'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { directBridgeAccessCount } = require('./support/renderer-bridge-access');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = [path.join(ROOT, 'renderer'), path.join(ROOT, 'src')];
const NATIVE_HOST_ADAPTER = 'renderer/core/native-host-adapter.ts';
const LEGACY_DIRECT_ACCESS_LIMITS = new Map([
  ['renderer/core/plugin-extension-bootstrap.js', 2],
  ['src/agent-workbench.js', 7],
  ['src/ai-agent-button.js', 3],
  ['src/ai-chat-panel.js', 7],
  ['src/ai-service.js', 16],
  ['src/app.js', 23],
  ['src/auth.js', 16],
  ['src/collaboration.js', 6],
  ['src/dap-client.js', 27],
  ['src/environment-center.js', 6],
  ['src/i18n.js', 22],
  ['src/lsp-client.js', 56],
  ['src/package-center.js', 1],
  ['src/plugin-details.js', 6],
  ['src/plugin-manager-ui.js', 5],
  ['src/projects.js', 5],
  ['src/runner.js', 13],
  ['src/terminal.js', 30],
  ['src/views.js', 2],
  ['src/workspace-launch.js', 9],
  ['src/workspace-settings.js', 6],
  ['src/workspace.js', 28]
]);
const MIGRATED_DIAGNOSTICS_MODULES = Object.freeze([
  'renderer/compat/diagnostics-settings-adapter.ts',
  'src/diagnostics-settings.ts',
  'src/editor-core.js',
  'src/settings.js'
]);
const MIGRATED_PROJECT_TASKS_MODULES = Object.freeze([
  'renderer/compat/project-tasks-adapter.ts',
  'src/project-tasks.ts'
]);
const MIGRATED_DOCUMENT_VIEW_MODULES = Object.freeze([
  'renderer/core/document-view.ts',
  'renderer/core/document-view-sandbox.ts',
  'renderer/compat/document-views-adapter.ts',
  'src/document-views.ts'
]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:js|ts)$/.test(entry.name) ? [target] : [];
  });
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function syntaxNameCount(file, source, name) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );
  let count = 0;
  function visit(node) {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

test('renderer bridge detector catches global aliases and destructuring forms', () => {
  const probes = [
    ['window.api', 1],
    ["globalThis['api']", 1],
    ['self.api', 1],
    ['globalThis.window.api', 1],
    ['const root = globalThis.window; root.api', 1],
    ['const { api } = globalThis', 1],
    ["const { ['api']: bridge } = globalThis", 1],
    ['({ api } = globalThis)', 1],
    ["({ ['api']: bridge } = self)", 1],
    ['const { window: root } = globalThis; root.api', 1],
    ['const value = object.api; const { api } = config', 0]
  ];
  for (const [source, expected] of probes) {
    assert.equal(directBridgeAccessCount('probe.js', source), expected, source);
  }
});

test('renderer bridge access is confined to the adapter and bounded legacy callers', () => {
  const actual = new Map();
  const taskResolveOwners = new Map();
  for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
    const source = fs.readFileSync(file, 'utf8');
    const count = directBridgeAccessCount(file, source);
    if (count) actual.set(relative(file), count);
    const taskResolveCount = syntaxNameCount(file, source, 'tasksResolve');
    if (taskResolveCount) taskResolveOwners.set(relative(file), taskResolveCount);
  }

  assert.equal(actual.get(NATIVE_HOST_ADAPTER), 1,
    'the native host adapter must be the only new renderer bridge entrypoint');
  actual.delete(NATIVE_HOST_ADAPTER);

  for (const [file, count] of actual) {
    assert.equal(file.endsWith('.ts'), false, `TypeScript module bypasses the native host adapter: ${file}`);
    assert.equal(LEGACY_DIRECT_ACCESS_LIMITS.has(file), true, `new direct native host access: ${file}`);
    assert.ok(count <= LEGACY_DIRECT_ACCESS_LIMITS.get(file),
      `direct native host access increased in ${file}: ${count}`);
  }

  for (const [file, limit] of LEGACY_DIRECT_ACCESS_LIMITS) {
    const count = actual.get(file) || 0;
    assert.ok(count <= limit, `direct native host access increased in ${file}: ${count}`);
  }

  assert.equal(actual.has('src/rclone-client.js'), false,
    'the migrated rclone slice must not regain a direct preload dependency');
  for (const file of MIGRATED_DIAGNOSTICS_MODULES) {
    assert.equal(actual.has(file), false,
      `the migrated diagnostics slice must not regain a direct preload dependency: ${file}`);
  }
  for (const file of MIGRATED_PROJECT_TASKS_MODULES) {
    assert.equal(actual.has(file), false,
      `the migrated project tasks slice must not regain a direct preload dependency: ${file}`);
  }
  for (const file of MIGRATED_DOCUMENT_VIEW_MODULES) {
    assert.equal(actual.has(file), false,
      `the migrated document views slice must not regain a direct preload dependency: ${file}`);
  }

  assert.deepEqual(Array.from(taskResolveOwners), [[NATIVE_HOST_ADAPTER, 1]],
    'tasksResolve must remain a unique native-adapter bridge capability');

  const runnerSource = fs.readFileSync(path.join(ROOT, 'src/runner.js'), 'utf8');
  assert.doesNotMatch(runnerSource, /\b(?:window|global|globalThis|self)\.api\.tasksResolve\b/);
  assert.match(runnerSource, /\bBOBO\.projectTasks\.resolveTask\s*\(/);
});

test('native host services remain private to the workbench', () => {
  const adapter = fs.readFileSync(path.join(ROOT, NATIVE_HOST_ADAPTER), 'utf8');
  const diagnosticsAdapter = fs.readFileSync(
    path.join(ROOT, 'renderer/compat/diagnostics-settings-adapter.ts'),
    'utf8'
  );
  const documentViewsAdapter = fs.readFileSync(
    path.join(ROOT, 'renderer/compat/document-views-adapter.ts'),
    'utf8'
  );
  assert.match(adapter, /DIAGNOSTICS_HOST_SERVICE_ID\s*=\s*['"]host\.diagnostics['"]/);
  assert.match(adapter, /PROJECT_TASKS_HOST_SERVICE_ID\s*=\s*['"]host\.projectTasks['"]/);
  assert.match(adapter, /RCLONE_HOST_SERVICE_ID\s*=\s*['"]host\.rclone['"]/);
  assert.match(adapter, /DOCUMENT_VIEWS_HOST_SERVICE_ID\s*=\s*['"]host\.documentViews['"]/);
  assert.equal((adapter.match(/exposeToPlugins:\s*false/g) || []).length, 4);
  assert.doesNotMatch(adapter, /pluginView\s*:/);
  assert.match(diagnosticsAdapter,
    /DIAGNOSTICS_SETTINGS_SERVICE_ID\s*=\s*['"]workbench\.diagnosticsSettings['"]/);
  assert.match(diagnosticsAdapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(diagnosticsAdapter, /pluginView\s*:/);
  assert.match(documentViewsAdapter,
    /DOCUMENT_VIEWS_SERVICE_ID\s*=\s*['"]workbench\.documentViews['"]/);
  assert.match(documentViewsAdapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(documentViewsAdapter, /pluginView\s*:/);
});
