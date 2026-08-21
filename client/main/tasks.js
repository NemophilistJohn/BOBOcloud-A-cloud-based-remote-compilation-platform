const fs = require('fs');
const path = require('path');
const { parse, printParseErrorCode } = require('jsonc-parser');
const { loadWorkspaceSettings } = require('./workspace-settings');

const TASK_SOURCES = [
  { id: 'vscode', relativePath: path.join('.vscode', 'tasks.json'), priority: 0 },
  { id: 'bobocloud', relativePath: path.join('.bobocloud', 'tasks.json'), priority: 1 }
];
const VARIABLE_PATTERN = /\$\{([^}]+)\}/g;
const SUPPORTED_TYPES = new Set(['shell', 'process']);
const SUPPORTED_KINDS = new Set(['build', 'test', 'run', 'custom']);
const INPUT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const RESERVED_INPUT_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_INPUT_VALUE_LENGTH = 4096;
const PRESENTATION_REVEAL_VALUES = new Set(['always', 'silent', 'never']);
const SUPPORTED_INPUT_TYPES = new Set(['promptString', 'pickString', 'command']);
const CONFIG_VARIABLE_KEYS = new Set([
  'editor.tabSize',
  'editor.insertSpaces',
  'editor.wordWrap',
  'editor.wordWrapColumn',
  'editor.rulers',
  'editor.renderWhitespace',
  'editor.minimap.enabled',
  'editor.bracketPairColorization.enabled'
]);
const BUILTIN_TASK_COMMANDS = Object.freeze({
  'bobocloud.tasks.activeFile': ({ variables }) => variables.file,
  'bobocloud.tasks.relativeFile': ({ variables }) => variables.relativeFile,
  'bobocloud.tasks.workspaceFolder': ({ variables }) => variables.workspaceFolder
});

function warning(code, message, details = {}) {
  return Object.assign({ code, message }, details);
}

function cloneObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.assign({}, value) : {};
}

function mergeOptions(...values) {
  const result = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const previousEnv = cloneObject(result.env);
    const previousShell = cloneObject(result.shell);
    Object.assign(result, value);
    if (value.env && typeof value.env === 'object' && !Array.isArray(value.env)) {
      result.env = Object.assign(previousEnv, value.env);
    }
    if (value.shell && typeof value.shell === 'object' && !Array.isArray(value.shell)) {
      result.shell = Object.assign(previousShell, value.shell);
    }
  }
  return result;
}

