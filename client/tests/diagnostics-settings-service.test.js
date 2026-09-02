'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { defaultDiagnosticsSettings } = require('../main/settings-store');

const ROOT = path.resolve(__dirname, '..');

function loadDiagnosticsModule() {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/diagnostics-settings.ts'],
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

const {
  DIAGNOSTICS_CHECK_CATALOG,
  createDiagnosticsSettings,
  normalizeDiagnosticsSettings
} = loadDiagnosticsModule();

const CHECK_IDS = DIAGNOSTICS_CHECK_CATALOG.map((entry) => entry.id);

function loadRendererDefaults() {
  const context = {};
  context.window = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'completion-rules.js'), 'utf8'),
    context,
    { filename: 'completion-rules.js' }
  );
  return JSON.parse(JSON.stringify(context.editorRuleRegistry.DEFAULT_DIAGNOSTICS_SETTINGS));
}

const PRODUCTION_RENDERER_DEFAULTS = loadRendererDefaults();

function rawDefaults() {
  return JSON.parse(JSON.stringify(PRODUCTION_RENDERER_DEFAULTS));
}

function normalizedDefaults() {
  return normalizeDiagnosticsSettings(undefined, rawDefaults());
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

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, listeners = new Set());
    listeners.add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(Object.assign({ type, target: this }, event));
    }
  }
}

class FakeElement extends FakeEventTarget {
  constructor(id = '', tagName = 'div') {
    super();
    this.id = id;
    this.tagName = String(tagName).toUpperCase();
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.childNodes = [];
    this.parentElement = null;
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
    this._innerHTML = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  appendChild(child) {
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this._innerHTML = String(value);
  }
}

function createFakeDocument() {
  const elements = new Map();
  for (const id of ['diag-modal', 'diag-body', 'diag-save', 'diag-close', 'diag-close-x', 'diag-reset']) {
    elements.set(id, new FakeElement(id));
  }
  elements.get('diag-modal').style.display = 'none';
  const title = new FakeElement();
  return {
    elements,
    title,
    document: {
      getElementById(id) {
        return elements.get(id) || null;
      },
      querySelector(selector) {
        return selector === '#diag-modal .ss-title' ? title : null;
      },
      querySelectorAll() {
        return [];
      },
      createElement(tagName) {
        return new FakeElement('', tagName);
      }
    }
  };
}

test('main and renderer diagnostics defaults remain one closed production contract', () => {
  assert.deepEqual(defaultDiagnosticsSettings(), PRODUCTION_RENDERER_DEFAULTS);
  assert.deepEqual(Object.keys(PRODUCTION_RENDERER_DEFAULTS.checks), CHECK_IDS);
});

function createHost(overrides = {}) {
  const openListeners = new Set();
  let openDisposals = 0;
  return {
    host: {
      readSettings: overrides.readSettings || (async () => rawDefaults()),
      writeSettings: overrides.writeSettings || (async () => true),
      onOpen(listener) {
        openListeners.add(listener);
        let active = true;
        return {
          dispose() {
            if (!active) return;
            active = false;
            openDisposals += 1;
            openListeners.delete(listener);
          }
        };
      }
    },
    get openListenerCount() {
      return openListeners.size;
    },
    get openDisposals() {
      return openDisposals;
    }
  };
}

function createHarness(options = {}) {
  const state = options.state || { diagnosticsSettings: normalizedDefaults() };
  const calls = [];
  const registry = {
    DEFAULT_DIAGNOSTICS_SETTINGS: options.defaults || rawDefaults(),
    setDiagnosticsSettings(settings) {
      calls.push({ type: 'registry', settings });
      options.onRegistry?.(settings, state, calls);
    }
  };
  const editor = {
    recheckAll() {
      calls.push({ type: 'recheck' });
      options.onRecheck?.(state, calls);
    }
  };
  const fakeDocument = createFakeDocument();
  const languageEvents = new FakeEventTarget();
  const errors = [];
  const notifications = [];
  const hostFixture = options.hostFixture || createHost();
  const service = createDiagnosticsSettings({
    host: hostFixture.host,
    document: fakeDocument.document,
    languageEvents,
    getState: () => state,
    getI18n: () => ({ t: (source) => source }),
    getRuleRegistry: () => registry,
    getEditorCore: () => editor,
    getToast: () => ({ error: (message) => notifications.push(message) }),
    logger: { error: (...args) => errors.push(args) }
  });
  return {
    service,
    state,
    calls,
    registry,
    errors,
    notifications,
    languageEvents,
    hostFixture,
    ...fakeDocument
  };
}

test('normalization closes wire enums, known checks and numeric ranges over defaults', () => {
  const normalized = normalizeDiagnosticsSettings({
    enabled: false,
    checkOn: 'idle',
    debounceMs: 9000,
    checks: {
      missingSemicolon: { enabled: false, severity: 'fatal' },
      longLines: { enabled: true, severity: 'hint', maxLineLength: 9000 },
      strayTokens: { enabled: true, severity: 'error', maxLineLength: -50 },
      inventedCheck: { enabled: false, severity: 'error' }
    }
  }, {
    enabled: true,
    checkOn: 'save',
    debounceMs: 250,
    checks: {
      missingSemicolon: { enabled: true, severity: 'error' },
      longLines: { enabled: true, severity: 'info', maxLineLength: 80 }
    }
  });

  assert.equal(normalized.enabled, false);
  assert.equal(normalized.checkOn, 'save');
  assert.equal(normalized.debounceMs, 5000);
  assert.deepEqual(Object.keys(normalized.checks), CHECK_IDS);
  assert.deepEqual(normalized.checks.missingSemicolon, { enabled: false, severity: 'error' });
  assert.deepEqual(normalized.checks.longLines, { enabled: true, severity: 'hint', maxLineLength: 1000 });
  assert.deepEqual(normalized.checks.strayTokens, { enabled: true, severity: 'error', maxLineLength: 20 });
  assert.equal(Object.hasOwn(normalized.checks, 'inventedCheck'), false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.checks), true);
  assert.equal(Object.isFrozen(normalized.checks.longLines), true);
});

