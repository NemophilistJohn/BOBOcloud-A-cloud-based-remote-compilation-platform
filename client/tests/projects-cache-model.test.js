'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const { resolveProjectDisplayName } = require('../src/projects.js');

const ROOT = path.resolve(__dirname, '..');
const CACHE_MODEL_KEYS = Object.freeze([
  'SCHEMA_VERSION',
  'CATEGORY_ORDER',
  'HISTORY_STATES',
  'normalizeEntry',
  'normalizeInventory',
  'groupInventory',
  'compareEntries',
  'workspaceMatches',
  'isCurrentEnvironmentEntry',
  'isServiceCategory'
]);

function buildTypeScriptBundle(entryPoint, options = {}) {
  return esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: [entryPoint],
    bundle: true,
    platform: options.platform || 'node',
    format: options.format || 'cjs',
    write: false,
    logLevel: 'silent'
  }).outputFiles[0].text;
}

function loadCacheModel() {
  const loaded = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', buildTypeScriptBundle('src/cache-model.ts'));
  evaluate(require, loaded, loaded.exports);
  return loaded.exports;
}

const CACHE_MODEL_ADAPTER_BUNDLE = buildTypeScriptBundle('renderer/compat/cache-model-adapter.ts', {
  platform: 'browser',
  format: 'iife'
});
const cacheModel = loadCacheModel();

function loadCacheModelAdapter(existingBobo = {}) {
  const window = { BOBO: existingBobo };
  vm.runInNewContext(CACHE_MODEL_ADAPTER_BUNDLE, { window }, {
    filename: 'renderer/compat/cache-model-adapter.ts'
  });
  return { window, cacheModel: window.BOBO.cacheModel };
}

function inventory(entries, extra = {}) {
  return cacheModel.normalizeInventory(Object.assign({
    schema: 2,
    owner_kind: 'user',
    owner_id: 'root',
    quota_bytes: 1024 * 1024,
    used_bytes: 950,
    managed_bytes: 700,
    managed_files: 21,
    reclaimable_bytes: 120,
    reserved_bytes: 100,
    revision: 'revision-7',
    generated_at: '2026-08-24T12:00:00Z',
    entries
  }, extra));
}

test('cache inventory v2 normalizes snake_case without accepting legacy cache groups', () => {
  const normalized = inventory([{
    schema: 2,
    id: 'dependency-current',
    category: 'dependencies',
    state: 'current',
    workspace_id: 'owner\u0000workspace-a',
    workspace_name: 'Workspace A',
    runtime_id: 'python:3.10',
    runtime_fingerprint: 'runtime-fingerprint',
    dependency_digest: 'lock-digest',
    size_bytes: 450,
    files: 12,
    last_used_at: '2026-08-24T11:00:00Z',
    active_readers: 2,
    writing: false
  }]);

  assert.equal(normalized.schema, 2);
  assert.equal(normalized.revision, 'revision-7');
  assert.equal(normalized.usedBytes, 950, 'used bytes are the owner quota total');
  assert.equal(normalized.managedBytes, 700, 'managed bytes are cache-v2 only');
  assert.equal(normalized.managedFiles, 21);
  assert.equal(normalized.reclaimableBytes, 120);
  assert.equal(normalized.entries[0].workspaceId, 'owner\u0000workspace-a');
  assert.equal(normalized.entries[0].runtimeFingerprint, 'runtime-fingerprint');
  assert.equal(normalized.entries[0].dependencyDigest, 'lock-digest');
  assert.equal(normalized.entries[0].current, true);
  assert.equal(normalized.entries[0].history, false);
  assert.equal(normalized.entries[0].busy, true);

  assert.throws(
    () => cacheModel.normalizeInventory({ cacheGroups: [], schema: 1 }),
    (error) => error.code === 'cache_inventory_protocol_error'
  );
});

