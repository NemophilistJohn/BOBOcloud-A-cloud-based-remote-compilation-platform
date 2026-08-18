'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalLanguage,
  recognizeManifests,
  languageMatchesRuntime,
  normalizeHealth,
  mergeServerSnapshot
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
