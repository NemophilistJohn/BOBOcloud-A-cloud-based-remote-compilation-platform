import {
  EXTENSION_PROTOCOL_VERSION,
  ExtensionErrorCode,
  ExtensionMessageType,
  createExtensionError
} from './plugin-extension-protocol.js';

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

function extensionWorkerBootstrapSource() {
  // Keep this self-contained: the worker intentionally cannot import host
  // modules or access any renderer global objects.
  return `
(() => {
  'use strict';
  // Defense in depth for direct network/process-like browser APIs. CSP still
  // enforces this boundary for module imports and any future browser API.
  const blockedError = () => new Error('Direct extension network access is disabled.');
  const blockedFetch = () => Promise.reject(blockedError());
  const BlockedConstructor = function() { throw blockedError(); };
  for (const name of [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection',
    'importScripts', 'Worker', 'SharedWorker'
  ]) {
    try {
      Object.defineProperty(self, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: name === 'fetch' ? blockedFetch : BlockedConstructor
      });
    } catch (_) {}
  }
  try {
    if (self.navigator && typeof self.navigator.sendBeacon === 'function') {
      Object.defineProperty(self.navigator, 'sendBeacon', { configurable: false, writable: false, value: () => false });
    }
  } catch (_) {}
  const VERSION = ${EXTENSION_PROTOCOL_VERSION};
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
    SERVICE_GET: 'services.get',
    BROKER_REQUEST: 'host.request'
  };
  const SANDBOX_METHOD = {
    COMMAND_INVOKE: 'command.invoke',
    I18N_CHANGED: 'i18n.changed',
    DEACTIVATE: 'extension.deactivate'
  };
  let port = null;
  let sequence = 0;
  let extensionModule = null;
  let activated = false;
  let deactivated = false;
  const pending = new Map();
  const commandHandlers = new Map();
  const subscriptions = new Set();
  let localization = Object.freeze({ locale: 'en', messages: Object.freeze(Object.create(null)) });
  const localizationListeners = new Set();

  function errorValue(error, fallbackCode) {
    return {
      code: error && typeof error.code === 'string' && error.code ? error.code : fallbackCode || 'EXTENSION_UNAVAILABLE',
      message: error && typeof error.message === 'string' && error.message ? error.message.slice(0, 65536) : 'Extension operation failed.'
    };
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function post(message) {
    if (!port) throw fail('EXTENSION_UNAVAILABLE', 'Extension host channel is unavailable.');
    port.postMessage(Object.assign({ protocolVersion: VERSION }, message));
  }

  function request(method, args) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        post({ type: TYPE.REQUEST, id, method, args: args === undefined ? null : args });
      } catch (error) {
        pending.delete(id);
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

  function normalizeLocalization(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !value.messages || typeof value.messages !== 'object' || Array.isArray(value.messages)) {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Plugin localization payload is invalid.');
    }
    const locale = value.locale === 'zh-CN' || value.locale === 'ja' || value.locale === 'en' ? value.locale : 'en';
    const messages = Object.create(null);
    const keys = Object.keys(value.messages);
    if (keys.length > 1024) throw fail('EXTENSION_PROTOCOL_ERROR', 'Plugin localization payload is too large.');
    for (const key of keys) {
      const message = value.messages[key];
      if (!key || key.length > 160 || key.includes('\\0') || typeof message !== 'string' || message.length > 8192) {
        throw fail('EXTENSION_PROTOCOL_ERROR', 'Plugin localization payload contains an invalid string.');
      }
      messages[key] = message;
    }
    return Object.freeze({ locale, messages: Object.freeze(messages) });
  }

  function interpolate(message, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return message;
    return message.replace(/\\{([A-Za-z0-9_]+)\\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    ));
  }

  function updateLocalization(value) {
    localization = normalizeLocalization(value);
    for (const listener of Array.from(localizationListeners)) {
      try { listener(Object.freeze({ locale: localization.locale })); } catch (_) {}
    }
  }

  function pluginI18n() {
    return Object.freeze({
      get locale() { return localization.locale; },
      t(key, values) {
        const source = String(key == null ? '' : key);
        const message = Object.prototype.hasOwnProperty.call(localization.messages, source)
          ? localization.messages[source]
          : source;
        return interpolate(message, values);
      },
      onDidChange(listener) {
        if (typeof listener !== 'function') throw new TypeError('Plugin i18n listener must be a function.');
        let active = true;
        localizationListeners.add(listener);
        return Object.freeze({
          dispose() {
            if (!active) return;
            active = false;
            localizationListeners.delete(listener);
          }
        });
      }
    });
  }

  function makeDisposable(dispose) {
    let active = true;
    return Object.freeze({
      dispose() {
        if (!active) return;
        active = false;
        try { dispose(); } catch (_) {}
      }
    });
  }

  function addSubscription(value) {
    if (!value || typeof value.dispose !== 'function') {
      throw new TypeError('Extension subscriptions accept disposables only.');
    }
    subscriptions.add(value);
    return value;
  }

  function disposeSubscriptions() {
    const values = Array.from(subscriptions).reverse();
    subscriptions.clear();
    for (const value of values) {
      try { value.dispose(); } catch (_) {}
    }
  }

  function createContext(init) {
    const extension = Object.freeze({ id: init.extension.id, version: init.extension.version });
    const context = {
      apiVersion: init.apiVersion,
      extension,
      subscriptions: Object.freeze({ add: addSubscription }),
      i18n: pluginI18n(),
      commands: Object.freeze({
        async register(id, handler, metadata) {
          if (typeof handler !== 'function') throw new TypeError('Command handler must be a function.');
          const handlerId = 'handler-' + (++sequence);
          commandHandlers.set(handlerId, handler);
          try {
            const result = await request(HOST_METHOD.COMMAND_REGISTER, {
              id,
              handlerId,
              metadata: metadata || {}
            });
            const disposable = makeDisposable(() => {
              commandHandlers.delete(handlerId);
              request(HOST_METHOD.COMMAND_DISPOSE, { handle: result.handle }).catch(() => {});
            });
            addSubscription(disposable);
            return disposable;
          } catch (error) {
            commandHandlers.delete(handlerId);
            throw error;
          }
        },
        execute(id, ...args) {
          return request(HOST_METHOD.COMMAND_EXECUTE, { id, args });
        }
      }),
      contributions: Object.freeze({
        async register(point, contribution, options) {
          const result = await request(HOST_METHOD.CONTRIBUTION_REGISTER, {
            point,
            contribution,
            options: options || {}
          });
          const disposable = makeDisposable(() => {
            request(HOST_METHOD.CONTRIBUTION_DISPOSE, { handle: result.handle }).catch(() => {});
          });
          addSubscription(disposable);
          return disposable;
        }
      }),
      sourceControl: Object.freeze({
        async register(descriptor) {
          const result = await request(HOST_METHOD.SOURCE_CONTROL_REGISTER, descriptor);
          let active = true;
          const requireActive = () => {
            if (!active) throw fail('EXTENSION_CANCELLED', 'Source-control state provider has been disposed.');
          };
          const provider = Object.freeze({
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
              request(HOST_METHOD.SOURCE_CONTROL_DISPOSE, { handle: result.handle }).catch(() => {});
            }
          });
          addSubscription(provider);
          return provider;
        }
      }),
      fileDecorations: Object.freeze({
        async registerScm(options) {
          const result = await request(HOST_METHOD.FILE_DECORATIONS_SCM_REGISTER, options);
          let active = true;
          const requireActive = () => {
            if (!active) throw fail('EXTENSION_CANCELLED', 'SCM decoration provider has been disposed.');
          };
          const provider = Object.freeze({
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
              request(HOST_METHOD.FILE_DECORATIONS_SCM_DISPOSE, { handle: result.handle }).catch(() => {});
            }
          });
          addSubscription(provider);
          return provider;
        }
      }),
      scm: Object.freeze({
        git: Object.freeze({
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
      services: Object.freeze({
        get(id) {
          return request(HOST_METHOD.SERVICE_GET, { id });
        }
      }),
      host: Object.freeze({
        request(method, args) {
          return request(HOST_METHOD.BROKER_REQUEST, { method, args: args === undefined ? null : args });
        }
      })
    };
    return Object.freeze(context);
  }

  async function initialize(message) {
    if (activated || extensionModule) throw fail('EXTENSION_PROTOCOL_ERROR', 'Extension was initialized more than once.');
    if (!message.extension || typeof message.extension.id !== 'string' || typeof message.source !== 'string') {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Extension initialization payload is invalid.');
    }
    if (message.source.length > 5 * 1024 * 1024) {
      throw fail('EXTENSION_INVALID_REQUEST', 'Extension entry exceeds the 5 MiB host limit.');
    }
    updateLocalization(message.localization || { locale: 'en', messages: {} });
    const sourceUrl = URL.createObjectURL(new Blob([message.source], { type: 'text/javascript' }));
    try {
      extensionModule = await import(sourceUrl);
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
    if (!extensionModule || typeof extensionModule.activate !== 'function') {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Extension entry must export activate(context).');
    }
    const result = await extensionModule.activate(createContext(message));
    if (typeof result === 'function') addSubscription(makeDisposable(result));
    else if (result && typeof result.dispose === 'function') addSubscription(result);
    activated = true;
    post({ type: TYPE.ACTIVATED });
  }

  async function invokeCommand(args) {
    if (!args || typeof args.handlerId !== 'string') {
      throw fail('EXTENSION_PROTOCOL_ERROR', 'Command invocation payload is invalid.');
    }
    const handler = commandHandlers.get(args.handlerId);
    if (!handler) throw fail('EXTENSION_NOT_FOUND', 'Extension command handler is no longer available.');
    return handler.apply(undefined, Array.isArray(args.args) ? args.args : []);
  }

  async function deactivate() {
    if (deactivated) return null;
    deactivated = true;
    try {
      if (extensionModule && typeof extensionModule.deactivate === 'function') {
        await extensionModule.deactivate();
      }
    } finally {
      disposeSubscriptions();
      commandHandlers.clear();
      localizationListeners.clear();
    }
    return null;
  }

  async function handleHostRequest(message) {
    if (message.method === SANDBOX_METHOD.COMMAND_INVOKE) return invokeCommand(message.args);
    if (message.method === SANDBOX_METHOD.I18N_CHANGED) {
      updateLocalization(message.args);
      return null;
    }
    if (message.method === SANDBOX_METHOD.DEACTIVATE) return deactivate();
    throw fail('EXTENSION_PROTOCOL_ERROR', 'Unsupported host request.');
  }

  function handleResponse(message) {
    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) return;
    pending.delete(message.id);
    if (message.ok === true) pendingRequest.resolve(message.value);
    else pendingRequest.reject(fail(
      message.error && message.error.code || 'EXTENSION_UNAVAILABLE',
      message.error && message.error.message || 'Extension operation failed.'
    ));
  }

  function handleMessage(message) {
    if (!message || message.protocolVersion !== VERSION || typeof message.type !== 'string') return;
    if (message.type === TYPE.INITIALIZE) {
      initialize(message).catch((error) => {
        post({ type: TYPE.ACTIVATION_FAILED, error: errorValue(error) });
      });
      return;
    }
    if (message.type === TYPE.RESPONSE) {
      handleResponse(message);
      return;
    }
    if (message.type === TYPE.REQUEST && typeof message.id !== 'undefined') {
      Promise.resolve().then(() => handleHostRequest(message)).then(
        (value) => post({ type: TYPE.RESPONSE, id: message.id, ok: true, value }),
        (error) => post({ type: TYPE.RESPONSE, id: message.id, ok: false, error: errorValue(error) })
      );
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

function sandboxBootstrapSource() {
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
    if (!message || message.type !== CONNECT || message.protocolVersion !== VERSION || event.ports.length !== 1 || connected) return;
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

export function buildExtensionSandboxDocument() {
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    EXTENSION_SANDBOX_CSP + '"></head><body><script>' + sandboxBootstrapSource() + '</script></body></html>';
}

function requireDocument(documentRef) {
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'The extension sandbox requires a renderer document.');
  }
  const target = documentRef.body || documentRef.documentElement;
  if (!target || typeof target.appendChild !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'The extension sandbox cannot attach to this document.');
  }
  return target;
}

export function createSandboxedExtensionSandbox(options = {}) {
  const documentRef = options.document || globalThis.document;
  const target = requireDocument(documentRef);
  const MessageChannelConstructor = options.MessageChannel || globalThis.MessageChannel;
  if (typeof MessageChannelConstructor !== 'function') {
    throw createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'MessageChannel is unavailable for extension isolation.');
  }

  const iframe = documentRef.createElement('iframe');
  const channel = new MessageChannelConstructor();
  let disposed = false;
  let connected = false;
  let timeout = null;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function reportFatal(error) {
    if (typeof options.onFatal === 'function') options.onFatal(error);
  }

  function rejectConnection(error) {
    if (connected || disposed) return;
    connected = true;
    clearTimeout(timeout);
    rejectReady(error);
    reportFatal(error);
  }

  function connect() {
    if (disposed || connected) return;
    try {
      iframe.contentWindow.postMessage({
        type: ExtensionMessageType.CONNECT,
        protocolVersion: EXTENSION_PROTOCOL_VERSION
      }, '*', [channel.port2]);
      connected = true;
      clearTimeout(timeout);
      resolveReady();
    } catch (error) {
      rejectConnection(error);
    }
  }

  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.referrerPolicy = 'no-referrer';
  iframe.style.cssText = 'display:none !important;position:absolute;width:0;height:0;border:0;pointer-events:none;';
  iframe.addEventListener('load', connect, { once: true });
  iframe.addEventListener('error', () => {
    rejectConnection(createExtensionError(ExtensionErrorCode.UNAVAILABLE, 'Extension sandbox failed to load.'));
  }, { once: true });
  channel.port1.onmessage = (event) => {
    if (disposed || typeof options.onMessage !== 'function') return;
    options.onMessage(event.data);
  };
  channel.port1.onmessageerror = () => {
    reportFatal(createExtensionError(ExtensionErrorCode.PROTOCOL, 'Extension sandbox message channel failed.'));
  };
  if (typeof channel.port1.start === 'function') channel.port1.start();
  iframe.srcdoc = buildExtensionSandboxDocument();
  target.appendChild(iframe);
  timeout = setTimeout(() => {
    rejectConnection(createExtensionError(ExtensionErrorCode.TIMEOUT, 'Extension sandbox connection timed out.'));
  }, Number.isFinite(options.connectTimeoutMs) ? options.connectTimeoutMs : CONNECT_TIMEOUT_MS);

  return Object.freeze({
    ready,
    postMessage(message) {
      if (disposed) throw createExtensionError(ExtensionErrorCode.CANCELLED, 'Extension sandbox has been disposed.');
      channel.port1.postMessage(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      try { channel.port1.close(); } catch (_) {}
      try { iframe.remove(); } catch (_) {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }
    }
  });
}