test('load applies normalized settings in strict state, registry, recheck order', async () => {
  let loadedState;
  const hostFixture = createHost({
    readSettings: async () => ({
      enabled: false,
      checkOn: 'invalid-wire-value',
      debounceMs: -10,
      checks: {
        missingSemicolon: { enabled: false, severity: 'invalid-wire-value' },
        longLines: { enabled: true, severity: 'hint', maxLineLength: 2000 }
      }
    })
  });
  const harness = createHarness({
    hostFixture,
    onRegistry(settings, state) {
      assert.equal(state.diagnosticsSettings, settings);
      loadedState = settings;
    },
    onRecheck(state, calls) {
      assert.equal(state.diagnosticsSettings, loadedState);
      assert.equal(calls[0].type, 'registry');
    }
  });

  assert.equal(await harness.service.load(), true);
  assert.equal(harness.state.diagnosticsSettings.enabled, false);
  assert.equal(harness.state.diagnosticsSettings.checkOn, 'type');
  assert.equal(harness.state.diagnosticsSettings.debounceMs, 0);
  assert.equal(harness.state.diagnosticsSettings.checks.missingSemicolon.severity, 'error');
  assert.equal(harness.state.diagnosticsSettings.checks.longLines.maxLineLength, 1000);
  assert.deepEqual(harness.calls.map((call) => call.type), ['registry', 'recheck']);
});

test('persist applies only after the host confirms a successful write', async () => {
  const write = deferred();
  let written;
  const hostFixture = createHost({
    writeSettings(settings) {
      written = settings;
      return write.promise;
    }
  });
  const harness = createHarness({ hostFixture });
  const previous = harness.state.diagnosticsSettings;
  const pending = harness.service.persist({ enabled: false, checkOn: 'save', debounceMs: 7250 });

  await Promise.resolve();
  assert.equal(harness.state.diagnosticsSettings, previous);
  assert.equal(written.debounceMs, 5000);
  write.resolve(true);
  assert.equal(await pending, true);
  assert.equal(harness.state.diagnosticsSettings, written);
  assert.deepEqual(harness.calls.map((call) => call.type), ['registry', 'recheck']);
});

test('false and rejected writes do not mutate state, registry or editor diagnostics', async (t) => {
  for (const scenario of [
    { name: 'false', writeSettings: async () => false, errorCount: 0 },
    { name: 'rejection', writeSettings: async () => { throw new Error('write failed'); }, errorCount: 1 }
  ]) {
    await t.test(scenario.name, async () => {
      const hostFixture = createHost({ writeSettings: scenario.writeSettings });
      const harness = createHarness({ hostFixture });
      const previous = harness.state.diagnosticsSettings;

      assert.equal(await harness.service.persist({ enabled: false }), false);
      assert.equal(harness.state.diagnosticsSettings, previous);
      assert.deepEqual(harness.calls, []);
      assert.equal(harness.errors.length, scenario.errorCount);
    });
  }
});

