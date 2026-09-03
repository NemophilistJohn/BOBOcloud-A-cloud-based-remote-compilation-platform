'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadModule(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-document-view-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'document-views.cjs');
  await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "export { createDocumentViewService } from './src/document-views.ts';",
        "export { selectDocumentView } from './renderer/core/document-view.ts';",
        'export {',
        '  DOCUMENT_VIEW_PROTOCOL_VERSION,',
        '  MAX_DOCUMENT_VIEW_INFLIGHT_READS,',
        '  MAX_DOCUMENT_VIEW_READ_BYTES,',
        '  MAX_DOCUMENT_VIEW_RESOURCE_BYTES,',
        '  MAX_DOCUMENT_VIEW_SOURCE_BYTES,',
        '  MAX_DOCUMENT_VIEW_TOTAL_BYTES,',
        '  buildDocumentViewSandboxDocument,',
        '  createSandboxedDocumentView',
        "} from './renderer/core/document-view-sandbox.ts';"
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'document-view-service-test-entry.ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    logLevel: 'silent'
  });
  delete require.cache[output];
  return require(output);
}

function descriptor(id, extensions = ['.preview'], priority = 0) {
  return Object.freeze({
    id,
    title: id,
    extensions: Object.freeze(extensions),
    entry: 'dist/view.js',
    resources: Object.freeze(['dist/view.css']),
    priority
  });
}

function contribution(id, extensions, priority) {
  return Object.freeze({
    id,
    owner: 'acme.preview',
    contribution: descriptor(id, extensions, priority)
  });
}

function loaded(registration) {
  return Object.freeze({
    pluginId: registration.pluginId,
    viewer: Object.freeze({
      id: registration.id,
      extensions: Object.freeze([...registration.extensions]),
      entry: 'dist/view.js',
      resources: Object.freeze(['dist/view.css']),
      priority: registration.priority
    }),
    entry: Object.freeze({
      path: 'dist/view.js',
      source: 'export function activate() {}',
      hash: 'a'.repeat(64),
      mimeType: 'text/javascript'
    }),
    resources: Object.freeze([Object.freeze({
      path: 'dist/view.css',
      source: ':root{}',
      hash: 'b'.repeat(64),
      mimeType: 'text/css'
    })])
  });
}

function fakeNode(tagName = 'div') {
  const children = [];
  return {
    tagName,
    children,
    hidden: false,
    textContent: '',
    className: '',
    style: {},
    parentNode: null,
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); }
    },
    appendChild(child) {
      child.parentNode = this;
      children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }
  };
}

