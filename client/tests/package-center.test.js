'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
globalThis.BOBO = { state: {
  workspaceRoot: 'C:\\work\\demo',
  workspaceIdentity: 7,
  workspaceGeneration: 1,
  selectedRuntime: 'python:3.11',
  runIdentityEpoch: 1,
  serverSettings: { ip: 'compiler.example', user: 'root', httpPort: 3100, secureTransport: false },
  auth: { mode: 'multi', token: 'token-1', user: { id: 'alice' } },
  lsp: { settings: { mode: 'standard' } }
} };
const {
  normalizeContext,
  normalizePackageManager,
  normalizePackageCapabilities,
  assertManagedPackageManager,
  normalizeResults,
  normalizeCompatibility,
  normalizePackageVersions,
  preferredPackageVersion,
  resolvedRuntimeVersion,
  runtimeDisplayLabel,
  automaticPackageVersion,
  mergeInstalledState,
  upsertChange,
  removeChange,
  normalizeManagedPackageChanges,
  exactDeclaredPackageVersion,
  managedPackageDeclarations,
  inventoryBinding,
  canonicalPackageLanguage,
  packageLanguageForRequest,
  packageContextMatchesRequest,
  localizedPackageError,
  applyServerPlan,
  captureOperationContext,
  operationContextMatches,
  rebindOperationContext,
  stableIdentityState,
  captureEditorSnapshots,
  updateOpenBuffers,
  collectEditorConflicts,
  normalizePendingRecovery,
  refreshConfiguredLanguageService,
  packageQueryTimeoutMs,
  packagePlanTimeoutMs,
  packageApplyTimeoutMs,
  PACKAGE_QUERY_TIMEOUT_MS,
  PACKAGE_QUERY_GRACE_MS,
  PACKAGE_APPLY_GRACE_MS,
  PACKAGE_APPLY_RESPONSE_GRACE_MS,
  PACKAGE_PLAN_TIMEOUT_MS
} = require('../src/package-center');

test('pending local recovery normalization exposes only relative file summaries', () => {
  assert.deepEqual(normalizePendingRecovery({
    transactionId: 'tx-1',
    files: [
      { path: 'package.json', exists: true, sha256: 'A'.repeat(64) },
      { path: '../secret', exists: true, sha256: 'B'.repeat(64) }
    ],
    conflicts: [{ path: 'package.json' }]
  }), {
    transactionId: 'tx-1',
    state: 'reconciliation-required',
    files: [{ path: 'package.json', exists: true, sha256: 'a'.repeat(64) }],
    conflicts: [{ path: 'package.json' }]
  });
});

test('package IPC errors use stable localized messages instead of raw main-process text', () => {
  const originalI18n = globalThis.BOBO.i18n;
  let locale = 'zh-CN';
  const translations = {
    'The library plan contains an invalid dependency file change.': '本地化：计划无效',
    'The selected library change conflicts with the project dependency file.': '本地化：依赖文件冲突',
    'The project pnpm version does not match this server policy. Update packageManager and try again.': '本地化：pnpm 策略不一致',
    'The project folder must be a real directory, not a symbolic link.': '本地化：工作区链接无效',
    'Package transaction id is required': '本地化：缺少事务 ID',
    'The project library cache quota is full.': '本地化：缓存配额已满',
    'The library request failed.': '本地化：请求失败',
    'Library update failed.': '本地化：更新失败'
  };
  const japaneseTranslations = {
    'The library request failed.': 'ライブラリ要求に失敗しました。'
  };
  globalThis.BOBO.i18n = {
    getActive: () => locale,
    t: (key) => (locale === 'ja' ? japaneseTranslations[key] : translations[key]) || key
  };
  try {
    assert.equal(localizedPackageError({ code: 'PACKAGE_CHANGE_INVALID', message: 'wording may change' }, 'Library update failed.'), '本地化：计划无效');
    assert.equal(localizedPackageError({ code: 'PACKAGE_WORKSPACE_SYMLINK', message: 'raw path detail' }, 'Library update failed.'), '本地化：工作区链接无效');
    assert.equal(
      localizedPackageError({ success: false, errorCode: 'package_storage_quota_exceeded', error: 'raw server wording' }, 'Library update failed.'),
      '本地化：缓存配额已满'
    );
    assert.equal(
      localizedPackageError({ success: false, errorCode: 'package_manifest_change_invalid', error: 'raw server wording' }, 'Library update failed.'),
      '本地化：依赖文件冲突'
    );
    assert.equal(
      localizedPackageError({ success: false, errorCode: 'package_manager_policy_mismatch', error: 'raw server wording' }, 'Library update failed.'),
      '本地化：pnpm 策略不一致'
    );
    assert.equal(
      localizedPackageError({ success: false, error: 'dynamic English server detail' }, 'The library request failed.'),
      '本地化：请求失败'
    );
    assert.equal(
      localizedPackageError(new Error("Error invoking remote method 'package-center:rollback-local-changes': Error: Package transaction id is required"), 'Dependency file rollback failed.'),
      '本地化：缺少事务 ID'
    );
    assert.equal(localizedPackageError({ code: 'PACKAGE_FUTURE_FAILURE', message: 'new raw wording' }, 'Library update failed.'), '本地化：更新失败');
    locale = 'en';
    assert.equal(
      localizedPackageError({ success: false, error: { message: 'Fixture install failed' } }, 'The library request failed.'),
      'Fixture install failed'
    );
    locale = 'ja';
    assert.equal(
      localizedPackageError({ success: false, error: { message: 'Fixture install failed' } }, 'The library request failed.'),
      'ライブラリ要求に失敗しました。'
    );
  } finally {
    globalThis.BOBO.i18n = originalI18n;
  }
});