test('updateBasic preserves debounce and every detailed check', async () => {
  const initial = normalizeDiagnosticsSettings({
    enabled: true,
    checkOn: 'type',
    debounceMs: 875,
    checks: Object.fromEntries(CHECK_IDS.map((id, index) => [id, {
      enabled: index % 2 === 0,
      severity: ['error', 'warning', 'info', 'hint'][index % 4],
      ...(id === 'longLines' ? { maxLineLength: 333 } : {})
    }]))
  }, rawDefaults());
  let written;
  const hostFixture = createHost({
    writeSettings: async (settings) => {
      written = settings;
      return true;
    }
  });
  const harness = createHarness({
    hostFixture,
    state: { diagnosticsSettings: initial }
  });

  assert.equal(await harness.service.updateBasic({ enabled: false, checkOn: 'save' }), true);
  assert.equal(written.enabled, false);
  assert.equal(written.checkOn, 'save');
  assert.equal(written.debounceMs, 875);
  assert.deepEqual(written.checks, initial.checks);
  assert.deepEqual(harness.state.diagnosticsSettings.checks, initial.checks);
});

test('a failed basic update keeps state unchanged and reports a localized failure', async () => {
  const hostFixture = createHost({ writeSettings: async () => false });
  const harness = createHarness({ hostFixture });
  const previous = harness.state.diagnosticsSettings;

  assert.equal(await harness.service.updateBasic({ enabled: false }), false);
  assert.equal(harness.state.diagnosticsSettings, previous);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.notifications, ['Failed to save diagnostics settings']);
});

test('a newer persist prevents an older load from applying stale settings', async () => {
  const read = deferred();
  let written;
  const hostFixture = createHost({
    readSettings: () => read.promise,
    writeSettings: async (settings) => {
      written = settings;
      return true;
    }
  });
  const harness = createHarness({ hostFixture });
  const load = harness.service.load();
  await Promise.resolve();
  const persist = harness.service.updateBasic({ enabled: false, checkOn: 'save' });

  const loaded = normalizeDiagnosticsSettings({
    enabled: true,
    checkOn: 'type',
    debounceMs: 875,
    checks: {
      missingSemicolon: { enabled: false, severity: 'hint' },
      longLines: { enabled: false, severity: 'error', maxLineLength: 444 }
    }
  }, rawDefaults());
  read.resolve(loaded);
  assert.equal(await load, false);
  assert.equal(await persist, true);
  assert.equal(written.debounceMs, 875);
  assert.deepEqual(written.checks, loaded.checks);
  assert.equal(harness.state.diagnosticsSettings.enabled, false);
  assert.equal(harness.state.diagnosticsSettings.checkOn, 'save');
  assert.deepEqual(harness.calls.map((call) => call.type), ['registry', 'recheck']);
});

test('a failed newer persist releases the successful loaded snapshot', async () => {
  const read = deferred();
  let written;
  const hostFixture = createHost({
    readSettings: () => read.promise,
    writeSettings: async (settings) => {
      written = settings;
      return false;
    }
  });
  const harness = createHarness({ hostFixture });
  const load = harness.service.load();
  await Promise.resolve();
  const persist = harness.service.updateBasic({ enabled: false, checkOn: 'save' });
  const loaded = normalizeDiagnosticsSettings({
    enabled: true,
    checkOn: 'type',
    debounceMs: 875,
    checks: {
      missingSemicolon: { enabled: false, severity: 'hint' },
      longLines: { enabled: false, severity: 'error', maxLineLength: 444 }
    }
  }, rawDefaults());

  read.resolve(loaded);
  assert.equal(await load, false);
  assert.equal(await persist, false);
  assert.equal(written.enabled, false);
  assert.equal(written.checkOn, 'save');
  assert.equal(written.debounceMs, 875);
  assert.deepEqual(written.checks, loaded.checks);
  assert.deepEqual(harness.state.diagnosticsSettings, loaded);
  assert.deepEqual(harness.calls.map((call) => call.type), ['registry', 'recheck']);
  assert.deepEqual(harness.notifications, ['Failed to save diagnostics settings']);
});

