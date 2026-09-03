import { DisposableStore, toDisposable } from './disposable.js';
import { ContributionPoint } from './contribution-registry';
import { PLUGIN_API_VERSION, PluginPermission, validatePluginManifest } from './plugin-runtime.js';
import { createScmFileDecorationProvider } from './scm-file-decoration';
import { normalizeScmGitRequest } from './scm-git';
import { SourceControlStateStore, validateSourceControlDescriptor } from './source-control.js';
import { validateDocumentViewDescriptor } from './document-view.js';
import { validateAgentDescriptor } from './agent.js';
import {
  EXTENSION_PROTOCOL_VERSION,
  ExtensionErrorCode,
  ExtensionHostMethod,
  ExtensionMessageType,
  ExtensionSandboxMethod,
  assertExtensionOwnedId,
  cloneExtensionData,
  createExtensionError,
  deserializeExtensionError,
  isExtensionMessage,
  isExtensionRequestId,
  serializeExtensionError
} from './plugin-extension-protocol.js';
import { createSandboxedExtensionSandbox } from './plugin-extension-sandbox.js';
import type { AgentStateHandle } from '../../types/agent';
import type { Disposable } from '../../types/lifecycle';
import type {
  ExtensionData,
  ExtensionHostToSandboxPayloadDto,
  ExtensionRequestMessageDto,
  ExtensionResponseMessageDto,
  ExtensionSandboxMethodDto
} from '../../types/plugin-extension-protocol';
import type {
  PluginExtensionChangeEventDto,
  PluginExtensionDescriptorDto,
  PluginExtensionDescriptorRegistrationDto,
  PluginExtensionErrorSource,
  PluginExtensionHostContract,
  PluginExtensionHostRecord as HostRecord,
  PluginExtensionHostOptions,
  PluginExtensionLifecycleStatusDto,
  PluginExtensionLocalizationDto,
  PluginExtensionModelStreamRecord as HostModelStreamRecord,
  PluginExtensionObservedErrorEvent,
  PluginExtensionOperationResultDto,
  PluginExtensionResource as HostResource,
  PluginExtensionRefreshResultDto,
  PluginExtensionSnapshotDto,
  PluginExtensionDeferred as HostDeferred
} from '../../types/plugin-extension-host';
import type { PluginPermissionDto } from '../../types/plugin-runtime';
import type { ScmFileDecorationProvider } from '../../types/scm';
import type { SourceControlStateHandle } from '../../types/source-control';

const ACTIVATION_TIMEOUT_MS = 15_000;
const INVOCATION_TIMEOUT_MS = 10_000;
const DEACTIVATION_TIMEOUT_MS = 1_500;
const MAX_ENTRY_SOURCE_BYTES = 5 * 1024 * 1024;
const LOCALIZATION_TIMEOUT_MS = 5_000;
const LOCALIZATION_REFRESH_CONCURRENCY = 4;
const MAX_INCOMING_EXTENSION_REQUESTS = 32;
const MAX_PENDING_SANDBOX_REQUESTS = 32;
const MAX_PENDING_SANDBOX_DATA_REQUESTS = MAX_PENDING_SANDBOX_REQUESTS - 1;
const MAX_EXTENSION_HANDLES_PER_PLUGIN = 1024;
const MAX_ACTIVE_MODEL_STREAMS_PER_PLUGIN = 2;
const MAX_PENDING_MODEL_EVENTS = 2048;
const MAX_PENDING_MODEL_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_MODEL_EVENT_BYTES_PER_PLUGIN = 16 * 1024 * 1024;
const AGENT_REQUEST_CLONE_OPTIONS = Object.freeze({
  maxStringLength: 1024 * 1024,
  maxItems: 8192,
  maxBytes: 2 * 1024 * 1024
});
const AGENT_RESULT_CLONE_OPTIONS = Object.freeze({
  maxStringLength: 2 * 1024 * 1024,
  maxItems: 8192,
  maxBytes: 8 * 1024 * 1024
});
const MODEL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'response.started', 'content.delta', 'reasoning.delta', 'tool_call.delta',
  'usage', 'response.completed', 'response.error'
]);
const MODEL_EVENT_FIELDS: ReadonlySet<string> = new Set([
  'type', 'requestedReasoningEffort', 'effectiveReasoningEffort', 'delta',
  'index', 'id', 'name', 'argumentsDelta', 'usage', 'result', 'error'
]);

type PlainObject = Record<string, unknown>;
type ExtensionHandleKind =
  | 'command'
  | 'contribution'
  | 'source-control'
  | 'scm-decoration'
  | 'document-view'
  | 'agent';

interface CommandMetadata {
  readonly title: string;
  readonly category: string;
  readonly hint: string;
}

type Deferred<Value> = HostDeferred<Value>;
type ExtensionModelEventDelivery = NonNullable<HostModelStreamRecord['queue'][number]>;
type ExtensionModelStreamRecord = HostModelStreamRecord;
type ExtensionResource = HostResource;
type PluginExtensionRecord = HostRecord;

interface NormalizedAgentModelEvent {
  readonly pluginId: string;
  readonly revision: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly delivery: ExtensionModelEventDelivery;
}

// Debug configuration providers accept executable callbacks and remain
// unavailable to installed extensions. SCM file decorations use the dedicated
// static publisher below, so package code never provides a callback or DOM.
export const DeclarativeContributionPoint = Object.freeze({
  MENUS: ContributionPoint.MENUS,
  TASKS: ContributionPoint.TASKS,
  SETTINGS: ContributionPoint.SETTINGS,
  LANGUAGES: ContributionPoint.LANGUAGES,
  AI_TOOLS: ContributionPoint.AI_TOOLS,
  MCP_PROVIDERS: ContributionPoint.MCP_PROVIDERS,
  SKILL_PROVIDERS: ContributionPoint.SKILL_PROVIDERS
});

const DECLARATIVE_POINTS: ReadonlySet<string> = new Set(Object.values(DeclarativeContributionPoint));
const KNOWN_PERMISSIONS = new Set(Object.values(PluginPermission));

function createDeferred<Value = void>(): Deferred<Value> {
  let resolve!: Deferred<Value>['resolve'];
  let reject!: Deferred<Value>['reject'];
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, label + ' must be a non-empty string.');
  }
  return value.trim();
}

function boundedString(value: unknown, fallback: string, maxLength = 160): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength) || fallback;
}

function raceWithTimeout<Value>(
  promise: Value | PromiseLike<Value>,
  timeoutMs: number,
  message: string
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(createExtensionError(ExtensionErrorCode.TIMEOUT, message)), timeoutMs);
    })
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function stringPropertyForReport(value: unknown, key: string): string {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return '';
  try {
    const property = (value as PlainObject)[key];
    return typeof property === 'string' ? property : '';
  } catch (_) {
    return '';
  }
}

function hasErrorCode(error: unknown, code?: string): error is { readonly code: string } {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  try {
    const value = (error as { readonly code?: unknown }).code;
    return typeof value === 'string' && (code === undefined || value === code);
  } catch (_) {
    return false;
  }
}

function normalizeDescriptor(
  descriptor: unknown,
  onIdentity?: (id: string) => void
): PluginExtensionDescriptorDto {
  if (!descriptor || typeof descriptor !== 'object') {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor must be an object.');
  }
  const source = descriptor as PlainObject;
  const manifestSource = source.manifest;
  const manifest = validatePluginManifest(manifestSource);
  const descriptorId = source.id;
  if (typeof descriptorId === 'string') onIdentity?.(descriptorId);
  if (descriptorId !== manifest.id) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor id does not match its manifest.');
  }
  const grantedPermissionSource = source.grantedPermissions;
  const grantedPermissions = Array.isArray(grantedPermissionSource)
    ? [...new Set(grantedPermissionSource)]
    : [];
  for (const permission of grantedPermissions) {
    if (!KNOWN_PERMISSIONS.has(permission as PluginPermissionDto)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor includes an unknown permission.');
    }
    if (!manifest.permissions.includes(permission as PluginPermissionDto)) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'Extension was not granted an undeclared permission.');
    }
  }
  const revisionSource = source.revision;
  const revision = revisionSource === undefined ? manifest.version : revisionSource;
  if (typeof revision !== 'string' || !revision.trim() || revision.length > 160 || /[\0\r\n]/.test(revision)) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor revision is invalid.');
  }
  return Object.freeze({
    id: manifest.id,
    manifest,
    grantedPermissions: Object.freeze(grantedPermissions) as readonly PluginPermissionDto[],
    revision
  });
}

function sanitizeCommandMetadata(metadata: unknown, commandId: string): CommandMetadata {
  const value = cloneExtensionData(metadata || {}) as PlainObject;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Command metadata must be a plain object.');
  }
  return Object.freeze({
    title: boundedString(value.title, commandId),
    category: boundedString(value.category, 'Extensions'),
    hint: boundedString(value.hint || value.keybinding, '', 80)
  });
}

function defaultServiceSnapshot(id: string, service: unknown): unknown {
  if (id !== 'workbench.projectTasks') {
    throw createExtensionError(ExtensionErrorCode.DENIED, 'This service has no data-only extension snapshot.');
  }
  if (!service || typeof (service as PlainObject).list !== 'function' ||
      typeof (service as PlainObject).getSelected !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Project task snapshot service is unavailable.');
  }
  const snapshotService = service as { list(): unknown; getSelected(): unknown };
  return {
    tasks: snapshotService.list(),
    selected: snapshotService.getSelected()
  };
}

