import type {
  DocumentInfoDto,
  DocumentReadRangeDto,
  DocumentReadResultDto,
  DocumentViewLocalizationDto,
  DocumentViewPublicDescriptorDto,
  DocumentViewThemeDto,
  SandboxedDocumentView,
  SandboxedDocumentViewOptions,
  VerifiedDocumentViewFileDto
} from '../../types/document-view';

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
export const MAX_DOCUMENT_VIEW_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_VIEW_RESOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_VIEW_TOTAL_BYTES = 24 * 1024 * 1024;
export const MAX_DOCUMENT_VIEW_READ_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_VIEW_INFLIGHT_READS = 4;

function bootstrapSource(): string {
  return `
(() => {
  'use strict';
  const VERSION = ${DOCUMENT_VIEW_PROTOCOL_VERSION};
  const MAX_READS = ${MAX_DOCUMENT_VIEW_INFLIGHT_READS};
  const CONNECT = 'bobocloud.documentView.connect';
  let port = null;
  let disposed = false;
  let sequence = 0;
  let moduleValue = null;
  let disposer = null;
  let initializing = false;
  let activationStarted = false;
  let activationPromise = null;
  let cleanupPromise = null;
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
    if (disposed || !port) throw fail('DOCUMENT_VIEW_UNAVAILABLE', 'Document view channel is unavailable.');
    port.postMessage(Object.assign({ protocolVersion: VERSION }, message), transfer || []);
  }

  function request(method, args) {
    if (disposed) return Promise.reject(fail('DOCUMENT_VIEW_UNAVAILABLE', 'Document view has been disposed.'));
    if (pending.size >= MAX_READS) return Promise.reject(fail('DOCUMENT_VIEW_BUSY', 'Document view has too many reads in progress.'));
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
    if (initializing || moduleValue || !message || typeof message.source !== 'string') throw fail('DOCUMENT_VIEW_PROTOCOL_ERROR', 'Document view initialization is invalid.');
    initializing = true;
    try {
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
      if (disposed) {
        moduleValue = null;
        return;
      }
      if (!moduleValue || typeof moduleValue.activate !== 'function') {
        throw fail('DOCUMENT_VIEW_PROTOCOL_ERROR', 'Document view entry must export activate(context).');
      }
      activationStarted = true;
      const currentActivation = Promise.resolve().then(() => moduleValue.activate(context));
      activationPromise = currentActivation;
      let result;
      try { result = await currentActivation; }
      finally { if (activationPromise === currentActivation) activationPromise = null; }
      if (typeof result === 'function') disposer = result;
      else if (result && typeof result.dispose === 'function') disposer = () => result.dispose();
      if (!disposed) post({ type: 'ready' });
    } finally {
      initializing = false;
    }
  }

  async function disposeView() {
    if (cleanupPromise) return cleanupPromise;
    disposed = true;
    for (const item of pending.values()) {
      try { item.reject(fail('DOCUMENT_VIEW_UNAVAILABLE', 'Document view has been disposed.')); } catch (_) {}
    }
    pending.clear();
    cleanupPromise = (async () => {
      const currentActivation = activationPromise;
      if (currentActivation) {
        try { await currentActivation; } catch (_) {}
      }
      try {
        try {
          if (activationStarted && moduleValue && typeof moduleValue.deactivate === 'function') await moduleValue.deactivate();
        } finally {
          if (disposer) await disposer();
        }
      } finally {
        moduleValue = null;
        disposer = null;
        activationPromise = null;
        localizationListeners.clear();
        for (const url of assetUrls.values()) URL.revokeObjectURL(url);
        assetUrls.clear();
        try { if (port) port.close(); } catch (_) {}
        port = null;
      }
    })();
    return cleanupPromise;
  }

  function handleMessage(message) {
    if (!message || message.protocolVersion !== VERSION || disposed) return;
    if (message.type === 'initialize') {
      initialize(message).catch((error) => {
        if (!disposed) {
          try { post({ type: 'fatal', error: errorValue(error) }); } catch (_) {}
        }
      });
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
    if (message.type === 'event' && message.event === 'theme.changed') applyTheme(message.value || {});
    if (message.type === 'event' && message.event === 'dispose') disposeView().catch(() => {});
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window.parent || port || !message || message.type !== CONNECT || message.protocolVersion !== VERSION || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = (portEvent) => handleMessage(portEvent.data);
    if (typeof port.start === 'function') port.start();
  });
})();`;
}

