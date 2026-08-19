'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'server-capabilities.js'), 'utf8');

function loadCapabilities(options = {}) {
  const BOBO = { state: options.state || {} };
  if (options.sendToServer) BOBO.sendToServer = options.sendToServer;
  const events = [];
  function CustomEvent(type, options) {
    this.type = type;
    this.detail = options && options.detail;
  }
  const window = { BOBO, CustomEvent, dispatchEvent: event => events.push(event) };
  BOBO._capabilityEvents = events;
  vm.runInNewContext(SOURCE, { window, Array, Number, Object, String }, {
    filename: 'src/server-capabilities.js'
  });
  return BOBO;
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

function serverInfo(descriptor) {
  return {
    success: true,
    authMode: 'single',
    version: '2.4.0',
    data: Object.assign({ dap: { enabled: true } }, descriptor === undefined ? {} : { serverCapabilities: descriptor })
  };
}

function descriptor(overrides) {
  const base = {
    schemaVersion: 1,
    protocol: { name: 'bobocloud', version: 1 },
    release: { version: '2.4.0' },
    transport: {
      http: { scheme: 'https', paths: ['/'] },
      websocket: { scheme: 'wss', paths: ['/ws', '/terminal', '/lsp', '/dap'] }
    },
    capabilities: {
      run: true, tasks: true, terminal: true, projectEnvironment: true, collaboration: false,
      lsp: { enabled: true, languages: ['go', 'python', 'go'] }, dap: { enabled: true }
    },
    limits: {
      runMaxConcurrent: 2, terminalMaxSessionSeconds: 3600,
      lsp: { maxSessions: 8, maxPerUser: 2 }, dap: { maxSessions: 1, maxPerUser: 1 }
    },
    catalogRevisions: { lsp: 1, dap: '1.0' },
    catalogFingerprints: { lsp: 'lsp-fingerprint', dap: 'dap-fingerprint' }
  };
  return Object.assign(base, overrides || {});
}

test('a missing capability descriptor remains compatible with legacy servers', () => {
  const BOBO = loadCapabilities();
  const snapshot = BOBO.serverCapabilities.applyServerInfo(serverInfo());

  assert.equal(snapshot.state, 'legacy');
  assert.equal(BOBO.serverCapabilities.supports('terminal'), true);
  assert.equal(BOBO.serverCapabilities.requiresSecureTransport(snapshot, { secureTransport: false }), false);
  assert.equal(BOBO.state.serverCapabilities, snapshot);
});

test('a schema-v1 descriptor is normalized without exposing raw server data', () => {
  const BOBO = loadCapabilities();
  const snapshot = BOBO.serverCapabilities.inspectServerInfo(serverInfo(descriptor({
    capabilities: {
      run: true, terminal: true, lsp: { enabled: true, languages: ['go', 3, 'go'] },
      dap: { enabled: false }
    },
    transport: {
      http: { scheme: 'https', paths: ['/', 'https://not-a-path', '/'] },
      websocket: { scheme: 'wss', paths: ['/ws'] }
    },
    limits: { runMaxConcurrent: -1, lsp: { maxSessions: 2.5, maxPerUser: 1 } }
  })));

  assert.equal(snapshot.state, 'compatible');
  assert.deepEqual(Array.from(snapshot.transport.http.paths), ['/']);
  assert.deepEqual(Array.from(snapshot.capabilities.lsp.languages), ['go']);
  assert.equal(snapshot.limits.runMaxConcurrent, 0);
  assert.equal(snapshot.limits.lsp.maxSessions, 0);
  assert.equal(snapshot.limits.lsp.maxPerUser, 1);
  assert.equal(snapshot.catalogFingerprints.lsp, 'lsp-fingerprint');
  assert.equal(snapshot.catalogFingerprints.dap, 'dap-fingerprint');
  assert.equal(BOBO.serverCapabilities.supports('lsp', snapshot), true);
  assert.equal(BOBO.serverCapabilities.supports('dap', snapshot), false);
  assert.equal(BOBO.serverCapabilities.requiresSecureTransport(snapshot, { secureTransport: false }), true);
  assert.equal(BOBO.serverCapabilities.requiresSecureTransport(snapshot, { secureTransport: true }), false);
});

test('unsupported capability schemas and protocols fail closed', () => {
  const BOBO = loadCapabilities();
  const wrongSchema = BOBO.serverCapabilities.inspectServerInfo(serverInfo(descriptor({ schemaVersion: 2 })));
  const wrongProtocol = BOBO.serverCapabilities.inspectServerInfo(serverInfo(descriptor({
    protocol: { name: 'other', version: 1 }
  })));

  assert.deepEqual({ state: wrongSchema.state, reason: wrongSchema.reason }, {
    state: 'incompatible', reason: 'unsupported_schema'
  });
  assert.deepEqual({ state: wrongProtocol.state, reason: wrongProtocol.reason }, {
    state: 'incompatible', reason: 'unsupported_protocol'
  });
  assert.equal(BOBO.serverCapabilities.supports('run', wrongSchema), false);
});

test('capability snapshots publish subscribable apply, notify and clear events', () => {
  const BOBO = loadCapabilities();
  const changes = [];
  const unsubscribe = BOBO.serverCapabilities.subscribe(detail => changes.push(detail));

  const snapshot = BOBO.serverCapabilities.applyServerInfo(serverInfo(descriptor()), 'server-info');
  BOBO.serverCapabilities.notify('auth-success');
  BOBO.serverCapabilities.clear('server-change');
  unsubscribe();
  BOBO.serverCapabilities.notify('ignored');

  assert.deepEqual(changes.map(change => change.reason), ['server-info', 'auth-success', 'server-change']);
  assert.equal(changes[0].current, snapshot);
  assert.equal(changes[1].previous, snapshot);
  assert.equal(changes[2].current, null);
  assert.equal(BOBO.state.serverCapabilities, null);
  assert.equal(BOBO.serverCapabilities.supports('run'), false);
  assert.deepEqual(BOBO._capabilityEvents.map(event => event.type), [
    'bobo:server-capabilities-changed',
    'bobo:server-capabilities-changed',
    'bobo:server-capabilities-changed',
    'bobo:server-capabilities-changed'
  ]);
});

test('capability refresh is single-flight and briefly cached for one server identity', async () => {
  let calls = 0;
  const state = {
    serverSettings: { ip: 'server-a', httpPort: 3100, wsPort: 3101, secureTransport: true },
    auth: { mode: 'single', user: null },
    runIdentityEpoch: 2
  };
  const BOBO = loadCapabilities({
    state,
    sendToServer: async type => {
      calls += 1;
      assert.equal(type, 'serverInfo');
      return serverInfo(descriptor({ catalogFingerprints: { lsp: 'fresh-lsp', dap: 'fresh-dap' } }));
    }
  });
  const changes = [];
  BOBO.serverCapabilities.subscribe(change => changes.push(change));

  const first = BOBO.serverCapabilities.refresh({ reason: 'lsp-reconnect' });
  const second = BOBO.serverCapabilities.refresh({ reason: 'lsp-reconnect' });
  assert.equal(first, second);
  const result = await first;
  const cached = await BOBO.serverCapabilities.refresh({ reason: 'lsp-reconnect' });

  assert.equal(calls, 1);
  assert.equal(result.success, true);
  assert.equal(result.snapshot.catalogFingerprints.lsp, 'fresh-lsp');
  assert.equal(cached.cached, true);
  assert.equal(cached.refreshed, false);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'lsp-reconnect');
});

