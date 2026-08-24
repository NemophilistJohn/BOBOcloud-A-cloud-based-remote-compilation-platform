const assert = require('node:assert/strict');
const test = require('node:test');

const cacheModel = require('../src/cache-model.js');
const { resolveProjectDisplayName } = require('../src/projects.js');

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
});

test('project display names prefer server names then durable local mappings', () => {
  assert.equal(resolveProjectDisplayName({ key: 'folder-key', name: 'Server project' }, { 'folder-key': 'Local project' }), 'Server project');
  assert.equal(resolveProjectDisplayName({ key: 'folder-key', name: 'folder-key' }, { 'folder-key': 'Local project' }), 'Local project');
  assert.equal(resolveProjectDisplayName({ key: 'folder-key' }, {}), 'folder-key');
});
