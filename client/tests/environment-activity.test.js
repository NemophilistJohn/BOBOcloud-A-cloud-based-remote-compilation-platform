'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { directBridgeAccessCount } = require('./support/renderer-bridge-access');

const ROOT = path.resolve(__dirname, '..');
const FACADE_KEYS = Object.freeze([
  'read',
  'record',
  'contextChanged',
  'subscribe',
  'getScope',
  'getScopeKey',
  '_storageKey'
]);

function loadCore() {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/environment-activity.ts'],
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

const environmentActivity = loadCore();
const ADAPTER_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  stdin: {
    contents: [
      "import { rendererPlatform } from './renderer/core/bootstrap.ts';",
      "import './renderer/compat/environment-activity-adapter.ts';",
      'window.__environmentActivityPlatform = rendererPlatform;'
    ].join('\n'),
    loader: 'ts',
    resolveDir: ROOT,
    sourcefile: 'tests/environment-activity-adapter-entry.ts'
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

function createStorage(initialValue) {
  let serialized = initialValue === undefined
    ? null
    : typeof initialValue === 'string'
      ? initialValue
      : JSON.stringify(initialValue);
  const writes = [];
  return {
    storage: {
      getItem(key) {
        assert.equal(key, environmentActivity.ENVIRONMENT_ACTIVITY_STORAGE_KEY);
        return serialized;
      },
      setItem(key, value) {
        assert.equal(key, environmentActivity.ENVIRONMENT_ACTIVITY_STORAGE_KEY);
        serialized = String(value);
        writes.push(serialized);
      }
    },
    writes,
    value() {
      return serialized === null ? null : JSON.parse(serialized);
    }
  };
}

function defaultState(overrides = {}) {
  return {
    tabs: [{ path: '/work/main.ts', language: 'typescript' }],
    activeTabPath: '/work/main.ts',
    workspaceRoot: 'C:\\work\\demo',
    selectedRuntime: 'node:22',
    serverSettings: { ip: '127.0.0.1' },
    auth: { user: { id: 'user-7' } },
    ...overrides
  };
}

function createHarness(options = {}) {
  const events = [];
  const subscriberErrors = [];
  const storageHarness = options.storageHarness || createStorage(options.initialRecords);
  const nowValues = Array.isArray(options.now) ? [...options.now] : [options.now || 1_000];
  let nowIndex = 0;
  const service = environmentActivity.createEnvironmentActivityService({
    state: options.state || defaultState(),
    storage: options.storage === null ? null : storageHarness.storage,
    projectKey: options.projectKey || ((root) => 'project:' + root),
    now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)],
    dispatchEvent(event) {
      events.push(event);
      if (options.trace) options.trace.push('dispatch:' + event.kind);
    },
    reportSubscriberError(error) {
      subscriberErrors.push(error);
    }
  });
  return { events, service, storageHarness, subscriberErrors };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('typed core stays side-effect free and the compatibility adapter is the only projection', () => {
  const coreFile = 'src/environment-activity.ts';
  const adapterFile = 'renderer/compat/environment-activity-adapter.ts';
  const coreSource = fs.readFileSync(path.join(ROOT, coreFile), 'utf8');
  const adapterSource = fs.readFileSync(path.join(ROOT, adapterFile), 'utf8');

  assert.doesNotMatch(coreSource, /\b(?:window|globalThis|BOBO|module\.exports|require\s*\()/);
  assert.equal(directBridgeAccessCount(coreFile, coreSource), 0);
  assert.equal(directBridgeAccessCount(adapterFile, adapterSource), 0);
  assert.equal((adapterSource.match(/BOBO\.environmentActivity\s*=/g) || []).length, 1);
  assert.doesNotMatch(adapterSource, /\bcreateRendererPlatform\s*\(|\bnew\s+ServiceRegistry\s*\(/);
});

test('stringHash preserves the established FNV-1a golden values and falsy coercion', () => {
  assert.equal(environmentActivity.stringHash(''), 'ztntfp');
  assert.equal(environmentActivity.stringHash('hello'), 'm3bicr');
  assert.equal(environmentActivity.stringHash('127.0.0.1'), '2eauxq');
  for (const value of [undefined, null, false, 0, Number.NaN]) {
    assert.equal(environmentActivity.stringHash(value), 'ztntfp', String(value));
  }
  assert.equal(
    environmentActivity.stringHash({ toString: () => 'custom' }),
    '8z1h7y'
  );
});

test('scope descriptors preserve personal, team, editor, identity, and override precedence', () => {
  const projectRoots = [];
  const personal = createHarness({
    state: defaultState({
      tabs: [{ path: '/work/image.png', language: 'image' }],
      activeTabPath: '/work/image.png',
      editor: { getModel: () => ({ getLanguageId: () => 'python' }) },
      auth: { user: { uid: 'uid-first', id: 'id-second' } }
    }),
    projectKey(root) {
      projectRoots.push(root);
      return 'folder-42';
    }
  });

  assert.deepEqual(personal.service.getScope(), {
    server: environmentActivity.stringHash('127.0.0.1'),
    user: environmentActivity.stringHash('uid-first'),
    workspace: { kind: 'personal', folderKey: 'folder-42' },
    runtime: 'node:22',
    language: 'python'
  });
  assert.deepEqual(projectRoots, ['C:\\work\\demo']);

  assert.deepEqual(personal.service.getScope({
    workspaceRoot: null,
    language: 'rust',
    runtime: null
  }), {
    server: environmentActivity.stringHash('127.0.0.1'),
    user: environmentActivity.stringHash('uid-first'),
    workspace: { kind: 'personal', folderKey: '' },
    runtime: 'local',
    language: 'rust'
  });

  let personalResolverCalls = 0;
  const team = createHarness({
    state: defaultState({
      collaboration: {
        current: { teamId: 9, projectId: 'project-a', branch: 'feature' }
      },
      auth: { mode: 'single', user: null }
    }),
    projectKey() {
      personalResolverCalls += 1;
      return 'unused';
    }
  });
  const teamScope = team.service.getScope({ workspaceRoot: 'ignored' });
  assert.deepEqual(teamScope.workspace, {
    kind: 'team',
    teamId: '9',
    projectId: 'project-a',
    branch: 'feature'
  });
  assert.equal(teamScope.user, environmentActivity.stringHash('single'));
  assert.equal(personalResolverCalls, 0);
  assert.match(team.service.getScopeKey(), /^e1-[a-z0-9]+$/);
  assert.notEqual(team.service.getScopeKey({ runtime: 'python:3.12' }), team.service.getScopeKey());
});

test('stored records are normalized, copied, and updated without leaking caller mutation', () => {
  const state = defaultState();
  const probe = createHarness({ state, storage: null });
  const scopeKey = probe.service.getScopeKey();
  probe.service.dispose();
  const storageHarness = createStorage({
    [scopeKey]: {
      lastIndexedAt: '40',
      lastCompiledAt: 'not-a-number',
      lastAction: 7,
      lastOutcome: null,
      updatedAt: '40'
    }
  });
  const { events, service } = createHarness({ state, storageHarness });

  const first = service.read();
  assert.deepEqual(first, {
    lastIndexedAt: 40,
    lastInstalledAt: 0,
    lastCompiledAt: 0,
    lastRepairAt: 0,
    lastRebuildAt: 0,
    lastAction: '7',
    lastOutcome: '',
    updatedAt: 40
  });
  first.lastIndexedAt = 999;
  assert.equal(service.read().lastIndexedAt, 40);

  assert.equal(service.record('compile', { at: 75, outcome: 'failed', source: 'runner' }), true);
  assert.deepEqual(service.read(), {
    lastIndexedAt: 40,
    lastInstalledAt: 0,
    lastCompiledAt: 75,
    lastRepairAt: 0,
    lastRebuildAt: 0,
    lastAction: 'compile',
    lastOutcome: 'failed',
    updatedAt: 75
  });
  assert.equal(storageHarness.writes.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.source, 'runner');
  events[0].record.lastCompiledAt = 1;
  assert.equal(service.read().lastCompiledAt, 75);
});

test('backdated actions cannot regress the latest scope state or eviction freshness', () => {
  const { events, service } = createHarness();

  assert.equal(service.record('compile', { at: 100, outcome: 'completed' }), true);
  assert.equal(service.record('index', { at: 10, outcome: 'failed' }), true);

  assert.deepEqual(service.read(), {
    lastIndexedAt: 10,
    lastInstalledAt: 0,
    lastCompiledAt: 100,
    lastRepairAt: 0,
    lastRebuildAt: 0,
    lastAction: 'compile',
    lastOutcome: 'completed',
    updatedAt: 100
  });
  assert.equal(events.at(-1).kind, 'index');
  assert.equal(events.at(-1).record.updatedAt, 100);
  assert.equal(events.at(-1).record.lastAction, 'compile');
});

test('persist keeps the 80 newest scopes after recording a new environment', () => {
  const initialRecords = {};
  for (let index = 0; index < 80; index += 1) {
    initialRecords['old-' + index] = { updatedAt: index + 1 };
  }
  const { service, storageHarness } = createHarness({ initialRecords });
  const newScopeKey = service.getScopeKey();

  assert.equal(service.record('index', { at: 1_000 }), true);
  const persisted = storageHarness.value();
  assert.equal(Object.keys(persisted).length, 80);
  assert.equal(Object.hasOwn(persisted, 'old-0'), false);
  assert.equal(Object.hasOwn(persisted, 'old-79'), true);
  assert.equal(Object.hasOwn(persisted, newScopeKey), true);
});

test('subscribers keep registration order, isolate failures, and unsubscribe duplicate callbacks independently', () => {
  const trace = [];
  const marker = new Error('listener failed');
  const { service, subscriberErrors } = createHarness({ trace });
  const duplicate = (event) => trace.push('duplicate:' + event.kind);
  const removeFirst = service.subscribe(duplicate);
  service.subscribe((event) => {
    trace.push('throw:' + event.kind);
    throw marker;
  });
  service.subscribe((event) => trace.push('healthy:' + event.kind));
  const removeSecond = service.subscribe(duplicate);

  service.record('install', { at: 10 });
  assert.deepEqual(trace, [
    'duplicate:install',
    'throw:install',
    'healthy:install',
    'duplicate:install',
    'dispatch:install'
  ]);
  assert.deepEqual(subscriberErrors, [marker]);

  trace.length = 0;
  removeFirst();
  removeFirst();
  service.record('repair', { at: 20 });
  assert.deepEqual(trace, [
    'throw:repair',
    'healthy:repair',
    'duplicate:repair',
    'dispatch:repair'
  ]);

  trace.length = 0;
  removeSecond();
  service.record('rebuild', { at: 30 });
  assert.deepEqual(trace, ['throw:rebuild', 'healthy:rebuild', 'dispatch:rebuild']);
});

test('record resolves one scope key for storage and notification even when project identity is dynamic', () => {
  let projectKeyCalls = 0;
  const { events, service, storageHarness } = createHarness({
    projectKey() {
      projectKeyCalls += 1;
      return projectKeyCalls === 1 ? 'first-scope' : 'later-scope';
    }
  });

  assert.equal(service.record('compile', { at: 55 }), true);
  assert.equal(projectKeyCalls, 1);
  const persistedKeys = Object.keys(storageHarness.value());
  assert.deepEqual(persistedKeys, [events[0].scopeKey]);

  events.length = 0;
  projectKeyCalls = 0;
  service.contextChanged('workspace');
  assert.equal(projectKeyCalls, 1);
  assert.equal(events[0].scopeKey, persistedKeys[0]);
  assert.equal(events[0].record.lastCompiledAt, 55);
});

test('prototype-shaped actions are rejected and disposal is idempotent', () => {
  const { events, service, storageHarness } = createHarness();
  for (const kind of ['__proto__', 'constructor', 'toString']) {
    assert.equal(service.record(kind, { at: 10 }), false, kind);
  }
  assert.equal(storageHarness.writes.length, 0);
  assert.equal(events.length, 0);

  let listenerCalls = 0;
  service.subscribe(() => { listenerCalls += 1; });
  service.dispose();
  service.dispose();
  assert.equal(service.disposed, true);
  assert.equal(service.record('index', { at: 20 }), false);
  service.contextChanged('disposed');
  const remove = service.subscribe(() => { listenerCalls += 1; });
  remove();
  assert.equal(listenerCalls, 0);
  assert.equal(storageHarness.writes.length, 0);
  assert.equal(events.length, 0);
});

test('adapter exposes the exact writable facade while registry owns the private disposable service', async () => {
  const dispatched = [];
  const originalState = defaultState();
  const existingBobo = {
    sentinel: Object.freeze({ retained: true }),
    state: originalState,
    projectKey: (root) => 'first:' + root,
    environmentActivity: { legacy: true }
  };
  const window = {
    BOBO: existingBobo,
    localStorage: createStorage().storage,
    dispatchEvent(event) {
      dispatched.push(event);
    }
  };
  function CustomEvent(type, options) {
    this.type = type;
    this.detail = options && options.detail;
  }

  vm.runInNewContext(ADAPTER_BUNDLE, { console, CustomEvent, window }, {
    filename: 'tests/environment-activity-adapter-entry.ts'
  });

  const platform = window.__environmentActivityPlatform;
  const facade = window.BOBO.environmentActivity;
  const service = platform.services.require('workbench.environmentActivity');
  assert.equal(window.BOBO, existingBobo);
  assert.deepEqual(Object.keys(facade), FACADE_KEYS);
  for (const key of FACADE_KEYS) {
    assert.equal(Object.getOwnPropertyDescriptor(facade, key).writable, true, key);
  }
  assert.equal(facade._storageKey, 'bobocloud.environment.activity.v1');
  assert.equal('dispose' in facade, false);
  assert.equal('_storageKey' in service, false);
  assert.notEqual(service, facade);
  assert.equal(service.record, facade.record);
  assert.deepEqual(plain(platform.services.describe()), [{
    id: 'workbench.environmentActivity',
    owner: 'core.environment-activity',
    exposeToPlugins: false
  }]);
  assert.throws(
    () => platform.services.getForPluginDynamic('workbench.environmentActivity'),
    /not exposed to plugins/
  );

  window.BOBO.state = defaultState({ workspaceRoot: 'C:\\replacement' });
  window.BOBO.projectKey = (root) => 'second:' + root;
  assert.equal(
    facade.getScope().workspace.folderKey,
    'second:C:\\work\\demo',
    'the adapter captures state but resolves the current projectKey function'
  );
  facade.record('index', { at: 90 });
  assert.equal(dispatched[0].type, 'bobo:environment-activity');
  assert.equal(dispatched[0].detail.kind, 'index');

  await platform.dispose();
  assert.equal(service.disposed, true);
  assert.equal(platform.services.has('workbench.environmentActivity'), false);
  assert.equal(facade.record('compile', { at: 100 }), false);
});