test('package center honors the server planning capability and source defaults', () => {
  const context = normalizeContext({
    defaultSource: 'pypi-tuna',
    catalogTimeoutSeconds: 12,
    searchMode: 'exact',
    sources: [
      { id: 'pypi-official', name: 'PyPI', kind: 'official' },
      { id: 'pypi-tuna', name: 'TUNA', kind: 'mirror' }
    ],
    canPlanChanges: { supported: false, reason: 'team-workspace-unsupported' },
    inventory: { status: 'ready', exact: false }
  });

  assert.equal(context.supported, false);
  assert.equal(context.reason, 'Library management is unavailable for this project.');
  assert.equal(context.selectedSourceId, 'pypi-tuna');
  assert.equal(context.searchMode, 'exact');
  assert.equal(context.catalogTimeoutSeconds, 12);
  assert.equal(context.inventoryExact, false, 'ready but inexact inventory must remain read-only');
  assert.equal(context.operationTimeoutSeconds, 600);
});

test('project dependency context preserves Node manager, lock, scopes, and split capabilities', () => {
  const normalized = normalizeContext({
    language: { id: 'node', displayName: 'Node.js' },
    runtime: { id: 'node:22', interpreterVersion: '22.14.0' },
    manager: {
      id: 'pnpm', name: 'pnpm', manifestPath: 'package.json', lockfilePath: 'pnpm-lock.yaml',
      lockfilePresent: true, detectedBy: 'pnpm-lock.yaml', scopes: ['runtime', 'dev', 'optional']
    },
    capabilities: {
      browse: true, inspect: true, mutate: false, exactInventory: true,
      scopes: true, prereleases: true, transitivePackages: true
    },
    canPlanChanges: { supported: false, reason: 'Fixture policy blocks changes' },
    manifests: [
      { path: 'package.json', manager: 'pnpm', kind: 'package', language: 'node', editable: true },
      { path: 'pnpm-lock.yaml', manager: 'pnpm', kind: 'pnpm-lock', language: 'node', lockfile: true }
    ],
    defaultManifestPath: 'package.json',
    packages: { declared: [], installed: [], missing: [], unknown: [] }
  });

  assert.equal(normalized.supported, true, 'read-only catalog browsing remains available');
  assert.equal(normalized.canMutate, false);
  assert.equal(normalized.mutationReason, 'Fixture policy blocks changes');
  assert.deepEqual(normalized.manager, {
    id: 'pnpm', name: 'pnpm', manifestPath: 'package.json', lockfilePath: 'pnpm-lock.yaml',
    lockfilePresent: true, detectedBy: 'pnpm-lock.yaml', scopes: ['runtime', 'dev', 'optional']
  });
  assert.equal(normalized.capabilities.transitivePackages, true);
  assert.equal(normalized.capabilities.scopes, true);
  assert.equal(normalizePackageManager({}, { id: 'python' }, [{ path: 'requirements.txt', manager: 'pip' }], 'requirements.txt').id, 'pip');
  assert.equal(normalizePackageCapabilities({ browse: true, mutate: false }, { supported: true }).mutate, false);
});

