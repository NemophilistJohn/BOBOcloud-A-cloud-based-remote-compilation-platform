'use strict';

// Local SCM broker for installed extensions. This module intentionally has no
// dependency on rclone, server settings, authentication, or cloud services.
// Extensions receive short-lived opaque repository ids, never a local path or
// a general process runner.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 768 * 1024;
const MAX_DISCOVERY_DEPTH = 4;
const MAX_DISCOVERED_REPOSITORIES = 32;
const MAX_CHANGED_PATHS = 256;
const MAX_HISTORY_ITEMS = 500;
const MAX_STATUS_ITEMS = 200;
const MAX_PAGE_OFFSET = 10_000;
const DEFAULT_HISTORY_LIMIT = 30;
const DEFAULT_STATUS_LIMIT = 100;
const MAX_DIFF_STAT_VALUE = 100_000_000;
const MAX_COMMIT_MESSAGE_LENGTH = 16 * 1024;
const GIT_READ_TIMEOUT_MS = 15_000;
const GIT_MUTATION_TIMEOUT_MS = 60_000;
const SAFE_GIT_ENVIRONMENT = Object.freeze({
  // Do not invoke interactive credential prompts from an extension-owned
  // background request. Native credential helpers and SSH agents still work.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never'
});

const SCM_GIT_METHODS = Object.freeze({
  'scm.git.detect': 'scm.git.read',
  'scm.git.status': 'scm.git.read',
  'scm.git.history': 'scm.git.read',
  'scm.git.diff': 'scm.git.read',
  'scm.git.branches': 'scm.git.read',
  'scm.git.remotes': 'scm.git.read',
  'scm.git.clone': 'scm.git.write',
  'scm.git.init': 'scm.git.write',
  'scm.git.setRemote': 'scm.git.write',
  'scm.git.stage': 'scm.git.write',
  'scm.git.stageAll': 'scm.git.write',
  'scm.git.unstage': 'scm.git.write',
  'scm.git.commit': 'scm.git.write',
  'scm.git.checkout': 'scm.git.write',
  'scm.git.createBranch': 'scm.git.write',
  'scm.git.deleteBranch': 'scm.git.write',
  'scm.git.fetch': 'scm.git.write',
  'scm.git.pull': 'scm.git.write',
  'scm.git.push': 'scm.git.write'
});

const DISCOVERY_IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
  '.bobocloud', 'dist', 'build', 'coverage'
]);

function scmError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function trimText(value, maxLength = 4096) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function isPathInside(root, target, allowRoot = true) {
  const relative = path.relative(root, target);
  if (!relative) return allowRoot;
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function normalizeRepositoryId(value) {
  if (typeof value !== 'string' || !/^scm-[A-Za-z0-9-]{16,128}$/.test(value)) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'repositoryId must be an opaque repository id returned by scm.git.detect.');
  }
  return value;
}

function normalizeRemoteName(value, fallback = 'origin') {
  const name = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'Remote name is invalid.');
  }
  return name;
}

function normalizeBranchName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') ||
      value.includes('//') || value.includes('@{') || value.endsWith('.') || value.endsWith('/')) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'Branch name is invalid.');
  }
  return value;
}

function normalizeRef(value) {
  if (value === undefined || value === null || value === '') return 'HEAD';
  if (typeof value !== 'string' || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('.') || value.endsWith('/')) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'Revision is invalid.');
  }
  return value;
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') || value.includes('\\')) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'Path must be a short repository-relative POSIX path.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('/../')) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'Path must stay inside the repository.');
  }
  return normalized;
}

function normalizePaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANGED_PATHS) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'paths must contain between one and ' + MAX_CHANGED_PATHS + ' repository-relative paths.');
  }
  const paths = value.map(normalizeRelativePath);
  if (new Set(paths).size !== paths.length) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'paths must not repeat a repository-relative path.');
  }
  return paths;
}

function normalizeLimit(value) {
  if (value === undefined || value === null) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HISTORY_ITEMS) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'limit must be an integer between 1 and ' + MAX_HISTORY_ITEMS + '.');
  }
  return value;
}

function normalizeStatusLimit(value) {
  if (value === undefined || value === null) return DEFAULT_STATUS_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_STATUS_ITEMS) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'limit must be an integer between 1 and ' + MAX_STATUS_ITEMS + '.');
  }
  return value;
}

function normalizeOffset(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0 || value > MAX_PAGE_OFFSET) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'offset must be an integer between 0 and ' + MAX_PAGE_OFFSET + '.');
  }
  return value;
}

function normalizeCommitMessage(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_COMMIT_MESSAGE_LENGTH || value.includes('\0')) {
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'Commit message must be non-empty and at most ' + MAX_COMMIT_MESSAGE_LENGTH + ' characters.');
  }
  return value;
}

function normalizeRemoteUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\0]/.test(value)) {
    throw scmError('SCM_GIT_REMOTE_DENIED', 'Remote URL must be a short HTTPS or SSH URL.');
  }
  if (/^https:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw scmError('SCM_GIT_REMOTE_DENIED', 'Remote URL is invalid.'); }
    if (!parsed.hostname || parsed.password || parsed.search || parsed.hash ||
        (parsed.protocol === 'https:' && parsed.username)) {
      throw scmError('SCM_GIT_REMOTE_DENIED', 'Remote URL must not embed credentials or unsupported URL components.');
    }
    return value;
  }
  // SCP-style SSH is widely used for Git hosting: git@host:owner/repository.git.
  // Require an explicit SSH user or a domain-like host so ambiguous strings
  // such as `file:relative-path` and `C:/local-path` cannot be interpreted as
  // a local Git transport by platform-specific Git builds.
  const scp = !value.includes('://') && value.match(/^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):[A-Za-z0-9._~/-]+$/);
  if (scp && (scp[1] || scp[2].includes('.') || scp[2].toLowerCase() === 'localhost')) return value;
  throw scmError('SCM_GIT_REMOTE_DENIED', 'Only HTTPS and SSH Git remotes are supported.');
}