function mergePlatformConfiguration(base, linux) {
  const merged = Object.assign({}, base || {}, linux || {});
  merged.options = mergeOptions(base && base.options, linux && linux.options);
  for (const field of ['presentation', 'runOptions']) {
    const baseValue = base && base[field];
    const overrideValue = linux && linux[field];
    if (overrideValue === undefined) merged[field] = baseValue;
    else if (isRecord(baseValue) && isRecord(overrideValue)) merged[field] = Object.assign({}, baseValue, overrideValue);
    else merged[field] = overrideValue;
  }
  return merged;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeInputDefinitions(rawInputs, source, filePath) {
  const definitions = new Map();
  const warnings = [];
  if (rawInputs === undefined) return { definitions, warnings };
  if (!Array.isArray(rawInputs)) {
    warnings.push(warning('TASK_INPUT_DEFINITION_INVALID', `${source.relativePath} inputs must be an array`, {
      source: source.id, path: filePath, field: 'inputs'
    }));
    return { definitions, warnings };
  }
  rawInputs.forEach((rawInput, index) => {
    const input = isRecord(rawInput) ? rawInput : {};
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    const details = { source: source.id, path: filePath, field: 'inputs', inputId: id, inputType: type, inputIndex: index };
    let valid = true;
    if (!INPUT_ID_PATTERN.test(id) || RESERVED_INPUT_IDS.has(id)) {
      valid = false;
      warnings.push(warning('TASK_INPUT_DEFINITION_INVALID', `${source.relativePath} input #${index + 1} has an invalid id`, details));
    }
    if (!SUPPORTED_INPUT_TYPES.has(type)) {
      valid = false;
      warnings.push(warning('TASK_INPUT_TYPE_UNSUPPORTED', `${source.relativePath} input "${id || index + 1}" uses unsupported type "${type}"`, details));
    }
    const definition = {
      id,
      type,
      description: typeof input.description === 'string' ? input.description.slice(0, 512) : '',
      default: typeof input.default === 'string' ? input.default.slice(0, MAX_INPUT_VALUE_LENGTH) : undefined,
      password: input.password === true,
      options: [],
      command: typeof input.command === 'string' ? input.command.trim() : '',
      args: cloneJson(input.args),
      valid,
      source: source.id,
      sourcePath: filePath
    };
    if ((type === 'promptString' || type === 'pickString') && !definition.description) {
      definition.valid = false;
      warnings.push(warning('TASK_INPUT_DEFINITION_INVALID', `${source.relativePath} input "${id}" must define a description`, details));
    }
    if (type === 'pickString') {
      if (!Array.isArray(input.options) || input.options.length === 0) {
        definition.valid = false;
        warnings.push(warning('TASK_INPUT_DEFINITION_INVALID', `${source.relativePath} pickString input "${id}" must define options`, details));
      } else {
        definition.options = input.options.slice(0, 256).map((option) => {
          if (typeof option === 'string') return { label: option.slice(0, 512), value: option.slice(0, MAX_INPUT_VALUE_LENGTH) };
          if (isRecord(option) && typeof option.label === 'string' && typeof option.value === 'string') {
            return { label: option.label.slice(0, 512), value: option.value.slice(0, MAX_INPUT_VALUE_LENGTH) };
          }
          return null;
        }).filter(Boolean);
        if (definition.options.length !== input.options.length || definition.options.length === 0) {
          definition.valid = false;
          warnings.push(warning('TASK_INPUT_DEFINITION_INVALID', `${source.relativePath} pickString input "${id}" contains invalid options`, details));
        }
        if (definition.default !== undefined && !definition.options.some((option) => option.value === definition.default)) {
          definition.valid = false;
          warnings.push(warning('TASK_INPUT_DEFINITION_INVALID', `${source.relativePath} pickString input "${id}" has a default outside its options`, details));
        }
      }
    }
    if (type === 'command' && (!Object.prototype.hasOwnProperty.call(BUILTIN_TASK_COMMANDS, definition.command) || input.args !== undefined)) {
      definition.valid = false;
      warnings.push(warning('TASK_INPUT_COMMAND_NOT_ALLOWED', `${source.relativePath} command input "${id}" is not an allowed BOBOCLOUD built-in command`, {
        ...details, command: definition.command
      }));
    }
    if (id) {
      if (definitions.has(id)) {
        warnings.push(warning('TASK_INPUT_DUPLICATE', `${source.relativePath} defines input "${id}" more than once`, details));
      }
      definitions.set(id, definition);
    }
  });
  return { definitions, warnings };
}

function parseTaskFile(workspaceRoot, source) {
  const filePath = path.join(workspaceRoot, source.relativePath);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const parseErrors = [];
  const raw = parse(content, parseErrors, { allowTrailingComma: true, disallowComments: false });
  const warnings = parseErrors.map((error) => {
    const prefix = content.slice(0, error.offset);
    const line = prefix.split(/\r?\n/).length;
    const lastNewline = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
    const column = error.offset - lastNewline;
    return warning(
      'TASKS_JSON_PARSE_ERROR',
      `${source.relativePath}:${line}:${column}: ${printParseErrorCode(error.error)}`,
      { source: source.id, path: filePath, offset: error.offset, length: error.length, line, column, reason: printParseErrorCode(error.error) }
    );
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(warning('TASKS_INVALID_ROOT', `${source.relativePath} must contain a JSON object`, {
      source: source.id, path: filePath
    }));
    return { source, filePath, raw, tasks: [], warnings };
  }
  if (raw.version !== '2.0.0') {
    warnings.push(warning('TASKS_VERSION_UNSUPPORTED', `${source.relativePath} uses version ${String(raw.version || '(missing)')}; only 2.0.0 is executable`, {
      source: source.id, path: filePath, field: 'version', version: String(raw.version || '(missing)')
    }));
  }
  const normalizedInputs = normalizeInputDefinitions(raw.inputs, source, filePath);
  warnings.push(...normalizedInputs.warnings);
  const taskList = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (!Array.isArray(raw.tasks)) {
    warnings.push(warning('TASKS_ARRAY_MISSING', `${source.relativePath} must define a tasks array`, {
      source: source.id, path: filePath, field: 'tasks'
    }));
  }
  const globalBase = Object.assign({}, raw);
  delete globalBase.version;
  delete globalBase.tasks;
  delete globalBase.inputs;
  delete globalBase.windows;
  delete globalBase.osx;
  delete globalBase.linux;
  const base = mergePlatformConfiguration(globalBase, raw.linux);
  const tasks = taskList.map((task, index) => normalizeTask(task, index, base, source, filePath, raw.version, parseErrors.length === 0));
  for (const task of tasks) warnings.push(...task.warnings);
  return { source, filePath, raw, tasks, inputs: normalizedInputs.definitions, warnings };
}

function taskKind(task) {
  const boboKind = task.bobocloud && task.bobocloud.kind;
  const group = typeof task.group === 'string' ? task.group : task.group && task.group.kind;
  const candidate = String(boboKind || group || 'custom').toLowerCase();
  return SUPPORTED_KINDS.has(candidate) ? candidate : 'custom';
}

function normalizeDependsOn(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

function variableNames(value, result = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([^}]+)\}/g)) result.push(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => variableNames(item, result));
  } else if (isRecord(value)) {
    Object.values(value).forEach((item) => variableNames(item, result));
  }
  return result;
}