test('normalization preserves coercion, identity, and safe shallow capability copies', () => {
  let idCoercions = 0;
  let categoryCoercions = 0;
  let stateCoercions = 0;
  const lifecycle = { phase: 'published' };
  const nestedCapability = { version: 2 };
  const prototypePayload = { polluted: true };
  const inheritedCapabilities = { inheritedCapability: true };
  const capabilities = Object.create(inheritedCapabilities);
  const symbolCapability = Symbol('capability');
  Object.defineProperties(capabilities, {
    supported: { enumerable: true, value: nestedCapability },
    hidden: { enumerable: false, value: true },
    __proto__: { enumerable: true, value: prototypePayload }
  });
  capabilities[symbolCapability] = 'symbol-value';
  const raw = {
    schema: '7',
    id: { toString() { idCoercions += 1; return '  cache-id  '; } },
    category: { toString() { categoryCoercions += 1; return '  Future-Kind  '; } },
    state: { toString() { stateCoercions += 1; return '  Future-State  '; } },
    workspace_id: 42,
    workspace_name: false,
    runtime_id: 'runtime',
    language: 'TypeScript',
    size_bytes: '12.5',
    files: '4.9',
    active_readers: '3.9',
    writing: true,
    created_at: '2026-08-24T10:00:00Z',
    last_used_at: 1_725_000_000_000,
    lifecycle,
    capabilities
  };

  const normalized = cacheModel.normalizeEntry(raw);
  assert.ok(normalized);
  assert.equal(normalized.id, 'cache-id');
  assert.equal(normalized.category, 'future-kind');
  assert.equal(normalized.state, 'future-state');
  assert.equal(normalized.schema, 7);
  assert.equal(normalized.workspaceId, '42');
  assert.equal(normalized.workspaceName, 'false');
  assert.equal(normalized.language, 'typescript');
  assert.equal(normalized.sizeBytes, 12.5);
  assert.equal(normalized.files, 4);
  assert.equal(normalized.activeReaders, 3);
  assert.equal(normalized.writing, true);
  assert.equal(normalized.busy, true);
  assert.equal(normalized.createdAtMs, Date.parse(raw.created_at));
  assert.equal(normalized.lastUsedAtMs, raw.last_used_at);
  assert.equal(normalized.raw, raw);
  assert.equal(normalized.lifecycle, lifecycle);
  assert.equal(idCoercions, 1);
  assert.equal(categoryCoercions, 1);
  assert.equal(stateCoercions, 1);

  assert.notEqual(normalized.capabilities, capabilities);
  assert.equal(normalized.capabilities.supported, nestedCapability, 'capabilities stay shallow');
  assert.equal(normalized.capabilities[symbolCapability], 'symbol-value');
  assert.equal(Object.hasOwn(normalized.capabilities, 'inheritedCapability'), false);
  assert.equal(Object.hasOwn(normalized.capabilities, 'hidden'), false);
  assert.equal(Object.hasOwn(normalized.capabilities, '__proto__'), true);
  assert.equal(normalized.capabilities.__proto__, prototypePayload);
  assert.notEqual(Object.getPrototypeOf(normalized.capabilities), prototypePayload);
  assert.equal(normalized.capabilities.polluted, undefined);

  assert.equal(cacheModel.normalizeEntry(null), null);
  assert.equal(cacheModel.normalizeEntry([]), null);
  assert.equal(cacheModel.normalizeEntry({ id: 'missing-category' }), null);
  assert.equal(cacheModel.normalizeEntry({ category: 'missing-id' }), null);
});

test('inventory normalization counts each invalid entry and retains raw protocol identity', () => {
  const lifecycle = { state: 'ready' };
  const nestedCapability = { delete: true };
  const capabilities = Object.create({ inherited: true });
  Object.defineProperty(capabilities, 'operations', { enumerable: true, value: nestedCapability });
  Object.defineProperty(capabilities, '__proto__', {
    enumerable: true,
    value: { inventoryPolluted: true }
  });
  const raw = {
    schema: '2',
    owner_kind: 7,
    owner_id: false,
    quota_bytes: '1024.5',
    used_bytes: -4,
    managed_files: '8.9',
    quota_files: Number.POSITIVE_INFINITY,
    scan_truncated: true,
    generated_at: '2026-08-24T12:00:00Z',
    revision: 17,
    lifecycle,
    capabilities,
    entries: [
      null,
      [],
      {},
      { id: 'missing-category' },
      { category: 'missing-id' },
      { id: '   ', category: 'results' },
      { id: 'valid', category: 'results', state: 'ready' }
    ]
  };

  const normalized = cacheModel.normalizeInventory(raw);
  assert.equal(normalized.schema, 2);
  assert.equal(normalized.ownerKind, '7');
  assert.equal(normalized.ownerId, 'false');
  assert.equal(normalized.quotaBytes, 1024.5);
  assert.equal(normalized.usedBytes, 0);
  assert.equal(normalized.managedFiles, 8);
  assert.equal(normalized.quotaFiles, 0);
  assert.equal(normalized.scanTruncated, true);
  assert.equal(normalized.generatedAtMs, Date.parse(raw.generated_at));
  assert.equal(normalized.revision, '17');
  assert.equal(normalized.invalidEntries, 6);
  assert.deepEqual(normalized.entries.map((entry) => entry.id), ['valid']);
  assert.equal(normalized.raw, raw);
  assert.equal(normalized.lifecycle, lifecycle);
  assert.equal(normalized.capabilities.operations, nestedCapability);
  assert.equal(Object.hasOwn(normalized.capabilities, 'inherited'), false);
  assert.equal(Object.hasOwn(normalized.capabilities, '__proto__'), true);
  assert.equal(normalized.capabilities.inventoryPolluted, undefined);

  const withoutEntryArray = cacheModel.normalizeInventory({ schema: 2, entries: { id: 'ignored' } });
  assert.equal(withoutEntryArray.invalidEntries, 0);
  assert.deepEqual(withoutEntryArray.entries, []);
});