test('open waits for deferred load reconciliation before rendering', async () => {
  const read = deferred();
  const write = deferred();
  let written;
  const hostFixture = createHost({
    readSettings: () => read.promise,
    writeSettings: (settings) => {
      written = settings;
      return write.promise;
    }
  });
  const harness = createHarness({ hostFixture });
  const load = harness.service.load();
  await Promise.resolve();
  const persist = harness.service.updateBasic({ enabled: false, checkOn: 'save' });
  harness.service.open();
  assert.equal(harness.elements.get('diag-modal').style.display, 'none');

  const loaded = normalizeDiagnosticsSettings({
    enabled: true,
    checkOn: 'type',
    debounceMs: 875,
    checks: {
      missingSemicolon: { enabled: false, severity: 'hint' },
      longLines: { enabled: false, severity: 'error', maxLineLength: 444 }
    }
  }, rawDefaults());
  read.resolve(loaded);
  assert.equal(await load, false);
  assert.equal(harness.elements.get('diag-modal').style.display, 'none');
  assert.equal(written.debounceMs, 875);
  assert.deepEqual(written.checks, loaded.checks);

  write.resolve(true);
  assert.equal(await persist, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.elements.get('diag-modal').style.display, 'flex');
  assert.equal(harness.state.diagnosticsSettings.debounceMs, 875);
  assert.equal(harness.state._diagForm.debounceMs.value, '875');
  assert.equal(harness.state._diagForm.enabled.checked, false);
  assert.equal(harness.state._diagForm.checkOn.value, 'save');
});

test('a confirmed write remains applied when the next queued write fails', async () => {
  const firstWrite = deferred();
  let writeCount = 0;
  const hostFixture = createHost({
    writeSettings: async () => {
      writeCount += 1;
      if (writeCount === 1) return firstWrite.promise;
      return false;
    }
  });
  const harness = createHarness({ hostFixture });
  const first = harness.service.persist({ enabled: false, checkOn: 'save' });
  await Promise.resolve();
  const second = harness.service.persist({ enabled: true, checkOn: 'type' });
  firstWrite.resolve(true);

  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(harness.state.diagnosticsSettings.enabled, false);
  assert.equal(harness.state.diagnosticsSettings.checkOn, 'save');
  assert.deepEqual(harness.calls.map((call) => call.type), ['registry', 'recheck']);
});

test('dispose prevents queued host writes that have not started', async () => {
  const firstWrite = deferred();
  let writeCount = 0;
  const hostFixture = createHost({
    writeSettings: async () => {
      writeCount += 1;
      return firstWrite.promise;
    }
  });
  const harness = createHarness({ hostFixture });
  const first = harness.service.persist({ enabled: false });
  await Promise.resolve();
  const second = harness.service.persist({ enabled: true });
  harness.service.dispose();
  firstWrite.resolve(true);

  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(writeCount, 1);
  assert.deepEqual(harness.calls, []);
});

test('init is idempotent and dispose releases host, DOM and language listeners and ignores late load', async () => {
  const read = deferred();
  const hostFixture = createHost({ readSettings: () => read.promise });
  const harness = createHarness({ hostFixture });
  const listenerIds = ['diag-save', 'diag-close', 'diag-close-x', 'diag-reset'];

  harness.service.init();
  harness.service.init();
  assert.equal(hostFixture.openListenerCount, 1);
  assert.equal(harness.languageEvents.listenerCount('bobo:language-changed'), 1);
  for (const id of listenerIds) assert.equal(harness.elements.get(id).listenerCount('click'), 1);
  assert.equal(harness.elements.get('diag-modal').listenerCount('click'), 1);

  const load = harness.service.load();
  await Promise.resolve();
  harness.service.dispose();
  harness.service.dispose();

  assert.equal(hostFixture.openListenerCount, 0);
  assert.equal(hostFixture.openDisposals, 1);
  assert.equal(harness.languageEvents.listenerCount('bobo:language-changed'), 0);
  for (const id of listenerIds) assert.equal(harness.elements.get(id).listenerCount('click'), 0);
  assert.equal(harness.elements.get('diag-modal').listenerCount('click'), 0);
  assert.equal(harness.elements.get('diag-modal').style.display, 'none');
  assert.equal(harness.state._diagForm, null);

  const previous = harness.state.diagnosticsSettings;
  read.resolve({ ...rawDefaults(), enabled: false });
  assert.equal(await load, false);
  assert.equal(harness.state.diagnosticsSettings, previous);
  assert.deepEqual(harness.calls, []);
  assert.equal(await harness.service.persist({ enabled: false }), false);
  assert.equal(await harness.service.load(), false);
});