function sanitizeRemoteUrl(value, workspaceRoot) {
  try {
    return redactText(normalizeRemoteUrl(value), workspaceRoot);
  } catch (_) {
    // Keep the historical redacted display for HTTPS/SSH URLs containing
    // userinfo, but never return an unsupported local or helper URL. These
    // remotes remain non-callable because assertRemote still rejects them.
    const redacted = redactText(value, workspaceRoot);
    return /^(?:https|ssh):\/\/\*\*\*@/i.test(redacted) ? redacted : '';
  }
}

function redactText(value, workspaceRoot) {
  let text = trimText(value, MAX_OUTPUT_BYTES).replace(/\u001b\[[0-9;]*m/g, '');
  if (workspaceRoot) {
    const normalized = String(workspaceRoot).replace(/\\/g, '/');
    text = text.split(workspaceRoot).join('<workspace>');
    if (normalized !== workspaceRoot) text = text.split(normalized).join('<workspace>');
  }
  // Do not pass a URL userinfo token, an HTTP Basic credential, or an
  // accidental credential-helper message through the extension boundary.
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+(?::[^\s/@]*)?@)/gi, '$1***@');
  text = text.replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, '$1***');
  return text;
}

function gitFailure(error, workspaceRoot) {
  if (error && error.code && /^SCM_GIT_/.test(error.code)) return error;
  const stdout = redactText(error && error.stdout, workspaceRoot);
  const stderr = redactText(error && error.stderr, workspaceRoot);
  const text = (stderr + '\n' + stdout + '\n' + String(error && error.message || '')).toLowerCase();
  if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
    return scmError('SCM_GIT_UNAVAILABLE', 'Local Git is not available on this device.');
  }
  if (error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return scmError('SCM_GIT_OUTPUT_TOO_LARGE', 'Git output exceeded the extension API limit. Narrow the request and try again.');
  }
  if (/not a git repository|not a repository/.test(text)) {
    return scmError('SCM_GIT_NOT_REPOSITORY', 'The selected local workspace is not a Git repository.');
  }
  if (/authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)|publickey|authentication is required/.test(text)) {
    return scmError('SCM_GIT_AUTH_REQUIRED', 'Git authentication is required. Configure a local credential helper or SSH agent, then retry.');
  }
  if (/please tell me who you are|unable to auto-detect email address/.test(text)) {
    return scmError('SCM_GIT_IDENTITY_REQUIRED', 'Git author identity is not configured. Set your local user.name and user.email, then retry.');
  }
  if (/nothing to commit|no changes added to commit/.test(text)) {
    return scmError('SCM_GIT_NOTHING_TO_COMMIT', 'There are no local changes to commit.');
  }
  if (/conflict|unmerged|would be overwritten/.test(text)) {
    return scmError('SCM_GIT_CONFLICT', 'Git could not complete the operation because the local repository has conflicts.');
  }
  if (/non-fast-forward|rejected|failed to push some refs/.test(text)) {
    return scmError('SCM_GIT_OPERATION_FAILED', 'The remote rejected the Git update. Fetch or pull the local repository, resolve changes, then retry.');
  }
  return scmError('SCM_GIT_OPERATION_FAILED', 'Local Git could not complete this operation.');
}

function parseStatus(stdout) {
  const branch = { head: '', upstream: '', ahead: 0, behind: 0, oid: '' };
  const changes = [];
  const records = String(stdout || '').split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const line = records[index];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) { branch.oid = trimText(line.slice(13), 80); continue; }
    if (line.startsWith('# branch.head ')) { branch.head = trimText(line.slice(14), 160); continue; }
    if (line.startsWith('# branch.upstream ')) { branch.upstream = trimText(line.slice(18), 200); continue; }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) { branch.ahead = Number(match[1]); branch.behind = Number(match[2]); }
      continue;
    }
    if (line.startsWith('? ')) {
      changes.push({ path: trimText(line.slice(2), 1024), index: '?', workingTree: '?', kind: 'untracked' });
      continue;
    }
    if (line.startsWith('! ')) {
      changes.push({ path: trimText(line.slice(2), 1024), index: '!', workingTree: '!', kind: 'ignored' });
      continue;
    }
    const fields = line.split(' ');
    if (line.startsWith('1 ') && fields.length >= 9) {
      changes.push({ path: trimText(fields.slice(8).join(' '), 1024), index: fields[1][0] || ' ', workingTree: fields[1][1] || ' ', kind: 'changed' });
      continue;
    }
    if (line.startsWith('2 ') && fields.length >= 10) {
      const originalPath = records[++index] || '';
      changes.push({
        path: trimText(fields.slice(9).join(' '), 1024),
        originalPath: trimText(originalPath, 1024),
        index: fields[1][0] || ' ',
        workingTree: fields[1][1] || ' ',
        kind: 'renamed'
      });
      continue;
    }
    if (line.startsWith('u ') && fields.length >= 11) {
      changes.push({ path: trimText(fields.slice(10).join(' '), 1024), index: fields[1][0] || 'U', workingTree: fields[1][1] || 'U', kind: 'unmerged' });
    }
  }
  return { branch, changes };
}

