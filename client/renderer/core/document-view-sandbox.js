export const DOCUMENT_VIEW_PROTOCOL_VERSION = 1;

export const DOCUMENT_VIEW_SANDBOX_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' blob:",
  "worker-src blob:"
].join('; ');

const CONNECT_TIMEOUT_MS = 5_000;
const MAX_VIEW_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_VIEW_RESOURCE_BYTES = 8 * 1024 * 1024;

function bootstrapSource() {
  return `
(() => {
  'use strict';
  const VERSION = ${DOCUMENT_VIEW_PROTOCOL_VERSION};
  const CONNECT = 'bobocloud.documentView.connect';
  let port = null;
  let sequence = 0;
  let moduleValue = null;
  let disposer = null;
  let localization = Object.freeze({ locale: 'en', messages: Object.freeze(Object.create(null)) });
  const localizationListeners = new Set();
  const pending = new Map();
  const assetUrls = new Map();

  const blockedError = () => new Error('Direct document-view network access is disabled.');
  const blockedFetch = () => Promise.reject(blockedError());
  const BlockedConstructor = function() { throw blockedError(); };
  for (const name of [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'
  ]) {
    try {
      Object.defineProperty(window, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: name === 'fetch' ? blockedFetch : BlockedConstructor
      });
    } catch (_) {}
  }
  try { Object.defineProperty(window, 'open', { configurable: false, writable: false, value: () => null }); } catch (_) {}
  try {
    if (navigator && typeof navigator.sendBeacon === 'function') {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: false, writable: false, value: () => false });
    }
  } catch (_) {}
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (anchor) event.preventDefault();
  }, true);

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function errorValue(error) {
    return {
      code: error && typeof error.code === 'string' ? error.code : 'DOCUMENT_VIEW_FAILED',
      message: error && typeof error.message === 'string' ? error.message.slice(0, 8192) : 'Document preview failed.'
    };
  }

  function post(message, transfer) {
    if (!port) throw fail('DOCUMENT_VIEW_UNAVAILABLE', 'Document view channel is unavailable.');
    port.postMessage(Object.assign({ protocolVersion: VERSION }, message), transfer || []);
  }

  function request(method, args) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { post({ type: 'request', id, method, args }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  function updateLocalization(value) {
    const messages = Object.create(null);
    const raw = value && value.messages && typeof value.messages === 'object' ? value.messages : {};
    for (const key of Object.keys(raw).slice(0, 1024)) {
      if (typeof raw[key] === 'string') messages[key] = raw[key].slice(0, 8192);
    }
    const locale = value && (value.locale === 'zh-CN' || value.locale === 'ja') ? value.locale : 'en';
    localization = Object.freeze({ locale, messages: Object.freeze(messages) });
    for (const listener of Array.from(localizationListeners)) {
      try { listener(Object.freeze({ locale })); } catch (_) {}
    }
  }

  function interpolate(message, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return message;
    return message.replace(/\\{([A-Za-z0-9_]+)\\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    ));
  }

  function i18nApi() {
    return Object.freeze({
      get locale() { return localization.locale; },
      t(key, values) {
        const source = String(key == null ? '' : key);
        return interpolate(Object.prototype.hasOwnProperty.call(localization.messages, source) ? localization.messages[source] : source, values);
      },
      onDidChange(listener) {
        if (typeof listener !== 'function') throw new TypeError('Localization listener must be a function.');
        localizationListeners.add(listener);
        let active = true;
        return Object.freeze({ dispose() { if (active) { active = false; localizationListeners.delete(listener); } } });
      }
    });
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    const allowed = ['background', 'surface', 'border', 'text', 'muted', 'accent', 'danger', 'fontFamily', 'monoFontFamily'];
    for (const key of allowed) {
      if (theme && typeof theme[key] === 'string' && theme[key].length <= 160) {
        root.style.setProperty('--bobo-' + key.replace(/[A-Z]/g, (match) => '-' + match.toLowerCase()), theme[key]);
      }
    }
    root.dataset.theme = theme && theme.kind === 'light' ? 'light' : 'dark';
  }

  function createAssetUrls(resources) {
    for (const resource of Array.isArray(resources) ? resources : []) {
      if (!resource || typeof resource.path !== 'string' || typeof resource.source !== 'string' || assetUrls.has(resource.path)) continue;
      assetUrls.set(resource.path, URL.createObjectURL(new Blob([resource.source], { type: resource.mimeType || 'text/plain' })));
    }
  }

  async function readAll(documentInfo, maximumBytes) {
    const limit = maximumBytes === undefined ? 64 * 1024 * 1024 : maximumBytes;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 128 * 1024 * 1024 || documentInfo.size > limit) {
      throw fail('DOCUMENT_VIEW_TOO_LARGE', 'Document exceeds this viewer limit.');
    }
    const result = new Uint8Array(documentInfo.size);
    let offset = 0;
    while (offset < documentInfo.size) {
      const length = Math.min(2 * 1024 * 1024, documentInfo.size - offset);
      const response = await request('document.read', { offset, length });
      const bytes = response && response.data instanceof ArrayBuffer ? new Uint8Array(response.data) : new Uint8Array(0);
      if (bytes.byteLength === 0 && offset < documentInfo.size) throw fail('DOCUMENT_VIEW_FAILED', 'Document read ended unexpectedly.');
      result.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return result;
  }

  async function initialize(message) {
    if (moduleValue || !message || typeof message.source !== 'string') throw fail('DOCUMENT_VIEW_PROTOCOL_ERROR', 'Document view initialization is invalid.');
    updateLocalization(message.localization || {});
    applyTheme(message.theme || {});
    createAssetUrls(message.resources);
    const documentInfo = Object.freeze(Object.assign({}, message.document));
    const viewerInfo = Object.freeze(Object.assign({}, message.viewer));
    const context = Object.freeze({
      root: document.getElementById('app'),
      document: documentInfo,
      viewer: viewerInfo,
      i18n: i18nApi(),
      assets: Object.freeze({
        url(resourcePath) {
          if (!assetUrls.has(resourcePath)) throw fail('DOCUMENT_VIEW_NOT_FOUND', 'Document view resource is not declared: ' + resourcePath);
          return assetUrls.get(resourcePath);
        }
      }),
      async read(offset, length) {
        const response = await request('document.read', { offset, length });
        return response && response.data instanceof ArrayBuffer ? new Uint8Array(response.data) : new Uint8Array(0);
      },
      readAll(maximumBytes) { return readAll(documentInfo, maximumBytes); },
      async readText(maximumBytes, encoding) {
        const bytes = await readAll(documentInfo, maximumBytes);
        return new TextDecoder(encoding || 'utf-8', { fatal: false }).decode(bytes);
      }
    });
    const sourceUrl = URL.createObjectURL(new Blob([message.source], { type: 'text/javascript' }));
    try { moduleValue = await import(sourceUrl); }
    finally { URL.revokeObjectURL(sourceUrl); }
    if (!moduleValue || typeof moduleValue.activate !== 'function') {
      throw fail('DOCUMENT_VIEW_PROTOCOL_ERROR', 'Document view entry must export activate(context).');
    }
    const result = await moduleValue.activate(context);
    if (typeof result === 'function') disposer = result;
    else if (result && typeof result.dispose === 'function') disposer = () => result.dispose();
    post({ type: 'ready' });
  }

  async function disposeView() {
    try {
      if (moduleValue && typeof moduleValue.deactivate === 'function') await moduleValue.deactivate();
      if (disposer) await disposer();
    } finally {
      disposer = null;
      localizationListeners.clear();
      for (const url of assetUrls.values()) URL.revokeObjectURL(url);
      assetUrls.clear();
    }
  }

  function handleMessage(message) {
    if (!message || message.protocolVersion !== VERSION) return;
    if (message.type === 'initialize') {
      initialize(message).catch((error) => post({ type: 'fatal', error: errorValue(error) }));
      return;
    }
    if (message.type === 'response') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.ok === true) item.resolve(message.value);
      else item.reject(fail(message.error && message.error.code || 'DOCUMENT_VIEW_FAILED', message.error && message.error.message || 'Document operation failed.'));
      return;
    }
    if (message.type === 'event' && message.event === 'i18n.changed') updateLocalization(message.value || {});
    if (message.type === 'event' && message.event === 'dispose') disposeView().catch(() => {});
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (port || !message || message.type !== CONNECT || message.protocolVersion !== VERSION || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = (portEvent) => handleMessage(portEvent.data);
    if (typeof port.start === 'function') port.start();
  });
})();`;
}