test('category and state values remain open while prototype names never become history', () => {
  const future = cacheModel.normalizeEntry({
    id: 'future',
    category: 'Future-Cache-Kind',
    state: 'Future-Lifecycle-State'
  });
  const constructorState = cacheModel.normalizeEntry({
    id: 'constructor-state',
    category: '__proto__',
    state: 'constructor'
  });
  const protoState = cacheModel.normalizeEntry({
    id: 'proto-state',
    category: 'constructor',
    state: '__proto__'
  });

  assert.ok(future && constructorState && protoState);
  assert.equal(future.category, 'future-cache-kind');
  assert.equal(future.state, 'future-lifecycle-state');
  assert.equal(future.history, false);
  assert.equal(constructorState.history, false);
  assert.equal(protoState.history, false);

  const grouped = cacheModel.groupInventory(inventory([future.raw, constructorState.raw, protoState.raw]));
  assert.equal(grouped.shared.length, 3);
  assert.equal(grouped.shared.some((category) => category.category === '__proto__'), true);
  assert.equal(grouped.shared.some((category) => category.category === 'constructor'), true);
  assert.equal(grouped.shared.some((category) => category.category === 'future-cache-kind'), true);
});

test('project caches are grouped by type with current, available and history kept distinct', () => {
  const normalized = inventory([
    {
      id: 'dep-current', category: 'dependencies', state: 'current', workspace_id: 'owner\u0000workspace-a',
      workspace_name: 'Workspace A', runtime_id: 'python:3.10', dependency_digest: 'digest-current',
      size_bytes: 300, files: 10, last_used_at: '2026-08-24T11:00:00Z'
    },
    {
      id: 'dep-ready', category: 'dependencies', state: 'ready', workspace_id: 'owner\u0000workspace-a',
      workspace_name: 'Workspace A', runtime_id: 'python:3.11', dependency_digest: 'digest-ready',
      size_bytes: 200, files: 7, last_used_at: '2026-08-24T10:00:00Z'
    },
    {
      id: 'dep-old', category: 'dependencies', state: 'superseded', workspace_id: 'owner\u0000workspace-a',
      workspace_name: 'Workspace A', runtime_id: 'python:3.10', dependency_digest: 'digest-old',
      size_bytes: 100, files: 4, last_used_at: '2026-08-23T10:00:00Z'
    },
    {
      id: 'inc-current', category: 'incremental', state: 'current', workspace_id: 'owner\u0000workspace-a',
      workspace_name: 'Workspace A', runtime_id: 'python:3.10', build_target: 'src/main.py', size_bytes: 75, files: 3
    },
    { id: 'shared-toolchain', category: 'toolchains', state: 'ready', runtime_id: 'go:1.24', size_bytes: 250, files: 5 },
    { id: 'lsp-cache', category: 'analysis-lsp', state: 'ready', runtime_id: 'python:3.10', size_bytes: 20, files: 1 },
    { id: 'dap-cache', category: 'debug-dap', state: 'ready', runtime_id: 'python:3.10', size_bytes: 5, files: 1 }
  ]);

  const grouped = cacheModel.groupInventory(normalized, {
    context: { folderKey: 'workspace-a', runtimeId: 'python:3.10' }
  });

  assert.equal(grouped.projects.length, 1);
  assert.equal(grouped.projects[0].current, true);
  assert.deepEqual(grouped.projects[0].categories.map((category) => category.category), ['dependencies', 'incremental']);
  const dependencies = grouped.projects[0].categories[0];
  assert.deepEqual(dependencies.primary.map((entry) => entry.id), ['dep-current', 'dep-ready']);
  assert.deepEqual(dependencies.history.map((entry) => entry.id), ['dep-old']);
  assert.equal(dependencies.currentCount, 1);
  assert.equal(grouped.shared[0].category, 'toolchains');
  assert.deepEqual(grouped.services.map((category) => category.category), ['analysis-lsp', 'debug-dap']);
  assert.equal(grouped.services.reduce((sum, category) => sum + category.sizeBytes, 0), 25);
  assert.equal(cacheModel.isCurrentEnvironmentEntry(dependencies.primary[0], { folderKey: 'workspace-a', runtimeId: 'python:3.10' }), true);
  assert.equal(cacheModel.isCurrentEnvironmentEntry(dependencies.primary[1], { folderKey: 'workspace-a', runtimeId: 'python:3.10' }), false);
});

