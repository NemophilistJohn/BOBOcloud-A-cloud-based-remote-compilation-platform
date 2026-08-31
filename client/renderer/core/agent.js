import { toDisposable } from './disposable.js';
import { cloneExtensionData } from './plugin-extension-protocol.js';

const MAX_ID = 180;
const MAX_TITLE = 160;
const MAX_MESSAGE = 256 * 1024;
const MAX_SESSIONS = 200;
const MAX_MESSAGES = 240;
const MAX_TIMELINE = 320;
const MAX_MODELS = 80;
const MAX_SKILLS = 256;
const MAX_STATE_TEXT = 2 * 1024 * 1024;
const MAX_APPROVAL_RESULT_STRING = 2 * 1024 * 1024;
const MAX_APPROVAL_RESULT_ITEMS = 8192;
const MAX_APPROVAL_OUTPUT_BYTES = 128 * 1024;
const APPROVAL_RESULT_FIELDS = new Set([
  'approved', 'rejected', 'tool', 'path', 'sha256', 'exitCode', 'signal',
  'stdout', 'stderr', 'truncated', 'timedOut', 'cancelled', 'failed',
  'errorCode', 'errorMessage', 'outcome', 'mayHaveExecuted'
]);
const ALLOWED_DESCRIPTOR_FIELDS = new Set(['id', 'title', 'description', 'icon', 'order', 'commands', 'capabilities']);
const ALLOWED_COMMAND_FIELDS = new Set(['create', 'select', 'delete', 'send', 'cancel', 'approve', 'reject', 'preferences', 'configure']);
const ALLOWED_CAPABILITY_FIELDS = new Set(['modes', 'reasoningEfforts', 'accessModes', 'skills', 'localTools']);
const ALLOWED_STATE_FIELDS = new Set(['phase', 'message', 'activeSessionId', 'sessions', 'models', 'skills', 'activeSession']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fields(value, allowed, label) {
  if (!isPlainObject(value)) throw new TypeError(label + ' must be a plain object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) throw new TypeError(label + ' includes an unsupported field: ' + key);
    if (!Object.prototype.hasOwnProperty.call(descriptors[key], 'value')) throw new TypeError(label + ' cannot contain accessors.');
  }
  return value;
}

function requiredText(value, label, maximum = MAX_TITLE) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(label + ' must be a non-empty string.');
  if (value.length > maximum) throw new TypeError(label + ' exceeds the host limit.');
  return value.trim();
}

function optionalText(value, label, maximum = MAX_TITLE) {
  if (value === undefined || value === null || value === '') return '';
  return requiredText(value, label, maximum);
}

function approvalResultText(value, key, maximum) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError('Agent approval result ' + key + ' must be a string.');
  if (value.length > maximum) throw new TypeError('Agent approval result ' + key + ' exceeds the host limit.');
  return value;
}

function truncateUtf8(value, byteBudget) {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= byteBudget) return { value, bytes: encoder.encode(value).byteLength, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= byteBudget) low = middle;
    else high = middle - 1;
  }
  const result = value.slice(0, low);
  return { value: result, bytes: encoder.encode(result).byteLength, truncated: true };
}