function createHarness(options = {}) {
  const root = fakeNode('main');
  const editor = fakeNode('section');
  const entries = options.entries || [contribution('acme.preview.viewer', ['.preview'], 0)];
  const contributionListeners = new Set();
  const localeListeners = new Set();
  const themeListeners = new Set();
  const sandboxes = [];
  const calls = {
    load: [],
    localization: [],
    open: [],
    read: [],
    close: [],
    closeTab: []
  };
  const state = { currentViewMode: 'single', tabs: [] };
  let locale = 'en';
  let themeVersion = 'dark';
  let documentSequence = 0;

  const host = {
    async loadDocumentView(pluginId, viewerId) {
      calls.load.push([pluginId, viewerId]);
      if (options.loadDocumentView) return options.loadDocumentView(pluginId, viewerId);
      const registration = { pluginId, id: viewerId, title: viewerId, extensions: ['.preview'], priority: 0 };
      return loaded(registration);
    },
    async loadLocalization(pluginId, requestedLocale) {
      calls.localization.push([pluginId, requestedLocale]);
      if (options.loadLocalization) return options.loadLocalization(pluginId, requestedLocale);
      return { locale: requestedLocale, messages: {} };
    },
    async openDocument(pluginId, viewerId, filePath) {
      calls.open.push([pluginId, viewerId, filePath]);
      if (options.openDocument) return options.openDocument(pluginId, viewerId, filePath);
      return {
        documentId: 'document-' + (++documentSequence),
        name: path.basename(filePath),
        extension: path.extname(filePath),
        size: 4,
        lastModified: '2026-09-03T00:00:00.000Z'
      };
    },
    async readDocument(documentId, offset, length) {
      calls.read.push([documentId, offset, length]);
      return { data: new Uint8Array(length), offset, length, eof: true };
    },
    async closeDocument(documentId) {
      calls.close.push(documentId);
      return { closed: true };
    }
  };

  const dependencies = {
    document: {
      getElementById(id) {
        if (id === 'document-view-host') return root;
        if (id === 'container') return editor;
        return null;
      },
      createElement(tagName) { return fakeNode(tagName); }
    },
    state,
    i18n: {
      t: (key) => key,
      getActive: () => locale,
      onChange(listener) {
        localeListeners.add(listener);
        return () => localeListeners.delete(listener);
      }
    },
    theme: {
      snapshot: () => ({
        kind: themeVersion === 'light' ? 'light' : 'dark',
        background: themeVersion,
        surface: '', border: '', text: '', muted: '', accent: '', danger: '',
        fontFamily: '', monoFontFamily: ''
      }),
      onChange(listener) {
        themeListeners.add(listener);
        return () => themeListeners.delete(listener);
      }
    },
    views: {},
    workspace: {
      closeTab(filePath, closeOptions) {
        calls.closeTab.push([filePath, closeOptions]);
      }
    },
    contributions: {
      list: () => entries,
      onDidChange(listener) {
        contributionListeners.add(listener);
        return { dispose: () => contributionListeners.delete(listener) };
      }
    },
    host,
    createSandboxedView(sandboxOptions) {
      const sandbox = {
        element: fakeNode('iframe'),
        ready: Promise.resolve(),
        shown: false,
        disposed: false,
        localizations: [],
        themes: [],
        options: sandboxOptions,
        show() { this.shown = true; },
        hide() { this.shown = false; },
        updateLocalization(value) { this.localizations.push(value); },
        updateTheme(value) { this.themes.push(value); },
        dispose() { this.disposed = true; }
      };
      sandboxes.push(sandbox);
      return sandbox;
    }
  };

  return {
    calls,
    dependencies,
    entries,
    host,
    localeListeners,
    contributionListeners,
    themeListeners,
    root,
    sandboxes,
    state,
    setLocale(value) { locale = value; },
    setTheme(value) { themeVersion = value; }
  };
}

test('document-view selection compares each viewer by its longest compound extension', async (t) => {
  const { selectDocumentView } = await loadModule(t);
  const shortHighPriority = contribution('acme.preview.short', ['.gz'], 100);
  const compound = contribution('acme.preview.compound', ['.gz', '.tar.gz'], -100);
  const selected = selectDocumentView([shortHighPriority, compound], 'ARCHIVE.TAR.GZ');
  assert.equal(selected.id, 'acme.preview.compound');
});

test('document-view creation coalesces by path and disposal invalidates an open in-flight handle', async (t) => {
  const { createDocumentViewService } = await loadModule(t);
  const loadGate = deferred();
  const harness = createHarness({ loadDocumentView: () => loadGate.promise });
  const service = createDocumentViewService(harness.dependencies);
  const registration = service.find('sample.preview');
  const first = service.create('C:/workspace/sample.preview', 'sample.preview', registration);
  const second = service.create('C:/workspace/sample.preview', 'sample.preview', registration);
  assert.equal(first, second);
  assert.equal(harness.calls.load.length, 1);
  loadGate.resolve(loaded(registration));
  const instance = await first;
  assert.equal(harness.sandboxes.length, 1);
  assert.deepEqual(Object.keys(harness.sandboxes[0].options.viewer).sort(), [
    'extensions', 'id', 'priority', 'title'
  ]);
  assert.equal('entry' in harness.sandboxes[0].options.viewer, false);
  service.disposeAll();
  assert.equal(instance.disposed, true);
  assert.equal(harness.sandboxes[0].disposed, true);
  assert.deepEqual(harness.calls.close, [instance.documentId]);

  const openGate = deferred();
  const staleHarness = createHarness({ openDocument: () => openGate.promise });
  const staleService = createDocumentViewService(staleHarness.dependencies);
  const staleRegistration = staleService.find('stale.preview');
  const staleCreation = staleService.create('C:/workspace/stale.preview', 'stale.preview', staleRegistration);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleHarness.calls.open.length, 1);
  staleService.disposeAll();
  openGate.resolve({
    documentId: 'stale-document',
    name: 'stale.preview',
    extension: '.preview',
    size: 1,
    lastModified: '2026-09-03T00:00:00.000Z'
  });
  await assert.rejects(staleCreation, /cancelled/);
  assert.deepEqual(staleHarness.calls.close, ['stale-document']);
  assert.equal(staleHarness.sandboxes.length, 0);
});