function normalizePresentation(rawPresentation, label, source, filePath, warnings) {
  const presentation = { reveal: 'always', echo: true, focus: false, clear: false };
  if (rawPresentation === undefined) return presentation;
  if (!isRecord(rawPresentation)) {
    warnings.push(warning('TASK_PRESENTATION_VALUE_INVALID', `${label}: presentation must be an object`, {
      source: source.id, path: filePath, task: label, field: 'presentation'
    }));
    return presentation;
  }
  if (rawPresentation.reveal !== undefined) {
    if (PRESENTATION_REVEAL_VALUES.has(rawPresentation.reveal)) presentation.reveal = rawPresentation.reveal;
    else warnings.push(warning('TASK_PRESENTATION_VALUE_INVALID', `${label}: presentation.reveal has an unsupported value`, {
      source: source.id, path: filePath, task: label, field: 'presentation.reveal'
    }));
  }
  for (const field of ['echo', 'focus', 'clear']) {
    if (rawPresentation[field] === undefined) continue;
    if (typeof rawPresentation[field] === 'boolean') presentation[field] = rawPresentation[field];
    else warnings.push(warning('TASK_PRESENTATION_VALUE_INVALID', `${label}: presentation.${field} must be a boolean`, {
      source: source.id, path: filePath, task: label, field: `presentation.${field}`
    }));
  }
  for (const field of ['panel', 'group', 'showReuseMessage', 'revealProblems', 'close']) {
    if (rawPresentation[field] === undefined) continue;
    warnings.push(warning('TASK_PRESENTATION_FIELD_UNSUPPORTED', `${label}: presentation.${field} cannot be represented by the shared BOBOCLOUD output panel`, {
      source: source.id, path: filePath, task: label, field: `presentation.${field}`
    }));
  }
  return presentation;
}

function normalizeRunOptions(rawRunOptions, label, source, filePath, warnings) {
  const runOptions = { reevaluateOnRerun: true, runOn: 'default' };
  if (rawRunOptions === undefined) return runOptions;
  if (!isRecord(rawRunOptions)) {
    warnings.push(warning('TASK_RUN_OPTION_UNSUPPORTED', `${label}: runOptions must be an object`, {
      source: source.id, path: filePath, task: label, field: 'runOptions'
    }));
    return runOptions;
  }
  if (rawRunOptions.reevaluateOnRerun !== undefined) {
    if (typeof rawRunOptions.reevaluateOnRerun === 'boolean') runOptions.reevaluateOnRerun = rawRunOptions.reevaluateOnRerun;
    else warnings.push(warning('TASK_RUN_OPTION_UNSUPPORTED', `${label}: runOptions.reevaluateOnRerun must be a boolean`, {
      source: source.id, path: filePath, task: label, field: 'runOptions.reevaluateOnRerun'
    }));
  }
  if (rawRunOptions.runOn !== undefined) {
    if (rawRunOptions.runOn === 'default') {
      runOptions.runOn = 'default';
    } else if (rawRunOptions.runOn === 'folderOpen') {
      runOptions.runOn = 'folderOpen';
      warnings.push(warning('TASK_RUN_ON_MANUAL_ONLY', `${label}: runOn folderOpen is disabled because BOBOCLOUD never auto-runs workspace tasks`, {
        source: source.id, path: filePath, task: label, field: 'runOptions.runOn'
      }));
    } else {
      warnings.push(warning('TASK_RUN_OPTION_UNSUPPORTED', `${label}: runOptions.runOn has an unsupported value`, {
        source: source.id, path: filePath, task: label, field: 'runOptions.runOn'
      }));
    }
  }
  Object.keys(rawRunOptions).forEach((field) => {
    if (field === 'reevaluateOnRerun' || field === 'runOn') return;
    warnings.push(warning('TASK_RUN_OPTION_UNSUPPORTED', `${label}: runOptions.${field} is not supported by the single cloud task executor`, {
      source: source.id, path: filePath, task: label, field: `runOptions.${field}`
    }));
  });
  return runOptions;
}

function normalizeTask(rawTask, index, globalBase, source, filePath, version, parseValid) {
  const sourceTask = rawTask && typeof rawTask === 'object' && !Array.isArray(rawTask) ? rawTask : {};
  let merged = mergePlatformConfiguration(globalBase, sourceTask);
  merged = mergePlatformConfiguration(merged, sourceTask.linux);
  merged.options = mergeOptions(globalBase.options, sourceTask.options, sourceTask.linux && sourceTask.linux.options);
  const label = String(merged.label || merged.taskName || '').trim();
  const type = String(merged.type || 'shell').toLowerCase();
  const dependsOn = normalizeDependsOn(merged.dependsOn);
  const dependsOrder = merged.dependsOrder === 'sequence' ? 'sequence' : 'parallel';
  const taskWarnings = [];
  let executable = version === '2.0.0' && parseValid;

  if (!label) {
    executable = false;
    taskWarnings.push(warning('TASK_LABEL_MISSING', `${source.relativePath} task #${index + 1} has no label`, {
      source: source.id, path: filePath, taskIndex: index, field: 'label'
    }));
  }
  if (!SUPPORTED_TYPES.has(type)) {
    executable = false;
    taskWarnings.push(warning('TASK_TYPE_UNSUPPORTED', `${label || `Task #${index + 1}`} uses extension-contributed type "${type}"; only shell and process tasks can run in BOBOCloud`, {
      source: source.id, path: filePath, task: label, field: 'type', taskType: type
    }));
  }
  if (merged.isBackground === true) {
    executable = false;
    taskWarnings.push(warning('TASK_BACKGROUND_UNSUPPORTED', `${label} is a background task; background readiness and watch lifecycles are not implemented`, {
      source: source.id, path: filePath, task: label, field: 'isBackground'
    }));
  }
  if (merged.dependsOrder && merged.dependsOrder !== 'sequence' && merged.dependsOrder !== 'parallel') {
    executable = false;
    taskWarnings.push(warning('TASK_DEPENDS_ORDER_UNSUPPORTED', `${label} has unsupported dependsOrder "${merged.dependsOrder}"`, {
      source: source.id, path: filePath, task: label, field: 'dependsOrder', dependsOrder: merged.dependsOrder
    }));
  }
  if (!merged.command && dependsOn.length === 0) {
    executable = false;
    taskWarnings.push(warning('TASK_COMMAND_MISSING', `${label || `Task #${index + 1}`} has neither command nor dependencies`, {
      source: source.id, path: filePath, task: label, field: 'command'
    }));
  }
  const presentation = normalizePresentation(merged.presentation, label, source, filePath, taskWarnings);
  const runOptions = normalizeRunOptions(merged.runOptions, label, source, filePath, taskWarnings);
  if (sourceTask.windows || sourceTask.osx) {
    taskWarnings.push(warning('TASK_PLATFORM_CLOUD_LINUX', `${label}: Windows/macOS overrides are preserved; the Linux override is used for the cloud container`, {
      source: source.id, path: filePath, task: label
    }));
  }

  return {
    id: `${source.id}:${index}`,
    label,
    type,
    kind: taskKind(merged),
    command: merged.command,
    args: Array.isArray(merged.args) ? merged.args.slice() : [],
    options: cloneObject(merged.options),
    dependsOn,
    dependsOrder,
    isDefault: Boolean(merged.group && typeof merged.group === 'object' && merged.group.isDefault),
    hide: merged.hide === true,
    executable,
    source: source.id,
    sourcePath: filePath,
    problemMatcher: merged.problemMatcher === undefined ? undefined : JSON.parse(JSON.stringify(merged.problemMatcher)),
    presentation,
    runOptions,
    raw: sourceTask,
    warnings: taskWarnings
  };
}

