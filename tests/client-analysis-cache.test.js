const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ClientAnalysisCache,
  DEFAULT_POLICIES,
  MIN_CACHE_SIZE_MIB,
  MAX_CACHE_SIZE_MIB,
  normalizeCacheMode,
  normalizeCacheSizeMiB,
  normalizeScope,
  normalizeCacheKey,
  sanitizeCompletionItems,
  sanitizeDependencyIndex,
  DEPENDENCY_INDEX_SCHEMA,
  MIN_DEPENDENCY_INDEX_SIZE_MIB
} = require('../client-analysis-cache');

function makeTempCache(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-client-analysis-cache-'));
  const cache = new ClientAnalysisCache(Object.assign({ baseDir: root }, options || {}));
  return { root, cache };
}

function personalScope(overrides) {
  return Object.assign({
    serverId: 'cloud.example.test:3100',
    userId: 'u-100',
    workspace: { kind: 'personal', folderKey: 'pabc123' },
    languageId: 'python',
    runtimeId: 'python:3.11',
    dependencyRevision: 'requirements-abc'
  }, overrides || {});
}

function teamScope(overrides) {
  return Object.assign({
    serverId: 'cloud.example.test:3100',
    userId: 'u-100',
    workspace: { kind: 'team', teamId: 'team-1', projectId: 'project-1', branch: 'feature/cache-fast-path' },
    languageId: 'rust',
    runtimeId: 'rust:1.87',
    dependencyRevision: 'cargo-lock-abc'
  }, overrides || {});
}

function candidate(label) {
  return {
    isIncomplete: false,
    items: [{
      label: label,
      kind: 3,
      insertText: label + '()',
      detail: 'cached candidate',
      filterText: label,
      sortText: label,
      preselect: true,
      documentation: { value: 'must not persist' },
      textEdit: { newText: 'must not persist' },
      additionalTextEdits: [{ newText: 'must not persist' }],
      data: { secret: 'must not persist' },
      command: { command: 'must-not-run' }
    }]
  };
}

function safeCandidate(label) {
  const value = candidate(label);
  delete value.items[0].textEdit;
  delete value.items[0].additionalTextEdits;
  delete value.items[0].data;
  delete value.items[0].command;
  return value;
}

function largeSafeCandidate(label) {
  return {
    isIncomplete: false,
    items: Array.from({ length: 20 }, function(_, index) {
      const suffix = String(index).padStart(2, '0');
      return {
        label: label + '-' + suffix,
        kind: 3,
        insertText: label + '-' + suffix + '-' + 'x'.repeat(850),
        detail: 'large cache policy probe',
        filterText: label + '-' + suffix,
        sortText: label + '-' + suffix
      };
    })
  };
}

function mediumSafeCandidate(label) {
  return {
    isIncomplete: false,
    items: Array.from({ length: 2 }, function(_, index) {
      return {
        label: label + index,
        kind: 3,
        insertText: label + '-' + 'x'.repeat(700),
        detail: 'quota pressure candidate',
        filterText: label + index,
        sortText: label + index
      };
    })
  };
}

function dependencyIndex(rootName) {
  return {
    schema: DEPENDENCY_INDEX_SCHEMA,
    roots: [{
      name: rootName || 'numpy',
      kind: 'module',
      detail: 'numeric arrays',
      members: [
        { name: 'array', kind: 'function', detail: 'array(object)' },
        { name: 'ndarray', kind: 'class', detail: 'ndarray' }
      ],
      modules: [{
        name: 'linalg',
        kind: 'module',
        members: [{ name: 'norm', kind: 'function', detail: 'norm(x)' }]
      }]
    }]
  };
}

test('normalizes cache scopes without paths and supports slash-containing Git branches', () => {
  const normalized = normalizeScope(teamScope());
  assert.match(normalized.scopeHash, /^[a-f0-9]{64}$/);
  assert.equal(normalized.value.workspace.branch, 'feature/cache-fast-path');
  assert.throws(() => normalizeScope(personalScope({ workspace: { kind: 'personal', folderKey: 'C:\\users\\me' } })), /workspace identity/);
  assert.throws(() => normalizeScope(personalScope({ dependencyRevision: 'bad\nrevision' })), /dependency revision/);
  assert.throws(() => normalizeCacheKey('file:///secret/source.py'), /cache key/);
});

