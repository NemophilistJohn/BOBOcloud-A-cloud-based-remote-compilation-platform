'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildRenderer } = require('../scripts/build-renderer');
const beforePack = require('../scripts/before-pack');

const ROOT = path.resolve(__dirname, '..');
const MAIN_DIRECTORY = path.join(ROOT, 'main');
const RENDERER_OUTPUT = path.join(ROOT, 'renderer-dist');

const EXPECTED_IPC = new Map([
  ['workspace-leave-response', 'on'],
  ['workspace-leave-choice', 'handle'],
  ['workspace-identity', 'handle'],
  ['workspace-switch-applied', 'handle'],
  ['workspace-switch-reject', 'handle'],
  ['artifact-run-context', 'handle'],
  ['pick-workspace', 'handle'],
  ['write-team-mapping', 'handle'],
  ['close-workspace', 'handle'],
  ['read-file', 'handle'],
  ['read-files', 'handle'],
  ['save-file', 'handle'],
  ['save-binary-file', 'handle'],
  ['save-artifact', 'handle'],
  ['read-tree', 'handle'],
  ['refresh-workspace', 'handle'],
  ['create-file', 'handle'],
  ['create-folder', 'handle'],
  ['rename-entry', 'handle'],
  ['delete-entry', 'handle'],
  ['calculate-dir-size', 'handle'],
  ['read-project-names', 'handle'],
  ['save-project-name', 'handle'],
  ['read-server-settings', 'handle'],
  ['write-server-settings', 'handle'],
  ['auth-get', 'handle'],
  ['auth-set', 'handle'],
  ['auth-clear', 'handle'],
  ['auth-state-update', 'on'],
  ['lsp:settings-read', 'handle'],
  ['lsp:settings-write', 'handle'],
  ['lsp:client-cache-get', 'handle'],
  ['lsp:client-cache-put', 'handle'],
  ['lsp:client-cache-stats', 'handle'],
  ['lsp:client-cache-clear', 'handle'],
  ['lsp:client-cache-prune', 'handle'],
  ['lsp:client-cache-dependency-index-get', 'handle'],
  ['lsp:client-cache-dependency-index-put', 'handle'],
  ['lsp:client-cache-dependency-index-clear', 'handle'],
  ['lsp:configure', 'handle'],
  ['lsp:request', 'handle'],
  ['lsp:notify', 'handle'],
  ['lsp:cancel', 'handle'],
  ['lsp:control', 'handle'],
  ['lsp:status', 'handle'],
  ['rclone:sync', 'handle'],
  ['rclone:pull', 'handle'],
  ['pick-local-mapping', 'handle'],
  ['local-path-info', 'handle'],
  ['rclone:check-version', 'handle'],
  ['rclone:find-path', 'handle'],
  ['ai-chat-request', 'handle'],
  ['ai-cancel-stream', 'handle'],
  ['ai-inline-cancel', 'handle'],
  ['ai-inline-request', 'handle'],
  ['ai-read-settings', 'handle'],
  ['ai-write-settings', 'handle'],
  ['ai-test-connection', 'handle'],
  ['chat-history-read', 'handle'],
  ['chat-history-write', 'handle'],
  ['diagnostics-read', 'handle'],
  ['diagnostics-write', 'handle'],
  ['language-packs:startup', 'handle'],
  ['language-packs:list', 'handle'],
  ['language-packs:load', 'handle'],
  ['language-packs:set-active', 'handle'],
  ['language-packs:install-directory', 'handle'],
  ['language-packs:remove', 'handle'],
  ['language-packs:open-folder', 'handle'],
  ['language-packs:refresh', 'handle'],
  ['tasks:list', 'handle'],
  ['tasks:resolve', 'handle'],
  ['dap:configurations', 'handle'],
  ['dap:resolve', 'handle'],
  ['dap:ensure-configuration', 'handle'],
  ['dap:start', 'handle'],
  ['dap:request', 'handle'],
  ['dap:respond', 'handle'],
  ['dap:stop', 'handle'],
  ['dap:status', 'handle']
]);

