import { DisposableStore, toDisposable } from './disposable.js';
import { ContributionPoint } from './contribution-registry.js';
import { PLUGIN_API_VERSION, PluginPermission, validatePluginManifest } from './plugin-runtime.js';
import { createScmFileDecorationProvider } from './scm-file-decoration.js';
import { normalizeScmGitRequest } from './scm-git.js';
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

const ACTIVATION_TIMEOUT_MS = 15_000;
const INVOCATION_TIMEOUT_MS = 10_000;
const DEACTIVATION_TIMEOUT_MS = 1_500;
const MAX_ENTRY_SOURCE_BYTES = 5 * 1024 * 1024;
const LOCALIZATION_TIMEOUT_MS = 5_000;

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

const DECLARATIVE_POINTS = new Set(Object.values(DeclarativeContributionPoint));
const KNOWN_PERMISSIONS = new Set(Object.values(PluginPermission));

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, label + ' must be a non-empty string.');
  }
  return value.trim();
}

function boundedString(value, fallback, maxLength = 160) {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength) || fallback;
}

function raceWithTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(createExtensionError(ExtensionErrorCode.TIMEOUT, message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function normalizeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor must be an object.');
  }
  const manifest = validatePluginManifest(descriptor.manifest);
  if (descriptor.id !== manifest.id) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor id does not match its manifest.');
  }
  const grantedPermissions = Array.isArray(descriptor.grantedPermissions)
    ? [...new Set(descriptor.grantedPermissions)]
    : [];
  for (const permission of grantedPermissions) {
    if (!KNOWN_PERMISSIONS.has(permission)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor includes an unknown permission.');
    }
    if (!manifest.permissions.includes(permission)) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'Extension was not granted an undeclared permission.');
    }
  }
  const revision = descriptor.revision === undefined ? manifest.version : descriptor.revision;
  if (typeof revision !== 'string' || !revision.trim() || revision.length > 160 || /[\0\r\n]/.test(revision)) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor revision is invalid.');
  }
  return Object.freeze({
    id: manifest.id,
    manifest,
    grantedPermissions: Object.freeze(grantedPermissions),
    revision
  });
}

