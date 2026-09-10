'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = [path.join(ROOT, 'renderer'), path.join(ROOT, 'src')];
const FACADE_KEYS = Object.freeze([
  'init',
  'load',
  'render',
  'setVisible',
  'setProjectNames',
  'dispose',
  'getFilters'
]);

function buildTypeScriptModule(entryPoint) {
  return esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    write: false,
    logLevel: 'silent'
  }).outputFiles[0].text;
}

function loadTypeScriptModule(entryPoint) {
  const loaded = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', buildTypeScriptModule(entryPoint));
  evaluate(require, loaded, loaded.exports);
  return loaded.exports;
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:js|ts)$/.test(entry.name) ? [target] : [];
  });
}

function compatibilityProjectionOwners(property) {
  const pattern = new RegExp(
    String.raw`\bBOBO(?:\.${property}|\[['"]${property}['"]\])\s*=`,
    'g'
  );
  return SOURCE_ROOTS.flatMap(sourceFiles).flatMap((file) => {
    const count = (fs.readFileSync(file, 'utf8').match(pattern) || []).length;
    return count
      ? [{ file: path.relative(ROOT, file).replace(/\\/g, '/'), count }]
      : [];
  });
}

class FakeEventTarget {
  constructor(name = 'target', operationLog = []) {
    this.name = name;
    this.operationLog = operationLog;
    this.listeners = new Map();
    this.addCalls = new Map();
    this.removeCalls = new Map();
    this.throwOnAdd = new Set();
  }

  addEventListener(type, listener) {
    this.operationLog.push(this.name + ':add:' + type);
    this.addCalls.set(type, (this.addCalls.get(type) || 0) + 1);
    if (this.throwOnAdd.has(type)) throw new Error(this.name + ' add failed: ' + type);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.operationLog.push(this.name + ':remove:' + type);
    this.removeCalls.set(type, (this.removeCalls.get(type) || 0) + 1);
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, init = {}) {
    const event = Object.assign({
      type,
      target: this,
      preventDefault() {}
    }, init);
    return [...(this.listeners.get(type) || [])].map((listener) => listener.call(this, event));
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(name, operationLog) {
    super(name, operationLog);
    this._innerHTML = '';
    this.writeCount = 0;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.writeCount += 1;
  }
}

class FakeDocument {
  constructor(operationLog = [], withRoot = true) {
    this.operationLog = operationLog;
    this.elements = new Map();
    if (withRoot) this.mountCacheRoot();
  }

  mountCacheRoot() {
    const root = new FakeElement('root', this.operationLog);
    this.elements.set('cache-tree', root);
    return root;
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }
}

class FakeStore {
  constructor(inventory, operationLog = []) {
    this.operationLog = operationLog;
    this.subscribeCalls = 0;
    this.unsubscribeCalls = 0;
    this.loadCalls = [];
    this.getEntryCalls = [];
    this.deleteCalls = [];
    this.clearCalls = [];
    this.activeCalls = [];
    this.listeners = new Set();
    this.subscribeError = null;
    this.subscribeAfterNotify = null;
    this.loadImplementation = null;
    this.getEntryImplementation = null;
    this.deleteImplementation = null;
    this.clearImplementation = null;
    this.snapshot = {
      status: 'ready',
      inventory,
      error: null,
      stale: false,
      identity: 'server\u0000token\u0000user',
      mutations: {},
      invalidation: null
    };
  }

  subscribe(listener) {
    this.operationLog.push('store:subscribe');
    this.subscribeCalls += 1;
    if (this.subscribeError) throw this.subscribeError;
    this.listeners.add(listener);
    listener(this.snapshot, 'subscribe');
    if (this.subscribeAfterNotify) this.subscribeAfterNotify();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.operationLog.push('store:unsubscribe');
      this.unsubscribeCalls += 1;
      this.listeners.delete(listener);
    };
  }

  emit(reason = 'change') {
    for (const listener of [...this.listeners]) listener(this.snapshot, reason);
  }

  getState() {
    return this.snapshot;
  }

  load(options) {
    this.loadCalls.push(options);
    return this.loadImplementation
      ? this.loadImplementation(options)
      : Promise.resolve(this.snapshot.inventory);
  }

  getEntry(cacheId) {
    this.getEntryCalls.push(cacheId);
    if (this.getEntryImplementation) return this.getEntryImplementation(cacheId);
    return Promise.resolve(this.snapshot.inventory?.entries.find((entry) => entry.id === cacheId) || null);
  }

