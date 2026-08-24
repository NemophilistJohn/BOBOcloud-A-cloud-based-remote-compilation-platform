const assert = require('node:assert/strict');
const test = require('node:test');

const cacheModel = require('../src/cache-model.js');
const { createCacheStore, extractCacheInventory } = require('../src/cache-store.js');

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