test('npm metadata and exact manifest pins survive catalog normalization', () => {
  const item = normalizeResults({ items: [{
    name: '@scope/demo', recommendedVersion: '3.2.1', description: 'Scoped demo',
    requiresLanguage: '>=20', deprecated: true, deprecationMessage: 'Use @scope/next',
    distTags: { latest: '3.2.1', next: '4.0.0-beta.1' },
    versions: [
      { version: '3.2.1', compatibility: 'compatible', deprecated: true, deprecationMessage: 'Use @scope/next' },
      { version: '4.0.0-beta.1', compatibility: 'compatible' }
    ]
  }] }).items[0];
  assert.equal(item.requiresLanguage, '>=20');
  assert.equal(item.deprecated, true);
  assert.deepEqual(item.distTags, { latest: '3.2.1', next: '4.0.0-beta.1' });
  const stable = normalizePackageVersions(item, false);
  assert.equal(stable.length, 1);
  assert.equal(stable[0].deprecated, true);
  assert.equal(exactDeclaredPackageVersion({ constraint: '3.2.1' }), '3.2.1');
  assert.equal(exactDeclaredPackageVersion({ constraint: '^3.2.1' }), '');
});

test('terminal-managed dependency changes cannot cross Node package managers', () => {
  assert.equal(assertManagedPackageManager('pnpm', 'pnpm'), true);
  assert.equal(assertManagedPackageManager('', 'npm'), true);
  assert.throws(() => assertManagedPackageManager('pnpm', 'npm'), /project uses npm; pnpm commands cannot manage/i);
});

test('catalog requests follow the server deadline with transport grace', () => {
  assert.equal(packageQueryTimeoutMs(), PACKAGE_QUERY_TIMEOUT_MS);
  assert.equal(packageQueryTimeoutMs(5), PACKAGE_QUERY_TIMEOUT_MS);
  assert.equal(packageQueryTimeoutMs(12), 12000 + PACKAGE_QUERY_GRACE_MS);
});

test('dependency planning honors the server operation deadline with a sane minimum', () => {
  assert.equal(packagePlanTimeoutMs(5), PACKAGE_PLAN_TIMEOUT_MS);
  assert.equal(packagePlanTimeoutMs(120), 120000 + PACKAGE_QUERY_GRACE_MS);
});

test('installed view never promotes a manifest declaration into installed inventory', () => {
  const normalized = normalizeContext({
    manifests: [
      { path: 'requirements.txt', kind: 'requirements', language: 'python' },
      { path: '.bobocloud/source-imports.txt', kind: 'source-imports', language: 'python' }
    ],
    packages: {
      declared: [
        { name: 'requests', constraint: '==2.31.0', source: 'requirements.txt' },
        { name: 'numpy', constraint: '==2.3.1', source: 'requirements.txt' },
        { name: 'cv2', source: '.bobocloud/source-imports.txt' }
      ],
      installed: [{ name: 'requests', version: '2.31.0', relationship: 'direct' }],
      missing: [{ name: 'numpy', constraint: '==2.3.1', source: 'requirements.txt' }, { name: 'cv2', source: '.bobocloud/source-imports.txt' }],
      unknown: []
    },
    inventory: {
      exact: true,
      generation: 'generation-current',
      dependencyDigest: 'digest-current',
      cacheEntryId: 'cache-entry-current'
    }
  });
  assert.deepEqual(normalized.installed.map(item => item.name), ['requests']);
  assert.equal(normalized.installed[0].version, '2.31.0');
  assert.equal(normalized.inventoryGeneration, 'generation-current');
  assert.equal(normalized.inventoryDependencyDigest, 'digest-current');
  assert.equal(normalized.inventoryCacheEntryId, 'cache-entry-current');
  assert.deepEqual(normalized.missing.map(item => item.name), ['numpy', 'cv2']);

  const catalog = mergeInstalledState({ name: 'numpy', latestVersion: '2.3.1', installedVersion: '9.9.9', direct: true }, normalized.installed);
  assert.equal(catalog.installedVersion, '');
  assert.equal(catalog.direct, false);
  assert.equal(catalog.projectCached, false);
  assert.equal(catalog.inventoryPresent, false);
  assert.equal(catalog.inventoryState, '');
});