  deleteEntry(cacheId) {
    this.deleteCalls.push(cacheId);
    return this.deleteImplementation
      ? this.deleteImplementation(cacheId)
      : Promise.resolve({ success: true });
  }

  clearScope(request) {
    this.clearCalls.push(request);
    return this.clearImplementation
      ? this.clearImplementation(request)
      : Promise.resolve({ success: true });
  }

  setActive(value) {
    this.activeCalls.push(value);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settleUiWork() {
  await Promise.resolve();
  await nextTurn();
  await Promise.resolve();
}

function translate(source, replacements) {
  return String(source).replace(/\{([^}]+)\}/g, (match, key) => (
    replacements && replacements[key] !== undefined ? String(replacements[key]) : match
  ));
}

const cacheModel = loadTypeScriptModule('src/cache-model.ts');
const cacheCenterModule = loadTypeScriptModule('src/cache-center.ts');

function inventory(entries = []) {
  return cacheModel.normalizeInventory({
    schema: 2,
    owner_kind: 'user',
    owner_id: 'root',
    quota_bytes: 1024 * 1024,
    used_bytes: 128 * 1024,
    managed_bytes: 64 * 1024,
    managed_files: 18,
    reclaimable_bytes: 1024,
    reserved_bytes: 2048,
    revision: 'revision-1',
    generated_at: '2026-08-24T12:00:00Z',
    entries
  });
}

function representativeInventory() {
  return inventory([
    {
      id: 'dependency-current',
      category: 'dependencies',
      state: 'current',
      workspace_id: 'root\u0000folder-key',
      workspace_name: '<Fixture & project>',
      runtime_id: 'python:3.10',
      runtime_fingerprint: 'python-runtime',
      dependency_digest: '0123456789abcdef',
      size_bytes: 4096,
      files: 12,
      active_readers: 0,
      writing: false,
      last_used_at: '2026-08-24T11:00:00Z'
    },
    {
      id: 'shared-toolchain',
      category: 'toolchains',
      state: 'ready',
      runtime_id: 'go:1.24',
      size_bytes: 2048,
      files: 4
    },
    {
      id: 'lsp-service',
      category: 'analysis-lsp',
      state: 'ready',
      runtime_id: 'python:3.10',
      size_bytes: 64,
      files: 1
    }
  ]);
}

function createHarness(options = {}) {
  const operationLog = [];
  const document = new FakeDocument(operationLog, options.withRoot !== false);
  const languageEvents = new FakeEventTarget('language', operationLog);
  const state = options.state || {
    workspaceRoot: 'C:\\fixture\\workspace-a',
    workspaceIdentity: 'local-workspace-identity',
    selectedRuntime: 'python:3.10'
  };
  const selectedInventory = options.inventory || representativeInventory();
  const store = options.store || new FakeStore(selectedInventory, operationLog);
  const ports = {
    i18n: { t: translate, getActive: () => 'en' },
    icons: {
      package: '<i-package>', fileText: '<i-file-text>', history: '<i-history>',
      file: '<i-file>', eye: '<i-eye>', eyeOff: '<i-eye-off>', trash: '<i-trash>',
      folder: '<i-folder>', folderOpen: '<i-folder-open>', cloud: '<i-cloud>',
      shield: '<i-shield>', chevronRight: '<i-chevron>'
    },
    toast: { success() {}, error() {} },
    confirm: async () => true,
    projects: { close() {} },
    workbench: { setPrimaryView() {} },
    packageCenter: { open() {} }
  };
  const projectKeyCalls = [];
  const service = cacheCenterModule.createCacheCenterService({
    document,
    languageEvents,
    state,
    model: options.model || cacheModel,
    getStore: options.getStore || (() => store),
    projectKey(workspaceRoot) {
      projectKeyCalls.push(workspaceRoot);
      return 'folder-key';
    },
    getI18n: () => ports.i18n,
    getIcons: () => ports.icons,
    getToast: () => ports.toast,
    getConfirm: () => ports.confirm,
    getProjects: () => ports.projects,
    getWorkbench: () => ports.workbench,
    getPackageCenter: () => ports.packageCenter,
    alert(message) {
      operationLog.push('alert:' + message);
    }
  });
  return {
    document,
    languageEvents,
    operationLog,
    ports,
    projectKeyCalls,
    service,
    state,
    store,
    get root() {
      return document.getElementById('cache-tree');
    }
  };
}

function actionTarget(action, dataset = {}, attributes = {}) {
  const target = {
    disabled: false,
    dataset: Object.assign({ cacheAction: action }, dataset),
    closest(selector) {
      return selector === '[data-cache-action]' ? target : null;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    }
  };
  return target;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('core exports only the injectable global-free cache center service and has one compatibility projection owner', () => {
  assert.deepEqual(Object.keys(cacheCenterModule).sort(), [
    'CACHE_CENTER_SERVICE_ID',
    'createCacheCenterService'
  ]);
  assert.equal(cacheCenterModule.CACHE_CENTER_SERVICE_ID, 'workbench.cacheCenter');

  const source = fs.readFileSync(path.join(ROOT, 'src', 'cache-center.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(?:window|globalThis|BOBO)\b/);
  assert.doesNotMatch(source, /\bmodule\.exports\b|\brequire\s*\(/);
  assert.deepEqual(compatibilityProjectionOwners('cacheCenter'), [{
    file: 'renderer/compat/cache-center-adapter.ts',
    count: 1
  }]);
});

test('init is single-owner, missing roots and subscription failures remain retryable, and dispose is reversible', async () => {
  const harness = createHarness({ withRoot: false });
  const { document, languageEvents, operationLog, ports, service, store } = harness;
  assert.equal(Object.isFrozen(service), true);
  assert.equal(service.disposed, false);

  service.init();
  service.init();
  assert.equal(store.subscribeCalls, 0);
  assert.equal(languageEvents.listenerCount('bobo:language-changed'), 0);
  service.setVisible(true);
  assert.equal(store.activeCalls.length, 0, 'a missing cache root must not activate background loading');

  const root = document.mountCacheRoot();
  service.init();
  service.init();
  assert.deepEqual(operationLog.slice(0, 4), [
    'root:add:click',
    'root:add:change',
    'store:subscribe',
    'language:add:bobo:language-changed'
  ]);
  assert.equal(store.subscribeCalls, 1);
  assert.equal(store.listeners.size, 1);
  assert.equal(root.listenerCount('click'), 1);
  assert.equal(root.listenerCount('change'), 1);
  assert.equal(languageEvents.listenerCount('bobo:language-changed'), 1);

  const writesBeforeLanguageChange = root.writeCount;
  languageEvents.dispatch('bobo:language-changed');
  assert.equal(root.writeCount, writesBeforeLanguageChange, 'identical translated markup must not replace the DOM');
  ports.i18n = {
    t: (source, replacements) => 'LANGUAGE ' + translate(source, replacements),
    getActive: () => 'test'
  };
  languageEvents.dispatch('bobo:language-changed');
  assert.equal(root.writeCount, writesBeforeLanguageChange + 1, 'changed translations must commit exactly once');
  languageEvents.dispatch('bobo:language-changed');
  assert.equal(root.writeCount, writesBeforeLanguageChange + 1, 'duplicate language renders must be coalesced');

  service.setVisible(true);
  assert.equal(store.activeCalls.at(-1), true);
  service.dispose();
  service.dispose();
  assert.equal(service.disposed, true);
  assert.equal(store.unsubscribeCalls, 1);
  assert.equal(store.listeners.size, 0);
  assert.equal(store.activeCalls.at(-1), false);
  assert.equal(root.listenerCount('click'), 0);
  assert.equal(root.listenerCount('change'), 0);
  assert.equal(languageEvents.listenerCount('bobo:language-changed'), 0);

  const writesAfterDispose = root.writeCount;
  languageEvents.dispatch('bobo:language-changed');
  root.dispatch('click', { target: actionTarget('refresh') });
  await settleUiWork();
  assert.equal(root.writeCount, writesAfterDispose);
  assert.equal(store.loadCalls.length, 0);

  service.init();
  service.init();
  assert.equal(service.disposed, false);
  assert.equal(store.subscribeCalls, 2);
  assert.equal(store.listeners.size, 1);
  assert.equal(root.listenerCount('click'), 1);
  assert.equal(root.listenerCount('change'), 1);
  assert.equal(languageEvents.listenerCount('bobo:language-changed'), 1);
  root.dispatch('click', { target: actionTarget('refresh') });
  await settleUiWork();
  assert.deepEqual(store.loadCalls, [{ force: true }]);

  service.dispose();
  await service.load(null);
  assert.equal(service.disposed, false, 'load must preserve the legacy implicit re-initialization contract');
  assert.equal(store.subscribeCalls, 3);
  service.dispose();
  service.setVisible(true);
  assert.equal(service.disposed, false, 'setVisible must preserve the legacy implicit re-initialization contract');
  assert.equal(store.subscribeCalls, 4);
  assert.equal(store.activeCalls.at(-1), true);
  service.dispose();

  const failed = createHarness();
  failed.store.subscribeError = new Error('subscribe failed');
  assert.throws(() => failed.service.init(), /subscribe failed/);
  assert.equal(failed.root.listenerCount('click'), 0);
  assert.equal(failed.root.listenerCount('change'), 0);
  assert.equal(failed.languageEvents.listenerCount('bobo:language-changed'), 0);
  failed.store.subscribeError = null;
  failed.service.init();
  assert.equal(failed.store.subscribeCalls, 2);
  assert.equal(failed.root.listenerCount('click'), 1);
  assert.equal(failed.languageEvents.listenerCount('bobo:language-changed'), 1);
  failed.service.dispose();

  let failRender = true;
  const renderFailed = createHarness({
    model: {
      ...cacheModel,
      groupInventory(value, options) {
        if (failRender) throw new Error('initial render failed');
        return cacheModel.groupInventory(value, options);
      }
    }
  });
  assert.throws(() => renderFailed.service.init(), /initial render failed/);
  assert.equal(renderFailed.store.listeners.size, 0);
  assert.equal(renderFailed.store.unsubscribeCalls, 1);
  assert.equal(renderFailed.root.listenerCount('click'), 0);
  assert.equal(renderFailed.languageEvents.listenerCount('bobo:language-changed'), 0);
  failRender = false;
  renderFailed.service.init();
  assert.equal(renderFailed.store.listeners.size, 1);
  renderFailed.service.dispose();
});

test('init resists subscription reentry and rolls back a dispose during immediate notification', () => {
  const reentrant = createHarness();
  reentrant.store.subscribeAfterNotify = () => reentrant.service.init();
  reentrant.service.init();
  assert.equal(reentrant.store.subscribeCalls, 1);
  assert.equal(reentrant.store.listeners.size, 1);
  assert.equal(reentrant.root.listenerCount('click'), 1);
  reentrant.service.dispose();

  const interrupted = createHarness();
  let interruptOnce = true;
  interrupted.store.subscribeAfterNotify = () => {
    if (!interruptOnce) return;
    interruptOnce = false;
    interrupted.service.dispose();
  };
  interrupted.service.init();
  assert.equal(interrupted.service.disposed, true);
  assert.equal(interrupted.store.listeners.size, 0);
  assert.equal(interrupted.store.unsubscribeCalls, 1);
  assert.equal(interrupted.root.listenerCount('click'), 0);
  assert.equal(interrupted.root.listenerCount('change'), 0);
  assert.equal(interrupted.languageEvents.listenerCount('bobo:language-changed'), 0);

  interrupted.store.subscribeAfterNotify = null;
  interrupted.service.init();
  assert.equal(interrupted.service.disposed, false);
  assert.equal(interrupted.store.listeners.size, 1);
  interrupted.service.dispose();
});

test('project-name snapshots copy only own enumerable data properties into a null-prototype map', () => {
  let capturedProjectNames = null;
  const model = {
    CATEGORY_ORDER: cacheModel.CATEGORY_ORDER,
    groupInventory(value, options) {
      capturedProjectNames = options.projectNames;
      return cacheModel.groupInventory(value, options);
    },
    isCurrentEnvironmentEntry: cacheModel.isCurrentEnvironmentEntry,
    isServiceCategory: cacheModel.isServiceCategory
  };
  const harness = createHarness({ model });
  const names = Object.create({ inherited: 'Inherited project' });
  let getterCalls = 0;
  Object.defineProperties(names, {
    ['__proto__']: { enumerable: true, configurable: true, writable: true, value: 'Own proto' },
    constructor: { enumerable: true, configurable: true, writable: true, value: 'Own constructor' },
    toString: { enumerable: true, configurable: true, writable: true, value: 'Own toString' },
    dangerous: {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error('project-name accessors must not execute');
      }
    },
    hidden: { enumerable: false, value: 'Hidden project' }
  });

  harness.service.init();
  harness.service.setVisible(true);
  harness.service.setProjectNames(names);
  assert.equal(getterCalls, 0);
  assert.equal(Object.getPrototypeOf(capturedProjectNames), null);
  assert.deepEqual(Object.keys(capturedProjectNames), ['__proto__', 'constructor', 'toString']);
  assert.equal(capturedProjectNames.__proto__, 'Own proto');
  assert.equal(capturedProjectNames.constructor, 'Own constructor');
  assert.equal(capturedProjectNames.toString, 'Own toString');
  assert.equal(Object.hasOwn(capturedProjectNames, 'inherited'), false);
  assert.equal(Object.hasOwn(capturedProjectNames, 'dangerous'), false);
  assert.equal(Object.hasOwn(capturedProjectNames, 'hidden'), false);

  names.constructor = 'Changed after snapshot';
  harness.service.render();
  assert.equal(capturedProjectNames.constructor, 'Own constructor');

  const filters = harness.service.getFilters();
  assert.deepEqual(plain(filters), { scope: 'all', category: 'all' });
  filters.scope = 'shared';
  assert.deepEqual(plain(harness.service.getFilters()), { scope: 'all', category: 'all' });
  harness.service.dispose();
});

test('markup, dynamic ports, filters, destructive confirmations, payloads and package navigation stay compatible', async () => {
  const harness = createHarness();
  const { ports, root, service, store } = harness;
  const confirmationCalls = [];
  const toastCalls = [];
  const navigationCalls = [];
  ports.i18n = {
    t: (source, replacements) => 'DYNAMIC ' + translate(source, replacements),
    getActive: () => 'en'
  };
  ports.icons = Object.assign({}, ports.icons, { package: '<dynamic-package-icon>' });
  ports.confirm = async (options) => {
    confirmationCalls.push(options);
    return true;
  };
  ports.toast = {
    success: (message) => toastCalls.push(['success', message]),
    error: (message) => toastCalls.push(['error', message])
  };
  ports.projects = { close: () => navigationCalls.push(['close']) };
  ports.workbench = { setPrimaryView: (view) => navigationCalls.push(['view', view]) };
  ports.packageCenter = { open: (options) => navigationCalls.push(['packages', options]) };

  service.init();
  assert.match(root.innerHTML, /DYNAMIC Project caches/);
  assert.match(root.innerHTML, /<dynamic-package-icon>/);
  assert.match(root.innerHTML, /&lt;Fixture &amp; project&gt;/);
  assert.doesNotMatch(root.innerHTML, /<Fixture & project>/);
  for (const action of ['refresh', 'details', 'delete', 'clear', 'clear-project', 'packages']) {
    assert.match(root.innerHTML, new RegExp('data-cache-action="' + action + '"'));
  }

  root.dispatch('click', { target: actionTarget('refresh') });
  await settleUiWork();
  assert.deepEqual(store.loadCalls, [{ force: true }]);

  root.dispatch('change', { target: { id: 'cache-v2-scope', value: 'shared' } });
  root.dispatch('change', { target: { id: 'cache-v2-category', value: 'toolchains' } });
  assert.deepEqual(plain(service.getFilters()), { scope: 'shared', category: 'toolchains' });
  root.dispatch('click', { target: actionTarget('clear') });
  await settleUiWork();
  assert.equal(confirmationCalls.length, 2);
  assert.deepEqual(plain(store.clearCalls[0]), { scope: 'shared', category: 'toolchains' });

  root.dispatch('change', { target: { id: 'cache-v2-scope', value: 'current' } });
  root.dispatch('change', { target: { id: 'cache-v2-category', value: 'all' } });
  root.dispatch('click', { target: actionTarget('clear') });
  await settleUiWork();
  assert.deepEqual(plain(store.clearCalls[1]), {
    scope: 'workspace',
    workspaceId: 'root\u0000folder-key'
  });

  root.dispatch('change', { target: { id: 'cache-v2-scope', value: 'all' } });
  root.dispatch('click', { target: actionTarget('clear-project', {
    workspaceId: 'workspace-explicit',
    projectName: 'Explicit project'
  }) });
  await settleUiWork();
  assert.deepEqual(plain(store.clearCalls[2]), {
    scope: 'workspace',
    workspaceId: 'workspace-explicit'
  });

  root.dispatch('click', { target: actionTarget('delete', { cacheId: 'dependency-current' }) });
  await settleUiWork();
  assert.deepEqual(store.deleteCalls, ['dependency-current']);
  assert.deepEqual(toastCalls.at(-1), ['success', 'DYNAMIC Cache entry deleted.']);

  root.dispatch('click', { target: actionTarget('packages', { cacheId: 'dependency-current' }) });
  assert.deepEqual(navigationCalls, [
    ['close'],
    ['view', 'environment'],
    ['packages', { mode: 'installed' }]
  ]);

  const clearsBeforeCancel = store.clearCalls.length;
  let confirmIndex = 0;
  ports.confirm = async () => (++confirmIndex === 1);
  root.dispatch('click', { target: actionTarget('clear') });
  await settleUiWork();
  assert.equal(confirmIndex, 2);
  assert.equal(store.clearCalls.length, clearsBeforeCancel, 'second-step cancellation must prevent deletion');
  service.dispose();
});

test('late detail results cannot override close, delete, clear or dispose intent', async (t) => {
  for (const scenario of ['close', 'delete', 'clear', 'dispose']) {
    await t.test(scenario, async () => {
      const harness = createHarness();
      const gate = deferred();
      harness.store.getEntryImplementation = () => gate.promise;
      harness.service.init();
      harness.root.dispatch('click', {
        target: actionTarget('details', { cacheId: 'dependency-current' })
      });
      assert.match(harness.root.innerHTML, /cache-v2-entry-detail/);
      assert.deepEqual(harness.store.getEntryCalls, ['dependency-current']);

      if (scenario === 'close') {
        harness.root.dispatch('click', {
          target: actionTarget('details', { cacheId: 'dependency-current' })
        });
        assert.doesNotMatch(harness.root.innerHTML, /cache-v2-entry-detail/);
      } else if (scenario === 'delete') {
        harness.root.dispatch('click', {
          target: actionTarget('delete', { cacheId: 'dependency-current' })
        });
        await settleUiWork();
        assert.deepEqual(harness.store.deleteCalls, ['dependency-current']);
      } else if (scenario === 'clear') {
        harness.root.dispatch('click', { target: actionTarget('clear') });
        await settleUiWork();
        assert.equal(harness.store.clearCalls.length, 1);
      } else {
        harness.service.dispose();
      }

      const writesBeforeLateResult = harness.root.writeCount;
      if (scenario === 'dispose') gate.reject(new Error('late detail failure'));
      else gate.resolve(harness.store.snapshot.inventory.entries[0]);
      await settleUiWork();
      assert.equal(
        harness.root.writeCount,
        writesBeforeLateResult,
        'a stale detail result must not trigger a render after ' + scenario
      );
      if (scenario === 'close') {
        assert.doesNotMatch(harness.root.innerHTML, /cache-v2-entry-detail/);
      }
      harness.service.dispose();
    });
  }
});

test('destructive confirmations cannot cross lifecycle, store, context or inventory revisions', async (t) => {
  for (const scenario of ['lifecycle', 'store', 'context', 'revision']) {
    await t.test(scenario, async () => {
      const firstStore = new FakeStore(representativeInventory());
      const replacementStore = new FakeStore(representativeInventory());
      let selectedStore = firstStore;
      const harness = createHarness({
        store: firstStore,
        getStore: () => selectedStore
      });
      const confirmation = deferred();
      harness.ports.confirm = () => confirmation.promise;
      harness.service.init();
      harness.root.dispatch('click', {
        target: actionTarget('delete', { cacheId: 'dependency-current' })
      });
      await Promise.resolve();

      if (scenario === 'lifecycle') {
        harness.service.dispose();
        harness.service.init();
      } else if (scenario === 'store') {
        selectedStore = replacementStore;
      } else if (scenario === 'context') {
        harness.state.workspaceIdentity = 'changed-workspace';
      } else {
        firstStore.snapshot.inventory = {
          ...firstStore.snapshot.inventory,
          revision: 'changed-revision'
        };
      }

      confirmation.resolve(true);
      await settleUiWork();
      assert.deepEqual(firstStore.deleteCalls, []);
      assert.deepEqual(replacementStore.deleteCalls, []);
      harness.service.dispose();
    });
  }

  await t.test('clear between confirmations', async () => {
    const harness = createHarness();
    const secondConfirmation = deferred();
    let confirmationCount = 0;
    harness.ports.confirm = () => {
      confirmationCount += 1;
      return confirmationCount === 1 ? Promise.resolve(true) : secondConfirmation.promise;
    };
    harness.service.init();
    harness.root.dispatch('click', { target: actionTarget('clear') });
    await settleUiWork();
    assert.equal(confirmationCount, 2);
    harness.service.dispose();
    harness.service.init();
    secondConfirmation.resolve(true);
    await settleUiWork();
    assert.deepEqual(harness.store.clearCalls, []);
    harness.service.dispose();
  });
});

test('completed mutations from a released lifecycle cannot alter the new lifecycle UI', async (t) => {
  for (const action of ['delete', 'clear']) {
    await t.test(action, async () => {
      const harness = createHarness();
      const mutation = deferred();
      const toastCalls = [];
      harness.ports.toast = {
        success: (message) => toastCalls.push(['success', message]),
        error: (message) => toastCalls.push(['error', message])
      };
      if (action === 'delete') harness.store.deleteImplementation = () => mutation.promise;
      else harness.store.clearImplementation = () => mutation.promise;
      harness.service.init();
      harness.root.dispatch('click', {
        target: actionTarget(action, action === 'delete' ? { cacheId: 'dependency-current' } : {})
      });
      await settleUiWork();
      assert.equal(
        action === 'delete' ? harness.store.deleteCalls.length : harness.store.clearCalls.length,
        1
      );

      harness.service.dispose();
      harness.service.init();
      const writesBeforeCompletion = harness.root.writeCount;
      mutation.resolve({ success: true });
      await settleUiWork();
      assert.deepEqual(toastCalls, []);
      assert.equal(harness.root.writeCount, writesBeforeCompletion);
      harness.service.dispose();
    });
  }
});

test('notification port failures cannot rewrite successful mutation outcomes', async () => {
  const successful = createHarness();
  successful.ports.toast = Object.defineProperty({}, 'success', {
    get() {
      throw new Error('toast getter failed');
    }
  });
  successful.service.init();
  successful.root.dispatch('click', {
    target: actionTarget('delete', { cacheId: 'dependency-current' })
  });
  await settleUiWork();
  assert.deepEqual(successful.store.deleteCalls, ['dependency-current']);
  assert.equal(successful.operationLog.some((entry) => entry.startsWith('alert:')), false);
  successful.service.dispose();

  const failed = createHarness();
  failed.store.deleteImplementation = () => Promise.reject(new Error('mutation failed'));
  failed.ports.toast = Object.defineProperty({}, 'error', {
    get() {
      throw new Error('error toast getter failed');
    }
  });
  failed.service.init();
  failed.root.dispatch('click', {
    target: actionTarget('delete', { cacheId: 'dependency-current' })
  });
  await settleUiWork();
  assert.ok(failed.operationLog.includes('alert:mutation failed'));
  failed.service.dispose();
});

async function buildAdapterBundle() {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "import { rendererPlatform } from './renderer/core/bootstrap';",
        'export async function install(stubs) {',
        "  rendererPlatform.services.register('workbench.cacheStore', stubs.store, { owner: 'test.cache-store', exposeToPlugins: false });",
        "  rendererPlatform.services.register('workbench.i18n', stubs.i18n, { owner: 'test.i18n', exposeToPlugins: false });",
        "  rendererPlatform.services.register('workbench.confirm', stubs.confirm, { owner: 'test.confirm', exposeToPlugins: false });",
        "  await import('./renderer/compat/cache-center-adapter');",
        '  return rendererPlatform;',
        '}'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'tests/cache-center-adapter-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'cache-center-adapter-i18n-id',
      setup(build) {
        build.onResolve({ filter: /^\.\/i18n-adapter$/ }, (args) => {
          if (!args.importer.endsWith('cache-center-adapter.ts')) return null;
          return { path: 'cache-center-i18n-id', namespace: 'cache-center-test' };
        });
        build.onLoad({ filter: /.*/, namespace: 'cache-center-test' }, () => ({
          contents: "export const I18N_SERVICE_ID = 'workbench.i18n';",
          loader: 'ts'
        }));
      }
    }]
  });
  return result.outputFiles[0].text;
}

