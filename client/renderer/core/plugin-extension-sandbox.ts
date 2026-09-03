import {
  EXTENSION_PROTOCOL_VERSION,
  ExtensionErrorCode,
  ExtensionMessageType,
  createExtensionDataCloner,
  createExtensionError
} from './plugin-extension-protocol.js';
import type {
  PluginExtensionSandbox,
  PluginExtensionSandboxDocument,
  PluginExtensionSandboxMountTarget,
  PluginExtensionSandboxOptions
} from '../../types/plugin-extension-sandbox';
import type { ExtensionHostToSandboxMessageDto } from '../../types/plugin-extension-protocol';

// This CSP is deliberately stricter than the workbench CSP. The iframe has an
// opaque origin (`sandbox` omits allow-same-origin), cannot connect to the
// network, and receives its extension source only over a MessageChannel. The
// only worker allowed by this CSP is the host-created Blob worker below.
export const EXTENSION_SANDBOX_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "worker-src blob:"
].join('; ');

const CONNECT_TIMEOUT_MS = 5000;

function extensionWorkerBootstrapSource(): string {
  // Keep this self-contained: the worker intentionally cannot import host
  // modules or access any renderer global objects.
  return `
(() => {
  'use strict';
  const SafeBlob = Blob;
  const SafeError = Error;
  const SafeMap = Map;
  const SafePromise = Promise;
  const SafeSet = Set;
  const SafeString = String;
  const SafeTypeError = TypeError;
  const SafeURL = URL;
  const safeApply = Reflect.apply;
  const safeArrayIsArray = Array.isArray;
  const safeAssign = Object.assign;
  const safeDefineProperty = Object.defineProperty;
  const safeFreeze = Object.freeze;
  const safeHasOwn = Object.prototype.hasOwnProperty;
  const safeKeys = Object.keys;
  const safeMapClear = Map.prototype.clear;
  const safeMapDelete = Map.prototype.delete;
  const safeMapGet = Map.prototype.get;
  const safeMapSet = Map.prototype.set;
  const safeMapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  const safeNumberIsSafeInteger = Number.isSafeInteger;
  const safeObjectCreate = Object.create;
  const safeOwnKeys = Reflect.ownKeys;
  const safePromiseCatch = Promise.prototype.catch;
  const safePromiseReject = Promise.reject;
  const safeRegExpTest = RegExp.prototype.test;
  const safeSetAdd = Set.prototype.add;
  const safeSetClear = Set.prototype.clear;
  const safeSetDelete = Set.prototype.delete;
  const safeSetForEach = Set.prototype.forEach;
  const safeSetHas = Set.prototype.has;
  const safeSetSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
  const safeStringCharCodeAt = String.prototype.charCodeAt;
  const safeStringIncludes = String.prototype.includes;
  const safeStringReplace = String.prototype.replace;
  const safeStringSlice = String.prototype.slice;
  const safeUrlCreateObjectURL = URL.createObjectURL;
  const safeUrlRevokeObjectURL = URL.revokeObjectURL;
  const nativePortPostMessage = self.MessagePort && self.MessagePort.prototype.postMessage;
  const cloneData = (${createExtensionDataCloner.toString()})();

  function apply(method, receiver, args) {
    return safeApply(method, receiver, args);
  }

  function freeze(value) {
    return safeFreeze(value);
  }

  function hasOwn(value, key) {
    return apply(safeHasOwn, value, [key]);
  }

  function mapClear(value) { apply(safeMapClear, value, []); }
  function mapDelete(value, key) { return apply(safeMapDelete, value, [key]); }
  function mapGet(value, key) { return apply(safeMapGet, value, [key]); }
  function mapSet(value, key, item) { apply(safeMapSet, value, [key, item]); }
  function mapSize(value) { return apply(safeMapSize, value, []); }
  function matches(pattern, value) { return apply(safeRegExpTest, pattern, [value]); }
  function rejectPromise(error) { return apply(safePromiseReject, SafePromise, [error]); }
  function setAdd(value, item) { apply(safeSetAdd, value, [item]); }
  function setClear(value) { apply(safeSetClear, value, []); }
  function setDelete(value, item) { return apply(safeSetDelete, value, [item]); }
  function setHas(value, item) { return apply(safeSetHas, value, [item]); }
  function setSize(value) { return apply(safeSetSize, value, []); }
  function setSnapshot(value) {
    const result = [];
    apply(safeSetForEach, value, [(item) => { result[result.length] = item; }]);
    return result;
  }
  function ignoreRejection(promise) {
    apply(safePromiseCatch, promise, [() => {}]);
  }

  function utf8ByteLength(value, maxBytes) {
    let bytes = 0;
    for (let position = 0; position < value.length; position += 1) {
      const code = apply(safeStringCharCodeAt, value, [position]);
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && position + 1 < value.length) {
        const next = apply(safeStringCharCodeAt, value, [position + 1]);
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

  // Defense in depth for direct network/process-like browser APIs. CSP still
  // enforces this boundary for module imports and any future browser API.
  const blockedError = () => new SafeError('Direct extension network access is disabled.');
  const blockedFetch = () => rejectPromise(blockedError());
  const BlockedConstructor = function() { throw blockedError(); };
  for (const name of [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection',
    'importScripts', 'Worker', 'SharedWorker'
  ]) {
    try {
      safeDefineProperty(self, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: name === 'fetch' ? blockedFetch : BlockedConstructor
      });
    } catch (_) {}
  }
  try {
    if (self.navigator && typeof self.navigator.sendBeacon === 'function') {
      safeDefineProperty(self.navigator, 'sendBeacon', { configurable: false, writable: false, value: () => false });
    }
  } catch (_) {}
  const VERSION = ${EXTENSION_PROTOCOL_VERSION};
  const errorCodePattern = /^[A-Za-z][A-Za-z0-9._-]*$/;
  const TYPE = {
    CONNECT: ${JSON.stringify(ExtensionMessageType.CONNECT)},
    INITIALIZE: ${JSON.stringify(ExtensionMessageType.INITIALIZE)},
    ACTIVATED: ${JSON.stringify(ExtensionMessageType.ACTIVATED)},
    ACTIVATION_FAILED: ${JSON.stringify(ExtensionMessageType.ACTIVATION_FAILED)},
    REQUEST: ${JSON.stringify(ExtensionMessageType.REQUEST)},
    RESPONSE: ${JSON.stringify(ExtensionMessageType.RESPONSE)},
    FATAL: ${JSON.stringify(ExtensionMessageType.FATAL)}
  };
  const HOST_METHOD = {
    COMMAND_REGISTER: 'commands.register',
    COMMAND_DISPOSE: 'commands.dispose',
    COMMAND_EXECUTE: 'commands.execute',
    CONTRIBUTION_REGISTER: 'contributions.register',
    CONTRIBUTION_DISPOSE: 'contributions.dispose',
    SOURCE_CONTROL_REGISTER: 'sourceControl.register',
    SOURCE_CONTROL_SET_STATE: 'sourceControl.setState',
    SOURCE_CONTROL_CLEAR_STATE: 'sourceControl.clearState',
    SOURCE_CONTROL_DISPOSE: 'sourceControl.dispose',
    SCM_GIT_REQUEST: 'scm.git.request',
    FILE_DECORATIONS_SCM_REGISTER: 'fileDecorations.scm.register',
    FILE_DECORATIONS_SCM_SET: 'fileDecorations.scm.set',
    FILE_DECORATIONS_SCM_CLEAR: 'fileDecorations.scm.clear',
    FILE_DECORATIONS_SCM_DISPOSE: 'fileDecorations.scm.dispose',
    DOCUMENT_VIEW_REGISTER: 'documentViews.register',
    DOCUMENT_VIEW_DISPOSE: 'documentViews.dispose',
    AGENT_REGISTER: 'agents.register',
    AGENT_SET_STATE: 'agents.setState',
    AGENT_UPDATE_STATE: 'agents.updateState',
    AGENT_CLEAR_STATE: 'agents.clearState',
    AGENT_DISPOSE: 'agents.dispose',
    AGENT_BROKER_REQUEST: 'agent.broker.request',
    SERVICE_GET: 'services.get',
    BROKER_REQUEST: 'host.request'
  };
  const SANDBOX_METHOD = {
    COMMAND_INVOKE: 'command.invoke',
    I18N_CHANGED: 'i18n.changed',
    AGENT_MODEL_EVENT: 'models.event',
    DEACTIVATE: 'extension.deactivate'
  };
  const AGENT_REQUEST_CLONE_OPTIONS = freeze({
    maxStringLength: 1024 * 1024,
    maxItems: 8192,
    maxBytes: 2 * 1024 * 1024
  });
  const AGENT_RESULT_CLONE_OPTIONS = freeze({
    maxStringLength: 2 * 1024 * 1024,
    maxItems: 8192,
    maxBytes: 8 * 1024 * 1024
  });
  const MAX_EXTENSION_SOURCE_BYTES = 5 * 1024 * 1024;
  let port = null;
  let sequence = 0;
  let extensionModule = null;
  let activated = false;
  let initializationPromise = null;
  let deactivationPromise = null;
  let deactivated = false;
  const pending = new SafeMap();
  const incomingRequests = new SafeSet();
  const commandHandlers = new SafeMap();
  const modelStreamListeners = new SafeMap();
  const subscriptions = new SafeSet();
  let localization = freeze({ locale: 'en', messages: freeze(safeObjectCreate(null)) });
  const localizationListeners = new SafeSet();

  function errorValue(error, fallbackCode) {
    const fallback = typeof fallbackCode === 'string' && matches(errorCodePattern, fallbackCode) && fallbackCode.length <= 160
      ? fallbackCode
      : 'EXTENSION_UNAVAILABLE';
    const code = error && typeof error.code === 'string' && matches(errorCodePattern, error.code) && error.code.length <= 160
      ? error.code
      : fallback;
    return {
      code,
      message: error && typeof error.message === 'string' && error.message
        ? apply(safeStringSlice, error.message, [0, 8192])
        : 'Extension operation failed.'
    };
  }

  function fail(code, message) {
    const error = new SafeError(message);
    error.code = code;
    return error;
  }

  function post(message) {
    if (!port || typeof nativePortPostMessage !== 'function') {
      throw fail('EXTENSION_UNAVAILABLE', 'Extension host channel is unavailable.');
    }
    apply(nativePortPostMessage, port, [safeAssign({ protocolVersion: VERSION }, message)]);
  }

  function cloneOptions(method) {
    return method === HOST_METHOD.AGENT_BROKER_REQUEST
      ? AGENT_REQUEST_CLONE_OPTIONS
      : undefined;
  }

  function responseCloneOptions(method) {
    return method === HOST_METHOD.AGENT_BROKER_REQUEST
      ? AGENT_RESULT_CLONE_OPTIONS
      : undefined;
  }

  function inboundCloneOptions(method) {
    return method === SANDBOX_METHOD.AGENT_MODEL_EVENT
      ? AGENT_RESULT_CLONE_OPTIONS
      : undefined;
  }

  function request(method, args) {
    if (deactivated) {
      return rejectPromise(fail('EXTENSION_CANCELLED', 'Extension is being deactivated.'));
    }
    if (mapSize(pending) >= 32) {
      return rejectPromise(fail('EXTENSION_UNAVAILABLE', 'Extension request concurrency limit reached.'));
    }
    const id = ++sequence;
    return new SafePromise((resolve, reject) => {
      mapSet(pending, id, { resolve, reject, method });
      try {
        const value = cloneData(args === undefined ? null : args, cloneOptions(method));
        post({ type: TYPE.REQUEST, id, method, args: value });
      } catch (error) {
        mapDelete(pending, id);
        reject(error);
      }
    });
  }

  // Only an omitted SCM argument object means "no optional fields". Do not
  // coerce falsy values such as false or an empty string into an empty request:
  // the privileged host must receive those values and reject them structurally.
  function scmRequest(operation, args) {
    return request(HOST_METHOD.SCM_GIT_REQUEST, {
      operation,
    args: args === undefined ? {} : args
    });
  }

  function agentBrokerRequest(method, args) {
    return request(HOST_METHOD.AGENT_BROKER_REQUEST, { method, args: args === undefined ? {} : args });
  }

  function normalizeLocalization(value) {
    if (!value || typeof value !== 'object' || safeArrayIsArray(value) ||
        !value.messages || typeof value.messages !== 'object' || safeArrayIsArray(value.messages)) {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Plugin localization payload is invalid.');
    }
    const locale = value.locale === 'zh-CN' || value.locale === 'ja' || value.locale === 'en' ? value.locale : 'en';
    const messages = safeObjectCreate(null);
    const keys = safeKeys(value.messages);
    if (keys.length > 1024) throw fail('EXTENSION_PROTOCOL_ERROR', 'Plugin localization payload is too large.');
    for (let position = 0; position < keys.length; position += 1) {
      const key = keys[position];
      const message = value.messages[key];
      if (!key || key.length > 160 || apply(safeStringIncludes, key, ['\\0']) ||
          typeof message !== 'string' || message.length > 8192) {
        throw fail('EXTENSION_PROTOCOL_ERROR', 'Plugin localization payload contains an invalid string.');
      }
      messages[key] = message;
    }
    return freeze({ locale, messages: freeze(messages) });
  }

  function interpolate(message, values) {
    if (!values || typeof values !== 'object' || safeArrayIsArray(values)) return message;
    return apply(safeStringReplace, message, [/\\{([A-Za-z0-9_]+)\\}/g, (match, key) => (
      hasOwn(values, key) ? SafeString(values[key]) : match
    )]);
  }

  function updateLocalization(value) {
    localization = normalizeLocalization(value);
    const listeners = setSnapshot(localizationListeners);
    for (let position = 0; position < listeners.length; position += 1) {
      try { listeners[position](freeze({ locale: localization.locale })); } catch (_) {}
    }
  }

  function pluginI18n() {
    return freeze({
      get locale() { return localization.locale; },
      t(key, values) {
        const source = SafeString(key == null ? '' : key);
        const message = hasOwn(localization.messages, source)
          ? localization.messages[source]
          : source;
        return interpolate(message, values);
      },
      onDidChange(listener) {
        if (typeof listener !== 'function') throw new SafeTypeError('Plugin i18n listener must be a function.');
        let active = true;
        setAdd(localizationListeners, listener);
        return freeze({
          dispose() {
            if (!active) return;
            active = false;
            setDelete(localizationListeners, listener);
          }
        });
      }
    });
  }

  function makeDisposable(dispose) {
    let active = true;
    const disposable = freeze({
      dispose() {
        if (!active) return;
        active = false;
        setDelete(subscriptions, disposable);
        try { dispose(); } catch (_) {}
      }
    });
    return disposable;
  }

  function addSubscription(value) {
    if (!value || typeof value.dispose !== 'function') {
      throw new SafeTypeError('Extension subscriptions accept disposables only.');
    }
    setAdd(subscriptions, value);
    return value;
  }

  function disposeSubscriptions() {
    const values = setSnapshot(subscriptions);
    setClear(subscriptions);
    for (let position = values.length - 1; position >= 0; position -= 1) {
      try { values[position].dispose(); } catch (_) {}
    }
  }

  function createContext(init) {
    const extension = freeze({ id: init.extension.id, version: init.extension.version });
    const context = {
      apiVersion: init.apiVersion,
      extension,
      subscriptions: freeze({ add: addSubscription }),
      i18n: pluginI18n(),
      commands: freeze({
        async register(id, handler, metadata) {
          if (typeof handler !== 'function') throw new SafeTypeError('Command handler must be a function.');
          const handlerId = 'handler-' + (++sequence);
          mapSet(commandHandlers, handlerId, handler);
          try {
            const result = await request(HOST_METHOD.COMMAND_REGISTER, {
              id,
              handlerId,
              metadata: metadata || {}
            });
            const disposable = makeDisposable(() => {
              mapDelete(commandHandlers, handlerId);
              ignoreRejection(request(HOST_METHOD.COMMAND_DISPOSE, { handle: result.handle }));
            });
            addSubscription(disposable);
            return disposable;
          } catch (error) {
            mapDelete(commandHandlers, handlerId);
            throw error;
          }
        },
        execute(id, ...args) {
          return request(HOST_METHOD.COMMAND_EXECUTE, { id, args });
        }
      }),
      contributions: freeze({
        async register(point, contribution, options) {
          const result = await request(HOST_METHOD.CONTRIBUTION_REGISTER, {
            point,
            contribution,
            options: options || {}
          });
          const disposable = makeDisposable(() => {
            ignoreRejection(request(HOST_METHOD.CONTRIBUTION_DISPOSE, { handle: result.handle }));
          });
          addSubscription(disposable);
          return disposable;
        }
      }),
      sourceControl: freeze({
        async register(descriptor) {
          const result = await request(HOST_METHOD.SOURCE_CONTROL_REGISTER, descriptor);
          let active = true;
          const requireActive = () => {
            if (!active) throw fail('EXTENSION_CANCELLED', 'Source-control state provider has been disposed.');
          };
          const provider = freeze({
            id: typeof result.id === 'string' ? result.id : descriptor && descriptor.id,
            setState(state) {
              requireActive();
              return request(HOST_METHOD.SOURCE_CONTROL_SET_STATE, { handle: result.handle, state });
            },
            clearState() {
              requireActive();
              return request(HOST_METHOD.SOURCE_CONTROL_CLEAR_STATE, { handle: result.handle });
            },
            dispose() {
              if (!active) return;
              active = false;
              setDelete(subscriptions, provider);
              ignoreRejection(request(HOST_METHOD.SOURCE_CONTROL_DISPOSE, { handle: result.handle }));
            }
          });
          addSubscription(provider);
          return provider;
        }
      }),
      fileDecorations: freeze({
        async registerScm(options) {
          const result = await request(HOST_METHOD.FILE_DECORATIONS_SCM_REGISTER, options);
          let active = true;
          const requireActive = () => {
            if (!active) throw fail('EXTENSION_CANCELLED', 'SCM decoration provider has been disposed.');
          };
          const provider = freeze({
            set(entries) {
              requireActive();
              return request(HOST_METHOD.FILE_DECORATIONS_SCM_SET, { handle: result.handle, entries });
            },
            clear(paths) {
              requireActive();
              return request(HOST_METHOD.FILE_DECORATIONS_SCM_CLEAR, paths === undefined ? { handle: result.handle } : { handle: result.handle, paths });
            },
            dispose() {
              if (!active) return;
              active = false;
              setDelete(subscriptions, provider);
              ignoreRejection(request(HOST_METHOD.FILE_DECORATIONS_SCM_DISPOSE, { handle: result.handle }));
            }
          });
          addSubscription(provider);
          return provider;
        }
      }),
      documentViews: freeze({
        async register(descriptor) {
          const result = await request(HOST_METHOD.DOCUMENT_VIEW_REGISTER, descriptor);
          const disposable = makeDisposable(() => {
            ignoreRejection(request(HOST_METHOD.DOCUMENT_VIEW_DISPOSE, { handle: result.handle }));
          });
          addSubscription(disposable);
          return disposable;
        }
      }),
      agents: freeze({
        async register(descriptor) {
          const result = await request(HOST_METHOD.AGENT_REGISTER, descriptor);
          let active = true;
          const requireActive = () => {
            if (!active) throw fail('EXTENSION_CANCELLED', 'Agent provider has been disposed.');
          };
          const provider = freeze({
            id: typeof result.id === 'string' ? result.id : descriptor && descriptor.id,
            setState(state) {
              requireActive();
              return request(HOST_METHOD.AGENT_SET_STATE, { handle: result.handle, state });
            },
            updateState(patch) {
              requireActive();
              return request(HOST_METHOD.AGENT_UPDATE_STATE, { handle: result.handle, patch });
            },
            clearState() {
              requireActive();
              return request(HOST_METHOD.AGENT_CLEAR_STATE, { handle: result.handle });
            },
            dispose() {
              if (!active) return;
              active = false;
              setDelete(subscriptions, provider);
              ignoreRejection(request(HOST_METHOD.AGENT_DISPOSE, { handle: result.handle }));
            }
          });
          addSubscription(provider);
          return provider;
        }
      }),
      models: freeze({
        list: () => agentBrokerRequest('models.list'),
        generate: (args) => agentBrokerRequest('models.generate', args),
        generateStream(args, onEvent) {
          if (!args || typeof args !== 'object' || safeArrayIsArray(args) ||
              typeof args.requestId !== 'string' || !matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, args.requestId)) {
            throw new SafeTypeError('Streaming model requests require a valid requestId.');
          }
          if (typeof onEvent !== 'function') throw new SafeTypeError('Streaming model requests require an event listener.');
          if (mapGet(modelStreamListeners, args.requestId)) {
            throw fail('EXTENSION_INVALID_REQUEST', 'Streaming model request id is already active.');
          }
          mapSet(modelStreamListeners, args.requestId, onEvent);
          const operation = agentBrokerRequest('models.generateStream', args);
          return apply(safePromiseCatch, operation, [(error) => {
            mapDelete(modelStreamListeners, args.requestId);
            throw error;
          }]);
        },
        cancel: (requestId) => agentBrokerRequest('models.cancel', { requestId })
      }),
      tools: freeze({
        list: () => agentBrokerRequest('agent.tools.list'),
        invoke: (tool, input) => agentBrokerRequest('agent.tools.invoke', { tool, input: input || {} })
      }),
      skills: freeze({
        list: () => agentBrokerRequest('agent.skills.list'),
        read: (skillId, revision) => agentBrokerRequest('agent.skills.read', { skillId, revision })
      }),
      storage: freeze({
        read: () => agentBrokerRequest('agent.storage.read'),
        write: (value) => agentBrokerRequest('agent.storage.write', { value })
      }),
      scm: freeze({
        git: freeze({
          detect: (args) => scmRequest('detect', args),
          status: (args) => scmRequest('status', args),
          history: (args) => scmRequest('history', args),
          diff: (args) => scmRequest('diff', args),
          branches: (args) => scmRequest('branches', args),
          remotes: (args) => scmRequest('remotes', args),
          clone: (args) => scmRequest('clone', args),
          init: (args) => scmRequest('init', args),
          setRemote: (args) => scmRequest('setRemote', args),
          stage: (args) => scmRequest('stage', args),
          stageAll: (args) => scmRequest('stageAll', args),
          unstage: (args) => scmRequest('unstage', args),
          commit: (args) => scmRequest('commit', args),
          checkout: (args) => scmRequest('checkout', args),
          createBranch: (args) => scmRequest('createBranch', args),
          deleteBranch: (args) => scmRequest('deleteBranch', args),
          fetch: (args) => scmRequest('fetch', args),
          pull: (args) => scmRequest('pull', args),
          push: (args) => scmRequest('push', args)
        })
      }),
      services: freeze({
        get(id) {
          return request(HOST_METHOD.SERVICE_GET, { id });
        }
      }),
      host: freeze({
        request(method, args) {
          return request(HOST_METHOD.BROKER_REQUEST, { method, args: args === undefined ? null : args });
        }
      })
    };
    return freeze(context);
  }

  async function initialize(message) {
    if (activated || extensionModule) throw fail('EXTENSION_PROTOCOL_ERROR', 'Extension was initialized more than once.');
    if (!message.extension || typeof message.extension.id !== 'string' || typeof message.source !== 'string') {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Extension initialization payload is invalid.');
    }
    if (utf8ByteLength(message.source, MAX_EXTENSION_SOURCE_BYTES) > MAX_EXTENSION_SOURCE_BYTES) {
      throw fail('EXTENSION_INVALID_REQUEST', 'Extension entry exceeds the 5 MiB host limit.');
    }
    updateLocalization(message.localization || { locale: 'en', messages: {} });
    const sourceUrl = apply(safeUrlCreateObjectURL, SafeURL, [new SafeBlob([message.source], { type: 'text/javascript' })]);
    try {
      extensionModule = await import(sourceUrl);
    } finally {
      apply(safeUrlRevokeObjectURL, SafeURL, [sourceUrl]);
    }
    if (deactivated) throw fail('EXTENSION_CANCELLED', 'Extension activation was cancelled.');
    if (!extensionModule || typeof extensionModule.activate !== 'function') {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Extension entry must export activate(context).');
    }
    const result = await apply(extensionModule.activate, undefined, [createContext(message)]);
    if (typeof result === 'function') addSubscription(makeDisposable(result));
    else if (result && typeof result.dispose === 'function') addSubscription(result);
    if (deactivated) throw fail('EXTENSION_CANCELLED', 'Extension activation was cancelled.');
    activated = true;
    post({ type: TYPE.ACTIVATED });
  }

  async function invokeCommand(args) {
    if (!args || typeof args.handlerId !== 'string') {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Command invocation payload is invalid.');
    }
    const handler = mapGet(commandHandlers, args.handlerId);
    if (!handler) throw fail('EXTENSION_NOT_FOUND', 'Extension command handler is no longer available.');
    return apply(handler, undefined, safeArrayIsArray(args.args) ? args.args : []);
  }

  async function deliverModelEvent(args) {
    if (!args || typeof args !== 'object' || safeArrayIsArray(args) ||
        typeof args.requestId !== 'string' || !safeNumberIsSafeInteger(args.sequence) ||
        args.sequence < 1 || !args.event || typeof args.event !== 'object' || safeArrayIsArray(args.event)) {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Streaming model event payload is invalid.');
    }
    const listener = mapGet(modelStreamListeners, args.requestId);
    if (!listener) return null;
    const event = freeze(cloneData(args.event, AGENT_RESULT_CLONE_OPTIONS));
    await apply(listener, undefined, [event]);
    if (event.type === 'response.completed' || event.type === 'response.error') {
      mapDelete(modelStreamListeners, args.requestId);
    }
    return null;
  }

  function deactivate() {
    if (deactivationPromise) return deactivationPromise;
    deactivated = true;
    deactivationPromise = (async () => {
      try {
        if (initializationPromise) {
          try { await initializationPromise; } catch (_) {}
        }
        if (extensionModule && typeof extensionModule.deactivate === 'function') {
          await apply(extensionModule.deactivate, undefined, []);
        }
      } finally {
        disposeSubscriptions();
        mapClear(commandHandlers);
        mapClear(modelStreamListeners);
        setClear(localizationListeners);
        activated = false;
      }
      return null;
    })();
    return deactivationPromise;
  }

  async function handleHostRequest(message) {
    if (deactivated && message.method !== SANDBOX_METHOD.DEACTIVATE) {
      throw fail('EXTENSION_CANCELLED', 'Extension is being deactivated.');
    }
    if (message.method === SANDBOX_METHOD.COMMAND_INVOKE) return invokeCommand(message.args);
    if (message.method === SANDBOX_METHOD.AGENT_MODEL_EVENT) return deliverModelEvent(message.args);
    if (message.method === SANDBOX_METHOD.I18N_CHANGED) {
      updateLocalization(message.args);
      return null;
    }
    if (message.method === SANDBOX_METHOD.DEACTIVATE) return deactivate();
    throw fail('EXTENSION_PROTOCOL_ERROR', 'Unsupported host request.');
  }

  function handleResponse(message) {
    const pendingRequest = mapGet(pending, message.id);
    if (!pendingRequest) return;
    mapDelete(pending, message.id);
    if (message.ok === true) {
      try {
        pendingRequest.resolve(cloneData(message.value, responseCloneOptions(pendingRequest.method)));
      } catch (error) {
        pendingRequest.reject(error);
      }
      return;
    }
    pendingRequest.reject(fail(message.error.code, message.error.message));
  }

  function hasExactKeys(value, allowed) {
    const keys = safeOwnKeys(value);
    if (keys.length !== allowed.length) return false;
    for (let position = 0; position < keys.length; position += 1) {
      const key = keys[position];
      if (typeof key !== 'string') return false;
      let found = false;
      for (let candidate = 0; candidate < allowed.length; candidate += 1) {
        if (allowed[candidate] === key) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  function validError(value) {
    return value && typeof value === 'object' && !safeArrayIsArray(value) &&
      hasExactKeys(value, ['code', 'message']) && typeof value.code === 'string' &&
      matches(errorCodePattern, value.code) && value.code.length <= 160 &&
      typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 8192;
  }

  function validRequestId(value) {
    return (safeNumberIsSafeInteger(value) && value >= 1) ||
      (typeof value === 'string' && matches(/^[A-Za-z0-9_-]{1,96}$/, value));
  }

  function validHostMessage(message) {
    if (!message || typeof message !== 'object' || safeArrayIsArray(message) ||
        message.protocolVersion !== VERSION || typeof message.type !== 'string') return false;
    if (message.type === TYPE.INITIALIZE) {
      return hasExactKeys(message, ['protocolVersion', 'type', 'extension', 'apiVersion', 'source', 'localization']) &&
        message.extension && typeof message.extension === 'object' && !safeArrayIsArray(message.extension) &&
        hasExactKeys(message.extension, ['id', 'version']) && typeof message.extension.id === 'string' &&
        typeof message.extension.version === 'string' && typeof message.apiVersion === 'string' &&
        typeof message.source === 'string';
    }
    if (message.type === TYPE.RESPONSE) {
      if (!validRequestId(message.id) || typeof message.ok !== 'boolean') return false;
      return message.ok === true
        ? hasExactKeys(message, ['protocolVersion', 'type', 'id', 'ok', 'value'])
        : hasExactKeys(message, ['protocolVersion', 'type', 'id', 'ok', 'error']) && validError(message.error);
    }
    if (message.type === TYPE.REQUEST) {
      return hasExactKeys(message, ['protocolVersion', 'type', 'id', 'method', 'args']) &&
        validRequestId(message.id) && typeof message.method === 'string' &&
        message.method.length > 0 && message.method.length <= 160;
    }
    return false;
  }

  async function respondToHostRequest(message) {
    if (setHas(incomingRequests, message.id) || setSize(incomingRequests) >= 32) {
      post({
        type: TYPE.RESPONSE,
        id: message.id,
        ok: false,
        error: errorValue(fail('EXTENSION_UNAVAILABLE', 'Extension request concurrency limit reached.'))
      });
      return;
    }
    setAdd(incomingRequests, message.id);
    try {
      const args = cloneData(message.args, inboundCloneOptions(message.method));
      const value = await handleHostRequest({ method: message.method, args });
      post({ type: TYPE.RESPONSE, id: message.id, ok: true, value: cloneData(value) });
    } catch (error) {
      post({ type: TYPE.RESPONSE, id: message.id, ok: false, error: errorValue(error) });
    } finally {
      setDelete(incomingRequests, message.id);
    }
  }

  function protocolFatal(message) {
    try {
      post({ type: TYPE.FATAL, error: errorValue(fail('EXTENSION_PROTOCOL_ERROR', message)) });
    } catch (_) {}
  }

  function handleMessage(message) {
    if (!validHostMessage(message)) {
      protocolFatal('Malformed extension host message.');
      return;
    }
    if (message.type === TYPE.INITIALIZE) {
      if (initializationPromise || activated || extensionModule) {
        protocolFatal('Extension was initialized more than once.');
        return;
      }
      initializationPromise = initialize(message);
      apply(safePromiseCatch, initializationPromise, [(error) => {
        post({ type: TYPE.ACTIVATION_FAILED, error: errorValue(error) });
      }]);
      return;
    }
    if (message.type === TYPE.RESPONSE) {
      handleResponse(message);
      return;
    }
    if (message.type === TYPE.REQUEST) {
      void respondToHostRequest(message);
    }
  }

  self.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== TYPE.CONNECT || message.protocolVersion !== VERSION || !message.port || port) return;
    port = message.port;
    port.onmessage = (portEvent) => handleMessage(portEvent.data);
    port.onmessageerror = () => {
      try { post({ type: TYPE.FATAL, error: { code: 'EXTENSION_PROTOCOL_ERROR', message: 'Extension host channel failed.' } }); } catch (_) {}
    };
    if (typeof port.start === 'function') port.start();
  });
})();`;
}

