import { toDisposable } from './disposable.js';
import { cloneExtensionData } from './plugin-extension-protocol.js';
import type { Disposable } from '../../types/lifecycle';
import type {
  AgentAccessModeDto,
  AgentActiveSessionDto,
  AgentApprovalDto,
  AgentApprovalResultDto,
  AgentCommandPayloadDto,
  AgentCommandValuesRegistrationDto,
  AgentCompactionDto,
  AgentDescriptorDto,
  AgentDescriptorRegistrationDto,
  AgentEffectiveReasoningEffortDto,
  AgentGoalDto,
  AgentGoalStepDto,
  AgentGoalStepStatusDto,
  AgentMessageDto,
  AgentModeDto,
  AgentModelCapabilitiesDto,
  AgentModelCapabilitySourceDto,
  AgentModelChoiceDto,
  AgentObservedStatePatchDto,
  AgentObservedStatePatchOperationDto,
  AgentPhaseDto,
  AgentReasoningEffortDto,
  AgentSessionStatusDto,
  AgentSessionSummaryDto,
  AgentSkillChoiceDto,
  AgentStateChangeEvent,
  AgentStateChangeListener,
  AgentStateChangeType,
  AgentStateDto,
  AgentStateHandle,
  AgentStatePatchDto,
  AgentStateRegistrationDto,
  AgentStateRegistrationOptions,
  AgentStateSnapshot,
  AgentStateStoreContract,
  AgentStateStoreErrorEvent,
  AgentStateStoreOptions,
  AgentStateUpdateResultDto,
  AgentTimelineItemDto,
  AgentTimelineKindDto,
  AgentTimelineStatusDto,
  AgentVersionDto
} from '../../types/agent';

const MAX_ID = 180;
const MAX_TITLE = 160;
const MAX_MESSAGE = 256 * 1024;
const MAX_SESSIONS = 200;
const MAX_MESSAGES = 240;
const MAX_TIMELINE = 320;
const MAX_MODELS = 80;
const MAX_SKILLS = 256;
const MAX_PATCH_OPERATIONS = 128;
const MAX_MODEL_REQUEST_OUTPUT_TOKENS = 262_144;
const MAX_STATE_TEXT = 2 * 1024 * 1024;
const MAX_APPROVAL_RESULT_STRING = 2 * 1024 * 1024;
const MAX_APPROVAL_RESULT_ITEMS = 8192;
const MAX_APPROVAL_OUTPUT_BYTES = 128 * 1024;
const APPROVAL_RESULT_FIELDS: ReadonlySet<string> = new Set([
  'approved', 'rejected', 'tool', 'path', 'sha256', 'exitCode', 'signal',
  'stdout', 'stderr', 'truncated', 'timedOut', 'cancelled', 'failed',
  'errorCode', 'errorMessage', 'outcome', 'mayHaveExecuted'
]);
const ALLOWED_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'description', 'icon', 'order', 'commands', 'capabilities']);
const ALLOWED_COMMAND_FIELDS: ReadonlySet<string> = new Set(['create', 'select', 'delete', 'send', 'cancel', 'approve', 'reject', 'preferences', 'configure']);
const ALLOWED_CAPABILITY_FIELDS: ReadonlySet<string> = new Set(['modes', 'reasoningEfforts', 'accessModes', 'skills', 'localTools']);
const ALLOWED_STATE_FIELDS: ReadonlySet<string> = new Set(['phase', 'message', 'activeSessionId', 'sessions', 'models', 'skills', 'activeSession']);
const SESSION_SUMMARY_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'updatedAt', 'status', 'mode']);
const MODEL_CHOICE_FIELDS: ReadonlySet<string> = new Set(['ref', 'name', 'provider', 'modelId', 'purpose', 'configured', 'capabilities']);
const MODEL_CAPABILITY_FIELDS: ReadonlySet<string> = new Set([
  'contextWindowTokens', 'maxOutputTokens', 'requestOutputLimitTokens', 'tools', 'streaming',
  'parallelToolCalls', 'reasoningEfforts', 'effectiveEffortMap', 'source'
]);
const SKILL_CHOICE_FIELDS: ReadonlySet<string> = new Set([
  'id', 'name', 'description', 'source', 'enabled', 'revision', 'sizeBytes', 'estimatedTokens'
]);
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['id', 'role', 'content', 'reasoning', 'createdAt']);
const TIMELINE_ITEM_FIELDS: ReadonlySet<string> = new Set(['id', 'kind', 'title', 'detail', 'status', 'createdAt']);
const GOAL_FIELDS: ReadonlySet<string> = new Set(['title', 'status', 'steps']);
const GOAL_STEP_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'status']);
const APPROVAL_FIELDS: ReadonlySet<string> = new Set(['id']);
const COMPACTION_FIELDS: ReadonlySet<string> = new Set([
  'count', 'compactedMessages', 'estimatedTokensBefore', 'estimatedTokensAfter', 'compactedAt'
]);
const ACTIVE_SESSION_FIELDS: ReadonlySet<string> = new Set([
  'id', 'title', 'status', 'mode', 'reasoningEffort', 'effectiveReasoningEffort',
  'accessMode', 'modelRef', 'messages', 'timeline', 'goal', 'approval', 'compacting', 'compaction'
]);
const STATE_PATCH_FIELDS: ReadonlySet<string> = new Set(['baseVersion', 'operations']);
const PATCH_OPERATION_FIELDS: ReadonlySet<string> = new Set(['type', 'value']);
const STATE_MERGE_FIELDS: ReadonlySet<string> = new Set(['phase', 'message', 'activeSessionId', 'sessions', 'models', 'skills']);
const SESSION_MERGE_FIELDS: ReadonlySet<string> = new Set([
  'id', 'title', 'status', 'mode', 'reasoningEffort', 'effectiveReasoningEffort',
  'accessMode', 'modelRef', 'goal', 'approval', 'compacting', 'compaction'
]);
const PATCH_OPERATION_TYPES = new Set<AgentStatePatchDto['operations'][number]['type']>([
  'state.merge', 'session.merge', 'message.upsert', 'timeline.upsert'
]);
const COMMAND_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'sessionId', 'text', 'mode', 'reasoningEffort', 'accessMode', 'modelRef',
  'skillIds', 'approvalId', 'approvalResult'
]);