function parseHistory(stdout) {
  const commits = [];
  for (const record of String(stdout || '').split('\x1e')) {
    if (!record) continue;
    // `git log --pretty=format:` inserts a record separator newline between
    // commits on some Git versions. Strip only that framing newline so pages
    // after the first commit remain parseable without altering subject text.
    const fields = record.replace(/^[\r\n]+/, '').split('\x1f');
    if (fields.length < 6 || !/^[a-f0-9]{40,64}$/i.test(fields[0])) continue;
    commits.push({
      hash: trimText(fields[0], 80),
      parents: trimText(fields[1], 512).split(' ').filter((value) => /^[a-f0-9]{40,64}$/i.test(value)),
      author: { name: trimText(fields[2], 200), email: trimText(fields[3], 320) },
      date: trimText(fields[4], 80),
      subject: trimText(fields[5].replace(/[\r\n]+/g, ' '), 500)
    });
  }
  return commits;
}

function parseDiffStats(stdout) {
  const stats = new Map();
  for (const record of String(stdout || '').split('\0')) {
    if (!record) continue;
    const match = record.match(/^([^\t]+)\t([^\t]+)\t([\s\S]+)$/);
    if (!match) continue;
    let relativePath;
    try { relativePath = normalizeRelativePath(match[3]); } catch (_) { continue; }
    if (match[1] === '-' || match[2] === '-') {
      // Git uses -/- for binary files. Treat that as unknown rather than
      // presenting a misleading zero-line change in a source-control UI.
      stats.set(relativePath, null);
      continue;
    }
    const additions = Number(match[1]);
    const deletions = Number(match[2]);
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions) ||
        additions < 0 || deletions < 0 || additions > MAX_DIFF_STAT_VALUE || deletions > MAX_DIFF_STAT_VALUE) {
      stats.set(relativePath, null);
      continue;
    }
    stats.set(relativePath, { additions, deletions });
  }
  return stats;
}

function hasDiffStats(status) {
  return typeof status === 'string' && status !== ' ' && status !== '?' && status !== '!';
}

