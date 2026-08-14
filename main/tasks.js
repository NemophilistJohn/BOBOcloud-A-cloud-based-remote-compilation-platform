const fs = require('fs');
const path = require('path');
const { parse, printParseErrorCode } = require('jsonc-parser');

const TASK_SOURCES = [
  { id: 'vscode', relativePath: path.join('.vscode', 'tasks.json'), priority: 0 },
  { id: 'bobocloud', relativePath: path.join('.bobocloud', 'tasks.json'), priority: 1 }
];
const VARIABLE_PATTERN = /\$\{([^}]+)\}/g;
const SUPPORTED_TYPES = new Set(['shell', 'process']);
const SUPPORTED_KINDS = new Set(['build', 'test', 'run', 'custom']);

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
  return merged;
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
  if (Array.isArray(raw.inputs) && raw.inputs.length > 0) {
    warnings.push(warning('TASKS_INPUTS_UNSUPPORTED', `${source.relativePath} inputs are preserved but interactive input variables are not available`, {
      source: source.id, path: filePath, field: 'inputs'
    }));
  }
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
  return { source, filePath, raw, tasks, warnings };
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

function containsUnsupportedVariable(value) {
  if (typeof value === 'string') return /\$\{(?:input|command|config):[^}]+\}/.test(value);
  if (Array.isArray(value)) return value.some(containsUnsupportedVariable);
  if (value && typeof value === 'object') return Object.values(value).some(containsUnsupportedVariable);
  return false;
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
  if (containsUnsupportedVariable([merged.command, merged.args, merged.options])) {
    executable = false;
    taskWarnings.push(warning('TASK_VARIABLE_UNSUPPORTED', `${label} uses input, command, or config variables that cannot be resolved by BOBOCloud`, {
      source: source.id, path: filePath, task: label
    }));
  }
  if (!merged.command && dependsOn.length === 0) {
    executable = false;
    taskWarnings.push(warning('TASK_COMMAND_MISSING', `${label || `Task #${index + 1}`} has neither command nor dependencies`, {
      source: source.id, path: filePath, task: label, field: 'command'
    }));
  }
  for (const field of ['problemMatcher', 'presentation', 'runOptions']) {
    if (merged[field] !== undefined) {
      taskWarnings.push(warning('TASK_FIELD_PRESERVED', `${label}: ${field} is preserved but is not applied by the cloud output runner`, {
        source: source.id, path: filePath, task: label, field
      }));
    }
  }
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
    raw: sourceTask,
    warnings: taskWarnings
  };
}

function loadTaskConfiguration(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ''));
  const configs = TASK_SOURCES.map((source) => parseTaskFile(root, source)).filter(Boolean);
  const warnings = configs.flatMap((config) => config.warnings);
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
  return {
    version: '2.0.0',
    workspaceRoot: root,
    tasks: [...mergedByLabel.values()],
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
    cwd: '/workspace',
    defaultBuildTask: defaultBuildTask ? defaultBuildTask.label : ''
  };
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

function resolveStep(task, sequence, variables) {
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
    dependsOn: []
  };
}

function resolveTaskExecution(configuration, label, context = {}) {
  const tasksByLabel = new Map(configuration.tasks.map((task) => [task.label, task]));
  const selected = tasksByLabel.get(label);
  if (!selected) throw new Error(`Task not found: ${label}`);
  if (!selected.executable) throw new Error(`Task is not executable: ${label}`);
  const variables = pathContext(configuration.workspaceRoot, context, configuration);
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
      const node = resolveStep(task, nodes.length + 1, variables);
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
    source: selected.source
  };
}

function createTasksController(options) {
  const ipcMain = options.ipcMain;
  const getWorkspaceIdentity = options.getWorkspaceIdentity;

  function currentConfiguration() {
    const identity = getWorkspaceIdentity();
    if (!identity || !identity.rootPath) return { version: '2.0.0', workspaceRoot: '', tasks: [], warnings: [], sources: [] };
    return loadTaskConfiguration(identity.rootPath);
  }

  function registerIpc() {
    ipcMain.handle('tasks:list', async () => currentConfiguration());
    ipcMain.handle('tasks:resolve', async (_event, payload) => {
      const configuration = currentConfiguration();
      if (!configuration.workspaceRoot) return { success: false, error: { code: 'TASK_WORKSPACE_MISSING', message: 'No workspace is open' } };
      try {
        return {
          success: true,
          execution: resolveTaskExecution(configuration, String(payload && payload.label || ''), payload && payload.context || {})
        };
      } catch (error) {
        return {
          success: false,
          error: { code: error && error.code || 'TASK_RESOLVE_FAILED', message: error && error.message || String(error) }
        };
      }
    });
  }

  return { registerIpc, loadTaskConfiguration, resolveTaskExecution };
}

module.exports = {
  TASK_SOURCES,
  createTasksController,
  loadTaskConfiguration,
  normalizeCloudCwd,
  resolveTaskExecution,
  substituteString
};