type PlainObject = Record<string, unknown>;
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

interface TruncatedUtf8 {
  readonly value: string | undefined;
  readonly bytes: number;
  readonly truncated: boolean;
}

interface AgentRecord {
  readonly id: string;
  readonly owner: string;
  readonly descriptor: AgentDescriptorDto;
  state: AgentStateDto | null;
  version: number;
  active: boolean;
}

interface MutableAgentActiveSession extends Omit<Mutable<AgentActiveSessionDto>, 'messages' | 'timeline'> {
  messages: AgentMessageDto[];
  timeline: AgentTimelineItemDto[];
}

interface MutableAgentState extends Omit<Mutable<AgentStateDto>, 'sessions' | 'models' | 'skills' | 'activeSession'> {
  sessions: AgentSessionSummaryDto[];
  models: AgentModelChoiceDto[];
  skills: AgentSkillChoiceDto[];
  activeSession: MutableAgentActiveSession | null;
}

function isPlainObject(value: unknown): value is PlainObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fields(value: unknown, allowed: ReadonlySet<string>, label: string): PlainObject {
  if (!isPlainObject(value)) throw new TypeError(label + ' must be a plain object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) throw new TypeError(label + ' includes an unsupported field: ' + key);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new TypeError(label + ' cannot contain accessors.');
  }
  return value;
}

function requiredText(value: unknown, label: string, maximum = MAX_TITLE): string {
  if (typeof value !== 'string') throw new TypeError(label + ' must be a non-empty string.');
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(label + ' must be a non-empty string.');
  if (value.length > maximum) throw new TypeError(label + ' exceeds the host limit.');
  return trimmed;
}

function optionalText(value: unknown, label: string, maximum = MAX_TITLE): string {
  if (value === undefined || value === null || value === '') return '';
  return requiredText(value, label, maximum);
}

function approvalResultText(value: unknown, key: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError('Agent approval result ' + key + ' must be a string.');
  if (value.length > maximum) throw new TypeError('Agent approval result ' + key + ' exceeds the host limit.');
  return value;
}

function truncateUtf8(value: string | undefined, byteBudget: number): TruncatedUtf8 {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= byteBudget) return { value, bytes: encoded.byteLength, truncated: false };
  const text = value as string;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).byteLength <= byteBudget) low = middle;
    else high = middle - 1;
  }
  const result = text.slice(0, low);
  return { value: result, bytes: encoder.encode(result).byteLength, truncated: true };
}