test('a late capability refresh cannot overwrite a newer server identity', async () => {
  const oldProbe = deferred();
  const newProbe = deferred();
  let calls = 0;
  const state = {
    serverSettings: { ip: 'server-a', httpPort: 3100, wsPort: 3101, secureTransport: true },
    auth: { mode: 'multi', user: { id: 'user-1' } },
    runIdentityEpoch: 7
  };
  const BOBO = loadCapabilities({
    state,
    sendToServer: () => {
      calls += 1;
      return calls === 1 ? oldProbe.promise : newProbe.promise;
    }
  });

  const oldResultPromise = BOBO.serverCapabilities.refresh({ reason: 'lsp-reconnect' });
  await Promise.resolve();
  state.serverSettings = Object.assign({}, state.serverSettings, { ip: 'server-b' });
  state.runIdentityEpoch += 1;
  const newResultPromise = BOBO.serverCapabilities.refresh({ reason: 'lsp-reconnect' });
  await Promise.resolve();

  newProbe.resolve(serverInfo(descriptor({ catalogFingerprints: { lsp: 'new-identity', dap: 'new-dap' } })));
  const newResult = await newResultPromise;
  oldProbe.resolve(serverInfo(descriptor({ catalogFingerprints: { lsp: 'stale-identity', dap: 'stale-dap' } })));
  const oldResult = await oldResultPromise;

  assert.equal(calls, 2);
  assert.equal(newResult.success, true);
  assert.equal(oldResult.stale, true);
  assert.equal(BOBO.state.serverCapabilities.catalogFingerprints.lsp, 'new-identity');
});