test('a removed contribution cancels pending creation even when the same id is re-registered', async (t) => {
  const { createDocumentViewService } = await loadModule(t);
  const firstLoad = deferred();
  const entries = [contribution('acme.preview.viewer', ['.preview'], 0)];
  let loadCount = 0;
  const harness = createHarness({
    entries,
    loadDocumentView(pluginId, viewerId) {
      loadCount += 1;
      if (loadCount === 1) return firstLoad.promise;
      return loaded({
        pluginId,
        id: viewerId,
        title: viewerId,
        extensions: ['.preview'],
        priority: 0
      });
    }
  });
  const service = createDocumentViewService(harness.dependencies);
  service.init();
  const registration = service.find('sample.preview');
  const staleCreation = service.create('C:/workspace/sample.preview', 'sample.preview', registration);
  await new Promise((resolve) => setImmediate(resolve));

  entries.splice(0);
  for (const listener of harness.contributionListeners) {
    listener({ type: 'removed', owner: 'acme.preview', id: 'acme.preview.viewer' });
  }
  entries.push(contribution('acme.preview.viewer', ['.preview'], 0));
  firstLoad.resolve(loaded(registration));
  await assert.rejects(staleCreation, /cancelled/);
  assert.equal(harness.sandboxes.length, 0);

  const replacement = await service.create(
    'C:/workspace/sample.preview',
    'sample.preview',
    service.find('sample.preview')
  );
  assert.equal(loadCount, 2);
  assert.equal(harness.sandboxes.length, 1);
  service.disposeTab({ path: replacement.path, documentView: replacement });
});

test('terminal sandbox failures close the document once while retaining the error view', async (t) => {
  const { createDocumentViewService } = await loadModule(t);
  const harness = createHarness();
  const service = createDocumentViewService(harness.dependencies);
  const registration = service.find('sample.preview');
  const instance = await service.create('C:/workspace/sample.preview', 'sample.preview', registration);
  const tab = { path: instance.path, documentView: instance };
  harness.state.tabs.push(tab);
  assert.equal(service.show(tab), true);

  harness.sandboxes[0].options.onError(new Error('activation failed'));
  assert.equal(harness.sandboxes[0].disposed, true);
  assert.equal(instance.error.hidden, false);
  assert.match(instance.error.textContent, /activation failed/);
  assert.deepEqual(harness.calls.close, [instance.documentId]);

  service.disposeTab(tab);
  assert.deepEqual(harness.calls.close, [instance.documentId]);
  assert.equal(instance.error.parentNode, null);
});

