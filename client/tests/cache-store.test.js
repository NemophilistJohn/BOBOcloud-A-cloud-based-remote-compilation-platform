'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { directBridgeAccessCount } = require('./support/renderer-bridge-access');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = [path.join(ROOT, 'renderer'), path.join(ROOT, 'src')];
const STORE_FACADE_KEYS = Object.freeze([
  'subscribe',
  'getState',
  'load',
  'getEntry',
  'deleteEntry',
  'clearScope',
  'invalidate',
  'setActive',
  'reset'
]);
const FACTORY_FACADE_KEYS = Object.freeze([
  'createCacheStore',
  'extractData',
  'extractCacheInventory',
  'extractCacheEntry'
]);

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
    const source = fs.readFileSync(file, 'utf8');
    const count = (source.match(pattern) || []).length;
    return count > 0
      ? [{ file: path.relative(ROOT, file).replace(/\\/g, '/'), count }]
      : [];
  });
}

function loadTypeScriptModule(entryPoint) {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    write: false,
    logLevel: 'silent'
  });
  const loaded = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', build.outputFiles[0].text);
  evaluate(require, loaded, loaded.exports);
  return loaded.exports;
}

const cacheModel = loadTypeScriptModule('src/cache-model.ts');
const cacheStore = loadTypeScriptModule('src/cache-store.ts');
const ADAPTER_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  stdin: {
    contents: [
      "import { rendererPlatform } from './renderer/core/bootstrap.ts';",
      "import './renderer/compat/cache-model-adapter.ts';",
      "import './renderer/compat/cache-store-adapter.ts';",
      'window.__cacheStorePlatform = rendererPlatform;'
    ].join('\n'),
    loader: 'ts',
    resolveDir: ROOT,
    sourcefile: 'tests/cache-store-adapter-entry.ts'
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message || 'condition was not reached');
}

function settleWithin(promise, label = 'cache-store operation') {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' did not settle')), 1500);
  });
  return Promise.race([Promise.resolve(promise), timeout])
    .finally(() => clearTimeout(timer));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function rawInventory(revision, entries = []) {
  return {
    schema: 2,
    revision,
    owner_kind: 'user',
    owner_id: 'root',
    quota_bytes: 1000,
    used_bytes: 100,
    reserved_bytes: 10,
    generated_at: '2026-08-24T12:00:00Z',
    entries
  };
}

function rawEntry(id) {
  return {
    schema: 2,
    id,
    category: 'results',
    state: 'available',
    size_bytes: 10,
    files: 1
  };
}

function defaultState() {
  return {
    serverSettings: { ip: '127.0.0.1' },
    auth: { token: 'token-a', user: { id: 'user-a' } }
  };
}

function createHarness(handler, options = {}) {
  const calls = [];
  const invalidationEvents = [];
  const listenerErrors = [];
  const controllers = [];
  const state = options.state || defaultState();
  const service = cacheStore.createCacheStoreService({
    model: options.model || cacheModel,
    getState: () => state,
    sendToServer(action, payload, transportOptions) {
      const call = { action, payload, options: transportOptions };
      calls.push(call);
      return handler(action, payload, transportOptions, calls.length);
    },
    createAbortController() {
      if (options.createAbortController) return options.createAbortController();
      const controller = new AbortController();
      controllers.push(controller);
      return controller;
    },
    dispatchInvalidationEvent(detail) {
      invalidationEvents.push(detail);
      if (options.trace) options.trace.push('dispatch:invalidate');
    },
    reportListenerError(error) {
      listenerErrors.push(error);
      if (options.reportListenerError) options.reportListenerError(error);
    }
  });
  return { calls, controllers, invalidationEvents, listenerErrors, service, state };
}

function assertContextChanged(promise) {
  return assert.rejects(settleWithin(promise, 'context-invalidated operation'), (error) => (
    error
    && error.code === 'cache_context_changed'
  ));
}

function assertDisposed(promise) {
  return assert.rejects(settleWithin(promise, 'disposed operation'), (error) => (
    error
    && error.code === 'cache_store_disposed'
  ));
}

