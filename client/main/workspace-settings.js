'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('jsonc-parser');
const minimatch = require('minimatch');
const { readFileBounded } = require('./atomic-file');

const SCHEMA_VERSION = 1;
const MAX_SETTINGS_BYTES = 256 * 1024;
const WORD_WRAP_VALUES = new Set(['off', 'on', 'wordWrapColumn', 'bounded']);
const RENDER_WHITESPACE_VALUES = new Set(['none', 'boundary', 'selection', 'trailing', 'all']);
const EDITOR_SETTING_KEYS = new Set([
  'editor.tabSize',
  'editor.insertSpaces',
  'editor.wordWrap',
  'editor.wordWrapColumn',
  'editor.rulers',
  'editor.renderWhitespace',
  'editor.minimap.enabled',
  'editor.bracketPairColorization.enabled'
]);
const KNOWN_LANGUAGE_IDS = new Set([
  'c', 'cpp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'less',
  'markdown', 'php', 'plaintext', 'python', 'ruby', 'rust', 'scss', 'shell',
  'sql', 'typescript', 'xml', 'yaml'
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.keys(value).forEach((key) => deepFreeze(value[key]));
  return value;
}

function warningCollector() {
  const counts = new Map();
  return {
    add(code, count = 1) {
      counts.set(code, (counts.get(code) || 0) + count);
    },
    value() {
      return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({ code, count }));
    }
  };
}

function normalizedEditorSettings(source, warnings) {
  const result = {};
  if (!isRecord(source)) {
    warnings.add('WORKSPACE_SETTINGS_SCOPE_INVALID');
    return result;
  }
  for (const key of Object.keys(source)) {
    if (!EDITOR_SETTING_KEYS.has(key)) {
      warnings.add('WORKSPACE_SETTING_UNSUPPORTED');
      continue;
    }
    const value = source[key];
    if (key === 'editor.tabSize') {
      if (Number.isInteger(value) && value >= 1 && value <= 16) result.tabSize = value;
      else warnings.add('WORKSPACE_SETTING_INVALID');
    } else if (key === 'editor.insertSpaces') {
      if (typeof value === 'boolean') result.insertSpaces = value;
      else warnings.add('WORKSPACE_SETTING_INVALID');
    } else if (key === 'editor.wordWrap') {
      if (typeof value === 'string' && WORD_WRAP_VALUES.has(value)) result.wordWrap = value;
      else warnings.add('WORKSPACE_SETTING_INVALID');
    } else if (key === 'editor.wordWrapColumn') {
      if (Number.isInteger(value) && value >= 1 && value <= 1000) result.wordWrapColumn = value;
      else warnings.add('WORKSPACE_SETTING_INVALID');
    } else if (key === 'editor.rulers') {
      if (Array.isArray(value) && value.length <= 32 && value.every((column) => Number.isInteger(column) && column >= 1 && column <= 1000)) {
        result.rulers = value.slice();
      } else warnings.add('WORKSPACE_SETTING_INVALID');
    } else if (key === 'editor.renderWhitespace') {
      if (typeof value === 'string' && RENDER_WHITESPACE_VALUES.has(value)) result.renderWhitespace = value;
      else warnings.add('WORKSPACE_SETTING_INVALID');
    } else if (key === 'editor.minimap.enabled') {
      if (typeof value === 'boolean') result.minimapEnabled = value;
      else warnings.add('WORKSPACE_SETTING_INVALID');
    } else if (key === 'editor.bracketPairColorization.enabled') {
      if (typeof value === 'boolean') result.bracketPairColorizationEnabled = value;
      else warnings.add('WORKSPACE_SETTING_INVALID');
    }
  }
  return result;
}