function samePermissions(
  left: readonly PluginPermissionDto[],
  right: readonly PluginPermissionDto[]
): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

function extensionInvalidRequest(error: unknown, fallbackMessage: string): Error {
  const message = error && typeof (error as { readonly message?: unknown }).message === 'string'
    ? (error as { readonly message: string }).message
    : '';
  return createExtensionError(
    ExtensionErrorCode.INVALID_REQUEST,
    message || fallbackMessage
  );
}

function normalizePluginLocale(value: unknown): PluginExtensionLocalizationDto['locale'] {
  return value === 'zh-CN' || value === 'ja' || value === 'en' ? value : 'en';
}

function normalizeLocalizationPayload(
  value: unknown,
  fallbackLocale: PluginExtensionLocalizationDto['locale']
): PluginExtensionLocalizationDto {
  const payload = cloneExtensionData(value) as PlainObject;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some((key) => key !== 'locale' && key !== 'messages')) {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Plugin localization broker returned an invalid response.');
  }
  if (!payload.messages || typeof payload.messages !== 'object' || Array.isArray(payload.messages)) {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Plugin localization messages are invalid.');
  }
  const entries = Object.entries(payload.messages as PlainObject);
  if (entries.length > 1024) {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Plugin localization messages exceed the host limit.');
  }
  const messages: Record<string, string> = Object.create(null);
  for (const [key, message] of entries) {
    if (!key || key.length > 160 || key.includes('\0') || typeof message !== 'string' || message.length > 8192) {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Plugin localization contains an invalid string.');
    }
    messages[key] = message;
  }
  return Object.freeze({
    locale: normalizePluginLocale(payload.locale || fallbackLocale),
    messages: Object.freeze(messages)
  });
}

function extensionDataByteSize(value: ExtensionData): number {
  if (value === undefined) return 1;
  if (value === null || typeof value === 'boolean') return 4;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return value.length * 2;
  if (Array.isArray(value)) {
    let bytes = value.length * 4;
    for (const key of Object.keys(value)) {
      const item = value[Number(key)];
      bytes += extensionDataByteSize(item);
    }
    return bytes;
  }
  let bytes = 0;
  for (const [key, item] of Object.entries(value)) {
    bytes += key.length * 2 + extensionDataByteSize(item);
  }
  return bytes;
}

function utf8ByteLength(value: string, maxBytes: number): number {
  let bytes = 0;
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && position + 1 < value.length) {
      const next = value.charCodeAt(position + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        position += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return bytes;
  }
  return bytes;
}

function normalizeAgentModelEventPayload(payload: unknown): NormalizedAgentModelEvent {
  const value = cloneExtensionData(payload, AGENT_RESULT_CLONE_OPTIONS) as PlainObject;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['pluginId', 'revision', 'requestId', 'sequence', 'event'].includes(key)) ||
      typeof value.pluginId !== 'string' || typeof value.revision !== 'string' ||
      typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value.requestId) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
      (value.sequence as number) > 1_000_000_000 ||
      !value.event || typeof value.event !== 'object' || Array.isArray(value.event) ||
      !MODEL_EVENT_TYPES.has((value.event as PlainObject).type as string)) {
    throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Streaming model event is invalid.');
  }
  const sourceEvent = value.event as PlainObject;
  if (Object.keys(sourceEvent).some((key) => !MODEL_EVENT_FIELDS.has(key))) {
    throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Streaming model event includes an unsupported field.');
  }
  if ((sourceEvent.type === 'content.delta' || sourceEvent.type === 'reasoning.delta') &&
      typeof sourceEvent.delta !== 'string') {
    throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Streaming model text delta is invalid.');
  }
  if (sourceEvent.type === 'tool_call.delta' &&
      (!Number.isSafeInteger(sourceEvent.index) || (sourceEvent.index as number) < 0 ||
       (sourceEvent.index as number) > 31 ||
       (sourceEvent.argumentsDelta !== undefined && typeof sourceEvent.argumentsDelta !== 'string'))) {
    throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Streaming model tool delta is invalid.');
  }
  const requestId = value.requestId as string;
  const sequence = value.sequence as number;
  const event = Object.freeze({ ...sourceEvent, requestId, sequence }) as ExtensionData;
  const args = Object.freeze({ requestId, sequence, event }) as ExtensionData;
  return Object.freeze({
    pluginId: value.pluginId as string,
    revision: value.revision as string,
    requestId,
    sequence,
    eventType: sourceEvent.type as string,
    delivery: {
      args,
      byteLength: extensionDataByteSize(args),
      accounted: false
    }
  });
}

