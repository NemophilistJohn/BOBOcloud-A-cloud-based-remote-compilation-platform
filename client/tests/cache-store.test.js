'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadCacheModel() {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/cache-model.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const loaded = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', build.outputFiles[0].text);
  evaluate(require, loaded, loaded.exports);
  return loaded.exports;
}

const cacheModel = loadCacheModel();
const CACHE_STORE_MODULE_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/cache-store.js'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;
const CACHE_STARTUP_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  stdin: {
    contents: [
      "import './renderer/compat/cache-model-adapter.ts';",
      "import './src/cache-store.js';"
    ].join('\n'),
    loader: 'ts',
    resolveDir: ROOT,
    sourcefile: 'tests/cache-model-store-startup.ts'
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

function loadCacheStoreModule(window = { BOBO: {} }) {
  const loaded = { exports: {} };
  const evaluate = new Function('window', 'require', 'module', 'exports', CACHE_STORE_MODULE_BUNDLE);
  evaluate(window, require, loaded, loaded.exports);
  return loaded.exports;
}

const { createCacheStore, extractCacheInventory } = loadCacheStoreModule();

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

function harness(handler) {
  const calls = [];
  const BOBO = {
    cacheModel,
    state: {
      serverSettings: { ip: '127.0.0.1' },
      auth: { token: 'token', user: { id: 'root' } }
    },
    async sendToServer(action, payload, options) {
      calls.push({ action, payload, options });
      return handler(action, payload, calls.length);
    }
  };
  const root = { BOBO, AbortController, CustomEvent: class {}, dispatchEvent() {} };
  return { calls, store: createCacheStore({ global: root, BOBO, model: cacheModel }) };
}

test('renderer startup adapter initializes the default cache store with the typed facade', async () => {
  const calls = [];
  const window = {
    AbortController,
    BOBO: {
      state: {
        serverSettings: { ip: '127.0.0.1' },
        auth: { token: 'token', user: { id: 'root' } }
      },
      async sendToServer(action, payload, options) {
        calls.push({ action, payload, options });
        return { success: true, data: { cacheInventory: rawInventory('startup-revision') } };
      }
    }
  };
  vm.runInNewContext(CACHE_STARTUP_BUNDLE, { window }, {
    filename: 'tests/cache-model-store-startup.ts'
  });

  const loaded = await window.BOBO.cacheStore.load({ force: true });
  assert.equal(loaded.revision, 'startup-revision');
  assert.equal(window.BOBO.cacheStore.getState().inventory, loaded);
  assert.equal(typeof window.BOBO.cacheStoreFactory.createCacheStore, 'function');
  assert.deepEqual(calls.map((call) => call.action), ['getCacheInventory']);
});

test('cache store reads Data.cacheInventory and rejects old cacheGroups responses', async () => {
  assert.equal(extractCacheInventory({ Data: { cacheInventory: rawInventory('r1') } }).revision, 'r1');
  assert.equal(extractCacheInventory({ cacheInventory: rawInventory('r2') }).revision, 'r2');

  const valid = harness(async () => ({ success: true, data: { cacheInventory: rawInventory('r3') } }));
  const loaded = await valid.store.load({ force: true });
  assert.equal(loaded.schema, 2);
  assert.equal(loaded.revision, 'r3');
  assert.equal(valid.calls[0].action, 'getCacheInventory');

  const legacy = harness(async () => ({ success: true, cacheGroups: [] }));
  await assert.rejects(() => legacy.store.load({ force: true }), (error) => error.code === 'cache_inventory_protocol_error');
});

test('delete sends an opaque cache id with expected revision and refreshes after success', async () => {
  let inventoryRevision = 'r7';
  const runtime = harness(async (action) => {
    if (action === 'getCacheInventory') return { success: true, data: { cacheInventory: rawInventory(inventoryRevision) } };
    if (action === 'deleteCacheEntry') {
      inventoryRevision = 'r8';
      return { success: true, data: { revision: 'r8' } };
    }
    throw new Error('unexpected action: ' + action);
  });

  await runtime.store.load({ force: true });
  await runtime.store.deleteEntry('cache-entry-opaque');

  assert.deepEqual(runtime.calls.map((call) => call.action), ['getCacheInventory', 'deleteCacheEntry', 'getCacheInventory']);
  assert.deepEqual(runtime.calls[1].payload, { cacheId: 'cache-entry-opaque', expectedRevision: 'r7' });
  assert.equal(runtime.store.getState().inventory.revision, 'r8');
  assert.equal(Object.keys(runtime.store.getState().mutations).length, 0);
});

test('scope clear uses camelCase workspace and revision fields', async () => {
  let inventoryRevision = 'revision-before';
  const runtime = harness(async (action) => {
    if (action === 'getCacheInventory') return { success: true, data: { cacheInventory: rawInventory(inventoryRevision) } };
    if (action === 'clearCacheScope') {
      inventoryRevision = 'revision-after';
      return { success: true };
    }
    throw new Error('unexpected action: ' + action);
  });

  await runtime.store.load({ force: true });
  await runtime.store.clearScope({ scope: 'workspace', workspaceId: 'workspace-id', category: 'dependencies' });

  assert.deepEqual(runtime.calls[1].payload, {
    scope: 'workspace',
    expectedRevision: 'revision-before',
    workspaceId: 'workspace-id',
    category: 'dependencies'
  });
  assert.equal(runtime.store.getState().inventory.revision, 'revision-after');
});