const LEGACY_RENDERER_MODULES = [
  'theme-manager.js',
  'editor-rules/completion-engine.js',
  'completion-rules.js',
  'editor-rules/symbol-extractor.js',
  'editor-rules/diagnostics/c-family-checker.js',
  'editor-rules/plugins/python.js',
  'editor-rules/plugins/c.js',
  'editor-rules/plugins/cpp.js',
  'editor-rules/plugins/java.js',
  'editor-rules/plugins/go.js',
  'editor-rules/plugins/rust.js',
  'src/state.js',
  'src/i18n.js',
  'src/icons.js',
  'src/confirm-dialog.js',
  'src/toast.js',
  'src/command-palette.js',
  'src/workbench-layout.js',
  'src/file-search.js',
  'src/settings.js',
  'src/language-packs-panel.js',
  'src/utils.js',
  'src/server-comm.js',
  'src/lsp-client.js',
  'src/output-panel.js',
  'src/terminal.js',
  'src/runtime.js',
  'src/file-icons.js',
  'src/editor-core.js',
  'src/workspace.js',
  'src/rclone-client.js',
  'src/run-config.js',
  'src/runner.js',
  'src/dap-client.js',
  'renderer/compat/dap-adapter.js',
  'src/environment-activity.js',
  'src/environment-center.js',
  'src/views.js',
  'src/diagnostics-settings.js',
  'src/auth.js',
  'src/projects.js',
  'src/collaboration.js',
  'src/account-profile.js',
  'src/ai-settings-schema.js',
  'src/ai-capabilities.js',
  'src/ai-prompts.js',
  'src/ai-service.js',
  'src/ai-context.js',
  'src/ai-settings-center.js',
  'src/ai-agent-button.js',
  'node_modules/temml/dist/temml.mjs',
  'src/ai-markdown.js',
  'src/ai-chat-panel.js',
  'src/ai-inline.js',
  'src/app.js'
];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function mainRegistrations() {
  const registrations = [];
  for (const name of fs.readdirSync(MAIN_DIRECTORY).filter((entry) => entry.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(MAIN_DIRECTORY, name), 'utf8');
    for (const match of source.matchAll(/\bipcMain\.(handle|on)\(\s*['"]([^'"]+)['"]/g)) {
      registrations.push({ file: name, method: match[1], channel: match[2] });
    }
  }
  return registrations;
}

test('main.js is a composition root and IPC ownership is complete and unique', () => {
  const composition = read('main.js');
  assert.ok(composition.split(/\r?\n/).length <= 180, 'main.js should remain a small composition root');
  assert.doesNotMatch(composition, /\bipcMain\.(?:handle|on)\(/);

  for (const moduleName of [
    'settings-store', 'window-state', 'workspace', 'ai', 'lsp', 'dap', 'auth',
    'diagnostics', 'rclone-ipc', 'language-packs', 'menu'
  ]) {
    assert.match(composition, new RegExp("require\\('./main/" + moduleName.replace('-', '\\-') + "'\\)"), moduleName + ' is composed');
  }

  const registrations = mainRegistrations();
  assert.equal(registrations.length, EXPECTED_IPC.size, 'IPC registration count changed');
  const actual = new Map();
  for (const registration of registrations) {
    assert.equal(actual.has(registration.channel), false, 'duplicate IPC channel: ' + registration.channel);
    actual.set(registration.channel, registration.method);
  }
  assert.deepEqual([...actual.entries()].sort(), [...EXPECTED_IPC.entries()].sort());
});

test('HTML has at most two startup scripts and the renderer build covers every former module', () => {
  const html = read('index.html');
  const scriptSources = Array.from(html.matchAll(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g), (match) => match[1]);
  assert.deepEqual(scriptSources, [
    './node_modules/monaco-editor/min/vs/loader.js',
    './renderer-dist/bobo-renderer.js'
  ]);

  const metadata = JSON.parse(read('renderer-dist/bobo-renderer.meta.json'));
  const inputs = new Set(Object.keys(metadata.inputs).map((entry) => entry.replace(/\\/g, '/')));
  for (const moduleName of LEGACY_RENDERER_MODULES) {
    assert.ok(inputs.has(moduleName), 'renderer build omitted ' + moduleName);
  }

  const manifest = JSON.parse(read('renderer-dist/bobo-renderer.manifest.json'));
  assert.equal(manifest.entries.core.orderedModules.at(-1), '../src/app.js');
  assert.equal(manifest.entries.aiUi.load, 'first-visible-ai-ui');
  assert.deepEqual(manifest.entries.aiUi.outputs, ['bobo-ai-ui.js', 'bobo-ai-ui.js.map']);
  assert.equal(manifest.entries.core.orderedModules.includes('../src/ai-chat-panel.js'), false);
  assert.ok(manifest.entries.aiUi.orderedModules.includes('../src/ai-chat-panel.js'));
});

test('checked renderer bundles are fresh for their recorded build mode', async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-renderer-freshness-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const manifest = JSON.parse(read('renderer-dist/bobo-renderer.manifest.json'));
  await buildRenderer({ mode: manifest.mode, outputDirectory: temporaryDirectory, logLevel: 'silent' });

  for (const fileName of ['bobo-renderer.js', 'bobo-ai-ui.js']) {
    assert.deepEqual(
      fs.readFileSync(path.join(temporaryDirectory, fileName)),
      fs.readFileSync(path.join(RENDERER_OUTPUT, fileName)),
      fileName + ' is stale; rebuild the renderer'
    );
  }
});

test('release packaging always rebuilds a production renderer and packages only generated renderer code', async () => {
  const calls = [];
  await beforePack(
    { electronPlatformName: 'win32', arch: 'x64' },
    {
      buildRenderer: async (options) => calls.push('renderer:' + options.mode),
      prepareRclone: async () => calls.push('rclone')
    }
  );
  assert.deepEqual(calls, ['renderer:production']);

  const packageJson = JSON.parse(read('package.json'));
  assert.ok(packageJson.build.files.includes('renderer-dist/'));
  assert.ok(packageJson.build.files.includes('main/'));
  assert.equal(packageJson.build.files.includes('src/'), false);
  assert.equal(packageJson.scripts['pretest:ui'], 'npm run build:renderer:dev');
});
