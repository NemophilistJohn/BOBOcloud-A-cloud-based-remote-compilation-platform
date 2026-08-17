const MAX_REFERENCE_LENGTH = 160;
const MAX_REMOTE_URL_LENGTH = 2048;
const MAX_COMMIT_MESSAGE_LENGTH = 16 * 1024;
const MAX_PATH_COUNT = 256;
const MAX_STATUS_ITEMS = 200;
const MAX_PAGE_OFFSET = 10_000;

export const ScmGitOperation = Object.freeze({
  DETECT: 'detect',
  STATUS: 'status',
  HISTORY: 'history',
  DIFF: 'diff',
  BRANCHES: 'branches',
  REMOTES: 'remotes',
  CLONE: 'clone',
  INIT: 'init',
  SET_REMOTE: 'setRemote',
  STAGE: 'stage',
  STAGE_ALL: 'stageAll',
  UNSTAGE: 'unstage',
  COMMIT: 'commit',
  CHECKOUT: 'checkout',
  CREATE_BRANCH: 'createBranch',
  DELETE_BRANCH: 'deleteBranch',
  FETCH: 'fetch',
  PULL: 'pull',
  PUSH: 'push'
});

export const ScmGitPermission = Object.freeze({
  READ: 'scm.git.read',
  WRITE: 'scm.git.write'
});

const READ_OPERATIONS = new Set([
  ScmGitOperation.DETECT,
  ScmGitOperation.STATUS,
  ScmGitOperation.HISTORY,
  ScmGitOperation.DIFF,
  ScmGitOperation.BRANCHES,
  ScmGitOperation.REMOTES
]);

const WRITE_OPERATIONS = new Set([
  ScmGitOperation.INIT,
  ScmGitOperation.CLONE,
  ScmGitOperation.SET_REMOTE,
  ScmGitOperation.STAGE,
  ScmGitOperation.STAGE_ALL,
  ScmGitOperation.UNSTAGE,
  ScmGitOperation.COMMIT,
  ScmGitOperation.CHECKOUT,
  ScmGitOperation.CREATE_BRANCH,
  ScmGitOperation.DELETE_BRANCH,
  ScmGitOperation.FETCH,
  ScmGitOperation.PULL,
  ScmGitOperation.PUSH
]);

const FIELDS_BY_OPERATION = Object.freeze({
  [ScmGitOperation.DETECT]: ['includeNested'],
  [ScmGitOperation.STATUS]: ['repositoryId', 'offset', 'limit'],
  [ScmGitOperation.HISTORY]: ['repositoryId', 'offset', 'limit', 'ref'],
  [ScmGitOperation.DIFF]: ['repositoryId', 'path', 'ref', 'staged'],
  [ScmGitOperation.BRANCHES]: ['repositoryId'],
  [ScmGitOperation.REMOTES]: ['repositoryId'],
  [ScmGitOperation.CLONE]: ['url', 'branch'],
  [ScmGitOperation.INIT]: [],
  [ScmGitOperation.SET_REMOTE]: ['repositoryId', 'name', 'url'],
  [ScmGitOperation.STAGE]: ['repositoryId', 'paths'],
  [ScmGitOperation.STAGE_ALL]: ['repositoryId'],
  [ScmGitOperation.UNSTAGE]: ['repositoryId', 'paths'],
  [ScmGitOperation.COMMIT]: ['repositoryId', 'message'],
  [ScmGitOperation.CHECKOUT]: ['repositoryId', 'branch', 'force'],
  [ScmGitOperation.CREATE_BRANCH]: ['repositoryId', 'name', 'checkout'],
  [ScmGitOperation.DELETE_BRANCH]: ['repositoryId', 'name', 'force'],
  [ScmGitOperation.FETCH]: ['repositoryId', 'remote'],
  [ScmGitOperation.PULL]: ['repositoryId', 'remote', 'branch'],
  [ScmGitOperation.PUSH]: ['repositoryId', 'remote', 'branch', 'force', 'setUpstream']
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function repositoryId(value) {
  if (typeof value !== 'string' || !/^scm-[A-Za-z0-9-]{16,128}$/.test(value)) {
    throw new TypeError('SCM repository id must be an opaque id returned by detect.');
  }
  return value;
}

function normalizeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\u0000') || value.includes('\\')) {
    throw new TypeError(label + ' must be a short repository-relative POSIX path.');
  }
  const parts = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new TypeError(label + ' must stay inside the repository.');
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const normalized = parts.join('/');
  if (!normalized || value.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new TypeError(label + ' must stay inside the repository.');
  }
  return normalized;
}

