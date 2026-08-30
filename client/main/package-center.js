'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Package-manager transactions may bind a manifest and its lock file. Keep the
// set deliberately small so every file can be inspected, CAS-written, and
// rolled back as one user operation.
const MAX_CHANGE_COUNT = 8;
const MAX_BINDING_COUNT = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const JOURNAL_SCHEMA = 'bobocloud-package-local-journal/v1';
const JOURNAL_DIRECTORY_NAME = 'package-center-transactions';
const JOURNAL_FILE_NAME = 'journal.json';
const JOURNAL_STATES = new Set([
  'prepared',
  'applied',
  'server-applied',
  'rollback-reconciliation-required',
  'commit-reconciliation-required',
  'committed',
  'rolled-back',
  'preserved'
]);

const MANIFEST_NAMES = Object.freeze({
  python: new Set([
    'pyproject.toml', 'setup.py', 'setup.cfg', 'pipfile', 'pipfile.lock',
    'poetry.lock', 'pdm.lock', 'uv.lock', 'pixi.lock', 'environment.yml',
    'environment.yaml', 'conda-lock.yml'
  ]),
  node: new Set([
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock'
  ]),
  go: new Set(['go.mod', 'go.sum', 'go.work', 'go.work.sum']),
  rust: new Set(['cargo.toml', 'cargo.lock']),
  java: new Set([
    'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
    'settings.gradle.kts', 'gradle.properties', 'libs.versions.toml',
    'gradle.lockfile'
  ])
});

function packageCenterError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details && typeof details === 'object') Object.assign(error, details);
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (['python', 'py'].includes(language)) return 'python';
  if (['node', 'nodejs', 'javascript', 'typescript', 'js', 'ts'].includes(language)) return 'node';
  if (['golang', 'go'].includes(language)) return 'go';
  if (language === 'rust') return 'rust';
  if (['java', 'maven', 'gradle'].includes(language)) return 'java';
  return '';
}

function normalizeRelativeManifestPath(value, language) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512 || value.includes('\0')) {
    throw packageCenterError('PACKAGE_CHANGE_PATH_INVALID', 'Dependency file path is invalid');
  }
  if (value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw packageCenterError('PACKAGE_CHANGE_PATH_INVALID', 'Dependency file path must be workspace-relative');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw packageCenterError('PACKAGE_CHANGE_PATH_INVALID', 'Dependency file path is not normalized');
  }
  const relativePath = segments.join('/');
  const baseName = segments[segments.length - 1].toLowerCase();
  const allowedNames = MANIFEST_NAMES[language];
  const pythonRequirement = language === 'python' &&
    /^(?:requirements|constraints)(?:[-_.][a-z0-9_.-]+)?\.(?:txt|in)$/i.test(baseName);
  if (!allowedNames || (!allowedNames.has(baseName) && !pythonRequirement)) {
    throw packageCenterError('PACKAGE_CHANGE_FILE_NOT_ALLOWED', 'The plan targets a file that is not a dependency manifest for the selected language', {
      relativePath,
      language
    });
  }
  return relativePath;
}

function pathIsOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function sameRoot(left, right) {
  if (!left || !right) return left === right;
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

async function resolveWorkspaceRoot(rootPath, fileSystem) {
  const io = fileSystem || fs.promises;
  const lexicalRoot = path.resolve(rootPath);
  let lexicalStat;
  let canonicalRoot;
  let canonicalStat;
  try {
    let current = lexicalRoot;
    for (;;) {
      const componentStat = await io.lstat(current);
      if (componentStat.isSymbolicLink()) throw new Error('redirected workspace root');
      if (current === lexicalRoot) {
        lexicalStat = componentStat;
        if (!lexicalStat.isDirectory()) throw new Error('invalid workspace root');
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    canonicalRoot = await io.realpath(lexicalRoot);
    canonicalStat = await io.stat(canonicalRoot);
  } catch (_) {
    throw packageCenterError('PACKAGE_WORKSPACE_SYMLINK', 'Package changes require a real workspace root');
  }
  if (!canonicalStat.isDirectory() || !sameFileIdentity(lexicalStat, canonicalStat)) {
    throw packageCenterError('PACKAGE_WORKSPACE_SYMLINK', 'Package changes require a real workspace root');
  }
  return path.resolve(canonicalRoot);
}

function transactionKey(identity) {
  const root = path.resolve(identity.rootPath);
  return (process.platform === 'win32' ? root.toLowerCase() : root) + ':' + identity.workspaceIdentity;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAllowedDependencyPath(relativePath) {
  for (const language of Object.keys(MANIFEST_NAMES)) {
    try {
      normalizeRelativeManifestPath(relativePath, language);
      return true;
    } catch (_) {}
  }
  return false;
}

function serializedError(error) {
  const result = {
    code: error && error.code || 'PACKAGE_LOCAL_TRANSACTION_FAILED',
    message: error && error.message || String(error)
  };
  if (error && Array.isArray(error.conflicts)) result.conflicts = error.conflicts;
  if (error && error.relativePath) result.relativePath = error.relativePath;
  if (error && error.transactionId) result.transactionId = error.transactionId;
  if (error && error.reconciliationRequired === true) result.reconciliationRequired = true;
  return result;
}

async function atomicWrite(filePath, content, mode, beforeReplace) {
  const temporary = path.join(
    path.dirname(filePath),
    '.' + path.basename(filePath) + '.bobocloud-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp'
  );
  let handle = null;
  try {
    handle = await fs.promises.open(temporary, 'wx', mode || 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    if (typeof beforeReplace === 'function') await beforeReplace();
    await fs.promises.rename(temporary, filePath);
  } finally {
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
    try { await fs.promises.unlink(temporary); } catch (_) {}
  }
}

async function atomicWriteJSON(filePath, value) {
  const serialized = Buffer.from(JSON.stringify(value), 'utf8');
  if (serialized.length > MAX_JOURNAL_BYTES) {
    throw packageCenterError('PACKAGE_JOURNAL_TOO_LARGE', 'Package transaction journal exceeds its size limit');
  }
  await atomicWrite(filePath, serialized, 0o600);
}

async function readRegularFile(target, maximumBytes) {
  let stat;
  try {
    stat = await fs.promises.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, stat: null, content: null, digest: null };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw packageCenterError('PACKAGE_CHANGE_TARGET_INVALID', 'Dependency file must be a regular file');
  }
  if (stat.size > maximumBytes) {
    throw packageCenterError('PACKAGE_CHANGE_FILE_TOO_LARGE', 'Dependency file exceeds the transaction size limit');
  }
  const content = await fs.promises.readFile(target);
  return { exists: true, stat, content, digest: sha256(content) };
}

function createPackageCenterController(options) {
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const getWorkspaceIdentity = options.getWorkspaceIdentity;
  const onFilesChanged = options.onFilesChanged || (() => {});
  const configuredUserDataPath = String(options.userDataPath || '').trim();
  if (!configuredUserDataPath || !path.isAbsolute(configuredUserDataPath)) {
    throw packageCenterError('PACKAGE_JOURNAL_PATH_INVALID', 'Package transaction recovery requires an absolute Electron user data path');
  }
  const journalRoot = path.join(path.resolve(configuredUserDataPath), JOURNAL_DIRECTORY_NAME);
  const transactions = new Map();
  const activeByWorkspace = new Map();
  const finalized = new Map();
  const pendingRecoveries = new Map();
  const beforeCompareAndSwap = typeof options.beforeCompareAndSwap === 'function'
    ? options.beforeCompareAndSwap
    : null;
  const onJournalCheckpoint = typeof options.onJournalCheckpoint === 'function'
    ? options.onJournalCheckpoint
    : null;
  let mutationQueue = Promise.resolve();
  let journalRootRealPath = '';
  let workspaceTransitionDepth = 0;

  function enqueue(task) {
    const result = mutationQueue.then(task, task);
    mutationQueue = result.catch(() => {});
    return result;
  }

  function requireCurrentSender(event) {
    if (typeof getWindow !== 'function') return;
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !event || event.sender !== window.webContents) {
      throw packageCenterError('PACKAGE_SENDER_INVALID', 'Package Center request sender is not active');
    }
  }

  function notify(state, transaction, extra) {
    const window = typeof getWindow === 'function' ? getWindow() : null;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send('package-center:local-transaction', Object.assign({
        state,
        transactionId: transaction && transaction.id || '',
        planId: transaction && transaction.planId || '',
        workspaceIdentity: transaction && transaction.workspaceIdentity
      }, extra || {}));
    } catch (_) {}
  }

  function reportFilesChanged(files) {
    try { onFilesChanged(files); } catch (_) {}
  }

  function publicRecoveryConflict(conflict) {
    return {
      path: String(conflict && conflict.path || ''),
      expectedSha256: DIGEST_PATTERN.test(String(conflict && conflict.expectedSha256 || ''))
        ? String(conflict.expectedSha256).toLowerCase()
        : null,
      actualSha256: DIGEST_PATTERN.test(String(conflict && conflict.actualSha256 || ''))
        ? String(conflict.actualSha256).toLowerCase()
        : null,
      source: conflict && conflict.source === 'journal-backup' ? 'journal-backup' : 'workspace'
    };
  }

  async function rememberPendingRecovery(transaction, state, conflicts) {
    const files = [];
    for (const change of transaction.changes || []) {
      let current = null;
      try { current = await readRegularFile(change.target, MAX_FILE_BYTES); } catch (_) {}
      files.push({
        path: change.relativePath,
        exists: Boolean(current && current.exists),
        sha256: current && current.exists ? current.digest : null
      });
    }
    pendingRecoveries.set(transaction.id, {
      id: transaction.id,
      directory: transaction.journal && transaction.journal.directory || '',
      rootPath: transaction.rootPath,
      state,
      files,
      conflicts: (conflicts || []).slice(0, MAX_CHANGE_COUNT).map(publicRecoveryConflict)
    });
  }

  function publicPendingRecovery(entry) {
    return {
      schema: 'project-package-local-recovery/v1',
      transactionId: entry.id,
      state: 'reconciliation-required',
      files: entry.files.map(file => ({ path: file.path, exists: file.exists, sha256: file.sha256 })),
      conflicts: entry.conflicts.map(publicRecoveryConflict)
    };
  }

  function pendingRecoveriesForRoot(rootPath) {
    return [...pendingRecoveries.values()].filter(entry => sameRoot(entry.rootPath, rootPath));
  }

  async function journalCheckpoint(phase, transaction, change) {
    if (!onJournalCheckpoint) return;
    await Promise.resolve(onJournalCheckpoint({
      phase,
      transactionId: transaction && transaction.id || '',
      journalDirectory: transaction && transaction.journal && transaction.journal.directory || '',
      path: change && change.target || '',
      relativePath: change && change.relativePath || ''
    }));
  }

  function simulatedProcessCrash(error) {
    return Boolean(error && error.simulateProcessCrash === true);
  }

  async function ensureJournalRoot() {
    if (journalRootRealPath) return journalRootRealPath;
    await fs.promises.mkdir(journalRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(journalRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw packageCenterError('PACKAGE_JOURNAL_PATH_INVALID', 'Package transaction journal directory is not a private real directory');
    }
    journalRootRealPath = await fs.promises.realpath(journalRoot);
    try { await fs.promises.chmod(journalRootRealPath, 0o700); } catch (_) {}
    return journalRootRealPath;
  }

  function assertJournalDirectory(directory, rootRealPath) {
    const resolved = path.resolve(directory);
    const id = path.basename(resolved);
    if (!TRANSACTION_ID_PATTERN.test(id) || !sameRoot(path.dirname(resolved), rootRealPath)) {
      throw packageCenterError('PACKAGE_JOURNAL_PATH_INVALID', 'Package transaction journal path is invalid');
    }
    return { directory: resolved, id };
  }

  async function removeJournalDirectory(directory) {
    const rootRealPath = await ensureJournalRoot();
    const validated = assertJournalDirectory(directory, rootRealPath);
    let stat;
    try {
      stat = await fs.promises.lstat(validated.directory);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        pendingRecoveries.delete(validated.id);
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw packageCenterError('PACKAGE_JOURNAL_PATH_INVALID', 'Package transaction journal entry is not a real directory');
    }
    await fs.promises.rm(validated.directory, { recursive: true, force: true });
    pendingRecoveries.delete(validated.id);
  }

  function journalRecord(transaction, state) {
    return {
      schema: JOURNAL_SCHEMA,
      transactionId: transaction.id,
      state,
      workspaceRoot: transaction.rootPath,
      files: transaction.changes.map(change => ({
        target: change.target,
        oldExists: change.existed,
        oldSha256: change.oldDigest,
        newSha256: change.newDigest
      }))
    };
  }

  async function createTransactionJournal(transaction) {
    if (!transaction.changes.length) return;
    if (!pathIsOutside(transaction.rootPath, journalRoot)) {
      throw packageCenterError('PACKAGE_JOURNAL_PATH_INVALID', 'Package transaction journal must be outside the workspace');
    }
    const rootRealPath = await ensureJournalRoot();
    if (!pathIsOutside(transaction.rootPath, rootRealPath)) {
      throw packageCenterError('PACKAGE_JOURNAL_PATH_INVALID', 'Package transaction journal must be outside the workspace');
    }
    const directory = path.join(rootRealPath, transaction.id);
    assertJournalDirectory(directory, rootRealPath);
    await fs.promises.mkdir(directory, { mode: 0o700 });
    try {
      const directoryStat = await fs.promises.lstat(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw packageCenterError('PACKAGE_JOURNAL_PATH_INVALID', 'Package transaction journal entry is not a real directory');
      }
      try { await fs.promises.chmod(directory, 0o700); } catch (_) {}
      for (let index = 0; index < transaction.changes.length; index += 1) {
        const change = transaction.changes[index];
        if (!change.existed) continue;
        const backupPath = path.join(directory, `before-${index}.bin`);
        await atomicWrite(backupPath, change.oldContent, 0o600);
        const backup = await readRegularFile(backupPath, MAX_FILE_BYTES);
        if (!backup.exists || backup.digest !== change.oldDigest) {
          throw packageCenterError('PACKAGE_JOURNAL_BACKUP_INVALID', 'Package transaction backup could not be verified', { relativePath: change.relativePath });
        }
      }
      const record = journalRecord(transaction, 'prepared');
      const filePath = path.join(directory, JOURNAL_FILE_NAME);
      await atomicWriteJSON(filePath, record);
      transaction.journal = { directory, filePath, record };
      await journalCheckpoint('prepared', transaction);
    } catch (error) {
      if (!simulatedProcessCrash(error)) {
        try { await removeJournalDirectory(directory); } catch (_) {}
      }
      throw error;
    }
  }

  async function updateTransactionJournalState(transaction, state) {
    if (!transaction.journal) return;
    if (!JOURNAL_STATES.has(state)) {
      throw packageCenterError('PACKAGE_JOURNAL_STATE_INVALID', 'Package transaction journal state is invalid');
    }
    transaction.journal.record.state = state;
    await atomicWriteJSON(transaction.journal.filePath, transaction.journal.record);
    await journalCheckpoint(state, transaction);
  }

  async function finalizeTransactionJournal(transaction, state, preserve) {
    if (!transaction.journal) return;
    await updateTransactionJournalState(transaction, state);
    if (!preserve) {
      await removeJournalDirectory(transaction.journal.directory);
      transaction.journal = null;
    }
  }

  function currentIdentity(payload) {
    const current = getWorkspaceIdentity();
    const requestedRoot = payload && (payload.workspaceRoot || payload.context && payload.context.workspaceRoot);
    const requestedIdentity = payload && (payload.workspaceIdentity !== undefined
      ? payload.workspaceIdentity
      : payload.context && payload.context.workspaceIdentity);
    if (!current || !current.rootPath) {
      throw packageCenterError('PACKAGE_WORKSPACE_MISSING', 'No workspace is open');
    }
    if (typeof requestedRoot !== 'string' || !sameRoot(requestedRoot, current.rootPath) || requestedIdentity !== current.workspaceIdentity) {
      throw packageCenterError('PACKAGE_WORKSPACE_STALE', 'The package plan belongs to a different workspace');
    }
    return { rootPath: path.resolve(current.rootPath), workspaceIdentity: current.workspaceIdentity };
  }

  function assertStillCurrent(identity) {
    const current = getWorkspaceIdentity();
    if (!current || current.workspaceIdentity !== identity.workspaceIdentity || !sameRoot(current.rootPath, identity.rootPath)) {
      throw packageCenterError('PACKAGE_WORKSPACE_STALE', 'The workspace changed during the package operation');
    }
  }

  async function inspectChanges(rootPath, rootRealPath, language, rawChanges) {
    if (!Array.isArray(rawChanges) || rawChanges.length < 1 || rawChanges.length > MAX_CHANGE_COUNT) {
      throw packageCenterError('PACKAGE_CHANGE_SET_INVALID', `A package transaction requires between 1 and ${MAX_CHANGE_COUNT} dependency file changes`);
    }
    const seen = new Set();
    const changes = [];
    let totalBytes = 0;
    for (let index = 0; index < rawChanges.length; index += 1) {
      const raw = rawChanges[index];
      if (!isRecord(raw) || typeof raw.oldExists !== 'boolean' || typeof raw.newContent !== 'string') {
        throw packageCenterError('PACKAGE_CHANGE_INVALID', 'Package plan contains an invalid local file change');
      }
      const relativePath = normalizeRelativeManifestPath(raw.path, language);
      const collisionKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
      if (seen.has(collisionKey)) {
        throw packageCenterError('PACKAGE_CHANGE_DUPLICATE', 'Package plan contains the same dependency file more than once', { relativePath });
      }
      seen.add(collisionKey);
      const hasOldDigest = Object.prototype.hasOwnProperty.call(raw, 'oldSha256');
      const suppliedOldDigest = hasOldDigest && raw.oldSha256 != null ? String(raw.oldSha256).toLowerCase() : '';
      if ((raw.oldExists && !DIGEST_PATTERN.test(suppliedOldDigest)) || (!raw.oldExists && suppliedOldDigest !== '')) {
        throw packageCenterError('PACKAGE_CHANGE_DIGEST_INVALID', 'Package plan contains an invalid file digest', { relativePath });
      }
      const expectedOldDigest = raw.oldExists ? suppliedOldDigest : null;
      const expectedNewDigest = String(raw.newSha256 || '').toLowerCase();
      if (!DIGEST_PATTERN.test(expectedNewDigest)) {
        throw packageCenterError('PACKAGE_CHANGE_DIGEST_INVALID', 'Package plan contains an invalid file digest', { relativePath });
      }
      const newContent = Buffer.from(raw.newContent, 'utf8');
      if (newContent.includes(0) || newContent.length > MAX_FILE_BYTES) {
        throw packageCenterError('PACKAGE_CHANGE_CONTENT_INVALID', 'Dependency file content exceeds the transaction limit or contains binary data', { relativePath });
      }
      totalBytes += newContent.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw packageCenterError('PACKAGE_CHANGE_SET_TOO_LARGE', 'Dependency file changes exceed the transaction size limit');
      }
      if (sha256(newContent) !== expectedNewDigest) {
        throw packageCenterError('PACKAGE_CHANGE_NEW_DIGEST_MISMATCH', 'Dependency file content does not match the planned digest', { relativePath });
      }

      const lexicalTarget = path.resolve(rootPath, ...relativePath.split('/'));
      if (pathIsOutside(rootPath, lexicalTarget) || lexicalTarget === rootPath) {
        throw packageCenterError('PACKAGE_CHANGE_PATH_INVALID', 'Dependency file escapes the workspace', { relativePath });
      }
      let parentRealPath;
      try {
        const parentStat = await fs.promises.lstat(path.dirname(lexicalTarget));
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('invalid parent');
        parentRealPath = await fs.promises.realpath(path.dirname(lexicalTarget));
      } catch (_) {
        throw packageCenterError('PACKAGE_CHANGE_PARENT_INVALID', 'Dependency file parent must be an existing real directory', { relativePath });
      }
      if (pathIsOutside(rootRealPath, parentRealPath)) {
        throw packageCenterError('PACKAGE_CHANGE_PATH_INVALID', 'Dependency file parent resolves outside the workspace', { relativePath });
      }
      const target = path.join(parentRealPath, path.basename(lexicalTarget));
      const previous = await readRegularFile(target, MAX_FILE_BYTES);
      if ((expectedOldDigest === null && previous.exists) ||
          (expectedOldDigest !== null && (!previous.exists || previous.digest !== expectedOldDigest))) {
        throw packageCenterError('PACKAGE_CHANGE_OLD_DIGEST_MISMATCH', 'Dependency file changed after the package plan was created', {
          relativePath,
          expectedSha256: expectedOldDigest,
          actualSha256: previous.digest
        });
      }
      if (previous.exists && previous.digest === expectedNewDigest) {
        throw packageCenterError('PACKAGE_CHANGE_NOOP', 'The package plan does not change the dependency file', { relativePath });
      }
      changes.push({
        relativePath,
        target,
        existed: previous.exists,
        oldContent: previous.content,
        oldDigest: previous.digest,
        newContent,
        newDigest: expectedNewDigest,
        mode: previous.stat ? previous.stat.mode & 0o777 : 0o600
      });
    }
    return changes;
  }

  async function inspectManifestBindings(rootPath, rootRealPath, language, rawBindings) {
    if (!Array.isArray(rawBindings) || rawBindings.length < 1 || rawBindings.length > MAX_BINDING_COUNT) {
      throw packageCenterError('PACKAGE_BINDING_SET_INVALID', `A package plan requires between 1 and ${MAX_BINDING_COUNT} dependency manifest bindings`);
    }
    const seen = new Set();
    const bindings = [];
    for (const raw of rawBindings) {
      if (!isRecord(raw) || !DIGEST_PATTERN.test(String(raw.sha256 || ''))) {
        throw packageCenterError('PACKAGE_BINDING_INVALID', 'The reinstall plan contains an invalid dependency manifest binding');
      }
      const relativePath = normalizeRelativeManifestPath(raw.path, language);
      const collisionKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
      if (seen.has(collisionKey)) {
        throw packageCenterError('PACKAGE_BINDING_DUPLICATE', 'The reinstall plan binds the same dependency file more than once', { relativePath });
      }
      seen.add(collisionKey);
      const lexicalTarget = path.resolve(rootPath, ...relativePath.split('/'));
      if (pathIsOutside(rootPath, lexicalTarget) || lexicalTarget === rootPath) {
        throw packageCenterError('PACKAGE_CHANGE_PATH_INVALID', 'Dependency file escapes the workspace', { relativePath });
      }
      let parentRealPath;
      try {
        const parentStat = await fs.promises.lstat(path.dirname(lexicalTarget));
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('invalid parent');
        parentRealPath = await fs.promises.realpath(path.dirname(lexicalTarget));
      } catch (_) {
        throw packageCenterError('PACKAGE_CHANGE_PARENT_INVALID', 'Dependency file parent must be an existing real directory', { relativePath });
      }
      if (pathIsOutside(rootRealPath, parentRealPath)) {
        throw packageCenterError('PACKAGE_CHANGE_PATH_INVALID', 'Dependency file parent resolves outside the workspace', { relativePath });
      }
      const target = path.join(parentRealPath, path.basename(lexicalTarget));
      const expectedDigest = String(raw.sha256).toLowerCase();
      const current = await readRegularFile(target, MAX_FILE_BYTES);
      if (!current.exists || current.digest !== expectedDigest) {
        throw packageCenterError('PACKAGE_BINDING_DIGEST_MISMATCH', 'Dependency file changed after the reinstall plan was created', {
          relativePath,
          expectedSha256: expectedDigest,
          actualSha256: current.digest
        });
      }
      bindings.push({ relativePath, target, digest: expectedDigest });
    }
    return bindings;
  }

  function validatePlanShape(plan, language) {
    const localChanges = Array.isArray(plan.localChanges) ? plan.localChanges : null;
    if (!Array.isArray(plan.manifestBindings) || plan.manifestBindings.length < 1 || plan.manifestBindings.length > MAX_BINDING_COUNT) {
      throw packageCenterError('PACKAGE_BINDING_SET_INVALID', `The package plan must bind between 1 and ${MAX_BINDING_COUNT} dependency files`);
    }
    const bindingDigests = new Map();
    for (const binding of plan.manifestBindings) {
      if (!isRecord(binding)) throw packageCenterError('PACKAGE_BINDING_INVALID', 'The package plan contains an invalid dependency manifest binding');
      const relativePath = normalizeRelativeManifestPath(binding.path, language);
      const collisionKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
      const digest = String(binding.sha256 || '').toLowerCase();
      if (!DIGEST_PATTERN.test(digest) || bindingDigests.has(collisionKey)) {
        throw packageCenterError('PACKAGE_BINDING_INVALID', 'The package plan contains an invalid dependency manifest binding');
      }
      bindingDigests.set(collisionKey, digest);
    }
    if (plan.reinstall === true) {
      const operations = Array.isArray(plan.changes) ? plan.changes : [];
      if (!localChanges || localChanges.length !== 0 || operations.length !== 1 ||
          !isRecord(operations[0]) || String(operations[0].operation || '').toLowerCase() !== 'update' ||
          !String(operations[0].name || '').trim() || !String(operations[0].version || '').trim()) {
        throw packageCenterError('PACKAGE_REINSTALL_PLAN_INVALID', 'The reinstall plan must contain one exact package update and no local file changes');
      }
      return;
    }
    if (!localChanges || localChanges.length < 1 || localChanges.length > MAX_CHANGE_COUNT) {
      throw packageCenterError('PACKAGE_CHANGE_SET_INVALID', `The package adapter must return between 1 and ${MAX_CHANGE_COUNT} dependency file changes`);
    }
    for (const change of localChanges) {
      if (!isRecord(change)) throw packageCenterError('PACKAGE_CHANGE_INVALID', 'Package plan contains an invalid local file change');
      const relativePath = normalizeRelativeManifestPath(change.path, language);
      const collisionKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
      if (bindingDigests.get(collisionKey) !== String(change.newSha256 || '').toLowerCase()) {
        throw packageCenterError('PACKAGE_CHANGE_UNBOUND', 'Every dependency file change must match a reviewed manifest binding', { relativePath });
      }
    }
  }

  function requestFingerprint(planId, revision, language, plan) {
    validatePlanShape(plan, language);
    const rawChanges = plan.localChanges;
    const digest = crypto.createHash('sha256');
    digest.update(planId + '\0' + revision + '\0' + language + '\0' + String(plan.reinstall === true) + '\0');
    let totalBytes = 0;
    for (const raw of rawChanges) {
      if (!isRecord(raw) || typeof raw.newContent !== 'string') {
        throw packageCenterError('PACKAGE_CHANGE_INVALID', 'Package plan contains an invalid local file change');
      }
      const relativePath = normalizeRelativeManifestPath(raw.path, language);
      const content = Buffer.from(raw.newContent, 'utf8');
      totalBytes += content.length;
      if (content.includes(0) || content.length > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
        throw packageCenterError('PACKAGE_CHANGE_CONTENT_INVALID', 'Dependency file content exceeds the transaction limit or contains binary data', { relativePath });
      }
      digest.update(relativePath + '\0' + String(raw.oldExists === true) + '\0' + String(raw.oldSha256 || '').toLowerCase() + '\0' +
        String(raw.newSha256 || '').toLowerCase() + '\0' + sha256(content) + '\0');
    }
    if (plan.reinstall === true) {
      const operation = plan.changes[0];
      digest.update(String(operation.operation).toLowerCase() + '\0' + String(operation.name).trim().toLowerCase() + '\0' + String(operation.version).trim() + '\0');
    }
    for (const binding of plan.manifestBindings) {
      const relativePath = normalizeRelativeManifestPath(binding && binding.path, language);
      const bindingDigest = String(binding && binding.sha256 || '').toLowerCase();
      digest.update(relativePath + '\0' + bindingDigest + '\0');
    }
    return digest.digest('hex');
  }

  function publishedFiles(transaction) {
    return transaction.changes.map(change => ({ path: change.relativePath, sha256: change.newDigest }))
      .concat((transaction.bindings || []).map(binding => ({ path: binding.relativePath, sha256: binding.digest })));
  }

  function publicTransaction(transaction, extra) {
    return Object.assign({
      success: true,
      schema: 'project-package-local-transaction/v1',
      transactionId: transaction.id,
      planId: transaction.planId,
      revision: transaction.revision,
      workspaceRoot: transaction.rootPath,
      workspaceIdentity: transaction.workspaceIdentity,
      reinstall: transaction.reinstall === true,
      changedFiles: transaction.changes.map(change => ({
        path: change.relativePath,
        oldSha256: change.oldDigest,
        newSha256: change.newDigest
      })),
      publishedFiles: publishedFiles(transaction)
    }, extra || {});
  }

  async function assertExpectedFile(change, expectedDigest, code, message, phase) {
    if (beforeCompareAndSwap) {
      await Promise.resolve(beforeCompareAndSwap({
        phase,
        path: change.target,
        relativePath: change.relativePath,
        expectedSha256: expectedDigest
      }));
    }
    const current = await readRegularFile(change.target, MAX_FILE_BYTES);
    const matches = expectedDigest === null
      ? !current.exists
      : current.exists && current.digest === expectedDigest;
    if (!matches) {
      throw packageCenterError(code, message, {
        relativePath: change.relativePath,
        conflicts: [{ path: change.relativePath, expectedSha256: expectedDigest, actualSha256: current.digest }]
      });
    }
    return current;
  }

  async function restoreAppliedChanges(changes, verifyCurrent) {
    const restored = [];
    try {
      for (const change of [...changes].reverse()) {
        const verifyRollbackTarget = verifyCurrent
          ? () => assertExpectedFile(
            change,
            change.newDigest,
            'PACKAGE_ROLLBACK_CONFLICT',
            'Dependency files changed after the package transaction was applied',
            'rollback'
          )
          : null;
        if (change.existed) await atomicWrite(change.target, change.oldContent, change.mode, verifyRollbackTarget);
        else {
          if (verifyRollbackTarget) await verifyRollbackTarget();
          try { await fs.promises.unlink(change.target); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
        }
        restored.push(change);
      }
    } catch (error) {
      for (const change of restored.reverse()) {
        try { await atomicWrite(change.target, change.newContent, change.mode); } catch (_) {}
      }
      throw error;
    }
  }

  function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every(key => allowed.has(key));
  }

  async function loadRecoveryJournal(directory) {
    const rootRealPath = await ensureJournalRoot();
    const validatedDirectory = assertJournalDirectory(directory, rootRealPath);
    const directoryStat = await fs.promises.lstat(validatedDirectory.directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal entry is not a real directory');
    }
    const directoryRealPath = await fs.promises.realpath(validatedDirectory.directory);
    if (!sameRoot(directoryRealPath, validatedDirectory.directory)) {
      throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal entry resolves outside its private directory');
    }
    const filePath = path.join(directoryRealPath, JOURNAL_FILE_NAME);
    const journalFile = await readRegularFile(filePath, MAX_JOURNAL_BYTES);
    if (!journalFile.exists) throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal is missing');
    let record;
    try {
      record = JSON.parse(journalFile.content.toString('utf8'));
    } catch (_) {
      throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal is not valid JSON');
    }
    const topLevelKeys = new Set(['schema', 'transactionId', 'state', 'workspaceRoot', 'files']);
    if (!isRecord(record) || !hasOnlyKeys(record, topLevelKeys) || record.schema !== JOURNAL_SCHEMA ||
        record.transactionId !== validatedDirectory.id || !JOURNAL_STATES.has(record.state) ||
        typeof record.workspaceRoot !== 'string' || !path.isAbsolute(record.workspaceRoot) ||
        !Array.isArray(record.files) || record.files.length < 1 || record.files.length > MAX_CHANGE_COUNT) {
      throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal metadata is invalid');
    }
    const workspaceRoot = path.resolve(record.workspaceRoot);
    if (!sameRoot(workspaceRoot, record.workspaceRoot) || !pathIsOutside(workspaceRoot, rootRealPath)) {
      throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal workspace boundary is invalid');
    }
    const fileKeys = new Set(['target', 'oldExists', 'oldSha256', 'newSha256']);
    const seen = new Set();
    const files = record.files.map((raw, index) => {
      if (!isRecord(raw) || !hasOnlyKeys(raw, fileKeys) || typeof raw.target !== 'string' ||
          !path.isAbsolute(raw.target) || typeof raw.oldExists !== 'boolean') {
        throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal file metadata is invalid');
      }
      const target = path.resolve(raw.target);
      const oldDigest = raw.oldExists ? String(raw.oldSha256 || '').toLowerCase() : null;
      const newDigest = String(raw.newSha256 || '').toLowerCase();
      if (!sameRoot(target, raw.target) || pathIsOutside(workspaceRoot, target) || target === workspaceRoot ||
          (raw.oldExists ? !DIGEST_PATTERN.test(oldDigest) : raw.oldSha256 !== null) ||
          !DIGEST_PATTERN.test(newDigest) || oldDigest === newDigest) {
        throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal file identity is invalid');
      }
      const relativePath = path.relative(workspaceRoot, target).split(path.sep).join('/');
      if (!isAllowedDependencyPath(relativePath)) {
        throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal targets a non-dependency file');
      }
      const collisionKey = pathKey(target);
      if (seen.has(collisionKey)) throw packageCenterError('PACKAGE_JOURNAL_INVALID', 'Package transaction journal contains duplicate files');
      seen.add(collisionKey);
      return {
        index,
        relativePath,
        target,
        existed: raw.oldExists,
        oldDigest,
        newDigest,
        backupPath: raw.oldExists ? path.join(directoryRealPath, `before-${index}.bin`) : null
      };
    });
    return {
      id: record.transactionId,
      rootPath: workspaceRoot,
      changes: files,
      journal: { directory: directoryRealPath, filePath, record }
    };
  }

  async function inspectRecoveryFiles(transaction, commitDirection) {
    let rootStat;
    try {
      rootStat = await fs.promises.lstat(transaction.rootPath);
    } catch (_) {
      throw packageCenterError('PACKAGE_RECOVERY_RECONCILIATION_REQUIRED', 'Package transaction workspace is unavailable');
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw packageCenterError('PACKAGE_RECOVERY_RECONCILIATION_REQUIRED', 'Package transaction workspace is not a real directory');
    }
    const rootRealPath = await fs.promises.realpath(transaction.rootPath);
    if (!sameRoot(rootRealPath, transaction.rootPath)) {
      throw packageCenterError('PACKAGE_RECOVERY_RECONCILIATION_REQUIRED', 'Package transaction workspace boundary changed');
    }
    const conflicts = [];
    for (const change of transaction.changes) {
      let parentRealPath;
      try {
        const parentStat = await fs.promises.lstat(path.dirname(change.target));
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('invalid parent');
        parentRealPath = await fs.promises.realpath(path.dirname(change.target));
      } catch (_) {
        conflicts.push({ path: change.relativePath, expectedSha256: change.newDigest, actualSha256: null });
        continue;
      }
      if (pathIsOutside(rootRealPath, parentRealPath) || !sameRoot(path.join(parentRealPath, path.basename(change.target)), change.target)) {
        conflicts.push({ path: change.relativePath, expectedSha256: change.newDigest, actualSha256: null });
        continue;
      }
      let current;
      try {
        current = await readRegularFile(change.target, MAX_FILE_BYTES);
      } catch (_) {
        conflicts.push({ path: change.relativePath, expectedSha256: change.newDigest, actualSha256: null });
        continue;
      }
      change.current = current;
      change.position = current.exists && current.digest === change.newDigest
        ? 'new'
        : (change.existed ? (current.exists && current.digest === change.oldDigest ? 'old' : 'conflict') : (!current.exists ? 'old' : 'conflict'));
      if (commitDirection ? change.position !== 'new' : change.position === 'conflict') {
        conflicts.push({ path: change.relativePath, expectedSha256: change.newDigest, actualSha256: current.digest });
      }
      if (change.existed) {
        try {
          const backup = await readRegularFile(change.backupPath, MAX_FILE_BYTES);
          if (!backup.exists || backup.digest !== change.oldDigest) throw new Error('invalid backup');
          change.oldContent = backup.content;
        } catch (_) {
          conflicts.push({ path: change.relativePath, expectedSha256: change.oldDigest, actualSha256: null, source: 'journal-backup' });
        }
      }
    }
    return conflicts;
  }

  async function preserveRecoveryJournal(transaction, state, conflicts) {
    try { await updateTransactionJournalState(transaction, state); } catch (_) {}
    await rememberPendingRecovery(transaction, state, conflicts);
    notify('reconciliation-required', transaction, { recovered: true, conflicts: conflicts || [] });
    return {
      success: false,
      transactionId: transaction.id,
      state: 'reconciliation-required',
      reconciliationRequired: true,
      preserved: true,
      conflicts: conflicts || []
    };
  }

  async function recoverJournalDirectory(directory) {
    const transaction = await loadRecoveryJournal(directory);
    const state = transaction.journal.record.state;
    if (['committed', 'rolled-back', 'preserved'].includes(state)) {
      await removeJournalDirectory(transaction.journal.directory);
      return { success: true, transactionId: transaction.id, state, cleaned: true };
    }
    const commitDirection = state === 'server-applied' || state === 'commit-reconciliation-required';
    let conflicts;
    try {
      conflicts = await inspectRecoveryFiles(transaction, commitDirection);
    } catch (error) {
      return preserveRecoveryJournal(transaction, commitDirection ? 'commit-reconciliation-required' : 'rollback-reconciliation-required', [{
        path: '',
        expectedSha256: null,
        actualSha256: null,
        error: serializedError(error)
      }]);
    }
    if (conflicts.length) {
      const result = await preserveRecoveryJournal(transaction, commitDirection ? 'commit-reconciliation-required' : 'rollback-reconciliation-required', conflicts);
      for (const change of transaction.changes) {
        if (change.oldContent) change.oldContent.fill(0);
      }
      return result;
    }
    if (commitDirection) {
      await finalizeTransactionJournal(transaction, 'committed', false);
      for (const change of transaction.changes) {
        if (change.oldContent) change.oldContent.fill(0);
      }
      return { success: true, transactionId: transaction.id, state: 'committed', recovered: true };
    }

    const restored = [];
    try {
      for (const change of [...transaction.changes].reverse()) {
        if (change.position === 'old') continue;
        const verify = () => assertExpectedFile(
          change,
          change.newDigest,
          'PACKAGE_ROLLBACK_CONFLICT',
          'Dependency file changed while an interrupted package transaction was being recovered',
          'recovery'
        );
        if (change.existed) {
          const mode = change.current && change.current.stat ? change.current.stat.mode & 0o777 : 0o600;
          await atomicWrite(change.target, change.oldContent, mode, verify);
        } else {
          await verify();
          try { await fs.promises.unlink(change.target); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
        }
        restored.push(change);
        await journalCheckpoint('recovery-file-restored', transaction, change);
      }
    } catch (error) {
      if (simulatedProcessCrash(error)) {
        wipeTransactionContents(transaction);
        throw error;
      }
      const recoveryConflicts = error && Array.isArray(error.conflicts) ? error.conflicts : [{
        path: error && error.relativePath || '',
        expectedSha256: null,
        actualSha256: null,
        error: serializedError(error)
      }];
      return preserveRecoveryJournal(transaction, 'rollback-reconciliation-required', recoveryConflicts);
    } finally {
      for (const change of transaction.changes) {
        if (change.oldContent) change.oldContent.fill(0);
      }
    }
    reportFilesChanged(restored.map(change => ({
      event: change.existed ? 'file-changed' : 'file-deleted',
      path: change.target,
      relativePath: change.relativePath
    })));
    await finalizeTransactionJournal(transaction, 'rolled-back', false);
    return { success: true, transactionId: transaction.id, state: 'rolled-back', recovered: true };
  }

  async function recoverJournalsUnqueued() {
    const rootRealPath = await ensureJournalRoot();
    const entries = await fs.promises.readdir(rootRealPath, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TRANSACTION_ID_PATTERN.test(entry.name)) continue;
      const directory = path.join(rootRealPath, entry.name);
      try {
        try {
          await fs.promises.lstat(path.join(directory, JOURNAL_FILE_NAME));
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
          // Targets are never mutated before the journal rename succeeds, so
          // a transaction directory without journal.json only contains an
          // interrupted private backup preparation and is safe to discard.
          await removeJournalDirectory(directory);
          results.push({ success: true, transactionId: entry.name, state: 'orphan-preparation-removed', recovered: true });
          continue;
        }
        results.push(await recoverJournalDirectory(directory));
      } catch (error) {
        results.push({ success: false, transactionId: entry.name, preserved: true, error: serializedError(error) });
      }
    }
    return results;
  }

  function rememberFinalized(transaction, state, details) {
    finalized.set(transaction.id, {
      state,
      planId: transaction.planId,
      revision: transaction.revision,
      rootPath: transaction.rootPath,
      workspaceIdentity: transaction.workspaceIdentity,
      reinstall: transaction.reinstall === true,
      publishedFiles: publishedFiles(transaction),
      conflicts: details && Array.isArray(details.conflicts) ? details.conflicts : []
    });
    while (finalized.size > 100) finalized.delete(finalized.keys().next().value);
  }

  function wipeTransactionContents(transaction) {
    for (const change of transaction.changes) {
      if (change.oldContent) change.oldContent.fill(0);
      if (change.newContent) change.newContent.fill(0);
    }
  }

  async function releaseTransaction(transaction, state, details) {
    const preserveJournal = state === 'reconciliation-required' || state === 'superseded';
    const journalState = state === 'reconciliation-required' && details && details.serverApplied
      ? 'commit-reconciliation-required'
      : (preserveJournal ? 'rollback-reconciliation-required' : state);
    await finalizeTransactionJournal(transaction, journalState, preserveJournal);
    if (preserveJournal) await rememberPendingRecovery(transaction, journalState, details && details.conflicts);
    transactions.delete(transaction.id);
    activeByWorkspace.delete(transaction.workspaceKey);
    wipeTransactionContents(transaction);
    rememberFinalized(transaction, state, details);
  }

  async function applyLocalChangesUnqueued(payload) {
    if (workspaceTransitionDepth > 0) {
      throw packageCenterError('PACKAGE_WORKSPACE_TRANSITION', 'Package changes are paused while the workspace is changing');
    }
    if (!isRecord(payload)) throw packageCenterError('PACKAGE_PLAN_INVALID', 'Package plan is required');
    const identity = currentIdentity(payload);
    const unresolved = pendingRecoveriesForRoot(identity.rootPath);
    if (unresolved.length) {
      throw packageCenterError(
        'PACKAGE_RECOVERY_RECONCILIATION_REQUIRED',
        'Resolve the interrupted dependency file transaction before starting another package change',
        { transactionId: unresolved[0].id, reconciliationRequired: true }
      );
    }
    const plan = isRecord(payload.plan) ? payload.plan : payload;
    const planId = String(plan.planId || '').trim();
    const revision = String(plan.revision || payload.revision || '').trim();
    const language = canonicalLanguage(payload.language || payload.context && payload.context.language || plan.language);
    if (!TOKEN_PATTERN.test(planId) || !revision || revision.length > 512 || !language) {
      throw packageCenterError('PACKAGE_PLAN_INVALID', 'Package plan identity, revision, or language is invalid');
    }
    const rawFingerprint = requestFingerprint(planId, revision, language, plan);
    const workspaceKey = transactionKey(identity);
    const existingId = activeByWorkspace.get(workspaceKey);
    if (existingId) {
      const existing = transactions.get(existingId);
      if (existing && existing.planId === planId && existing.requestFingerprint === rawFingerprint) {
        return publicTransaction(existing, { alreadyApplied: true });
      }
      throw packageCenterError('PACKAGE_TRANSACTION_ACTIVE', 'Another package change is awaiting synchronization for this workspace');
    }
    // A Windows 8.3 alias may differ textually from its canonical path while
    // still naming the same ordinary directory. Reject links by file type and
    // identity, then use the canonical root for every containment check.
    const rootRealPath = await resolveWorkspaceRoot(identity.rootPath);
    const reinstall = plan.reinstall === true;
    const changes = reinstall ? [] : await inspectChanges(identity.rootPath, rootRealPath, language, plan.localChanges);
    const transaction = {
      id: crypto.randomUUID(),
      planId,
      revision,
      language,
      reinstall,
      requestFingerprint: rawFingerprint,
      rootPath: identity.rootPath,
      workspaceIdentity: identity.workspaceIdentity,
      workspaceKey,
      changes,
      bindings: [],
      journal: null,
      createdAt: Date.now()
    };
    assertStillCurrent(identity);
    const written = [];
    try {
      await createTransactionJournal(transaction);
      for (const change of changes) {
        // Write and fsync the temporary replacement first, then compare the
        // current manifest at the last responsible moment before rename.
        await atomicWrite(change.target, change.newContent, change.mode, () => assertExpectedFile(
          change,
          change.oldDigest,
          'PACKAGE_CHANGE_OLD_DIGEST_MISMATCH',
          'Dependency file changed immediately before it was written',
          'apply'
        ));
        written.push(change);
        await journalCheckpoint('file-applied', transaction, change);
      }
      assertStillCurrent(identity);
      for (const change of changes) {
        const current = await readRegularFile(change.target, MAX_FILE_BYTES);
        if (!current.exists || current.digest !== change.newDigest) {
          throw packageCenterError('PACKAGE_CHANGE_VERIFY_FAILED', 'Dependency file could not be verified after writing', { relativePath: change.relativePath });
        }
      }
      const verifiedBindings = await inspectManifestBindings(identity.rootPath, rootRealPath, language, plan.manifestBindings);
      const changedPaths = new Set(changes.map(change => process.platform === 'win32' ? change.relativePath.toLowerCase() : change.relativePath));
      transaction.bindings = verifiedBindings.filter(binding => !changedPaths.has(process.platform === 'win32' ? binding.relativePath.toLowerCase() : binding.relativePath));
      await updateTransactionJournalState(transaction, 'applied');
    } catch (error) {
      if (simulatedProcessCrash(error)) {
        wipeTransactionContents(transaction);
        throw error;
      }
      // Never overwrite a newer editor/filesystem write while cleaning up a
      // failed apply. A cleanup conflict deliberately preserves that new truth.
      let cleanupError = null;
      try { await restoreAppliedChanges(written, true); } catch (restoreError) { cleanupError = restoreError; }
      if (cleanupError && cleanupError.code === 'PACKAGE_ROLLBACK_CONFLICT') {
        try { await finalizeTransactionJournal(transaction, 'rollback-reconciliation-required', true); } catch (_) {}
        await rememberPendingRecovery(transaction, 'rollback-reconciliation-required', cleanupError.conflicts || []);
        error.reconciliationRequired = true;
        error.conflicts = cleanupError.conflicts || [];
      } else if (!cleanupError) {
        try { await finalizeTransactionJournal(transaction, 'rolled-back', false); } catch (journalError) { cleanupError = journalError; }
      }
      wipeTransactionContents(transaction);
      if (cleanupError && !error.reconciliationRequired) throw cleanupError;
      throw error;
    }
    transactions.set(transaction.id, transaction);
    activeByWorkspace.set(workspaceKey, transaction.id);
    reportFilesChanged(changes.map(change => ({
      event: change.existed ? 'file-changed' : 'file-created',
      path: change.target,
      relativePath: change.relativePath
    })));
    notify('applied', transaction);
    return publicTransaction(transaction);
  }

  function requireTransaction(payload, options) {
    options = options || {};
    const id = String(payload && payload.transactionId || '').trim();
    if (!id) throw packageCenterError('PACKAGE_TRANSACTION_INVALID', 'Package transaction id is required');
    const transaction = transactions.get(id);
    if (!transaction) {
      const finalState = finalized.get(id);
      if (finalState) {
        if (options.requireIdentity !== false) {
          const identity = currentIdentity(payload);
          if (finalState.workspaceIdentity !== identity.workspaceIdentity || !sameRoot(finalState.rootPath, identity.rootPath)) {
            throw packageCenterError('PACKAGE_WORKSPACE_STALE', 'Package transaction belongs to a different workspace');
          }
        }
        return {
          finalized: finalState.state,
          id,
          planId: finalState.planId,
          revision: finalState.revision,
          rootPath: finalState.rootPath,
          workspaceIdentity: finalState.workspaceIdentity,
          reinstall: finalState.reinstall === true,
          publishedFiles: finalState.publishedFiles || [],
          conflicts: finalState.conflicts || []
        };
      }
      throw packageCenterError('PACKAGE_TRANSACTION_NOT_FOUND', 'Package transaction was not found');
    }
    if (options.requireIdentity !== false) {
      const identity = currentIdentity(payload);
      if (transaction.workspaceIdentity !== identity.workspaceIdentity || !sameRoot(transaction.rootPath, identity.rootPath)) {
        throw packageCenterError('PACKAGE_WORKSPACE_STALE', 'Package transaction belongs to a different workspace');
      }
    }
    return transaction;
  }

  function expectedPublishedFiles(transaction) {
    return transaction.finalized
      ? (transaction.publishedFiles || [])
      : publishedFiles(transaction);
  }

  function validatePublishedSummary(payload, transaction) {
    const supplied = payload && payload.publishedFiles;
    const expected = expectedPublishedFiles(transaction);
    if (!Array.isArray(supplied) || supplied.length !== expected.length) {
      throw packageCenterError('PACKAGE_PUBLISHED_SUMMARY_INVALID', 'Published dependency file summary does not match the local transaction');
    }
    const byPath = new Map();
    for (const item of supplied) {
      if (!isRecord(item) || typeof item.path !== 'string' || !DIGEST_PATTERN.test(String(item.sha256 || ''))) {
        throw packageCenterError('PACKAGE_PUBLISHED_SUMMARY_INVALID', 'Published dependency file summary is invalid');
      }
      byPath.set(item.path, String(item.sha256).toLowerCase());
    }
    for (const item of expected) {
      if (byPath.get(item.path) !== item.sha256) {
        throw packageCenterError('PACKAGE_PUBLISHED_SUMMARY_INVALID', 'Published dependency file summary does not match the local transaction');
      }
    }
  }

  function verificationEntries(transaction) {
    if (transaction.finalized) {
      return (transaction.publishedFiles || []).map(item => ({
        relativePath: item.path,
        target: path.resolve(transaction.rootPath, ...item.path.split('/')),
        digest: item.sha256
      }));
    }
    return transaction.changes.map(change => ({ relativePath: change.relativePath, target: change.target, digest: change.newDigest }))
      .concat((transaction.bindings || []).map(binding => ({ relativePath: binding.relativePath, target: binding.target, digest: binding.digest })));
  }

  function validatedEditorConflicts(payload, transaction) {
    const supplied = payload && payload.editorConflicts;
    if (supplied == null) return [];
    if (!Array.isArray(supplied) || supplied.length > MAX_BINDING_COUNT) {
      throw packageCenterError('PACKAGE_EDITOR_CONFLICT_INVALID', 'Editor conflict summary is invalid');
    }
    const expected = new Map(expectedPublishedFiles(transaction).map(item => [item.path, item.sha256]));
    return supplied.map(item => {
      if (!isRecord(item) || !expected.has(item.path) || String(item.expectedSha256 || '').toLowerCase() !== expected.get(item.path)) {
        throw packageCenterError('PACKAGE_EDITOR_CONFLICT_INVALID', 'Editor conflict does not belong to the published dependency file');
      }
      const actualSha256 = String(item.actualSha256 || '').toLowerCase();
      if (actualSha256 && !DIGEST_PATTERN.test(actualSha256)) {
        throw packageCenterError('PACKAGE_EDITOR_CONFLICT_INVALID', 'Editor conflict contains an invalid content digest');
      }
      return {
        path: item.path,
        source: 'editor',
        expectedSha256: expected.get(item.path),
        actualSha256: actualSha256 || null,
        expectedVersion: Number.isFinite(Number(item.expectedVersion)) ? Number(item.expectedVersion) : null,
        actualVersion: Number.isFinite(Number(item.actualVersion)) ? Number(item.actualVersion) : null
      };
    });
  }

  async function publishedFileConflicts(transaction) {
    const conflicts = [];
    for (const entry of verificationEntries(transaction)) {
      try {
        await assertExpectedFile(
          { target: entry.target, relativePath: entry.relativePath },
          entry.digest,
          'PACKAGE_COMMIT_CONFLICT',
          'Dependency files changed before the published package transaction was finalized',
          'commit'
        );
      } catch (error) {
        if (!error || error.code !== 'PACKAGE_COMMIT_CONFLICT') throw error;
        conflicts.push(...(error.conflicts || []));
      }
    }
    return conflicts;
  }

  function reconciliationResult(transaction, conflicts, alreadyFinalized) {
    return {
      success: true,
      schema: 'project-package-local-transaction/v1',
      transactionId: transaction.id,
      planId: transaction.planId,
      state: 'reconciliation-required',
      committed: false,
      reconciliationRequired: true,
      preserved: true,
      alreadyFinalized: alreadyFinalized === true,
      publishedFiles: expectedPublishedFiles(transaction),
      conflicts: conflicts || []
    };
  }

  async function rollbackTransaction(transaction, reason, requireIdentity) {
    if (requireIdentity) assertStillCurrent(transaction);
    try {
      await restoreAppliedChanges(transaction.changes, true);
    } catch (error) {
      if (!error || error.code !== 'PACKAGE_ROLLBACK_CONFLICT') throw error;
      // A newer editor or filesystem write now owns the manifest. Preserve it,
      // end this transaction, and let the renderer sync that newer truth.
      await releaseTransaction(transaction, 'superseded', { conflicts: error.conflicts || [] });
      notify('superseded', transaction, { reason: String(reason || ''), conflicts: error.conflicts || [] });
      return publicTransaction(transaction, {
        rolledBack: false,
        superseded: true,
        preserved: true,
        conflicts: error.conflicts || []
      });
    }
    reportFilesChanged(transaction.changes.map(change => ({
      event: change.existed ? 'file-changed' : 'file-deleted',
      path: change.target,
      relativePath: change.relativePath
    })));
    await releaseTransaction(transaction, 'rolled-back');
    notify('rolled-back', transaction, { reason: String(reason || '') });
    return publicTransaction(transaction, { rolledBack: true });
  }

  async function rollbackLocalChangesUnqueued(payload) {
    const transaction = requireTransaction(payload);
    if (transaction.finalized) {
      return { success: true, transactionId: transaction.id, alreadyFinalized: true, state: transaction.finalized };
    }
    return rollbackTransaction(transaction, payload && payload.reason, true);
  }

  async function commitLocalChangesUnqueued(payload) {
    const serverApplied = payload && payload.serverApplied === true;
    const transaction = requireTransaction(payload, { requireIdentity: !serverApplied });
    if (serverApplied && (!TOKEN_PATTERN.test(String(payload.planId || '')) || payload.planId !== transaction.planId)) {
      throw packageCenterError('PACKAGE_PLAN_INVALID', 'Published package plan identity does not match the local transaction');
    }
    if (serverApplied) validatePublishedSummary(payload, transaction);
    if (transaction.finalized) {
      if (serverApplied) {
        if (transaction.finalized === 'reconciliation-required') {
          return reconciliationResult(transaction, transaction.conflicts, true);
        }
        if (transaction.finalized !== 'committed' && transaction.finalized !== 'preserved') {
          throw packageCenterError('PACKAGE_PUBLISHED_TRANSACTION_LOST', 'The published package transaction was already finalized with incompatible local files');
        }
        if (transaction.finalized === 'preserved') {
          const conflicts = (await publishedFileConflicts(transaction)).concat(validatedEditorConflicts(payload, transaction));
          const finalState = finalized.get(transaction.id);
          if (conflicts.length) {
            finalState.state = 'reconciliation-required';
            finalState.conflicts = conflicts;
            notify('reconciliation-required', transaction, { previousState: 'preserved', serverApplied: true, conflicts });
            return reconciliationResult(transaction, conflicts, true);
          }
          finalState.state = 'committed';
          notify('committed', transaction, { previousState: 'preserved', serverApplied: true });
          return {
            success: true,
            transactionId: transaction.id,
            alreadyFinalized: true,
            previousState: 'preserved',
            state: 'committed',
            committed: true
          };
        }
      }
      return { success: true, transactionId: transaction.id, alreadyFinalized: true, state: transaction.finalized };
    }
    if (serverApplied) await updateTransactionJournalState(transaction, 'server-applied');
    if (!serverApplied) assertStillCurrent(transaction);
    const conflicts = await publishedFileConflicts(transaction);
    if (serverApplied) conflicts.push(...validatedEditorConflicts(payload, transaction));
    if (conflicts.length) {
      if (!serverApplied) {
        throw packageCenterError('PACKAGE_COMMIT_CONFLICT', 'Dependency files changed before the package transaction was committed', { conflicts });
      }
      const result = reconciliationResult(transaction, conflicts, false);
      await releaseTransaction(transaction, 'reconciliation-required', { conflicts, serverApplied: true });
      notify('reconciliation-required', transaction, { serverApplied: true, conflicts });
      return result;
    }
    await releaseTransaction(transaction, 'committed');
    notify('committed', transaction, { serverApplied });
    return publicTransaction(transaction, { committed: true });
  }

  async function rollbackAllUnqueued(reason) {
    const results = [];
    for (const transaction of [...transactions.values()]) {
      try {
        results.push(await rollbackTransaction(transaction, reason || 'lifecycle', false));
      } catch (error) {
        results.push({ success: false, transactionId: transaction.id, error: serializedError(error) });
      }
    }
    return results;
  }

  async function preserveAllUnqueued(reason) {
    const results = [];
    for (const transaction of [...transactions.values()]) {
      const result = publicTransaction(transaction, { preserved: true, reason: String(reason || 'lifecycle') });
      await releaseTransaction(transaction, 'preserved');
      notify('preserved', transaction, { reason: String(reason || 'lifecycle') });
      results.push(result);
    }
    return results;
  }

  async function beginWorkspaceTransitionUnqueued(reason) {
    workspaceTransitionDepth += 1;
    try {
      // Once the renderer has approved leaving, publication may already have
      // completed. Preserve the reviewed manifest as durable project truth.
      return preserveAllUnqueued(reason || 'workspace-transition');
    } catch (error) {
      workspaceTransitionDepth = Math.max(0, workspaceTransitionDepth - 1);
      throw error;
    }
  }

  async function listPendingRecoveriesUnqueued(payload) {
    const identity = currentIdentity(payload);
    const entries = pendingRecoveriesForRoot(identity.rootPath);
    const recoveries = [];
    for (const entry of entries) {
      const transaction = await loadRecoveryJournal(entry.directory);
      if (!sameRoot(transaction.rootPath, identity.rootPath)) {
        throw packageCenterError('PACKAGE_WORKSPACE_STALE', 'Package recovery belongs to a different workspace');
      }
      await rememberPendingRecovery(transaction, entry.state, entry.conflicts);
      recoveries.push(publicPendingRecovery(pendingRecoveries.get(entry.id)));
    }
    recoveries.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
    return { success: true, schema: 'project-package-local-recoveries/v1', recoveries };
  }

  async function validateAcceptedRecoveryFiles(payload, transaction) {
    const supplied = payload && payload.files;
    if (!Array.isArray(supplied) || supplied.length !== transaction.changes.length) {
      throw packageCenterError('PACKAGE_RECOVERY_ACCEPT_INVALID', 'Current dependency file summary is required to clear package recovery');
    }
    const expected = new Map();
    for (const item of supplied) {
      if (!isRecord(item) || typeof item.path !== 'string' || typeof item.exists !== 'boolean') {
        throw packageCenterError('PACKAGE_RECOVERY_ACCEPT_INVALID', 'Current dependency file summary is invalid');
      }
      const digest = item.exists ? String(item.sha256 || '').toLowerCase() : null;
      if ((item.exists && !DIGEST_PATTERN.test(digest)) || (!item.exists && item.sha256 !== null)) {
        throw packageCenterError('PACKAGE_RECOVERY_ACCEPT_INVALID', 'Current dependency file summary is invalid');
      }
      if (expected.has(item.path)) throw packageCenterError('PACKAGE_RECOVERY_ACCEPT_INVALID', 'Current dependency file summary contains duplicate paths');
      expected.set(item.path, { exists: item.exists, digest });
    }
    const conflicts = [];
    for (const change of transaction.changes) {
      const accepted = expected.get(change.relativePath);
      if (!accepted) throw packageCenterError('PACKAGE_RECOVERY_ACCEPT_INVALID', 'Current dependency file summary does not match package recovery');
      const current = await readRegularFile(change.target, MAX_FILE_BYTES);
      if (current.exists !== accepted.exists || (current.exists && current.digest !== accepted.digest)) {
        conflicts.push({ path: change.relativePath, expectedSha256: accepted.digest, actualSha256: current.digest });
      }
    }
    if (conflicts.length) {
      throw packageCenterError(
        'PACKAGE_RECOVERY_CAS_MISMATCH',
        'Dependency files changed while package recovery was being cleared',
        { conflicts, reconciliationRequired: true, transactionId: transaction.id }
      );
    }
  }

  async function resolvePendingRecoveryUnqueued(payload) {
    if (!isRecord(payload) || !TRANSACTION_ID_PATTERN.test(String(payload.transactionId || ''))) {
      throw packageCenterError('PACKAGE_TRANSACTION_INVALID', 'Package recovery transaction id is required');
    }
    const identity = currentIdentity(payload);
    const id = String(payload.transactionId);
    const entry = pendingRecoveries.get(id);
    if (!entry) return { success: true, transactionId: id, resolved: true, alreadyResolved: true };
    if (!sameRoot(entry.rootPath, identity.rootPath)) {
      throw packageCenterError('PACKAGE_WORKSPACE_STALE', 'Package recovery belongs to a different workspace');
    }
    const action = String(payload.action || '').trim().toLowerCase();
    if (action === 'retry') {
      const result = await recoverJournalDirectory(entry.directory);
      const pending = pendingRecoveries.get(id);
      return pending
        ? { success: true, transactionId: id, resolved: false, recovery: publicPendingRecovery(pending) }
        : { success: true, transactionId: id, resolved: true, state: result.state || 'rolled-back' };
    }
    if (action === 'accept-current') {
      const transaction = await loadRecoveryJournal(entry.directory);
      if (!sameRoot(transaction.rootPath, identity.rootPath) ||
          !['rollback-reconciliation-required', 'commit-reconciliation-required'].includes(transaction.journal.record.state)) {
        throw packageCenterError('PACKAGE_RECOVERY_ACCEPT_INVALID', 'Package recovery is not awaiting reconciliation');
      }
      await validateAcceptedRecoveryFiles(payload, transaction);
      await finalizeTransactionJournal(transaction, 'preserved', false);
      return { success: true, transactionId: id, resolved: true, state: 'preserved' };
    }
    throw packageCenterError('PACKAGE_RECOVERY_ACTION_INVALID', 'Package recovery action is invalid');
  }

  function invokeSafely(operation) {
    return enqueue(operation).catch(error => ({ success: false, error: serializedError(error) }));
  }

  function registerIpc() {
    ipcMain.handle('package-center:apply-local-changes', async (event, payload) => {
      try { requireCurrentSender(event); } catch (error) { return { success: false, error: serializedError(error) }; }
      return invokeSafely(() => applyLocalChangesUnqueued(payload));
    });
    ipcMain.handle('package-center:rollback-local-changes', async (event, payload) => {
      try { requireCurrentSender(event); } catch (error) { return { success: false, error: serializedError(error) }; }
      return invokeSafely(() => rollbackLocalChangesUnqueued(payload));
    });
    ipcMain.handle('package-center:commit-local-changes', async (event, payload) => {
      try { requireCurrentSender(event); } catch (error) { return { success: false, error: serializedError(error) }; }
      return invokeSafely(() => commitLocalChangesUnqueued(payload));
    });
    ipcMain.handle('package-center:list-pending-recoveries', async (event, payload) => {
      try { requireCurrentSender(event); } catch (error) { return { success: false, error: serializedError(error) }; }
      return invokeSafely(() => listPendingRecoveriesUnqueued(payload));
    });
    ipcMain.handle('package-center:resolve-pending-recovery', async (event, payload) => {
      try { requireCurrentSender(event); } catch (error) { return { success: false, error: serializedError(error) }; }
      return invokeSafely(() => resolvePendingRecoveryUnqueued(payload));
    });
  }

  const recoveryReady = enqueue(() => recoverJournalsUnqueued());

  return {
    registerIpc,
    applyLocalChanges: payload => enqueue(() => applyLocalChangesUnqueued(payload)),
    rollbackLocalChanges: payload => enqueue(() => rollbackLocalChangesUnqueued(payload)),
    commitLocalChanges: payload => enqueue(() => commitLocalChangesUnqueued(payload)),
    listPendingRecoveries: payload => enqueue(() => listPendingRecoveriesUnqueued(payload)),
    resolvePendingRecovery: payload => enqueue(() => resolvePendingRecoveryUnqueued(payload)),
    rollbackAll: reason => enqueue(() => rollbackAllUnqueued(reason)),
    preserveAll: reason => enqueue(() => preserveAllUnqueued(reason)),
    beginWorkspaceTransition: reason => enqueue(() => beginWorkspaceTransitionUnqueued(reason)),
    endWorkspaceTransition: () => enqueue(() => {
      workspaceTransitionDepth = Math.max(0, workspaceTransitionDepth - 1);
      return workspaceTransitionDepth;
    }),
    ready: () => recoveryReady,
    recoverIncompleteTransactions: () => enqueue(() => recoverJournalsUnqueued()),
    activeTransactionCount: () => transactions.size
  };
}

module.exports = {
  MAX_CHANGE_COUNT,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  canonicalLanguage,
  createPackageCenterController,
  normalizeRelativeManifestPath,
  resolveWorkspaceRoot,
  sha256
};