test('installed view preserves a real but declaration-mismatched version', () => {
  const normalized = normalizeContext({
    language: { id: 'python' },
    manifests: [{ path: 'requirements.txt', kind: 'requirements', language: 'python' }],
    packages: {
      declared: [{ name: 'demo_pkg', constraint: '==2.0.0', source: 'requirements.txt' }],
      installed: [{ name: 'demo-pkg', version: '1.0.0', relationship: 'direct' }],
      missing: [{ name: 'demo.pkg', constraint: '==2.0.0', source: 'requirements.txt' }],
      unknown: []
    },
    inventory: {
      exact: true,
      generation: 'generation-mismatch',
      dependencyDigest: 'digest-mismatch',
      cacheId: 'cache-entry-mismatch'
    }
  });
  assert.equal(normalized.installed.length, 1, 'PEP 503 equivalent names must merge');
  assert.equal(normalized.installed[0].version, '1.0.0');
  assert.equal(normalized.installed[0].inventoryPresent, true);
  assert.equal(normalized.installed[0].inventoryState, 'mismatch');
  assert.equal(normalized.missing.length, 0, 'an observed installed package must not also appear as a missing suggestion');
});

test('installed view rejects exact-looking inventory without current cache binding', () => {
  const normalized = normalizeContext({
    packages: {
      installed: [{ name: 'numpy', version: '2.3.1', relationship: 'direct' }],
      missing: [],
      unknown: []
    },
    inventory: { exact: true, generation: 'generation-only' }
  });
  assert.equal(normalized.inventoryExact, false);
  assert.deepEqual(normalized.installed, []);
});

test('package inventory binding accepts the current Go cache id and binds response identity', () => {
  assert.deepEqual(inventoryBinding({ inventory: {
    exact: true,
    cacheId: 'cache-current',
    generation: 'generation-current',
    dependencyDigest: 'digest-current'
  } }), {
    exact: true,
    authoritative: true,
    cacheEntryId: 'cache-current',
    generation: 'generation-current',
    dependencyDigest: 'digest-current'
  });
  const response = {
    workspace: { kind: 'personal', key: 'project-key' },
    runtime: { id: 'python:3.11' },
    language: { id: 'python' }
  };
  assert.equal(packageContextMatchesRequest(response, {
    folderKey: 'project-key', runtime: 'python:3.11', language: 'python'
  }), true);
  assert.equal(packageContextMatchesRequest(response, {
    folderKey: 'other-project', runtime: 'python:3.11', language: 'python'
  }), false);
  assert.equal(packageContextMatchesRequest(response, {
    folderKey: 'project-key', runtime: 'python:3.12', language: 'python'
  }), false);
});

test('package context matches Node editor language aliases without weakening workspace or runtime binding', () => {
  const response = {
    workspace: { kind: 'personal', key: 'node-project' },
    runtime: { id: 'node:22' },
    language: { id: 'node' }
  };
  const request = { folderKey: 'node-project', runtime: 'node:22' };

  for (const language of ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'node', 'nodejs']) {
    assert.equal(packageContextMatchesRequest(response, { ...request, language }), true, language);
  }

  assert.equal(packageContextMatchesRequest(response, { ...request, language: 'python' }), false);
  assert.equal(packageContextMatchesRequest(response, {
    folderKey: 'other-project', runtime: 'node:22', language: 'javascript'
  }), false);
  assert.equal(packageContextMatchesRequest(response, {
    folderKey: 'node-project', runtime: 'node:20', language: 'typescript'
  }), false);
});

test('package requests follow the selected runtime ecosystem instead of the active editor file', () => {
  assert.equal(packageLanguageForRequest({ runtime: 'node:22', language: 'json' }), 'node');
  assert.equal(packageLanguageForRequest({ runtime: 'node:22', language: 'javascript' }), 'node');
  assert.equal(packageLanguageForRequest({ runtime: 'python:3.10', language: 'javascript' }), 'python');
  assert.equal(packageLanguageForRequest({ runtime: '', language: 'typescriptreact' }), 'node');
  assert.equal(canonicalPackageLanguage('golang'), 'go');
});

test('catalog results distinguish direct updates from transitive pins', () => {
  const direct = mergeInstalledState({ name: 'numpy', latestVersion: '2.3.1' }, [
    { name: 'NumPy', version: '2.2.0', direct: true, scope: 'runtime' }
  ]);
  assert.equal(direct.installedVersion, '2.2.0');
  assert.equal(direct.direct, true);

  const transitive = mergeInstalledState({ name: 'urllib3', latestVersion: '2.5.0' }, [
    { name: 'urllib3', version: '2.4.0', direct: false, scope: 'runtime' }
  ]);
  assert.equal(transitive.installedVersion, '2.4.0');
  assert.equal(transitive.direct, false);
});