function normalizeRef(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_REFERENCE_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') ||
      value.includes('//') || value.includes('@{') || value.endsWith('.') || value.endsWith('/')) {
    throw new TypeError(label + ' is invalid.');
  }
  return value;
}

function normalizeBranchName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') ||
      value.includes('//') || value.includes('@{') || value.endsWith('.') || value.endsWith('/')) {
    throw new TypeError(label + ' is invalid.');
  }
  return value;
}

function normalizeOptionalBranch(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeBranchName(value, label);
}

function normalizeRemoteName(value, label, fallback = 'origin') {
  const name = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new TypeError(label + ' is invalid.');
  }
  return name;
}

function normalizeRemoteUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_REMOTE_URL_LENGTH || /[\s\u0000]/.test(value)) {
    throw new TypeError('SCM remote url is invalid.');
  }
  if (/^https:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new TypeError('SCM remote url is invalid.'); }
    if (!parsed.hostname || parsed.password || parsed.search || parsed.hash ||
        (parsed.protocol === 'https:' && parsed.username)) {
      throw new TypeError('SCM remote url is invalid.');
    }
    return value;
  }
  const scp = !value.includes('://') && value.match(/^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):[A-Za-z0-9._~/-]+$/);
  if (scp && (scp[1] || scp[2].includes('.') || scp[2].toLowerCase() === 'localhost')) return value;
  throw new TypeError('SCM remote url must use HTTPS or SSH.');
}

function normalizeCommitMessage(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_COMMIT_MESSAGE_LENGTH || value.includes('\u0000')) {
    throw new TypeError('SCM commit message is invalid.');
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(label + ' must be a boolean.');
  return value;
}

function requirePaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATH_COUNT) {
    throw new TypeError('SCM paths must contain between 1 and ' + MAX_PATH_COUNT + ' relative paths.');
  }
  const paths = value.map((item) => normalizeRelativePath(item, 'SCM path'));
  if (new Set(paths).size !== paths.length) throw new TypeError('SCM paths must not repeat a repository-relative path.');
  return Object.freeze(paths);
}

function normalizeOffset(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > MAX_PAGE_OFFSET) {
    throw new TypeError('SCM offset must be an integer from 0 to ' + MAX_PAGE_OFFSET + '.');
  }
  return value;
}

function normalizeLimit(value, maximum, label) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(label + ' must be an integer from 1 to ' + maximum + '.');
  }
  return value;
}