function normalizeApprovalResult(value) {
  const source = cloneExtensionData(value, {
    maxDepth: 16,
    maxItems: MAX_APPROVAL_RESULT_ITEMS,
    maxStringLength: MAX_APPROVAL_RESULT_STRING
  });
  if (!isPlainObject(source)) throw new TypeError('Agent approval result must be a plain object.');
  const result = {};
  for (const key of ['approved', 'rejected', 'truncated', 'timedOut', 'cancelled', 'failed', 'mayHaveExecuted']) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (typeof source[key] !== 'boolean') throw new TypeError('Agent approval result ' + key + ' must be a boolean.');
    result[key] = source[key];
  }
  if (Object.prototype.hasOwnProperty.call(source, 'errorCode')) {
    const errorCode = approvalResultText(source.errorCode, 'errorCode', 96);
    if (!/^[A-Za-z0-9_.-]+$/.test(errorCode)) throw new TypeError('Agent approval result errorCode is invalid.');
    result.errorCode = errorCode;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'errorMessage')) {
    result.errorMessage = approvalResultText(source.errorMessage, 'errorMessage', 4000);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'outcome')) {
    const outcome = approvalResultText(source.outcome, 'outcome', 32);
    if (outcome !== 'not-started' && outcome !== 'unknown') throw new TypeError('Agent approval result outcome is invalid.');
    result.outcome = outcome;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'tool')) {
    const tool = approvalResultText(source.tool, 'tool', 96);
    if (tool !== 'workspace_write' && tool !== 'process_run') throw new TypeError('Agent approval result tool is invalid.');
    result.tool = tool;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'path')) result.path = approvalResultText(source.path, 'path', 1000);
  if (Object.prototype.hasOwnProperty.call(source, 'sha256')) {
    const sha256 = approvalResultText(source.sha256, 'sha256', 64);
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new TypeError('Agent approval result sha256 is invalid.');
    result.sha256 = sha256;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'exitCode')) {
    if (source.exitCode !== null && !Number.isSafeInteger(source.exitCode)) throw new TypeError('Agent approval result exitCode is invalid.');
    result.exitCode = source.exitCode;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'signal')) result.signal = approvalResultText(source.signal, 'signal', 64);

  let remaining = MAX_APPROVAL_OUTPUT_BYTES;
  let outputTruncated = false;
  for (const key of ['stdout', 'stderr']) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const output = approvalResultText(source[key], key, MAX_APPROVAL_RESULT_STRING);
    const bounded = truncateUtf8(output, remaining);
    result[key] = bounded.value;
    remaining -= bounded.bytes;
    outputTruncated = outputTruncated || bounded.truncated;
  }
  if (outputTruncated) result.truncated = true;
  const missingUnavailableTool = !result.tool &&
    (result.errorCode === 'AGENT_APPROVAL_NOT_FOUND' || result.errorCode === 'AGENT_APPROVAL_EXPIRED');
  if (result.failed === true && (result.rejected !== true || result.approved === true ||
      (!result.tool && !missingUnavailableTool) ||
      !result.errorCode || typeof result.errorMessage !== 'string' ||
      (result.outcome !== 'not-started' && result.outcome !== 'unknown') ||
      typeof result.mayHaveExecuted !== 'boolean' ||
      (result.outcome === 'unknown') !== result.mayHaveExecuted)) {
    throw new TypeError('Agent approval failure result is invalid.');
  }
  for (const key of Object.keys(result)) {
    if (!APPROVAL_RESULT_FIELDS.has(key)) delete result[key];
  }
  return freeze(result);
}

function scopedId(value, label, maximum = MAX_ID) {
  const id = requiredText(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new TypeError(label + ' contains unsupported characters.');
  return id;
}

function namespacedId(value, label) {
  const id = requiredText(value, label, MAX_ID);
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(id)) throw new TypeError(label + ' must be namespaced.');
  return id;
}

function command(value, label, prefix) {
  const id = requiredText(value, label, MAX_ID);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || (prefix && !id.startsWith(prefix))) {
    throw new TypeError(label + ' must use the owning extension namespace.');
  }
  return id;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function stringSet(value, allowed, fallback) {
  if (!Array.isArray(value)) return Object.freeze([...fallback]);
  const result = [...new Set(value.filter((item) => allowed.has(item)))];
  return Object.freeze(result.length ? result : [...fallback]);
}

export const AgentPhase = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  UNCONFIGURED: 'unconfigured',
  ERROR: 'error'
});