function validateTaskVariables(task, inputs) {
  const warnings = [];
  const names = new Set(variableNames([task.command, task.args, task.options]));
  for (const name of names) {
    if (name.startsWith('input:')) {
      const inputId = name.slice('input:'.length);
      const definition = inputs.get(inputId);
      if (!definition || !definition.valid) {
        task.executable = false;
        warnings.push(warning('TASK_INPUT_UNAVAILABLE', `${task.label} references unavailable input "${inputId}"`, {
          source: task.source, path: task.sourcePath, task: task.label, field: 'inputs', inputId
        }));
      }
      continue;
    }
    if (name.startsWith('command:')) {
      const command = name.slice('command:'.length);
      if (!Object.prototype.hasOwnProperty.call(BUILTIN_TASK_COMMANDS, command)) {
        task.executable = false;
        warnings.push(warning('TASK_COMMAND_NOT_ALLOWED', `${task.label} references command "${command}", which is not an allowed BOBOCLOUD built-in`, {
          source: task.source, path: task.sourcePath, task: task.label, field: 'command', command
        }));
      }
      continue;
    }
    if (name.startsWith('config:')) {
      const configKey = name.slice('config:'.length);
      if (!CONFIG_VARIABLE_KEYS.has(configKey)) {
        task.executable = false;
        warnings.push(warning('TASK_CONFIG_NOT_ALLOWED', `${task.label} references setting "${configKey}", which is outside the imported workspace settings whitelist`, {
          source: task.source, path: task.sourcePath, task: task.label, field: 'config', configKey
        }));
      }
    }
  }
  task.warnings.push(...warnings);
  return warnings;
}

function loadTaskConfiguration(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ''));
  const configs = TASK_SOURCES.map((source) => parseTaskFile(root, source)).filter(Boolean);
  const warnings = configs.flatMap((config) => config.warnings);
  const inputs = new Map();
  for (const config of configs) {
    for (const [id, definition] of config.inputs || []) {
      const previous = inputs.get(id);
      if (previous) {
        warnings.push(warning('TASK_INPUT_CONFLICT', `Input "${id}" from ${definition.sourcePath} overrides ${previous.sourcePath}`, {
          inputId: id,
          source: definition.source,
          sourcePath: definition.sourcePath,
          overriddenSource: previous.source,
          overriddenSourcePath: previous.sourcePath
        }));
      }
      inputs.set(id, definition);
    }
  }
  const mergedByLabel = new Map();
  for (const config of configs) {
    for (const task of config.tasks) {
      if (!task.label) continue;
      const previous = mergedByLabel.get(task.label);
      if (previous) {
        warnings.push(warning('TASK_LABEL_CONFLICT', `${task.label}: ${task.sourcePath} overrides ${previous.sourcePath}`, {
          task: task.label, source: task.source, sourcePath: task.sourcePath,
          overriddenSource: previous.source, overriddenSourcePath: previous.sourcePath
        }));
      }
      mergedByLabel.set(task.label, task);
    }
  }
  const tasks = [...mergedByLabel.values()];
  tasks.forEach((task) => warnings.push(...validateTaskVariables(task, inputs)));
  return {
    version: '2.0.0',
    workspaceRoot: root,
    tasks,
    inputs: [...inputs.values()].map((definition) => cloneJson(definition)),
    warnings,
    sources: configs.map((config) => ({ id: config.source.id, path: config.filePath, raw: config.raw }))
  };
}

