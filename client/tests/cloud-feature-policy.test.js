'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const LSP_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'lsp-client.js'), 'utf8');
const TERMINAL_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'terminal.js'), 'utf8')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\.\/renderer\/terminal-input-policy\.js';\s*/, '');

function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const transformed = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
    sourcefile: relativePath
  });
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformed.code)(module, module.exports, require);
  return module.exports;
}

const { createServerCapabilities } = loadTypeScriptModule('src/server-capabilities.ts');
const { createCloudFeaturePolicy } = loadTypeScriptModule('src/cloud-feature-policy.ts');

function descriptor(capabilities) {
  return {
    schemaVersion: 1,
    protocol: { name: 'bobocloud', version: 1 },
    release: { version: '2.4.0' },
    transport: {
      http: { scheme: 'http', paths: ['/'] },
      websocket: { scheme: 'ws', paths: ['/terminal', '/lsp'] }
    },
    capabilities: Object.assign({
      run: true,
      tasks: true,
      terminal: true,
      projectEnvironment: true,
      collaboration: false,
      lsp: { enabled: true, languages: ['node', 'python'] },
      dap: { enabled: true }
    }, capabilities || {}),
    limits: {},
    catalogRevisions: { lsp: 1, dap: '1.0' },
    catalogFingerprints: { lsp: 'lsp-fingerprint', dap: 'dap-fingerprint' }
  };
}

function loadPolicy(snapshot) {
  const BOBO = { state: { serverCapabilities: snapshot === undefined ? null : snapshot } };
  installPolicy(BOBO);
  return BOBO;
}

function installCapabilities(BOBO) {
  BOBO.serverCapabilities = createServerCapabilities({
    getState: () => BOBO.state,
    getSendToServer: () => BOBO.sendToServer
  });
}

function installPolicy(BOBO) {
  BOBO.cloudFeaturePolicy = createCloudFeaturePolicy({
    getSnapshot: () => BOBO.state && BOBO.state.serverCapabilities
  });
}

test('runtime policy distinguishes unnegotiated, legacy and incompatible servers', () => {
  const BOBO = loadPolicy();
  assert.deepEqual(JSON.parse(JSON.stringify(BOBO.cloudFeaturePolicy.evaluate('run'))), {
    feature: 'run', available: false, state: 'unknown', reason: 'not_negotiated'
  });

  BOBO.state.serverCapabilities = { state: 'legacy', compatible: true };
  assert.equal(BOBO.cloudFeaturePolicy.allows('run'), true);
  assert.equal(BOBO.cloudFeaturePolicy.allows('terminal'), true);

  BOBO.state.serverCapabilities = { state: 'incompatible', compatible: false, reason: 'unsupported_schema' };
  assert.equal(BOBO.cloudFeaturePolicy.evaluate('run').available, false);
  assert.equal(BOBO.cloudFeaturePolicy.evaluate('run').reason, 'unsupported_schema');
});

test('compatible servers can disable individual features and constrain LSP languages', () => {
  const BOBO = loadPolicy();
  installCapabilities(BOBO);
  BOBO.serverCapabilities.applyServerInfo({
    success: true,
    data: { serverCapabilities: descriptor({ terminal: false }) }
  });

  assert.equal(BOBO.cloudFeaturePolicy.allows('terminal'), false);
  assert.equal(BOBO.cloudFeaturePolicy.evaluate('terminal').reason, 'feature_disabled');
  assert.equal(BOBO.cloudFeaturePolicy.allows('lsp', { language: 'typescript' }), true);
  assert.equal(BOBO.cloudFeaturePolicy.allows('lsp', { language: 'py' }), true);
  assert.equal(BOBO.cloudFeaturePolicy.allows('lsp', { language: 'go' }), false);
  assert.equal(BOBO.cloudFeaturePolicy.evaluate('lsp', { language: 'go' }).reason, 'unsupported_language');
});