export const AgentSessionStatus = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting-approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const PHASES = new Set(Object.values(AgentPhase));
const SESSION_STATUSES = new Set(Object.values(AgentSessionStatus));
const MODES = new Set(['chat', 'goal']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ACCESS_MODES = new Set(['ask', 'auto', 'full']);
const ROLES = new Set(['user', 'assistant', 'system']);
const TIMELINE_KINDS = new Set(['thought', 'tool', 'status', 'skill', 'compaction', 'error']);
const TIMELINE_STATUSES = new Set(['pending', 'running', 'waiting', 'completed', 'failed', 'rejected']);
const STEP_STATUSES = new Set(['pending', 'in-progress', 'completed', 'blocked']);

export function validateAgentDescriptor(value, owner) {
  fields(value, ALLOWED_DESCRIPTOR_FIELDS, 'Agent descriptor');
  const id = namespacedId(value.id, 'Agent descriptor id');
  if (owner && !id.startsWith(owner + '.')) throw new TypeError('Agent descriptor id must use the extension namespace.');
  const prefix = owner ? owner + '.' : '';
  const commands = fields(value.commands, ALLOWED_COMMAND_FIELDS, 'Agent command map');
  const capabilities = fields(value.capabilities || {}, ALLOWED_CAPABILITY_FIELDS, 'Agent capabilities');
  return freeze({
    id,
    title: requiredText(value.title, 'Agent title'),
    description: optionalText(value.description, 'Agent description', 600),
    icon: value.icon === 'sparkles' ? 'sparkles' : 'sparkles',
    order: Number.isInteger(value.order) && value.order >= -1000 && value.order <= 1000 ? value.order : 0,
    commands: {
      create: command(commands.create, 'Agent create command', prefix),
      select: command(commands.select, 'Agent select command', prefix),
      delete: command(commands.delete, 'Agent delete command', prefix),
      send: command(commands.send, 'Agent send command', prefix),
      cancel: command(commands.cancel, 'Agent cancel command', prefix),
      approve: command(commands.approve, 'Agent approve command', prefix),
      reject: command(commands.reject, 'Agent reject command', prefix),
      preferences: command(commands.preferences, 'Agent preferences command', prefix),
      configure: command(commands.configure, 'Agent configure command', prefix)
    },
    capabilities: {
      modes: stringSet(capabilities.modes, MODES, ['chat']),
      reasoningEfforts: stringSet(capabilities.reasoningEfforts, EFFORTS, ['medium']),
      accessModes: stringSet(capabilities.accessModes, ACCESS_MODES, ['ask']),
      skills: capabilities.skills === true,
      localTools: capabilities.localTools === true
    }
  });
}

function sessionSummary(value) {
  fields(value, new Set(['id', 'title', 'updatedAt', 'status', 'mode']), 'Agent session summary');
  return Object.freeze({
    id: scopedId(value.id, 'Agent session id'),
    title: requiredText(value.title, 'Agent session title'),
    updatedAt: optionalText(value.updatedAt, 'Agent session timestamp', 64),
    status: SESSION_STATUSES.has(value.status) ? value.status : 'idle',
    mode: MODES.has(value.mode) ? value.mode : 'chat'
  });
}

function modelChoice(value) {
  fields(value, new Set(['ref', 'name', 'provider', 'modelId', 'purpose', 'configured']), 'Agent model choice');
  return Object.freeze({
    ref: scopedId(value.ref, 'Agent model reference'),
    name: requiredText(value.name, 'Agent model name'),
    provider: optionalText(value.provider, 'Agent model provider', 80),
    modelId: optionalText(value.modelId, 'Agent model id', 200),
    purpose: value.purpose === 'inline' ? 'inline' : 'chat',
    configured: value.configured === true
  });
}

function skillChoice(value) {
  fields(value, new Set(['id', 'name', 'description', 'source', 'enabled']), 'Agent skill choice');
  return Object.freeze({
    id: scopedId(value.id, 'Agent skill id'),
    name: requiredText(value.name, 'Agent skill name'),
    description: optionalText(value.description, 'Agent skill description', 1000),
    source: value.source === 'workspace' ? 'workspace' : 'user',
    enabled: value.enabled !== false
  });
}

function message(value) {
  fields(value, new Set(['id', 'role', 'content', 'reasoning', 'createdAt']), 'Agent message');
  if (!ROLES.has(value.role)) throw new TypeError('Agent message role is invalid.');
  return Object.freeze({
    id: scopedId(value.id, 'Agent message id'),
    role: value.role,
    content: optionalText(value.content, 'Agent message content', MAX_MESSAGE),
    reasoning: optionalText(value.reasoning, 'Agent message reasoning', MAX_MESSAGE),
    createdAt: optionalText(value.createdAt, 'Agent message timestamp', 64)
  });
}

function timelineItem(value) {
  fields(value, new Set(['id', 'kind', 'title', 'detail', 'status', 'createdAt']), 'Agent timeline item');
  return Object.freeze({
    id: scopedId(value.id, 'Agent timeline item id'),
    kind: TIMELINE_KINDS.has(value.kind) ? value.kind : 'status',
    title: requiredText(value.title, 'Agent timeline item title'),
    detail: optionalText(value.detail, 'Agent timeline item detail', 32 * 1024),
    status: TIMELINE_STATUSES.has(value.status) ? value.status : 'completed',
    createdAt: optionalText(value.createdAt, 'Agent timeline item timestamp', 64)
  });
}

function goal(value) {
  if (value === undefined || value === null) return null;
  fields(value, new Set(['title', 'status', 'steps']), 'Agent goal');
  const steps = Array.isArray(value.steps) ? value.steps.slice(0, 40).map((step) => {
    fields(step, new Set(['id', 'title', 'status']), 'Agent goal step');
    return Object.freeze({
      id: scopedId(step.id, 'Agent goal step id'),
      title: requiredText(step.title, 'Agent goal step title', 300),
      status: STEP_STATUSES.has(step.status) ? step.status : 'pending'
    });
  }) : [];
  return Object.freeze({
    title: requiredText(value.title, 'Agent goal title', 300),
    status: STEP_STATUSES.has(value.status) ? value.status : 'pending',
    steps: Object.freeze(steps)
  });
}

function approval(value) {
  if (value === undefined || value === null) return null;
  fields(value, new Set(['id']), 'Agent approval');
  return Object.freeze({
    id: scopedId(value.id, 'Agent approval id')
  });
}

function compaction(value) {
  if (value === undefined || value === null) return null;
  fields(value, new Set(['count', 'compactedMessages', 'estimatedTokensBefore', 'estimatedTokensAfter', 'compactedAt']), 'Agent compaction');
  const boundedCount = (input) => Number.isSafeInteger(input) && input >= 0 && input <= 1_000_000_000 ? input : 0;
  return Object.freeze({
    count: boundedCount(value.count),
    compactedMessages: boundedCount(value.compactedMessages),
    estimatedTokensBefore: boundedCount(value.estimatedTokensBefore),
    estimatedTokensAfter: boundedCount(value.estimatedTokensAfter),
    compactedAt: optionalText(value.compactedAt, 'Agent compaction timestamp', 64)
  });
}

function activeSession(value) {
  if (value === undefined || value === null) return null;
  fields(value, new Set(['id', 'title', 'status', 'mode', 'reasoningEffort', 'accessMode', 'modelRef', 'messages', 'timeline', 'goal', 'approval', 'compacting', 'compaction']), 'Active Agent session');
  const messages = Array.isArray(value.messages) ? value.messages.slice(-MAX_MESSAGES).map(message) : [];
  const timeline = Array.isArray(value.timeline) ? value.timeline.slice(-MAX_TIMELINE).map(timelineItem) : [];
  return freeze({
    id: scopedId(value.id, 'Active Agent session id'),
    title: requiredText(value.title, 'Active Agent session title'),
    status: SESSION_STATUSES.has(value.status) ? value.status : 'idle',
    mode: MODES.has(value.mode) ? value.mode : 'chat',
    reasoningEffort: EFFORTS.has(value.reasoningEffort) ? value.reasoningEffort : 'medium',
    accessMode: ACCESS_MODES.has(value.accessMode) ? value.accessMode : 'ask',
    modelRef: optionalText(value.modelRef, 'Agent model reference', MAX_ID),
    messages,
    timeline,
    goal: goal(value.goal),
    approval: approval(value.approval),
    compacting: value.compacting === true,
    compaction: compaction(value.compaction)
  });
}

export function validateAgentState(value) {
  fields(value || {}, ALLOWED_STATE_FIELDS, 'Agent state');
  const sessions = Array.isArray(value.sessions) ? value.sessions.slice(0, MAX_SESSIONS).map(sessionSummary) : [];
  const models = Array.isArray(value.models) ? value.models.slice(0, MAX_MODELS).map(modelChoice) : [];
  const skills = Array.isArray(value.skills) ? value.skills.slice(0, MAX_SKILLS).map(skillChoice) : [];
  const current = activeSession(value.activeSession);
  const activeSessionId = optionalText(value.activeSessionId, 'Active Agent session id', MAX_ID);
  if (current && activeSessionId && current.id !== activeSessionId) throw new TypeError('Active Agent session identity is inconsistent.');
  const stateTextSize = (current ? current.messages.reduce((total, item) => total + item.content.length + item.reasoning.length, 0) +
    current.timeline.reduce((total, item) => total + item.title.length + item.detail.length, 0) : 0) +
    sessions.reduce((total, item) => total + item.title.length, 0) +
    models.reduce((total, item) => total + item.name.length + item.modelId.length, 0) +
    skills.reduce((total, item) => total + item.name.length + item.description.length, 0);
  if (stateTextSize > MAX_STATE_TEXT) throw new TypeError('Agent state exceeds the host text budget.');
  return freeze({
    phase: PHASES.has(value.phase) ? value.phase : 'idle',
    message: optionalText(value.message, 'Agent state message', 4000),
    activeSessionId,
    sessions,
    models,
    skills,
    activeSession: current
  });
}

export function createAgentCommandPayload(providerId, action, values = {}) {
  const payload = { providerId: namespacedId(providerId, 'Agent provider id'), action: scopedId(action, 'Agent action', 48) };
  if (!isPlainObject(values)) throw new TypeError('Agent command values must be a plain object.');
  const allowed = new Set(['sessionId', 'text', 'mode', 'reasoningEffort', 'accessMode', 'modelRef', 'skillIds', 'approvalId', 'approvalResult']);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) continue;
    if (key === 'skillIds') {
      payload.skillIds = Array.isArray(values.skillIds) ? values.skillIds.slice(0, MAX_SKILLS).map((id) => scopedId(id, 'Agent skill id')) : [];
    } else if (key === 'text') {
      payload.text = optionalText(values.text, 'Agent prompt', MAX_MESSAGE);
    } else if (key === 'mode') {
      payload.mode = MODES.has(values.mode) ? values.mode : 'chat';
    } else if (key === 'reasoningEffort') {
      payload.reasoningEffort = EFFORTS.has(values.reasoningEffort) ? values.reasoningEffort : 'medium';
    } else if (key === 'accessMode') {
      payload.accessMode = ACCESS_MODES.has(values.accessMode) ? values.accessMode : 'ask';
    } else if (key === 'approvalResult') {
      payload.approvalResult = normalizeApprovalResult(values.approvalResult);
    } else {
      payload[key] = optionalText(values[key], 'Agent command value', MAX_ID);
    }
  }
  return freeze(payload);
}

