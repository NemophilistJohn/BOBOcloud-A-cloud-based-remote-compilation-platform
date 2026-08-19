'use strict';

const fs = require('fs');
const path = require('path');
const { parse, printParseErrorCode } = require('jsonc-parser');

const BUILTIN_CONFIGURATION_ID = 'builtin:current-file';
const UNSUPPORTED_VARIABLE = /\$\{(?:input|command|config|env):[^}]+\}/;

function lineColumn(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function warning(code, values = {}) {
  return Object.assign({ code }, values);
}

function readJsonc(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, value: null, warnings: [] };
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { exists: true, value: null, warnings: [warning('read-error', { path: filePath, reason: error.message })] };
  }
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    return {
      exists: true,
      value: null,
      warnings: errors.map((error) => Object.assign(
        warning('parse-error', { path: filePath, reason: printParseErrorCode(error.error) }),
        lineColumn(text, error.offset)
      ))
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { exists: true, value: null, warnings: [warning('not-object', { path: filePath })] };
  }
  return { exists: true, value, warnings: [] };
}

function containsUnsupportedVariable(value) {
  if (typeof value === 'string') return UNSUPPORTED_VARIABLE.test(value);
  if (Array.isArray(value)) return value.some(containsUnsupportedVariable);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsUnsupportedVariable);
}

function lifecycleTaskLabel(value, field, itemWarnings, name) {
  if (value[field] === undefined) return '';
  if (typeof value[field] !== 'string' || !value[field].trim()) {
    itemWarnings.push(warning('invalid-lifecycle-task', { name, field }));
    return '';
  }
  return value[field].trim();
}

function normalizeConfiguration(raw, index, sourceKind, sourcePath) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = String(value.name || '').trim();
  const itemWarnings = [];
  if (!name) itemWarnings.push(warning('missing-name', { path: sourcePath, index: index + 1 }));
  if (!String(value.type || '').trim()) itemWarnings.push(warning('missing-type', { name: name || `#${index + 1}` }));
  const request = String(value.request || 'launch').trim();
  if (request !== 'launch') itemWarnings.push(warning('unsupported-request', { name: name || `#${index + 1}`, request }));
  const displayName = name || `#${index + 1}`;
  const preLaunchTask = lifecycleTaskLabel(value, 'preLaunchTask', itemWarnings, displayName);
  const postDebugTask = lifecycleTaskLabel(value, 'postDebugTask', itemWarnings, displayName);
  if (containsUnsupportedVariable(value)) itemWarnings.push(warning('unsupported-variable', { name: name || `#${index + 1}` }));
  return {
    id: `${sourceKind}:${name || index + 1}`,
    name: name || `#${index + 1}`,
    type: String(value.type || '').trim(),
    request,
    sourceKind,
    sourcePath,
    configuration: value,
    preLaunchTask,
    postDebugTask,
    warnings: itemWarnings,
    executable: Boolean(name && value.type && request === 'launch' &&
      !itemWarnings.some((item) => item.code === 'invalid-lifecycle-task') &&
      !containsUnsupportedVariable(value))
  };
}

function parseSource(workspaceRoot, sourceKind, relativePath) {
  const filePath = path.join(workspaceRoot, ...relativePath);
  const parsed = readJsonc(filePath);
  const warnings = [...parsed.warnings];
  if (!parsed.value) return { configurations: [], warnings, exists: parsed.exists, path: filePath };
  if (parsed.value.version !== undefined && String(parsed.value.version) !== '0.2.0') {
    warnings.push(warning('unsupported-version', { path: filePath, version: String(parsed.value.version) }));
  }
  if (!Array.isArray(parsed.value.configurations)) {
    warnings.push(warning('missing-configurations', { path: filePath }));
    return { configurations: [], warnings, exists: true, path: filePath };
  }
  if (Array.isArray(parsed.value.compounds) && parsed.value.compounds.length) {
    warnings.push(warning('unsupported-compounds', { path: filePath }));
  }
  if (Array.isArray(parsed.value.inputs) && parsed.value.inputs.length) {
    warnings.push(warning('unsupported-inputs', { path: filePath }));
  }
  const configurations = parsed.value.configurations.map((entry, index) => normalizeConfiguration(entry, index, sourceKind, filePath));
  if (String(parsed.value.version || '0.2.0') !== '0.2.0') {
    configurations.forEach((item) => { item.executable = false; });
  }
  return { configurations, warnings, exists: true, path: filePath };
}

