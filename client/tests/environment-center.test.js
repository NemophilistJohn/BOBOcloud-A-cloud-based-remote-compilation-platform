'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalLanguage,
  recognizeManifests,
  languageMatchesRuntime,
  normalizeHealth,
  mergeServerSnapshot,
  unresolvedPythonImport,
  packageIdentity,
  dependencyIssueRows,
  mergeLiveDependencyDiagnostics,
  localizedDynamicText,
  healthFallbackDetail,
  localizedDependencyReason
} = require('../src/environment-center');

test('recognizes project dependency files while skipping generated dependency trees', () => {
  const root = 'C:\\work\\demo';
  const tree = {
    name: 'demo',
    path: root,
    type: 'folder',
    children: [
      { name: 'pyproject.toml', path: root + '\\pyproject.toml', type: 'file' },
      { name: 'requirements-dev.txt', path: root + '\\requirements-dev.txt', type: 'file' },
      {
        name: 'service', path: root + '\\service', type: 'folder', children: [
          { name: 'package.json', path: root + '\\service\\package.json', type: 'file' },
          { name: 'pnpm-lock.yaml', path: root + '\\service\\pnpm-lock.yaml', type: 'file' }
        ]
      },
      {
        name: 'node_modules', path: root + '\\node_modules', type: 'folder', children: [
          { name: 'package.json', path: root + '\\node_modules\\numpy\\package.json', type: 'file' }
        ]
      },
      {
        name: '.venv', path: root + '\\.venv', type: 'folder', children: [
          { name: 'pyproject.toml', path: root + '\\.venv\\lib\\pyproject.toml', type: 'file' }
        ]
      }
    ]
  };

  const manifests = recognizeManifests(tree, root);
  assert.deepEqual(manifests.map((item) => item.path), [
    'pyproject.toml',
    'requirements-dev.txt',
    'service/package.json',
    'service/pnpm-lock.yaml'
  ]);
  assert.equal(manifests.find((item) => item.path === 'service/pnpm-lock.yaml').lockfile, true);
});

test('maps editor languages to runtime families and diagnoses mismatches', () => {
  assert.equal(canonicalLanguage('typescript'), 'node');
  assert.equal(canonicalLanguage('cpp'), 'native');
  assert.equal(languageMatchesRuntime('javascript', { language: 'node' }), true);
  assert.equal(languageMatchesRuntime('cpp', { runtimeId: 'gcc:13', language: 'cpp' }), true);
  assert.equal(languageMatchesRuntime('python', { runtimeId: 'node:20', language: 'node' }), false);
  assert.equal(normalizeHealth('mixed'), 'warning');
  assert.equal(normalizeHealth('mismatch'), 'error');
});

test('cloud environment data upgrades local discovery without discarding local manifests', () => {
  const local = {
    schema: 'project-environment/v1',
    source: 'local',
    workspace: { kind: 'personal', name: 'demo', key: 'folder-key' },
    language: { id: 'python', source: 'editor' },
    runtime: { id: 'python:3.11', image: 'python:3.11' },
    manifests: [{ path: 'requirements.txt', manager: 'pip', localPath: 'C:\\work\\demo\\requirements.txt' }],
    packages: { declared: [], installed: [], missing: [], unknown: [] },
    consistency: { status: 'warning' },
    activity: {},
    actions: { repair: { supported: false } }
  };
  const remote = {
    schema: 'project-environment/v1',
    revision: 'env-2',
    workspace: { kind: 'personal', name: 'demo' },
    runtime: { id: 'python:3.11', image: 'bobocloud/python:3.11', status: 'ready' },
    packages: {
      declared: [{ name: 'numpy', constraint: '>=2' }],
      installed: [{ name: 'numpy', version: '2.2.6', trust: 'runtime-scoped' }],
      missing: [],
      unknown: []
    },
    consistency: { status: 'healthy' },
    actions: { repair: { supported: true, requiresConfirmation: true } }
  };

  const merged = mergeServerSnapshot(local, remote);
  assert.equal(merged.source, 'cloud');
  assert.equal(merged.runtime.image, 'bobocloud/python:3.11');
  assert.equal(merged.packages.installed[0].version, '2.2.6');
  assert.equal(merged.manifests[0].localPath, 'C:\\work\\demo\\requirements.txt');
  assert.equal(merged.actions.repair.supported, true);
});