test('typed core is side-effect free and exports only the cache-store contract', () => {
  const coreFile = 'src/cache-store.ts';
  const adapterFile = 'renderer/compat/cache-store-adapter.ts';
  const coreSource = fs.readFileSync(path.join(ROOT, coreFile), 'utf8');
  const adapterSource = fs.readFileSync(path.join(ROOT, adapterFile), 'utf8');

  assert.deepEqual(Object.keys(cacheStore).sort(), [
    'CACHE_STORE_SERVICE_ID',
    'createCacheStoreService',
    'extractCacheEntry',
    'extractCacheInventory',
    'extractData'
  ]);
  assert.equal(cacheStore.CACHE_STORE_SERVICE_ID, 'workbench.cacheStore');
  assert.doesNotMatch(coreSource, /\b(?:window|globalThis|BOBO|module\.exports|require\s*\()/);
  assert.equal(directBridgeAccessCount(coreFile, coreSource), 0);
  assert.equal(directBridgeAccessCount(adapterFile, adapterSource), 0);
  assert.equal((adapterSource.match(/BOBO\.cacheStore\s*=/g) || []).length, 1);
  assert.equal((adapterSource.match(/BOBO\.cacheStoreFactory\s*=/g) || []).length, 1);
  assert.deepEqual(compatibilityProjectionOwners('cacheStore'), [
    { file: adapterFile, count: 1 }
  ]);
  assert.deepEqual(compatibilityProjectionOwners('cacheStoreFactory'), [
    { file: adapterFile, count: 1 }
  ]);
  assert.doesNotMatch(adapterSource, /\bcreateRendererPlatform\s*\(|\bnew\s+ServiceRegistry\s*\(/);
});

test('response extraction preserves data, Data, and top-level precedence', () => {
  const lowerData = { marker: 'lower' };
  const upperData = { marker: 'upper' };
  const response = { marker: 'top', data: lowerData, Data: upperData };
  assert.equal(cacheStore.extractData(response), lowerData);
  assert.equal(cacheStore.extractData({ marker: 'top', Data: upperData }), upperData);
  assert.deepEqual(cacheStore.extractData({ marker: 'top' }), { marker: 'top' });
  assert.deepEqual(cacheStore.extractData(null), {});

  const lowerInventory = rawInventory('lower');
  const upperInventory = rawInventory('upper');
  const topInventory = rawInventory('top');
  assert.equal(cacheStore.extractCacheInventory({
    cacheInventory: topInventory,
    Data: { cacheInventory: upperInventory },
    data: { cacheInventory: lowerInventory }
  }), lowerInventory);
  assert.equal(cacheStore.extractCacheInventory({
    cacheInventory: topInventory,
    Data: { cacheInventory: upperInventory }
  }), upperInventory);
  assert.equal(cacheStore.extractCacheInventory({ cacheInventory: topInventory }), topInventory);

  const lowerEntry = rawEntry('lower');
  const upperEntry = rawEntry('upper');
  const topEntry = rawEntry('top');
  assert.equal(cacheStore.extractCacheEntry({
    cacheEntry: topEntry,
    Data: { cacheEntry: upperEntry },
    data: { cacheEntry: lowerEntry }
  }), lowerEntry);
  assert.equal(cacheStore.extractCacheEntry({
    cacheEntry: topEntry,
    Data: { cacheEntry: upperEntry }
  }), upperEntry);
  assert.equal(cacheStore.extractCacheEntry({ cacheEntry: topEntry }), topEntry);
});

test('load accepts non-false success values and emits immediate ordered snapshots', async () => {
  const listenerFailure = new Error('listener failed');
  const runtime = createHarness(async () => ({
    success: 0,
    data: { cacheInventory: rawInventory('ready-r1') }
  }));
  const trace = [];
  const snapshots = [];

  runtime.service.subscribe((snapshot, reason) => {
    trace.push(reason);
    snapshots.push(snapshot);
  });
  runtime.service.subscribe((_snapshot, reason) => {
    if (reason !== 'subscribe') throw listenerFailure;
  });
  const inventory = await runtime.service.load();

  assert.equal(inventory.revision, 'ready-r1');
  assert.deepEqual(trace, ['subscribe', 'load-start', 'load-success']);
  assert.equal(snapshots[0].status, 'idle');
  assert.equal(snapshots[1].status, 'loading');
  assert.equal(snapshots[2].status, 'ready');
  assert.equal(snapshots[2].inventory, inventory);
  assert.equal(runtime.listenerErrors.length, 2);
  assert.equal(runtime.listenerErrors.every((error) => error === listenerFailure), true);
  assert.deepEqual(runtime.calls[0].payload, {});
  assert.equal(runtime.calls[0].options.quiet, true);
  assert.equal(runtime.calls[0].options.timeoutMs, 20_000);
  assert.ok(runtime.calls[0].options.signal);

  snapshots[2].mutations.injected = true;
  assert.equal(Object.hasOwn(runtime.service.getState().mutations, 'injected'), false);
});

test('listener and error-reporter failures cannot replace or strand load settlement', async () => {
  const listenerFailure = new Error('listener failed');
  const reporterFailure = new Error('reporter failed');
  const networkFailure = new Error('network failed');
  for (const outcome of ['success', 'failure']) {
    const runtime = createHarness(async () => {
      if (outcome === 'failure') throw networkFailure;
      return { success: true, data: { cacheInventory: rawInventory('listener-safe') } };
    }, {
      reportListenerError() { throw reporterFailure; }
    });
    runtime.service.subscribe((_snapshot, reason) => {
      if (reason !== 'subscribe') throw listenerFailure;
    });

    const loading = runtime.service.load({ force: true });
    if (outcome === 'success') {
      assert.equal((await loading).revision, 'listener-safe');
    } else {
      await assert.rejects(loading, (error) => error === networkFailure);
    }
    assert.ok(runtime.listenerErrors.length >= 1);
    assert.equal(runtime.listenerErrors.every((error) => error === listenerFailure), true);
  }
});

test('false and falsy responses preserve nested errors and protocol codes', async () => {
  const camel = createHarness(async () => ({
    success: false,
    errorCode: 'cache_denied',
    data: { error: 'nested denial' }
  }));
  await assert.rejects(camel.service.load({ force: true }), (error) => (
    error.message === 'nested denial' && error.code === 'cache_denied'
  ));

  const snake = createHarness(async () => ({
    success: false,
    error: 'top-level denial',
    error_code: 'cache_denied_snake'
  }));
  await assert.rejects(snake.service.load({ force: true }), (error) => (
    error.message === 'top-level denial' && error.code === 'cache_denied_snake'
  ));

  const falsy = createHarness(async () => null);
  await assert.rejects(
    falsy.service.load({ force: true }),
    /Failed to load cache inventory\./
  );

  const legacy = createHarness(async () => ({ success: true, cacheGroups: [] }));
  await assert.rejects(
    legacy.service.load({ force: true }),
    (error) => error.code === 'cache_inventory_protocol_error'
  );
});

test('reads use 20s transport options and mutations use camelCase payloads without signals', async () => {
  let revision = 'revision-before';
  const runtime = createHarness(async (action) => {
    if (action === 'getCacheInventory') {
      return { success: true, data: { cacheInventory: rawInventory(revision) } };
    }
    if (action === 'getCacheEntry') {
      return { success: true, Data: { cacheEntry: rawEntry('opaque-entry') } };
    }
    if (action === 'deleteCacheEntry') {
      revision = 'revision-after-delete';
      return { success: true };
    }
    if (action === 'clearCacheScope') {
      revision = 'revision-after-clear';
      return { success: true };
    }
    throw new Error('unexpected action: ' + action);
  });
  const reasons = [];
  runtime.service.subscribe((_snapshot, reason) => reasons.push(reason));

  await runtime.service.load({ force: true });
  const entry = await runtime.service.getEntry('  opaque-entry  ');
  await runtime.service.deleteEntry('  opaque-entry  ');
  await runtime.service.clearScope({
    scope: 'workspace',
    workspaceId: 'workspace-id',
    category: 'dependencies'
  });

  const entryCall = runtime.calls.find((call) => call.action === 'getCacheEntry');
  const deleteCall = runtime.calls.find((call) => call.action === 'deleteCacheEntry');
  const clearCall = runtime.calls.find((call) => call.action === 'clearCacheScope');
  assert.equal(entry.id, 'opaque-entry');
  assert.deepEqual(entryCall.payload, { cacheId: 'opaque-entry' });
  assert.deepEqual(entryCall.options, { quiet: true, timeoutMs: 20_000 });
  assert.deepEqual(deleteCall.payload, {
    cacheId: 'opaque-entry',
    expectedRevision: 'revision-before'
  });
  assert.deepEqual(clearCall.payload, {
    scope: 'workspace',
    expectedRevision: 'revision-after-delete',
    workspaceId: 'workspace-id',
    category: 'dependencies'
  });
  for (const call of [deleteCall, clearCall]) {
    assert.deepEqual(call.options, { quiet: true, timeoutMs: 30_000 });
    assert.equal(Object.hasOwn(call.options, 'signal'), false);
  }
  assert.deepEqual(reasons, [
    'subscribe',
    'load-start', 'load-success',
    'mutation-start', 'load-start', 'load-success', 'mutation-end',
    'mutation-start', 'load-start', 'load-success', 'mutation-end'
  ]);
  assert.equal(Object.keys(runtime.service.getState().mutations).length, 0);
});

test('scope validation preserves established error codes and omits all-category payloads', async () => {
  const runtime = createHarness(async (action) => {
    if (action === 'clearCacheScope') return { success: true };
    if (action === 'getCacheInventory') {
      return { success: true, data: { cacheInventory: rawInventory('scope-refresh') } };
    }
    throw new Error('unexpected action: ' + action);
  });

  await assert.rejects(
    runtime.service.clearScope({ scope: 'future' }),
    (error) => error.code === 'cache_scope_invalid'
  );
  await assert.rejects(
    runtime.service.clearScope({ scope: 'workspace' }),
    (error) => error.code === 'cache_workspace_required'
  );
  await assert.rejects(
    runtime.service.deleteEntry('  '),
    (error) => error.code === 'cache_id_required'
  );
  await assert.rejects(
    runtime.service.getEntry(''),
    (error) => error.code === 'cache_id_required'
  );

  await runtime.service.clearScope({ scope: 'owner', category: 'all' });
  assert.deepEqual(runtime.calls[0].payload, { scope: 'owner', expectedRevision: '' });
});

test('identity changes clear the previous inventory before the next load-start event', async () => {
  const switched = deferred();
  let inventoryRequests = 0;
  const runtime = createHarness(async (action) => {
    assert.equal(action, 'getCacheInventory');
    inventoryRequests += 1;
    if (inventoryRequests === 1) {
      return { success: true, data: { cacheInventory: rawInventory('user-a') } };
    }
    return switched.promise;
  });
  const observations = [];
  runtime.service.subscribe((snapshot, reason) => observations.push({ snapshot, reason }));
  await runtime.service.load({ force: true });

  runtime.state.auth = { token: 'token-b', user: { id: 'user-b' } };
  const nextLoad = runtime.service.load({ force: true });
  const start = observations.at(-1);
  assert.equal(start.reason, 'load-start');
  assert.equal(start.snapshot.status, 'loading');
  assert.equal(start.snapshot.inventory, null);
  assert.equal(start.snapshot.identity, '127.0.0.1\ntoken-b\nuser-b');

  switched.resolve({ success: true, data: { cacheInventory: rawInventory('user-b') } });
  assert.equal((await settleWithin(nextLoad, 'identity replacement load')).revision, 'user-b');
});

test('getState is observational and a new operation starts in a cleared replacement identity', async () => {
  const entryResponse = deferred();
  let inventoryRequests = 0;
  const runtime = createHarness(async (action) => {
    if (action === 'getCacheInventory') {
      inventoryRequests += 1;
      return {
        success: true,
        data: { cacheInventory: rawInventory(inventoryRequests === 1 ? 'user-a' : 'user-c') }
      };
    }
    if (action === 'getCacheEntry') return entryResponse.promise;
    if (action === 'deleteCacheEntry') return { success: true };
    throw new Error('unexpected action: ' + action);
  });
  await runtime.service.load({ force: true });

  runtime.state.auth = { token: 'token-b', user: { id: 'user-b' } };
  const observed = runtime.service.getState();
  assert.equal(observed.inventory.revision, 'user-a');
  assert.equal(observed.identity, '127.0.0.1\ntoken-a\nuser-a');

  const detail = runtime.service.getEntry('entry-b');
  const duringDetail = runtime.service.getState();
  assert.equal(duringDetail.inventory, null);
  assert.equal(duringDetail.identity, '127.0.0.1\ntoken-b\nuser-b');
  entryResponse.resolve({ success: true, data: { cacheEntry: rawEntry('entry-b') } });
  assert.equal((await settleWithin(detail, 'replacement identity detail')).id, 'entry-b');

  runtime.state.auth = { token: 'token-c', user: { id: 'user-c' } };
  const deletion = runtime.service.deleteEntry('entry-c');
  const deleteCall = runtime.calls.find((call) => call.action === 'deleteCacheEntry');
  assert.deepEqual(deleteCall.payload, { cacheId: 'entry-c', expectedRevision: '' });
  assert.equal(runtime.service.getState().inventory, null);
  await settleWithin(deletion, 'replacement identity deletion');
  assert.equal(runtime.service.getState().inventory.revision, 'user-c');
});

test('load-start force reentrancy keeps one live request and gives its serial tail a new signal', async () => {
  const pending = [];
  const runtime = createHarness((_action, _payload, _options, callNumber) => {
    const request = deferred();
    pending.push({ callNumber, request });
    return request.promise;
  });
  let reentrantLoad;
  let reentered = false;
  runtime.service.subscribe((_snapshot, reason) => {
    if (reason === 'load-start' && !reentered) {
      reentered = true;
      reentrantLoad = runtime.service.load({ force: true });
    }
  });

  const firstLoad = runtime.service.load();
  assert.equal(runtime.calls.length, 1, 'synchronous force reentrancy must join the first flight');
  const firstSignal = runtime.calls[0].options.signal;
  assert.equal(firstSignal.aborted, false);

  pending[0].request.resolve({
    success: true,
    data: { cacheInventory: rawInventory('dirty-first-flight') }
  });
  assert.equal(await settleWithin(firstLoad, 'dirty first flight'), null);
  await waitFor(() => runtime.calls.length === 2, 'the serial reentrant tail did not start');
  const tailSignal = runtime.calls[1].options.signal;
  assert.notEqual(tailSignal, firstSignal);
  assert.equal(firstSignal.aborted, false);
  assert.equal(tailSignal.aborted, false);
  pending[1].request.resolve({
    success: true,
    data: { cacheInventory: rawInventory('reentrant-winner') }
  });
  assert.equal((await settleWithin(reentrantLoad, 'reentrant tail')).revision, 'reentrant-winner');
  assert.equal(runtime.service.getState().inventory.revision, 'reentrant-winner');
});

test('same-identity loads single-flight and inactive manual refreshes coalesce invalidations into one tail', async () => {
  const pending = [];
  const runtime = createHarness(() => {
    const request = deferred();
    pending.push(request);
    return request.promise;
  });

  const first = runtime.service.load();
  const joined = runtime.service.load();
  assert.equal(runtime.calls.length, 1);
  pending[0].resolve({ success: true, data: { cacheInventory: rawInventory('joined') } });
  const [firstInventory, joinedInventory] = await settleWithin(
    Promise.all([first, joined]),
    'joined inventory loads'
  );
  assert.equal(firstInventory, joinedInventory);
  assert.equal(firstInventory.revision, 'joined');

  let tailSucceeded = false;
  runtime.service.subscribe((snapshot, reason) => {
    if (reason === 'load-success' && snapshot.inventory?.revision === 'tail') {
      tailSucceeded = true;
    }
  });
  const manualRefresh = runtime.service.load({ force: true });
  runtime.service.invalidate({ reason: 'server-event-1', marker: 1 });
  runtime.service.invalidate({ reason: 'server-event-2', marker: 2 });
  runtime.service.invalidate({ reason: 'server-event-3', marker: 3 });
  assert.equal(runtime.calls.length, 2, 'invalidations join the active refresh');
  assert.deepEqual(runtime.invalidationEvents.map((detail) => detail.marker), [1, 2, 3]);

  pending[1].resolve({ success: true, data: { cacheInventory: rawInventory('before-tail') } });
  await waitFor(() => runtime.calls.length === 3, 'trailing refresh did not start');
  pending[2].resolve({ success: true, data: { cacheInventory: rawInventory('tail') } });
  await waitFor(() => tailSucceeded, 'tail success was not published');
  assert.equal((await settleWithin(manualRefresh, 'manual trailing refresh')).revision, 'tail');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.calls.length, 3);
  assert.equal(runtime.service.getState().inventory.revision, 'tail');
  assert.equal(runtime.service.getState().stale, false);
  assert.deepEqual(runtime.service.getState().invalidation, {
    reason: 'server-event-3',
    marker: 3
  });
});

test('invalidation notifies subscribers before dispatching the compatibility event', () => {
  const trace = [];
  const runtime = createHarness(() => {
    throw new Error('inactive invalidation must not load');
  }, { trace });
  runtime.service.subscribe((_snapshot, reason) => {
    if (reason === 'invalidate') trace.push('listener:invalidate');
  });

  runtime.service.invalidate({ reason: 'external', marker: 9 });

  assert.deepEqual(trace, ['listener:invalidate', 'dispatch:invalidate']);
  assert.deepEqual(runtime.invalidationEvents, [{ reason: 'external', marker: 9 }]);
  assert.equal(runtime.calls.length, 0);
});

test('successful mutation with a failed refresh issues only one inventory GET', async () => {
  let getCount = 0;
  const runtime = createHarness(async (action) => {
    if (action === 'getCacheInventory') {
      getCount += 1;
      if (getCount === 1) {
        return { success: true, data: { cacheInventory: rawInventory('before-write') } };
      }
      throw new Error('refresh failed');
    }
    if (action === 'deleteCacheEntry') return { success: true };
    throw new Error('unexpected action: ' + action);
  });

  await runtime.service.load({ force: true });
  await assert.rejects(runtime.service.deleteEntry('entry-a'), /refresh failed/);

  assert.equal(getCount, 2, 'the failed post-success refresh must not be retried');
  assert.deepEqual(runtime.calls.map((call) => call.action), [
    'getCacheInventory',
    'deleteCacheEntry',
    'getCacheInventory'
  ]);
  assert.equal(runtime.service.getState().stale, true);
  assert.equal(Object.keys(runtime.service.getState().mutations).length, 0);
});

test('reset invalidates late load, detail, and mutation responses without refreshing', async () => {
  const lateLoad = deferred();
  const loadRuntime = createHarness(() => lateLoad.promise);
  const loading = loadRuntime.service.load({ force: true });
  const loadSignal = loadRuntime.calls[0].options.signal;
  loadRuntime.service.reset();
  assert.equal(loadSignal.aborted, true);
  lateLoad.resolve({ success: true, data: { cacheInventory: rawInventory('late') } });
  assert.equal(await settleWithin(loading, 'reset load'), null);
  assert.deepEqual(plain(loadRuntime.service.getState()), {
    status: 'idle',
    inventory: null,
    error: null,
    stale: true,
    identity: '',
    mutations: {},
    invalidation: null
  });

  const lateEntry = deferred();
  const detailRuntime = createHarness(() => lateEntry.promise);
  const detail = detailRuntime.service.getEntry('entry-a');
  detailRuntime.service.reset();
  lateEntry.resolve({ success: true, data: { cacheEntry: rawEntry('entry-a') } });
  await assertContextChanged(detail);

  const lateMutation = deferred();
  const mutationRuntime = createHarness((action) => {
    if (action === 'getCacheInventory') {
      return Promise.resolve({ success: true, data: { cacheInventory: rawInventory('base') } });
    }
    return lateMutation.promise;
  });
  await mutationRuntime.service.load({ force: true });
  const mutation = mutationRuntime.service.deleteEntry('entry-a');
  mutationRuntime.service.reset();
  lateMutation.resolve({ success: true });
  await assertContextChanged(mutation);
  assert.deepEqual(mutationRuntime.calls.map((call) => call.action), [
    'getCacheInventory',
    'deleteCacheEntry'
  ]);
  assert.equal(Object.keys(mutationRuntime.service.getState().mutations).length, 0);
});

test('dispose invalidates every pending operation and suppresses late notifications', async () => {
  const requests = new Map([
    ['getCacheInventory', deferred()],
    ['getCacheEntry', deferred()],
    ['deleteCacheEntry', deferred()]
  ]);
  const runtime = createHarness((action) => requests.get(action).promise);
  const reasons = [];
  runtime.service.subscribe((_snapshot, reason) => reasons.push(reason));
  const loading = runtime.service.load({ force: true });
  const detail = runtime.service.getEntry('entry-a');
  const mutation = runtime.service.deleteEntry('entry-a');
  const reasonsBeforeDispose = [...reasons];

  runtime.service.dispose();
  runtime.service.dispose();
  assert.equal(runtime.service.disposed, true);
  requests.get('getCacheInventory').resolve({
    success: true,
    data: { cacheInventory: rawInventory('late') }
  });
  requests.get('getCacheEntry').resolve({
    success: true,
    data: { cacheEntry: rawEntry('entry-a') }
  });
  requests.get('deleteCacheEntry').resolve({ success: true });

  assert.equal(await settleWithin(loading, 'disposed load'), null);
  await assertDisposed(detail);
  await assertDisposed(mutation);
  assert.deepEqual(reasons, reasonsBeforeDispose);
  assert.equal(runtime.calls.filter((call) => call.action === 'getCacheInventory').length, 1);
});

test('getEntry rejects both identity drift and same-identity epoch changes before normalization', async () => {
  const identityResponse = deferred();
  let normalizeCalls = 0;
  const model = {
    ...cacheModel,
    normalizeEntry(value) {
      normalizeCalls += 1;
      return cacheModel.normalizeEntry(value);
    }
  };
  const identityRuntime = createHarness(() => identityResponse.promise, { model });
  const identityDetail = identityRuntime.service.getEntry('entry-a');
  identityRuntime.state.auth.token = 'token-b';
  identityResponse.resolve({ success: true, data: { cacheEntry: rawEntry('entry-a') } });
  await assertContextChanged(identityDetail);
  assert.equal(normalizeCalls, 0);

  const epochResponse = deferred();
  const epochRuntime = createHarness(() => epochResponse.promise, { model });
  const epochDetail = epochRuntime.service.getEntry('entry-b');
  epochRuntime.service.reset();
  epochResponse.resolve({ success: true, data: { cacheEntry: rawEntry('entry-b') } });
  await assertContextChanged(epochDetail);
  assert.equal(normalizeCalls, 0);
});

test('mutation generations prevent an old same-key request from clearing the current marker', async () => {
  const writes = [];
  let inventoryRequest = 0;
  const runtime = createHarness((action) => {
    if (action === 'getCacheInventory') {
      inventoryRequest += 1;
      return Promise.resolve({
        success: true,
        data: { cacheInventory: rawInventory('inventory-' + inventoryRequest) }
      });
    }
    if (action === 'deleteCacheEntry') {
      const request = deferred();
      writes.push(request);
      return request.promise;
    }
    throw new Error('unexpected action: ' + action);
  });

  await runtime.service.load({ force: true });
  const staleMutation = runtime.service.deleteEntry('same-key');
  assert.equal(runtime.service.getState().mutations['delete:same-key'], true);

  runtime.service.reset();
  await runtime.service.load({ force: true });
  const currentMutation = runtime.service.deleteEntry('same-key');
  assert.equal(runtime.service.getState().mutations['delete:same-key'], true);

  writes[0].resolve({ success: true });
  await assertContextChanged(staleMutation);
  assert.equal(
    runtime.service.getState().mutations['delete:same-key'],
    true,
    'the stale finally block must not clear the new generation'
  );
  assert.equal(inventoryRequest, 2, 'the stale mutation must not refresh');

  writes[1].resolve({ success: true });
  await settleWithin(currentMutation, 'current mutation generation');
  assert.equal(inventoryRequest, 3);
  assert.equal(Object.hasOwn(runtime.service.getState().mutations, 'delete:same-key'), false);
});

test('mutation-start reset or disposal prevents the write from reaching transport', async () => {
  for (const mode of ['reset', 'dispose']) {
    const runtime = createHarness(() => {
      throw new Error('write transport must not run after synchronous ' + mode);
    });
    let intercepted = false;
    runtime.service.subscribe((_snapshot, reason) => {
      if (reason !== 'mutation-start' || intercepted) return;
      intercepted = true;
      runtime.service[mode]();
    });

    const mutation = runtime.service.deleteEntry('entry-a');
    if (mode === 'dispose') await assertDisposed(mutation);
    else await assertContextChanged(mutation);
    assert.equal(intercepted, true);
    assert.equal(runtime.calls.length, 0);
    assert.equal(Object.keys(runtime.service.getState().mutations).length, 0);
  }
});

test('setActive cancels an in-flight load and late completion cannot republish it', async () => {
  const response = deferred();
  const runtime = createHarness(() => response.promise);
  const reasons = [];
  runtime.service.subscribe((_snapshot, reason) => reasons.push(reason));
  const loading = runtime.service.load({ force: true });
  const signal = runtime.calls[0].options.signal;

  runtime.service.invalidate({ reason: 'dirty-while-loading' });
  assert.equal(runtime.calls.length, 1, 'dirty refresh must remain serial');
  runtime.service.setActive(false);
  assert.equal(signal.aborted, true);
  assert.equal(runtime.service.getState().status, 'idle');
  assert.deepEqual(reasons, ['subscribe', 'load-start', 'invalidate', 'load-cancel']);

  response.resolve({ success: true, data: { cacheInventory: rawInventory('cancelled') } });
  assert.equal(await settleWithin(loading, 'cancelled dirty load'), null);
  assert.equal(runtime.service.getState().inventory, null);
  assert.equal(runtime.calls.length, 1, 'cancellation must suppress the pending tail');
  assert.deepEqual(reasons, ['subscribe', 'load-start', 'invalidate', 'load-cancel']);
});

test('reset and load-cancel listeners may synchronously start a replacement load', async () => {
  for (const transition of ['reset', 'load-cancel']) {
    const pending = [];
    const runtime = createHarness(() => {
      const request = deferred();
      pending.push(request);
      return request.promise;
    });
    let replacement;
    let reentered = false;
    runtime.service.subscribe((_snapshot, reason) => {
      if (reason !== transition || reentered) return;
      reentered = true;
      replacement = runtime.service.load();
    });

    const stale = runtime.service.load({ force: true });
    const staleSignal = runtime.calls[0].options.signal;
    if (transition === 'reset') runtime.service.reset();
    else runtime.service.setActive(false);

    assert.equal(reentered, true);
    assert.equal(staleSignal.aborted, true);
    assert.equal(runtime.calls.length, 2, transition + ' should permit a replacement GET');
    assert.notEqual(runtime.calls[1].options.signal, staleSignal);

    pending[0].resolve({ success: true, data: { cacheInventory: rawInventory('stale') } });
    assert.equal(await settleWithin(stale, transition + ' stale load'), null);
    pending[1].resolve({
      success: true,
      data: { cacheInventory: rawInventory('replacement-' + transition) }
    });
    assert.equal(
      (await settleWithin(replacement, transition + ' replacement load')).revision,
      'replacement-' + transition
    );
    assert.equal(runtime.service.getState().inventory.revision, 'replacement-' + transition);
  }
});

test('synchronous AbortController callbacks cannot start transport inside cancellation', async () => {
  const response = deferred();
  let runtime;
  let abortLoad;
  let aborted = false;
  const signal = { aborted: false };
  runtime = createHarness(() => response.promise, {
    createAbortController: () => ({
      signal,
      abort() {
        aborted = true;
        signal.aborted = true;
        abortLoad = runtime.service.load({ force: true });
      }
    })
  });
  const stale = runtime.service.load({ force: true });

  runtime.service.reset();

  assert.equal(aborted, true);
  assert.equal(await settleWithin(abortLoad, 'abort callback load'), null);
  assert.equal(runtime.calls.length, 1, 'abort callbacks must not create a nested GET');
  response.resolve({ success: true, data: { cacheInventory: rawInventory('stale') } });
  assert.equal(await settleWithin(stale, 'aborted stale load'), null);
});

test('adapter exposes exact writable facades, captures the model, and resolves the sender dynamically', async () => {
  let originalSenderCalls = 0;
  let dynamicSenderCalls = 0;
  const dispatched = [];
  const existingBobo = {
    sentinel: Object.freeze({ retained: true }),
    state: defaultState(),
    async sendToServer() {
      originalSenderCalls += 1;
      throw new Error('the startup sender must not be captured');
    }
  };
  const window = {
    AbortController,
    BOBO: existingBobo,
    dispatchEvent(event) {
      dispatched.push(event);
    }
  };
  function CustomEvent(type, options) {
    this.type = type;
    this.detail = options && options.detail;
  }
  window.CustomEvent = CustomEvent;

  vm.runInNewContext(ADAPTER_BUNDLE, { AbortController, console, CustomEvent, window }, {
    filename: 'tests/cache-store-adapter-entry.ts'
  });

  const platform = window.__cacheStorePlatform;
  const facade = window.BOBO.cacheStore;
  const factory = window.BOBO.cacheStoreFactory;
  const service = platform.services.require('workbench.cacheStore');
  assert.equal(window.BOBO, existingBobo);
  assert.deepEqual(Object.keys(facade), STORE_FACADE_KEYS);
  assert.deepEqual(Object.keys(factory), FACTORY_FACADE_KEYS);
  for (const [name, value, keys] of [
    ['cacheStore', facade, STORE_FACADE_KEYS],
    ['cacheStoreFactory', factory, FACTORY_FACADE_KEYS]
  ]) {
    for (const key of keys) {
      assert.equal(Object.getOwnPropertyDescriptor(value, key).writable, true, name + '.' + key);
    }
  }
  assert.equal('dispose' in facade, false);
  assert.equal('disposed' in facade, false);
  assert.notEqual(service, facade);
  assert.equal(service.load, facade.load);
  assert.deepEqual(plain(platform.services.describe()), [{
    id: 'workbench.cacheStore',
    owner: 'core.cacheInventory',
    exposeToPlugins: false
  }]);
  assert.throws(
    () => platform.services.getForPluginDynamic('workbench.cacheStore'),
    /not exposed to plugins/
  );

  window.BOBO.cacheModel = {
    normalizeInventory() { throw new Error('replacement model must not be used'); },
    normalizeEntry() { throw new Error('replacement model must not be used'); }
  };
  window.BOBO.sendToServer = async (action) => {
    dynamicSenderCalls += 1;
    assert.equal(action, 'getCacheInventory');
    return { success: true, data: { cacheInventory: rawInventory('dynamic-sender') } };
  };
  assert.equal((await facade.load({ force: true })).revision, 'dynamic-sender');
  assert.equal(originalSenderCalls, 0);
  assert.equal(dynamicSenderCalls, 1);

  const legacyStore = factory.createCacheStore({
    global: window,
    BOBO: window.BOBO,
    model: cacheModel
  });
  assert.deepEqual(Object.keys(legacyStore), STORE_FACADE_KEYS);
  assert.equal('dispose' in legacyStore, false);

  facade.invalidate({ reason: 'compatibility-event' });
  assert.equal(dispatched.at(-1).type, 'bobo:cache-changed');
  assert.equal(dispatched.at(-1).detail.reason, 'compatibility-event');

  await platform.dispose();
  assert.equal(service.disposed, true);
  assert.equal(platform.services.has('workbench.cacheStore'), false);
});