function readLaunchConfigurations(workspaceRoot) {
  if (!workspaceRoot) return { workspaceRoot: '', configurations: [], warnings: [] };
  const vscode = parseSource(workspaceRoot, 'vscode', ['.vscode', 'launch.json']);
  const bobocloud = parseSource(workspaceRoot, 'bobocloud', ['.bobocloud', 'launch.json']);
  const merged = new Map();
  const warnings = [...vscode.warnings, ...bobocloud.warnings];
  for (const item of vscode.configurations) merged.set(item.name, item);
  for (const item of bobocloud.configurations) {
    const previous = merged.get(item.name);
    if (previous) {
      warnings.push(warning('overrides', {
        name: item.name,
        sourcePath: item.sourcePath,
        overriddenSourcePath: previous.sourcePath
      }));
    }
    merged.set(item.name, item);
  }
  return {
    workspaceRoot,
    configurations: Array.from(merged.values()),
    warnings,
    sources: [vscode, bobocloud].filter((source) => source.exists).map((source) => source.path)
  };
}

function posixRelative(workspaceRoot, activeFile) {
  if (!activeFile) return '';
  const root = path.resolve(workspaceRoot);
  const file = path.resolve(activeFile);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (file !== root) throw new Error('The active file is outside the workspace');
  }
  return relative.split(path.sep).join('/');
}

function adapterTypeForLanguage(languageId) {
  const language = String(languageId || '').toLowerCase();
  if (language === 'python') return 'python';
  if (language === 'go') return 'go';
  if (language === 'javascript' || language === 'typescript' || language === 'javascriptreact' || language === 'typescriptreact') return 'node';
  return '';
}

function needsActiveEditorContext(value) {
  if (typeof value === 'string') return /\$\{(?:file|relativeFile|fileDirname|fileBasename|fileBasenameNoExtension|fileExtname|lineNumber|selectedText)\}/.test(value);
  if (Array.isArray(value)) return value.some(needsActiveEditorContext);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(needsActiveEditorContext);
}

function substitute(value, variables) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (match, key) => {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) throw new Error(`Unsupported debug variable: ${match}`);
      return variables[key];
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[key] = substitute(entry, variables);
  return result;
}

function resolveLaunchConfiguration(configurationSet, id, context = {}) {
  let item;
  if (id === BUILTIN_CONFIGURATION_ID) {
    const type = adapterTypeForLanguage(context.languageId);
    if (!type) throw new Error(`Unsupported language for cloud debugging: ${context.languageId || 'unknown'}`);
    item = {
      id,
      name: 'Current File',
      type,
      request: 'launch',
      sourceKind: 'builtin',
      sourcePath: '',
      executable: true,
      warnings: [],
      configuration: { name: 'Current File', type, request: 'launch', program: '${file}' }
    };
  } else {
    item = configurationSet.configurations.find((entry) => entry.id === id);
    if (!item) throw new Error(`Debug configuration not found: ${id}`);
    if (!item.executable) throw new Error(`Debug configuration is not executable: ${item.name}`);
  }
  const adapterConfiguration = Object.assign({}, item.configuration);
  delete adapterConfiguration.preLaunchTask;
  delete adapterConfiguration.postDebugTask;
  const requiresActiveFile = item.id === BUILTIN_CONFIGURATION_ID || needsActiveEditorContext(adapterConfiguration);
  const relativeFile = context.activeFile ? posixRelative(configurationSet.workspaceRoot, context.activeFile) : '';
  if (requiresActiveFile && !relativeFile) throw new Error('Open a source file before starting a debug session');
  const basename = path.posix.basename(relativeFile);
  const extension = path.posix.extname(basename);
  const remoteFile = `/workspace/${relativeFile}`;
  const variables = {
    workspaceFolder: '/workspace',
    workspaceFolderBasename: path.basename(configurationSet.workspaceRoot),
    file: remoteFile,
    relativeFile,
    fileDirname: path.posix.dirname(remoteFile),
    fileBasename: basename,
    fileBasenameNoExtension: extension ? basename.slice(0, -extension.length) : basename,
    fileExtname: extension,
    cwd: '/workspace',
    lineNumber: String(Number(context.lineNumber) || 1),
    selectedText: String(context.selectedText || '')
  };
  const resolved = substitute(adapterConfiguration, variables);
  if (!resolved.cwd) resolved.cwd = '/workspace';
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    request: item.request,
    sourceKind: item.sourceKind,
    sourcePath: item.sourcePath,
    preLaunchTask: item.preLaunchTask || '',
    postDebugTask: item.postDebugTask || '',
    configuration: resolved
  };
}

module.exports = {
  BUILTIN_CONFIGURATION_ID,
  readLaunchConfigurations,
  resolveLaunchConfiguration,
  adapterTypeForLanguage
};