function pathContext(workspaceRoot, context, configuration) {
  const root = path.resolve(workspaceRoot);
  const candidate = context && context.activeFile ? path.resolve(String(context.activeFile)) : '';
  const relative = candidate ? path.relative(root, candidate) : '';
  const activeInside = candidate && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  const relativeSlash = activeInside ? relative.split(path.sep).join('/') : '';
  const targetFile = relativeSlash ? '/workspace/' + relativeSlash : '';
  const base = relativeSlash ? path.posix.basename(relativeSlash) : '';
  const ext = base ? path.posix.extname(base) : '';
  const relativeDir = relativeSlash ? path.posix.dirname(relativeSlash) : '';
  const defaultBuildTask = (configuration.tasks || []).find((task) => task.kind === 'build' && task.isDefault);
  return {
    workspaceFolder: '/workspace',
    workspaceFolderBasename: path.basename(root),
    fileWorkspaceFolder: '/workspace',
    file: targetFile,
    relativeFile: relativeSlash,
    relativeFileDirname: relativeDir === '.' ? '' : relativeDir,
    fileBasename: base,
    fileBasenameNoExtension: ext ? base.slice(0, -ext.length) : base,
    fileExtname: ext,
    fileDirname: targetFile ? path.posix.dirname(targetFile) : '',
    fileDirnameBasename: targetFile ? path.posix.basename(path.posix.dirname(targetFile)) : '',
    selectedText: String(context && context.selectedText || ''),
    lineNumber: String(context && context.lineNumber || ''),
    columnNumber: String(context && context.columnNumber || ''),
    pathSeparator: '/',
    '/': '/',
    cwd: '/workspace',
    defaultBuildTask: defaultBuildTask ? defaultBuildTask.label : ''
  };
}

function taskError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function reachableTasks(configuration, label) {
  const tasksByLabel = new Map(configuration.tasks.map((task) => [task.label, task]));
  const result = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(taskLabel) {
    if (visited.has(taskLabel)) return;
    if (visiting.has(taskLabel)) throw taskError('TASK_DEPENDENCY_CYCLE', `Task dependency cycle detected at: ${taskLabel}`);
    const task = tasksByLabel.get(taskLabel);
    if (!task) throw taskError('TASK_DEPENDENCY_MISSING', `Task dependency not found: ${taskLabel}`);
    if (!task.executable) throw taskError('TASK_NOT_EXECUTABLE', `Task dependency is not executable: ${taskLabel}`);
    visiting.add(taskLabel);
    task.dependsOn.forEach(visit);
    visiting.delete(taskLabel);
    visited.add(taskLabel);
    result.push(task);
  }
  visit(label);
  return result;
}

function inputDefinitions(configuration) {
  return new Map((configuration.inputs || []).map((definition) => [definition.id, definition]));
}

function collectTaskInputRequests(configuration, label, inputValues = {}) {
  const definitions = inputDefinitions(configuration);
  const requests = [];
  const seen = new Set();
  for (const task of reachableTasks(configuration, label)) {
    for (const name of variableNames([task.command, task.args, task.options])) {
      if (!name.startsWith('input:')) continue;
      const id = name.slice('input:'.length);
      if (seen.has(id) || Object.prototype.hasOwnProperty.call(inputValues, id)) continue;
      seen.add(id);
      const definition = definitions.get(id);
      if (!definition || !definition.valid) throw taskError('TASK_INPUT_UNAVAILABLE', `Task input is unavailable: ${id}`);
      if (definition.type === 'command') continue;
      requests.push({
        id: definition.id,
        type: definition.type,
        description: definition.description,
        default: definition.default,
        password: definition.password === true,
        options: cloneJson(definition.options || [])
      });
    }
  }
  return requests;
}

function variableString(value, code, message) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) return JSON.stringify(value);
  throw taskError(code, message);
}