test('catalog normalization understands metadata compatibility and exact versions', () => {
  const result = normalizeResults({
    items: [{ name: 'numpy', latestVersion: '2.3.1', description: 'Arrays', compatibility: 'metadata-compatible' }]
  });
  assert.equal(result.items[0].version, '2.3.1');
  assert.equal(result.items[0].summary, 'Arrays');
  assert.equal(result.items[0].compatibility, 'compatible');
  assert.equal(normalizeCompatibility('source-build'), 'build-required');
  assert.equal(normalizeCompatibility('incompatible'), 'incompatible');
});

test('version selection prefers an installable release and never preserves a disabled release', () => {
  const item = {
    version: '3.0.0',
    compatibility: 'unknown',
    raw: { versions: [
      { version: '3.0.0', compatibility: 'incompatible', reason: 'Requires Python 3.12' },
      { version: '2.9.0', compatibility: 'metadata-compatible' },
      { version: '2.8.0', compatibility: 'metadata-compatible', yanked: true },
      { version: '2.7.0rc1', compatibility: 'metadata-compatible' }
    ] }
  };
  const stable = normalizePackageVersions(item, false);
  assert.deepEqual(stable.map(version => version.version), ['3.0.0', '2.9.0', '2.8.0']);
  assert.equal(stable[0].compatibilityReason, 'Requires Python 3.12');
  assert.equal(preferredPackageVersion(stable, item.version, ''), '2.9.0');
  assert.equal(preferredPackageVersion(stable, item.version, '3.0.0'), '2.9.0');
  assert.equal(preferredPackageVersion(stable, item.version, '2.9.0'), '2.9.0');
  assert.equal(preferredPackageVersion(stable.filter(version => version.compatibility === 'incompatible'), item.version, ''), '');
});

test('automatic version selection favors a stable compatible release for the resolved interpreter', () => {
  const item = {
    name: 'numpy',
    recommendedVersion: '2.3.1',
    compatibility: 'metadata-compatible',
    versions: [
      { version: '2.4.0', compatibility: 'incompatible', reason: 'Requires Python >=3.12' },
      { version: '2.3.2rc1', compatibility: 'metadata-compatible', prerelease: true },
      { version: '2.3.1', compatibility: 'metadata-compatible' },
      { version: '2.2.6', compatibility: 'source-build' }
    ]
  };
  assert.equal(automaticPackageVersion(item), '2.3.1');
  const normalized = normalizeResults({ items: [item] }).items[0];
  assert.equal(preferredPackageVersion(normalizePackageVersions(normalized, false), '2.2.6', '2.2.6'), '2.3.1', 'a compatible wheel outranks a preserved source-build candidate');
});

test('runtime labels expose the resolved patch version instead of only the runtime family', () => {
  const runtime = { id: 'python:3.10', displayName: 'Python 3.10', version: '3.10', interpreterVersion: '3.10.19' };
  assert.equal(resolvedRuntimeVersion(runtime), '3.10.19');
  assert.equal(runtimeDisplayLabel(runtime, { id: 'python', displayName: 'Python' }), 'Python 3.10.19');
  assert.equal(runtimeDisplayLabel({ language: 'python', version: '3.10', actualVersion: '3.10.21' }, {}), 'Python 3.10.21');
});

test('pending changes remain one operation per package and can be cancelled', () => {
  let changes = upsertChange([], { operation: 'add', name: 'NumPy', version: '2.2.0' });
  changes = upsertChange(changes, { operation: 'update', name: 'numpy', version: '2.3.0' });
  changes = upsertChange(changes, { operation: 'add', name: 'requests', version: '2.32.4' });
  assert.deepEqual(changes.map((item) => [item.operation, item.name, item.version]), [
    ['update', 'numpy', '2.3.0'],
    ['add', 'requests', '2.32.4']
  ]);
  changes = removeChange(changes, 'NUMPY');
  assert.deepEqual(changes.map((item) => item.name), ['requests']);
});