function sandboxBootstrapSource(): string {
  const workerSource = JSON.stringify(extensionWorkerBootstrapSource());
  return `
(() => {
  'use strict';
  const VERSION = ${EXTENSION_PROTOCOL_VERSION};
  const CONNECT = ${JSON.stringify(ExtensionMessageType.CONNECT)};
  const WORKER_SOURCE = ${workerSource};
  let connected = false;
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window.parent || !message || message.type !== CONNECT ||
        message.protocolVersion !== VERSION || event.ports.length !== 1 || connected) return;
    connected = true;
    try {
      const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      const worker = new Worker(workerUrl, { name: 'bobocloud-extension-host' });
      setTimeout(() => URL.revokeObjectURL(workerUrl), 1000);
      worker.postMessage({ type: CONNECT, protocolVersion: VERSION, port: event.ports[0] }, [event.ports[0]]);
    } catch (_) {
      // The renderer-side activation timeout reports a failed sandbox without
      // exposing a second ambient channel to extension code.
    }
  });
})();`;
}

let cachedExtensionSandboxDocument: string | null = null;

export function buildExtensionSandboxDocument(): string {
  if (cachedExtensionSandboxDocument !== null) return cachedExtensionSandboxDocument;
  const source = sandboxBootstrapSource().replace(/<\/script/gi, '<\\/script');
  cachedExtensionSandboxDocument = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    EXTENSION_SANDBOX_CSP.replace(/"/g, '&quot;') + '"></head><body><script>' + source + '</script></body></html>';
  return cachedExtensionSandboxDocument;
}

function requireDocument(
  documentRef: PluginExtensionSandboxDocument | null | undefined
): PluginExtensionSandboxMountTarget {
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'The extension sandbox requires a renderer document.');
  }
  const target = documentRef.body || documentRef.documentElement;
  if (!target || typeof target.appendChild !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'The extension sandbox cannot attach to this document.');
  }
  return target;
}