test('keeps cache namespaces separated for distinct authenticated user identities', () => {
  const first = normalizeScope(personalScope({ userId: 'uid-user-1' }));
  const second = normalizeScope(personalScope({ userId: 'uid-user-2' }));
  assert.notEqual(first.scopeHash, second.scopeHash);
  assert.notEqual(first.workspaceHash, second.workspaceHash);
});

test('sanitizes completion candidates and rejects incomplete / edit-bearing durable values', () => {
  const source = safeCandidate('cachedThing');
  const value = sanitizeCompletionItems(source, DEFAULT_POLICIES.active);
  assert.deepEqual(value, {
    items: [{
      label: 'cachedThing', kind: 3, insertText: 'cachedThing()', detail: 'cached candidate',
      filterText: 'cachedThing', sortText: 'cachedThing'
    }]
  });
  assert.equal(value.items[0].documentation, undefined);
  assert.equal(value.items[0].preselect, undefined);
  assert.equal(sanitizeCompletionItems(candidate('unsafeEdit'), DEFAULT_POLICIES.active), null);
  assert.equal(sanitizeCompletionItems({
    isIncomplete: false,
    items: [{ label: 'editWithInsertText', insertText: 'safe-looking', textEdit: { newText: 'unsafe' } }]
  }, DEFAULT_POLICIES.active), null);
  assert.equal(sanitizeCompletionItems({ isIncomplete: true, items: candidate('x').items }, DEFAULT_POLICIES.active), null);
  assert.equal(sanitizeCompletionItems({
    isIncomplete: false,
    items: [{ label: 'multiline', insertText: 'one\ntwo' }]
  }, DEFAULT_POLICIES.active), null);
});

test('legacy policies migrate to the public cache policies and cache size is bounded', () => {
  assert.equal(normalizeCacheMode('session'), 'lazy');
  assert.equal(normalizeCacheMode('persistent'), 'active');
  assert.equal(normalizeCacheMode('unknown'), 'lazy');
  assert.equal(normalizeCacheSizeMiB(-2), MIN_CACHE_SIZE_MIB);
  assert.equal(normalizeCacheSizeMiB(9999), MAX_CACHE_SIZE_MIB);
  assert.equal(normalizeCacheSizeMiB(31.6), 32);
});

test('lazy tier is durable and clears current workspace without affecting another workspace', async (t) => {
  const { root, cache } = makeTempCache();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = personalScope();
  const second = personalScope({ workspace: { kind: 'personal', folderKey: 'psecond' } });
  const policy = { mode: 'lazy', sizeMiB: 1 };
  await cache.put(first, 'sha256:one', safeCandidate('one'), policy);
  await cache.put(second, 'sha256:two', safeCandidate('two'), policy);
  assert.equal((await cache.get(first, 'sha256:one', policy)).items[0].label, 'one');
  const before = await cache.stats(first, policy);
  assert.equal(before.entryCount, 1);
  assert.equal(before.policy.refreshStrategy, 'on-miss-or-invalidation');
  assert.equal(before.totalQuotaBytes, 1024 * 1024);
  const cleared = await cache.clear({ scope: 'workspace', context: first }, policy);
  assert.equal(cleared.removedEntries, 1);
  assert.equal(await cache.get(first, 'sha256:one', policy), null);
  assert.equal((await cache.get(second, 'sha256:two', policy)).items[0].label, 'two');
  assert.equal(fs.existsSync(path.join(root, 'records')), true);
  const fresh = new ClientAnalysisCache({ baseDir: root });
  assert.equal((await fresh.get(second, 'sha256:two', policy)).items[0].label, 'two');
});

