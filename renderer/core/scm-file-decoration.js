import { toDisposable } from './disposable.js';

const MAX_ENTRIES = 4096;
const MAX_PATH_LENGTH = 1024;

export const ScmFileStatus = Object.freeze({
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  UNTRACKED: 'untracked',
  CONFLICTED: 'conflicted',
  IGNORED: 'ignored'
});

const KNOWN_STATUSES = new Set(Object.values(ScmFileStatus));
const PRESENTATION = Object.freeze({
  [ScmFileStatus.ADDED]: Object.freeze({ badge: 'A', color: 'success', tooltip: 'Source control: Added' }),
  [ScmFileStatus.MODIFIED]: Object.freeze({ badge: 'M', color: 'warning', tooltip: 'Source control: Modified' }),
  [ScmFileStatus.DELETED]: Object.freeze({ badge: 'D', color: 'danger', tooltip: 'Source control: Deleted' }),
  [ScmFileStatus.RENAMED]: Object.freeze({ badge: 'R', color: 'info', tooltip: 'Source control: Renamed' }),
  [ScmFileStatus.UNTRACKED]: Object.freeze({ badge: 'U', color: 'success', tooltip: 'Source control: Untracked' }),
  [ScmFileStatus.CONFLICTED]: Object.freeze({ badge: '!', color: 'danger', tooltip: 'Source control: Conflicted' }),
  [ScmFileStatus.IGNORED]: Object.freeze({ badge: 'I', color: 'muted', tooltip: 'Source control: Ignored' })
});

function requireString(value, label, maxLength) {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(label + ' is invalid.');
  }
  return value;
}

/**
 * Normalizes a workspace-relative file path without consulting the actual
 * workspace root. The host is the only component allowed to resolve the path
 * against a local folder; package code cannot provide a root or a cwd.
 */
export function normalizeScmRelativePath(value) {
  let result = requireString(value, 'SCM file path', MAX_PATH_LENGTH).replace(/\\/g, '/');
  while (result.startsWith('./')) result = result.slice(2);
  if (!result || result === '.' || /^(?:[A-Za-z]:\/|\/|\\\\)/.test(result)) {
    throw new TypeError('SCM file path must be workspace-relative.');
  }
  const segments = result.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('SCM file path must not traverse outside the workspace.');
  }
  return result;
}

export function normalizeScmDecorationEntries(value) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new TypeError('SCM decoration entries must be an array with at most ' + MAX_ENTRIES + ' items.');
  }
  const paths = new Set();
  const entries = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each SCM decoration entry must be a plain object.');
    }
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== 'path' && key !== 'status')) {
      throw new TypeError('SCM decoration entry includes an unsupported field.');
    }
    const path = normalizeScmRelativePath(entry.path);
    if (paths.has(path)) throw new TypeError('SCM decoration entries must not repeat a path.');
    paths.add(path);
    if (!KNOWN_STATUSES.has(entry.status)) {
      throw new TypeError('SCM decoration status is not supported.');
    }
    return Object.freeze({ path, status: entry.status });
  });
  return Object.freeze(entries);
}

function normalizeClearPaths(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new TypeError('SCM clear paths must be an array with at most ' + MAX_ENTRIES + ' items.');
  }
  return Object.freeze(value.map((path) => normalizeScmRelativePath(path)));
}

function sameStatus(previous, next) {
  return previous && next && previous.status === next.status;
}

/**
 * A trusted, static provider which translates data-only worker publications
 * into the existing SCM decoration lane. The Worker never supplies callbacks,
 * badges, colors, tooltips, styles, or DOM; all presentation stays here.
 */
export function createScmFileDecorationProvider(options = {}) {
  const id = requireString(options.id, 'SCM decoration provider id', 180);
  const namespace = requireString(options.namespace, 'SCM decoration provider namespace', 180);
  const priority = options.priority === undefined ? 0 : options.priority;
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
    throw new TypeError('SCM decoration provider priority must be an integer from -1000 to 1000.');
  }
  const localize = typeof options.localize === 'function' ? options.localize : (key) => key;
  const entries = new Map();
  const listeners = new Set();
  let disposed = false;

  function emit(paths) {
    if (disposed || paths.length === 0) return;
    const snapshot = Object.freeze([...new Set(paths)]);
    for (const listener of Array.from(listeners)) {
      try { listener(snapshot); } catch (_) {}
    }
  }

  function set(value) {
    if (disposed) throw new Error('SCM decoration provider has been disposed.');
    const normalizedEntries = normalizeScmDecorationEntries(value);
    const next = new Map(normalizedEntries.map((entry) => [entry.path, entry]));
    const changedPaths = [];
    for (const [path, previous] of entries) {
      const replacement = next.get(path);
      if (!sameStatus(previous, replacement)) changedPaths.push(path);
    }
    for (const [path, replacement] of next) {
      const previous = entries.get(path);
      if (!sameStatus(previous, replacement) && !changedPaths.includes(path)) changedPaths.push(path);
    }
    entries.clear();
    for (const [path, entry] of next) entries.set(path, entry);
    emit(changedPaths);
    return Object.freeze({ changedPaths: Object.freeze(changedPaths), entryCount: entries.size });
  }

  function clear(value) {
    if (disposed) return Object.freeze({ clearedPaths: Object.freeze([]), entryCount: 0 });
    const paths = normalizeClearPaths(value);
    const clearedPaths = [];
    if (paths === null) {
      for (const path of entries.keys()) clearedPaths.push(path);
      entries.clear();
    } else {
      for (const path of paths) {
        if (entries.delete(path)) clearedPaths.push(path);
      }
    }
    emit(clearedPaths);
    return Object.freeze({ clearedPaths: Object.freeze(clearedPaths), entryCount: entries.size });
  }

  const provider = {
    id,
    namespace,
    lane: 'scm',
    priority,
    getDecoration(pathValue) {
      let path;
      try { path = normalizeScmRelativePath(pathValue); } catch (_) { return null; }
      const entry = entries.get(path);
      if (!entry) return null;
      const presentation = PRESENTATION[entry.status];
      const tooltip = String(localize(presentation.tooltip) || presentation.tooltip);
      return Object.freeze({
        status: entry.status,
        badge: presentation.badge,
        color: presentation.color,
        tooltip,
        ariaLabel: tooltip
      });
    },
    onDidChange(listener) {
      if (typeof listener !== 'function') throw new TypeError('SCM decoration listener must be a function.');
      if (disposed) return toDisposable(() => {});
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    set,
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      entries.clear();
      listeners.clear();
    }
  };
  return Object.freeze(provider);
}