test('unresolved Python imports supplement unavailable server truth without mutating it', () => {
  const snapshot = {
    language: { id: 'python' },
	dependencyCache: { inventoryStatus: 'missing' },
	packages: { declared: [], installed: [], missing: [], unknown: [] },
    consistency: {
	  status: 'unknown',
	  dependencyRuntime: { status: 'unknown', detail: 'Package inventory is missing' }
    },
    actions: { repair: { supported: false } }
  };
  const problems = [
    { severity: 'error', code: 'reportMissingImports', message: 'Import "numpy" could not be resolved' },
    { severity: 'error', code: 'reportMissingImports', message: 'Import "matplotlib.pyplot" could not be resolved' },
    { severity: 'error', code: 'reportMissingImports', message: 'Import "matplotlib.animation" could not be resolved' },
    { severity: 'warning', code: 'reportUnusedImport', message: 'Import "nmsl" is not accessed' }
  ];

  const merged = mergeLiveDependencyDiagnostics(snapshot, problems);
  assert.equal(merged.consistency.status, 'mismatch');
  assert.equal(merged.consistency.dependencyRuntime.status, 'unknown');
  assert.equal(merged.consistency.dependencyRuntime.detail, 'Package inventory is missing');
  assert.match(merged.consistency.lspDependencies.detail, /^2 unresolved dependency imports/);
  assert.deepEqual(merged.packages.missing.map((item) => item.name), ['numpy', 'matplotlib']);
  assert.equal(merged.actions.repair.supported, false, 'live diagnostics must not invent a repair action');
  assert.deepEqual(snapshot.packages.missing, [], 'the server snapshot remains the action/revision truth');
});

test('unresolved Python imports never overwrite exact project inventory truth', () => {
	const snapshot = {
	  language: { id: 'python' },
	  dependencyCache: { scope: 'project-lock', inventoryStatus: 'ready' },
	  packages: {
		declared: [{ name: 'numpy', source: 'requirements.txt' }],
		installed: [{ name: 'numpy', version: '2.1.0', trust: 'exact' }],
		missing: [], unknown: []
	  },
	  consistency: {
		status: 'aligned',
		dependencyRuntime: { status: 'aligned', detail: 'Exact inventory contains all declarations' },
		lspDependencies: { status: 'ready', detail: 'Dependency view is ready' }
	  }
	};
	const merged = mergeLiveDependencyDiagnostics(snapshot, [
	  { severity: 'error', code: 'reportMissingImports', message: 'Import "numpy" could not be resolved' }
	]);
	assert.deepEqual(merged.packages.missing, []);
	assert.equal(merged.consistency.dependencyRuntime.status, 'aligned');
	assert.equal(merged.consistency.lspDependencies.status, 'ready');
	assert.equal(merged.consistency.status, 'aligned');
});

test('cloud package evidence suppresses duplicate LSP fallback in both issue rows and health', () => {
  const snapshot = {
    language: { id: 'python' },
    packages: {
      declared: [
        { name: 'NumPy', constraint: '>=2', source: 'requirements.txt' },
        { name: 'matplotlib', constraint: '>=3', source: 'requirements.txt' }
      ],
      installed: [],
      missing: [],
      unknown: [
        { name: 'numpy', reason: 'Inventory verification required' },
        { name: 'MatPlotLib', reason: 'Inventory verification required' }
      ]
    },
    consistency: {
      status: 'unknown',
      dependencyRuntime: { status: 'unknown', detail: 'Inventory verification required' },
      lspDependencies: { status: 'ready', detail: 'Language service is ready.' }
    }
  };

  const merged = mergeLiveDependencyDiagnostics(snapshot, [
    { severity: 'error', code: 'reportMissingImports', message: 'Import "numpy" could not be resolved' },
    { severity: 'error', code: 'reportMissingImports', message: 'Import "matplotlib.pyplot" could not be resolved' }
  ]);

  assert.equal(merged, snapshot, 'fallback diagnostics must leave a represented cloud snapshot unchanged');
  assert.deepEqual(merged.packages.missing, []);
  assert.equal(merged.packages.unknown.length, 2);
  assert.deepEqual(merged.consistency.lspDependencies, { status: 'ready', detail: 'Language service is ready.' });
  assert.equal(merged.consistency.dependencyRuntime.status, 'unknown');
});

test('dependency issue rows deduplicate Python package spelling across server status groups', () => {
  assert.equal(packageIdentity('Example_Package', 'python'), 'example-package');
  assert.equal(packageIdentity('sklearn', 'python'), 'scikit-learn');
  assert.equal(packageIdentity('PIL', 'python'), 'pillow');
  const rows = dependencyIssueRows({
    missing: [{ name: 'Example_Package', constraint: '==1.0', reason: 'Missing from exact inventory' }],
    unknown: [
      { name: 'example.package', reason: 'Inventory verification required' },
      { name: 'numpy', reason: 'Inventory verification required' },
      { name: 'NumPy', reason: 'Duplicate fallback' }
    ]
  }, 'python');

  assert.deepEqual(rows.map((item) => [item.name, item._status]), [
    ['Example_Package', 'missing'],
    ['numpy', 'warning']
  ]);
  assert.equal(rows[0].reason, 'Missing from exact inventory', 'verified missing status keeps precedence');
});

