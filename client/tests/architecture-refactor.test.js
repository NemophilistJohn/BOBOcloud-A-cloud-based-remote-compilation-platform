'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  ['workspace-settings-read', 'handle'],
  ['workspace-switch-applied', 'handle'],
  ['workspace-switch-reject', 'handle'],
  ['artifact-run-context', 'handle'],
  ['pick-workspace', 'handle'],
  ['forget-recent-workspace', 'handle'],
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
  ['rclone:prepare-remote', 'handle'],
  ['rclone:cancel', 'handle'],
  ['rclone:cancel-all', 'handle'],
  ['pick-local-mapping', 'handle'],
  ['local-path-info', 'handle'],
  ['rclone:list-binaries', 'handle'],
  ['rclone:get-selection', 'handle'],
  ['rclone:select-binary', 'handle'],
  ['rclone:check-version', 'handle'],
  ['rclone:validate-connection', 'handle'],
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
  ['plugins:list', 'handle'],
  ['plugins:get', 'handle'],
  ['plugins:install', 'handle'],
  ['plugins:enable', 'handle'],
  ['plugins:disable', 'handle'],
  ['plugins:uninstall', 'handle'],
  ['plugins:grant', 'handle'],
  ['plugins:revoke', 'handle'],
  ['plugins:runtime-descriptors', 'handle'],
  ['plugins:load-entry', 'handle'],
  ['plugins:load-localization', 'handle'],
  ['plugins:load-document-view', 'handle'],
  ['plugins:document-open', 'handle'],
  ['plugins:document-read', 'handle'],
  ['plugins:document-close', 'handle'],
  ['plugins:marketplace-list', 'handle'],
  ['plugins:marketplace-refresh', 'handle'],
  ['plugins:marketplace-install', 'handle'],
  ['plugins:rpc', 'handle'],
  ['plugins:agent-approval-describe', 'handle'],
  ['plugins:agent-approval-decide', 'handle'],
  ['plugins:agent-approval-cancel', 'handle'],
  ['plugins:agent-access-get', 'handle'],
  ['plugins:agent-access-set', 'handle'],
  ['plugins:agent-access-clear', 'handle'],
  ['plugins:open-folder', 'handle'],
  ['plugins:refresh', 'handle'],
  ['tasks:list', 'handle'],
  ['tasks:resolve', 'handle'],
  ['dap:configurations', 'handle'],
  ['dap:resolve', 'handle'],
  ['dap:ensure-configuration', 'handle'],
  ['dap:start', 'handle'],
  ['dap:request', 'handle'],
  ['dap:respond', 'handle'],
  ['dap:stop', 'handle'],
  ['dap:status', 'handle'],
  ['terminal:start', 'handle'],
  ['terminal:write', 'handle'],
  ['terminal:resize', 'handle'],
  ['terminal:package-intent-decision', 'handle'],
  ['terminal:stop', 'handle'],
  ['terminal:status', 'handle'],
  ['package-center:apply-local-changes', 'handle'],
  ['package-center:rollback-local-changes', 'handle'],
  ['package-center:commit-local-changes', 'handle'],
  ['package-center:list-pending-recoveries', 'handle'],
  ['package-center:resolve-pending-recovery', 'handle']
]);

