'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'server-capabilities.js'), 'utf8');

function loadCapabilities() {
  const BOBO = { state: {} };
  vm.runInNewContext(SOURCE, { window: { BOBO }, Array, Number, Object, String }, {
    filename: 'src/server-capabilities.js'
  });
  return BOBO;
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
    catalogRevisions: { lsp: 1, dap: '1.0' }
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