test('entry, category, and project sorting preserve the complete precedence ladder', () => {
  const entries = [
    { id: 'history-newest', category: 'dependencies', state: 'retired', last_used_at: '2030-01-01T00:00:00Z', size_bytes: 999 },
    { id: 'ready-beta', category: 'dependencies', state: 'ready', last_used_at: '2026-01-01T00:00:00Z', size_bytes: 10 },
    { id: 'ready-alpha', category: 'dependencies', state: 'ready', last_used_at: '2026-01-01T00:00:00Z', size_bytes: 10 },
    { id: 'ready-large', category: 'dependencies', state: 'available', last_used_at: '2026-01-01T00:00:00Z', size_bytes: 20 },
    { id: 'ready-recent', category: 'dependencies', state: 'future-state', last_used_at: '2026-02-01T00:00:00Z', size_bytes: 1 },
    { id: 'current', category: 'dependencies', state: 'current', last_used_at: '2020-01-01T00:00:00Z' },
    { id: 'reader', category: 'dependencies', state: 'retired', active_readers: 1 },
    { id: 'writer', category: 'dependencies', state: 'retired', writing: true }
  ].map((entry) => cacheModel.normalizeEntry(entry));

  assert.equal(entries.every(Boolean), true);
  entries.sort(cacheModel.compareEntries);
  assert.deepEqual(entries.map((entry) => entry.id), [
    'writer',
    'reader',
    'current',
    'ready-recent',
    'ready-large',
    'ready-alpha',
    'ready-beta',
    'history-newest'
  ]);

  const categoryOrder = cacheModel.groupInventory(inventory([
    { id: 'zeta', category: 'zeta-cache', state: 'ready' },
    { id: 'toolchain', category: 'toolchains', state: 'ready' },
    { id: 'result', category: 'results', state: 'ready' },
    { id: 'alpha', category: 'alpha-cache', state: 'ready' },
    { id: 'dependency', category: 'dependencies', state: 'ready' },
    { id: 'incremental', category: 'incremental', state: 'ready' }
  ])).shared.map((category) => category.category);
  assert.deepEqual(categoryOrder, [
    'dependencies',
    'incremental',
    'results',
    'toolchains',
    'alpha-cache',
    'zeta-cache'
  ]);

  const projects = cacheModel.groupInventory(inventory([
    { id: 'current-workspace', category: 'results', state: 'ready', workspace_id: 'ws-current', workspace_name: 'Zulu current' },
    { id: 'busy-workspace', category: 'results', state: 'ready', workspace_id: 'ws-busy', workspace_name: 'Zulu busy', writing: true },
    { id: 'current-entry', category: 'results', state: 'current', workspace_id: 'ws-current-entry', workspace_name: 'Zulu generation' },
    { id: 'recent-workspace', category: 'results', state: 'ready', workspace_id: 'ws-recent', workspace_name: 'Zulu recent', last_used_at: '2026-02-01T00:00:00Z' },
    { id: 'large-workspace', category: 'results', state: 'ready', workspace_id: 'ws-large', workspace_name: 'Zulu large', last_used_at: '2026-01-01T00:00:00Z', size_bytes: 200 },
    { id: 'alpha-workspace', category: 'results', state: 'ready', workspace_id: 'ws-alpha', workspace_name: 'Alpha', last_used_at: '2026-01-01T00:00:00Z', size_bytes: 100 },
    { id: 'beta-workspace', category: 'results', state: 'ready', workspace_id: 'ws-beta', workspace_name: 'Beta', last_used_at: '2026-01-01T00:00:00Z', size_bytes: 100 }
  ]), {
    context: { workspaceId: 'ws-current' }
  }).projects;
  assert.deepEqual(projects.map((project) => project.workspaceId), [
    'ws-current',
    'ws-busy',
    'ws-current-entry',
    'ws-recent',
    'ws-large',
    'ws-alpha',
    'ws-beta'
  ]);
});