function evaluateTaskVariables(configuration, label, context, options = {}) {
  const variables = pathContext(configuration.workspaceRoot, context, configuration);
  const resolved = Object.assign({}, variables);
  const sensitiveNames = new Set();
  const definitions = inputDefinitions(configuration);
  const inputValues = isRecord(options.inputValues) ? options.inputValues : {};
  const configValues = isRecord(options.configValues) ? options.configValues : {};
  const commandResolvers = Object.assign({}, BUILTIN_TASK_COMMANDS, isRecord(options.commandResolvers) ? options.commandResolvers : {});
  const names = [];
  const seen = new Set();
  for (const task of reachableTasks(configuration, label)) {
    for (const name of variableNames([task.command, task.args, task.options])) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(resolved, name)) continue;
    if (name.startsWith('env:')) {
      throw taskError('TASK_VARIABLE_UNAVAILABLE', `Cloud environment variable is unavailable at task resolution time: ${name.slice(4)}`);
    }
    if (name.startsWith('config:')) {
      const key = name.slice('config:'.length);
      if (!CONFIG_VARIABLE_KEYS.has(key)) throw taskError('TASK_CONFIG_NOT_ALLOWED', `Workspace setting is not allowed in tasks: ${key}`);
      if (!Object.prototype.hasOwnProperty.call(configValues, key)) throw taskError('TASK_CONFIG_UNAVAILABLE', `Workspace setting has no imported value: ${key}`);
      resolved[name] = variableString(configValues[key], 'TASK_CONFIG_UNAVAILABLE', `Workspace setting cannot be represented as a task variable: ${key}`);
      continue;
    }
    if (name.startsWith('command:')) {
      const command = name.slice('command:'.length);
      const resolver = Object.prototype.hasOwnProperty.call(BUILTIN_TASK_COMMANDS, command) && commandResolvers[command];
      if (typeof resolver !== 'function') throw taskError('TASK_COMMAND_NOT_ALLOWED', `Task command variable is not allowed: ${command}`);
      resolved[name] = variableString(resolver({ variables: Object.freeze(Object.assign({}, variables)), context: cloneJson(context) }), 'TASK_COMMAND_RESULT_INVALID', `Task command did not return a string: ${command}`);
      continue;
    }
    if (name.startsWith('input:')) {
      const id = name.slice('input:'.length);
      const definition = definitions.get(id);
      if (!definition || !definition.valid) throw taskError('TASK_INPUT_UNAVAILABLE', `Task input is unavailable: ${id}`);
      if (definition.type === 'command') {
        const resolver = Object.prototype.hasOwnProperty.call(BUILTIN_TASK_COMMANDS, definition.command) && commandResolvers[definition.command];
        if (typeof resolver !== 'function') throw taskError('TASK_INPUT_COMMAND_NOT_ALLOWED', `Task input command is not allowed: ${definition.command}`);
        resolved[name] = variableString(resolver({ variables: Object.freeze(Object.assign({}, variables)), context: cloneJson(context) }), 'TASK_COMMAND_RESULT_INVALID', `Task input command did not return a string: ${definition.command}`);
      } else {
        if (!Object.prototype.hasOwnProperty.call(inputValues, id)) throw taskError('TASK_INPUT_REQUIRED', `Task input is required: ${id}`, {
          inputRequests: collectTaskInputRequests(configuration, label, inputValues)
        });
        if (typeof inputValues[id] !== 'string' || inputValues[id].length > MAX_INPUT_VALUE_LENGTH) {
          throw taskError('TASK_INPUT_VALUE_INVALID', `Task input has an invalid value: ${id}`);
        }
        if (definition.type === 'pickString' && !definition.options.some((option) => option.value === inputValues[id])) {
          throw taskError('TASK_INPUT_VALUE_INVALID', `Task input value is not one of the configured options: ${id}`);
        }
        resolved[name] = inputValues[id];
        if (definition.password) sensitiveNames.add(name);
      }
      continue;
    }
    throw taskError('TASK_VARIABLE_UNAVAILABLE', 'Task variable is unavailable in the cloud task runner: ${' + name + '}');
  }
  const display = Object.assign({}, resolved);
  sensitiveNames.forEach((name) => { display[name] = '******'; });
  return { values: resolved, displayValues: display };
}

function configValuesFromSnapshot(snapshot, languageId) {
  const settings = snapshot && snapshot.settings || {};
  const editor = Object.assign({}, settings.editor || {}, settings.languages && settings.languages[String(languageId || '')] || {});
  const values = {};
  const mappings = {
    'editor.tabSize': 'tabSize',
    'editor.insertSpaces': 'insertSpaces',
    'editor.wordWrap': 'wordWrap',
    'editor.wordWrapColumn': 'wordWrapColumn',
    'editor.rulers': 'rulers',
    'editor.renderWhitespace': 'renderWhitespace',
    'editor.minimap.enabled': 'minimapEnabled',
    'editor.bracketPairColorization.enabled': 'bracketPairColorizationEnabled'
  };
  Object.entries(mappings).forEach(([key, internalKey]) => {
    if (editor[internalKey] !== undefined) values[key] = cloneJson(editor[internalKey]);
  });
  return values;
}

function substituteString(value, variables) {
  return String(value).replace(VARIABLE_PATTERN, (match, name) => {
    if (name.startsWith('env:')) {
      const key = name.slice(4);
      const error = new Error(`Cloud environment variable is unavailable at task resolution time: ${key}`);
      error.code = 'TASK_VARIABLE_UNAVAILABLE';
      throw error;
    }
    if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
    const error = new Error('Task variable is unavailable in the cloud task runner: ${' + name + '}');
    error.code = 'TASK_VARIABLE_UNAVAILABLE';
    throw error;
  });
}

function substituteValue(value, variables) {
  if (typeof value === 'string') return substituteString(value, variables);
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.value === 'string') {
    return Object.assign({}, value, { value: substituteString(value.value, variables) });
  }
  return value;
}

