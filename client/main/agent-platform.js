'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readFileBounded } = require('./atomic-file');

const MAX_STORAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_FILES = 4000;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROCESS_ARGUMENT_BYTES = 32 * 1024;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_APPROVALS = 64;
const MAX_PENDING_APPROVALS_PER_PLUGIN = 8;
const MAX_ACTIVE_MODELS = 8;
const MAX_ACTIVE_MODELS_PER_PLUGIN = 2;
const MAX_ACTIVE_SEARCHES = 2;
const MAX_ACTIVE_OPERATIONS = 8;
const MAX_ACTIVE_OPERATIONS_PER_PLUGIN = 2;
const ACCESS_MODES = new Set(['ask', 'auto', 'full']);
const ACCESS_MODE_RANK = Object.freeze({ ask: 0, auto: 1, full: 2 });
const ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd',
  'bun', 'deno', 'git', 'go', 'cargo', 'rustc', 'python', 'python3', 'py', 'java',
  'javac', 'mvn', 'mvn.cmd', 'gradle', 'gradle.bat', 'gradlew', 'gradlew.bat',
  'dotnet', 'cmake', 'make'
]);
const TEXT_FILE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsx', '.kt', '.kts', '.md', '.mjs', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte',
  '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml'
]);
const PROCESS_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL',
  'JAVA_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'DOTNET_ROOT',
  'CC', 'CXX', 'MAKEFLAGS'
]);
const HIGH_RISK_WRITE_PATHS = [
  /(^|\/)\.git(?:\/|$)/i,
  /(^|\/)\.github\/workflows(?:\/|$)/i,
  /(^|\/)\.vscode\/(?:tasks|settings)\.json$/i,
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc)$/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.[^/]*)?$/i,
  /(^|\/)(?:package\.json|dockerfile|docker-compose(?:\.[^/]*)?\.ya?ml|makefile|justfile)$/i,
  /\.(?:sh|ps1|cmd|bat)$/i
];
const LOW_RISK_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files']);

function agentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function agentWorkspaceFileError(error, action) {
  if (error && error.code === 'DATA_TOO_LARGE') {
    return agentError('AGENT_FILE_TOO_LARGE', 'Agent can ' + action + ' text files up to 2 MiB.');
  }
  if (error && error.code === 'UNSAFE_DATA_FILE') {
    return agentError('AGENT_INVALID_PATH', 'Agent file access requires a regular non-symbolic file.');
  }
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedText(value, maximum, fallback = '') {
  return typeof value === 'string' ? value.slice(0, maximum) : fallback;
}

function safePluginId(value) {
  const id = String(value || '');
  if (!/^[a-z0-9][a-z0-9.-]{2,119}$/.test(id)) throw agentError('AGENT_INVALID_PLUGIN', 'Agent plugin id is invalid.');
  return id;
}

function safeAgentIdentity(value, label) {
  const id = boundedText(value, 180).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw agentError('AGENT_INVALID_ACCESS_CONTEXT', label + ' is invalid.');
  return id;
}

function classifyWorkspaceWriteRisk(args) {
  const relativePath = normalizeRelativePath(args && args.path);
  return HIGH_RISK_WRITE_PATHS.some((pattern) => pattern.test(relativePath)) ? 'high' : 'medium';
}

function classifyProcessRisk(args) {
  const command = boundedText(args && args.command, 120).trim().toLowerCase();
  const commandArgs = Array.isArray(args && args.args) ? args.args.map((value) => boundedText(value, 4000).trim()) : [];
  if (commandArgs.length === 1 && /^(?:--version|-v|version|--help|-h|help)$/i.test(commandArgs[0])) return 'low';
  if (command === 'git' && commandArgs.length > 0 && LOW_RISK_GIT_COMMANDS.has(commandArgs[0].toLowerCase())) return 'low';
  return 'high';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function processEnvironment() {
  const environment = { CI: process.env.CI || '1', NO_COLOR: '1' };
  for (const key of PROCESS_ENV_KEYS) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return environment;
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveProcessCommand(command, snapshot) {
  const environment = processEnvironment();
  const searchPath = environment.Path || environment.PATH || '';
  const names = process.platform === 'win32'
    ? (path.extname(command) ? [command] : (environment.PATHEXT || '.EXE;.COM;.CMD;.BAT').split(';').map((extension) => command + extension.toLowerCase()))
    : [command];
  for (const directoryValue of searchPath.split(path.delimiter)) {
    const directory = directoryValue.replace(/^"|"$/g, '').trim();
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      let stat;
      try { stat = await fsp.stat(candidate); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      const real = await fsp.realpath(candidate);
      if (pathInside(snapshot.rootPath, real)) continue;
      const extension = path.extname(real).toLowerCase();
      if (process.platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
        return { executable: real, prefixArgs: [] };
      }
      const base = path.basename(real, extension).toLowerCase();
      if (base !== 'npm' && base !== 'npx') continue;
      const script = path.join(path.dirname(real), 'node_modules', 'npm', 'bin', base + '-cli.js');
      const scriptStat = await fsp.stat(script).catch(() => null);
      if (!scriptStat || !scriptStat.isFile()) continue;
      const node = await resolveProcessCommand('node', snapshot);
      return { executable: node.executable, prefixArgs: node.prefixArgs.concat([await fsp.realpath(script)]) };
    }
  }
  throw agentError('AGENT_COMMAND_NOT_FOUND', 'The approved executable is not available in the local toolchain PATH.');
}

async function replaceFileAtomic(temporary, destination) {
  try {
    await fsp.rename(temporary, destination);
    return;
  } catch (error) {
    if (process.platform !== 'win32' || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error;
  }
  const backup = destination + '.' + crypto.randomUUID() + '.bak';
  let movedExisting = false;
  try {
    await fsp.rename(destination, backup);
    movedExisting = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fsp.rename(temporary, destination);
    if (movedExisting) await fsp.unlink(backup).catch(() => {});
  } catch (error) {
    if (movedExisting) await fsp.rename(backup, destination).catch(() => {});
    throw error;
  }
}

function normalizeRelativePath(value, options = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || value.includes('\0')) {
    throw agentError('AGENT_INVALID_PATH', 'A workspace-relative path is required.');
  }
  const input = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalized = path.posix.normalize(input);
  if ((!options.allowRoot && (!normalized || normalized === '.')) || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw agentError('AGENT_INVALID_PATH', 'The path must stay inside the active workspace.');
  }
  return normalized === '.' ? '' : normalized;
}

function createAgentPlatformBroker(options) {
  if (!options || !options.app || !options.settings || typeof options.getWorkspaceIdentity !== 'function' ||
      typeof options.requestModel !== 'function') {
    throw new TypeError('createAgentPlatformBroker requires app, settings, getWorkspaceIdentity, and requestModel.');
  }
  const app = options.app;
  const settings = options.settings;
  const getWorkspaceIdentity = options.getWorkspaceIdentity;
  const runWorkspaceMutation = options.runWorkspaceMutation;
  const requestModel = options.requestModel;
  const cancelModel = typeof options.cancelModel === 'function' ? options.cancelModel : () => ({ success: true, cancelled: false });
  const notifyWorkspaceFiles = typeof options.notifyWorkspaceFiles === 'function' ? options.notifyWorkspaceFiles : () => {};
  if (typeof runWorkspaceMutation !== 'function') throw new TypeError('Agent workspace writes require the workspace mutation coordinator.');
  const storageRoot = path.join(app.getPath('userData'), 'agent-data');
  const approvals = new Map();
  const activeOperations = new Map();
  const activeModelRequests = new Map();
  const activeSearches = new Map();
  const pluginEpochs = new Map();
  const runningProcesses = new Map();
  const accessModes = new Map();
  const activeAccessContexts = new Map();

  function pluginEpoch(pluginId) {
    return pluginEpochs.get(pluginId) || 0;
  }

  function accessIdentity(pluginId, args) {
    const providerId = safeAgentIdentity(args && args.providerId, 'Agent provider id');
    if (!providerId.startsWith(pluginId + '.')) throw agentError('AGENT_INVALID_ACCESS_CONTEXT', 'Agent provider id must use the plugin namespace.');
    const sessionId = safeAgentIdentity(args && args.sessionId, 'Agent session id');
    return { pluginId, providerId, sessionId, key: pluginId + '\0' + providerId + '\0' + sessionId };
  }

  function accessSnapshot(identity, accessMode) {
    return Object.freeze({
      pluginId: identity.pluginId,
      providerId: identity.providerId,
      sessionId: identity.sessionId,
      accessMode
    });
  }

  function cancelAutomaticOperations(accessKey) {
    for (const operation of activeOperations.values()) {
      if (operation.accessKey !== accessKey || operation.autoApproved !== true) continue;
      operation.cancelled = true;
      if (operation.child) terminateProcess(operation);
    }
  }

  function getAccessMode(pluginId, args) {
    const identity = accessIdentity(safePluginId(pluginId), args);
    const accessMode = accessModes.get(identity.key) || 'ask';
    const previousKey = activeAccessContexts.get(identity.pluginId);
    if (previousKey && previousKey !== identity.key) cancelAutomaticOperations(previousKey);
    activeAccessContexts.set(identity.pluginId, identity.key);
    return accessSnapshot(identity, accessMode);
  }

  function setAccessMode(pluginId, args) {
    const identity = accessIdentity(safePluginId(pluginId), args);
    const accessMode = boundedText(args && args.accessMode, 16).trim();
    if (!ACCESS_MODES.has(accessMode)) throw agentError('AGENT_INVALID_ACCESS_MODE', 'Agent access mode must be ask, auto, or full.');
    if (accessMode === 'full' && (!args || args.confirmed !== true)) {
      throw agentError('AGENT_FULL_ACCESS_CONFIRMATION_REQUIRED', 'Full access requires an explicit trusted user confirmation.');
    }
    const previousMode = accessModes.get(identity.key) || 'ask';
    const previousKey = activeAccessContexts.get(identity.pluginId);
    if (previousKey && previousKey !== identity.key) cancelAutomaticOperations(previousKey);
    if (ACCESS_MODE_RANK[accessMode] < ACCESS_MODE_RANK[previousMode]) cancelAutomaticOperations(identity.key);
    accessModes.set(identity.key, accessMode);
    activeAccessContexts.set(identity.pluginId, identity.key);
    return accessSnapshot(identity, accessMode);
  }

  function clearAccessMode(pluginId, args) {
    const identity = accessIdentity(safePluginId(pluginId), args);
    cancelAutomaticOperations(identity.key);
    accessModes.delete(identity.key);
    if (activeAccessContexts.get(identity.pluginId) === identity.key) activeAccessContexts.delete(identity.pluginId);
    return accessSnapshot(identity, 'ask');
  }

  function currentAccess(pluginId) {
    const key = activeAccessContexts.get(pluginId);
    if (!key) return { key: '', accessMode: 'ask' };
    return { key, accessMode: accessModes.get(key) || 'ask' };
  }

  function countOwned(records, pluginId) {
    let count = 0;
    for (const record of records.values()) if (record.pluginId === pluginId) count += 1;
    return count;
  }

  function workspaceSnapshot() {
    const identity = getWorkspaceIdentity() || {};
    if (!identity.rootPath || !Number.isInteger(identity.workspaceIdentity)) {
      throw agentError('AGENT_NO_WORKSPACE', 'Open a local workspace before using Agent tools.');
    }
    let rootPath;
    try { rootPath = fs.realpathSync.native(path.resolve(identity.rootPath)); }
    catch (_) { throw agentError('AGENT_NO_WORKSPACE', 'The active local workspace is unavailable.'); }
    return { rootPath, workspaceIdentity: identity.workspaceIdentity };
  }

  function assertCurrentWorkspace(snapshot) {
    const current = workspaceSnapshot();
    if (current.workspaceIdentity !== snapshot.workspaceIdentity || current.rootPath !== snapshot.rootPath) {
      throw agentError('AGENT_STALE_WORKSPACE', 'The active workspace changed before the Agent operation completed.');
    }
    return current;
  }

  async function resolveWorkspacePath(relativePath, options = {}) {
    const snapshot = options.snapshot || workspaceSnapshot();
    const normalized = normalizeRelativePath(relativePath, { allowRoot: options.allowRoot === true });
    const candidate = path.resolve(snapshot.rootPath, normalized || '.');
    const relative = path.relative(snapshot.rootPath, candidate);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw agentError('AGENT_INVALID_PATH', 'The path escapes the active workspace.');
    }
    if (options.allowMissing !== true) {
      const realRoot = await fsp.realpath(snapshot.rootPath);
      const realCandidate = await fsp.realpath(candidate);
      const realRelative = path.relative(realRoot, realCandidate);
      if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
        throw agentError('AGENT_INVALID_PATH', 'The path resolves outside the active workspace.');
      }
      return { snapshot, normalized, absolute: realCandidate };
    }
    const parent = await fsp.realpath(path.dirname(candidate));
    const realRoot = await fsp.realpath(snapshot.rootPath);
    const parentRelative = path.relative(realRoot, parent);
    if (parentRelative === '..' || parentRelative.startsWith('..' + path.sep) || path.isAbsolute(parentRelative)) {
      throw agentError('AGENT_INVALID_PATH', 'The target parent resolves outside the active workspace.');
    }
    return { snapshot, normalized, absolute: path.join(parent, path.basename(candidate)) };
  }

  async function modelRecords() {
    const raw = await settings.readAiSettings();
    const values = [];
    const seen = new Set();
    for (const purpose of ['chat', 'inline']) {
      const profiles = Array.isArray(raw[purpose + 'Profiles']) ? raw[purpose + 'Profiles'] : [];
      for (const profile of profiles) {
        const id = boundedText(profile && profile.id, 120).trim();
        if (!id) continue;
        const ref = purpose + ':' + id;
        if (seen.has(ref)) continue;
        seen.add(ref);
        values.push({
          ref,
          purpose,
          name: boundedText(profile.name || id, 160),
          provider: boundedText(profile.provider || 'openai-compatible', 80),
          modelId: boundedText(profile.modelId, 200),
          configured: Boolean(profile.endpoint && profile.apiKey && profile.modelId),
          profile
        });
      }
    }
    return values;
  }

  async function listModels() {
    return {
      models: (await modelRecords()).map(({ profile, ...record }) => Object.freeze(record))
    };
  }

  function normalizeMessages(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 96) {
      throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent messages must be a non-empty bounded array.');
    }
    let total = 0;
    return value.map((message) => {
      if (!isPlainObject(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
        throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent messages contain an unsupported role.');
      }
      const result = { role: message.role, content: boundedText(message.content, 256 * 1024) };
      total += result.content.length;
      if (message.name !== undefined) result.name = boundedText(message.name, 96);
      if (message.tool_call_id !== undefined) result.tool_call_id = boundedText(message.tool_call_id, 160);
      if (Array.isArray(message.tool_calls)) result.tool_calls = cloneJson(message.tool_calls);
      return result;
    }).map((message) => {
      if (total > 768 * 1024) throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent messages exceed the host input limit.');
      return message;
    });
  }

  function normalizeTools(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 48) throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent tool definitions are invalid.');
    return value.map((tool) => {
      if (!isPlainObject(tool) || !isPlainObject(tool.function) || tool.type !== 'function') {
        throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent tools must use function descriptors.');
      }
      const name = boundedText(tool.function.name, 96);
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(name)) throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent tool name is invalid.');
      const parameters = isPlainObject(tool.function.parameters) ? cloneJson(tool.function.parameters) : { type: 'object', properties: {} };
      const encoded = JSON.stringify(parameters);
      if (Buffer.byteLength(encoded, 'utf8') > 128 * 1024) throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent tool schema is too large.');
      return { type: 'function', function: { name, description: boundedText(tool.function.description, 1000), parameters } };
    });
  }

  function normalizeModelResponse(result) {
    if (!result || result.success !== true || !result.data) {
      throw agentError('AGENT_MODEL_FAILED', boundedText(result && (result.error || result.code), 1000, 'The model request failed.'));
    }
    const data = result.data;
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const message = choice && choice.message;
    if (message) {
      return {
        content: typeof message.content === 'string' ? message.content : '',
        reasoning: boundedText(message.reasoning_content || message.reasoning, 256 * 1024),
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 32).map((call) => ({
          id: boundedText(call.id, 160),
          name: boundedText(call.function && call.function.name, 96),
          arguments: boundedText(call.function && call.function.arguments, 256 * 1024, '{}')
        })) : [],
        finishReason: boundedText(choice.finish_reason, 80),
        usage: isPlainObject(data.usage) ? cloneJson(data.usage) : null
      };
    }
    if (Array.isArray(data.content)) {
      const textBlocks = data.content.filter((block) => block && block.type === 'text');
      const thinkingBlocks = data.content.filter((block) => block && block.type === 'thinking');
      const toolBlocks = data.content.filter((block) => block && block.type === 'tool_use');
      return {
        content: textBlocks.map((block) => boundedText(block.text, 256 * 1024)).join(''),
        reasoning: thinkingBlocks.map((block) => boundedText(block.thinking, 256 * 1024)).join(''),
        toolCalls: toolBlocks.slice(0, 32).map((block) => ({
          id: boundedText(block.id, 160),
          name: boundedText(block.name, 96),
          arguments: JSON.stringify(isPlainObject(block.input) ? block.input : {})
        })),
        finishReason: boundedText(data.stop_reason, 80),
        usage: isPlainObject(data.usage) ? cloneJson(data.usage) : null
      };
    }
    throw agentError('AGENT_MODEL_PROTOCOL', 'The model returned an unsupported response shape.');
  }

  function modelRequestId(pluginId, requestId) {
    return 'agent-' + sha256(pluginId).slice(0, 16) + '-' + boundedText(requestId, 80, crypto.randomUUID());
  }

  async function generate(pluginId, args) {
    if (!isPlainObject(args)) throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent model request must be an object.');
    const requestId = boundedText(args.requestId, 80).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(requestId)) {
      throw agentError('AGENT_INVALID_MODEL_REQUEST', 'Agent model requests require a non-empty request id.');
    }
    if (activeModelRequests.size >= MAX_ACTIVE_MODELS || countOwned(activeModelRequests, pluginId) >= MAX_ACTIVE_MODELS_PER_PLUGIN) {
      throw agentError('AGENT_MODEL_BUSY', 'This Agent already has the maximum number of active model requests.');
    }
    const hostRequestId = modelRequestId(pluginId, requestId);
    if (activeModelRequests.has(hostRequestId)) throw agentError('AGENT_MODEL_BUSY', 'The Agent model request id is already active.');
    activeModelRequests.set(hostRequestId, { pluginId, epoch: pluginEpoch(pluginId) });
    try {
      const models = await modelRecords();
      const record = models.find((model) => model.ref === args.modelRef);
      if (!record || !record.configured) throw agentError('AGENT_MODEL_UNCONFIGURED', 'The selected local model profile is unavailable or incomplete.');
      const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(args.reasoningEffort) ? args.reasoningEffort : 'medium';
      const defaultMaxTokens = effort === 'max' ? 16384 : effort === 'xhigh' ? 12288 : 8192;
      if (activeModelRequests.get(hostRequestId)?.epoch !== pluginEpoch(pluginId)) {
        throw agentError('AGENT_CANCELLED', 'The Agent model request was cancelled.');
      }
      const result = await requestModel({
        requestId: hostRequestId,
        modelConfig: cloneJson(record.profile),
        messages: normalizeMessages(args.messages),
        tools: normalizeTools(args.tools),
        reasoningEffort: effort,
        maxTokens: Math.max(256, Math.min(32768, Number(args.maxTokens) || defaultMaxTokens)),
        temperature: Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0.2,
        stream: false,
        mode: 'chat'
      });
      if (pluginEpoch(pluginId) !== activeModelRequests.get(hostRequestId)?.epoch) {
        throw agentError('AGENT_CANCELLED', 'The Agent model request was cancelled.');
      }
      return normalizeModelResponse(result);
    } finally {
      activeModelRequests.delete(hostRequestId);
    }
  }

  function cancelGeneration(pluginId, args) {
    const requestId = boundedText(args && args.requestId, 80).trim();
    if (!requestId) return { success: true, cancelled: false };
    return cancelModel(modelRequestId(pluginId, requestId));
  }

  function storagePath(pluginId) {
    return path.join(storageRoot, safePluginId(pluginId) + '.json');
  }

  async function readStorage(pluginId) {
    try {
      const content = await readFileBounded(storagePath(pluginId), { maxBytes: MAX_STORAGE_BYTES, encoding: 'utf8' });
      const value = JSON.parse(content);
      return { value: isPlainObject(value) ? value : {} };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { value: {} };
      if (error && error.code === 'DATA_TOO_LARGE') throw agentError('AGENT_STORAGE_TOO_LARGE', 'Agent storage exceeds the host limit.');
      if (error && String(error.code).startsWith('AGENT_')) throw error;
      throw agentError('AGENT_STORAGE_INVALID', 'Agent storage could not be read.');
    }
  }

  async function writeStorage(pluginId, args) {
    const value = args && args.value;
    if (!isPlainObject(value)) throw agentError('AGENT_STORAGE_INVALID', 'Agent storage value must be a plain object.');
    const serialized = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_BYTES) throw agentError('AGENT_STORAGE_TOO_LARGE', 'Agent storage exceeds the host limit.');
    await fsp.mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const destination = storagePath(pluginId);
    const temporary = destination + '.' + process.pid + '.' + Date.now() + '.tmp';
    await fsp.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    try { await replaceFileAtomic(temporary, destination); }
    finally { await fsp.unlink(temporary).catch(() => {}); }
    return { saved: true, bytes: Buffer.byteLength(serialized, 'utf8') };
  }

  async function listWorkspace(args) {
    const snapshot = workspaceSnapshot();
    const base = await resolveWorkspacePath(args && args.path || '.', { snapshot, allowRoot: true });
    const maximumDepth = Math.max(0, Math.min(8, Number(args && args.depth) || 3));
    const maximumEntries = Math.max(1, Math.min(2000, Number(args && args.limit) || 500));
    const entries = [];
    async function visit(directory, depth) {
      if (entries.length >= maximumEntries || depth > maximumDepth) return;
      const children = await fsp.readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (entries.length >= maximumEntries) break;
        if (child.isSymbolicLink()) continue;
        const absolute = path.join(directory, child.name);
        const relative = path.relative(snapshot.rootPath, absolute).replace(/\\/g, '/');
        entries.push({ path: relative, type: child.isDirectory() ? 'directory' : 'file' });
        if (child.isDirectory()) await visit(absolute, depth + 1);
      }
    }
    const stat = await fsp.stat(base.absolute);
    if (stat.isDirectory()) await visit(base.absolute, 0);
    else entries.push({ path: base.normalized, type: 'file' });
    assertCurrentWorkspace(snapshot);
    return { entries, truncated: entries.length >= maximumEntries, workspaceIdentity: snapshot.workspaceIdentity };
  }

  async function readWorkspace(args) {
    const target = await resolveWorkspacePath(args && args.path);
    let content;
    try {
      content = await readFileBounded(target.absolute, { maxBytes: MAX_FILE_BYTES, encoding: 'utf8' });
    } catch (error) {
      throw agentWorkspaceFileError(error, 'read');
    }
    assertCurrentWorkspace(target.snapshot);
    return { path: target.normalized, content, sha256: sha256(content), size: Buffer.byteLength(content, 'utf8') };
  }

  async function searchWorkspace(pluginId, args) {
    const snapshot = workspaceSnapshot();
    const query = boundedText(args && args.query, 500).trim();
    if (!query) throw agentError('AGENT_INVALID_SEARCH', 'A search query is required.');
    const caseSensitive = args && args.caseSensitive === true;
    const needle = caseSensitive ? query : query.toLowerCase();
    const maximumResults = Math.max(1, Math.min(500, Number(args && args.limit) || 100));
    if (activeSearches.size >= MAX_ACTIVE_SEARCHES || countOwned(activeSearches, pluginId) >= 1) {
      throw agentError('AGENT_SEARCH_BUSY', 'This Agent already has an active workspace search.');
    }
    const searchId = crypto.randomUUID();
    const search = { pluginId, epoch: pluginEpoch(pluginId), cancelled: false };
    activeSearches.set(searchId, search);
    const results = [];
    let scannedFiles = 0;
    function assertSearchCurrent() {
      if (search.cancelled || search.epoch !== pluginEpoch(pluginId)) {
        throw agentError('AGENT_CANCELLED', 'The Agent workspace search was cancelled.');
      }
      assertCurrentWorkspace(snapshot);
    }
    async function visit(directory) {
      assertSearchCurrent();
      if (results.length >= maximumResults || scannedFiles >= MAX_SEARCH_FILES) return;
      let children;
      try { children = await fsp.readdir(directory, { withFileTypes: true }); }
      catch (_) { return; }
      for (const child of children) {
        assertSearchCurrent();
        if (results.length >= maximumResults || scannedFiles >= MAX_SEARCH_FILES || child.isSymbolicLink()) continue;
        if (child.name === '.git' || child.name === 'node_modules' || child.name === 'dist' || child.name === 'release') continue;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!TEXT_FILE_EXTENSIONS.has(path.extname(child.name).toLowerCase())) continue;
        scannedFiles += 1;
        let content;
        try {
          content = await readFileBounded(absolute, { maxBytes: MAX_SEARCH_FILE_BYTES, encoding: 'utf8' });
        } catch (_) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maximumResults; index += 1) {
          const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
          if (!haystack.includes(needle)) continue;
          results.push({
            path: path.relative(snapshot.rootPath, absolute).replace(/\\/g, '/'),
            line: index + 1,
            preview: lines[index].slice(0, 500)
          });
        }
      }
    }
    try {
      await visit(snapshot.rootPath);
      assertSearchCurrent();
      return { results, truncated: results.length >= maximumResults || scannedFiles >= MAX_SEARCH_FILES, scannedFiles };
    } finally {
      activeSearches.delete(searchId);
    }
  }

  function createOperation(pluginId, snapshot, tool, args, summary, risk, riskLevel, access) {
    return {
      id: 'approval-' + crypto.randomBytes(18).toString('hex'),
      pluginId,
      epoch: pluginEpoch(pluginId),
      snapshot,
      tool,
      args: cloneJson(args),
      summary: boundedText(summary, 64 * 1024),
      risk,
      riskLevel,
      accessMode: access.accessMode,
      accessKey: access.key,
      expiresAt: Date.now() + APPROVAL_TTL_MS
    };
  }

  function queueApproval(operation) {
    if (approvals.size >= MAX_PENDING_APPROVALS || countOwned(approvals, operation.pluginId) >= MAX_PENDING_APPROVALS_PER_PLUGIN) {
      throw agentError('AGENT_APPROVAL_LIMIT', 'This Agent already has the maximum number of pending approvals.');
    }
    approvals.set(operation.id, operation);
    return {
      approvalRequired: true,
      approval: {
        id: operation.id,
        tool: operation.tool,
        summary: boundedText(operation.summary, 1000),
        risk: operation.risk,
        riskLevel: operation.riskLevel,
        accessMode: operation.accessMode,
        expiresAt: new Date(operation.expiresAt).toISOString()
      }
    };
  }

  async function authorizeOperation(pluginId, snapshot, tool, args, summary, risk, riskLevel) {
    // Path and executable resolution above may yield. Re-read trusted state at the
    // last synchronous boundary before the operation becomes pending or active.
    const access = currentAccess(pluginId);
    const operation = createOperation(pluginId, snapshot, tool, args, summary, risk, riskLevel, access);
    const automatic = access.accessMode === 'full' || (access.accessMode === 'auto' && riskLevel !== 'high');
    if (!automatic) return queueApproval(operation);
    operation.autoApproved = true;
    const result = await executeOperation(operation);
    return Object.assign({}, result, {
      autoApproved: true,
      accessMode: access.accessMode,
      riskLevel
    });
  }

  async function requestWrite(pluginId, args) {
    const snapshot = workspaceSnapshot();
    const target = await resolveWorkspacePath(args && args.path, { snapshot, allowMissing: true });
    const content = boundedText(args && args.content, MAX_FILE_BYTES + 1);
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw agentError('AGENT_FILE_TOO_LARGE', 'Agent can write text files up to 2 MiB.');
    let currentHash = '';
    try {
      const current = await readFileBounded(target.absolute, { maxBytes: MAX_FILE_BYTES });
      currentHash = sha256(current);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw agentWorkspaceFileError(error, 'write');
    }
    const expected = boundedText(args && args.expectedSha256, 64);
    if ((expected && expected !== currentHash) || (currentHash && !expected)) {
      throw agentError('AGENT_FILE_CHANGED', 'The file changed after the Agent read it. Read it again before writing.');
    }
    const operation = { path: target.normalized, content, expectedSha256: currentHash };
    return authorizeOperation(pluginId, snapshot, 'workspace_write', operation,
      (currentHash ? 'Replace ' : 'Create ') + target.normalized + ' (' + Buffer.byteLength(content, 'utf8') + ' bytes)',
      'write', classifyWorkspaceWriteRisk(operation));
  }

  async function requestProcess(pluginId, args) {
    const snapshot = workspaceSnapshot();
    const command = boundedText(args && args.command, 80).trim();
    if (!ALLOWED_COMMANDS.has(command.toLowerCase()) || command.includes('/') || command.includes('\\')) {
      throw agentError('AGENT_COMMAND_DENIED', 'The executable is not in the Agent command allowlist.');
    }
    const commandArgs = Array.isArray(args.args) ? args.args.map((value) => boundedText(value, 4000)) : [];
    if (commandArgs.length > 128) throw agentError('AGENT_INVALID_COMMAND', 'The Agent command has too many arguments.');
    if (Buffer.byteLength(JSON.stringify(commandArgs), 'utf8') > MAX_PROCESS_ARGUMENT_BYTES) {
      throw agentError('AGENT_INVALID_COMMAND', 'The Agent command arguments exceed the host limit.');
    }
    const cwd = normalizeRelativePath(args && args.cwd || '.', { allowRoot: true });
    const timeoutMs = Math.max(1000, Math.min(120000, Number(args && args.timeoutMs) || 60000));
    const resolvedCommand = await resolveProcessCommand(command, snapshot);
    const operation = {
      command,
      args: commandArgs,
      cwd,
      timeoutMs,
      executable: resolvedCommand.executable,
      prefixArgs: resolvedCommand.prefixArgs
    };
    const shown = [command].concat(commandArgs.map((value) => JSON.stringify(value))).join(' ');
    return authorizeOperation(pluginId, snapshot, 'process_run', operation, shown, 'execute', classifyProcessRisk(operation));
  }

  async function invokeTool(pluginId, args) {
    if (!isPlainObject(args)) throw agentError('AGENT_INVALID_TOOL', 'Agent tool request must be an object.');
    const tool = boundedText(args.tool, 96);
    const input = isPlainObject(args.input) ? args.input : {};
    if (tool === 'workspace_list') return listWorkspace(input);
    if (tool === 'workspace_read') return readWorkspace(input);
    if (tool === 'workspace_search') return searchWorkspace(pluginId, input);
    if (tool === 'workspace_write') return requestWrite(pluginId, input);
    if (tool === 'process_run') return requestProcess(pluginId, input);
    throw agentError('AGENT_TOOL_NOT_FOUND', 'Unknown Agent tool: ' + tool);
  }

  async function executeWrite(operation) {
    return runWorkspaceMutation(operation.args.path, async (mutation) => {
      assertOperationCurrent(operation);
      if (mutation.rootPath !== path.resolve(operation.snapshot.rootPath) ||
          mutation.workspaceIdentity !== operation.snapshot.workspaceIdentity) {
        throw agentError('AGENT_WORKSPACE_CHANGED', 'The workspace changed before the Agent write started.');
      }
      const target = await resolveWorkspacePath(operation.args.path, { snapshot: operation.snapshot, allowMissing: true });
      mutation.assertCurrent();
      let currentHash = '';
      try {
        currentHash = sha256(await readFileBounded(target.absolute, { maxBytes: MAX_FILE_BYTES }));
      } catch (error) {
        if (error.code !== 'ENOENT') throw agentWorkspaceFileError(error, 'write');
      }
      if (currentHash !== operation.args.expectedSha256) throw agentError('AGENT_FILE_CHANGED', 'The file changed while approval was pending.');
      mutation.assertCurrent();
      await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
      mutation.assertCurrent();
      const temporary = target.absolute + '.bobo-agent-' + process.pid + '-' + Date.now();
      await fsp.writeFile(temporary, operation.args.content, 'utf8');
      try {
        assertOperationCurrent(operation);
        mutation.assertCurrent();
        await replaceFileAtomic(temporary, target.absolute);
        mutation.assertCurrent();
      } finally {
        await fsp.unlink(temporary).catch(() => {});
      }
      try {
        notifyWorkspaceFiles(
          [{ path: target.absolute, event: operation.args.expectedSha256 ? 'file-changed' : 'file-created' }],
          { rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity }
        );
      } catch (_) {}
      return { approved: true, path: operation.args.path, sha256: sha256(operation.args.content) };
    });
  }

  function terminateProcess(record) {
    if (!record || !record.child || record.child.killed) return;
    record.cancelled = true;
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
      try {
        const killer = spawn(taskkill, ['/pid', String(record.child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { record.child.kill(); } catch (_) {} });
      }
      catch (_) { try { record.child.kill(); } catch (_) {} }
      return;
    }
    try { process.kill(-record.child.pid, 'SIGTERM'); }
    catch (_) { try { record.child.kill('SIGTERM'); } catch (_) {} }
    const forceTimer = setTimeout(() => {
      try { process.kill(-record.child.pid, 'SIGKILL'); } catch (_) {}
    }, 2000);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
  }

  async function executeProcess(operation) {
    assertOperationCurrent(operation);
    const cwd = await resolveWorkspacePath(operation.args.cwd || '.', { snapshot: operation.snapshot, allowRoot: true });
    const stat = await fsp.stat(cwd.absolute);
    if (!stat.isDirectory()) throw agentError('AGENT_INVALID_COMMAND', 'Agent command working directory is not a directory.');
    const resolvedCommand = await resolveProcessCommand(operation.args.command, operation.snapshot);
    if (resolvedCommand.executable !== operation.args.executable || JSON.stringify(resolvedCommand.prefixArgs) !== JSON.stringify(operation.args.prefixArgs)) {
      throw agentError('AGENT_COMMAND_CHANGED', 'The approved executable changed before it could start.');
    }
    assertOperationCurrent(operation);
    return new Promise((resolve, reject) => {
      const child = spawn(resolvedCommand.executable, resolvedCommand.prefixArgs.concat(operation.args.args), {
        cwd: cwd.absolute,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: processEnvironment()
      });
      const running = operation;
      running.child = child;
      runningProcesses.set(operation.id, running);
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const append = (kind, chunk) => {
        const remaining = Math.max(0, MAX_PROCESS_OUTPUT_BYTES - bytes);
        if (!remaining) { truncated = true; return; }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const slice = buffer.subarray(0, remaining);
        bytes += slice.length;
        if (slice.length < buffer.length) truncated = true;
        if (kind === 'stdout') stdout += slice.toString('utf8');
        else stderr += slice.toString('utf8');
      };
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.once('error', (error) => {
        runningProcesses.delete(operation.id);
        reject(agentError('AGENT_PROCESS_FAILED', error.message));
      });
      const timer = setTimeout(() => { timedOut = true; terminateProcess(running); }, operation.args.timeoutMs);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        runningProcesses.delete(operation.id);
        try { assertCurrentWorkspace(operation.snapshot); } catch (error) { reject(error); return; }
        resolve({ approved: true, exitCode: Number.isInteger(code) ? code : null, signal: signal || '', stdout, stderr, truncated, timedOut, cancelled: running.cancelled && !timedOut });
      });
    });
  }

  function findApproval(pluginId, approvalId) {
    const id = boundedText(approvalId, 120);
    const operation = approvals.get(id);
    if (!operation || operation.pluginId !== pluginId) throw agentError('AGENT_APPROVAL_NOT_FOUND', 'Agent approval is missing or no longer valid.');
    if (operation.expiresAt < Date.now()) {
      approvals.delete(id);
      throw agentError('AGENT_APPROVAL_EXPIRED', 'Agent approval expired.');
    }
    if (operation.epoch !== pluginEpoch(pluginId)) throw agentError('AGENT_CANCELLED', 'The Agent approval is no longer active.');
    assertCurrentWorkspace(operation.snapshot);
    return operation;
  }

  function assertOperationCurrent(operation) {
    if (!operation || operation.cancelled || operation.epoch !== pluginEpoch(operation.pluginId)) {
      throw agentError('AGENT_CANCELLED', 'The Agent operation was cancelled.');
    }
    assertCurrentWorkspace(operation.snapshot);
  }

  function approvalPermission(operation) {
    if (!operation) return '';
    if (operation.tool === 'workspace_write') return 'workspace.write';
    if (operation.tool === 'process_run') return 'process.execute';
    return '';
  }

  function describeApproval(pluginId, approvalId) {
    const id = boundedText(approvalId, 120);
    const operation = approvals.has(id) ? findApproval(pluginId, id) : activeOperations.get(id);
    if (!operation || operation.pluginId !== pluginId) throw agentError('AGENT_APPROVAL_NOT_FOUND', 'Agent approval is missing or no longer valid.');
    assertOperationCurrent(operation);
    const details = operation.tool === 'workspace_write'
      ? {
          path: operation.args.path,
          bytes: Buffer.byteLength(operation.args.content, 'utf8'),
          expectedSha256: operation.args.expectedSha256,
          contentPreview: operation.args.content.slice(0, 64 * 1024),
          contentTruncated: operation.args.content.length > 64 * 1024
        }
      : {
          command: operation.args.command,
          args: [...operation.args.args],
          cwd: operation.args.cwd || '.',
          timeoutMs: operation.args.timeoutMs,
          resolvedExecutable: operation.args.executable
        };
    return {
      approvalId: operation.id,
      tool: operation.tool,
      summary: operation.summary,
      risk: operation.risk,
      riskLevel: operation.riskLevel,
      accessMode: operation.accessMode,
      permission: approvalPermission(operation),
      expiresAt: new Date(operation.expiresAt).toISOString(),
      details
    };
  }

  function assertOperationCapacity(pluginId) {
    if (activeOperations.size >= MAX_ACTIVE_OPERATIONS || countOwned(activeOperations, pluginId) >= MAX_ACTIVE_OPERATIONS_PER_PLUGIN) {
      throw agentError('AGENT_OPERATION_BUSY', 'This Agent already has the maximum number of active approved operations.');
    }
  }

  async function executeOperation(operation) {
    const pluginId = operation.pluginId;
    assertOperationCapacity(pluginId);
    operation.cancelled = false;
    activeOperations.set(operation.id, operation);
    try {
      assertOperationCurrent(operation);
      if (operation.tool === 'workspace_write') return await executeWrite(operation);
      if (operation.tool === 'process_run') return await executeProcess(operation);
      throw agentError('AGENT_TOOL_NOT_FOUND', 'The approved Agent tool is no longer available.');
    } finally {
      runningProcesses.delete(operation.id);
      activeOperations.delete(operation.id);
    }
  }

  async function decideApproval(pluginId, approvalId, approved) {
    const operation = findApproval(pluginId, approvalId);
    if (approved !== true) {
      approvals.delete(operation.id);
      return { rejected: true, tool: operation.tool };
    }
    assertOperationCapacity(pluginId);
    approvals.delete(operation.id);
    return executeOperation(operation);
  }

  function cancelApproval(pluginId, approvalId) {
    approvalId = boundedText(approvalId, 120);
    const pending = approvals.get(approvalId);
    if (pending && pending.pluginId === pluginId) {
      approvals.delete(approvalId);
      return { cancelled: true };
    }
    const operation = activeOperations.get(approvalId);
    if (!operation || operation.pluginId !== pluginId) return { cancelled: false };
    operation.cancelled = true;
    if (operation.child) terminateProcess(operation);
    return { cancelled: true };
  }

  function skillRoots() {
    const roots = [];
    let workspace = null;
    try { workspace = workspaceSnapshot(); } catch (_) {}
    const home = typeof app.getPath === 'function' ? app.getPath('home') : os.homedir();
    const candidates = [
      workspace && ['workspace', path.join(workspace.rootPath, '.agents', 'skills')],
      workspace && ['workspace', path.join(workspace.rootPath, '.codex', 'skills')],
      workspace && ['workspace', path.join(workspace.rootPath, '.claude', 'skills')],
      ['user', path.join(home, '.agents', 'skills')],
      ['user', path.join(home, '.codex', 'skills')],
      ['user', path.join(home, '.claude', 'skills')]
    ].filter(Boolean);
    const seen = new Set();
    for (const [source, root] of candidates) {
      const normalized = path.resolve(root);
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ source, root: normalized });
    }
    return roots;
  }

  function skillMetadata(content, fallbackName) {
    const header = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    const values = Object.create(null);
    if (header) {
      for (const line of header[1].split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
      }
    }
    return {
      name: boundedText(values.name || fallbackName, 160),
      description: boundedText(values.description || '', 1000)
    };
  }

  async function discoverSkills() {
    const result = [];
    const seen = new Set();
    for (const candidate of skillRoots()) {
      let entries;
      try { entries = await fsp.readdir(candidate.root, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = path.join(candidate.root, entry.name, 'SKILL.md');
        try {
          const stat = await fsp.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
          const realRoot = await fsp.realpath(candidate.root);
          const real = await fsp.realpath(filePath);
          const relative = path.relative(realRoot, real);
          if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
          const id = 'skill-' + sha256(real).slice(0, 24);
          if (seen.has(id)) continue;
          seen.add(id);
          const content = await readFileBounded(real, { maxBytes: 512 * 1024, encoding: 'utf8' });
          const metadata = skillMetadata(content, entry.name);
          result.push({
            id, source: candidate.source, name: metadata.name, description: metadata.description,
            filePath: real, size: Buffer.byteLength(content, 'utf8')
          });
        } catch (_) {}
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async function listSkills() {
    return { skills: (await discoverSkills()).map(({ filePath, ...skill }) => skill) };
  }

  async function readSkill(args) {
    const id = boundedText(args && args.skillId, 64);
    const record = (await discoverSkills()).find((skill) => skill.id === id);
    if (!record) throw agentError('AGENT_SKILL_NOT_FOUND', 'The selected Skill is no longer available.');
    const stat = await fsp.lstat(record.filePath).catch(() => null);
    const real = stat && stat.isFile() && !stat.isSymbolicLink()
      ? await fsp.realpath(record.filePath).catch(() => '')
      : '';
    if (!real || real !== record.filePath || stat.size > 512 * 1024) {
      throw agentError('AGENT_SKILL_NOT_FOUND', 'The selected Skill changed before it could be read.');
    }
    let content;
    try {
      content = await readFileBounded(real, { maxBytes: 512 * 1024, encoding: 'utf8' });
    } catch (_) {
      throw agentError('AGENT_SKILL_NOT_FOUND', 'The selected Skill changed before it could be read.');
    }
    return {
      id: record.id,
      source: record.source,
      name: record.name,
      description: record.description,
      content
    };
  }

  async function request(pluginId, method, args) {
    const id = safePluginId(pluginId);
    for (const [approvalId, operation] of approvals) {
      if (operation.expiresAt < Date.now()) approvals.delete(approvalId);
    }
    if (method === 'models.list') return listModels();
    if (method === 'models.generate') return generate(id, args);
    if (method === 'models.cancel') return cancelGeneration(id, args);
    if (method === 'agent.storage.read') return readStorage(id);
    if (method === 'agent.storage.write') return writeStorage(id, args);
    if (method === 'agent.skills.list') return listSkills();
    if (method === 'agent.skills.read') return readSkill(args);
    if (method === 'agent.tools.invoke') return invokeTool(id, args);
    throw agentError('AGENT_METHOD_DENIED', 'Unknown Agent broker method: ' + method);
  }

  function disposePlugin(pluginId) {
    pluginEpochs.set(pluginId, pluginEpoch(pluginId) + 1);
    for (const [id, operation] of approvals) if (operation.pluginId === pluginId) approvals.delete(id);
    for (const operation of activeOperations.values()) {
      if (operation.pluginId !== pluginId) continue;
      operation.cancelled = true;
      if (operation.child) terminateProcess(operation);
    }
    for (const [requestId, request] of activeModelRequests) {
      if (request.pluginId !== pluginId) continue;
      try { cancelModel(requestId); } catch (_) {}
      activeModelRequests.delete(requestId);
    }
    for (const search of activeSearches.values()) {
      if (search.pluginId === pluginId) search.cancelled = true;
    }
    activeAccessContexts.delete(pluginId);
    for (const key of accessModes.keys()) if (key.startsWith(pluginId + '\0')) accessModes.delete(key);
  }

  function workspaceChanged() {
    const affectedPlugins = new Set();
    for (const operation of approvals.values()) affectedPlugins.add(operation.pluginId);
    for (const operation of activeOperations.values()) affectedPlugins.add(operation.pluginId);
    for (const request of activeModelRequests.values()) affectedPlugins.add(request.pluginId);
    for (const search of activeSearches.values()) affectedPlugins.add(search.pluginId);
    for (const pluginId of affectedPlugins) pluginEpochs.set(pluginId, pluginEpoch(pluginId) + 1);
    approvals.clear();
    for (const operation of activeOperations.values()) {
      operation.cancelled = true;
      if (operation.child) terminateProcess(operation);
    }
    for (const search of activeSearches.values()) search.cancelled = true;
    for (const requestId of activeModelRequests.keys()) {
      try { cancelModel(requestId); } catch (_) {}
    }
    activeModelRequests.clear();
    accessModes.clear();
    activeAccessContexts.clear();
  }

  function dispose() {
    workspaceChanged();
    runningProcesses.clear();
    activeOperations.clear();
    activeModelRequests.clear();
    activeSearches.clear();
  }

  return Object.freeze({
    request,
    getAccessMode,
    setAccessMode,
    clearAccessMode,
    describeApproval,
    decideApproval,
    cancelApproval,
    disposePlugin,
    workspaceChanged,
    dispose,
    _test: {
      normalizeRelativePath,
      modelRecords,
      discoverSkills,
      processEnvironment,
      resolveProcessCommand,
      classifyWorkspaceWriteRisk,
      classifyProcessRisk
    }
  });
}

module.exports = { createAgentPlatformBroker, ALLOWED_COMMANDS };