test('workspace matching accepts only exact and scoped suffix identities with case preserved', () => {
  const exact = { workspaceId: 'workspace-a' };
  const nulScoped = { workspaceId: 'owner\u0000workspace-a' };
  const colonScoped = { workspaceId: 'owner:workspace-a' };
  const context = { workspaceId: 'unrelated', folderKey: 'workspace-a' };

  assert.equal(cacheModel.workspaceMatches(exact, context), true);
  assert.equal(cacheModel.workspaceMatches(nulScoped, context), true);
  assert.equal(cacheModel.workspaceMatches(colonScoped, context), true);
  assert.equal(cacheModel.workspaceMatches({ workspaceId: 'ownerworkspace-a' }, context), false);
  assert.equal(cacheModel.workspaceMatches({ workspaceId: 'workspace-alpha' }, context), false);
  assert.equal(cacheModel.workspaceMatches({ workspaceId: 'owner/workspace-a' }, context), false);
  assert.equal(cacheModel.workspaceMatches({ workspaceId: 'owner:Workspace-A' }, context), false);
  assert.equal(cacheModel.workspaceMatches({ workspaceId: '' }, context), false);
  assert.equal(cacheModel.workspaceMatches(null, context), false);
});

test('grouping preserves dynamic Proxy-backed workspace context reads', () => {
  const workspaceIds = ['workspace-a', 'workspace-b'];
  let workspaceReads = 0;
  const context = new Proxy({}, {
    get(target, property, receiver) {
      if (property === 'workspaceId') {
        const value = workspaceIds[workspaceReads] || '';
        workspaceReads += 1;
        return value;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const grouped = cacheModel.groupInventory(inventory([
    { id: 'project-a', category: 'results', state: 'ready', workspace_id: 'workspace-a' },
    { id: 'project-b', category: 'results', state: 'ready', workspace_id: 'workspace-b' }
  ]), { context });
  const projectsByWorkspace = new Map(
    grouped.projects.map((project) => [project.workspaceId, project])
  );

  assert.equal(workspaceReads, 2, 'the compatibility contract reads context once for each new project');
  assert.equal(projectsByWorkspace.get('workspace-a').current, true);
  assert.equal(projectsByWorkspace.get('workspace-b').current, true);
});

test('service categories require a complete service token', () => {
  for (const category of [
    'lsp',
    'analysis-lsp',
    'cache.analysis',
    'cache_debug_data',
    'DAP-cache',
    'debug'
  ]) {
    assert.equal(cacheModel.isServiceCategory(category), true, category);
  }
  for (const category of [
    'language-server',
    'analysisservice',
    'debugger',
    'adapting',
    'prelspcache',
    'result-cache',
    ''
  ]) {
    assert.equal(cacheModel.isServiceCategory(category), false, category);
  }
});

test('project-name mappings use own properties without losing legitimate prototype-shaped keys', () => {
  const normalized = inventory([
    { id: 'plain-constructor', category: 'results', state: 'ready', workspace_id: 'constructor' },
    { id: 'plain-proto', category: 'results', state: 'ready', workspace_id: '__proto__' },
    { id: 'inherited-name', category: 'results', state: 'ready', workspace_id: 'inherited-workspace' }
  ]);
  const mappingPrototype = {
    constructor: 'Inherited constructor',
    'inherited-workspace': 'Inherited project'
  };
  Object.defineProperty(mappingPrototype, '__proto__', {
    enumerable: true,
    value: 'Inherited proto'
  });
  const inheritedMappings = Object.create(mappingPrototype);
  const withoutInheritedNames = cacheModel.groupInventory(normalized, {
    projectNames: inheritedMappings
  });
  const inheritedNamesByWorkspace = new Map(
    withoutInheritedNames.projects.map((project) => [project.workspaceId, project.name])
  );
  assert.equal(inheritedNamesByWorkspace.get('__proto__'), '');
  assert.equal(inheritedNamesByWorkspace.get('constructor'), '');
  assert.equal(inheritedNamesByWorkspace.get('inherited-workspace'), '');

  const ownMappings = Object.create(null);
  ownMappings.constructor = 'Own constructor';
  ownMappings.__proto__ = 'Own proto';
  ownMappings['inherited-workspace'] = 'Own project';
  const withOwnNames = cacheModel.groupInventory(normalized, { projectNames: ownMappings });
  const ownNamesByWorkspace = new Map(
    withOwnNames.projects.map((project) => [project.workspaceId, project.name])
  );
  assert.equal(ownNamesByWorkspace.get('__proto__'), 'Own proto');
  assert.equal(ownNamesByWorkspace.get('constructor'), 'Own constructor');
  assert.equal(ownNamesByWorkspace.get('inherited-workspace'), 'Own project');
});

test('filters preserve type-first grouping and never fold services into shared cache', () => {
  const normalized = inventory([
    { id: 'project-result', category: 'results', state: 'ready', workspace_id: 'workspace-a', workspace_name: 'A' },
    { id: 'shared-result', category: 'results', state: 'ready' },
    { id: 'lsp-result', category: 'analysis-lsp', state: 'ready' }
  ]);

  const shared = cacheModel.groupInventory(normalized, { filters: { scope: 'shared', category: 'results' } });
  assert.equal(shared.projects.length, 0);
  assert.equal(shared.shared.length, 1);
  assert.equal(shared.shared[0].entries[0].id, 'shared-result');
  assert.equal(shared.services.length, 0);

  const services = cacheModel.groupInventory(normalized, { filters: { scope: 'services' } });
  assert.equal(services.projects.length, 0);
  assert.equal(services.shared.length, 0);
  assert.equal(services.services[0].entries[0].id, 'lsp-result');

  const unknownScope = cacheModel.groupInventory(normalized, {
    filters: { scope: 'future-server-scope' }
  });
  assert.equal(unknownScope.projects.length, 1);
  assert.equal(unknownScope.shared.length, 1);
  assert.equal(unknownScope.services.length, 1);
  assert.equal(unknownScope.totals.entries, 3);
});

test('compatibility adapter projects the exact writable API with isolated category order', () => {
  const sentinel = Object.freeze({ retained: true });
  const existingBobo = { sentinel, cacheModel: { legacy: true } };
  const { window, cacheModel: facade } = loadCacheModelAdapter(existingBobo);

  assert.equal(window.BOBO, existingBobo);
  assert.equal(window.BOBO.sentinel, sentinel);
  assert.deepEqual(Object.keys(facade), CACHE_MODEL_KEYS);
  for (const key of CACHE_MODEL_KEYS) {
    assert.equal(Object.getOwnPropertyDescriptor(facade, key).writable, true, key);
  }
  assert.equal(facade.SCHEMA_VERSION, 2);
  assert.equal(Object.isFrozen(facade.HISTORY_STATES), true);
  assert.deepEqual(Array.from(facade.CATEGORY_ORDER), [
    'dependencies',
    'incremental',
    'results',
    'toolchains'
  ]);

  facade.CATEGORY_ORDER.reverse();
  facade.CATEGORY_ORDER.push('custom-first');
  const grouped = facade.groupInventory(facade.normalizeInventory({
    schema: 2,
    entries: [
      { id: 'custom', category: 'custom-first' },
      { id: 'dependency', category: 'dependencies' },
      { id: 'result', category: 'results' }
    ]
  }));
  assert.deepEqual(
    Array.from(grouped.shared, (category) => category.category),
    ['dependencies', 'results', 'custom-first'],
    'mutating the legacy display-order copy must not change core grouping order'
  );
  assert.deepEqual(Array.from(facade.CATEGORY_ORDER), [
    'toolchains',
    'results',
    'incremental',
    'dependencies',
    'custom-first'
  ]);
});

test('project display names prefer server names then durable local mappings', () => {
  assert.equal(resolveProjectDisplayName({ key: 'folder-key', name: 'Server project' }, { 'folder-key': 'Local project' }), 'Server project');
  assert.equal(resolveProjectDisplayName({ key: 'folder-key', name: 'folder-key' }, { 'folder-key': 'Local project' }), 'Local project');
  assert.equal(resolveProjectDisplayName({ key: 'folder-key' }, {}), 'folder-key');
});
