'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../src/runtime.js'), 'utf8');
const RUNTIME_KEY = 'bobocloud.runtime';
const LANGUAGE_PREFERENCE_KEY = 'bobocloud.runtime.language-preferences.v1';

const runtimes = [
  { language: 'python', version: '3.10', runtimeId: 'python:3.10', displayName: 'Python 3.10' },
  { language: 'python', version: '3.13', runtimeId: 'python:3.13', displayName: 'Python 3.13' },
  { language: 'go', version: '1.21', runtimeId: 'go:1.21', displayName: 'Go 1.21' },
  { language: 'go', version: '1.23', runtimeId: 'go:1.23', displayName: 'Go 1.23' },
  { language: 'node', version: '20', runtimeId: 'node:20', displayName: 'Node.js 20' },
  { language: 'node', version: '22', runtimeId: 'node:22', displayName: 'Node.js 22' }
];

function createStorage(entries) {
  const values = new Map(Object.entries(entries || {}));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    values
  };
}

function loadRuntime(options) {
  options = options || {};
  const storage = createStorage(options.storage);
  const notifications = [];
  const events = [];
  const state = Object.assign({
    selectedRuntime: options.selectedRuntime || '',
    availableRuntimes: options.availableRuntimes || runtimes.slice(),
    groupedRuntimes: {},
    setupCommands: ['pip install example'],
    tabs: options.tabs || [],
    activeTabPath: options.activeTabPath || '',
    serverSettings: { ip: options.serverIp || '' }
  }, options.state || {});
  const document = {
    getElementById() { return null; },
    addEventListener() {},
    removeEventListener() {},
    createElement() { throw new Error('The unit fixture does not render a runtime menu'); }
  };
  const BOBO = {
    state,
    i18n: {
      t(sourceText, replacements) {
        return String(sourceText).replace(/\{([^}]+)\}/g, (match, key) => replacements && replacements[key] !== undefined ? replacements[key] : match);
      }
    },
    toast: { info(message) { notifications.push(message); } },
    updateRunOutput(message) { events.push(['output', message]); },
    lsp: { runtimeChanged() { events.push(['lsp']); } },
    runConfig: { refreshForActiveFile() { events.push(['run-config']); } },
    environmentActivity: { contextChanged(reason) { events.push(['environment', reason]); } },
    sendToServer: options.sendToServer
  };
  const window = { BOBO };
  vm.runInNewContext(source, {
    window,
    document,
    localStorage: storage,
    JSON,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Math,
    Promise,
    setTimeout,
    clearTimeout
  }, { filename: 'src/runtime.js' });
  return { BOBO: window.BOBO, state, storage, notifications, events };
}