export class AgentStateStore {
  constructor(options = {}) {
    this._records = new Map();
    this._listeners = new Set();
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._disposed = false;
  }

  register(descriptor, options = {}) {
    if (this._disposed) throw new Error('Agent state store has been disposed.');
    const normalized = validateAgentDescriptor(descriptor, options.owner);
    if (this._records.has(normalized.id)) throw new Error('Agent provider is already registered: ' + normalized.id);
    const record = { id: normalized.id, owner: options.owner || 'core', descriptor: normalized, state: null, version: 0, active: true };
    this._records.set(record.id, record);
    this._emit('added', record);
    let active = true;
    return Object.freeze({
      id: record.id,
      setState: (state) => {
        if (!active || !record.active || this._records.get(record.id) !== record) throw new Error('Agent provider has been disposed.');
        record.state = validateAgentState(state);
        record.version += 1;
        this._emit('state', record);
        return Object.freeze({ version: record.version });
      },
      clearState: () => {
        if (!active || !record.active || this._records.get(record.id) !== record) return Object.freeze({ version: record.version });
        record.state = null;
        record.version += 1;
        this._emit('state', record);
        return Object.freeze({ version: record.version });
      },
      dispose: () => {
        if (!active) return;
        active = false;
        record.active = false;
        if (this._records.get(record.id) !== record) return;
        this._records.delete(record.id);
        this._emit('removed', record);
      }
    });
  }