function normalizeApprovalResult(value: unknown): AgentApprovalResultDto {
  const source = cloneExtensionData(value, {
    maxDepth: 16,
    maxItems: MAX_APPROVAL_RESULT_ITEMS,
    maxStringLength: MAX_APPROVAL_RESULT_STRING
  });
  if (!isPlainObject(source)) throw new TypeError('Agent approval result must be a plain object.');
  const result: Mutable<AgentApprovalResultDto> = {};
  for (const key of ['approved', 'rejected', 'truncated', 'timedOut', 'cancelled', 'failed', 'mayHaveExecuted'] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (typeof source[key] !== 'boolean') throw new TypeError('Agent approval result ' + key + ' must be a boolean.');
    result[key] = source[key];
  }
  if (Object.prototype.hasOwnProperty.call(source, 'errorCode')) {
    const errorCode = approvalResultText(source.errorCode, 'errorCode', 96);
    if (!/^[A-Za-z0-9_.-]+$/.test(errorCode as string)) throw new TypeError('Agent approval result errorCode is invalid.');
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
    if (source.exitCode !== null && (typeof source.exitCode !== 'number' || !Number.isSafeInteger(source.exitCode))) {
      throw new TypeError('Agent approval result exitCode is invalid.');
    }
    result.exitCode = source.exitCode;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'signal')) result.signal = approvalResultText(source.signal, 'signal', 64);

  let remaining = MAX_APPROVAL_OUTPUT_BYTES;
  let outputTruncated = false;
  for (const key of ['stdout', 'stderr'] as const) {
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
    if (!APPROVAL_RESULT_FIELDS.has(key)) delete (result as PlainObject)[key];
  }
  return freeze(result);
}

function scopedId(value: unknown, label: string, maximum = MAX_ID): string {
  const id = requiredText(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new TypeError(label + ' contains unsupported characters.');
  return id;
}

function namespacedId(value: unknown, label: string): string {
  const id = requiredText(value, label, MAX_ID);
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(id)) throw new TypeError(label + ' must be namespaced.');
  return id;
}

function command(value: unknown, label: string, prefix: string): string {
  const id = requiredText(value, label, MAX_ID);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || (prefix && !id.startsWith(prefix))) {
    throw new TypeError(label + ' must use the owning extension namespace.');
  }
  return id;
}

function freeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as object)) freeze(child);
  return Object.freeze(value) as Value;
}

function stringSet<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<Value>,
  fallback: readonly Value[]
): readonly Value[] {
  if (!Array.isArray(value)) return Object.freeze([...fallback]);
  const result = [...new Set(value.filter((item): item is Value => allowed.has(item as Value)))];
  return Object.freeze(result.length ? result : [...fallback]);
}

export const AgentPhase = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  UNCONFIGURED: 'unconfigured',
  ERROR: 'error'
} as const);

export const AgentSessionStatus = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting-approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
} as const);

const PHASES = new Set<AgentPhaseDto>(Object.values(AgentPhase));
const SESSION_STATUSES = new Set<AgentSessionStatusDto>(Object.values(AgentSessionStatus));
const MODES = new Set<AgentModeDto>(['chat', 'goal']);
const EFFORTS = new Set<AgentReasoningEffortDto>(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFECTIVE_EFFORTS = new Set<AgentEffectiveReasoningEffortDto>([...EFFORTS, 'none']);
const ACCESS_MODES = new Set<AgentAccessModeDto>(['ask', 'auto', 'full']);
const ROLES = new Set<AgentMessageDto['role']>(['user', 'assistant', 'system']);
const TIMELINE_KINDS = new Set<AgentTimelineKindDto>(['thought', 'tool', 'status', 'skill', 'compaction', 'error']);
const TIMELINE_STATUSES = new Set<AgentTimelineStatusDto>(['pending', 'running', 'waiting', 'completed', 'failed', 'rejected']);
const STEP_STATUSES = new Set<AgentGoalStepStatusDto>(['pending', 'in-progress', 'completed', 'blocked']);
const MODEL_CAPABILITY_SOURCES = new Set<AgentModelCapabilitySourceDto>([
  'provider-api', 'official-catalog', 'user-override'
]);

function setHas<Value>(values: ReadonlySet<Value>, value: unknown): value is Value {
  return values.has(value as Value);
}

function boundedTokenLimit(input: unknown, label: string, maximum = 100_000_000): number | null {
  if (input === undefined || input === null) return null;
  if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > maximum) {
    throw new TypeError(label + ' is invalid.');
  }
  return input as number;
}

function nullableBoolean(input: unknown, label: string): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'boolean') throw new TypeError(label + ' is invalid.');
  return input;
}

function boundedSkillCount(input: unknown, label: string): number | null {
  if (input === undefined || input === null) return null;
  if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) > 100_000_000) {
    throw new TypeError(label + ' is invalid.');
  }
  return input as number;
}

function boundedCompactionCount(input: unknown): number {
  return Number.isSafeInteger(input) && (input as number) >= 0 && (input as number) <= 1_000_000_000
    ? input as number
    : 0;
}