test('terminal package intents map through authoritative installed inventory', () => {
  const changes = normalizeManagedPackageChanges([
    { operation: 'install', name: 'NumPy', version: '2.3.1' },
    { operation: 'install', name: 'urllib3' },
    { operation: 'remove', name: 'requests', version: 'ignored' }
  ], [
    { name: 'numpy', version: '2.2.0', direct: true, scope: 'runtime' },
    { name: 'urllib3', version: '2.4.0', direct: false, scope: 'runtime' }
  ]);
  assert.deepEqual(changes, [
    { operation: 'update', name: 'NumPy', version: '2.3.1', scope: 'runtime' },
    { operation: 'add', name: 'urllib3', version: '', scope: 'runtime' },
    { operation: 'remove', name: 'requests', version: '', scope: 'runtime' }
  ]);
});

test('managed installs rehydrate an exact declared package and add a genuinely undeclared package', () => {
  const context = {
    manifests: [
      { path: 'requirements.txt', kind: 'requirements' },
      { path: '.bobocloud/source-imports.txt', kind: 'source-imports' }
    ],
    packages: { declared: [
      { name: 'numpy', constraint: '==2.1.0', source: 'requirements.txt', scope: 'runtime' },
      { name: 'cv2', source: '.bobocloud/source-imports.txt' }
    ] }
  };
  const declarations = managedPackageDeclarations(context);
  assert.deepEqual(declarations.map(item => item.name), ['numpy']);
  assert.equal(exactDeclaredPackageVersion(declarations[0]), '2.1.0');
  assert.deepEqual(normalizeManagedPackageChanges([
    { operation: 'install', name: 'NumPy' },
    { operation: 'install', name: 'pandas', version: '2.3.1' }
  ], [], declarations), [{
    operation: 'update', name: 'NumPy', version: '2.1.0', scope: 'runtime'
  }, {
    operation: 'add', name: 'pandas', version: '2.3.1', scope: 'runtime'
  }]);
});

test('package apply retries uncertain transport with the same plan and honors Retry-After', async () => {
  const originalSend = globalThis.BOBO.sendToServer;
  const calls = [];
  let clock = 1000;
  const startedAt = clock;
  const responses = [
    { success: false, errorCode: 'transport_timeout', error: 'timeout' },
    { success: false, status: 409, errorCode: 'package_plan_in_use', retryAfterSeconds: 0.001 },
    { success: true, data: { applied: true } }
  ];
  globalThis.BOBO.sendToServer = async (action, payload, options) => {
    calls.push({ action, payload, options });
    if (calls.length === 1) clock += options.timeoutMs;
    return responses.shift();
  };
  try {
    const payload = { packagePlanId: 'plan-1', revision: 'revision-1' };
    const result = await applyServerPlan(payload, {
      operationTimeoutSeconds: 2,
      now: () => clock,
      wait: async milliseconds => { clock += milliseconds; }
    });
    assert.equal(result.success, true);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.action === 'applyProjectPackageChanges' && call.payload === payload));
    assert.equal(calls[0].options.timeoutMs, 2000 + PACKAGE_APPLY_RESPONSE_GRACE_MS);
    assert.ok(calls.slice(1).every(call => call.options.timeoutMs <= PACKAGE_PLAN_TIMEOUT_MS));
    assert.equal(packageApplyTimeoutMs(2), 2000 + PACKAGE_APPLY_GRACE_MS);
    assert.ok(clock - startedAt <= packageApplyTimeoutMs(2), 'transport retries must not extend the total deadline');
  } finally {
    globalThis.BOBO.sendToServer = originalSend;
  }
});

test('package apply never retries an old plan through a changed live server identity', async () => {
  const originalSend = globalThis.BOBO.sendToServer;
  let identityMatches = true;
  const calls = [];
  globalThis.BOBO.sendToServer = async (action, payload, options) => {
    calls.push({ action, payload, options });
    identityMatches = false;
    return { success: false, errorCode: 'transport_timeout', error: 'timeout' };
  };
  try {
    const result = await applyServerPlan({ packagePlanId: 'plan-old-server' }, {
      operationTimeoutSeconds: 1,
      canSend: () => identityMatches,
      wait: async () => {}
    });
    assert.equal(calls.length, 1);
    assert.equal(result.errorCode, 'package_apply_context_changed');
    assert.equal(result.uncertain, true);
  } finally {
    globalThis.BOBO.sendToServer = originalSend;
  }
});