const REQUIRED_RENDERER_INPUTS = [
  'renderer/core/disposable.ts',
  'renderer/core/platform.ts',
  'renderer/core/bootstrap.ts',
  'renderer/core/service-registry.ts',
  'renderer/core/command-registry.ts',
  'renderer/core/contribution-registry.ts',
  'renderer/core/file-decoration.ts',
  'renderer/core/source-control.ts',
  'renderer/core/scm-file-decoration.ts',
  'renderer/core/scm-git.ts',
  'renderer/core/document-view.ts',
  'renderer/core/document-view-sandbox.ts',
  'renderer/compat/file-decoration-adapter.ts',
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
  'src/diagnostics-settings.ts',
  'renderer/compat/diagnostics-settings-adapter.ts',
  'src/icons.js',
  'src/confirm-dialog.js',
  'src/toast.js',
  'src/command-palette.js',
  'src/workbench-layout.js',
  'src/source-control-view.ts',
  'renderer/compat/source-control-view-adapter.ts',
  'src/file-search.js',
  'src/settings.js',
  'src/language-packs-panel.js',
  'src/utils.js',
  'src/server-transport.ts',
  'renderer/compat/server-transport-adapter.ts',
  'src/server-comm.js',
  'src/server-capabilities.ts',
  'renderer/compat/server-capabilities-adapter.ts',
  'src/cloud-feature-policy.ts',
  'renderer/compat/cloud-feature-policy-adapter.ts',
  'src/lsp-client.js',
  'src/output-panel.js',
  'src/terminal.js',
  'src/runtime.js',
  'src/file-icons.ts',
  'src/editor-core.js',
  'src/document-views.ts',
  'renderer/compat/document-views-adapter.ts',
  'src/workspace.js',
  'src/agent-workbench.js',
  'src/plugin-details.js',
  'src/run-config.js',
  'src/runner.js',
  'src/project-tasks.ts',
  'renderer/compat/project-tasks-adapter.ts',
  'src/dap-client.js',
  'renderer/compat/dap-adapter.js',
  'src/environment-activity.js',
  'src/environment-center.js',
  'src/package-center.js',
  'src/views.js',
  'src/auth.js',
  'src/projects.js',
  'src/collaboration.js',
  'src/account-profile.js',
  'src/ai-settings-schema.js',
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
  assert.ok(composition.trimEnd().split(/\r?\n/).length <= 180, 'main.js should remain a small composition root');
  assert.doesNotMatch(composition, /\bipcMain\.(?:handle|on)\(/);

  for (const moduleName of [
    'settings-store', 'window-state', 'workspace', 'workspace-settings', 'ai', 'lsp', 'dap', 'terminal', 'auth',
      'diagnostics', 'rclone-ipc', 'rclone-binary-manager', 'rclone-service', 'local-directory-authority', 'language-packs', 'plugins', 'marketplace', 'package-center', 'menu'
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
  assert.equal(
    fs.existsSync(path.join(ROOT, 'renderer', 'core', 'service-registry.js')),
    false,
    'legacy service-registry.js must not coexist with the TypeScript implementation'
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, 'renderer', 'core', 'command-registry.js')),
    false,
    'legacy command-registry.js must not coexist with the TypeScript implementation'
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, 'renderer', 'core', 'contribution-registry.js')),
    false,
    'legacy contribution-registry.js must not coexist with the TypeScript implementation'
  );
  for (const legacyModule of [
    'disposable.js',
    'platform.js',
    'bootstrap.js',
    'file-decoration.js',
    'source-control.js',
    'scm-file-decoration.js',
    'scm-git.js',
    'document-view.js',
    'document-view-sandbox.js',
    'typed-platform.ts'
  ]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'renderer', 'core', legacyModule)),
      false,
      'legacy renderer core module must not coexist with the typed platform: ' + legacyModule
    );
  }
  for (const legacyModule of [
    'src/file-icons.js',
    'renderer/compat/file-icons-adapter.js',
    'renderer/compat/file-decoration-adapter.js',
    'src/source-control-view.js',
    'renderer/compat/source-control-view-adapter.js',
    'src/document-views.js',
    'renderer/compat/document-views-adapter.js'
  ]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, legacyModule)),
      false,
      'legacy renderer module must not coexist with the TypeScript implementation: ' + legacyModule
    );
  }

  const metadata = JSON.parse(read('renderer-dist/bobo-renderer.meta.json'));
  const inputs = new Set(
    Object.keys(metadata.inputs).map((entry) => entry
      .replace(/\\/g, '/')
      // During this transition Node can resolve installed dependencies from the
      // repository parent. The bundle still contains the same dependency.
      .replace(/^(?:\.\.\/)+node_modules\//, 'node_modules/')),
  );
  for (const moduleName of REQUIRED_RENDERER_INPUTS) {
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
  const temporaryDirectory = fs.mkdtempSync(path.join(ROOT, '.bobo-renderer-freshness-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const manifest = JSON.parse(read('renderer-dist/bobo-renderer.manifest.json'));
  await buildRenderer({ mode: manifest.mode, outputDirectory: temporaryDirectory, logLevel: 'silent' });

  for (const fileName of [
    'bobo-renderer.js', 'bobo-renderer.js.map',
    'bobo-ai-ui.js', 'bobo-ai-ui.js.map',
    'bobo-terminal-ui.js', 'bobo-terminal-ui.js.map',
    'bobo-terminal-ui.css', 'bobo-terminal-ui.css.map',
    'bobo-renderer.manifest.json'
  ]) {
    assert.equal(
      fs.readFileSync(path.join(temporaryDirectory, fileName)).equals(
        fs.readFileSync(path.join(RENDERER_OUTPUT, fileName))
      ),
      true,
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
  assert.deepEqual(calls, ['renderer:production', 'rclone']);

  const packageJson = JSON.parse(read('package.json'));
  assert.ok(packageJson.build.files.includes('renderer-dist/'));
  assert.ok(packageJson.build.files.includes('main/'));
  assert.ok(packageJson.build.files.includes('shared/'));
  assert.equal(packageJson.build.files.includes('src/'), false);
  assert.equal(packageJson.scripts['pretest:ui'], 'npm run build:renderer:dev');
});

test('extensions remain a primary workbench surface while detail pages use the tab-provider boundary', () => {
  const html = read('index.html');
  const layout = read('src/workbench-layout.js');
  const sidebar = read('src/plugin-manager-ui.js');
  const details = read('src/plugin-details.js');

  assert.match(html, /id="activity-extensions"[^>]*data-workbench-view="extensions"/);
  assert.match(html, /id="extensions-sidebar"[^>]*data-sidebar-view="extensions"/);
  assert.match(html, /id="extensions-marketplace-view"/);
  assert.match(html, /id="extensions-installed-view"/);
  assert.doesNotMatch(html, /settings-plugins-tab|data-spane="plugins"|data-sfoot="plugins"/);
  assert.match(layout, /'extensions'/);
  assert.match(sidebar, /BOBO\.pluginDetails\.open\(pluginId\)/);
  assert.match(sidebar, /bobo:open-plugin-details/);
  assert.match(details, /registerWorkbenchTabProvider\('plugin-details'/);
});