test('localization refresh is grouped, latest-wins, and subscriptions are disposable', async (t) => {
  const { createDocumentViewService } = await loadModule(t);
  const localeGates = new Map();
  const harness = createHarness({
    entries: [contribution('acme.preview.viewer', ['.one', '.two'], 0)],
    loadLocalization(_pluginId, locale) {
      if (locale === 'en') return Promise.resolve({ locale, messages: {} });
      const gate = deferred();
      localeGates.set(locale, gate);
      return gate.promise;
    },
    loadDocumentView(pluginId, viewerId) {
      return loaded({ pluginId, id: viewerId, title: viewerId, extensions: ['.one', '.two'], priority: 0 });
    }
  });
  const service = createDocumentViewService(harness.dependencies);
  service.init();
  const registration = service.find('a.one');
  const first = await service.create('C:/workspace/a.one', 'a.one', registration);
  const second = await service.create('C:/workspace/b.two', 'b.two', registration);
  harness.state.tabs.push(
    { path: first.path, documentView: first },
    { path: second.path, documentView: second }
  );

  harness.setLocale('zh-CN');
  const staleRefresh = service.refreshLocalizations();
  harness.setLocale('ja');
  const currentRefresh = service.refreshLocalizations();
  assert.equal(harness.calls.localization.filter((call) => call[1] === 'zh-CN').length, 1);
  assert.equal(harness.calls.localization.filter((call) => call[1] === 'ja').length, 1);
  localeGates.get('ja').resolve({ locale: 'ja', messages: { Preview: 'preview-ja' } });
  await currentRefresh;
  localeGates.get('zh-CN').resolve({ locale: 'zh-CN', messages: { Preview: 'preview-zh' } });
  await staleRefresh;
  for (const sandbox of harness.sandboxes) {
    assert.deepEqual(sandbox.localizations.map((value) => value.locale), ['ja']);
  }

  harness.setTheme('light');
  for (const listener of harness.themeListeners) listener();
  for (const sandbox of harness.sandboxes) {
    assert.equal(sandbox.themes.at(-1).kind, 'light');
  }
  assert.equal(harness.localeListeners.size, 1);
  assert.equal(harness.themeListeners.size, 1);
  service.dispose();
  service.dispose();
  assert.equal(harness.localeListeners.size, 0);
  assert.equal(harness.themeListeners.size, 0);
  assert.equal(harness.contributionListeners.size, 0);
  assert.equal(harness.sandboxes.every((sandbox) => sandbox.disposed), true);
});