export function validateAgentDescriptor(value: unknown, owner?: string): AgentDescriptorDto {
  const source = fields(value, ALLOWED_DESCRIPTOR_FIELDS, 'Agent descriptor');
  const id = namespacedId(source.id, 'Agent descriptor id');
  if (owner && !id.startsWith(owner + '.')) throw new TypeError('Agent descriptor id must use the extension namespace.');
  const prefix = owner ? owner + '.' : '';
  const commands = fields(source.commands, ALLOWED_COMMAND_FIELDS, 'Agent command map');
  const capabilities = fields(source.capabilities || {}, ALLOWED_CAPABILITY_FIELDS, 'Agent capabilities');
  return freeze({
    id,
    title: requiredText(source.title, 'Agent title'),
    description: optionalText(source.description, 'Agent description', 600),
    icon: source.icon === 'sparkles' ? 'sparkles' : 'sparkles',
    order: Number.isInteger(source.order) && (source.order as number) >= -1000 && (source.order as number) <= 1000
      ? source.order as number
      : 0,
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

function sessionSummary(value: unknown): AgentSessionSummaryDto {
  const source = fields(value, SESSION_SUMMARY_FIELDS, 'Agent session summary');
  return Object.freeze({
    id: scopedId(source.id, 'Agent session id'),
    title: requiredText(source.title, 'Agent session title'),
    updatedAt: optionalText(source.updatedAt, 'Agent session timestamp', 64),
    status: setHas(SESSION_STATUSES, source.status) ? source.status : 'idle',
    mode: setHas(MODES, source.mode) ? source.mode : 'chat'
  });
}

function modelChoice(value: unknown): AgentModelChoiceDto {
  const source = fields(value, MODEL_CHOICE_FIELDS, 'Agent model choice');
  const capabilitySource = source.capabilities === undefined || source.capabilities === null
    ? null
    : fields(source.capabilities, MODEL_CAPABILITY_FIELDS, 'Agent model capabilities');
  const effortMap: Partial<Record<AgentReasoningEffortDto, AgentEffectiveReasoningEffortDto>> = {};
  if (capabilitySource && capabilitySource.effectiveEffortMap !== undefined && capabilitySource.effectiveEffortMap !== null) {
    const effectiveEffortMap = fields(
      capabilitySource.effectiveEffortMap,
      EFFORTS,
      'Agent model effective effort map'
    );
    for (const [requested, effective] of Object.entries(effectiveEffortMap)) {
      if (!setHas(EFFECTIVE_EFFORTS, effective)) throw new TypeError('Agent model effective effort map is invalid.');
      effortMap[requested as AgentReasoningEffortDto] = effective;
    }
  }
  const capabilities: AgentModelCapabilitiesDto | null = capabilitySource ? Object.freeze({
    contextWindowTokens: boundedTokenLimit(capabilitySource.contextWindowTokens, 'Agent model context window'),
    maxOutputTokens: boundedTokenLimit(capabilitySource.maxOutputTokens, 'Agent model output limit'),
    requestOutputLimitTokens: boundedTokenLimit(
      capabilitySource.requestOutputLimitTokens,
      'Agent model request output limit',
      MAX_MODEL_REQUEST_OUTPUT_TOKENS
    ),
    tools: nullableBoolean(capabilitySource.tools, 'Agent model tool support'),
    streaming: nullableBoolean(capabilitySource.streaming, 'Agent model streaming support'),
    parallelToolCalls: nullableBoolean(capabilitySource.parallelToolCalls, 'Agent model parallel tool support'),
    reasoningEfforts: Object.freeze(Array.isArray(capabilitySource.reasoningEfforts)
      ? [...new Set(capabilitySource.reasoningEfforts.filter((effort): effort is AgentReasoningEffortDto => setHas(EFFORTS, effort)))]
      : []),
    effectiveEffortMap: Object.freeze(effortMap),
    source: setHas(MODEL_CAPABILITY_SOURCES, capabilitySource.source) ? capabilitySource.source : 'unknown'
  }) : null;
  return Object.freeze({
    ref: scopedId(source.ref, 'Agent model reference'),
    name: requiredText(source.name, 'Agent model name'),
    provider: optionalText(source.provider, 'Agent model provider', 80),
    modelId: optionalText(source.modelId, 'Agent model id', 200),
    purpose: source.purpose === 'inline' ? 'inline' : 'chat',
    configured: source.configured === true,
    capabilities
  });
}

function skillChoice(value: unknown): AgentSkillChoiceDto {
  const source = fields(value, SKILL_CHOICE_FIELDS, 'Agent skill choice');
  return Object.freeze({
    id: scopedId(source.id, 'Agent skill id'),
    name: requiredText(source.name, 'Agent skill name'),
    description: optionalText(source.description, 'Agent skill description', 1000),
    source: source.source === 'workspace' ? 'workspace' : 'user',
    enabled: source.enabled !== false,
    revision: optionalText(source.revision, 'Agent skill revision', 160),
    sizeBytes: boundedSkillCount(source.sizeBytes, 'Agent skill size'),
    estimatedTokens: boundedSkillCount(source.estimatedTokens, 'Agent skill token estimate')
  });
}

function message(value: unknown): AgentMessageDto {
  const source = fields(value, MESSAGE_FIELDS, 'Agent message');
  if (!setHas(ROLES, source.role)) throw new TypeError('Agent message role is invalid.');
  return Object.freeze({
    id: scopedId(source.id, 'Agent message id'),
    role: source.role,
    content: optionalText(source.content, 'Agent message content', MAX_MESSAGE),
    reasoning: optionalText(source.reasoning, 'Agent message reasoning', MAX_MESSAGE),
    createdAt: optionalText(source.createdAt, 'Agent message timestamp', 64)
  });
}

function timelineItem(value: unknown): AgentTimelineItemDto {
  const source = fields(value, TIMELINE_ITEM_FIELDS, 'Agent timeline item');
  return Object.freeze({
    id: scopedId(source.id, 'Agent timeline item id'),
    kind: setHas(TIMELINE_KINDS, source.kind) ? source.kind : 'status',
    title: requiredText(source.title, 'Agent timeline item title'),
    detail: optionalText(source.detail, 'Agent timeline item detail', 32 * 1024),
    status: setHas(TIMELINE_STATUSES, source.status) ? source.status : 'completed',
    createdAt: optionalText(source.createdAt, 'Agent timeline item timestamp', 64)
  });
}

function goal(value: unknown): AgentGoalDto | null {
  if (value === undefined || value === null) return null;
  const source = fields(value, GOAL_FIELDS, 'Agent goal');
  const steps: AgentGoalStepDto[] = Array.isArray(source.steps) ? source.steps.slice(0, 40).map((step) => {
    const stepSource = fields(step, GOAL_STEP_FIELDS, 'Agent goal step');
    return Object.freeze({
      id: scopedId(stepSource.id, 'Agent goal step id'),
      title: requiredText(stepSource.title, 'Agent goal step title', 300),
      status: setHas(STEP_STATUSES, stepSource.status) ? stepSource.status : 'pending'
    });
  }) : [];
  return Object.freeze({
    title: requiredText(source.title, 'Agent goal title', 300),
    status: setHas(STEP_STATUSES, source.status) ? source.status : 'pending',
    steps: Object.freeze(steps)
  });
}

function approval(value: unknown): AgentApprovalDto | null {
  if (value === undefined || value === null) return null;
  const source = fields(value, APPROVAL_FIELDS, 'Agent approval');
  return Object.freeze({
    id: scopedId(source.id, 'Agent approval id')
  });
}

function compaction(value: unknown): AgentCompactionDto | null {
  if (value === undefined || value === null) return null;
  const source = fields(value, COMPACTION_FIELDS, 'Agent compaction');
  return Object.freeze({
    count: boundedCompactionCount(source.count),
    compactedMessages: boundedCompactionCount(source.compactedMessages),
    estimatedTokensBefore: boundedCompactionCount(source.estimatedTokensBefore),
    estimatedTokensAfter: boundedCompactionCount(source.estimatedTokensAfter),
    compactedAt: optionalText(source.compactedAt, 'Agent compaction timestamp', 64)
  });
}

function activeSession(value: unknown): AgentActiveSessionDto | null {
  if (value === undefined || value === null) return null;
  const source = fields(value, ACTIVE_SESSION_FIELDS, 'Active Agent session');
  const messages = Array.isArray(source.messages) ? source.messages.slice(-MAX_MESSAGES).map(message) : [];
  const timeline = Array.isArray(source.timeline) ? source.timeline.slice(-MAX_TIMELINE).map(timelineItem) : [];
  return freeze({
    id: scopedId(source.id, 'Active Agent session id'),
    title: requiredText(source.title, 'Active Agent session title'),
    status: setHas(SESSION_STATUSES, source.status) ? source.status : 'idle',
    mode: setHas(MODES, source.mode) ? source.mode : 'chat',
    reasoningEffort: setHas(EFFORTS, source.reasoningEffort) ? source.reasoningEffort : 'medium',
    effectiveReasoningEffort: setHas(EFFECTIVE_EFFORTS, source.effectiveReasoningEffort)
      ? source.effectiveReasoningEffort
      : 'none',
    accessMode: setHas(ACCESS_MODES, source.accessMode) ? source.accessMode : 'ask',
    modelRef: optionalText(source.modelRef, 'Agent model reference', MAX_ID),
    messages,
    timeline,
    goal: goal(source.goal),
    approval: approval(source.approval),
    compacting: source.compacting === true,
    compaction: compaction(source.compaction)
  });
}

export function validateAgentState(value: unknown): AgentStateDto {
  fields(value || {}, ALLOWED_STATE_FIELDS, 'Agent state');
  const source = value as PlainObject;
  const sessions = Array.isArray(source.sessions) ? source.sessions.slice(0, MAX_SESSIONS).map(sessionSummary) : [];
  const models = Array.isArray(source.models) ? source.models.slice(0, MAX_MODELS).map(modelChoice) : [];
  const skills = Array.isArray(source.skills) ? source.skills.slice(0, MAX_SKILLS).map(skillChoice) : [];
  const current = activeSession(source.activeSession);
  const activeSessionId = optionalText(source.activeSessionId, 'Active Agent session id', MAX_ID);
  if (current && activeSessionId && current.id !== activeSessionId) throw new TypeError('Active Agent session identity is inconsistent.');
  const stateTextSize = (current ? current.messages.reduce((total, item) => total + item.content.length + item.reasoning.length, 0) +
    current.timeline.reduce((total, item) => total + item.title.length + item.detail.length, 0) : 0) +
    sessions.reduce((total, item) => total + item.title.length, 0) +
    models.reduce((total, item) => total + item.name.length + item.modelId.length, 0) +
    skills.reduce((total, item) => total + item.name.length + item.description.length, 0);
  if (stateTextSize > MAX_STATE_TEXT) throw new TypeError('Agent state exceeds the host text budget.');
  return freeze({
    phase: setHas(PHASES, source.phase) ? source.phase : 'idle',
    message: optionalText(source.message, 'Agent state message', 4000),
    activeSessionId,
    sessions,
    models,
    skills,
    activeSession: current
  });
}

function mergeFields(target: object, source: unknown, allowed: ReadonlySet<string>, label: string): void {
  const normalized = fields(source, allowed, label);
  const mutableTarget = target as PlainObject;
  for (const [key, value] of Object.entries(normalized)) mutableTarget[key] = value;
}

function upsertById<Value extends { readonly id: string }>(values: Value[], value: Value, maximum: number): Value[] {
  const index = values.findIndex((item) => item.id === value.id);
  if (index >= 0) values[index] = value;
  else values.push(value);
  return values.slice(-maximum);
}

/** Applies a bounded domain patch and validates the complete resulting state atomically. */
export function applyAgentStatePatch(currentState: AgentStateDto | null, patch: AgentStatePatchDto): AgentStateDto {
  if (!currentState) throw new TypeError('Agent state patch requires an existing state.');
  fields(patch, STATE_PATCH_FIELDS, 'Agent state patch');
  if (!Number.isSafeInteger(patch.baseVersion) || patch.baseVersion < 0) {
    throw new TypeError('Agent state patch base version is invalid.');
  }
  if (!Array.isArray(patch.operations) || patch.operations.length < 1 || patch.operations.length > MAX_PATCH_OPERATIONS) {
    throw new TypeError('Agent state patch operations are invalid.');
  }
  const candidate: MutableAgentState = {
    ...currentState,
    sessions: [...currentState.sessions],
    models: [...currentState.models],
    skills: [...currentState.skills],
    activeSession: currentState.activeSession ? {
      ...currentState.activeSession,
      messages: [...currentState.activeSession.messages],
      timeline: [...currentState.activeSession.timeline]
    } : null
  };
  for (const operation of patch.operations) {
    fields(operation, PATCH_OPERATION_FIELDS, 'Agent state patch operation');
    if (!setHas(PATCH_OPERATION_TYPES, operation.type)) throw new TypeError('Agent state patch operation type is invalid.');
    if (operation.type === 'state.merge') {
      mergeFields(candidate, operation.value, STATE_MERGE_FIELDS, 'Agent state merge');
      continue;
    }
    if (!candidate.activeSession) throw new TypeError('Agent session patch requires an active session.');
    if (operation.type === 'session.merge') {
      mergeFields(candidate.activeSession, operation.value, SESSION_MERGE_FIELDS, 'Agent session merge');
    } else if (operation.type === 'message.upsert') {
      candidate.activeSession.messages = upsertById(
        candidate.activeSession.messages,
        message(operation.value),
        MAX_MESSAGES
      );
    } else if (operation.type === 'timeline.upsert') {
      candidate.activeSession.timeline = upsertById(
        candidate.activeSession.timeline,
        timelineItem(operation.value),
        MAX_TIMELINE
      );
    }
  }
  return validateAgentState(candidate);
}

function observedPatchValue(value: object): Readonly<Record<string, unknown>> {
  return value as unknown as Readonly<Record<string, unknown>>;
}

function normalizeObservedAgentStatePatch(patch: AgentStatePatchDto): AgentObservedStatePatchDto {
  const cloned = cloneExtensionData({
    baseVersion: patch.baseVersion,
    operations: patch.operations
  });
  if (!isPlainObject(cloned) || !Array.isArray(cloned.operations)) {
    throw new TypeError('Agent state patch event is invalid.');
  }
  const operations: AgentObservedStatePatchOperationDto[] = cloned.operations.map((operation) => {
    const source = fields(operation, PATCH_OPERATION_FIELDS, 'Agent state patch operation');
    if (!setHas(PATCH_OPERATION_TYPES, source.type)) throw new TypeError('Agent state patch operation type is invalid.');
    if (source.type === 'message.upsert') {
      return freeze({ type: source.type, value: message(source.value) });
    }
    if (source.type === 'timeline.upsert') {
      return freeze({ type: source.type, value: timelineItem(source.value) });
    }
    if (source.type === 'state.merge') {
      const value = fields(source.value, STATE_MERGE_FIELDS, 'Agent state merge');
      return freeze({ type: source.type, value: observedPatchValue(value) });
    }
    const value = fields(source.value, SESSION_MERGE_FIELDS, 'Agent session merge');
    return freeze({ type: source.type, value: observedPatchValue(value) });
  });
  return freeze({ baseVersion: patch.baseVersion, operations });
}

export function createAgentCommandPayload(
  providerId: string,
  action: string,
  values?: AgentCommandValuesRegistrationDto
): AgentCommandPayloadDto;
export function createAgentCommandPayload(providerId: string, action: string, values: unknown = {}): AgentCommandPayloadDto {
  const payload: Mutable<AgentCommandPayloadDto> = {
    providerId: namespacedId(providerId, 'Agent provider id'),
    action: scopedId(action, 'Agent action', 48)
  };
  if (!isPlainObject(values)) throw new TypeError('Agent command values must be a plain object.');
  for (const key of Object.keys(values)) {
    if (!COMMAND_VALUE_FIELDS.has(key)) continue;
    if (key === 'skillIds') {
      payload.skillIds = Array.isArray(values.skillIds) ? values.skillIds.slice(0, MAX_SKILLS).map((id) => scopedId(id, 'Agent skill id')) : [];
    } else if (key === 'text') {
      payload.text = optionalText(values.text, 'Agent prompt', MAX_MESSAGE);
    } else if (key === 'mode') {
      payload.mode = setHas(MODES, values.mode) ? values.mode : 'chat';
    } else if (key === 'reasoningEffort') {
      payload.reasoningEffort = setHas(EFFORTS, values.reasoningEffort) ? values.reasoningEffort : 'medium';
    } else if (key === 'accessMode') {
      payload.accessMode = setHas(ACCESS_MODES, values.accessMode) ? values.accessMode : 'ask';
    } else if (key === 'approvalResult') {
      payload.approvalResult = normalizeApprovalResult(values.approvalResult);
    } else if (key === 'sessionId') {
      payload.sessionId = optionalText(values.sessionId, 'Agent command value', MAX_ID);
    } else if (key === 'modelRef') {
      payload.modelRef = optionalText(values.modelRef, 'Agent command value', MAX_ID);
    } else if (key === 'approvalId') {
      payload.approvalId = optionalText(values.approvalId, 'Agent command value', MAX_ID);
    }
  }
  return freeze(payload);
}

export class AgentStateStore implements AgentStateStoreContract {
  private readonly _records = new Map<string, AgentRecord>();
  private readonly _listeners = new Set<AgentStateChangeListener>();
  private readonly _onError: (event: AgentStateStoreErrorEvent) => void;
  private _disposed = false;

  constructor(options: AgentStateStoreOptions = {}) {
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
  }

  register(
    descriptor: AgentDescriptorRegistrationDto,
    options: AgentStateRegistrationOptions = {}
  ): AgentStateHandle {
    if (this._disposed) throw new Error('Agent state store has been disposed.');
    const normalized = validateAgentDescriptor(descriptor, options.owner);
    if (this._records.has(normalized.id)) throw new Error('Agent provider is already registered: ' + normalized.id);
    const record: AgentRecord = {
      id: normalized.id,
      owner: options.owner || 'core',
      descriptor: normalized,
      state: null,
      version: 0,
      active: true
    };
    this._records.set(record.id, record);
    this._emit('added', record);
    let active = true;
    return Object.freeze({
      id: record.id,
      setState: (state: AgentStateRegistrationDto): AgentVersionDto => {
        if (!active || !record.active || this._records.get(record.id) !== record) throw new Error('Agent provider has been disposed.');
        record.state = validateAgentState(state);
        record.version += 1;
        this._emit('state', record, null);
        return Object.freeze({ version: record.version });
      },
      updateState: (patch: AgentStatePatchDto): AgentStateUpdateResultDto => {
        if (!active || !record.active || this._records.get(record.id) !== record) throw new Error('Agent provider has been disposed.');
        if (!isPlainObject(patch) || !Number.isSafeInteger(patch.baseVersion) || patch.baseVersion < 0 ||
            !Array.isArray(patch.operations) || patch.operations.length < 1 || patch.operations.length > MAX_PATCH_OPERATIONS) {
          throw new TypeError('Agent state patch is invalid.');
        }
        if (patch.baseVersion !== record.version) {
          return Object.freeze({ applied: false, version: record.version });
        }
        const nextState = applyAgentStatePatch(record.state, patch);
        const observedPatch = normalizeObservedAgentStatePatch(patch);
        record.state = nextState;
        record.version += 1;
        this._emit('state', record, observedPatch);
        return Object.freeze({ applied: true, version: record.version });
      },
      clearState: (): AgentVersionDto => {
        if (!active || !record.active || this._records.get(record.id) !== record) return Object.freeze({ version: record.version });
        record.state = null;
        record.version += 1;
        this._emit('state', record, null);
        return Object.freeze({ version: record.version });
      },
      dispose: (): void => {
        if (!active) return;
        active = false;
        record.active = false;
        if (this._records.get(record.id) !== record) return;
        this._records.delete(record.id);
        this._emit('removed', record);
      }
    });
  }

  list(): AgentStateSnapshot[] {
    return Array.from(this._records.values()).sort((left, right) => left.descriptor.order - right.descriptor.order || left.id.localeCompare(right.id)).map((record) => this._snapshot(record));
  }

  get(id: string): AgentStateSnapshot | null {
    const record = this._records.get(id);
    return record ? this._snapshot(record) : null;
  }

  onDidChange(listener: AgentStateChangeListener): Disposable {
    if (this._disposed) throw new Error('Agent state store has been disposed.');
    if (typeof listener !== 'function') throw new TypeError('Agent state listener must be a function.');
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  }

  disposeOwner(owner: string): void {
    for (const record of Array.from(this._records.values())) {
      if (record.owner !== owner) continue;
      record.active = false;
      this._records.delete(record.id);
      this._emit('removed', record);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const record of Array.from(this._records.values())) {
      record.active = false;
      this._emit('removed', record);
    }
    this._records.clear();
    this._listeners.clear();
  }

  private _snapshot(record: AgentRecord): AgentStateSnapshot {
    return Object.freeze({ id: record.id, owner: record.owner, descriptor: record.descriptor, state: record.state, version: record.version });
  }

  private _event(
    type: AgentStateChangeType,
    record: AgentRecord,
    patch: AgentObservedStatePatchDto | null
  ): AgentStateChangeEvent {
    const snapshot = this._snapshot(record);
    if (type === 'state' && patch) {
      return Object.freeze({
        type,
        record: snapshot as AgentStateSnapshot<AgentStateDto>,
        patch
      });
    }
    if (type === 'state' && record.state) {
      return Object.freeze({
        type,
        record: snapshot as AgentStateSnapshot<AgentStateDto>,
        patch: null
      });
    }
    if (type === 'state') {
      return Object.freeze({
        type,
        record: snapshot as AgentStateSnapshot<null>,
        patch: null
      });
    }
    if (type === 'added') {
      return Object.freeze({
        type,
        record: snapshot as AgentStateSnapshot<null>,
        patch: null
      });
    }
    return Object.freeze({ type, record: snapshot, patch: null });
  }

  private _emit(
    type: AgentStateChangeType,
    record: AgentRecord,
    patch: AgentObservedStatePatchDto | null = null
  ): void {
    const event = this._event(type, record, patch);
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(event);
      } catch (error) {
        try { this._onError({ source: 'agent-state-listener', id: record.id, error }); } catch (_) {}
      }
    }
  }
}