test('active tier survives a fresh instance, records no raw scope data and supports all clear', async (t) => {
  const { root, cache } = makeTempCache();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = teamScope();
  await cache.put(scope, 'sha256:active', safeCandidate('persisted'), { mode: 'active', sizeMiB: 32 });
  const manifestText = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  assert.equal(manifestText.includes('feature/cache-fast-path'), false);
  assert.equal(manifestText.includes('team-1'), false);
  assert.equal(manifestText.includes('u-100'), false);
  const fresh = new ClientAnalysisCache({ baseDir: root });
  // Both enabled modes share the same safe local store; switching policy does
  // not discard candidates simply because its refresh behavior changed.
  const hit = await fresh.get(scope, 'sha256:active', { mode: 'lazy', sizeMiB: 32 });
  assert.equal(hit.items[0].label, 'persisted');
  const all = await fresh.clear({ scope: 'all' }, { mode: 'active', sizeMiB: 32 });
  assert.equal(all.removedEntries, 1);
  assert.equal(await fresh.get(scope, 'sha256:active', { mode: 'active', sizeMiB: 32 }), null);
});

test('active entries expire and quotas prune least-recently-used entries', async (t) => {
  const { root, cache } = makeTempCache({
    now: (() => { let now = 1000; return () => now; })(),
    policies: {
      active: Object.assign({}, DEFAULT_POLICIES.active, {
        quotaBytes: 2000, scopeQuotaBytes: 2000, maxEntries: 2, maxScopeEntries: 2, ttlMs: 10
      })
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = personalScope();
  await cache.put(scope, 'sha256:old', safeCandidate('old'), 'active');
  await cache.put(scope, 'sha256:new', safeCandidate('new'), 'active');
  await cache.put(scope, 'sha256:newest', safeCandidate('newest'), 'active');
  assert.equal(await cache.get(scope, 'sha256:old', 'active'), null);
  assert.equal((await cache.get(scope, 'sha256:newest', 'active')).items[0].label, 'newest');
});

test('off tier never returns or persists values and clear requests require a scope except all', async (t) => {
  const { root, cache } = makeTempCache();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = personalScope();
  assert.deepEqual(await cache.put(scope, 'sha256:off', safeCandidate('off'), 'off'), { stored: false, reason: 'disabled' });
  assert.equal(await cache.get(scope, 'sha256:off', 'off'), null);
  await assert.rejects(cache.clear({ scope: 'workspace' }, 'lazy'), /scope is required/);
});

test('active and lazy policies expose independent refresh contracts while sharing capacity-scaled durable storage', async (t) => {
  const { root, cache } = makeTempCache();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = personalScope();
  const lazy = { mode: 'lazy', sizeMiB: 8 };
  const active = { mode: 'active', sizeMiB: 8 };
  await cache.put(scope, 'sha256:retained', safeCandidate('retained'), lazy);
  const activeStats = await cache.stats(scope, active);
  const lazyStats = await cache.stats(scope, lazy);
  assert.equal(activeStats.entryCount, 1);
  assert.equal(activeStats.policy.refreshStrategy, 'stale-while-revalidate');
  assert.equal(lazyStats.policy.refreshStrategy, 'on-miss-or-invalidation');
  assert.equal(activeStats.totalQuotaBytes, 8 * 1024 * 1024);
  assert.equal(cache.policy({ mode: 'active', sizeMiB: 1024 }).quotaBytes, 1024 * 1024 * 1024);
  await cache.clear({ scope: 'all' }, active);
  assert.equal((await cache.stats(scope, active)).entryCount, 0);
});

test('lowering a configured capacity prunes existing durable entries immediately', async (t) => {
  const { root, cache } = makeTempCache();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const larger = { mode: 'active', sizeMiB: 2 };
  const smaller = { mode: 'active', sizeMiB: 1 };
  // Spread records across scopes so the total cache can exceed 1 MiB without
  // violating the per-workspace cap that protects multi-project users.
  for (let workspace = 0; workspace < 3; workspace += 1) {
    const scope = personalScope({ workspace: { kind: 'personal', folderKey: 'pbulk' + workspace } });
    for (let entry = 0; entry < 20; entry += 1) {
      await cache.put(scope, 'sha256:bulk-' + workspace + '-' + entry, largeSafeCandidate('bulk' + workspace + '-' + entry), larger);
    }
  }
  const before = await cache.stats(null, larger);
  assert.ok(before.totalBytes > 1024 * 1024, 'test data exceeds the lowered quota');
  const result = await cache.prune(smaller, true);
  const after = await cache.stats(null, smaller);
  assert.equal(result.pruned, true);
  assert.ok(after.totalBytes <= 1024 * 1024, 'lowered quota is applied immediately');
  assert.ok(after.totalEntries < before.totalEntries, 'least recently used records were evicted');
});

test('a quota change bypasses the periodic cleanup throttle', async (t) => {
  let now = 10_000;
  const { root, cache } = makeTempCache({ now: () => now });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = personalScope();
  const high = { mode: 'lazy', sizeMiB: 2 };
  const low = { mode: 'lazy', sizeMiB: 1 };
  for (let entry = 0; entry < 110; entry += 1) {
    await cache.put(scope, 'sha256:throttle-' + entry, largeSafeCandidate('throttle-' + entry), high);
  }
  const before = await cache.stats(scope, high);
  assert.ok(before.totalBytes > 1024 * 1024, 'test data exceeds lower quota');
  // The previous write forced a prune at `now`; ordinary cleanup would be
  // throttled for an hour. The changed quota must still prune immediately.
  const result = await cache.prune(low, false);
  const after = await cache.stats(scope, low);
  assert.equal(result.pruned, true);
  assert.ok(after.totalBytes <= 1024 * 1024);
  now += 1;
});

test('sanitizes a bounded static dependency API tree and rejects source-like data', () => {
  const active = { mode: 'active', sizeMiB: MIN_DEPENDENCY_INDEX_SIZE_MIB, dependencyIndexEnabled: true };
  assert.deepEqual(sanitizeDependencyIndex(dependencyIndex(), active), dependencyIndex());
  assert.equal(sanitizeDependencyIndex(dependencyIndex(), { mode: 'lazy', sizeMiB: 1024, dependencyIndexEnabled: true }), null);
  assert.equal(sanitizeDependencyIndex(dependencyIndex(), { mode: 'active', sizeMiB: MIN_DEPENDENCY_INDEX_SIZE_MIB - 1, dependencyIndexEnabled: true }), null);
  assert.equal(sanitizeDependencyIndex(dependencyIndex(), { mode: 'active', sizeMiB: MIN_DEPENDENCY_INDEX_SIZE_MIB }), null);
  assert.equal(sanitizeDependencyIndex(Object.assign(dependencyIndex(), { source: 'import numpy' }), active), null);
  assert.equal(sanitizeDependencyIndex({
    schema: DEPENDENCY_INDEX_SCHEMA,
    roots: [{ name: 'numpy', kind: 'module', detail: '/persist/pip-packages/numpy', members: [] }]
  }, active), null);
  assert.equal(sanitizeDependencyIndex({
    schema: DEPENDENCY_INDEX_SCHEMA,
    roots: [{ name: 'numpy', kind: 'module', members: [{ name: 'array', kind: 'function', detail: 'line one\nline two' }] }]
  }, active), null);
});

test('dependency indexes require active mode and a 30 MiB capacity', async (t) => {
  const { root, cache } = makeTempCache();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = personalScope();
  assert.deepEqual(await cache.putDependencyIndex(scope, 'api:numpy', dependencyIndex(), { mode: 'lazy', sizeMiB: 1024, dependencyIndexEnabled: true }), {
    stored: false, reason: 'disabled'
  });
  assert.deepEqual(await cache.putDependencyIndex(scope, 'api:numpy', dependencyIndex(), { mode: 'active', sizeMiB: 29, dependencyIndexEnabled: true }), {
    stored: false, reason: 'disabled'
  });
  assert.equal(await cache.getDependencyIndex(scope, 'api:numpy', { mode: 'active', sizeMiB: 29, dependencyIndexEnabled: true }), null);
  const stored = await cache.putDependencyIndex(scope, 'api:numpy', dependencyIndex(), { mode: 'active', sizeMiB: 30, dependencyIndexEnabled: true });
  assert.equal(stored.stored, true);
  assert.deepEqual(await cache.getDependencyIndex(scope, 'api:numpy', { mode: 'active', sizeMiB: 30, dependencyIndexEnabled: true }), dependencyIndex());
  const stats = await cache.stats(scope, { mode: 'active', sizeMiB: 30, dependencyIndexEnabled: true });
  assert.equal(stats.entryCount, 1);
  assert.equal(stats.dependencyIndexEntries, 1);
  assert.ok(stats.dependencyIndexBytes > 0);
  assert.equal(stats.policy.dependencyIndex.enabled, true);
});

test('dependency indexes share quota but are evicted before completion hints', async (t) => {
  const { root, cache } = makeTempCache({
    policies: {
      active: Object.assign({}, DEFAULT_POLICIES.active, {
        quotaBytes: 2_500,
        scopeQuotaBytes: 2_500,
        maxEntries: 20,
        maxScopeEntries: 20
      })
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = personalScope();
  const policy = { mode: 'active', sizeMiB: 30, dependencyIndexEnabled: true };
  // The override models pressure under a 30 MiB logical setting while keeping
  // a unit test compact. Index and completion records use the same manifest.
  assert.equal((await cache.putDependencyIndex(scope, 'api:numpy', dependencyIndex(), policy)).stored, true);
  assert.equal((await cache.put(scope, 'sha256:completion', mediumSafeCandidate('completion'), policy)).stored, true);
  await cache.prune(policy, true);
  assert.equal(await cache.getDependencyIndex(scope, 'api:numpy', policy), null);
  assert.ok(await cache.get(scope, 'sha256:completion', policy));
  const stats = await cache.stats(scope, policy);
  assert.equal(stats.entryCount, 1);
  assert.equal(stats.completionEntries, 1);
  assert.equal(stats.dependencyIndexEntries, 0);
});

test('dependency index records stay scope-isolated and can be cleared without evicting completions', async (t) => {
  const { root, cache } = makeTempCache();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = personalScope();
  const second = personalScope({ workspace: { kind: 'personal', folderKey: 'pother-index' } });
  const policy = { mode: 'active', sizeMiB: 32, dependencyIndexEnabled: true };
  await cache.putDependencyIndex(first, 'api:numpy', dependencyIndex(), policy);
  await cache.put(first, 'sha256:completion', safeCandidate('retainMe'), policy);
  await cache.putDependencyIndex(second, 'api:numpy', dependencyIndex('pandas'), policy);
  const cleared = await cache.clearDependencyIndexes({ scope: 'workspace', context: first }, policy);
  assert.equal(cleared.removedEntries, 1);
  assert.equal(await cache.getDependencyIndex(first, 'api:numpy', policy), null);
  assert.equal((await cache.get(first, 'sha256:completion', policy)).items[0].label, 'retainMe');
  assert.deepEqual(await cache.getDependencyIndex(second, 'api:numpy', policy), dependencyIndex('pandas'));
  const all = await cache.clear({ scope: 'all' }, policy);
  assert.equal(all.removedEntries, 2);
  assert.equal(await cache.getDependencyIndex(second, 'api:numpy', policy), null);
});

test('dependency indexes expire after 24 hours while type-less legacy completions remain readable', async (t) => {
  let now = 5_000;
  const { root, cache } = makeTempCache({ now: () => now });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = personalScope();
  const policy = { mode: 'active', sizeMiB: 32, dependencyIndexEnabled: true };
  await cache.putDependencyIndex(scope, 'api:numpy', dependencyIndex(), policy);
  await cache.put(scope, 'sha256:legacy-completion', safeCandidate('legacy'), policy);
  const scopeHash = normalizeScope(scope).scopeHash;
  const completionKeyHash = normalizeCacheKey('sha256:legacy-completion');
  const manifestPath = path.join(root, 'manifest.json');
  const recordPath = path.join(root, 'records', scopeHash, completionKeyHash + '.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  delete manifest.entries[scopeHash + ':' + completionKeyHash].type;
  delete record.type;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(recordPath, JSON.stringify(record), 'utf8');
  const fresh = new ClientAnalysisCache({ baseDir: root, now: () => now });
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(await fresh.getDependencyIndex(scope, 'api:numpy', policy), null);
  assert.equal((await fresh.get(scope, 'sha256:legacy-completion', policy)).items[0].label, 'legacy');
  const records = fs.readdirSync(path.join(root, 'records', scopeHash));
  assert.ok(records.some((filename) => /^dependency-index-/.test(filename)) === false);
  assert.ok(records.some((filename) => !/^dependency-index-/.test(filename)));
});