test('sandbox enforces renderer read and resource bounds and drops disposed async replies', async (t) => {
  const sandboxModule = await loadModule(t);
  const channels = [];
  const iframes = [];

  class FakePort {
    constructor() {
      this.onmessage = null;
      this.sent = [];
      this.closed = false;
    }
    postMessage(message, transfer = []) {
      if (this.closed) throw new Error('port closed');
      this.sent.push({ message, transfer });
    }
    start() {}
    close() { this.closed = true; }
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      channels.push(this);
    }
  }

  const previousDocument = global.document;
  const previousMessageChannel = global.MessageChannel;
  global.MessageChannel = FakeMessageChannel;
  global.document = {
    createElement(tagName) {
      const listeners = new Map();
      const iframe = {
        tagName,
        className: '',
        hidden: false,
        srcdoc: '',
        attributes: new Map(),
        contentWindow: { sent: [], postMessage(...args) { this.sent.push(args); } },
        setAttribute(name, value) { this.attributes.set(name, value); },
        addEventListener(type, listener) { listeners.set(type, listener); },
        fire(type) { listeners.get(type)?.(); },
        remove() { this.removed = true; }
      };
      iframes.push(iframe);
      return iframe;
    }
  };
  t.after(() => {
    global.document = previousDocument;
    global.MessageChannel = previousMessageChannel;
  });

  const pendingRead = deferred();
  let readMode = 'bytes';
  let readCalls = 0;
  const container = { appendChild() {} };
  const baseOptions = {
    container,
    entry: { path: 'view.js', source: '', hash: 'a'.repeat(64), mimeType: 'text/javascript' },
    resources: [],
    document: {
      documentId: 'document-1', name: 'sample.bin', extension: '.bin', size: 32,
      lastModified: '2026-09-03T00:00:00.000Z'
    },
    viewer: { id: 'acme.preview.bin', title: 'Binary', extensions: ['.bin'], priority: 0 },
    read(range) {
      readCalls += 1;
      if (readMode === 'pending') return pendingRead.promise;
      let data;
      if (readMode === 'array-buffer') data = Uint8Array.from([1, 2]).buffer;
      else if (readMode === 'data-view') data = new DataView(Uint8Array.from([0, 3, 4, 0]).buffer, 1, 2);
      else if (readMode === 'cross-realm') data = vm.runInNewContext('new ArrayBuffer(2)');
      else if (readMode === 'string') data = 'no';
      else if (readMode === 'array') data = [1, 2];
      else data = Uint8Array.from([5, 6]);
      return { data, offset: range.offset, length: 2, eof: false };
    }
  };

  const sandbox = sandboxModule.createSandboxedDocumentView(baseOptions);
  void sandbox.ready.catch(() => {});
  const channel = channels[0];
  const request = (id, args) => channel.port1.onmessage({
    data: {
      protocolVersion: sandboxModule.DOCUMENT_VIEW_PROTOCOL_VERSION,
      type: 'request', method: 'document.read', id, args
    }
  });
  const response = (id) => channel.port1.sent.find((item) => item.message.id === id)?.message;

  request(1, { offset: -1, length: 1 });
  request(2, { offset: 0, length: sandboxModule.MAX_DOCUMENT_VIEW_READ_BYTES + 1 });
  assert.equal(readCalls, 0);
  assert.equal(response(1).ok, false);
  assert.equal(response(2).ok, false);

  for (const [id, mode] of [[3, 'bytes'], [4, 'array-buffer'], [5, 'data-view'], [10, 'cross-realm']]) {
    readMode = mode;
    request(id, { offset: 0, length: 4 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response(id).ok, true);
    assert.equal(response(id).value.data.byteLength, 2);
  }
  for (const [id, mode] of [[6, 'string'], [7, 'array']]) {
    readMode = mode;
    request(id, { offset: 0, length: 4 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response(id).ok, false);
    assert.match(response(id).error.message, /ArrayBuffer/);
  }

  sandbox.updateTheme({
    kind: 'light', background: '#fff', surface: '#fff', border: '#000', text: '#000',
    muted: '#555', accent: '#06c', danger: '#c00', fontFamily: 'sans-serif', monoFontFamily: 'monospace'
  });
  assert.equal(channel.port1.sent.at(-1).message.event, 'theme.changed');

  const readGates = [];
  let limitedReadCalls = 0;
  const limitedSandbox = sandboxModule.createSandboxedDocumentView({
    ...baseOptions,
    read(range) {
      limitedReadCalls += 1;
      const gate = deferred();
      readGates.push({ gate, range });
      return gate.promise;
    }
  });
  void limitedSandbox.ready.catch(() => {});
  const limitedChannel = channels[1];
  const limitedRequest = (id) => limitedChannel.port1.onmessage({ data: {
    protocolVersion: sandboxModule.DOCUMENT_VIEW_PROTOCOL_VERSION,
    type: 'request', method: 'document.read', id, args: { offset: 0, length: 4 }
  } });
  for (let index = 0; index < sandboxModule.MAX_DOCUMENT_VIEW_INFLIGHT_READS; index += 1) {
    limitedRequest(20 + index);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(limitedReadCalls, sandboxModule.MAX_DOCUMENT_VIEW_INFLIGHT_READS);
  limitedRequest(30);
  const busyResponse = limitedChannel.port1.sent.find((item) => item.message.id === 30)?.message;
  assert.equal(busyResponse.ok, false);
  assert.equal(busyResponse.error.code, 'DOCUMENT_VIEW_BUSY');
  assert.equal(limitedReadCalls, sandboxModule.MAX_DOCUMENT_VIEW_INFLIGHT_READS);

  readGates[0].gate.resolve({ data: Uint8Array.from([1]), offset: 0, length: 1, eof: true });
  await new Promise((resolve) => setImmediate(resolve));
  limitedRequest(31);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(limitedReadCalls, sandboxModule.MAX_DOCUMENT_VIEW_INFLIGHT_READS + 1);
  for (const { gate, range } of readGates.slice(1)) {
    gate.resolve({ data: Uint8Array.from([1]), offset: range.offset, length: 1, eof: true });
  }
  await new Promise((resolve) => setImmediate(resolve));
  limitedSandbox.dispose();

  readMode = 'pending';
  request(8, { offset: 0, length: 4 });
  await new Promise((resolve) => setImmediate(resolve));
  const sentBeforeDispose = channel.port1.sent.length;
  sandbox.dispose();
  const sentAfterDispose = channel.port1.sent.length;
  assert.equal(sentAfterDispose, sentBeforeDispose + 1, 'dispose event is the final sandbox message');
  pendingRead.resolve({ data: Uint8Array.from([8]), offset: 0, length: 1, eof: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.port1.sent.length, sentAfterDispose);
  assert.equal(response(8), undefined);

  const pendingRejection = deferred();
  const rejectingSandbox = sandboxModule.createSandboxedDocumentView({
    ...baseOptions,
    read: () => pendingRejection.promise
  });
  void rejectingSandbox.ready.catch(() => {});
  const rejectingChannel = channels[2];
  rejectingChannel.port1.onmessage({ data: {
    protocolVersion: sandboxModule.DOCUMENT_VIEW_PROTOCOL_VERSION,
    type: 'request', method: 'document.read', id: 9, args: { offset: 0, length: 4 }
  } });
  await new Promise((resolve) => setImmediate(resolve));
  rejectingSandbox.dispose();
  const rejectingSentAfterDispose = rejectingChannel.port1.sent.length;
  pendingRejection.reject(new Error('late read failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejectingChannel.port1.sent.length, rejectingSentAfterDispose);
  assert.equal(
    rejectingChannel.port1.sent.some((item) => item.message.id === 9),
    false
  );

  let fatalError = null;
  const fatalSandbox = sandboxModule.createSandboxedDocumentView({
    ...baseOptions,
    onError(error) { fatalError = error; }
  });
  const fatalReady = fatalSandbox.ready.catch((error) => error);
  const fatalChannel = channels[3];
  fatalChannel.port1.onmessage({ data: {
    protocolVersion: sandboxModule.DOCUMENT_VIEW_PROTOCOL_VERSION,
    type: 'fatal',
    error: { code: 'DOCUMENT_VIEW_PROTOCOL_ERROR', message: 'activation failed' }
  } });
  assert.equal((await fatalReady).message, 'activation failed');
  assert.equal(fatalError.message, 'activation failed');
  assert.equal(fatalChannel.port1.closed, true);
  assert.equal(fatalChannel.port2.closed, true);
  assert.equal(iframes[3].removed, true);
  assert.equal(fatalChannel.port1.sent.at(-1).message.event, 'dispose');

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let timeoutCallback = null;
  let timeoutError = null;
  try {
    global.setTimeout = (callback) => {
      timeoutCallback = callback;
      return 91;
    };
    global.clearTimeout = () => {};
    const timeoutSandbox = sandboxModule.createSandboxedDocumentView({
      ...baseOptions,
      onError(error) { timeoutError = error; }
    });
    const timeoutReady = timeoutSandbox.ready.catch((error) => error);
    assert.equal(typeof timeoutCallback, 'function');
    timeoutCallback();
    assert.match((await timeoutReady).message, /timed out/);
    assert.match(timeoutError.message, /timed out/);
    assert.equal(channels[4].port1.closed, true);
    assert.equal(channels[4].port2.closed, true);
    assert.equal(iframes[4].removed, true);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  let navigationError = null;
  const navigationSandbox = sandboxModule.createSandboxedDocumentView({
    ...baseOptions,
    onError(error) { navigationError = error; }
  });
  const navigationReady = navigationSandbox.ready.catch((error) => error);
  iframes[5].fire('load');
  await Promise.resolve();
  iframes[5].fire('load');
  assert.match((await navigationReady).message, /preview failed/i);
  assert.match(navigationError.message, /preview failed/i);
  assert.equal(iframes[5].removed, true);
  assert.equal(channels[5].port1.closed, true);

  const mib = 1024 * 1024;
  const maximumSource = 'a'.repeat(sandboxModule.MAX_DOCUMENT_VIEW_SOURCE_BYTES);
  const maximumResource = 'b'.repeat(sandboxModule.MAX_DOCUMENT_VIEW_RESOURCE_BYTES);
  assert.throws(() => sandboxModule.createSandboxedDocumentView({
    ...baseOptions,
    entry: { ...baseOptions.entry, source: maximumSource + 'x' }
  }), /source exceeds/);
  assert.throws(() => sandboxModule.createSandboxedDocumentView({
    ...baseOptions,
    resources: [{ path: 'large.css', source: maximumResource + 'x', hash: '', mimeType: 'text/css' }]
  }), /resource is invalid/);
  assert.throws(() => sandboxModule.createSandboxedDocumentView({
    ...baseOptions,
    entry: { ...baseOptions.entry, source: maximumSource },
    resources: [
      { path: 'a.bin', source: maximumResource, hash: '', mimeType: 'application/octet-stream' },
      { path: 'b.bin', source: maximumResource, hash: '', mimeType: 'application/octet-stream' },
      { path: 'c.bin', source: 'x', hash: '', mimeType: 'application/octet-stream' }
    ]
  }), /combined renderer limit/);
  assert.equal(sandboxModule.MAX_DOCUMENT_VIEW_TOTAL_BYTES, 24 * mib);
});

test('iframe bootstrap cleans a disposer returned after activation was disposed', async (t) => {
  const { buildDocumentViewSandboxDocument, DOCUMENT_VIEW_PROTOCOL_VERSION } = await loadModule(t);
  const activationGate = deferred();
  let activateCalls = 0;
  let deactivateCalls = 0;
  let disposerCalls = 0;
  let viewerContext = null;

  let connectListener;
  const port = {
    onmessage: null,
    sent: [],
    closed: false,
    postMessage(message) { this.sent.push(message); },
    start() {},
    close() { this.closed = true; }
  };
  const parentSource = {};
  const sandboxWindow = {
    parent: parentSource,
    async __import() {
      return {
        activate(context) {
          activateCalls += 1;
          viewerContext = context;
          return activationGate.promise;
        },
        deactivate() { deactivateCalls += 1; }
      };
    },
    addEventListener(type, listener) {
      if (type === 'message') connectListener = listener;
    }
  };
  const context = vm.createContext({
    Array,
    ArrayBuffer,
    Blob,
    Error,
    Map,
    Object,
    Promise,
    Set,
    String,
    TextDecoder,
    Uint8Array,
    console,
    document: {
      documentElement: { style: { setProperty() {} }, dataset: {} },
      addEventListener() {},
      getElementById() { return {}; }
    },
    navigator: {},
    URL: {
      createObjectURL() { return 'blob:document-view-entry'; },
      revokeObjectURL() {}
    },
    window: sandboxWindow
  });
  const html = buildDocumentViewSandboxDocument();
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.lastIndexOf('</script>');
  assert.ok(start >= '<script>'.length && end > start);
  const bootstrap = html.slice(start, end).replace(
    'moduleValue = await import(sourceUrl);',
    'moduleValue = await window.__import(sourceUrl);'
  );
  assert.match(bootstrap, /window\.__import/);
  const script = new vm.Script(bootstrap, { filename: 'document-view-sandbox-bootstrap.js' });
  script.runInContext(context);
  assert.equal(typeof connectListener, 'function');
  connectListener({
    source: {},
    data: { type: 'bobocloud.documentView.connect', protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION },
    ports: [port]
  });
  assert.equal(port.onmessage, null, 'a non-parent window cannot claim the sandbox port');
  connectListener({
    source: parentSource,
    data: { type: 'bobocloud.documentView.connect', protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION },
    ports: [port]
  });
  port.onmessage({ data: {
    protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
    type: 'initialize',
    source: 'export async function activate() {}',
    resources: [],
    document: { documentId: 'doc', name: 'sample', extension: '', size: 0, lastModified: '' },
    viewer: { id: 'acme.preview', title: 'Preview', extensions: ['.preview'], priority: 0 },
    localization: { locale: 'en', messages: {} },
    theme: { kind: 'dark' }
  } });
  for (let attempt = 0; attempt < 20 && activateCalls === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(activateCalls, 1);
  assert.ok(viewerContext);
  const queuedReads = Array.from({ length: 4 }, () => viewerContext.read(0, 1));
  queuedReads.forEach((read) => void read.catch(() => {}));
  await assert.rejects(
    () => viewerContext.read(0, 1),
    { code: 'DOCUMENT_VIEW_BUSY' }
  );
  assert.equal(port.sent.filter((message) => message.type === 'request').length, 4);
  port.onmessage({ data: {
    protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
    type: 'event', event: 'dispose'
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deactivateCalls, 0, 'deactivate must wait for activation to settle');
  activationGate.resolve(() => { disposerCalls += 1; });
  for (let attempt = 0; attempt < 20 && (deactivateCalls === 0 || disposerCalls === 0); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(deactivateCalls, 1);
  assert.equal(disposerCalls, 1);
  assert.equal(port.closed, true);
  assert.equal(port.sent.some((message) => message.type === 'ready' || message.type === 'fatal'), false);
});
