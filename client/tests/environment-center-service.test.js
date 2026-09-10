'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_KEYS = Object.freeze([
  'disposed',
  'init',
  'refresh',
  'scheduleRefresh',
  'runAction',
  'getSnapshot',
  'getRequestContext',
  'dispose'
]);

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

const environmentCenterModule = loadTypeScriptModule('src/environment-center.ts');
const { createEnvironmentCenterService } = environmentCenterModule;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:js|ts)$/.test(entry.name) ? [target] : [];
  });
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
    this.addCalls = new Map();
    this.removeCalls = new Map();
  }

  addEventListener(type, listener) {
    this.addCalls.set(type, (this.addCalls.get(type) || 0) + 1);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.removeCalls.set(type, (this.removeCalls.get(type) || 0) + 1);
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

function createHarness(overrides = {}) {
  const events = new FakeEventTarget();
  const state = Object.assign({
    tabs: [],
    activeTabPath: '',
    availableRuntimes: [],
    selectedRuntime: '',
    workspaceRoot: '',
    workspaceIdentity: '',
    setupCommands: [],
    serverSettings: { ip: '' },
    auth: { token: '', user: null },
    collaboration: { current: null }
  }, overrides.state || {});
  const calls = {
    activitySubscribe: 0,
    activityUnsubscribe: 0,
    fileSubscribe: 0,
    fileUnsubscribe: 0,
    markerSubscribe: 0,
    markerDispose: 0,
    confirm: [],
    send: [],
    toast: []
  };
  const ports = {
    readTree: overrides.readTree || (async () => []),
    sendToServer: overrides.sendToServer || (async () => ({ success: true })),
    confirm: overrides.confirm || (async (options) => {
      calls.confirm.push(options);
      return true;
    })
  };
  const nativeHost = {
    readTree: (...args) => ports.readTree(...args),
    onFileEvent() {
      calls.fileSubscribe += 1;
      return () => { calls.fileUnsubscribe += 1; };
    }
  };
  const activity = {
    read: () => ({}),
    record: () => true,
    subscribe() {
      calls.activitySubscribe += 1;
      return () => { calls.activityUnsubscribe += 1; };
    }
  };
  const markerPort = {
    onDidChangeMarkers() {
      calls.markerSubscribe += 1;
      return { dispose() { calls.markerDispose += 1; } };
    }
  };
  const document = {
    getElementById: () => null,
    createElement: () => { throw new Error('rendering was not expected'); },
    createDocumentFragment: () => { throw new Error('rendering was not expected'); }
  };
  const service = createEnvironmentCenterService({
    document,
    events,
    state,
    getNativeHost: () => nativeHost,
    getI18n: () => ({ t: (source) => source, getActive: () => 'en' }),
    getLsp: () => null,
    getEnvironmentActivity: () => activity,
    getTaskProblemMatcher: () => null,
    getWorkspace: () => null,
    getPackageCenter: () => null,
    getWorkbench: () => ({ getState: () => ({ activity: '' }) }),
    getToast: () => ({
      success: (message) => calls.toast.push(['success', message]),
      error: (message) => calls.toast.push(['error', message])
    }),
    getConfirm: () => ports.confirm,
    projectKey: (workspaceRoot) => 'key:' + workspaceRoot,
    getMarkerPort: () => markerPort,
    sendToServer: async (action, payload, options) => {
      calls.send.push({ action, payload, options });
      return ports.sendToServer(action, payload, options);
    },
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    now: () => Date.now()
  });
  return { activity, calls, events, nativeHost, ports, service, state };
}

function cloudSnapshot(overrides = {}) {
  return Object.assign({
    schema: 'project-environment/v1',
    revision: 'env-1',
    source: 'cloud',
    checkedAt: new Date().toISOString(),
    workspace: { kind: 'personal', id: 'demo', name: 'demo' },
    language: { id: 'python', source: 'editor' },
    runtime: { id: 'python:3.11', status: 'ready' },
    manifests: [],
    packages: { declared: [], installed: [], missing: [], unknown: [] },
    dependencyCache: { scope: 'project-lock', status: 'hit' },
    consistency: { status: 'ready' },
    activity: {},
    actions: {
      refreshIndex: { supported: false },
      clearCache: { supported: true },
      repair: { supported: true, requiresConfirmation: true },
      rebuild: { supported: true, requiresConfirmation: true }
    }
  }, overrides);
}

test('environment center core is global-free and the adapter is its sole exact facade owner', () => {
  assert.deepEqual(Object.keys(environmentCenterModule).sort(), [
    'ENVIRONMENT_CENTER_SERVICE_ID',
    'canonicalLanguage',
    'createEnvironmentCenterService',
    'dependencyIssueRows',
    'healthFallbackDetail',
    'languageMatchesRuntime',
    'localizedDependencyReason',
    'localizedDynamicText',
    'mergeLiveDependencyDiagnostics',
    'mergeServerSnapshot',
    'normalizeHealth',
    'packageIdentity',
    'recognizeManifests',
    'unresolvedPythonImport'
  ]);
  const core = fs.readFileSync(path.join(ROOT, 'src/environment-center.ts'), 'utf8');
  assert.doesNotMatch(core, /\b(?:BOBO|window|globalThis|global)\b/);
  const owners = [path.join(ROOT, 'renderer'), path.join(ROOT, 'src')]
    .flatMap(sourceFiles)
    .flatMap((file) => {
      const count = (fs.readFileSync(file, 'utf8').match(/\bBOBO\.environmentCenter\s*=/g) || []).length;
      return count ? [[path.relative(ROOT, file).replace(/\\/g, '/'), count]] : [];
    });
  assert.deepEqual(owners, [['renderer/compat/environment-center-adapter.ts', 1]]);
  const adapter = fs.readFileSync(
    path.join(ROOT, 'renderer/compat/environment-center-adapter.ts'),
    'utf8'
  );
  assert.match(adapter,
    /BOBO\.environmentCenter\s*=\s*\{\s*init:\s*environmentCenter\.init,\s*refresh:\s*environmentCenter\.refresh,\s*scheduleRefresh:\s*environmentCenter\.scheduleRefresh,\s*runAction:\s*environmentCenter\.runAction,\s*getSnapshot:\s*environmentCenter\.getSnapshot,\s*getRequestContext:\s*environmentCenter\.getRequestContext,\s*dispose:\s*environmentCenter\.dispose\s*\}/);
  assert.doesNotMatch(adapter, /\bwindow\.api\b/);
});

test('environment center lifecycle owns every subscription and remains reversibly single-owner', () => {
  const harness = createHarness();
  const { calls, events, service } = harness;
  assert.equal(Object.isFrozen(service), true);
  assert.deepEqual(Object.keys(service), SERVICE_KEYS);
  assert.equal(service.disposed, false);

  service.init();
  service.init();
  for (const event of [
    'bobo:workbench-changed',
    'bobo:workspace-changed',
    'bobo:environment-changed',
    'bobo:language-changed'
  ]) assert.equal(events.listenerCount(event), 1, event);
  assert.equal(calls.activitySubscribe, 1);
  assert.equal(calls.fileSubscribe, 1);
  assert.equal(calls.markerSubscribe, 1);

  service.dispose();
  service.dispose();
  assert.equal(service.disposed, true);
  for (const event of [
    'bobo:workbench-changed',
    'bobo:workspace-changed',
    'bobo:environment-changed',
    'bobo:language-changed'
  ]) assert.equal(events.listenerCount(event), 0, event);
  assert.equal(calls.activityUnsubscribe, 1);
  assert.equal(calls.fileUnsubscribe, 1);
  assert.equal(calls.markerDispose, 1);

  service.init();
  assert.equal(service.disposed, false);
  assert.equal(calls.activitySubscribe, 2);
  assert.equal(calls.fileSubscribe, 2);
  assert.equal(calls.markerSubscribe, 2);
  assert.equal(events.listenerCount('bobo:workspace-changed'), 1);
  service.dispose();
});

test('late refresh work cannot publish into a different workspace or a disposed lifecycle', async () => {
  const firstTree = deferred();
  const harness = createHarness({
    state: { workspaceRoot: 'C:\\one', workspaceIdentity: 'one' },
    readTree: () => firstTree.promise
  });
  const firstRefresh = harness.service.refresh();
  harness.state.workspaceRoot = 'C:\\two';
  harness.state.workspaceIdentity = 'two';
  harness.ports.readTree = async () => [];
  firstTree.resolve([]);
  assert.equal(await firstRefresh, null);
  assert.equal(harness.service.getSnapshot(), null);

  const current = await harness.service.refresh();
  assert.equal(current.workspace.name, 'two');
  assert.equal(harness.service.getSnapshot(), current);

  const lateTree = deferred();
  harness.state.workspaceRoot = 'C:\\three';
  harness.state.workspaceIdentity = 'three';
  harness.ports.readTree = () => lateTree.promise;
  const lateRefresh = harness.service.refresh();
  harness.service.dispose();
  lateTree.resolve([]);
  assert.equal(await lateRefresh, null);
  assert.equal(harness.service.getSnapshot(), current);
});

test('managed repair planning cannot cross an environment identity boundary', async () => {
  const plan = deferred();
  let applyCalls = 0;
  const harness = createHarness({
    state: {
      workspaceRoot: 'C:\\demo',
      workspaceIdentity: 'demo',
      selectedRuntime: 'python:3.11',
      serverSettings: { ip: '127.0.0.1' }
    },
    sendToServer: async (action) => {
      if (action === 'getProjectEnvironment') return { success: true, data: cloudSnapshot() };
      if (action === 'planProjectEnvironmentRepair') return plan.promise;
      applyCalls += 1;
      return { success: true, data: {} };
    }
  });
  await harness.service.refresh();
  const action = harness.service.runAction('repair');
  assert.deepEqual(harness.calls.send.map((entry) => entry.action), [
    'getProjectEnvironment',
    'planProjectEnvironmentRepair'
  ]);
  harness.state.selectedRuntime = 'python:3.12';
  plan.resolve({
    success: true,
    data: {
      supported: true,
      planId: 'plan-1',
      steps: [{ kind: 'install', label: 'Install dependencies' }]
    }
  });
  await action;
  assert.equal(harness.calls.confirm.length, 0);
  assert.equal(applyCalls, 0);
  assert.deepEqual(harness.calls.toast, []);
  harness.service.dispose();
});