function parseBranches(stdout) {
  const local = [];
  const remote = [];
  let current = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const [ref = '', hash = '', upstream = '', head = ''] = line.split('\t');
    if (!/^(refs\/heads|refs\/remotes)\//.test(ref) || !/^[a-f0-9]{40,64}$/i.test(hash)) continue;
    const name = ref.replace(/^refs\/(?:heads|remotes)\//, '');
    const item = { name: trimText(name, 180), hash: trimText(hash, 80), upstream: trimText(upstream, 180) };
    if (ref.startsWith('refs/remotes/')) remote.push(item); else local.push(item);
    if (head === '*') current = item.name;
  }
  return { current, local, remote };
}

function outputText(result) {
  return typeof result === 'string' ? result : String(result || '');
}

function createScmGitBroker(options = {}) {
  if (typeof options.getWorkspaceIdentity !== 'function') {
    throw new TypeError('createScmGitBroker requires getWorkspaceIdentity.');
  }
  const getWorkspaceIdentity = options.getWorkspaceIdentity;
  const execFile = typeof options.execFile === 'function' ? options.execFile : childProcess.execFile;
  const gitExecutable = typeof options.gitExecutable === 'string' && options.gitExecutable ? options.gitExecutable : 'git';
  const getHooksDirectory = typeof options.getHooksDirectory === 'function'
    ? options.getHooksDirectory
    : () => options.hooksDirectory || null;
  const repositories = new Map();
  const repositoryKeys = new Map();
  let activeScopeKey = '';
  let hooksDirectoryPromise = null;
  let workspaceMutationQueue = Promise.resolve();

  async function ensureHooksDirectory() {
    if (!hooksDirectoryPromise) {
      hooksDirectoryPromise = (async () => {
        const candidate = await getHooksDirectory();
        if (!candidate || typeof candidate !== 'string') {
          throw scmError('SCM_GIT_HOOKS_UNAVAILABLE', 'Local SCM requires a secure Git hooks directory.');
        }
        const absolute = path.resolve(candidate);
        await fsp.mkdir(absolute, { recursive: true, mode: 0o700 });
        return absolute;
      })().catch((error) => {
        hooksDirectoryPromise = null;
        throw scmError('SCM_GIT_HOOKS_UNAVAILABLE', 'Local SCM could not prepare its secure Git hooks directory.');
      });
    }
    return hooksDirectoryPromise;
  }

  async function workspaceScope() {
    const identity = getWorkspaceIdentity();
    const rootPath = identity && identity.rootPath;
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
      throw scmError('SCM_GIT_NO_WORKSPACE', 'Open a local workspace before using source control.');
    }
    let root;
    try { root = await fsp.realpath(path.resolve(rootPath)); } catch (_) {
      throw scmError('SCM_GIT_NO_WORKSPACE', 'The active local workspace is no longer available.');
    }
    const workspaceIdentity = identity && identity.workspaceIdentity;
    const currentIdentity = getWorkspaceIdentity();
    if (!currentIdentity || currentIdentity.rootPath !== rootPath || currentIdentity.workspaceIdentity !== workspaceIdentity) {
      throw scmError('SCM_GIT_STALE_REPOSITORY', 'Workspace changed while source control was resolving its local root. Retry the request.');
    }
    const key = String(workspaceIdentity === undefined ? '' : workspaceIdentity) + '\0' + root;
    if (activeScopeKey !== key) {
      // Keep old records just long enough to return STALE_REPOSITORY to an
      // in-flight or late caller. Repository ids remain capability tokens and
      // descriptor lookup is keyed by the new scope, so they cannot become
      // valid again for the replacement workspace.
      repositoryKeys.clear();
      activeScopeKey = key;
    }
    return { root, workspaceIdentity, key };
  }

  function createGitEnvironment() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      // Git accepts a broad set of environment overrides, including process
      // launchers (GIT_SSH_COMMAND), config injection (GIT_CONFIG_*), and a
      // replacement executable search path (GIT_EXEC_PATH). Do not let an
      // installed extension inherit any of them. Keep SSH_AUTH_SOCK and the
      // user's normal credential-helper configuration intact.
      if (/^GIT_/i.test(key) || /^GCM_/i.test(key) || /^SSH_ASKPASS(?:_|$)/i.test(key)) {
        delete env[key];
      }
    }
    return { ...env, ...SAFE_GIT_ENVIRONMENT };
  }

  async function execGit(cwd, args, options = {}) {
    // A missing override would re-enable repository hooks, including hooks
    // installed by untrusted project content. Refuse to execute in that case.
    const hooksDirectory = await ensureHooksDirectory();
    const config = [
      '-c', 'core.fsmonitor=false',
      '-c', 'protocol.file.allow=never',
      '-c', 'diff.external=',
      '-c', 'core.sshCommand=ssh'
    ];
    config.push('-c', 'core.hooksPath=' + hooksDirectory);
    const commandArgs = ['--no-pager', ...config, ...args];
    const env = createGitEnvironment();
    // Hooks setup is asynchronous. The workspace can be replaced while it is
    // pending, so verify scope again at the last async boundary before Git is
    // launched. The promise executor calls execFile synchronously.
    if (typeof options.assertScope === 'function') await options.assertScope();
    return new Promise((resolve, reject) => {
      execFile(gitExecutable, commandArgs, {
        cwd,
        windowsHide: true,
        shell: false,
        timeout: options.timeoutMs || GIT_READ_TIMEOUT_MS,
        maxBuffer: options.maxBuffer || MAX_OUTPUT_BYTES,
        env
      }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: outputText(stdout), stderr: outputText(stderr) });
      });
    });
  }

  async function runGit(scope, root, args, options = {}) {
    try {
      return await execGit(root, args, {
        ...options,
        assertScope: () => assertCurrentScope(scope, { scopeKey: scope.key })
      });
    } catch (error) {
      throw gitFailure(error, scope.root);
    }
  }

  async function resolveRepositoryRoot(scope, candidate) {
    let candidateRoot;
    try { candidateRoot = await fsp.realpath(candidate); } catch (_) { return null; }
    if (!isPathInside(scope.root, candidateRoot)) return null;
    let result;
    try {
      result = await runGit(scope, candidateRoot, ['rev-parse', '--show-toplevel']);
    } catch (error) {
      if (error && error.code === 'SCM_GIT_NOT_REPOSITORY') return null;
      throw error;
    }
    let repositoryRoot;
    try { repositoryRoot = await fsp.realpath(result.stdout.trim()); } catch (_) { return null; }
    if (!isPathInside(scope.root, repositoryRoot)) return null;

    // A worktree can place its .git directory outside the visible worktree.
    // That would let an extension mutate repository metadata outside its
    // workspace capability, so reject it even when the worktree itself is in
    // the active workspace.
    let gitDirectoryResult;
    try {
      gitDirectoryResult = await runGit(scope, candidateRoot, ['rev-parse', '--git-dir']);
    } catch (error) {
      if (error && error.code === 'SCM_GIT_NOT_REPOSITORY') return null;
      throw error;
    }
    const gitDirectoryOutput = gitDirectoryResult.stdout.trim();
    let gitDirectory;
    try { gitDirectory = await fsp.realpath(path.resolve(candidateRoot, gitDirectoryOutput)); } catch (_) { return null; }
    if (!isPathInside(scope.root, gitDirectory)) return null;
    return repositoryRoot;
  }

  async function markerExists(directory) {
    try {
      const marker = await fsp.lstat(path.join(directory, '.git'));
      return !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile());
    } catch (_) {
      return false;
    }
  }

  async function discoverRepositoryRoots(scope, includeNested) {
    const candidates = [scope.root];
    if (includeNested) {
      const visited = new Set([scope.root]);
      async function walk(directory, depth) {
        if (depth >= MAX_DISCOVERY_DEPTH || candidates.length >= MAX_DISCOVERED_REPOSITORIES) return;
        let entries;
        try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch (_) { return; }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (candidates.length >= MAX_DISCOVERED_REPOSITORIES) return;
          if (!entry.isDirectory() || entry.isSymbolicLink() || DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)) continue;
          const child = path.join(directory, entry.name);
          let childReal;
          try { childReal = await fsp.realpath(child); } catch (_) { continue; }
          if (!isPathInside(scope.root, childReal) || visited.has(childReal)) continue;
          visited.add(childReal);
          if (await markerExists(childReal)) candidates.push(childReal);
          await walk(childReal, depth + 1);
        }
      }
      await walk(scope.root, 0);
    }
    const roots = new Set();
    for (const candidate of candidates) {
      const repositoryRoot = await resolveRepositoryRoot(scope, candidate);
      if (repositoryRoot) roots.add(repositoryRoot);
    }
    return Array.from(roots).sort((left, right) => left.localeCompare(right));
  }

  function descriptorFor(scope, root) {
    const key = scope.key + '\0' + root;
    let id = repositoryKeys.get(key);
    if (!id) {
      id = 'scm-' + crypto.randomUUID();
      repositoryKeys.set(key, id);
      repositories.set(id, { id, root, scopeKey: scope.key, workspaceRoot: scope.root, mutationQueue: Promise.resolve() });
    }
    const relativeRoot = path.relative(scope.root, root).split(path.sep).join('/');
    return immutable({ repositoryId: id, relativeRoot, isWorkspaceRoot: relativeRoot === '' });
  }

  async function requireRepository(scope, args) {
    const value = isPlainObject(args) ? args : null;
    if (!value) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'SCM request must be an object.');
    const id = normalizeRepositoryId(value.repositoryId);
    const repository = repositories.get(id);
    if (!repository) throw scmError('SCM_GIT_REPOSITORY_NOT_FOUND', 'Repository id is not available in this workspace session.');
    if (repository.scopeKey !== scope.key) throw scmError('SCM_GIT_STALE_REPOSITORY', 'Repository id belongs to a previous workspace session. Run scm.git.detect again.');
    let root;
    try { root = await fsp.realpath(repository.root); } catch (_) { root = null; }
    if (!root || root !== repository.root || !isPathInside(scope.root, root)) {
      repositories.delete(id);
      repositoryKeys.delete(repository.scopeKey + '\0' + repository.root);
      throw scmError('SCM_GIT_STALE_REPOSITORY', 'Local repository changed or is no longer inside the active workspace. Run scm.git.detect again.');
    }
    const verifiedRoot = await resolveRepositoryRoot(scope, root);
    if (!verifiedRoot || verifiedRoot !== root) {
      repositories.delete(id);
      repositoryKeys.delete(repository.scopeKey + '\0' + repository.root);
      throw scmError('SCM_GIT_STALE_REPOSITORY', 'Local repository changed. Run scm.git.detect again.');
    }
    return repository;
  }

  async function assertCurrentScope(scope, repository) {
    const current = await workspaceScope();
    if (current.key !== scope.key || activeScopeKey !== scope.key || repository.scopeKey !== scope.key) {
      throw scmError('SCM_GIT_STALE_REPOSITORY', 'Workspace changed while Git was running. Refresh source control state.');
    }
  }

  function queueMutation(scope, repository, work) {
    const execute = async () => {
      // A queued operation can outlive the workspace that originally
      // authorized it. Check before touching the repository, not only after.
      await assertCurrentScope(scope, repository);
      return work();
    };
    const pending = repository.mutationQueue.then(execute, execute);
    repository.mutationQueue = pending.catch(() => {});
    return pending.then(async (result) => {
      await assertCurrentScope(scope, repository);
      return result;
    });
  }

  function queueWorkspaceMutation(scope, work) {
    const scopeRecord = { scopeKey: scope.key };
    const execute = async () => {
      // Neither initialization nor cloning is associated with a repository id
      // yet. Serialize them at the active-workspace boundary so two extension
      // requests cannot race to write into the same local directory.
      await assertCurrentScope(scope, scopeRecord);
      return work();
    };
    const pending = workspaceMutationQueue.then(execute, execute);
    workspaceMutationQueue = pending.catch(() => {});
    return pending.then(async (result) => {
      await assertCurrentScope(scope, scopeRecord);
      return result;
    });
  }

  async function assertWorkspaceIsEmpty(scope) {
    let entries;
    try {
      entries = await fsp.readdir(scope.root);
    } catch (_) {
      throw scmError('SCM_GIT_NO_WORKSPACE', 'The active local workspace is no longer available.');
    }
    if (entries.length > 0) {
      throw scmError('SCM_GIT_WORKSPACE_NOT_EMPTY', 'Clone requires an empty active local workspace.');
    }
    await assertCurrentScope(scope, { scopeKey: scope.key });
  }

  async function readDiffStats(scope, repository, paths, staged) {
    if (!paths.length) return new Map();
    const args = ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
    if (staged) args.push('--cached');
    args.push('--', ...paths);
    const result = await runGit(scope, repository.root, args);
    await assertCurrentScope(scope, repository);
    return parseDiffStats(result.stdout);
  }

  function collectDiffStatPaths(changes, statusKey) {
    const paths = [];
    const known = new Set();
    for (const change of changes) {
      // `--no-renames` intentionally avoids Git's multi-path numstat rename
      // encoding. A renamed entry remains unknown rather than receiving a
      // partial stat for only one side of the rename.
      if (change.kind === 'renamed' || !hasDiffStats(change[statusKey])) continue;
      let relativePath;
      try { relativePath = normalizeRelativePath(change.path); } catch (_) { continue; }
      if (!known.has(relativePath)) {
        known.add(relativePath);
        paths.push(relativePath);
      }
    }
    return paths;
  }

  function withDiffStats(change, indexStats, workingTreeStats) {
    const path = change.kind === 'renamed' ? '' : change.path;
    return {
      ...change,
      indexStats: hasDiffStats(change.index) && path ? (indexStats.get(path) || null) : null,
      workingTreeStats: hasDiffStats(change.workingTree) && path ? (workingTreeStats.get(path) || null) : null
    };
  }

  async function readStatus(scope, repository, page = {}) {
    const offset = normalizeOffset(page.offset);
    const limit = normalizeStatusLimit(page.limit);
    const result = await runGit(scope, repository.root, ['status', '--porcelain=v2', '-z', '--branch']);
    await assertCurrentScope(scope, repository);
    const parsed = parseStatus(result.stdout);
    const total = parsed.changes.length;
    const pageChanges = parsed.changes.slice(offset, offset + limit);
    const indexStats = await readDiffStats(scope, repository, collectDiffStatPaths(pageChanges, 'index'), true);
    const workingTreeStats = await readDiffStats(scope, repository, collectDiffStatPaths(pageChanges, 'workingTree'), false);
    const changes = pageChanges.map((change) => withDiffStats(change, indexStats, workingTreeStats));
    const hasMore = offset + changes.length < total;
    return immutable({
      repositoryId: repository.id,
      relativeRoot: path.relative(scope.root, repository.root).split(path.sep).join('/'),
      branch: parsed.branch,
      changes,
      offset,
      limit,
      total,
      hasMore,
      nextOffset: hasMore ? offset + changes.length : null
    });
  }

  async function readCurrentBranch(scope, repository) {
    const result = await runGit(scope, repository.root, ['branch', '--show-current']);
    const branch = result.stdout.trim();
    if (!branch) throw scmError('SCM_GIT_OPERATION_FAILED', 'The local repository is in detached HEAD state. Select a branch before pushing.');
    return normalizeBranchName(branch);
  }

  async function assertRemote(scope, repository, remoteName) {
    let result;
    try {
      result = await runGit(scope, repository.root, ['remote', 'get-url', remoteName]);
    } catch (error) {
      if (error && error.code === 'SCM_GIT_OPERATION_FAILED') {
        throw scmError('SCM_GIT_REMOTE_DENIED', 'The requested Git remote is not configured.');
      }
      throw error;
    }
    normalizeRemoteUrl(result.stdout.trim());
    // A repo-local remote helper could start an arbitrary helper executable.
    // The broker supports only native Git HTTPS/SSH transports.
    const helper = await runGit(scope, repository.root, ['config', '--get', 'remote.' + remoteName + '.vcs']).catch((error) => {
      if (error && error.code === 'SCM_GIT_OPERATION_FAILED') return { stdout: '' };
      throw error;
    });
    if (helper.stdout.trim() && helper.stdout.trim() !== 'git') {
      throw scmError('SCM_GIT_REMOTE_DENIED', 'The requested Git remote uses an unsupported helper.');
    }
  }

  async function request(method, args) {
    if (!Object.hasOwn(SCM_GIT_METHODS, method)) {
      throw scmError('SCM_GIT_INVALID_ARGUMENT', 'SCM Git method is not supported.');
    }
    const payload = args === undefined ? {} : args;
    if (!isPlainObject(payload)) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'SCM request must be an object.');
    const scope = await workspaceScope();

    if (method === 'scm.git.detect') {
      if (Object.keys(payload).some((key) => key !== 'includeNested')) {
        throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.detect has an unsupported field.');
      }
      if (payload.includeNested !== undefined && typeof payload.includeNested !== 'boolean') {
        throw scmError('SCM_GIT_INVALID_ARGUMENT', 'includeNested must be a boolean.');
      }
      const roots = await discoverRepositoryRoots(scope, payload.includeNested !== false);
      await assertCurrentScope(scope, { scopeKey: scope.key });
      return immutable({ repositories: roots.map((root) => descriptorFor(scope, root)) });
    }

    if (method === 'scm.git.clone') {
      if (Object.keys(payload).some((key) => key !== 'url' && key !== 'branch')) {
        throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.clone has an unsupported field.');
      }
      const url = normalizeRemoteUrl(payload.url);
      const branch = payload.branch === undefined || payload.branch === null || payload.branch === ''
        ? ''
        : normalizeBranchName(payload.branch);
      return queueWorkspaceMutation(scope, async () => {
        await assertWorkspaceIsEmpty(scope);
        const cloneArgs = ['clone', '--no-recurse-submodules'];
        if (branch) cloneArgs.push('--branch', branch);
        // The destination is deliberately fixed to the active workspace. An
        // extension can neither supply nor infer another local target path.
        cloneArgs.push(url, '.');
        try {
          await runGit(scope, scope.root, cloneArgs, { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        } catch (error) {
          // A syntactically permitted HTTPS/SSH URL can still name a missing
          // or unreachable repository. Give the extension a stable state for
          // that case without collapsing authentication or host availability.
          if (error && error.code === 'SCM_GIT_OPERATION_FAILED') {
            throw scmError('SCM_GIT_CLONE_FAILED', 'Git could not clone the requested remote into the active workspace.');
          }
          throw error;
        }
        const root = await resolveRepositoryRoot(scope, scope.root);
        if (!root || root !== scope.root) {
          throw scmError('SCM_GIT_OPERATION_FAILED', 'Git did not create a local repository in the active workspace.');
        }
        await assertCurrentScope(scope, { scopeKey: scope.key });
        return descriptorFor(scope, root);
      });
    }

    if (method === 'scm.git.init') {
      if (Object.keys(payload).length > 0) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.init does not accept paths or Git command arguments.');
      return queueWorkspaceMutation(scope, async () => {
        const existing = await resolveRepositoryRoot(scope, scope.root);
        if (!existing) {
          await assertCurrentScope(scope, { scopeKey: scope.key });
          await runGit(scope, scope.root, ['init', '--quiet'], { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        }
        const root = await resolveRepositoryRoot(scope, scope.root);
        if (!root || root !== scope.root) {
          throw scmError('SCM_GIT_OPERATION_FAILED', 'Local Git could not initialize the active workspace root.');
        }
        await assertCurrentScope(scope, { scopeKey: scope.key });
        return descriptorFor(scope, root);
      });
    }

    const repository = await requireRepository(scope, payload);
    if (method === 'scm.git.status') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'offset', 'limit'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.status has an unsupported field.');
      return readStatus(scope, repository, payload);
    }
    if (method === 'scm.git.history') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'offset', 'limit', 'ref'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.history has an unsupported field.');
      const offset = normalizeOffset(payload.offset);
      const limit = normalizeLimit(payload.limit);
      const ref = normalizeRef(payload.ref);
      // An initialized repository with no first commit is a valid and very
      // common state. `git log` exits non-zero for its unborn branch, which
      // must not make the whole SCM view look like a broken repository.
      const branchState = await runGit(scope, repository.root, ['status', '--porcelain=v2', '-z', '--branch']);
      await assertCurrentScope(scope, repository);
      if (parseStatus(branchState.stdout).branch.oid === '(initial)') {
        return immutable({
          repositoryId: repository.id,
          commits: [],
          offset,
          limit,
          hasMore: false,
          nextOffset: null
        });
      }
      const result = await runGit(scope, repository.root, [
        'log', '--date=iso-strict', '--skip=' + offset, '--max-count=' + (limit + 1),
        '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e', ref
      ]);
      await assertCurrentScope(scope, repository);
      const records = parseHistory(result.stdout);
      const hasMore = records.length > limit;
      const commits = records.slice(0, limit);
      return immutable({
        repositoryId: repository.id,
        commits,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? offset + commits.length : null
      });
    }
    if (method === 'scm.git.diff') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'path', 'ref', 'staged'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.diff has an unsupported field.');
      if (payload.staged !== undefined && typeof payload.staged !== 'boolean') throw scmError('SCM_GIT_INVALID_ARGUMENT', 'staged must be a boolean.');
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
      if (payload.staged === true) args.push('--cached');
      if (payload.ref !== undefined && payload.ref !== null && payload.ref !== '') args.push(normalizeRef(payload.ref));
      if (payload.path !== undefined && payload.path !== null && payload.path !== '') args.push('--', normalizeRelativePath(payload.path));
      const result = await runGit(scope, repository.root, args, { maxBuffer: MAX_DIFF_BYTES });
      await assertCurrentScope(scope, repository);
      return immutable({ repositoryId: repository.id, content: redactText(result.stdout, scope.root), truncated: false });
    }
    if (method === 'scm.git.branches') {
      if (Object.keys(payload).some((key) => key !== 'repositoryId')) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.branches has an unsupported field.');
      const result = await runGit(scope, repository.root, ['for-each-ref', '--format=%(refname)\t%(objectname)\t%(upstream:short)\t%(HEAD)', 'refs/heads', 'refs/remotes']);
      await assertCurrentScope(scope, repository);
      return immutable({ repositoryId: repository.id, ...parseBranches(result.stdout) });
    }
    if (method === 'scm.git.remotes') {
      if (Object.keys(payload).some((key) => key !== 'repositoryId')) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.remotes has an unsupported field.');
      const namesResult = await runGit(scope, repository.root, ['remote']);
      const remotes = [];
      for (const rawName of namesResult.stdout.split(/\r?\n/)) {
        if (!rawName) continue;
        const name = normalizeRemoteName(rawName, '');
        const fetchResult = await runGit(scope, repository.root, ['remote', 'get-url', '--all', name]);
        const pushResult = await runGit(scope, repository.root, ['remote', 'get-url', '--push', '--all', name]);
        let hasUnsupportedUrls = false;
        const safeUrls = (result) => result.stdout.split(/\r?\n/).filter(Boolean).flatMap((url) => {
          const safeUrl = sanitizeRemoteUrl(url, scope.root);
          if (!safeUrl) hasUnsupportedUrls = true;
          return safeUrl ? [safeUrl] : [];
        });
        const fetchUrls = safeUrls(fetchResult);
        const pushUrls = safeUrls(pushResult);
        // `urls` remains the compatibility alias for fetch URLs. Push URLs
        // are exposed separately so a local UI can accurately summarize a
        // split fetch/push configuration without inspecting repository files.
        remotes.push({ name, urls: fetchUrls, fetchUrls, pushUrls, hasUnsupportedUrls });
      }
      await assertCurrentScope(scope, repository);
      return immutable({ repositoryId: repository.id, remotes });
    }
    if (method === 'scm.git.setRemote') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'name', 'url'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.setRemote has an unsupported field.');
      const name = normalizeRemoteName(payload.name);
      const url = normalizeRemoteUrl(payload.url);
      return queueMutation(scope, repository, async () => {
        const names = await runGit(scope, repository.root, ['remote']);
        const exists = names.stdout.split(/\r?\n/).includes(name);
        await runGit(scope, repository.root, exists ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url], { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        return immutable({ repositoryId: repository.id, name, url: redactText(url, scope.root) });
      });
    }
    if (method === 'scm.git.stageAll') {
      if (Object.keys(payload).some((key) => key !== 'repositoryId')) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.stageAll does not accept paths or Git command arguments.');
      return queueMutation(scope, repository, async () => {
        await runGit(scope, repository.root, ['add', '--all'], { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        return readStatus(scope, repository);
      });
    }
    if (method === 'scm.git.stage' || method === 'scm.git.unstage') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'paths'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', method + ' has an unsupported field.');
      const paths = normalizePaths(payload.paths);
      return queueMutation(scope, repository, async () => {
        const args = method === 'scm.git.stage'
          ? ['add', '--', ...paths]
          : ['restore', '--staged', '--', ...paths];
        await runGit(scope, repository.root, args, { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        return readStatus(scope, repository);
      });
    }
    if (method === 'scm.git.commit') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'message'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.commit has an unsupported field.');
      const message = normalizeCommitMessage(payload.message);
      return queueMutation(scope, repository, async () => {
        await runGit(scope, repository.root, ['commit', '--no-verify', '--no-gpg-sign', '-m', message], { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        const hash = (await runGit(scope, repository.root, ['rev-parse', 'HEAD'])).stdout.trim();
        return immutable({ repositoryId: repository.id, commit: /^[a-f0-9]{40,64}$/i.test(hash) ? hash : '' });
      });
    }
    if (method === 'scm.git.checkout') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'branch', 'force'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.checkout has an unsupported field.');
      if (payload.force !== undefined && typeof payload.force !== 'boolean') throw scmError('SCM_GIT_INVALID_ARGUMENT', 'force must be a boolean.');
      const branch = normalizeBranchName(payload.branch);
      return queueMutation(scope, repository, async () => {
        const args = payload.force === true ? ['switch', '--discard-changes', branch] : ['switch', branch];
        await runGit(scope, repository.root, args, { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        return immutable({ repositoryId: repository.id, branch });
      });
    }
    if (method === 'scm.git.createBranch') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'name', 'checkout'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.createBranch has an unsupported field.');
      if (payload.checkout !== undefined && typeof payload.checkout !== 'boolean') throw scmError('SCM_GIT_INVALID_ARGUMENT', 'checkout must be a boolean.');
      const branch = normalizeBranchName(payload.name);
      return queueMutation(scope, repository, async () => {
        const branchState = await runGit(scope, repository.root, ['status', '--porcelain=v2', '-z', '--branch']);
        const currentBranch = parseStatus(branchState.stdout).branch;
        if (currentBranch.oid === '(initial)') {
          if (payload.checkout !== true) {
            throw scmError('SCM_GIT_OPERATION_FAILED', 'An unborn repository can only create its active initial branch.');
          }
          if (currentBranch.head !== branch) {
            await runGit(scope, repository.root, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch], { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
          }
          return immutable({ repositoryId: repository.id, branch, checkedOut: true });
        }
        await runGit(scope, repository.root, ['branch', branch], { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        if (payload.checkout === true) {
          await runGit(scope, repository.root, ['switch', branch], { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        }
        return immutable({ repositoryId: repository.id, branch, checkedOut: payload.checkout === true });
      });
    }
    if (method === 'scm.git.deleteBranch') {
      if (Object.keys(payload).some((key) => !['repositoryId', 'name', 'force'].includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', 'scm.git.deleteBranch has an unsupported field.');
      if (payload.force !== undefined && typeof payload.force !== 'boolean') throw scmError('SCM_GIT_INVALID_ARGUMENT', 'force must be a boolean.');
      const branch = normalizeBranchName(payload.name);
      return queueMutation(scope, repository, async () => {
        const current = (await runGit(scope, repository.root, ['branch', '--show-current'])).stdout.trim();
        if (current === branch) {
          throw scmError('SCM_GIT_BRANCH_CHECKED_OUT', 'Cannot delete the checked out local branch.');
        }
        const deleteArgs = payload.force === true ? ['branch', '-D', branch] : ['branch', '-d', branch];
        await runGit(scope, repository.root, deleteArgs, {
          timeoutMs: GIT_MUTATION_TIMEOUT_MS
        });
        return immutable({ repositoryId: repository.id, branch, deleted: true });
      });
    }
    if (method === 'scm.git.fetch' || method === 'scm.git.pull' || method === 'scm.git.push') {
      const allowed = method === 'scm.git.fetch'
        ? ['repositoryId', 'remote']
        : method === 'scm.git.pull'
          ? ['repositoryId', 'remote', 'branch']
          : ['repositoryId', 'remote', 'branch', 'force', 'setUpstream'];
      if (Object.keys(payload).some((key) => !allowed.includes(key))) throw scmError('SCM_GIT_INVALID_ARGUMENT', method + ' has an unsupported field.');
      if (payload.force !== undefined && typeof payload.force !== 'boolean') throw scmError('SCM_GIT_INVALID_ARGUMENT', 'force must be a boolean.');
      if (payload.setUpstream !== undefined && typeof payload.setUpstream !== 'boolean') throw scmError('SCM_GIT_INVALID_ARGUMENT', 'setUpstream must be a boolean.');
      const remote = normalizeRemoteName(payload.remote);
      const branch = payload.branch === undefined || payload.branch === null || payload.branch === '' ? '' : normalizeBranchName(payload.branch);
      return queueMutation(scope, repository, async () => {
        await assertRemote(scope, repository, remote);
        let args;
        if (method === 'scm.git.fetch') {
          args = ['fetch', '--prune', '--no-recurse-submodules', remote];
        } else if (method === 'scm.git.pull') {
          args = ['pull', '--no-rebase', '--no-edit', '--no-recurse-submodules', remote];
          if (branch) args.push(branch);
        } else {
          const targetBranch = branch || await readCurrentBranch(scope, repository);
          args = ['push', '--porcelain', '--no-verify', remote, targetBranch];
          if (payload.force === true) args.splice(1, 0, '--force-with-lease');
          if (payload.setUpstream === true) args.splice(1, 0, '--set-upstream');
        }
        const result = await runGit(scope, repository.root, args, { timeoutMs: GIT_MUTATION_TIMEOUT_MS });
        return immutable({ repositoryId: repository.id, remote, branch: branch || '', output: redactText(result.stdout + result.stderr, scope.root) });
      });
    }
    throw scmError('SCM_GIT_INVALID_ARGUMENT', 'SCM Git method is not supported.');
  }

  return Object.freeze({
    request,
    methods: immutable({ ...SCM_GIT_METHODS })
  });
}

module.exports = {
  SCM_GIT_METHODS,
  createScmGitBroker
};