export function buildDocumentViewSandboxDocument(): string {
  const source = bootstrapSource().replace(/<\/script/gi, '<\\/script');
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    DOCUMENT_VIEW_SANDBOX_CSP.replace(/"/g, '&quot;') + '"><style>' +
    ':root{color-scheme:dark light;background:var(--bobo-background,#111318);color:var(--bobo-text,#e7eaf0);font-family:var(--bobo-font-family,system-ui,sans-serif)}' +
    'html,body,#app{width:100%;height:100%;margin:0;overflow:hidden}*{box-sizing:border-box}' +
    '</style></head><body><main id="app"></main><script>' + source + '</script></body></html>';
}

interface SerializedDocumentViewError {
  readonly code: string;
  readonly message: string;
}

interface SandboxResourceDto {
  readonly path: string;
  readonly source: string;
  readonly mimeType: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializedError(error: unknown): SerializedDocumentViewError {
  const candidate = isRecord(error) ? error : null;
  return {
    code: candidate && typeof candidate.code === 'string' ? candidate.code : 'DOCUMENT_VIEW_FAILED',
    message: candidate && typeof candidate.message === 'string'
      ? candidate.message.slice(0, 8192)
      : 'Document operation failed.'
  };
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;

function exactArrayBuffer(value: unknown): ArrayBuffer {
  let bytes: Uint8Array;
  try {
    if (arrayBufferByteLength) {
      const byteLength = arrayBufferByteLength.call(value) as number;
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new TypeError();
      bytes = new Uint8Array(value as ArrayBuffer, 0, byteLength);
    } else {
      throw new TypeError();
    }
  } catch (_) {
    if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new TypeError('Document read data must be an ArrayBuffer or ArrayBufferView.');
    }
  }
  if (!bytes) {
    throw new TypeError('Document read data must be an ArrayBuffer or ArrayBufferView.');
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function validatedReadRange(value: unknown, documentInfo: DocumentInfoDto): DocumentReadRangeDto {
  if (!isRecord(value)) throw new TypeError('Document read range must be an object.');
  const { offset, length } = value;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > documentInfo.size ||
      !Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > MAX_DOCUMENT_VIEW_READ_BYTES ||
      !Number.isSafeInteger((offset as number) + (length as number))) {
    throw new RangeError('Document read range is invalid.');
  }
  return Object.freeze({ offset: offset as number, length: length as number });
}

function validatedReadResult(
  value: unknown,
  range: DocumentReadRangeDto
): Readonly<Omit<DocumentReadResultDto, 'data'> & { data: ArrayBuffer }> {
  if (!isRecord(value)) throw new TypeError('Document read result must be an object.');
  const data = exactArrayBuffer(value.data);
  if (value.offset !== range.offset || value.length !== data.byteLength || data.byteLength > range.length ||
      typeof value.eof !== 'boolean') {
    throw new TypeError('Document read result does not match the requested range.');
  }
  return Object.freeze({
    data,
    offset: range.offset,
    length: data.byteLength,
    eof: value.eof
  });
}

function projectDocumentInfo(value: DocumentInfoDto): DocumentInfoDto {
  if (!value || typeof value.documentId !== 'string' || !value.documentId ||
      typeof value.name !== 'string' || typeof value.extension !== 'string' ||
      !Number.isSafeInteger(value.size) || value.size < 0 ||
      typeof value.lastModified !== 'string') {
    throw new TypeError('Document view information is invalid.');
  }
  return Object.freeze({
    documentId: value.documentId,
    name: value.name,
    extension: value.extension,
    size: value.size,
    lastModified: value.lastModified
  });
}

function projectPublicViewer(value: DocumentViewPublicDescriptorDto): DocumentViewPublicDescriptorDto {
  if (!value || typeof value.id !== 'string' || !value.id ||
      typeof value.title !== 'string' || !value.title ||
      !Array.isArray(value.extensions) ||
      value.extensions.some((extension) => typeof extension !== 'string') ||
      !Number.isInteger(value.priority)) {
    throw new TypeError('Document viewer public descriptor is invalid.');
  }
  return Object.freeze({
    id: value.id,
    title: value.title,
    extensions: Object.freeze(Array.from(value.extensions)),
    priority: value.priority
  });
}

function validatedResource(
  resource: VerifiedDocumentViewFileDto,
  encoder: TextEncoder
): Readonly<{ resource: SandboxResourceDto; byteLength: number }> {
  if (!resource || typeof resource.path !== 'string' || typeof resource.source !== 'string') {
    throw new TypeError('Document view resource is invalid.');
  }
  const byteLength = encoder.encode(resource.source).byteLength;
  if (byteLength > MAX_DOCUMENT_VIEW_RESOURCE_BYTES) {
    throw new TypeError('Document view resource is invalid.');
  }
  return {
    resource: Object.freeze({
      path: resource.path,
      source: resource.source,
      mimeType: typeof resource.mimeType === 'string' && resource.mimeType
        ? resource.mimeType
        : 'text/plain'
    }),
    byteLength
  };
}

export function createSandboxedDocumentView(
  options: SandboxedDocumentViewOptions
): SandboxedDocumentView {
  if (!options.container || typeof options.container.appendChild !== 'function') throw new TypeError('Document view needs a container.');
  if (!options.entry || typeof options.entry.source !== 'string') throw new TypeError('Document view needs verified entry source.');
  const encoder = new TextEncoder();
  const entryBytes = encoder.encode(options.entry.source).byteLength;
  if (entryBytes > MAX_DOCUMENT_VIEW_SOURCE_BYTES) throw new Error('Document view source exceeds the renderer limit.');
  if (typeof options.read !== 'function') throw new TypeError('Document view needs a document reader.');
  let totalBytes = entryBytes;
  const resources: SandboxResourceDto[] = [];
  for (const sourceResource of options.resources || []) {
    const { resource, byteLength } = validatedResource(sourceResource, encoder);
    totalBytes += byteLength;
    if (totalBytes > MAX_DOCUMENT_VIEW_TOTAL_BYTES) {
      throw new Error('Document view source exceeds the combined renderer limit.');
    }
    resources.push(resource);
  }
  const documentInfo = projectDocumentInfo(options.document);
  const publicViewer = projectPublicViewer(options.viewer);

  const iframe = document.createElement('iframe');
  iframe.className = 'document-view-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', publicViewer.title || 'Document preview');
  iframe.srcdoc = buildDocumentViewSandboxDocument();
  iframe.hidden = true;

  const channel = new MessageChannel();
  let disposed = false;
  let inflightReads = 0;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (reason?: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => terminate(
    new Error('Document view sandbox connection timed out.'),
    true
  ), CONNECT_TIMEOUT_MS);

  function terminate(error: Error, notify: boolean): void {
    if (disposed) return;
    clearTimeout(timeout);
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    try {
      channel.port1.postMessage({
        protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
        type: 'event',
        event: 'dispose'
      });
    } catch (_) {}
    disposed = true;
    try { channel.port1.close(); } catch (_) {}
    try { channel.port2.close(); } catch (_) {}
    iframe.remove();
    if (notify && typeof options.onError === 'function') options.onError(error);
  }

  function postToSandbox(message: unknown, transfer: Transferable[] = []): boolean {
    if (disposed) return false;
    try {
      channel.port1.postMessage(message, transfer);
      return true;
    } catch (_) {
      return false;
    }
  }

  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isRecord(message) || message.protocolVersion !== DOCUMENT_VIEW_PROTOCOL_VERSION || disposed) return;
    if (message.type === 'ready') {
      if (!readySettled) { readySettled = true; clearTimeout(timeout); resolveReady(); }
      return;
    }
    if (message.type === 'fatal') {
      const detail = isRecord(message.error) ? message.error : null;
      const error = new Error(detail && typeof detail.message === 'string' ? detail.message : 'Document preview failed.');
      Object.assign(error, {
        code: detail && typeof detail.code === 'string' ? detail.code : 'DOCUMENT_VIEW_FAILED'
      });
      terminate(error, true);
      return;
    }
    if (message.type !== 'request' || message.method !== 'document.read' || !Number.isSafeInteger(message.id)) return;
    const requestId = message.id as number;
    let range: DocumentReadRangeDto;
    try {
      range = validatedReadRange(message.args, documentInfo);
    } catch (error) {
      postToSandbox({
        protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
        type: 'response',
        id: requestId,
        ok: false,
        error: serializedError(error)
      });
      return;
    }
    if (inflightReads >= MAX_DOCUMENT_VIEW_INFLIGHT_READS) {
      postToSandbox({
        protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
        type: 'response',
        id: requestId,
        ok: false,
        error: {
          code: 'DOCUMENT_VIEW_BUSY',
          message: 'Document view has too many reads in progress.'
        }
      });
      return;
    }
    inflightReads += 1;
    Promise.resolve().then(() => disposed ? null : options.read(range)).then((value) => {
      if (disposed) return;
      try {
        const result = validatedReadResult(value, range);
        postToSandbox({
          protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
          type: 'response',
          id: requestId,
          ok: true,
          value: result
        }, [result.data]);
      } catch (error) {
        postToSandbox({
          protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
          type: 'response',
          id: requestId,
          ok: false,
          error: serializedError(error)
        });
      }
    }, (error: unknown) => {
      if (disposed) return;
      postToSandbox({
        protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
        type: 'response',
        id: requestId,
        ok: false,
        error: serializedError(error)
      });
    }).finally(() => { inflightReads -= 1; });
  };
  channel.port1.start();

  iframe.addEventListener('load', () => {
    if (disposed || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({
      protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
      type: 'bobocloud.documentView.connect'
    }, '*', [channel.port2]);
    postToSandbox({
      protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
      type: 'initialize',
      source: options.entry.source,
      resources,
      document: documentInfo,
      viewer: publicViewer,
      localization: options.localization || { locale: 'en', messages: {} },
      theme: options.theme || {}
    });
    queueMicrotask(() => {
      if (disposed) return;
      iframe.addEventListener('load', () => {
        terminate(new Error('Document preview failed.'), true);
      }, { once: true });
    });
  }, { once: true });
  options.container.appendChild(iframe);

  return Object.freeze({
    element: iframe,
    ready,
    show() { if (!disposed) iframe.hidden = false; },
    hide() { iframe.hidden = true; },
    updateLocalization(value: DocumentViewLocalizationDto) {
      postToSandbox({ protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION, type: 'event', event: 'i18n.changed', value });
    },
    updateTheme(value: DocumentViewThemeDto) {
      postToSandbox({ protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION, type: 'event', event: 'theme.changed', value });
    },
    dispose() {
      terminate(new Error('Document view was disposed.'), false);
    }
  });
}