test('package apply keeps timeout followed by unavailable plan in reconciliation', async () => {
  const originalSend = globalThis.BOBO.sendToServer;
  const responses = [
    { success: false, errorCode: 'transport_timeout', error: 'timeout' },
    { success: false, status: 409, errorCode: 'package_plan_unavailable', error: 'durable plan record unavailable' }
  ];
  globalThis.BOBO.sendToServer = async () => responses.shift();
  try {
    const result = await applyServerPlan({ packagePlanId: 'plan-uncertain' }, {
      operationTimeoutSeconds: 1,
      wait: async () => {}
    });
    assert.equal(result.errorCode, 'package_plan_unavailable');
    assert.equal(result.uncertain, true, 'an unavailable record cannot prove a timed-out publish did not happen');
  } finally {
    globalThis.BOBO.sendToServer = originalSend;
  }
});

test('package apply treats runtime image drift as a definitive pre-execution failure', async () => {
  const originalSend = globalThis.BOBO.sendToServer;
  let calls = 0;
  globalThis.BOBO.sendToServer = async () => {
    calls += 1;
    return { success: false, status: 409, errorCode: 'package_plan_runtime_changed', error: 'runtime image changed' };
  };
  try {
    const result = await applyServerPlan({ packagePlanId: 'plan-runtime-drift' }, {
      operationTimeoutSeconds: 1,
      wait: async () => {}
    });
    assert.equal(calls, 1);
    assert.equal(result.errorCode, 'package_plan_runtime_changed');
    assert.notEqual(result.uncertain, true);
  } finally {
    globalThis.BOBO.sendToServer = originalSend;
  }
});

test('package apply treats package manager policy mismatch as definitive', async () => {
  const originalSend = globalThis.BOBO.sendToServer;
  let calls = 0;
  globalThis.BOBO.sendToServer = async () => {
    calls += 1;
    return {
      success: false,
      status: 409,
      errorCode: 'package_manager_policy_mismatch',
      error: 'project packageManager does not match the server policy'
    };
  };
  try {
    const result = await applyServerPlan({ packagePlanId: 'plan-manager-mismatch' }, {
      operationTimeoutSeconds: 1,
      wait: async () => {}
    });
    assert.equal(calls, 1);
    assert.equal(result.errorCode, 'package_manager_policy_mismatch');
    assert.notEqual(result.uncertain, true);
  } finally {
    globalThis.BOBO.sendToServer = originalSend;
  }
});

test('unknown gateway failures remain uncertain after an apply request was sent', async () => {
  const originalSend = globalThis.BOBO.sendToServer;
  let calls = 0;
  globalThis.BOBO.sendToServer = async () => {
    calls += 1;
    return { success: false, status: 502, errorCode: 'invalid_server_response', error: 'bad gateway response' };
  };
  try {
    const result = await applyServerPlan({ packagePlanId: 'plan-gateway' }, {
      operationTimeoutSeconds: 1,
      wait: async () => {}
    });
    assert.equal(calls, 3);
    assert.equal(result.uncertain, true);
  } finally {
    globalThis.BOBO.sendToServer = originalSend;
  }
});

test('package reconciliation status polls the same plan with short follow-up requests', async () => {
  const originalSend = globalThis.BOBO.sendToServer;
  const calls = [];
  let clock = 0;
  const responses = [
    { success: false, status: 409, errorCode: 'package_plan_reconciliation_required', retryAfterSeconds: 0.001 },
    { success: true, data: { applied: true, planId: 'plan-reconcile' } }
  ];
  globalThis.BOBO.sendToServer = async (action, payload, options) => {
    calls.push({ action, payload, options });
    return responses.shift();
  };
  try {
    const payload = { packagePlanId: 'plan-reconcile', revision: 'revision-1' };
    const result = await applyServerPlan(payload, {
      operationTimeoutSeconds: 2,
      now: () => clock,
      wait: async milliseconds => { clock += milliseconds; }
    });
    assert.equal(result.data.planId, payload.packagePlanId);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].payload, payload);
    assert.equal(calls[1].payload, payload);
    assert.ok(calls[1].options.timeoutMs <= PACKAGE_PLAN_TIMEOUT_MS);
  } finally {
    globalThis.BOBO.sendToServer = originalSend;
  }
});