async function installAdapter(window, document, stubs) {
  const source = await buildAdapterBundle();
  const loaded = { exports: {} };
  const context = {
    AbortController,
    clearTimeout,
    console,
    document,
    exports: loaded.exports,
    module: loaded,
    Promise,
    queueMicrotask,
    require,
    setTimeout,
    window
  };
  vm.runInNewContext(source, context, { filename: 'tests/cache-center-adapter-entry.ts' });
  return loaded.exports.install(stubs);
}

test('adapter owns the exact writable facade, dynamically delegates legacy ports, and registers a private disposable service', async () => {
  const operationLog = [];
  const document = new FakeDocument(operationLog);
  const window = new FakeEventTarget('window', operationLog);
  window.document = document;
  window.alert = () => undefined;
  const capturedState = {
    workspaceRoot: 'C:\\captured\\workspace',
    workspaceIdentity: 'captured-workspace',
    selectedRuntime: 'python:3.10'
  };
  const firstStore = new FakeStore(representativeInventory(), operationLog);
  const replacementStore = new FakeStore(representativeInventory(), operationLog);
  let dynamicModelCalls = 0;
  let dynamicProjectKeyCalls = [];
  const existingBobo = {
    sentinel: Object.freeze({ retained: true }),
    state: capturedState,
    cacheModel,
    cacheStore: firstStore,
    i18n: { t: translate, getActive: () => 'en' },
    icons: {},
    confirm: async () => true
  };
  window.BOBO = existingBobo;

  const platform = await installAdapter(window, document, {
    store: firstStore,
    i18n: { t: translate, getActive: () => 'en' },
    confirm: { confirm: async () => true }
  });
  const facade = window.BOBO.cacheCenter;
  const service = platform.services.require('workbench.cacheCenter');
  assert.equal(window.BOBO, existingBobo);
  assert.deepEqual(Object.keys(facade), FACADE_KEYS);
  for (const key of FACADE_KEYS) {
    assert.equal(Object.getOwnPropertyDescriptor(facade, key).writable, true, key);
    assert.equal(facade[key], service[key], key + ' delegates to the registered service');
  }
  assert.equal('disposed' in facade, false);
  assert.notEqual(service, facade);
  assert.equal(Object.isFrozen(service), true);
  assert.deepEqual(
    plain(platform.services.describe().filter(({ id }) => id === 'workbench.cacheCenter')),
    [{ id: 'workbench.cacheCenter', owner: 'core.cacheInventory', exposeToPlugins: false }]
  );
  assert.throws(
    () => platform.services.getForPluginDynamic('workbench.cacheCenter'),
    /not exposed to plugins/
  );

  window.BOBO.cacheStore = replacementStore;
  window.BOBO.cacheModel = {
    CATEGORY_ORDER: cacheModel.CATEGORY_ORDER,
    groupInventory(value, options) {
      dynamicModelCalls += 1;
      return cacheModel.groupInventory(value, options);
    },
    isCurrentEnvironmentEntry: cacheModel.isCurrentEnvironmentEntry,
    isServiceCategory: cacheModel.isServiceCategory
  };
  window.BOBO.i18n = {
    t: (source, replacements) => 'ADAPTER ' + translate(source, replacements),
    getActive: () => 'en'
  };
  window.BOBO.projectKey = (workspaceRoot) => {
    dynamicProjectKeyCalls.push(workspaceRoot);
    return 'folder-key';
  };
  window.BOBO.state = {
    workspaceRoot: 'C:\\replacement\\must-not-be-captured',
    workspaceIdentity: 'replacement-workspace',
    selectedRuntime: 'go:1.24'
  };

  facade.init();
  facade.render();
  assert.equal(firstStore.subscribeCalls, 0);
  assert.equal(replacementStore.subscribeCalls, 1);
  assert.ok(dynamicModelCalls >= 1);
  assert.ok(dynamicProjectKeyCalls.length >= 1);
  assert.equal(dynamicProjectKeyCalls.at(-1), capturedState.workspaceRoot);
  assert.match(document.getElementById('cache-tree').innerHTML, /ADAPTER Project caches/);

  facade.dispose();
  assert.equal(service.disposed, true);
  facade.init();
  assert.equal(service.disposed, false);
  await platform.dispose();
  assert.equal(service.disposed, true);
  assert.equal(platform.services.has('workbench.cacheCenter'), false);
});