function preferences(fixture) {
  return JSON.parse(fixture.storage.getItem(LANGUAGE_PREFERENCE_KEY) || '{}');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('automatic Docker selection follows latest versions and respects later manual choices', () => {
  const fixture = loadRuntime({ selectedRuntime: 'python:3.10' });

  fixture.BOBO.runtime.selectRuntime('python:3.10');
  assert.equal(preferences(fixture).python, 'python:3.10');

  const firstGo = fixture.BOBO.runtime.autoSelectForLanguage('go');
  assert.deepEqual(plain(firstGo), { changed: true, runtimeId: 'go:1.23', usedLatest: true });
  assert.equal(fixture.state.selectedRuntime, 'go:1.23');
  assert.equal(preferences(fixture).go, undefined, 'an automatic default must not pin a future newer runtime');
  assert.match(fixture.notifications.at(-1), /latest Go runtime.*Go 1\.23/i);

  fixture.BOBO.runtime.selectRuntime('go:1.21');
  fixture.BOBO.runtime.autoSelectForLanguage('python');
  assert.equal(fixture.state.selectedRuntime, 'python:3.10');
  const rememberedGo = fixture.BOBO.runtime.autoSelectForLanguage('go');
  assert.deepEqual(plain(rememberedGo), { changed: true, runtimeId: 'go:1.21', usedLatest: false });
  assert.equal(fixture.state.selectedRuntime, 'go:1.21');
  assert.equal(preferences(fixture).go, 'go:1.21');
});

test('Local mode is durable and prevents file activation from selecting Docker', () => {
  const fixture = loadRuntime({ selectedRuntime: 'node:22' });

  fixture.BOBO.runtime.selectRuntime('');
  const result = fixture.BOBO.runtime.autoSelectForLanguage('python');

  assert.deepEqual(plain(result), { changed: false, reason: 'local' });
  assert.equal(fixture.state.selectedRuntime, '');
  assert.equal(fixture.storage.getItem(RUNTIME_KEY), '');
  assert.equal(fixture.storage.getItem(LANGUAGE_PREFERENCE_KEY), null);
});

test('JavaScript and TypeScript files use the Node runtime family, while stale manual versions fall back to latest', () => {
  const fixture = loadRuntime({
    selectedRuntime: 'python:3.13',
    storage: { [LANGUAGE_PREFERENCE_KEY]: JSON.stringify({ go: 'go:1.20' }) }
  });

  const node = fixture.BOBO.runtime.autoSelectForLanguage('javascript');
  assert.deepEqual(plain(node), { changed: true, runtimeId: 'node:22', usedLatest: true });
  assert.equal(fixture.state.selectedRuntime, 'node:22');
  assert.equal(preferences(fixture).node, undefined);

  const typeScript = fixture.BOBO.runtime.autoSelectForLanguage('typescript');
  assert.deepEqual(plain(typeScript), { changed: false, runtimeId: 'node:22', usedLatest: true });
  assert.equal(fixture.state.selectedRuntime, 'node:22');

  const go = fixture.BOBO.runtime.autoSelectForLanguage('go');
  assert.deepEqual(plain(go), { changed: true, runtimeId: 'go:1.23', usedLatest: true });
  assert.equal(preferences(fixture).go, 'go:1.20', 'an unavailable manual preference is retained for a server that restores it');
});

test('the legacy global runtime is retained as the first preference for its own language', () => {
  const fixture = loadRuntime({ storage: { [RUNTIME_KEY]: 'python:3.10' } });
  fixture.BOBO.runtime.init();

  const result = fixture.BOBO.runtime.autoSelectForLanguage('python');

  assert.deepEqual(plain(result), { changed: false, runtimeId: 'python:3.10', usedLatest: false });
  assert.equal(preferences(fixture).python, 'python:3.10');
  assert.equal(fixture.notifications.length, 0);
});

test('a delayed runtime catalog reconciles the already-active source file', async () => {
  const fixture = loadRuntime({
    selectedRuntime: 'python:3.10',
    availableRuntimes: [],
    serverIp: 'compiler.example',
    activeTabPath: '/workspace/main.go',
    tabs: [{ path: '/workspace/main.go', language: 'go' }],
    sendToServer(action) {
      assert.equal(action, 'listRuntimes');
      return Promise.resolve({ success: true, runtimes });
    }
  });

  await fixture.BOBO.runtime.fetchRuntimes();

  assert.equal(fixture.state.selectedRuntime, 'go:1.23');
  assert.equal(preferences(fixture).go, undefined);
  assert.equal(fixture.notifications.length, 1);
});

test('runtime version comparison is numeric rather than lexical', () => {
  const fixture = loadRuntime({ availableRuntimes: [
    { language: 'python', version: '3.9', runtimeId: 'python:3.9' },
    { language: 'python', version: '3.10', runtimeId: 'python:3.10' },
    { language: 'python', version: '3.10.2', runtimeId: 'python:3.10.2' }
  ] });

  assert.equal(fixture.BOBO.runtime._helpers.latestRuntimeForLanguage('python').runtimeId, 'python:3.10.2');
});