export class PluginExtensionHost<PluginServices extends object = Record<string, unknown>>
implements PluginExtensionHostContract {
  declare private readonly _services: PluginExtensionHostOptions<PluginServices>['services'];
  declare private readonly _commands: PluginExtensionHostOptions<PluginServices>['commands'];
  declare private readonly _contributions: PluginExtensionHostOptions<PluginServices>['contributions'];
  declare private readonly _sourceControls: NonNullable<PluginExtensionHostOptions<PluginServices>['sourceControls']>;
  declare private readonly _ownsSourceControls: boolean;
  declare private readonly _agents: PluginExtensionHostOptions<PluginServices>['agents'];
  declare private readonly _loadEntry: PluginExtensionHostOptions<PluginServices>['loadEntry'];
  declare private readonly _listDescriptors: NonNullable<
    PluginExtensionHostOptions<PluginServices>['listDescriptors']
  > | null;
  declare private readonly _broker: NonNullable<PluginExtensionHostOptions<PluginServices>['broker']> | null;
  declare private readonly _loadLocalization: NonNullable<
    PluginExtensionHostOptions<PluginServices>['loadLocalization']
  >;
  declare private readonly _getLocale: NonNullable<PluginExtensionHostOptions<PluginServices>['getLocale']>;
  declare private readonly _sandboxFactory: NonNullable<
    PluginExtensionHostOptions<PluginServices>['sandboxFactory']
  >;
  declare private readonly _getCommandPalette: NonNullable<
    PluginExtensionHostOptions<PluginServices>['getCommandPalette']
  >;
  declare private readonly _serviceSnapshots: NonNullable<
    PluginExtensionHostOptions<PluginServices>['serviceSnapshots']
  >;
  declare private readonly _localize: NonNullable<PluginExtensionHostOptions<PluginServices>['localize']>;
  declare private readonly _onError: (event: PluginExtensionObservedErrorEvent) => void;
  declare private readonly _activationTimeoutMs: number;
  declare private readonly _invocationTimeoutMs: number;
  declare private readonly _deactivationTimeoutMs: number;
  declare private readonly _records: Map<string, PluginExtensionRecord>;
  declare private readonly _listeners: Set<(event: PluginExtensionChangeEventDto) => void>;
  declare private _disposed: boolean;
  declare private _disposePromise: Promise<void> | null;
  declare private _localeSubscription: Disposable | null;
  declare private _localizationRefreshPromise: Promise<void> | null;
  declare private _localizationRefreshRequested: boolean;
  declare private _localizationRefreshGeneration: number;

  constructor(options: PluginExtensionHostOptions<PluginServices>);
  constructor(options: PluginExtensionHostOptions<PluginServices> = {} as PluginExtensionHostOptions<PluginServices>) {
    if (!options.services || !options.commands || !options.contributions) {
      throw new TypeError('PluginExtensionHost requires service, command, and contribution registries.');
    }
    if (typeof options.loadEntry !== 'function') {
      throw new TypeError('PluginExtensionHost requires a loadEntry(id) broker.');
    }
    this._services = options.services;
    this._commands = options.commands;
    this._contributions = options.contributions;
    this._sourceControls = options.sourceControls || new SourceControlStateStore({ onError: options.onError });
    this._ownsSourceControls = !options.sourceControls;
    this._agents = options.agents;
    this._loadEntry = options.loadEntry;
    this._listDescriptors = typeof options.listDescriptors === 'function' ? options.listDescriptors : null;
    this._broker = typeof options.broker === 'function' ? options.broker : null;
    this._loadLocalization = typeof options.loadLocalization === 'function'
      ? options.loadLocalization
      : async (_id, locale) => ({ locale: normalizePluginLocale(locale), messages: {} });
    this._getLocale = typeof options.getLocale === 'function' ? options.getLocale : () => 'en';
    this._sandboxFactory = typeof options.sandboxFactory === 'function'
      ? options.sandboxFactory
      : (sandboxOptions) => createSandboxedExtensionSandbox(sandboxOptions);
    this._getCommandPalette = typeof options.getCommandPalette === 'function'
      ? options.getCommandPalette
      : () => null;
    this._serviceSnapshots = options.serviceSnapshots && typeof options.serviceSnapshots === 'object'
      ? options.serviceSnapshots
      : Object.create(null);
    this._localize = typeof options.localize === 'function' ? options.localize : (key) => key;
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._activationTimeoutMs = typeof options.activationTimeoutMs === 'number' &&
        Number.isFinite(options.activationTimeoutMs)
      ? options.activationTimeoutMs
      : ACTIVATION_TIMEOUT_MS;
    this._invocationTimeoutMs = typeof options.invocationTimeoutMs === 'number' &&
        Number.isFinite(options.invocationTimeoutMs)
      ? options.invocationTimeoutMs
      : INVOCATION_TIMEOUT_MS;
    this._deactivationTimeoutMs = typeof options.deactivationTimeoutMs === 'number' &&
        Number.isFinite(options.deactivationTimeoutMs)
      ? options.deactivationTimeoutMs
      : DEACTIVATION_TIMEOUT_MS;
    this._records = new Map<string, PluginExtensionRecord>();
    this._listeners = new Set<(event: PluginExtensionChangeEventDto) => void>();
    this._disposed = false;
    this._disposePromise = null;
    this._localeSubscription = null;
    this._localizationRefreshPromise = null;
    this._localizationRefreshRequested = false;
    this._localizationRefreshGeneration = 0;
    if (typeof options.onLocaleChange === 'function') {
      const subscription = options.onLocaleChange(() => { void this._refreshPluginLocalizations(); });
      if (typeof subscription === 'function') this._localeSubscription = { dispose: subscription };
      else if (subscription && typeof subscription.dispose === 'function') this._localeSubscription = subscription;
    }
  }

  onDidChange(listener: (event: PluginExtensionChangeEventDto) => void): Disposable {
    if (typeof listener !== 'function') throw new TypeError('Extension status listener must be a function.');
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  }

  handleAgentModelEvent(payload: unknown): boolean {
    let normalized: NormalizedAgentModelEvent;
    try {
      normalized = normalizeAgentModelEventPayload(payload);
    } catch (error) {
      this._report('agent-model-event', stringPropertyForReport(payload, 'pluginId'), error);
      return false;
    }
    const record = this._records.get(normalized.pluginId);
    if (!record || record.cleaned || record.cancelled || record.status !== 'active' ||
        record.descriptor.revision !== normalized.revision) return false;
    const stream = record.modelStreams.get(normalized.requestId);
    if (!stream || stream.terminal || normalized.sequence <= stream.lastSequence ||
        (stream.lastSequence === 0 && normalized.eventType !== 'response.started')) return false;
    const delivery = normalized.delivery;
    const queuedCount = stream.queue.length - stream.head;
    if (queuedCount >= MAX_PENDING_MODEL_EVENTS ||
        stream.queuedBytes + delivery.byteLength > MAX_PENDING_MODEL_EVENT_BYTES ||
        record.pendingModelEventBytes + delivery.byteLength > MAX_PENDING_MODEL_EVENT_BYTES_PER_PLUGIN) {
      const error = createExtensionError(
        ExtensionErrorCode.UNAVAILABLE,
        'Streaming model event backlog exceeded the host limit.'
      );
      this._abortModelStream(record, normalized.requestId, stream, error, true);
      this._report('agent-model-event', normalized.pluginId, error);
      return false;
    }
    stream.lastSequence = normalized.sequence;
    stream.terminal = normalized.eventType === 'response.completed' ||
      normalized.eventType === 'response.error';
    delivery.accounted = true;
    stream.queue.push(delivery);
    stream.queuedBytes += delivery.byteLength;
    record.pendingModelEventBytes += delivery.byteLength;
    this._pumpModelStream(record, normalized.requestId, stream);
    return true;
  }

  private _pumpModelStream(
    record: PluginExtensionRecord,
    requestId: string,
    stream: ExtensionModelStreamRecord
  ): void {
    if (stream.delivering || stream.deliveryError) return;
    stream.delivering = true;
    const pump = async (): Promise<void> => {
      while (!record.cleaned && !stream.deliveryError && stream.head < stream.queue.length) {
        const delivery = stream.queue[stream.head];
        if (!delivery) break;
        try {
          await this._callSandbox(
            record,
            ExtensionSandboxMethod.AGENT_MODEL_EVENT,
            delivery.args,
            this._invocationTimeoutMs
          );
        } catch (error) {
          if (!stream.deliveryError) {
            this._report('agent-model-event', record.descriptor.id, error);
            this._abortModelStream(record, requestId, stream, error, true);
          }
        } finally {
          this._releaseModelEvent(record, stream, delivery);
          if (stream.queue[stream.head] === delivery) {
            stream.queue[stream.head] = undefined;
            stream.head += 1;
          }
        }
      }
      stream.delivering = false;
      if (stream.head > 64 && stream.head * 2 >= stream.queue.length) {
        stream.queue = stream.queue.slice(stream.head);
        stream.head = 0;
      }
      if (stream.terminal && stream.head >= stream.queue.length) {
        stream.terminalDelivery.resolve();
        if (stream.settled && record.modelStreams.get(requestId) === stream) {
          record.modelStreams.delete(requestId);
        }
      } else if (!stream.deliveryError && stream.head < stream.queue.length) {
        this._pumpModelStream(record, requestId, stream);
      }
    };
    void pump();
  }

  private _releaseModelEvent(
    record: PluginExtensionRecord,
    stream: ExtensionModelStreamRecord,
    delivery: ExtensionModelEventDelivery
  ): void {
    if (!delivery.accounted) return;
    delivery.accounted = false;
    stream.queuedBytes = Math.max(0, stream.queuedBytes - delivery.byteLength);
    record.pendingModelEventBytes = Math.max(
      0,
      record.pendingModelEventBytes - delivery.byteLength
    );
  }

  private _abortModelStream(
    record: PluginExtensionRecord,
    requestId: string,
    stream: ExtensionModelStreamRecord,
    error: unknown,
    cancelBroker: boolean
  ): void {
    if (!stream.deliveryError) stream.deliveryError = error;
    stream.terminal = true;
    if (record.modelStreams.get(requestId) === stream) record.modelStreams.delete(requestId);
    for (let index = stream.head; index < stream.queue.length; index += 1) {
      const delivery = stream.queue[index];
      if (delivery) this._releaseModelEvent(record, stream, delivery);
    }
    stream.queue = [];
    stream.head = 0;
    stream.terminalDelivery.resolve();
    if (cancelBroker && !stream.cancelRequested && this._broker) {
      stream.cancelRequested = true;
      void Promise.resolve()
        .then(() => this._broker!(record.descriptor.id, 'models.cancel', { requestId }))
        .catch(() => {});
    }
  }

  private _requireHandleCapacity(record: PluginExtensionRecord): void {
    if (record.handles.size >= MAX_EXTENSION_HANDLES_PER_PLUGIN) {
      throw createExtensionError(
        ExtensionErrorCode.UNAVAILABLE,
        'Extension resource handle limit reached.'
      );
    }
  }

  list(): readonly PluginExtensionSnapshotDto[] {
    return Array.from(this._records.values(), (record) => Object.freeze({
      id: record.descriptor.id,
      version: record.descriptor.manifest.version,
      displayName: record.descriptor.manifest.displayName,
      status: record.status,
      grantedPermissions: record.descriptor.grantedPermissions
    }));
  }

  async start(): Promise<PluginExtensionRefreshResultDto> {
    return this.refresh();
  }

  async refresh(
    descriptors?: readonly PluginExtensionDescriptorRegistrationDto[]
  ): Promise<PluginExtensionRefreshResultDto> {
    if (this._disposed) return { ok: false, error: createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension host is disposed.') };
    let next: unknown;
    try {
      next = descriptors === undefined
        ? await this._requireDescriptorBroker()()
        : descriptors;
      if (!Array.isArray(next)) throw new TypeError('Extension descriptor broker must return an array.');
    } catch (error) {
      this._report('extension-refresh', '', error);
      return { ok: false, error };
    }

    const normalized = new Map<string, PluginExtensionDescriptorDto>();
    const failures: Array<{ id: string; error: unknown }> = [];
    for (const descriptor of next) {
      let reportId = '';
      try {
        const value = normalizeDescriptor(descriptor, (id) => { reportId = id; });
        if (normalized.has(value.id)) throw new Error('Duplicate extension descriptor: ' + value.id);
        normalized.set(value.id, value);
      } catch (error) {
        failures.push({ id: reportId, error });
        this._report('extension-descriptor', reportId, error);
      }
    }

    const deactivated: string[] = [];
    for (const record of Array.from(this._records.values())) {
      const replacement = normalized.get(record.descriptor.id);
      if (!replacement || replacement.revision !== record.descriptor.revision ||
          !samePermissions(replacement.grantedPermissions, record.descriptor.grantedPermissions)) {
        await this.deactivate(record.descriptor.id);
        deactivated.push(record.descriptor.id);
      }
    }

    const activated: string[] = [];
    for (const descriptor of normalized.values()) {
      if (this._records.has(descriptor.id)) continue;
      const result = await this.activate(descriptor);
      if (result.ok) activated.push(descriptor.id);
      else failures.push({ id: descriptor.id, error: result.error });
    }
    return { ok: failures.length === 0, activated, deactivated, failures };
  }

  activate(
    descriptor: PluginExtensionDescriptorRegistrationDto
  ): Promise<PluginExtensionOperationResultDto>;
  activate(descriptor: unknown): Promise<PluginExtensionOperationResultDto> {
    if (this._disposed) {
      return Promise.resolve({ ok: false, error: createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension host is disposed.') });
    }
    let normalized: PluginExtensionDescriptorDto;
    let reportId = '';
    try {
      normalized = normalizeDescriptor(descriptor, (id) => { reportId = id; });
      if (!normalized || !normalized.manifest || normalized.id !== normalized.manifest.id) {
        throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor is invalid.');
      }
    } catch (error) {
      this._report('extension-validate', reportId, error);
      return Promise.resolve({ ok: false, error });
    }
    const existing = this._records.get(normalized.id);
    if (existing) {
      return existing.activationPromise || Promise.resolve<PluginExtensionOperationResultDto>(
        existing.status === 'active'
          ? { ok: true, id: normalized.id }
          : {
              ok: false,
              error: createExtensionError(
                ExtensionErrorCode.UNAVAILABLE,
                'Extension activation is unavailable: ' + normalized.id
              )
            }
      );
    }

    const cancellation = createDeferred<void>();
    const activation = createDeferred<PluginExtensionOperationResultDto>();
    const record: PluginExtensionRecord = {
      descriptor: normalized,
      status: 'activating',
      subscriptions: new DisposableStore({ onError: (event) => this._report('extension-dispose', normalized.id, event.error) }),
      sandbox: null,
      pending: new Map(),
      incomingRequests: new Set(),
      handles: new Map(),
      ready: createDeferred<void>(),
      activationSettled: false,
      cancellation,
      cancelled: false,
      cleaned: false,
      activationPromise: activation.promise,
      deactivationPromise: null,
      nextRequestId: 0,
      modelStreams: new Map(),
      pendingModelEventBytes: 0,
      localization: null,
      localizationRevision: 0
    };
    this._records.set(normalized.id, record);
    this._emit(record);
    void this._activateRecord(record).then(activation.resolve, activation.reject);
    return activation.promise;
  }

  deactivate(id: string): Promise<PluginExtensionOperationResultDto> {
    const record = this._records.get(id);
    if (!record) return Promise.resolve({ ok: false, error: createExtensionError(ExtensionErrorCode.NOT_FOUND, 'Extension is not active: ' + id) });
    if (record.deactivationPromise) return record.deactivationPromise;
    const deactivation = createDeferred<PluginExtensionOperationResultDto>();
    record.deactivationPromise = deactivation.promise;
    record.cancelled = true;
    record.status = 'deactivating';
    record.cancellation.resolve();
    this._emit(record);
    const work = (async (): Promise<PluginExtensionOperationResultDto> => {
      let result: PluginExtensionOperationResultDto = { ok: true, id };
      try {
        if (record.sandbox && record.status === 'deactivating') {
          await raceWithTimeout(
            this._callSandbox(record, ExtensionSandboxMethod.DEACTIVATE, null, this._deactivationTimeoutMs),
            this._deactivationTimeoutMs,
            'Extension deactivation timed out.'
          );
        }
      } catch (error) {
        // A hung or hostile extension cannot keep the workbench alive. Cleanup
        // continues and the failure remains attributed to this extension.
        result = { ok: false, error };
        this._report('extension-deactivate', id, error);
      } finally {
        this._cleanupRecord(record);
      }
      return result;
    })();
    void work.then(deactivation.resolve, deactivation.reject);
    return deactivation.promise;
  }

  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    const disposal = createDeferred<void>();
    this._disposePromise = disposal.promise;
    this._disposed = true;
    const work = (async (): Promise<void> => {
      for (const record of Array.from(this._records.values()).reverse()) {
        await this.deactivate(record.descriptor.id);
      }
      if (this._localeSubscription) {
        try { this._localeSubscription.dispose(); } catch (error) { this._report('extension-i18n', '', error); }
        this._localeSubscription = null;
      }
      if (this._ownsSourceControls) this._sourceControls.dispose();
      this._listeners.clear();
    })();
    void work.then(disposal.resolve, disposal.reject);
    return disposal.promise;
  }

  private async _activateRecord(
    record: PluginExtensionRecord
  ): Promise<PluginExtensionOperationResultDto> {
    const id = record.descriptor.id;
    try {
      const loaded = await this._raceCancellation(record, this._loadEntry(id));
      const source = this._validateSource(id, loaded);
      const localization = await this._raceCancellation(record, this._loadPluginLocalization(record));
      if (record.cancelled || this._disposed) throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension activation was cancelled.');
      const sandbox = this._sandboxFactory({
        onMessage: (message) => this._handleSandboxMessage(record, message),
        onFatal: (error) => this._handleSandboxFatal(record, error)
      });
      if (!sandbox || typeof sandbox.postMessage !== 'function' || !sandbox.ready || typeof sandbox.dispose !== 'function') {
        throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension sandbox factory returned an invalid sandbox.');
      }
      record.sandbox = sandbox;
      await this._raceCancellation(record, sandbox.ready);
      this._post(record, {
        type: ExtensionMessageType.INITIALIZE,
        extension: { id, version: record.descriptor.manifest.version },
        apiVersion: PLUGIN_API_VERSION,
        source,
        localization
      });
      await this._raceCancellation(record, raceWithTimeout(
        record.ready.promise,
        this._activationTimeoutMs,
        'Extension activation timed out.'
      ));
      if (record.cancelled || this._disposed) throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension activation was cancelled.');
      record.status = 'active';
      this._emit(record);
      try {
        if (record.localization?.locale !== normalizePluginLocale(this._getLocale())) {
          void this._refreshPluginLocalizations();
        }
      } catch (error) {
        this._report('extension-i18n', id, error);
      }
      return { ok: true, id };
    } catch (error) {
      if (record.cancelled || this._disposed || hasErrorCode(error, ExtensionErrorCode.CANCELLED)) {
        // Once deactivation starts it owns sandbox shutdown and pending RPC
        // cleanup. Activation cancellation must not reject the deactivation
        // request that is currently waiting for the Worker to acknowledge it.
        if (!record.deactivationPromise) this._cleanupRecord(record);
        return { ok: false, error: createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension activation was cancelled: ' + id) };
      }
      this._cleanupRecord(record);
      this._report('extension-activate', id, error);
      return { ok: false, error };
    }
  }

  private _validateSource(id: string, loaded: unknown): string {
    if (!loaded || typeof loaded !== 'object') {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension source broker returned an invalid response.');
    }
    let loadedId: unknown;
    let source: unknown;
    try {
      loadedId = (loaded as PlainObject).id;
      source = (loaded as PlainObject).source;
    } catch (_) {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension source broker returned an invalid response.');
    }
    if (loadedId !== id || typeof source !== 'string') {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension source broker returned an invalid response.');
    }
    if (source.length === 0 || utf8ByteLength(source, MAX_ENTRY_SOURCE_BYTES) > MAX_ENTRY_SOURCE_BYTES) {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension entry source is unavailable or exceeds the 5 MiB limit.');
    }
    return source;
  }

  private async _loadPluginLocalization(
    record: PluginExtensionRecord,
    locale = normalizePluginLocale(this._getLocale())
  ): Promise<PluginExtensionLocalizationDto> {
    const value = await raceWithTimeout(
      this._loadLocalization(record.descriptor.id, locale),
      LOCALIZATION_TIMEOUT_MS,
      'Plugin localization loading timed out.'
    );
    const localization = normalizeLocalizationPayload(value, locale);
    record.localization = localization;
    return localization;
  }

  private _refreshPluginLocalizations(): Promise<void> {
    if (this._disposed) return Promise.resolve();
    this._localizationRefreshRequested = true;
    this._localizationRefreshGeneration += 1;
    if (this._localizationRefreshPromise) return this._localizationRefreshPromise;
    const refresh = async (): Promise<void> => {
      while (this._localizationRefreshRequested && !this._disposed) {
        this._localizationRefreshRequested = false;
        const generation = this._localizationRefreshGeneration;
        await this._refreshPluginLocalizationBatch(generation);
      }
    };
    const refreshOperation = createDeferred<void>();
    const operation = refreshOperation.promise;
    this._localizationRefreshPromise = operation;
    const work = refresh().catch((error) => {
      this._report('extension-i18n', '', error);
    }).finally(() => {
      if (this._localizationRefreshPromise === operation) {
        this._localizationRefreshPromise = null;
        if (this._localizationRefreshRequested && !this._disposed) {
          void this._refreshPluginLocalizations();
        }
      }
    });
    void work.then(refreshOperation.resolve, refreshOperation.reject);
    return operation;
  }

  private async _refreshPluginLocalizationBatch(generation: number): Promise<void> {
    let locale: PluginExtensionLocalizationDto['locale'];
    try {
      locale = normalizePluginLocale(this._getLocale());
    } catch (error) {
      this._report('extension-i18n', '', error);
      return;
    }
    const records = Array.from(this._records.values()).filter((record) => (
      !record.cleaned && !record.cancelled && record.status === 'active'
    ));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < records.length) {
        const record = records[cursor++];
        if (!record) continue;
        record.localizationRevision = generation;
        try {
          const value = await raceWithTimeout(
            this._loadLocalization(record.descriptor.id, locale),
            LOCALIZATION_TIMEOUT_MS,
            'Plugin localization loading timed out.'
          );
          const localization = normalizeLocalizationPayload(value, locale);
          if (record.cleaned || record.cancelled || record.status !== 'active' ||
              record.localizationRevision !== generation ||
              this._localizationRefreshGeneration !== generation || this._disposed) continue;
          record.localization = localization;
          await this._callSandbox(
            record,
            ExtensionSandboxMethod.I18N_CHANGED,
            localization,
            this._invocationTimeoutMs
          );
        } catch (error) {
          if (!record.cleaned && !record.cancelled &&
              record.localizationRevision === generation &&
              this._localizationRefreshGeneration === generation) {
            this._report('extension-i18n', record.descriptor.id, error);
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(LOCALIZATION_REFRESH_CONCURRENCY, records.length) },
        () => worker()
      )
    );
  }

  private _raceCancellation<Value>(
    record: PluginExtensionRecord,
    promise: Value | PromiseLike<Value>
  ): Promise<Value> {
    return Promise.race([
      Promise.resolve(promise),
      record.cancellation.promise.then(() => {
        throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension operation was cancelled.');
      })
    ]);
  }

  private _assertRecordCurrent(record: PluginExtensionRecord): void {
    if (this._disposed || record.cancelled || record.cleaned ||
        this._records.get(record.descriptor.id) !== record) {
      throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension operation was cancelled.');
    }
  }

  private async _awaitRecord<Value>(
    record: PluginExtensionRecord,
    promise: Value | PromiseLike<Value>
  ): Promise<Value> {
    const value = await this._raceCancellation(record, promise);
    this._assertRecordCurrent(record);
    return value;
  }

  private _requireDescriptorBroker(): NonNullable<
    PluginExtensionHostOptions<PluginServices>['listDescriptors']
  > {
    if (!this._listDescriptors) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension descriptor broker is unavailable.');
    return this._listDescriptors;
  }

  private _handleSandboxMessage(record: PluginExtensionRecord, message: unknown): void {
    if (record.cleaned) return;
    if (!isExtensionMessage(message)) {
      this._report('extension-protocol', record.descriptor.id, createExtensionError(ExtensionErrorCode.PROTOCOL, 'Malformed extension message was ignored.'));
      return;
    }
    if (message.type === ExtensionMessageType.ACTIVATED) {
      if (record.cancelled) return;
      if (record.status !== 'activating' || record.activationSettled) {
        this._handleSandboxFatal(record, createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension activation completed out of sequence.'));
        return;
      }
      record.activationSettled = true;
      record.ready.resolve();
      return;
    }
    if (message.type === ExtensionMessageType.ACTIVATION_FAILED) {
      if (record.cancelled) return;
      if (record.status !== 'activating' || record.activationSettled) {
        this._handleSandboxFatal(record, createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension activation failed out of sequence.'));
        return;
      }
      record.activationSettled = true;
      record.ready.reject(deserializeExtensionError(message.error, ExtensionErrorCode.UNAVAILABLE));
      return;
    }
    if (message.type === ExtensionMessageType.RESPONSE) {
      this._resolveSandboxRequest(record, message);
      return;
    }
    if (message.type === ExtensionMessageType.REQUEST) {
      void this._handleExtensionRequest(record, message);
      return;
    }
    if (message.type === ExtensionMessageType.FATAL) {
      this._handleSandboxFatal(record, deserializeExtensionError(message.error, ExtensionErrorCode.PROTOCOL));
      return;
    }
    this._report('extension-protocol', record.descriptor.id, createExtensionError(ExtensionErrorCode.PROTOCOL, 'Unsupported extension message was ignored.'));
  }

  private async _handleExtensionRequest(
    record: PluginExtensionRecord,
    message: ExtensionRequestMessageDto
  ): Promise<void> {
    if (!isExtensionRequestId(message.id) || typeof message.method !== 'string') {
      const error = createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension request is malformed.');
      this._report('extension-protocol', record.descriptor.id, error);
      this._respond(record, message.id, false, null, error);
      return;
    }
    if (record.incomingRequests.has(message.id)) {
      const error = createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension reused an active request id.');
      this._report('extension-protocol', record.descriptor.id, error);
      this._handleSandboxFatal(record, error);
      return;
    }
    if (record.incomingRequests.size >= MAX_INCOMING_EXTENSION_REQUESTS) {
      const error = createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension request concurrency limit reached.');
      this._respond(record, message.id, false, null, error);
      return;
    }
    record.incomingRequests.add(message.id);
    try {
      const value = await this._dispatchExtensionRequest(record, message.method, message.args);
      const cloneOptions = message.method === ExtensionHostMethod.AGENT_BROKER_REQUEST
        ? AGENT_RESULT_CLONE_OPTIONS
        : undefined;
      this._respond(record, message.id, true, cloneExtensionData(value, cloneOptions), null);
    } catch (error) {
      this._respond(record, message.id, false, null, error);
    } finally {
      record.incomingRequests.delete(message.id);
    }
  }

  private async _dispatchExtensionRequest(
    record: PluginExtensionRecord,
    method: string,
    args: unknown
  ): Promise<unknown> {
    this._assertRecordCurrent(record);
    switch (method) {
      case ExtensionHostMethod.COMMAND_REGISTER:
        return this._registerCommand(record, args);
      case ExtensionHostMethod.COMMAND_DISPOSE:
        return this._disposeHandle(record, args, 'command');
      case ExtensionHostMethod.COMMAND_EXECUTE:
        return this._executeCommand(record, args);
      case ExtensionHostMethod.CONTRIBUTION_REGISTER:
        return this._registerContribution(record, args);
      case ExtensionHostMethod.CONTRIBUTION_DISPOSE:
        return this._disposeHandle(record, args, 'contribution');
      case ExtensionHostMethod.SOURCE_CONTROL_REGISTER:
        return this._registerSourceControl(record, args);
      case ExtensionHostMethod.SOURCE_CONTROL_SET_STATE:
        return this._setSourceControlState(record, args);
      case ExtensionHostMethod.SOURCE_CONTROL_CLEAR_STATE:
        return this._clearSourceControlState(record, args);
      case ExtensionHostMethod.SOURCE_CONTROL_DISPOSE:
        return this._disposeHandle(record, args, 'source-control');
      case ExtensionHostMethod.FILE_DECORATIONS_SCM_REGISTER:
        return this._registerScmFileDecorations(record, args);
      case ExtensionHostMethod.FILE_DECORATIONS_SCM_SET:
        return this._setScmFileDecorations(record, args);
      case ExtensionHostMethod.FILE_DECORATIONS_SCM_CLEAR:
        return this._clearScmFileDecorations(record, args);
      case ExtensionHostMethod.FILE_DECORATIONS_SCM_DISPOSE:
        return this._disposeHandle(record, args, 'scm-decoration');
      case ExtensionHostMethod.DOCUMENT_VIEW_REGISTER:
        return this._registerDocumentView(record, args);
      case ExtensionHostMethod.DOCUMENT_VIEW_DISPOSE:
        return this._disposeHandle(record, args, 'document-view');
      case ExtensionHostMethod.AGENT_REGISTER:
        return this._registerAgent(record, args);
      case ExtensionHostMethod.AGENT_SET_STATE:
        return this._setAgentState(record, args);
      case ExtensionHostMethod.AGENT_UPDATE_STATE:
        return this._updateAgentState(record, args);
      case ExtensionHostMethod.AGENT_CLEAR_STATE:
        return this._clearAgentState(record, args);
      case ExtensionHostMethod.AGENT_DISPOSE:
        return this._disposeHandle(record, args, 'agent');
      case ExtensionHostMethod.AGENT_BROKER_REQUEST:
        return this._requestAgentBroker(record, args);
      case ExtensionHostMethod.SCM_GIT_REQUEST:
        return this._requestScmGit(record, args);
      case ExtensionHostMethod.SERVICE_GET:
        return this._readService(record, args);
      case ExtensionHostMethod.BROKER_REQUEST:
        return this._brokerRequest(record, args);
      default:
        throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Unsupported extension host method.');
    }
  }

  private async _registerCommand(
    record: PluginExtensionRecord,
    args: unknown
  ): Promise<{ readonly handle: string }> {
    this._requirePermission(record, PluginPermission.COMMANDS_REGISTER);
    const value = cloneExtensionData(args || {}) as PlainObject;
    const commandId = assertExtensionOwnedId(record.descriptor.id, asNonEmptyString(value.id, 'Command'), 'Command');
    const handlerId = asNonEmptyString(value.handlerId, 'Command handler');
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(handlerId)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Command handler id is invalid.');
    }
    await this._authorize(record, ExtensionHostMethod.COMMAND_REGISTER, {
      id: commandId,
      handlerId
    }, PluginPermission.COMMANDS_REGISTER);
    const metadata = sanitizeCommandMetadata(value.metadata, commandId);
    this._requireHandleCapacity(record);
    const handle = 'command-' + (++record.nextRequestId);
    const commandDisposable = this._commands.registerDynamic(commandId, (...commandArgs: unknown[]) => (
      this._callSandbox(record, ExtensionSandboxMethod.COMMAND_INVOKE, {
        handlerId,
        args: cloneExtensionData(commandArgs)
      }, this._invocationTimeoutMs)
    ), {
      owner: record.descriptor.id,
      title: metadata.title,
      category: metadata.category
    });
    let paletteDisposable: Disposable | null = null;
    try {
      paletteDisposable = this._registerPaletteCommand(record, commandId, metadata);
    } catch (error) {
      commandDisposable.dispose();
      throw error;
    }
    let resource!: Disposable;
    resource = toDisposable(() => {
      record.handles.delete(handle);
      record.subscriptions.delete(resource);
      if (paletteDisposable) paletteDisposable.dispose();
      commandDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'command', disposable: resource });
    record.subscriptions.add(resource);
    return { handle };
  }

  private _registerPaletteCommand(
    record: PluginExtensionRecord,
    commandId: string,
    metadata: CommandMetadata
  ): Disposable | null {
    const palette = this._getCommandPalette();
    if (!palette || typeof palette.register !== 'function' || palette.supportsDisposables !== true) return null;
    const disposable = palette.register(
      commandId,
      metadata.title,
      metadata.hint,
      metadata.category,
      () => this._commands.executeDynamicIsolated(commandId).then((result) => {
        if (!result.ok) this._report('extension-command', record.descriptor.id, result.error);
      })
    );
    if (disposable && typeof disposable.dispose === 'function') return disposable;
    // A compatible palette should return a disposer. Fall back to its explicit
    // unregister method only when available; otherwise do not retain a stale
    // command on later deactivation.
    if (typeof palette.unregister === 'function') {
      return toDisposable(() => { palette.unregister?.(commandId); });
    }
    this._report('extension-command-palette', record.descriptor.id,
      createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Command palette does not support disposable registrations.'));
    return null;
  }

  private async _executeCommand(record: PluginExtensionRecord, args: unknown): Promise<unknown> {
    this._requirePermission(record, PluginPermission.COMMANDS_EXECUTE);
    const value = cloneExtensionData(args || {}) as PlainObject;
    const id = asNonEmptyString(value.id, 'Command');
    const commandArgs = Array.isArray(value.args) ? value.args : [];
    await this._authorize(record, ExtensionHostMethod.COMMAND_EXECUTE, { id }, PluginPermission.COMMANDS_EXECUTE);
    this._assertRecordCurrent(record);
    return this._commands.executeDynamic(id, ...commandArgs);
  }

  private async _registerContribution(
    record: PluginExtensionRecord,
    args: unknown
  ): Promise<{ readonly handle: string }> {
    this._requirePermission(record, PluginPermission.CONTRIBUTIONS_REGISTER);
    const value = cloneExtensionData(args || {}) as PlainObject;
    const point = asNonEmptyString(value.point, 'Contribution point');
    if (!DECLARATIVE_POINTS.has(point)) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'This contribution point does not accept installed extension code.');
    }
    const contribution = cloneExtensionData(value.contribution);
    if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension contribution must be a plain object.');
    }
    const options = cloneExtensionData(value.options || {}) as PlainObject;
    const contributionId = assertExtensionOwnedId(
      record.descriptor.id,
      asNonEmptyString(options.id || contribution.id, 'Contribution'),
      'Contribution'
    );
    await this._authorize(record, ExtensionHostMethod.CONTRIBUTION_REGISTER, {
      id: contributionId,
      point
    }, PluginPermission.CONTRIBUTIONS_REGISTER);
    this._requireHandleCapacity(record);
    const handle = 'contribution-' + (++record.nextRequestId);
    const contributionDisposable = this._contributions.registerDynamic(point, contribution, {
      id: contributionId,
      owner: record.descriptor.id
    });
    let resource!: Disposable;
    resource = toDisposable(() => {
      record.handles.delete(handle);
      record.subscriptions.delete(resource);
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'contribution', disposable: resource });
    record.subscriptions.add(resource);
    return { handle };
  }

  private async _registerSourceControl(
    record: PluginExtensionRecord,
    args: unknown
  ): Promise<{ readonly handle: string }> {
    this._requirePermission(record, PluginPermission.SOURCE_CONTROL_REGISTER);
    const value = cloneExtensionData(args);
    let descriptor;
    try {
      descriptor = validateSourceControlDescriptor(value);
      assertExtensionOwnedId(record.descriptor.id, descriptor.id, 'Source-control descriptor');
      if (descriptor.openCommand) {
        assertExtensionOwnedId(record.descriptor.id, descriptor.openCommand, 'Source-control open command');
      }
    } catch (error) {
      throw extensionInvalidRequest(error, 'Source-control descriptor is invalid.');
    }
    await this._authorize(record, ExtensionHostMethod.SOURCE_CONTROL_REGISTER, descriptor, PluginPermission.SOURCE_CONTROL_REGISTER);
    this._requireHandleCapacity(record);
    const handle = 'source-control-' + (++record.nextRequestId);
    const contributionDisposable = this._contributions.registerDynamic(ContributionPoint.SOURCE_CONTROL, descriptor, {
      id: descriptor.id,
      owner: record.descriptor.id
    });
    let stateProvider;
    try {
      stateProvider = this._sourceControls.register(descriptor, {
        owner: record.descriptor.id,
        commandPrefix: record.descriptor.id + '.'
      });
    } catch (error) {
      contributionDisposable.dispose();
      throw error;
    }
    let resource!: Disposable;
    resource = toDisposable(() => {
      record.handles.delete(handle);
      record.subscriptions.delete(resource);
      stateProvider.dispose();
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'source-control', disposable: resource, stateProvider });
    record.subscriptions.add(resource);
    return { handle };
  }

  private _sourceControlHandle(
    record: PluginExtensionRecord,
    args: unknown
  ): {
    readonly value: PlainObject;
    readonly resource: Extract<ExtensionResource, { readonly kind: 'source-control' }>;
  } {
    this._requirePermission(record, PluginPermission.SOURCE_CONTROL_REGISTER);
    const value = cloneExtensionData(args) as PlainObject;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Source-control state request is invalid.');
    }
    const handle = asNonEmptyString(value.handle, 'Source-control handle');
    if (!handle.startsWith('source-control-')) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Source-control handle is invalid.');
    }
    const resource = record.handles.get(handle);
    if (!resource || resource.kind !== 'source-control' || !resource.stateProvider) {
      throw createExtensionError(ExtensionErrorCode.NOT_FOUND, 'Source-control provider is no longer available.');
    }
    return { value, resource };
  }

  private _setSourceControlState(record: PluginExtensionRecord, args: unknown): unknown {
    let state;
    try {
      state = this._sourceControlHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle' && key !== 'state')) {
        throw new TypeError('Source-control state request includes an unsupported field.');
      }
      return state.resource.stateProvider.setState(
        state.value.state as Parameters<SourceControlStateHandle['setState']>[0]
      );
    } catch (error) {
      if (hasErrorCode(error)) throw error;
      throw extensionInvalidRequest(error, 'Source-control state is invalid.');
    }
  }

  private _clearSourceControlState(record: PluginExtensionRecord, args: unknown): unknown {
    let state;
    try {
      state = this._sourceControlHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle')) {
        throw new TypeError('Source-control clear request includes an unsupported field.');
      }
      return state.resource.stateProvider.clearState();
    } catch (error) {
      if (hasErrorCode(error)) throw error;
      throw extensionInvalidRequest(error, 'Source-control state clear request is invalid.');
    }
  }

  private async _registerScmFileDecorations(
    record: PluginExtensionRecord,
    args: unknown
  ): Promise<{ readonly handle: string }> {
    this._requirePermission(record, PluginPermission.FILE_DECORATIONS_SCM);
    const value = cloneExtensionData(args) as PlainObject;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some((key) => key !== 'id' && key !== 'priority')) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'SCM decoration provider registration is invalid.');
    }
    const id = assertExtensionOwnedId(
      record.descriptor.id,
      asNonEmptyString(value.id, 'SCM decoration provider'),
      'SCM decoration provider'
    );
    const priority = value.priority === undefined ? 0 : value.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < -1000 || priority > 1000) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'SCM decoration priority must be an integer from -1000 to 1000.');
    }
    await this._authorize(record, ExtensionHostMethod.FILE_DECORATIONS_SCM_REGISTER, { id, priority }, PluginPermission.FILE_DECORATIONS_SCM);
    this._requireHandleCapacity(record);
    const provider = createScmFileDecorationProvider({
      id,
      namespace: record.descriptor.id,
      priority,
      localize: this._localize
    });
    let contributionDisposable: Disposable;
    try {
      contributionDisposable = this._contributions.registerDynamic(
        ContributionPoint.FILE_DECORATIONS_SCM,
        provider,
        { id, owner: record.descriptor.id }
      );
    } catch (error) {
      provider.dispose();
      throw error;
    }
    const handle = 'scm-decoration-' + (++record.nextRequestId);
    let resource!: Disposable;
    resource = toDisposable(() => {
      record.handles.delete(handle);
      record.subscriptions.delete(resource);
      provider.dispose();
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'scm-decoration', disposable: resource, provider });
    record.subscriptions.add(resource);
    return { handle };
  }

  private _scmDecorationHandle(
    record: PluginExtensionRecord,
    args: unknown
  ): {
    readonly value: PlainObject;
    readonly resource: Extract<ExtensionResource, { readonly kind: 'scm-decoration' }>;
  } {
    this._requirePermission(record, PluginPermission.FILE_DECORATIONS_SCM);
    const value = cloneExtensionData(args) as PlainObject;
    const handle = asNonEmptyString(value.handle, 'SCM decoration handle');
    if (!handle.startsWith('scm-decoration-')) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'SCM decoration handle is invalid.');
    }
    const resource = record.handles.get(handle);
    if (!resource || resource.kind !== 'scm-decoration' || !resource.provider) {
      throw createExtensionError(ExtensionErrorCode.NOT_FOUND, 'SCM decoration provider is no longer available.');
    }
    return { value, resource };
  }

  private _setScmFileDecorations(record: PluginExtensionRecord, args: unknown): unknown {
    let state;
    try {
      state = this._scmDecorationHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle' && key !== 'entries')) {
        throw new TypeError('SCM decoration set request includes an unsupported field.');
      }
      return state.resource.provider.set(
        state.value.entries as Parameters<ScmFileDecorationProvider['set']>[0]
      );
    } catch (error) {
      if (hasErrorCode(error)) throw error;
      throw extensionInvalidRequest(error, 'SCM decoration entries are invalid.');
    }
  }

  private _clearScmFileDecorations(record: PluginExtensionRecord, args: unknown): unknown {
    let state;
    try {
      state = this._scmDecorationHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle' && key !== 'paths')) {
        throw new TypeError('SCM decoration clear request includes an unsupported field.');
      }
      return state.resource.provider.clear(
        state.value.paths as Parameters<ScmFileDecorationProvider['clear']>[0]
      );
    } catch (error) {
      if (hasErrorCode(error)) throw error;
      throw extensionInvalidRequest(error, 'SCM decoration clear paths are invalid.');
    }
  }

  private async _requestScmGit(record: PluginExtensionRecord, args: unknown): Promise<unknown> {
    const value = cloneExtensionData(args);
    let request;
    try {
      request = normalizeScmGitRequest(value as Parameters<typeof normalizeScmGitRequest>[0]);
    } catch (error) {
      throw extensionInvalidRequest(error, 'SCM Git request is invalid.');
    }
    this._requirePermission(record, request.permission);
    if (!this._broker) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'SCM Git broker is unavailable.');
    this._assertRecordCurrent(record);
    const result = await this._awaitRecord(
      record,
      this._broker(record.descriptor.id, 'scm.git.' + request.operation, request.args)
    );
    return cloneExtensionData(result);
  }

  private async _registerDocumentView(
    record: PluginExtensionRecord,
    args: unknown
  ): Promise<{ readonly handle: string; readonly id: string }> {
    this._requirePermission(record, PluginPermission.DOCUMENT_VIEWS_REGISTER);
    this._requirePermission(record, PluginPermission.DOCUMENTS_READ);
    const value = cloneExtensionData(args || {}) as PlainObject;
    const id = assertExtensionOwnedId(
      record.descriptor.id,
      asNonEmptyString(value.id, 'Document viewer'),
      'Document viewer'
    );
    const title = boundedString(value.title, '', 120);
    if (!title || Object.keys(value).some((key) => key !== 'id' && key !== 'title')) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Document viewer registration is invalid.');
    }
    const authorization = await this._authorize(record, ExtensionHostMethod.DOCUMENT_VIEW_REGISTER, { id, title }, PluginPermission.DOCUMENT_VIEWS_REGISTER);
    let descriptor;
    try {
      descriptor = validateDocumentViewDescriptor(authorization.viewer, record.descriptor.id);
    } catch (error) {
      throw extensionInvalidRequest(error, 'Document viewer descriptor is invalid.');
    }
    if (descriptor.id !== id || descriptor.title !== title) {
      throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Document viewer authorization returned mismatched identity.');
    }
    this._requireHandleCapacity(record);
    const handle = 'document-view-' + (++record.nextRequestId);
    const contributionDisposable = this._contributions.registerDynamic(ContributionPoint.DOCUMENT_VIEWS, descriptor, {
      id,
      owner: record.descriptor.id
    });
    let resource!: Disposable;
    resource = toDisposable(() => {
      record.handles.delete(handle);
      record.subscriptions.delete(resource);
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'document-view', disposable: resource });
    record.subscriptions.add(resource);
    return { handle, id };
  }

  private _disposeHandle(
    record: PluginExtensionRecord,
    args: unknown,
    kind: ExtensionHandleKind
  ): { readonly disposed: boolean } {
    const value = cloneExtensionData(args || {}) as PlainObject;
    const handle = asNonEmptyString(value.handle, 'Extension handle');
    if (!handle.startsWith(kind + '-')) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension handle does not match the requested resource.');
    }
    const resource = record.handles.get(handle);
    if (!resource || resource.kind !== kind) return { disposed: false };
    resource.disposable.dispose();
    return { disposed: true };
  }

  private async _readService(record: PluginExtensionRecord, args: unknown): Promise<ExtensionData> {
    this._requirePermission(record, PluginPermission.SERVICES_READ);
    const value = cloneExtensionData(args || {}) as PlainObject;
    const id = asNonEmptyString(value.id, 'Service');
    await this._authorize(record, ExtensionHostMethod.SERVICE_GET, { id }, PluginPermission.SERVICES_READ);
    const service = this._services.getForPluginDynamic(id);
    const snapshotFactory = this._serviceSnapshots[id] || defaultServiceSnapshot;
    return cloneExtensionData(snapshotFactory(id, service));
  }

  private async _registerAgent(
    record: PluginExtensionRecord,
    args: unknown
  ): Promise<{ readonly handle: string; readonly id: string }> {
    this._requirePermission(record, PluginPermission.AGENTS_REGISTER);
    if (!this._agents) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Agent state store is unavailable.');
    let descriptor;
    try {
      descriptor = validateAgentDescriptor(cloneExtensionData(args), record.descriptor.id);
    } catch (error) {
      throw extensionInvalidRequest(error, 'Agent descriptor is invalid.');
    }
    await this._authorize(record, ExtensionHostMethod.AGENT_REGISTER, descriptor, PluginPermission.AGENTS_REGISTER);
    this._requireHandleCapacity(record);
    const contributionDisposable = this._contributions.registerDynamic(ContributionPoint.AGENTS, descriptor, {
      id: descriptor.id,
      owner: record.descriptor.id
    });
    let stateProvider;
    try {
      stateProvider = this._agents.register(descriptor, { owner: record.descriptor.id });
    } catch (error) {
      contributionDisposable.dispose();
      throw error;
    }
    const handle = 'agent-' + (++record.nextRequestId);
    let resource!: Disposable;
    resource = toDisposable(() => {
      record.handles.delete(handle);
      record.subscriptions.delete(resource);
      stateProvider.dispose();
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'agent', disposable: resource, stateProvider });
    record.subscriptions.add(resource);
    return { handle, id: descriptor.id };
  }

  private _agentHandle(
    record: PluginExtensionRecord,
    args: unknown
  ): {
    readonly value: PlainObject;
    readonly resource: Extract<ExtensionResource, { readonly kind: 'agent' }>;
  } {
    this._requirePermission(record, PluginPermission.AGENTS_REGISTER);
    const value = cloneExtensionData(args || {}) as PlainObject;
    const handle = asNonEmptyString(value.handle, 'Agent handle');
    if (!handle.startsWith('agent-')) throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Agent handle is invalid.');
    const resource = record.handles.get(handle);
    if (!resource || resource.kind !== 'agent' || !resource.stateProvider) {
      throw createExtensionError(ExtensionErrorCode.NOT_FOUND, 'Agent provider is no longer available.');
    }
    return { value, resource };
  }

  private _setAgentState(record: PluginExtensionRecord, args: unknown): unknown {
    try {
      const current = this._agentHandle(record, args);
      if (Object.keys(current.value).some((key) => key !== 'handle' && key !== 'state')) {
        throw new TypeError('Agent state request includes an unsupported field.');
      }
      return current.resource.stateProvider.setState(
        current.value.state as Parameters<AgentStateHandle['setState']>[0]
      );
    } catch (error) {
      if (hasErrorCode(error)) throw error;
      throw extensionInvalidRequest(error, 'Agent state is invalid.');
    }
  }

  private _updateAgentState(record: PluginExtensionRecord, args: unknown): unknown {
    try {
      const current = this._agentHandle(record, args);
      if (Object.keys(current.value).some((key) => key !== 'handle' && key !== 'patch')) {
        throw new TypeError('Agent state update request includes an unsupported field.');
      }
      return current.resource.stateProvider.updateState(
        current.value.patch as Parameters<AgentStateHandle['updateState']>[0]
      );
    } catch (error) {
      if (hasErrorCode(error)) throw error;
      throw extensionInvalidRequest(error, 'Agent state patch is invalid.');
    }
  }

  private _clearAgentState(record: PluginExtensionRecord, args: unknown): unknown {
    try {
      const current = this._agentHandle(record, args);
      if (Object.keys(current.value).some((key) => key !== 'handle')) throw new TypeError('Agent clear request includes an unsupported field.');
      return current.resource.stateProvider.clearState();
    } catch (error) {
      if (hasErrorCode(error)) throw error;
      throw extensionInvalidRequest(error, 'Agent state clear request is invalid.');
    }
  }

  private async _requestAgentBroker(record: PluginExtensionRecord, args: unknown): Promise<ExtensionData> {
    if (!this._broker) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Agent broker is unavailable.');
    const value = cloneExtensionData(args || {}, AGENT_REQUEST_CLONE_OPTIONS) as PlainObject;
    const method = asNonEmptyString(value.method, 'Agent broker method');
    const directPermissions: Readonly<Partial<Record<string, PluginPermissionDto>>> = {
      'models.list': PluginPermission.MODELS_GENERATE,
      'models.generate': PluginPermission.MODELS_GENERATE,
      'models.generateStream': PluginPermission.MODELS_GENERATE,
      'models.cancel': PluginPermission.MODELS_GENERATE,
      'agent.storage.read': PluginPermission.STORAGE_LOCAL,
      'agent.storage.write': PluginPermission.STORAGE_LOCAL,
      'agent.skills.list': PluginPermission.SKILLS_READ,
      'agent.skills.read': PluginPermission.SKILLS_READ,
      'agent.tools.list': PluginPermission.AGENTS_REGISTER
    };
    let permission = directPermissions[method];
    const brokerArgs = value.args && typeof value.args === 'object' && !Array.isArray(value.args)
      ? value.args as PlainObject
      : value.args;
    if (method === 'agent.tools.invoke') {
      const tool = brokerArgs && typeof brokerArgs === 'object'
        ? (brokerArgs as PlainObject).tool
        : undefined;
      if (tool === 'workspace_list' || tool === 'workspace_read' || tool === 'workspace_search') permission = PluginPermission.WORKSPACE_READ;
      else if (tool === 'workspace_write') permission = PluginPermission.WORKSPACE_WRITE;
      else if (tool === 'process_run') permission = PluginPermission.PROCESS_EXECUTE;
    }
    if (!permission) throw createExtensionError(ExtensionErrorCode.DENIED, 'Agent broker method is not available.');
    this._requirePermission(record, permission);
    this._assertRecordCurrent(record);
    let stream: ExtensionModelStreamRecord | null = null;
    let requestId = '';
    if (method === 'models.generateStream') {
      requestId = boundedString(
        brokerArgs && typeof brokerArgs === 'object'
          ? (brokerArgs as PlainObject).requestId
          : undefined,
        '',
        80
      );
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(requestId) || record.modelStreams.has(requestId)) {
        throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Streaming model request id is invalid or already active.');
      }
      if (record.modelStreams.size >= MAX_ACTIVE_MODEL_STREAMS_PER_PLUGIN) {
        throw createExtensionError(
          ExtensionErrorCode.UNAVAILABLE,
          'Streaming model concurrency limit reached.'
        );
      }
      stream = {
        lastSequence: 0,
        terminal: false,
        settled: false,
        delivering: false,
        cancelRequested: false,
        queue: [],
        head: 0,
        queuedBytes: 0,
        deliveryError: null,
        terminalDelivery: createDeferred<void>()
      };
      record.modelStreams.set(requestId, stream);
    }
    try {
      const result = await this._awaitRecord(
        record,
        this._broker(record.descriptor.id, method, brokerArgs || {})
      );
      if (stream) {
        await this._awaitRecord(record, raceWithTimeout(
          stream.terminalDelivery.promise,
          this._invocationTimeoutMs,
          'Streaming model terminal event delivery timed out.'
        ));
        if (stream.deliveryError) throw stream.deliveryError;
      }
      return cloneExtensionData(result, AGENT_RESULT_CLONE_OPTIONS);
    } catch (error) {
      if (stream && record.modelStreams.get(requestId) === stream) {
        this._abortModelStream(record, requestId, stream, error, method === 'models.generateStream');
      }
      throw error;
    } finally {
      if (stream) {
        stream.settled = true;
        if ((stream.terminal || stream.lastSequence === 0) &&
            stream.queue.length === stream.head &&
            record.modelStreams.get(requestId) === stream) record.modelStreams.delete(requestId);
      }
    }
  }

  private async _brokerRequest(record: PluginExtensionRecord, args: unknown): Promise<ExtensionData> {
    if (!this._broker) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension broker is unavailable.');
    const value = cloneExtensionData(args || {}) as PlainObject;
    const method = asNonEmptyString(value.method, 'Broker method');
    if (method !== 'host.getInfo' && method !== 'permissions.get') {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'This extension broker method is not available in API 1.4.');
    }
    this._assertRecordCurrent(record);
    const result = await this._awaitRecord(record, this._broker(record.descriptor.id, method, value.args));
    return cloneExtensionData(result);
  }

  private async _authorize(
    record: PluginExtensionRecord,
    method: string,
    args: unknown,
    permission: PluginPermissionDto
  ): Promise<PlainObject> {
    if (!this._broker) {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension authorization broker is unavailable.');
    }
    this._assertRecordCurrent(record);
    const result = cloneExtensionData(await this._awaitRecord(
      record,
      this._broker(record.descriptor.id, method, args)
    )) as PlainObject;
    if (!result || result.authorized !== true) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'Extension authorization was denied for: ' + permission);
    }
    return result;
  }

  private _requirePermission(record: PluginExtensionRecord, permission: PluginPermissionDto): void {
    if (!record.descriptor.manifest.permissions.includes(permission) ||
        !record.descriptor.grantedPermissions.includes(permission)) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'Extension was not granted permission: ' + permission);
    }
  }

  private _post(record: PluginExtensionRecord, message: ExtensionHostToSandboxPayloadDto): void {
    if (!record.sandbox || record.cleaned) {
      throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension sandbox is no longer available.');
    }
    record.sandbox.postMessage({ protocolVersion: EXTENSION_PROTOCOL_VERSION, ...message });
  }

  private _respond(
    record: PluginExtensionRecord,
    id: unknown,
    ok: boolean,
    value: unknown,
    error: unknown
  ): void {
    if (!isExtensionRequestId(id) || record.cleaned) return;
    try {
      this._post(record, ok
        ? { type: ExtensionMessageType.RESPONSE, id, ok: true, value }
        : { type: ExtensionMessageType.RESPONSE, id, ok: false, error: serializeExtensionError(error) });
    } catch (postError) {
      this._handleSandboxFatal(record, postError);
    }
  }

  private _callSandbox(
    record: PluginExtensionRecord,
    method: ExtensionSandboxMethodDto,
    args: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    if (record.cleaned || !record.sandbox ||
        (record.cancelled && method !== ExtensionSandboxMethod.DEACTIVATE)) {
      return Promise.reject(createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension sandbox is no longer available.'));
    }
    const pendingLimit = method === ExtensionSandboxMethod.DEACTIVATE
      ? MAX_PENDING_SANDBOX_REQUESTS
      : MAX_PENDING_SANDBOX_DATA_REQUESTS;
    if (record.pending.size >= pendingLimit) {
      return Promise.reject(createExtensionError(
        ExtensionErrorCode.UNAVAILABLE,
        'Extension sandbox request concurrency limit reached.'
      ));
    }
    const id = 'host-' + (++record.nextRequestId);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        record.pending.delete(id);
        reject(createExtensionError(ExtensionErrorCode.TIMEOUT, 'Extension request timed out.'));
      }, timeoutMs);
      record.pending.set(id, { resolve, reject, timeout });
      try {
        const cloneOptions = method === ExtensionSandboxMethod.AGENT_MODEL_EVENT
          ? AGENT_RESULT_CLONE_OPTIONS
          : undefined;
        this._post(record, {
          type: ExtensionMessageType.REQUEST,
          id,
          method,
          args: cloneExtensionData(args, cloneOptions)
        });
      } catch (error) {
        clearTimeout(timeout);
        record.pending.delete(id);
        reject(error);
      }
    });
  }

  private _resolveSandboxRequest(
    record: PluginExtensionRecord,
    message: ExtensionResponseMessageDto
  ): void {
    if (!isExtensionRequestId(message.id)) {
      this._report('extension-protocol', record.descriptor.id, createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension response has an invalid id.'));
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = record.pending.get(message.id);
    if (!pending) return;
    record.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.ok === true) {
      try {
        pending.resolve(cloneExtensionData(message.value));
      } catch (error) {
        pending.reject(error);
      }
    } else {
      pending.reject(deserializeExtensionError(message.error, ExtensionErrorCode.UNAVAILABLE));
    }
  }

  private _handleSandboxFatal(record: PluginExtensionRecord, error: unknown): void {
    if (record.cleaned) return;
    const failure = error instanceof Error
      ? error
      : createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension sandbox terminated unexpectedly.');
    record.ready.reject(failure);
    this._report('extension-sandbox', record.descriptor.id, failure);
    void this.deactivate(record.descriptor.id);
  }

  private _cleanupRecord(record: PluginExtensionRecord): void {
    if (record.cleaned) return;
    record.cancelled = true;
    record.cancellation.resolve();
    record.cleaned = true;
    if (this._records.get(record.descriptor.id) === record) this._records.delete(record.descriptor.id);
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension was deactivated.'));
    }
    record.pending.clear();
    record.incomingRequests.clear();
    for (const [requestId, stream] of record.modelStreams) {
      this._abortModelStream(
        record,
        requestId,
        stream,
        createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension was deactivated.'),
        true
      );
    }
    record.modelStreams.clear();
    record.pendingModelEventBytes = 0;
    record.handles.clear();
    record.subscriptions.dispose();
    this._commands.disposeOwner(record.descriptor.id);
    this._contributions.disposeOwner(record.descriptor.id);
    this._sourceControls.disposeOwner(record.descriptor.id);
    if (this._agents) this._agents.disposeOwner(record.descriptor.id);
    if (this._broker) {
      void Promise.resolve()
        .then(() => this._broker!(record.descriptor.id, 'agent.lifecycle.dispose', {}))
        .catch(() => {});
    }
    try { if (record.sandbox) record.sandbox.dispose(); } catch (error) { this._report('extension-sandbox-dispose', record.descriptor.id, error); }
    this._emit(record, 'stopped');
  }

  private _emit(
    record: PluginExtensionRecord,
    status?: PluginExtensionLifecycleStatusDto
  ): void {
    const event = Object.freeze({
      id: record.descriptor.id,
      status: status || record.status,
      version: record.descriptor.manifest.version
    });
    for (const listener of Array.from(this._listeners)) {
      try { listener(event); } catch (error) { this._report('extension-listener', record.descriptor.id, error); }
    }
  }

  private _report(source: PluginExtensionErrorSource, id: unknown, error: unknown): void {
    try { this._onError({ source, id: typeof id === 'string' ? id : '', error }); } catch (_) {}
  }
}