test('disabled terminal activation does not sync or invoke terminal IPC', async () => {
  let starts = 0;
  let syncs = 0;
  const tab = {
    dataset: {},
    disabled: false,
    setAttribute() {},
    removeAttribute() {}
  };
  const announcement = { textContent: '' };
  const BOBO = {
    state: { serverCapabilities: {}, activePanel: 'output' },
    cloudFeaturePolicy: { evaluate: () => ({ available: false, state: 'compatible', reason: 'feature_disabled' }) },
    serverCapabilities: { subscribe: () => () => {} },
    runner: { syncWithServer: async () => { syncs += 1; return true; } },
    workspace: { saveAllTabs: async () => true },
    i18n: { t: value => value }
  };
  const window = {
    BOBO,
    api: { terminalStart: async () => { starts += 1; } },
    document: {
      querySelector: selector => selector.includes('data-panel="terminal"') ? tab : null,
      getElementById: id => id === 'terminal-announcements' ? announcement : null
    },
    addEventListener() {},
    requestAnimationFrame: callback => callback()
  };
  const context = {
    window,
    document: window.document,
    Map,
    Promise,
    Uint8Array,
    TextEncoder,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(TERMINAL_SOURCE, context, { filename: 'src/terminal.js' });

  assert.equal(await BOBO.terminal.activate(), false);
  assert.equal(starts, 0);
  assert.equal(syncs, 0);
  assert.equal(tab.disabled, true);
  assert.equal(announcement.textContent, 'Cloud terminal is unavailable on this server.');
});

test('compatible LSP handshake languages avoid legacy catalog probing', async () => {
  let requests = 0;
  const BOBO = {
    state: {
      serverCapabilities: null,
      serverSettings: { ip: '127.0.0.1' },
      collaboration: null
    },
    sendToServer: async () => {
      requests += 1;
      return { success: true, data: { languages: ['go'] } };
    }
  };
  const window = { BOBO };
  const context = { window, globalThis: window, Array, Map, Number, Object, Promise, Set, String, Uint8Array, setTimeout, clearTimeout };
  installCapabilities(BOBO);
  installPolicy(BOBO);
  vm.runInNewContext(LSP_SOURCE, context, { filename: 'src/lsp-client.js' });

  BOBO.serverCapabilities.applyServerInfo({ success: true, data: { serverCapabilities: descriptor() } });
  assert.deepEqual(Array.from(await BOBO.lsp._helpers.refreshCapabilities()), ['node', 'python']);
  assert.equal(requests, 0);

  BOBO.serverCapabilities.applyServerInfo({ success: true, data: { serverCapabilities: descriptor({ lsp: { enabled: false, languages: [] } }) } });
  assert.deepEqual(Array.from(await BOBO.lsp._helpers.refreshCapabilities()), []);
  assert.equal(requests, 0);

  BOBO.serverCapabilities.applyServerInfo({ success: true, data: {} });
  assert.deepEqual(Array.from(await BOBO.lsp._helpers.refreshCapabilities()), ['go']);
  assert.equal(requests, 1);
  assert.deepEqual(Array.from(await BOBO.lsp._helpers.refreshCapabilities()), ['go']);
  assert.equal(requests, 1);

  BOBO.state.serverSettings.ip = '127.0.0.2';
  const refreshed = await Promise.all([
    BOBO.lsp._helpers.refreshCapabilities(),
    BOBO.lsp._helpers.refreshCapabilities()
  ]);
  assert.deepEqual(refreshed.map(languages => Array.from(languages)), [['go'], ['go']]);
  assert.equal(requests, 2);

  let resolveLateLegacy;
  BOBO.state.serverSettings.ip = '127.0.0.3';
  BOBO.sendToServer = async () => {
    requests += 1;
    return new Promise(resolve => { resolveLateLegacy = resolve; });
  };
  const lateLegacy = BOBO.lsp._helpers.refreshCapabilities();
  await Promise.resolve();
  BOBO.serverCapabilities.applyServerInfo({ success: true, data: { serverCapabilities: descriptor() } });
  assert.deepEqual(Array.from(await BOBO.lsp._helpers.refreshCapabilities()), ['node', 'python']);
  resolveLateLegacy({ success: true, data: { languages: ['go'] } });
  await lateLegacy;
  assert.deepEqual(Array.from(await BOBO.lsp._helpers.refreshCapabilities()), ['node', 'python']);
  assert.equal(requests, 3);
});

test('disabled LSP preference does not open a fresh transport IPC session', async () => {
  let configureCalls = 0;
  const BOBO = {
    state: {
      serverCapabilities: null,
      serverSettings: { ip: '127.0.0.1' },
      collaboration: null,
      lsp: { settings: { mode: 'local' }, status: { state: 'local' } }
    },
    i18n: { t: value => value }
  };
  const window = {
    BOBO,
    api: {
      lspSettingsWrite: async value => value,
      lspConfigure: async () => {
        configureCalls += 1;
        return { state: 'local', mode: 'local' };
      }
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => []
    }
  };
  const context = {
    window,
    globalThis: window,
    document: window.document,
    Array,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    Uint8Array,
    setTimeout,
    clearTimeout
  };
  installCapabilities(BOBO);
  installPolicy(BOBO);
  vm.runInNewContext(LSP_SOURCE, context, { filename: 'src/lsp-client.js' });
  BOBO.serverCapabilities.applyServerInfo({
    success: true,
    data: { serverCapabilities: descriptor({ lsp: { enabled: false, languages: [] } }) }
  });

  await BOBO.lsp.setMode('standard');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(configureCalls, 0);
  assert.equal(BOBO.state.lsp.status.state, 'disabled');
});