test('Python import aliases do not bypass cloud package evidence', () => {
  const snapshot = {
    language: { id: 'python' },
    packages: {
      declared: [{ name: 'scikit-learn' }, { name: 'pillow' }],
      installed: [],
      missing: [],
      unknown: [{ name: 'scikit-learn' }, { name: 'pillow' }]
    },
    consistency: {
      status: 'unknown',
      dependencyRuntime: { status: 'unknown', detail: 'Inventory verification required' },
      lspDependencies: { status: 'ready', detail: 'Language service is ready.' }
    }
  };
  const merged = mergeLiveDependencyDiagnostics(snapshot, [
    { severity: 'error', code: 'reportMissingImports', message: 'Import "sklearn" could not be resolved' },
    { severity: 'error', code: 'reportMissingImports', message: 'Import "PIL.Image" could not be resolved' }
  ]);
  assert.equal(merged, snapshot);
  assert.deepEqual(merged.packages.missing, []);
  assert.equal(merged.consistency.lspDependencies.status, 'ready');
});

test('supplemental LSP evidence preserves authoritative dependency health detail', () => {
  const snapshot = {
    language: { id: 'python' },
    packages: {
      declared: [{ name: 'numpy' }],
      installed: [],
      missing: [{ name: 'numpy', reason: 'Missing from exact inventory' }],
      unknown: []
    },
    consistency: {
      status: 'mismatch',
      dependencyRuntime: { status: 'mismatch', detail: 'Exact inventory is missing numpy' },
      lspDependencies: { status: 'ready', detail: 'Language service is ready.' }
    }
  };
  const merged = mergeLiveDependencyDiagnostics(snapshot, [
    { severity: 'error', code: 'reportMissingImports', message: 'Import "numpy" could not be resolved' },
    { severity: 'error', code: 'reportMissingImports', message: 'Import "matplotlib" could not be resolved' }
  ]);
  assert.deepEqual(merged.packages.missing.map((item) => item.name), ['numpy', 'matplotlib']);
  assert.deepEqual(merged.consistency.dependencyRuntime, snapshot.consistency.dependencyRuntime);
  assert.equal(merged.consistency.lspDependencies.status, 'mixed');
  assert.match(merged.consistency.lspDependencies.detail, /^1 unresolved dependency import/);
});

test('supplemental LSP evidence changes overall health without downgrading healthy dependency truth', () => {
  const snapshot = {
    language: { id: 'python' },
    packages: {
      declared: [{ name: 'numpy' }],
      installed: [{ name: 'numpy', version: '2.2.6', trust: 'runtime-scoped' }],
      missing: [],
      unknown: []
    },
    consistency: {
      status: 'aligned',
      dependencyRuntime: { status: 'ready', detail: 'Runtime dependencies match' },
      lspDependencies: { status: 'ready', detail: 'Dependency view is current' }
    }
  };
  const merged = mergeLiveDependencyDiagnostics(snapshot, [
    { severity: 'error', code: 'reportMissingImports', message: 'Import "numpy" could not be resolved' },
    { severity: 'error', code: 'reportMissingImports', message: 'Import "matplotlib.pyplot" could not be resolved' }
  ]);

  assert.equal(merged.consistency.status, 'mismatch');
  assert.deepEqual(merged.consistency.dependencyRuntime, snapshot.consistency.dependencyRuntime);
  assert.equal(merged.consistency.lspDependencies.status, 'mixed');
  assert.match(merged.consistency.lspDependencies.detail, /^1 unresolved dependency import/);
  assert.deepEqual(merged.packages.missing.map((item) => item.name), ['matplotlib']);
});

test('non-English environment details use localized structured fallbacks', () => {
  const originalI18n = globalThis.BOBO.i18n;
  const translations = {
    'Installed library state still needs verification.': '已安装库状态仍需验证。',
    'Missing from the verified project environment.': '已验证项目环境中缺少此库。'
  };
  globalThis.BOBO.i18n = {
    getActive: () => 'zh-CN',
    t: (key) => translations[key] || key
  };
  try {
    assert.equal(localizedDynamicText('Installed state is not trustworthy for runtime python:3.10', '已安装库状态仍需验证。'), '已安装库状态仍需验证。');
    assert.equal(localizedDynamicText('已检测到 1 个缺失导入', '回退'), '已检测到 1 个缺失导入');
    assert.equal(healthFallbackDetail('dependencies', 'warning', ''), '已安装库状态仍需验证。');
    assert.equal(localizedDependencyReason({ _status: 'warning', reason: 'Installed state is not trustworthy' }), '已安装库状态仍需验证。');
    assert.equal(localizedDependencyReason({ _status: 'missing', reason: 'Missing from exact inventory' }), '已验证项目环境中缺少此库。');
  } finally {
    globalThis.BOBO.i18n = originalI18n;
  }
});

test('Python import diagnostics require a real unresolved-import signal', () => {
  assert.equal(unresolvedPythonImport({ severity: 'error', message: 'Import "matplotlib.pyplot" could not be resolved' }), 'matplotlib');
  assert.equal(unresolvedPythonImport({ severity: 'warning', code: 'reportUnusedImport', message: 'Import "numpy" is not accessed' }), '');
  assert.equal(unresolvedPythonImport({ severity: 'info', code: 'reportMissingImports', message: 'Import "numpy" could not be resolved' }), '');
  assert.equal(unresolvedPythonImport({ severity: 'error', code: 'reportMissingImports', message: 'Import ".local" could not be resolved' }), '');
});
