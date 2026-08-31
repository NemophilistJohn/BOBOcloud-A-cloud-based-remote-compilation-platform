'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthController } = require('../main/auth');
const { authStorageKey } = require('../main/server-identity');

function createHarness(options = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, handler)
  };
  let serverSettings = Object.assign({
    ip: 'cloud.example', user: 'root', pass: 'ssh', apiKey: '', secureTransport: true,
    httpPort: 3100, wsPort: 3101, dapChildWsPort: 3102, syncInterval: 30_000
  }, options.serverSettings || {});
  let authData = options.authData || { servers: {} };
  const disposals = [];
  const writes = [];
  const credentialChanges = [];
  const serverWriteOutcomes = Array.isArray(options.serverWriteOutcomes)
    ? options.serverWriteOutcomes.slice()
    : [];
  const settings = {
    readServerSettings: async () => Object.assign({}, serverSettings),
    writeServerSettings: async (value) => {
      const outcome = serverWriteOutcomes.length ? serverWriteOutcomes.shift() : true;
      if (outcome instanceof Error) throw outcome;
      if (outcome === false) return false;
      serverSettings = Object.assign({}, value);
      return true;
    },
    readAuth: () => authData,
    writeAuth: (value) => { authData = value; return true; }
  };
  const controller = createAuthController({
    ipcMain,
    settings,
    disposeLsp: async (reason) => { disposals.push(reason); },
    onServerSettingsWritten: async (_value, context) => { writes.push(context); },
    onCredentialChanged: async (event) => { credentialChanges.push(event.type); }
  });
  controller.registerIpc();
  return {
    handlers, disposals, writes, credentialChanges,
    get serverSettings() { return serverSettings; },
    get authData() { return authData; }
  };
}

test('auth controller migrates the current legacy host credential to a canonical endpoint key', async () => {
  const credential = { token: 'session', expiresAt: Date.now() + 60_000, user: { id: 'alice' } };
  const harness = createHarness({ authData: { servers: { 'cloud.example': credential } } });
  assert.equal(await harness.handlers.get('auth-get')({}), credential);
  assert.equal(harness.authData.servers['cloud.example'], undefined);
  assert.deepEqual(harness.authData.servers[authStorageKey(harness.serverSettings)], credential);
});

test('renderer server settings mask SSH passwords and preserve an unchanged placeholder', async () => {
  const harness = createHarness();
  const visible = await harness.handlers.get('read-server-settings')({});
  assert.equal(visible.pass, '');
  assert.equal(visible.passConfigured, true);
  await harness.handlers.get('write-server-settings')({}, Object.assign({}, visible, { syncInterval: 5000 }));
  assert.equal(harness.serverSettings.pass, 'ssh');
});

test('server settings restart remote services only when the transport identity changes', async () => {
  const harness = createHarness();
  const write = harness.handlers.get('write-server-settings');
  await write({}, Object.assign({}, harness.serverSettings, { syncInterval: 5000 }));
  assert.deepEqual(harness.disposals, []);
  assert.equal(harness.writes.at(-1).connectionChanged, false);
  await write({}, Object.assign({}, harness.serverSettings, { httpPort: 4100 }));
  assert.deepEqual(harness.disposals, ['server-settings-changed']);
  assert.equal(harness.writes.at(-1).connectionChanged, true);
});

test('server settings rollback restores hidden credentials after a failed connection change', async () => {
  const harness = createHarness();
  const write = harness.handlers.get('write-server-settings');
  await write({}, { ip: 'next.example', user: 'next', pass: 'new-secret', secureTransport: true, httpPort: 4100, wsPort: 4101, dapChildWsPort: 4102 });
  assert.equal(harness.serverSettings.pass, 'new-secret');
  await write({}, { __serverSettingsAction: 'rollback' });
  assert.equal(harness.serverSettings.ip, 'cloud.example');
  assert.equal(harness.serverSettings.pass, 'ssh');
});

for (const failure of [false, new Error('temporary settings write failure')]) {
  test('server settings rollback retains its hidden snapshot after ' + (failure === false ? 'a false write' : 'a thrown write'), async () => {
    const harness = createHarness({ serverWriteOutcomes: [true, failure, true] });
    const write = harness.handlers.get('write-server-settings');
    await write({}, { ip: 'next.example', user: 'next', pass: 'new-secret', secureTransport: true, httpPort: 4100, wsPort: 4101, dapChildWsPort: 4102 });
    if (failure === false) {
      assert.equal(await write({}, { __serverSettingsAction: 'rollback' }), false);
    } else {
      await assert.rejects(write({}, { __serverSettingsAction: 'rollback' }), /temporary settings write failure/);
    }
    assert.equal(harness.serverSettings.ip, 'next.example');
    assert.equal(await write({}, { __serverSettingsAction: 'rollback' }), true);
    assert.equal(harness.serverSettings.ip, 'cloud.example');
    assert.equal(harness.serverSettings.pass, 'ssh');
  });
}

test('credential updates are canonical, idempotent, and clear only the current server', async () => {
  const harness = createHarness({ authData: { servers: { unrelated: { token: 'keep' } } } });
  const set = harness.handlers.get('auth-set');
  const clear = harness.handlers.get('auth-clear');
  const credential = { token: 'session', expiresAt: Date.now() + 60_000, user: { id: 'alice' } };
  assert.equal(await set({}, { credential }), true);
  assert.deepEqual(harness.disposals, ['credential-changed']);
  assert.equal(await set({}, { credential }), true);
  assert.deepEqual(harness.disposals, ['credential-changed']);
  assert.equal(await clear({}), true);
  assert.deepEqual(harness.disposals, ['credential-changed', 'credential-cleared']);
  assert.deepEqual(harness.credentialChanges, ['set', 'clear']);
  assert.deepEqual(harness.authData.servers.unrelated, { token: 'keep' });
});