export function buildDocumentViewSandboxDocument() {
  const source = bootstrapSource().replace(/<\/script/gi, '<\\/script');
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    DOCUMENT_VIEW_SANDBOX_CSP.replace(/"/g, '&quot;') + '"><style>' +
    ':root{color-scheme:dark light;background:var(--bobo-background,#111318);color:var(--bobo-text,#e7eaf0);font-family:var(--bobo-font-family,system-ui,sans-serif)}' +
    'html,body,#app{width:100%;height:100%;margin:0;overflow:hidden}*{box-sizing:border-box}' +
    '</style></head><body><main id="app"></main><script>' + source + '</script></body></html>';
}

function serializedError(error) {
  return {
    code: error && typeof error.code === 'string' ? error.code : 'DOCUMENT_VIEW_FAILED',
    message: error && typeof error.message === 'string' ? error.message.slice(0, 8192) : 'Document operation failed.'
  };
}

function exactArrayBuffer(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function createSandboxedDocumentView(options = {}) {
  if (!options.container || typeof options.container.appendChild !== 'function') throw new TypeError('Document view needs a container.');
  if (!options.entry || typeof options.entry.source !== 'string') throw new TypeError('Document view needs verified entry source.');
  if (new TextEncoder().encode(options.entry.source).byteLength > MAX_VIEW_SOURCE_BYTES) throw new Error('Document view source exceeds the renderer limit.');
  if (typeof options.read !== 'function') throw new TypeError('Document view needs a document reader.');
  const resources = Array.isArray(options.resources) ? options.resources.map((resource) => {
    if (!resource || typeof resource.path !== 'string' || typeof resource.source !== 'string' ||
        new TextEncoder().encode(resource.source).byteLength > MAX_VIEW_RESOURCE_BYTES) {
      throw new TypeError('Document view resource is invalid.');
    }
    return { path: resource.path, source: resource.source, mimeType: resource.mimeType || 'text/plain' };
  }) : [];

  const iframe = document.createElement('iframe');
  iframe.className = 'document-view-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', options.viewer && options.viewer.title || 'Document preview');
  iframe.srcdoc = buildDocumentViewSandboxDocument();
  iframe.hidden = true;

  const channel = new MessageChannel();
  let disposed = false;
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error('Document view sandbox connection timed out.'));
  }, CONNECT_TIMEOUT_MS);

  channel.port1.onmessage = (event) => {
    const message = event.data;
    if (!message || message.protocolVersion !== DOCUMENT_VIEW_PROTOCOL_VERSION || disposed) return;
    if (message.type === 'ready') {
      if (!readySettled) { readySettled = true; clearTimeout(timeout); resolveReady(); }
      return;
    }
    if (message.type === 'fatal') {
      const error = new Error(message.error && message.error.message || 'Document preview failed.');
      error.code = message.error && message.error.code || 'DOCUMENT_VIEW_FAILED';
      if (!readySettled) { readySettled = true; clearTimeout(timeout); rejectReady(error); }
      if (typeof options.onError === 'function') options.onError(error);
      return;
    }
    if (message.type !== 'request' || message.method !== 'document.read' || !Number.isSafeInteger(message.id)) return;
    Promise.resolve(options.read(message.args || {})).then((value) => {
      const data = exactArrayBuffer(value && value.data);
      channel.port1.postMessage({
        protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
        type: 'response',
        id: message.id,
        ok: true,
        value: { data, offset: value.offset, length: value.length, eof: value.eof === true }
      }, [data]);
    }, (error) => {
      channel.port1.postMessage({
        protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
        type: 'response',
        id: message.id,
        ok: false,
        error: serializedError(error)
      });
    });
  };
  channel.port1.start();

  iframe.addEventListener('load', () => {
    if (disposed || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({
      protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
      type: 'bobocloud.documentView.connect'
    }, '*', [channel.port2]);
    channel.port1.postMessage({
      protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
      type: 'initialize',
      source: options.entry.source,
      resources,
      document: options.document,
      viewer: options.viewer,
      localization: options.localization || { locale: 'en', messages: {} },
      theme: options.theme || {}
    });
  }, { once: true });
  options.container.appendChild(iframe);

  return Object.freeze({
    element: iframe,
    ready,
    show() { if (!disposed) iframe.hidden = false; },
    hide() { iframe.hidden = true; },
    updateLocalization(value) {
      if (!disposed) channel.port1.postMessage({ protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION, type: 'event', event: 'i18n.changed', value });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      if (!readySettled) { readySettled = true; rejectReady(new Error('Document view was disposed.')); }
      try { channel.port1.postMessage({ protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION, type: 'event', event: 'dispose' }); } catch (_) {}
      try { channel.port1.close(); } catch (_) {}
      iframe.remove();
    }
  });
}