function languageIdsFromScope(key) {
  if (typeof key !== 'string' || !/^(?:\[[a-z][a-z0-9_-]{0,31}\])+$/.test(key)) return null;
  const ids = [...key.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  return ids.length && ids.every((id) => KNOWN_LANGUAGE_IDS.has(id)) ? ids : null;
}

function safeAssociationPattern(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  return /^\*\.[A-Za-z0-9][A-Za-z0-9_+-]*(?:\.[A-Za-z0-9][A-Za-z0-9_+-]*){0,3}$/.test(value);
}

function normalizedAssociations(source, warnings) {
  if (!isRecord(source)) {
    warnings.add('WORKSPACE_ASSOCIATIONS_INVALID');
    return [];
  }
  const associations = new Map();
  for (const rawPattern of Object.keys(source)) {
    const rawLanguage = source[rawPattern];
    const languageId = typeof rawLanguage === 'string' ? rawLanguage.toLowerCase() : '';
    if (!safeAssociationPattern(rawPattern) || !KNOWN_LANGUAGE_IDS.has(languageId)) {
      warnings.add('WORKSPACE_ASSOCIATION_IGNORED');
      continue;
    }
    associations.set(rawPattern.toLowerCase(), languageId);
  }
  return [...associations.entries()]
    .map(([pattern, languageId]) => ({ pattern, languageId }))
    .sort((left, right) => {
      const lengthDifference = right.pattern.length - left.pattern.length;
      return lengthDifference || left.pattern.localeCompare(right.pattern);
    });
}

function normalizedFileExcludes(source, warnings) {
  if (!isRecord(source)) {
    warnings.add('WORKSPACE_FILE_EXCLUDES_INVALID');
    return [];
  }
  const rules = [];
  const entries = Object.entries(source);
  if (entries.length > 128) warnings.add('WORKSPACE_FILE_EXCLUDES_LIMIT', entries.length - 128);
  for (const [rawPattern, enabled] of entries.slice(0, 128)) {
    if (enabled === false) continue;
    if (enabled !== true) {
      warnings.add('WORKSPACE_FILE_EXCLUDE_CONDITION_UNSUPPORTED');
      continue;
    }
    let pattern = typeof rawPattern === 'string' ? rawPattern.trim().replace(/\/+$/, '') : '';
    if (!pattern || pattern.length > 256 || pattern.startsWith('!') || pattern.includes('\\') ||
        /[\u0000-\u001f]/.test(pattern) || path.posix.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) ||
        pattern.split('/').includes('..')) {
      warnings.add('WORKSPACE_FILE_EXCLUDE_PATTERN_IGNORED');
      continue;
    }
    let expression;
    try {
      const options = {
        dot: true,
        nocase: process.platform === 'win32',
        nocomment: true,
        nonegate: true,
        matchBase: false
      };
      const expressions = [minimatch.makeRe(pattern, options)];
      if (pattern.startsWith('**/')) expressions.push(minimatch.makeRe(pattern.slice(3), options));
      if (expressions.some((entry) => !entry)) expression = null;
      else if (expressions.length === 1) expression = expressions[0];
      else expression = new RegExp(expressions.map((entry) => `(?:${entry.source})`).join('|'), options.nocase ? 'i' : '');
    } catch (_) {
      expression = null;
    }
    if (!expression || expression.source.length > 4096) {
      warnings.add('WORKSPACE_FILE_EXCLUDE_PATTERN_IGNORED');
      continue;
    }
    rules.push({ pattern, regexp: expression.source, flags: expression.ignoreCase ? 'i' : '' });
  }
  return rules;
}

function normalizeWorkspaceSettings(document) {
  const warnings = warningCollector();
  const editorSource = {};
  const languages = {};
  const languageScopes = [];
  let associations = [];
  let fileExcludes = [];

  if (!isRecord(document)) {
    warnings.add('WORKSPACE_SETTINGS_ROOT_INVALID');
  } else {
    for (const key of Object.keys(document)) {
      if (EDITOR_SETTING_KEYS.has(key)) {
        editorSource[key] = document[key];
        continue;
      }
      if (key === 'files.associations') {
        associations = normalizedAssociations(document[key], warnings);
        continue;
      }
      if (key === 'files.exclude') {
        fileExcludes = normalizedFileExcludes(document[key], warnings);
        continue;
      }
      if (key.startsWith('[')) {
        const languageIds = languageIdsFromScope(key);
        if (!languageIds) {
          warnings.add('WORKSPACE_LANGUAGE_SCOPE_IGNORED');
          continue;
        }
        const scoped = normalizedEditorSettings(document[key], warnings);
        languageScopes.push({ languageIds, scoped });
        continue;
      }
      warnings.add('WORKSPACE_SETTING_UNSUPPORTED');
    }
  }

  // VS Code gives a single-language block precedence over a combined block,
  // independent of their textual order in settings.json.
  languageScopes
    .slice()
    .sort((left, right) => Number(left.languageIds.length === 1) - Number(right.languageIds.length === 1))
    .forEach(({ languageIds, scoped }) => {
      for (const languageId of languageIds) {
        languages[languageId] = Object.assign({}, languages[languageId] || {}, scoped);
      }
    });

  return {
    settings: {
      editor: normalizedEditorSettings(editorSource, warnings),
      languages,
      associations,
      files: { exclude: fileExcludes }
    },
    warnings: warnings.value()
  };
}

function settingsFilePath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), '.vscode', 'settings.json');
}

function pathIsOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function emptySnapshot(rootPath, workspaceIdentity, warnings = []) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    rootPath: rootPath || null,
    workspaceIdentity,
    settings: { editor: {}, languages: {}, associations: [], files: { exclude: [] } },
    warnings
  });
}