function sanitizeCommandMetadata(metadata, commandId) {
  const value = cloneExtensionData(metadata || {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Command metadata must be a plain object.');
  }
  return Object.freeze({
    title: boundedString(value.title, commandId),
    category: boundedString(value.category, 'Extensions'),
    hint: boundedString(value.hint || value.keybinding, '', 80)
  });
}

function defaultServiceSnapshot(id, service) {
  if (id !== 'workbench.projectTasks') {
    throw createExtensionError(ExtensionErrorCode.DENIED, 'This service has no data-only extension snapshot.');
  }
  if (!service || typeof service.list !== 'function' || typeof service.getSelected !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Project task snapshot service is unavailable.');
  }
  return {
    tasks: service.list(),
    selected: service.getSelected()
  };
}

function samePermissions(left, right) {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

function extensionInvalidRequest(error, fallbackMessage) {
  return createExtensionError(
    ExtensionErrorCode.INVALID_REQUEST,
    error && typeof error.message === 'string' && error.message ? error.message : fallbackMessage
  );
}

function normalizePluginLocale(value) {
  return value === 'zh-CN' || value === 'ja' || value === 'en' ? value : 'en';
}

function normalizeLocalizationPayload(value, fallbackLocale) {
  const payload = cloneExtensionData(value);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some((key) => key !== 'locale' && key !== 'messages')) {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Plugin localization broker returned an invalid response.');
  }
  if (!payload.messages || typeof payload.messages !== 'object' || Array.isArray(payload.messages)) {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Plugin localization messages are invalid.');
  }
  const entries = Object.entries(payload.messages);
  if (entries.length > 1024) {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Plugin localization messages exceed the host limit.');
  }
  const messages = Object.create(null);
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

export class PluginExtensionHost {
  constructor(options = {}) {
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
    this._activationTimeoutMs = Number.isFinite(options.activationTimeoutMs)
      ? options.activationTimeoutMs
      : ACTIVATION_TIMEOUT_MS;
    this._invocationTimeoutMs = Number.isFinite(options.invocationTimeoutMs)
      ? options.invocationTimeoutMs
      : INVOCATION_TIMEOUT_MS;
    this._deactivationTimeoutMs = Number.isFinite(options.deactivationTimeoutMs)
      ? options.deactivationTimeoutMs
      : DEACTIVATION_TIMEOUT_MS;
    this._records = new Map();
    this._listeners = new Set();
    this._disposed = false;
    this._disposePromise = null;
    this._localeSubscription = null;
    if (typeof options.onLocaleChange === 'function') {
      const subscription = options.onLocaleChange(() => { void this._refreshPluginLocalizations(); });
      if (typeof subscription === 'function') this._localeSubscription = { dispose: subscription };
      else if (subscription && typeof subscription.dispose === 'function') this._localeSubscription = subscription;
    }
  }

  onDidChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Extension status listener must be a function.');
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  }

  list() {
    return Array.from(this._records.values(), (record) => Object.freeze({
      id: record.descriptor.id,
      version: record.descriptor.manifest.version,
      displayName: record.descriptor.manifest.displayName,
      status: record.status,
      grantedPermissions: record.descriptor.grantedPermissions
    }));
  }

  async start() {
    return this.refresh();
  }

  async refresh(descriptors) {
    if (this._disposed) return { ok: false, error: createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension host is disposed.') };
    let next;
    try {
      next = descriptors === undefined
        ? await this._requireDescriptorBroker()()
        : descriptors;
      if (!Array.isArray(next)) throw new TypeError('Extension descriptor broker must return an array.');
    } catch (error) {
      this._report('extension-refresh', '', error);
      return { ok: false, error };
    }

    const normalized = new Map();
    const failures = [];
    for (const descriptor of next) {
      try {
        const value = normalizeDescriptor(descriptor);
        if (normalized.has(value.id)) throw new Error('Duplicate extension descriptor: ' + value.id);
        normalized.set(value.id, value);
      } catch (error) {
        failures.push({ id: descriptor && descriptor.id || '', error });
        this._report('extension-descriptor', descriptor && descriptor.id, error);
      }
    }

    const deactivated = [];
    for (const record of Array.from(this._records.values())) {
      const replacement = normalized.get(record.descriptor.id);
      if (!replacement || replacement.revision !== record.descriptor.revision ||
          !samePermissions(replacement.grantedPermissions, record.descriptor.grantedPermissions)) {
        await this.deactivate(record.descriptor.id);
        deactivated.push(record.descriptor.id);
      }
    }

    const activated = [];
    for (const descriptor of normalized.values()) {
      if (this._records.has(descriptor.id)) continue;
      const result = await this.activate(descriptor);
      if (result.ok) activated.push(descriptor.id);
      else failures.push({ id: descriptor.id, error: result.error });
    }
    return { ok: failures.length === 0, activated, deactivated, failures };
  }

  activate(descriptor) {
    if (this._disposed) {
      return Promise.resolve({ ok: false, error: createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension host is disposed.') });
    }
    let normalized;
    try {
      normalized = descriptor && descriptor.manifest ? normalizeDescriptor(descriptor) : descriptor;
      if (!normalized || !normalized.manifest || normalized.id !== normalized.manifest.id) {
        throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension descriptor is invalid.');
      }
    } catch (error) {
      this._report('extension-validate', descriptor && descriptor.id, error);
      return Promise.resolve({ ok: false, error });
    }
    const existing = this._records.get(normalized.id);
    if (existing) return existing.activationPromise || Promise.resolve({ ok: existing.status === 'active', id: normalized.id });

    const cancellation = createDeferred();
    const record = {
      descriptor: normalized,
      status: 'activating',
      subscriptions: new DisposableStore({ onError: (event) => this._report('extension-dispose', normalized.id, event.error) }),
      sandbox: null,
      pending: new Map(),
      incomingRequests: new Set(),
      handles: new Map(),
      ready: createDeferred(),
      activationSettled: false,
      cancellation,
      cancelled: false,
      cleaned: false,
      activationPromise: null,
      deactivationPromise: null,
      nextRequestId: 0,
      localization: null,
      localizationRevision: 0
    };
    this._records.set(normalized.id, record);
    this._emit(record);
    record.activationPromise = this._activateRecord(record);
    return record.activationPromise;
  }

  deactivate(id) {
    const record = this._records.get(id);
    if (!record) return Promise.resolve({ ok: false, error: createExtensionError(ExtensionErrorCode.NOT_FOUND, 'Extension is not active: ' + id) });
    if (record.deactivationPromise) return record.deactivationPromise;
    record.cancelled = true;
    record.status = 'deactivating';
    record.cancellation.resolve();
    this._emit(record);
    record.deactivationPromise = (async () => {
      let result = { ok: true, id };
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
    return record.deactivationPromise;
  }

  dispose() {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    this._disposePromise = (async () => {
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
    return this._disposePromise;
  }

  async _activateRecord(record) {
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
      return { ok: true, id };
    } catch (error) {
      if (record.cancelled || this._disposed || error && error.code === ExtensionErrorCode.CANCELLED) {
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

  _validateSource(id, loaded) {
    if (!loaded || typeof loaded !== 'object' || loaded.id !== id || typeof loaded.source !== 'string') {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension source broker returned an invalid response.');
    }
    if (loaded.source.length === 0 || loaded.source.length > MAX_ENTRY_SOURCE_BYTES) {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension entry source is unavailable or exceeds the 5 MiB limit.');
    }
    return loaded.source;
  }

  async _loadPluginLocalization(record) {
    const locale = normalizePluginLocale(this._getLocale());
    const value = await raceWithTimeout(
      this._loadLocalization(record.descriptor.id, locale),
      LOCALIZATION_TIMEOUT_MS,
      'Plugin localization loading timed out.'
    );
    const localization = normalizeLocalizationPayload(value, locale);
    record.localization = localization;
    return localization;
  }

  async _refreshPluginLocalizations() {
    if (this._disposed) return;
    for (const record of Array.from(this._records.values())) {
      if (record.cleaned || record.cancelled || record.status !== 'active') continue;
      const revision = (record.localizationRevision || 0) + 1;
      record.localizationRevision = revision;
      try {
        const localization = await this._loadPluginLocalization(record);
        if (record.cleaned || record.cancelled || record.status !== 'active' || record.localizationRevision !== revision) continue;
        await this._callSandbox(record, ExtensionSandboxMethod.I18N_CHANGED, localization, this._invocationTimeoutMs);
      } catch (error) {
        if (!record.cleaned && !record.cancelled) this._report('extension-i18n', record.descriptor.id, error);
      }
    }
  }

  _raceCancellation(record, promise) {
    return Promise.race([
      Promise.resolve(promise),
      record.cancellation.promise.then(() => {
        throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension operation was cancelled.');
      })
    ]);
  }

  _assertRecordCurrent(record) {
    if (this._disposed || record.cancelled || record.cleaned ||
        this._records.get(record.descriptor.id) !== record) {
      throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension operation was cancelled.');
    }
  }

  async _awaitRecord(record, promise) {
    const value = await this._raceCancellation(record, promise);
    this._assertRecordCurrent(record);
    return value;
  }

  _requireDescriptorBroker() {
    if (!this._listDescriptors) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension descriptor broker is unavailable.');
    return this._listDescriptors;
  }

  _handleSandboxMessage(record, message) {
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

  async _handleExtensionRequest(record, message) {
    if (!isExtensionRequestId(message.id) || typeof message.method !== 'string') {
      const error = createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension request is malformed.');
      this._report('extension-protocol', record.descriptor.id, error);
      this._respond(record, message && message.id, false, null, error);
      return;
    }
    if (record.incomingRequests.has(message.id)) {
      const error = createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension reused an active request id.');
      this._report('extension-protocol', record.descriptor.id, error);
      this._handleSandboxFatal(record, error);
      return;
    }
    if (record.incomingRequests.size >= 32) {
      const error = createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension request concurrency limit reached.');
      this._respond(record, message.id, false, null, error);
      return;
    }
    record.incomingRequests.add(message.id);
    try {
      const value = await this._dispatchExtensionRequest(record, message.method, message.args);
      const cloneOptions = message.method === ExtensionHostMethod.AGENT_BROKER_REQUEST
        ? { maxStringLength: 2 * 1024 * 1024, maxItems: 8192, maxBytes: 8 * 1024 * 1024 }
        : undefined;
      this._respond(record, message.id, true, cloneExtensionData(value, cloneOptions));
    } catch (error) {
      this._respond(record, message.id, false, null, error);
    } finally {
      record.incomingRequests.delete(message.id);
    }
  }

  async _dispatchExtensionRequest(record, method, args) {
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

  async _registerCommand(record, args) {
    this._requirePermission(record, PluginPermission.COMMANDS_REGISTER);
    const value = cloneExtensionData(args || {});
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
    const handle = 'command-' + (++record.nextRequestId);
    const commandDisposable = this._commands.register(commandId, (...commandArgs) => (
      this._callSandbox(record, ExtensionSandboxMethod.COMMAND_INVOKE, {
        handlerId,
        args: cloneExtensionData(commandArgs)
      }, this._invocationTimeoutMs)
    ), {
      owner: record.descriptor.id,
      title: metadata.title,
      category: metadata.category
    });
    const paletteDisposable = this._registerPaletteCommand(record, commandId, metadata);
    const resource = toDisposable(() => {
      record.handles.delete(handle);
      if (paletteDisposable) paletteDisposable.dispose();
      commandDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'command', disposable: resource });
    record.subscriptions.add(resource);
    return { handle };
  }

  _registerPaletteCommand(record, commandId, metadata) {
    const palette = this._getCommandPalette();
    if (!palette || typeof palette.register !== 'function' || palette.supportsDisposables !== true) return null;
    const disposable = palette.register(
      commandId,
      metadata.title,
      metadata.hint,
      metadata.category,
      () => this._commands.executeIsolated(commandId).then((result) => {
        if (!result.ok) this._report('extension-command', record.descriptor.id, result.error);
      })
    );
    if (disposable && typeof disposable.dispose === 'function') return disposable;
    // A compatible palette should return a disposer. Fall back to its explicit
    // unregister method only when available; otherwise do not retain a stale
    // command on later deactivation.
    if (typeof palette.unregister === 'function') {
      return toDisposable(() => palette.unregister(commandId));
    }
    this._report('extension-command-palette', record.descriptor.id,
      createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Command palette does not support disposable registrations.'));
    return null;
  }

  async _executeCommand(record, args) {
    this._requirePermission(record, PluginPermission.COMMANDS_EXECUTE);
    const value = cloneExtensionData(args || {});
    const id = asNonEmptyString(value.id, 'Command');
    const commandArgs = Array.isArray(value.args) ? value.args : [];
    await this._authorize(record, ExtensionHostMethod.COMMAND_EXECUTE, { id }, PluginPermission.COMMANDS_EXECUTE);
    this._assertRecordCurrent(record);
    return this._commands.execute(id, ...commandArgs);
  }

  async _registerContribution(record, args) {
    this._requirePermission(record, PluginPermission.CONTRIBUTIONS_REGISTER);
    const value = cloneExtensionData(args || {});
    const point = asNonEmptyString(value.point, 'Contribution point');
    if (!DECLARATIVE_POINTS.has(point)) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'This contribution point does not accept installed extension code.');
    }
    const contribution = cloneExtensionData(value.contribution);
    if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension contribution must be a plain object.');
    }
    const options = cloneExtensionData(value.options || {});
    const contributionId = assertExtensionOwnedId(
      record.descriptor.id,
      asNonEmptyString(options.id || contribution.id, 'Contribution'),
      'Contribution'
    );
    await this._authorize(record, ExtensionHostMethod.CONTRIBUTION_REGISTER, {
      id: contributionId,
      point
    }, PluginPermission.CONTRIBUTIONS_REGISTER);
    const handle = 'contribution-' + (++record.nextRequestId);
    const contributionDisposable = this._contributions.register(point, contribution, {
      id: contributionId,
      owner: record.descriptor.id
    });
    const resource = toDisposable(() => {
      record.handles.delete(handle);
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'contribution', disposable: resource });
    record.subscriptions.add(resource);
    return { handle };
  }

  async _registerSourceControl(record, args) {
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
    const handle = 'source-control-' + (++record.nextRequestId);
    const contributionDisposable = this._contributions.register(ContributionPoint.SOURCE_CONTROL, descriptor, {
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
    const resource = toDisposable(() => {
      record.handles.delete(handle);
      stateProvider.dispose();
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'source-control', disposable: resource, stateProvider });
    record.subscriptions.add(resource);
    return { handle };
  }

  _sourceControlHandle(record, args) {
    this._requirePermission(record, PluginPermission.SOURCE_CONTROL_REGISTER);
    const value = cloneExtensionData(args);
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

  _setSourceControlState(record, args) {
    let state;
    try {
      state = this._sourceControlHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle' && key !== 'state')) {
        throw new TypeError('Source-control state request includes an unsupported field.');
      }
      return state.resource.stateProvider.setState(state.value.state);
    } catch (error) {
      if (error && error.code) throw error;
      throw extensionInvalidRequest(error, 'Source-control state is invalid.');
    }
  }

  _clearSourceControlState(record, args) {
    let state;
    try {
      state = this._sourceControlHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle')) {
        throw new TypeError('Source-control clear request includes an unsupported field.');
      }
      return state.resource.stateProvider.clearState();
    } catch (error) {
      if (error && error.code) throw error;
      throw extensionInvalidRequest(error, 'Source-control state clear request is invalid.');
    }
  }

  async _registerScmFileDecorations(record, args) {
    this._requirePermission(record, PluginPermission.FILE_DECORATIONS_SCM);
    const value = cloneExtensionData(args);
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
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'SCM decoration priority must be an integer from -1000 to 1000.');
    }
    await this._authorize(record, ExtensionHostMethod.FILE_DECORATIONS_SCM_REGISTER, { id, priority }, PluginPermission.FILE_DECORATIONS_SCM);
    const provider = createScmFileDecorationProvider({
      id,
      namespace: record.descriptor.id,
      priority,
      localize: this._localize
    });
    const contributionDisposable = this._contributions.register(ContributionPoint.FILE_DECORATIONS_SCM, provider, {
      id,
      owner: record.descriptor.id
    });
    const handle = 'scm-decoration-' + (++record.nextRequestId);
    const resource = toDisposable(() => {
      record.handles.delete(handle);
      provider.dispose();
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'scm-decoration', disposable: resource, provider });
    record.subscriptions.add(resource);
    return { handle };
  }

  _scmDecorationHandle(record, args) {
    this._requirePermission(record, PluginPermission.FILE_DECORATIONS_SCM);
    const value = cloneExtensionData(args);
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

  _setScmFileDecorations(record, args) {
    let state;
    try {
      state = this._scmDecorationHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle' && key !== 'entries')) {
        throw new TypeError('SCM decoration set request includes an unsupported field.');
      }
      return state.resource.provider.set(state.value.entries);
    } catch (error) {
      if (error && error.code) throw error;
      throw extensionInvalidRequest(error, 'SCM decoration entries are invalid.');
    }
  }

  _clearScmFileDecorations(record, args) {
    let state;
    try {
      state = this._scmDecorationHandle(record, args);
      if (Object.keys(state.value).some((key) => key !== 'handle' && key !== 'paths')) {
        throw new TypeError('SCM decoration clear request includes an unsupported field.');
      }
      return state.resource.provider.clear(state.value.paths);
    } catch (error) {
      if (error && error.code) throw error;
      throw extensionInvalidRequest(error, 'SCM decoration clear paths are invalid.');
    }
  }

  async _requestScmGit(record, args) {
    const value = cloneExtensionData(args);
    let request;
    try {
      request = normalizeScmGitRequest(value);
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

  async _registerDocumentView(record, args) {
    this._requirePermission(record, PluginPermission.DOCUMENT_VIEWS_REGISTER);
    this._requirePermission(record, PluginPermission.DOCUMENTS_READ);
    const value = cloneExtensionData(args || {});
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
    const handle = 'document-view-' + (++record.nextRequestId);
    const contributionDisposable = this._contributions.register(ContributionPoint.DOCUMENT_VIEWS, descriptor, {
      id,
      owner: record.descriptor.id
    });
    const resource = toDisposable(() => {
      record.handles.delete(handle);
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'document-view', disposable: resource });
    record.subscriptions.add(resource);
    return { handle, id };
  }

  _disposeHandle(record, args, kind) {
    const value = cloneExtensionData(args || {});
    const handle = asNonEmptyString(value.handle, 'Extension handle');
    if (!handle.startsWith(kind + '-')) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension handle does not match the requested resource.');
    }
    const resource = record.handles.get(handle);
    if (!resource || resource.kind !== kind) return { disposed: false };
    resource.disposable.dispose();
    return { disposed: true };
  }

  async _readService(record, args) {
    this._requirePermission(record, PluginPermission.SERVICES_READ);
    const value = cloneExtensionData(args || {});
    const id = asNonEmptyString(value.id, 'Service');
    await this._authorize(record, ExtensionHostMethod.SERVICE_GET, { id }, PluginPermission.SERVICES_READ);
    const service = this._services.getForPlugin(id);
    const snapshotFactory = this._serviceSnapshots[id] || defaultServiceSnapshot;
    return cloneExtensionData(snapshotFactory(id, service));
  }

  async _registerAgent(record, args) {
    this._requirePermission(record, PluginPermission.AGENTS_REGISTER);
    if (!this._agents) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Agent state store is unavailable.');
    let descriptor;
    try {
      descriptor = validateAgentDescriptor(cloneExtensionData(args), record.descriptor.id);
    } catch (error) {
      throw extensionInvalidRequest(error, 'Agent descriptor is invalid.');
    }
    await this._authorize(record, ExtensionHostMethod.AGENT_REGISTER, descriptor, PluginPermission.AGENTS_REGISTER);
    const contributionDisposable = this._contributions.register(ContributionPoint.AGENTS, descriptor, {
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
    const resource = toDisposable(() => {
      record.handles.delete(handle);
      stateProvider.dispose();
      contributionDisposable.dispose();
    });
    record.handles.set(handle, { kind: 'agent', disposable: resource, stateProvider });
    record.subscriptions.add(resource);
    return { handle, id: descriptor.id };
  }

  _agentHandle(record, args) {
    this._requirePermission(record, PluginPermission.AGENTS_REGISTER);
    const value = cloneExtensionData(args || {});
    const handle = asNonEmptyString(value.handle, 'Agent handle');
    if (!handle.startsWith('agent-')) throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Agent handle is invalid.');
    const resource = record.handles.get(handle);
    if (!resource || resource.kind !== 'agent' || !resource.stateProvider) {
      throw createExtensionError(ExtensionErrorCode.NOT_FOUND, 'Agent provider is no longer available.');
    }
    return { value, resource };
  }

  _setAgentState(record, args) {
    try {
      const current = this._agentHandle(record, args);
      if (Object.keys(current.value).some((key) => key !== 'handle' && key !== 'state')) {
        throw new TypeError('Agent state request includes an unsupported field.');
      }
      return current.resource.stateProvider.setState(current.value.state);
    } catch (error) {
      if (error && error.code) throw error;
      throw extensionInvalidRequest(error, 'Agent state is invalid.');
    }
  }

  _clearAgentState(record, args) {
    try {
      const current = this._agentHandle(record, args);
      if (Object.keys(current.value).some((key) => key !== 'handle')) throw new TypeError('Agent clear request includes an unsupported field.');
      return current.resource.stateProvider.clearState();
    } catch (error) {
      if (error && error.code) throw error;
      throw extensionInvalidRequest(error, 'Agent state clear request is invalid.');
    }
  }

  async _requestAgentBroker(record, args) {
    if (!this._broker) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Agent broker is unavailable.');
    const value = cloneExtensionData(args || {}, {
      maxStringLength: 2 * 1024 * 1024,
      maxItems: 8192,
      maxBytes: 8 * 1024 * 1024
    });
    const method = asNonEmptyString(value.method, 'Agent broker method');
    const directPermissions = {
      'models.list': PluginPermission.MODELS_GENERATE,
      'models.generate': PluginPermission.MODELS_GENERATE,
      'models.cancel': PluginPermission.MODELS_GENERATE,
      'agent.storage.read': PluginPermission.STORAGE_LOCAL,
      'agent.storage.write': PluginPermission.STORAGE_LOCAL,
      'agent.skills.list': PluginPermission.SKILLS_READ,
      'agent.skills.read': PluginPermission.SKILLS_READ
    };
    let permission = directPermissions[method];
    if (method === 'agent.tools.invoke') {
      const tool = value.args && value.args.tool;
      if (tool === 'workspace_list' || tool === 'workspace_read' || tool === 'workspace_search') permission = PluginPermission.WORKSPACE_READ;
      else if (tool === 'workspace_write') permission = PluginPermission.WORKSPACE_WRITE;
      else if (tool === 'process_run') permission = PluginPermission.PROCESS_EXECUTE;
    }
    if (!permission) throw createExtensionError(ExtensionErrorCode.DENIED, 'Agent broker method is not available.');
    this._requirePermission(record, permission);
    this._assertRecordCurrent(record);
    const result = await this._awaitRecord(
      record,
      this._broker(record.descriptor.id, method, value.args || {})
    );
    return cloneExtensionData(result, {
      maxStringLength: 2 * 1024 * 1024,
      maxItems: 8192,
      maxBytes: 8 * 1024 * 1024
    });
  }

  async _brokerRequest(record, args) {
    if (!this._broker) throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension broker is unavailable.');
    const value = cloneExtensionData(args || {});
    const method = asNonEmptyString(value.method, 'Broker method');
    if (method !== 'host.getInfo' && method !== 'permissions.get') {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'This extension broker method is not available in API 1.4.');
    }
    this._assertRecordCurrent(record);
    const result = await this._awaitRecord(record, this._broker(record.descriptor.id, method, value.args));
    return cloneExtensionData(result);
  }

  async _authorize(record, method, args, permission) {
    if (!this._broker) {
      throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension authorization broker is unavailable.');
    }
    this._assertRecordCurrent(record);
    const result = cloneExtensionData(await this._awaitRecord(
      record,
      this._broker(record.descriptor.id, method, args)
    ));
    if (!result || result.authorized !== true) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'Extension authorization was denied for: ' + permission);
    }
    return result;
  }

  _requirePermission(record, permission) {
    if (!record.descriptor.manifest.permissions.includes(permission) ||
        !record.descriptor.grantedPermissions.includes(permission)) {
      throw createExtensionError(ExtensionErrorCode.DENIED, 'Extension was not granted permission: ' + permission);
    }
  }

  _post(record, message) {
    if (!record.sandbox || record.cleaned) {
      throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension sandbox is no longer available.');
    }
    record.sandbox.postMessage({ protocolVersion: EXTENSION_PROTOCOL_VERSION, ...message });
  }

  _respond(record, id, ok, value, error) {
    if (!isExtensionRequestId(id) || record.cleaned) return;
    try {
      this._post(record, ok
        ? { type: ExtensionMessageType.RESPONSE, id, ok: true, value }
        : { type: ExtensionMessageType.RESPONSE, id, ok: false, error: serializeExtensionError(error) });
    } catch (postError) {
      this._handleSandboxFatal(record, postError);
    }
  }

  _callSandbox(record, method, args, timeoutMs) {
    if (record.cleaned || !record.sandbox) {
      return Promise.reject(createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension sandbox is no longer available.'));
    }
    const id = 'host-' + (++record.nextRequestId);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        record.pending.delete(id);
        reject(createExtensionError(ExtensionErrorCode.TIMEOUT, 'Extension request timed out.'));
      }, timeoutMs);
      record.pending.set(id, { resolve, reject, timeout });
      try {
        this._post(record, {
          type: ExtensionMessageType.REQUEST,
          id,
          method,
          args: cloneExtensionData(args)
        });
      } catch (error) {
        clearTimeout(timeout);
        record.pending.delete(id);
        reject(error);
      }
    });
  }

  _resolveSandboxRequest(record, message) {
    if (!isExtensionRequestId(message.id)) {
      this._report('extension-protocol', record.descriptor.id, createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension response has an invalid id.'));
      return;
    }
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

  _handleSandboxFatal(record, error) {
    if (record.cleaned) return;
    const failure = error instanceof Error
      ? error
      : createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension sandbox terminated unexpectedly.');
    record.ready.reject(failure);
    this._report('extension-sandbox', record.descriptor.id, failure);
    void this.deactivate(record.descriptor.id);
  }

  _cleanupRecord(record) {
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
    record.handles.clear();
    record.subscriptions.dispose();
    this._commands.disposeOwner(record.descriptor.id);
    this._contributions.disposeOwner(record.descriptor.id);
    this._sourceControls.disposeOwner(record.descriptor.id);
    if (this._agents) this._agents.disposeOwner(record.descriptor.id);
    if (this._broker) void Promise.resolve(this._broker(record.descriptor.id, 'agent.lifecycle.dispose', {})).catch(() => {});
    try { if (record.sandbox) record.sandbox.dispose(); } catch (error) { this._report('extension-sandbox-dispose', record.descriptor.id, error); }
    this._emit(record, 'stopped');
  }

  _emit(record, status) {
    const event = Object.freeze({
      id: record.descriptor.id,
      status: status || record.status,
      version: record.descriptor.manifest.version
    });
    for (const listener of Array.from(this._listeners)) {
      try { listener(event); } catch (error) { this._report('extension-listener', record.descriptor.id, error); }
    }
  }

  _report(source, id, error) {
    try { this._onError({ source, id, error }); } catch (_) {}
  }
}