test('editor CAS preserves a manifest changed while a package plan is running', async () => {
  const state = globalThis.BOBO.state;
  const originalTabs = state.tabs;
  let value = 'requests==2.31.0\n';
  let version = 1;
  const model = {
    getValue: () => value,
    getVersionId: () => version,
    setValue: next => { value = next; version += 1; }
  };
  const tab = { path: 'C:\\work\\demo\\requirements.txt', model, dirty: false };
  state.tabs = [tab];
  try {
    const snapshots = await captureEditorSnapshots(state.workspaceRoot);
    value = 'requests==2.32.0\n';
    version += 1;
    tab.dirty = true;
    const updated = await updateOpenBuffers([
      { path: 'requirements.txt', newContent: 'requests==2.31.0\nnumpy==2.3.1\n' }
    ], 'newContent', state.workspaceRoot, snapshots);
    assert.equal(updated.length, 0);
    assert.equal(value, 'requests==2.32.0\n');
    assert.equal(tab.dirty, true);
    const conflicts = await collectEditorConflicts([
      { path: 'requirements.txt', sha256: 'a'.repeat(64) }
    ], snapshots, state.workspaceRoot);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, 'requirements.txt');
  } finally {
    state.tabs = originalTabs;
  }
});

test('editor CAS rechecks model version after asynchronous hashing', async () => {
  const state = globalThis.BOBO.state;
  const originalTabs = state.tabs;
  let value = 'requests==2.31.0\n';
  let versionReads = 0;
  const model = {
    getValue: () => value,
    getVersionId: () => (++versionReads < 3 ? 1 : 2),
    setValue: next => { value = next; }
  };
  state.tabs = [{ path: 'C:\\work\\demo\\requirements.txt', model, dirty: true }];
  try {
    const snapshots = await captureEditorSnapshots(state.workspaceRoot);
    const updated = await updateOpenBuffers([
      { path: 'requirements.txt', newContent: 'requests==2.31.0\nnumpy==2.3.1\n' }
    ], 'newContent', state.workspaceRoot, snapshots);
    assert.equal(updated.length, 0);
    assert.equal(value, 'requests==2.31.0\n');
  } finally {
    state.tabs = originalTabs;
  }
});

test('manifest opened during install is accepted when it matches the published digest', async () => {
  const state = globalThis.BOBO.state;
  const originalTabs = state.tabs;
  const value = 'requests==2.31.0\nnumpy==2.3.1\n';
  const model = { getValue: () => value, getVersionId: () => 1 };
  state.tabs = [{ path: 'C:\\work\\demo\\requirements.txt', model, dirty: false }];
  try {
    const conflicts = await collectEditorConflicts([{
      path: 'requirements.txt',
      sha256: crypto.createHash('sha256').update(value).digest('hex')
    }], [], state.workspaceRoot);
    assert.deepEqual(conflicts, []);
  } finally {
    state.tabs = originalTabs;
  }
});

test('recovery contexts rebind token epochs only for the same stable server and user', () => {
  const state = globalThis.BOBO.state;
  const original = {
    runIdentityEpoch: state.runIdentityEpoch,
    serverSettings: state.serverSettings,
    auth: state.auth
  };
  try {
    const operation = captureOperationContext();
    state.runIdentityEpoch += 1;
    state.auth = { mode: 'multi', token: 'renewed-token', user: { id: 'alice' } };
    assert.equal(operationContextMatches(operation), false, 'a direct apply response must not cross an epoch change');
    const rebound = rebindOperationContext(operation, { runtime: true });
    assert.equal(rebound.authEpoch, state.runIdentityEpoch);
    assert.equal(stableIdentityState(operation), 'same');

    state.auth = { mode: 'multi', token: 'other-token', user: { id: 'bob' } };
    assert.equal(stableIdentityState(operation), 'different');
    assert.equal(rebindOperationContext(operation), null);

    state.auth = { mode: 'multi', token: 'renewed-token', user: { id: 'alice' } };
    state.serverSettings = Object.assign({}, state.serverSettings, { ip: 'other.example' });
    assert.equal(stableIdentityState(operation), 'different');
    assert.equal(rebindOperationContext(operation), null);
  } finally {
    state.runIdentityEpoch = original.runIdentityEpoch;
    state.serverSettings = original.serverSettings;
    state.auth = original.auth;
  }
});

test('a false dependency refresh is recoverable only when cloud LSP is configured', async () => {
  const originalLsp = globalThis.BOBO.lsp;
  try {
    globalThis.BOBO.lsp = { getMode: () => 'standard', dependenciesChanged: () => false };
    await assert.rejects(refreshConfiguredLanguageService(), /analysis service could not verify/i);

    globalThis.BOBO.lsp = { getMode: () => 'local', dependenciesChanged: () => false };
    assert.equal(await refreshConfiguredLanguageService(), true);
  } finally {
    globalThis.BOBO.lsp = originalLsp;
  }
});