async function loadWorkspaceSettings(workspaceRoot, workspaceIdentity) {
  if (!workspaceRoot) return emptySnapshot(null, workspaceIdentity);
  const root = path.resolve(workspaceRoot);
  const target = settingsFilePath(root);
  const vscodeDirectory = path.dirname(target);
  let directoryStat;
  let fileStat;
  try {
    directoryStat = await fs.promises.lstat(vscodeDirectory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptySnapshot(root, workspaceIdentity);
    return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_READ_FAILED', count: 1 }]);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_UNSAFE_PATH', count: 1 }]);
  }
  try {
    fileStat = await fs.promises.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptySnapshot(root, workspaceIdentity);
    return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_READ_FAILED', count: 1 }]);
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_UNSAFE_PATH', count: 1 }]);
  }
  if (fileStat.size > MAX_SETTINGS_BYTES) {
    return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_TOO_LARGE', count: 1 }]);
  }
  try {
    const rootReal = await fs.promises.realpath(root);
    const targetReal = await fs.promises.realpath(target);
    if (pathIsOutside(rootReal, targetReal)) {
      return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_UNSAFE_PATH', count: 1 }]);
    }
    const source = await readFileBounded(targetReal, { maxBytes: MAX_SETTINGS_BYTES, encoding: 'utf8' });
    const errors = [];
    const document = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) {
      return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_PARSE_FAILED', count: errors.length }]);
    }
    const normalized = normalizeWorkspaceSettings(document);
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      rootPath: root,
      workspaceIdentity,
      settings: normalized.settings,
      warnings: normalized.warnings
    });
  } catch (_) {
    return emptySnapshot(root, workspaceIdentity, [{ code: 'WORKSPACE_SETTINGS_READ_FAILED', count: 1 }]);
  }
}

function sameIdentity(left, right) {
  if (!left || !right || left.workspaceIdentity !== right.workspaceIdentity) return false;
  if (!left.rootPath || !right.rootPath) return left.rootPath === right.rootPath;
  const leftRoot = path.resolve(left.rootPath);
  const rightRoot = path.resolve(right.rootPath);
  return process.platform === 'win32' ? leftRoot.toLowerCase() === rightRoot.toLowerCase() : leftRoot === rightRoot;
}

function createWorkspaceSettingsController(options) {
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const getWorkspaceIdentity = options.getWorkspaceIdentity;
  const debounceMs = Number.isInteger(options.debounceMs) ? Math.max(0, options.debounceMs) : 120;
  let refreshTimer = null;
  let refreshSequence = 0;

  function currentWindow() {
    const window = getWindow();
    return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : null;
  }

  function requireCurrentSender(event) {
    const window = currentWindow();
    if (!window || event.sender !== window.webContents) throw new Error('Workspace settings sender is not active');
  }

  function requireCurrentIdentity(requested) {
    const current = getWorkspaceIdentity();
    if (!sameIdentity(current, requested) || !current.rootPath) throw new Error('Stale workspace settings request');
    return current;
  }

  async function readForIdentity(identity) {
    const snapshot = await loadWorkspaceSettings(identity.rootPath, identity.workspaceIdentity);
    if (!sameIdentity(getWorkspaceIdentity(), identity)) throw new Error('Stale workspace settings response');
    return snapshot;
  }

  function registerIpc() {
    ipcMain.handle('workspace-settings-read', async (event, requestedIdentity) => {
      requireCurrentSender(event);
      return readForIdentity(requireCurrentIdentity(requestedIdentity));
    });
  }

  function workspaceChanged() {
    refreshSequence += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  function notifyFilesystemEvent(rootPath, workspaceIdentity, changedPath) {
    const identity = { rootPath, workspaceIdentity };
    if (!sameIdentity(getWorkspaceIdentity(), identity) || !rootPath) return;
    if (changedPath) {
      const vscodeDirectory = path.dirname(settingsFilePath(rootPath));
      const resolved = path.resolve(changedPath);
      const relative = path.relative(vscodeDirectory, resolved);
      if (relative && relative !== 'settings.json') return;
    }
    const sequence = ++refreshSequence;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (sequence !== refreshSequence || !sameIdentity(getWorkspaceIdentity(), identity)) return;
      let snapshot;
      try {
        snapshot = await readForIdentity(identity);
      } catch (_) {
        return;
      }
      if (sequence !== refreshSequence) return;
      const window = currentWindow();
      if (window) window.webContents.send('workspace-settings-changed', snapshot);
    }, debounceMs);
  }

  function dispose() {
    workspaceChanged();
  }

  return { registerIpc, workspaceChanged, notifyFilesystemEvent, dispose };
}

module.exports = {
  KNOWN_LANGUAGE_IDS,
  createWorkspaceSettingsController,
  deepFreeze,
  loadWorkspaceSettings,
  normalizeWorkspaceSettings,
  normalizedFileExcludes,
  safeAssociationPattern
};