  list() {
    return Array.from(this._records.values()).sort((left, right) => left.descriptor.order - right.descriptor.order || left.id.localeCompare(right.id)).map((record) => this._snapshot(record));
  }

  get(id) {
    const record = this._records.get(id);
    return record ? this._snapshot(record) : null;
  }

  onDidChange(listener) {
    if (this._disposed) throw new Error('Agent state store has been disposed.');
    if (typeof listener !== 'function') throw new TypeError('Agent state listener must be a function.');
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  }

  disposeOwner(owner) {
    for (const record of Array.from(this._records.values())) {
      if (record.owner !== owner) continue;
      record.active = false;
      this._records.delete(record.id);
      this._emit('removed', record);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const record of Array.from(this._records.values())) {
      record.active = false;
      this._emit('removed', record);
    }
    this._records.clear();
    this._listeners.clear();
  }

  _snapshot(record) {
    return Object.freeze({ id: record.id, owner: record.owner, descriptor: record.descriptor, state: record.state, version: record.version });
  }

  _emit(type, record) {
    const event = Object.freeze({ type, record: this._snapshot(record) });
    for (const listener of Array.from(this._listeners)) {
      try { listener(event); } catch (error) { this._onError({ source: 'agent-state-listener', id: record.id, error }); }
    }
  }
}