export function createSandboxedExtensionSandbox(
  options: PluginExtensionSandboxOptions = {}
): PluginExtensionSandbox {
  const documentRef: PluginExtensionSandboxDocument = options.document || globalThis.document;
  const target = requireDocument(documentRef);
  const MessageChannelConstructor = options.MessageChannel || globalThis.MessageChannel;
  if (typeof MessageChannelConstructor !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'MessageChannel is unavailable for extension isolation.');
  }

  const iframe = documentRef.createElement('iframe');
  const channel = new MessageChannelConstructor();
  let disposed = false;
  let readySettled = false;
  let timeout: number | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (reason?: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function clearConnectionTimeout(): void {
    if (timeout === null) return;
    clearTimeout(timeout);
    timeout = null;
  }

  function reportFatal(error: unknown): void {
    if (typeof options.onFatal === 'function') options.onFatal(error);
  }

  function rejectConnection(error: unknown): void {
    if (readySettled || disposed) return;
    readySettled = true;
    clearConnectionTimeout();
    rejectReady(error);
    reportFatal(error);
  }

  function connect(): void {
    if (disposed || readySettled) return;
    try {
      const contentWindow = iframe.contentWindow;
      if (!contentWindow) {
        throw createExtensionError(
          ExtensionErrorCode.UNAVAILABLE,
          'Extension sandbox content window is unavailable.'
        );
      }
      contentWindow.postMessage({
        type: ExtensionMessageType.CONNECT,
        protocolVersion: EXTENSION_PROTOCOL_VERSION
      }, '*', [channel.port2]);
      readySettled = true;
      clearConnectionTimeout();
      resolveReady();
    } catch (error) {
      rejectConnection(error);
    }
  }

  function handleLoadError(): void {
    rejectConnection(createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension sandbox failed to load.'));
  }

  function cleanupTransport(): void {
    clearConnectionTimeout();
    try { iframe.removeEventListener('load', connect); } catch (_) {}
    try { iframe.removeEventListener('error', handleLoadError); } catch (_) {}
    try { channel.port1.onmessage = null; } catch (_) {}
    try { channel.port1.onmessageerror = null; } catch (_) {}
    try { channel.port1.close(); } catch (_) {}
    try { channel.port2.close(); } catch (_) {}
    try { iframe.remove(); } catch (_) {
      try {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      } catch (_) {}
    }
  }

  try {
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.referrerPolicy = 'no-referrer';
    iframe.style.cssText = 'display:none !important;position:absolute;width:0;height:0;border:0;pointer-events:none;';
    iframe.addEventListener('load', connect, { once: true });
    iframe.addEventListener('error', handleLoadError, { once: true });
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (disposed || typeof options.onMessage !== 'function') return;
      options.onMessage(event.data);
    };
    channel.port1.onmessageerror = () => {
      if (disposed) return;
      reportFatal(createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension sandbox message channel failed.'));
    };
    if (typeof channel.port1.start === 'function') channel.port1.start();
    iframe.srcdoc = buildExtensionSandboxDocument();
    target.appendChild(iframe);
  } catch (error) {
    disposed = true;
    cleanupTransport();
    throw error;
  }
  if (!readySettled && !disposed) {
    timeout = setTimeout(() => {
      rejectConnection(createExtensionError(ExtensionErrorCode.TIMEOUT, 'Extension sandbox connection timed out.'));
    }, typeof options.connectTimeoutMs === 'number' && Number.isFinite(options.connectTimeoutMs)
      ? options.connectTimeoutMs
      : CONNECT_TIMEOUT_MS);
  }

  return Object.freeze({
    ready,
    postMessage(message: ExtensionHostToSandboxMessageDto): void {
      if (disposed) throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension sandbox has been disposed.');
      channel.port1.postMessage(message);
    },
    dispose(): void {
      if (disposed) return;
      if (!readySettled) {
        readySettled = true;
        rejectReady(createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension sandbox has been disposed.'));
      }
      disposed = true;
      cleanupTransport();
    }
  });
}