function shellQuote(value, quoting) {
  const text = String(value);
  if (quoting === 'escape') return text.replace(/([\\\s"'`$&|;<>()[\]{}*!?])/g, '\\$1');
  if (quoting === 'weak') return `"${text.replace(/(["\\])/g, '\\$1')}"`;
  if (quoting === 'strong') return `'${text.replace(/'/g, `'"'"'`)}'`;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function shellToken(value, isCommand, hasArguments) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return shellQuote(value.value, value.quoting);
  }
  // VS Code treats a shell command string as the complete command line when
  // there are no args. Once args are present, a command path containing
  // spaces is a token and needs the same strong quoting as any other token.
  if (isCommand && !hasArguments) return String(value);
  return shellQuote(value);
}

function normalizeCloudCwd(rawCwd) {
  if (!rawCwd || rawCwd === '/workspace') return '';
  let cwd = String(rawCwd).replace(/\\/g, '/');
  if (cwd.startsWith('/workspace/')) cwd = cwd.slice('/workspace/'.length);
  if (cwd.startsWith('/')) throw new Error(`Task cwd must be inside the cloud workspace: ${rawCwd}`);
  cwd = path.posix.normalize(cwd).replace(/^\.\//, '');
  if (cwd === '..' || cwd.startsWith('../')) throw new Error(`Task cwd escapes the cloud workspace: ${rawCwd}`);
  return cwd === '.' ? '' : cwd;
}

function displayCommand(task, command, args) {
  if (task.type === 'shell') {
    return [shellToken(command, true, args.length > 0), ...args.map((arg) => shellToken(arg, false, false))].join(' ').trim();
  }
  return [command, ...args].map((value) => shellQuote(value)).join(' ');
}

function resolveStep(task, sequence, variables, displayVariables) {
  const options = task.options || {};
  const resolvedEnv = {};
  for (const [key, value] of Object.entries(options.env || {})) {
    // options.env is passed to the cloud process. It may contain deterministic
    // editor variables, but `${env:*}` cannot be expanded here because those
    // values belong to the future container environment.
    resolvedEnv[key] = substituteString(value, variables);
  }
  const command = substituteValue(task.command, variables);
  const args = task.args.map((arg) => substituteValue(arg, variables));
  const displayResolvedCommand = substituteValue(task.command, displayVariables || variables);
  const displayResolvedArgs = task.args.map((arg) => substituteValue(arg, displayVariables || variables));
  const cwd = normalizeCloudCwd(substituteString(options.cwd || '/workspace', variables));
  let argv;
  if (task.type === 'process') {
    if (command && typeof command === 'object') throw new Error(`${task.label}: process commands do not support shell quoting objects`);
    if (args.some((arg) => arg && typeof arg === 'object')) throw new Error(`${task.label}: process arguments do not support shell quoting objects`);
    argv = [String(command), ...args.map(String)];
  } else {
    const shell = options.shell && typeof options.shell === 'object' ? options.shell : {};
    const executable = substituteString(shell.executable || 'sh', variables);
    const shellArgs = Array.isArray(shell.args) ? shell.args.map((arg) => substituteString(arg, variables)) : ['-c'];
    const line = [shellToken(command, true, args.length > 0), ...args.map((arg) => shellToken(arg, false, false))].join(' ').trim();
    argv = [executable, ...shellArgs, line];
  }
  return {
    id: `task-step-${sequence}`,
    label: task.label,
    kind: task.kind,
    type: task.type,
    argv,
    cwd,
    env: resolvedEnv,
    dependsOn: [],
    echo: task.presentation ? task.presentation.echo !== false : true,
    displayCommand: displayCommand(task, displayResolvedCommand, displayResolvedArgs)
  };
}

function resolveTaskExecution(configuration, label, context = {}, options = {}) {
  const tasksByLabel = new Map(configuration.tasks.map((task) => [task.label, task]));
  const selected = tasksByLabel.get(label);
  if (!selected) throw new Error(`Task not found: ${label}`);
  if (!selected.executable) throw new Error(`Task is not executable: ${label}`);
  const missingInputs = collectTaskInputRequests(configuration, label, options.inputValues || {});
  if (missingInputs.length > 0) {
    throw taskError('TASK_INPUT_REQUIRED', `Task input is required: ${missingInputs[0].id}`, { inputRequests: missingInputs });
  }
  const evaluated = evaluateTaskVariables(configuration, label, context, options);
  const variables = evaluated.values;
  const nodes = [];
  const nodesById = new Map();
  const built = new Map();
  const visiting = new Set();

  function addDependencies(nodeIds, dependencies) {
    for (const nodeId of nodeIds) {
      const node = nodesById.get(nodeId);
      if (!node) continue;
      node.dependsOn = [...new Set(node.dependsOn.concat(dependencies))];
    }
  }

  function newEntryNodes(nodeIds, previousNodeIds) {
    const fresh = nodeIds.filter((nodeId) => !previousNodeIds.has(nodeId));
    const freshSet = new Set(fresh);
    return fresh.filter((nodeId) => {
      const node = nodesById.get(nodeId);
      return node && node.dependsOn.every((dependencyId) => !freshSet.has(dependencyId));
    });
  }

  function build(taskLabel) {
    if (built.has(taskLabel)) return built.get(taskLabel);
    if (visiting.has(taskLabel)) throw new Error(`Task dependency cycle detected at: ${taskLabel}`);
    const task = tasksByLabel.get(taskLabel);
    if (!task) throw new Error(`Task dependency not found: ${taskLabel}`);
    if (!task.executable) throw new Error(`Task dependency is not executable: ${taskLabel}`);
    visiting.add(taskLabel);

    const dependencyNodeIds = new Set();
    let dependencyTerminals = [];
    if (task.dependsOrder === 'sequence') {
      let previousTerminals = [];
      for (const dependencyLabel of task.dependsOn) {
        const dependency = build(dependencyLabel);
        const entries = newEntryNodes(dependency.nodes, dependencyNodeIds);
        if (previousTerminals.length > 0 && entries.length > 0) {
          addDependencies(entries, previousTerminals);
        }
        const hasFreshNodes = dependency.nodes.some((nodeId) => !dependencyNodeIds.has(nodeId));
        dependency.nodes.forEach((nodeId) => dependencyNodeIds.add(nodeId));
        if (hasFreshNodes || previousTerminals.length === 0) {
          previousTerminals = dependency.terminals.slice();
        }
      }
      dependencyTerminals = previousTerminals;
    } else {
      for (const dependencyLabel of task.dependsOn) {
        const dependency = build(dependencyLabel);
        dependency.nodes.forEach((nodeId) => dependencyNodeIds.add(nodeId));
        dependencyTerminals.push(...dependency.terminals);
      }
    }

    let result;
    if (task.command !== undefined && task.command !== null && String(task.command) !== '') {
      const node = resolveStep(task, nodes.length + 1, variables, evaluated.displayValues);
      node.dependsOn = [...new Set(dependencyTerminals)];
      nodes.push(node);
      nodesById.set(node.id, node);
      dependencyNodeIds.add(node.id);
      result = {
        nodes: [...dependencyNodeIds],
        terminals: [node.id]
      };
    } else {
      result = { nodes: [...dependencyNodeIds], terminals: [...new Set(dependencyTerminals)] };
    }
    visiting.delete(taskLabel);
    built.set(taskLabel, result);
    return result;
  }

  build(label);
  if (nodes.length === 0) throw new Error(`Task has no executable command: ${label}`);
  return {
    schemaVersion: 1,
    label,
    kind: selected.kind,
    steps: nodes,
    source: selected.source,
    // This is declarative client-side display metadata. The server receives
    // only the resolved command DAG and therefore cannot execute matcher code.
    problemMatcher: selected.problemMatcher,
    presentation: cloneJson(selected.presentation),
    runOptions: cloneJson(selected.runOptions)
  };
}

function createTasksController(options) {
  const ipcMain = options.ipcMain;
  const getWorkspaceIdentity = options.getWorkspaceIdentity;
  const getWindow = options.getWindow;

  function sameIdentity(left, right) {
    if (!left || !right || left.workspaceIdentity !== right.workspaceIdentity) return false;
    if (!left.rootPath || !right.rootPath) return left.rootPath === right.rootPath;
    const leftRoot = path.resolve(left.rootPath);
    const rightRoot = path.resolve(right.rootPath);
    return process.platform === 'win32' ? leftRoot.toLowerCase() === rightRoot.toLowerCase() : leftRoot === rightRoot;
  }

  function requireCurrentSender(event) {
    if (typeof getWindow !== 'function') return;
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || event.sender !== window.webContents) {
      throw taskError('TASK_SENDER_INVALID', 'Task request sender is not active');
    }
  }

  function currentConfiguration() {
    const identity = getWorkspaceIdentity();
    if (!identity || !identity.rootPath) return { version: '2.0.0', workspaceRoot: '', tasks: [], inputs: [], warnings: [], sources: [] };
    return loadTaskConfiguration(identity.rootPath);
  }

  function registerIpc() {
    ipcMain.handle('tasks:list', async (event) => {
      requireCurrentSender(event);
      return currentConfiguration();
    });
    ipcMain.handle('tasks:resolve', async (event, payload) => {
      requireCurrentSender(event);
      const identity = getWorkspaceIdentity();
      const configuration = currentConfiguration();
      if (!configuration.workspaceRoot) return { success: false, error: { code: 'TASK_WORKSPACE_MISSING', message: 'No workspace is open' } };
      try {
        const inputValues = isRecord(payload && payload.inputs) ? payload.inputs : {};
        const inputRequests = collectTaskInputRequests(configuration, String(payload && payload.label || ''), inputValues);
        if (inputRequests.length > 0) return { success: false, inputRequired: true, inputRequests };
        const snapshot = await loadWorkspaceSettings(identity.rootPath, identity.workspaceIdentity);
        if (!sameIdentity(identity, getWorkspaceIdentity())) throw taskError('TASK_CONTEXT_CHANGED', 'Workspace changed while resolving the task');
        return {
          success: true,
          execution: resolveTaskExecution(configuration, String(payload && payload.label || ''), payload && payload.context || {}, {
            inputValues,
            configValues: configValuesFromSnapshot(snapshot, payload && payload.context && payload.context.languageId)
          })
        };
      } catch (error) {
        return {
          success: false,
          inputRequired: error && error.code === 'TASK_INPUT_REQUIRED',
          inputRequests: error && Array.isArray(error.inputRequests) ? error.inputRequests : undefined,
          error: { code: error && error.code || 'TASK_RESOLVE_FAILED', message: error && error.message || String(error) }
        };
      }
    });
  }

  return { registerIpc, loadTaskConfiguration, resolveTaskExecution };
}

module.exports = {
  TASK_SOURCES,
  BUILTIN_TASK_COMMANDS,
  CONFIG_VARIABLE_KEYS,
  collectTaskInputRequests,
  configValuesFromSnapshot,
  createTasksController,
  loadTaskConfiguration,
  normalizeCloudCwd,
  resolveTaskExecution,
  substituteString
};