function normalizeArguments(operation, value) {
  if (!isPlainObject(value)) throw new TypeError('SCM Git arguments must be a plain object.');
  const allowedFields = new Set(FIELDS_BY_OPERATION[operation]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new TypeError('SCM Git operation "' + operation + '" does not accept "' + field + '".');
    }
  }

  const result = Object.create(null);
  if (operation !== ScmGitOperation.DETECT && operation !== ScmGitOperation.CLONE && operation !== ScmGitOperation.INIT) {
    result.repositoryId = repositoryId(value.repositoryId);
  }
  switch (operation) {
    case ScmGitOperation.DETECT:
      if (value.includeNested !== undefined) result.includeNested = requireBoolean(value.includeNested, 'SCM includeNested');
      break;
    case ScmGitOperation.STATUS: {
      const offset = normalizeOffset(value.offset);
      const limit = normalizeLimit(value.limit, MAX_STATUS_ITEMS, 'SCM status limit');
      if (offset !== undefined) result.offset = offset;
      if (limit !== undefined) result.limit = limit;
      break;
    }
    case ScmGitOperation.HISTORY:
      {
        const offset = normalizeOffset(value.offset);
        const limit = normalizeLimit(value.limit, 500, 'SCM history limit');
        if (offset !== undefined) result.offset = offset;
        if (limit !== undefined) result.limit = limit;
      }
      if (Object.prototype.hasOwnProperty.call(value, 'ref')) {
        const ref = normalizeRef(value.ref, 'SCM ref');
        if (ref !== undefined) result.ref = ref;
      }
      break;
    case ScmGitOperation.DIFF:
      if (value.path !== undefined && value.path !== null && value.path !== '') {
        result.path = normalizeRelativePath(value.path, 'SCM path');
      }
      if (Object.prototype.hasOwnProperty.call(value, 'ref')) {
        const ref = normalizeRef(value.ref, 'SCM ref');
        if (ref !== undefined) result.ref = ref;
      }
      if (value.staged !== undefined) result.staged = requireBoolean(value.staged, 'SCM staged');
      break;
    case ScmGitOperation.CLONE:
      result.url = normalizeRemoteUrl(value.url);
      if (Object.prototype.hasOwnProperty.call(value, 'branch')) {
        const branch = normalizeOptionalBranch(value.branch, 'SCM branch');
        if (branch !== undefined) result.branch = branch;
      }
      break;
    case ScmGitOperation.SET_REMOTE:
      result.name = normalizeRemoteName(value.name, 'SCM remote name');
      result.url = normalizeRemoteUrl(value.url);
      break;
    case ScmGitOperation.STAGE:
    case ScmGitOperation.UNSTAGE:
      result.paths = requirePaths(value.paths);
      break;
    case ScmGitOperation.COMMIT:
      result.message = normalizeCommitMessage(value.message);
      break;
    case ScmGitOperation.CHECKOUT:
      result.branch = normalizeBranchName(value.branch, 'SCM branch');
      if (value.force !== undefined) result.force = requireBoolean(value.force, 'SCM force');
      break;
    case ScmGitOperation.CREATE_BRANCH:
      result.name = normalizeBranchName(value.name, 'SCM branch name');
      if (value.checkout !== undefined) result.checkout = requireBoolean(value.checkout, 'SCM checkout');
      break;
    case ScmGitOperation.DELETE_BRANCH:
      result.name = normalizeBranchName(value.name, 'SCM branch name');
      if (value.force !== undefined) result.force = requireBoolean(value.force, 'SCM force');
      break;
    case ScmGitOperation.FETCH:
      if (Object.prototype.hasOwnProperty.call(value, 'remote')) result.remote = normalizeRemoteName(value.remote, 'SCM remote');
      break;
    case ScmGitOperation.PULL:
      if (Object.prototype.hasOwnProperty.call(value, 'remote')) result.remote = normalizeRemoteName(value.remote, 'SCM remote');
      if (Object.prototype.hasOwnProperty.call(value, 'branch')) {
        const branch = normalizeOptionalBranch(value.branch, 'SCM branch');
        if (branch !== undefined) result.branch = branch;
      }
      break;
    case ScmGitOperation.PUSH:
      if (Object.prototype.hasOwnProperty.call(value, 'remote')) result.remote = normalizeRemoteName(value.remote, 'SCM remote');
      if (Object.prototype.hasOwnProperty.call(value, 'branch')) {
        const branch = normalizeOptionalBranch(value.branch, 'SCM branch');
        if (branch !== undefined) result.branch = branch;
      }
      if (value.force !== undefined) result.force = requireBoolean(value.force, 'SCM force');
      if (value.setUpstream !== undefined) result.setUpstream = requireBoolean(value.setUpstream, 'SCM setUpstream');
      break;
    default:
      break;
  }
  return Object.freeze(result);
}

export function scmGitPermissionForOperation(operation) {
  if (READ_OPERATIONS.has(operation)) return ScmGitPermission.READ;
  if (WRITE_OPERATIONS.has(operation)) return ScmGitPermission.WRITE;
  throw new TypeError('Unknown SCM Git operation: ' + String(operation));
}

/**
 * The broker selects the local worktree from an opaque repositoryId. This
 * renderer contract accepts no cwd, repository root, environment, shell, or
 * arbitrary Git arguments, which keeps cloud synchronization out of SCM.
 */
export function normalizeScmGitRequest(value) {
  if (!isPlainObject(value)) throw new TypeError('SCM Git request must be a plain object.');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'operation' && key !== 'args')) {
    throw new TypeError('SCM Git request includes an unsupported field.');
  }
  if (typeof value.operation !== 'string') throw new TypeError('SCM Git operation must be a string.');
  const operation = value.operation;
  const permission = scmGitPermissionForOperation(operation);
  const args = normalizeArguments(operation, value.args === undefined ? Object.create(null) : value.args);
  return Object.freeze({ operation, permission, args });
}
