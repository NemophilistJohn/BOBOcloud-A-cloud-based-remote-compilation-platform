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
  'renderer/core/native-host-adapter.ts',
  'renderer/core/service-registry.ts',
  'renderer/core/command-registry.ts',
  'renderer/core/contribution-registry.ts',
  'renderer/core/file-decoration.ts',
  'renderer/core/source-control.ts',
  'renderer/core/scm-file-decoration.ts',
  'renderer/core/scm-git.ts',
  'renderer/core/document-view.ts',
  'renderer/core/document-view-sandbox.ts',
  'renderer/core/agent.ts',
  'renderer/core/plugin-runtime.ts',
  'renderer/core/plugin-extension-protocol.ts',
  'renderer/core/plugin-extension-sandbox.ts',
  'renderer/core/plugin-extension-host.ts',
  'renderer/core/plugin-extension-bootstrap.ts',
  'renderer/compat/platform-adapter.ts',
  'renderer/compat/file-decoration-adapter.ts',
  'src/theme-manager.ts',
  'renderer/compat/theme-manager-adapter.ts',
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
  'src/state.ts',
  'renderer/compat/state-adapter.ts',
  'src/i18n.ts',
  'renderer/compat/i18n-adapter.ts',
  'src/diagnostics-settings.ts',
  'renderer/compat/diagnostics-settings-adapter.ts',
  'src/workspace-launch.ts',
  'renderer/compat/workspace-launch-adapter.ts',
  'src/icons.ts',
  'renderer/compat/icons-adapter.ts',
  'src/tab-order.ts',
  'renderer/compat/tab-order-adapter.ts',
  'src/confirm-dialog.ts',
  'renderer/compat/confirm-dialog-adapter.ts',
  'src/toast.ts',
  'renderer/compat/toast-adapter.ts',
  'src/command-palette.ts',
  'renderer/compat/command-palette-adapter.ts',
  'src/workbench-layout.ts',
  'renderer/compat/workbench-layout-adapter.ts',
  'src/source-control-view.ts',
  'renderer/compat/source-control-view-adapter.ts',
  'src/file-search.ts',
  'renderer/compat/file-search-adapter.ts',
  'src/settings.ts',
  'renderer/compat/settings-adapter.ts',
  'src/plugin-manager-ui.ts',
  'renderer/compat/plugin-manager-ui-adapter.ts',
  'src/language-packs-panel.ts',
  'renderer/compat/language-packs-panel-adapter.ts',
  'src/utils.ts',
  'renderer/compat/utils-adapter.ts',
  'src/server-transport.ts',
  'renderer/compat/server-transport-adapter.ts',
  'src/server-comm.ts',
  'renderer/compat/server-comm-adapter.ts',
  'src/run-output.ts',
  'renderer/compat/run-output-adapter.ts',
  'src/server-capabilities.ts',
  'renderer/compat/server-capabilities-adapter.ts',
  'src/cloud-feature-policy.ts',
  'renderer/compat/cloud-feature-policy-adapter.ts',
  'src/lsp-client.js',
  'src/output-panel.ts',
  'renderer/compat/output-panel-adapter.ts',
  'src/terminal.js',
  'src/runtime.ts',
  'renderer/compat/runtime-adapter.ts',
  'src/file-icons.ts',
  'src/workspace-sync-status.ts',
  'renderer/compat/workspace-sync-status-adapter.ts',
  'src/workspace-settings.ts',
  'renderer/compat/workspace-settings-adapter.ts',
  'src/editor-core.ts',
  'renderer/compat/editor-core-adapter.ts',
  'src/document-views.ts',
  'renderer/compat/document-views-adapter.ts',
  'src/workspace.js',
  'src/agent-workbench.js',
  'src/plugin-details.ts',
  'renderer/compat/plugin-details-adapter.ts',
  'src/rclone-client.ts',
  'renderer/compat/rclone-client-adapter.ts',
  'src/rclone-settings.ts',
  'renderer/compat/rclone-settings-adapter.ts',
  'src/run-config.ts',
  'renderer/compat/run-config-adapter.ts',
  'src/task-problem-matcher.ts',
  'renderer/compat/task-problem-matcher-adapter.ts',
  'src/runner.js',
  'src/project-tasks.ts',
  'renderer/compat/project-tasks-adapter.ts',
  'src/dap-client.js',
  'renderer/compat/dap-adapter.js',
  'src/environment-activity.ts',
  'renderer/compat/environment-activity-adapter.ts',
  'src/cache-model.ts',
  'renderer/compat/cache-model-adapter.ts',
  'src/cache-store.ts',
  'renderer/compat/cache-store-adapter.ts',
  'src/cache-center.ts',
  'renderer/compat/cache-center-adapter.ts',
  'src/environment-center-model.ts',
  'src/environment-center.ts',
  'renderer/compat/environment-center-adapter.ts',
  'src/package-center.js',
  'src/views.ts',
  'renderer/compat/views-adapter.ts',
  'src/auth.js',
  'src/projects.ts',
  'renderer/compat/projects-adapter.ts',
  'src/collaboration.js',
  'src/account-profile.ts',
  'renderer/compat/account-profile-adapter.ts',
  'src/ai-settings-schema.js',
  'src/ai-prompts.ts',
  'renderer/compat/ai-prompts-adapter.ts',
  'src/ai-service.ts',
  'renderer/compat/ai-service-adapter.ts',
  'src/ai-context.ts',
  'renderer/compat/ai-context-adapter.ts',
  'src/ai-settings-center.ts',
  'renderer/compat/ai-settings-center-adapter.ts',
  'src/ai-agent-button.ts',
  'renderer/compat/ai-agent-button-adapter.ts',
  'src/stream-render-scheduler.ts',
  'renderer/compat/stream-render-scheduler-adapter.ts',
  'node_modules/temml/dist/temml.mjs',
  'src/ai-markdown.ts',
  'renderer/compat/ai-markdown-adapter.ts',
  'src/ai-chat-panel.ts',
  'renderer/compat/ai-chat-panel-adapter.ts',
  'src/ai-inline.ts',
  'renderer/compat/ai-inline-adapter.ts',
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
  assert.equal(
    fs.existsSync(path.join(ROOT, 'renderer', 'core', 'index.ts')),
    true,
    'the typed renderer core barrel must remain available'
  );
  for (const legacyModule of [
    'disposable.js',
    'platform.js',
    'bootstrap.js',
    'native-host-adapter.js',
    'file-decoration.js',
    'source-control.js',
    'scm-file-decoration.js',
    'scm-git.js',
    'document-view.js',
    'document-view-sandbox.js',
    'agent.js',
    'plugin-runtime.js',
    'plugin-extension-protocol.js',
    'plugin-extension-sandbox.js',
    'plugin-extension-host.js',
    'plugin-extension-bootstrap.js',
    'index.js',
    'typed-platform.ts'
  ]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'renderer', 'core', legacyModule)),
      false,
      'legacy renderer core module must not coexist with the typed platform: ' + legacyModule
    );
  }
  for (const legacyModule of [
    'renderer/compat/platform-adapter.js',
    'theme-manager.js',
    'src/theme-manager.js',
    'renderer/compat/theme-manager-adapter.js',
    'src/file-icons.js',
    'renderer/compat/file-icons-adapter.js',
    'renderer/compat/file-decoration-adapter.js',
    'src/source-control-view.js',
    'renderer/compat/source-control-view-adapter.js',
    'src/file-search.js',
    'renderer/compat/file-search-adapter.js',
    'src/settings.js',
    'renderer/compat/settings-adapter.js',
    'src/account-profile.js',
    'renderer/compat/account-profile-adapter.js',
    'src/editor-core.js',
    'renderer/compat/editor-core-adapter.js',
    'src/document-views.js',
    'renderer/compat/document-views-adapter.js',
    'src/i18n.js',
    'renderer/compat/i18n-adapter.js',
    'src/command-palette.js',
    'renderer/compat/command-palette-adapter.js',
    'src/confirm-dialog.js',
    'renderer/compat/confirm-dialog-adapter.js',
    'src/utils.js',
    'renderer/compat/utils-adapter.js',
    'src/server-comm.js',
    'renderer/compat/server-comm-adapter.js',
    'src/cache-model.js',
    'renderer/compat/cache-model-adapter.js',
    'src/cache-store.js',
    'renderer/compat/cache-store-adapter.js',
    'src/cache-center.js',
    'renderer/compat/cache-center-adapter.js',
    'src/environment-activity.js',
    'renderer/compat/environment-activity-adapter.js',
    'src/environment-center.js',
    'renderer/compat/environment-center-adapter.js',
    'src/views.js',
    'renderer/compat/views-adapter.js',
    'src/plugin-manager-ui.js',
    'renderer/compat/plugin-manager-ui-adapter.js',
    'src/language-packs-panel.js',
    'renderer/compat/language-packs-panel-adapter.js',
    'src/plugin-details.js',
    'renderer/compat/plugin-details-adapter.js',
    'src/rclone-client.js',
    'renderer/compat/rclone-client-adapter.js',
    'src/rclone-settings.js',
    'renderer/compat/rclone-settings-adapter.js',
    'src/run-config.js',
    'renderer/compat/run-config-adapter.js',
    'src/projects.js',
    'renderer/compat/projects-adapter.js',
    'src/runtime.js',
    'renderer/compat/runtime-adapter.js',
    'src/run-output.js',
    'renderer/compat/run-output-adapter.js',
    'src/stream-render-scheduler.js',
    'renderer/compat/stream-render-scheduler-adapter.js',
    'src/ai-prompts.js',
    'renderer/compat/ai-prompts-adapter.js',
    'src/ai-service.js',
    'renderer/compat/ai-service-adapter.js',
    'src/ai-context.js',
    'renderer/compat/ai-context-adapter.js',
    'src/ai-settings-center.js',
    'renderer/compat/ai-settings-center-adapter.js',
    'src/ai-chat-panel.js',
    'renderer/compat/ai-chat-panel-adapter.js',
    'src/ai-agent-button.js',
    'renderer/compat/ai-agent-button-adapter.js',
    'src/ai-inline.js',
    'renderer/compat/ai-inline-adapter.js',
    'src/ai-markdown.js',
    'renderer/compat/ai-markdown-adapter.js',
    'src/output-panel.js',
    'renderer/compat/output-panel-adapter.js',
    'src/icons.js',
    'renderer/compat/icons-adapter.js',
    'src/tab-order.js',
    'renderer/compat/tab-order-adapter.js',
    'src/toast.js',
    'renderer/compat/toast-adapter.js',
    'src/state.js',
    'renderer/compat/state-adapter.js',
    'src/task-problem-matcher.js',
    'renderer/compat/task-problem-matcher-adapter.js',
    'src/workspace-sync-status.js',
    'renderer/compat/workspace-sync-status-adapter.js',
    'src/workspace-settings.js',
    'renderer/compat/workspace-settings-adapter.js',
    'src/workspace-launch.js',
    'renderer/compat/workspace-launch-adapter.js',
    'src/workbench-layout.js',
    'renderer/compat/workbench-layout-adapter.js'
  ]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, legacyModule)),
      false,
      'legacy renderer module must not coexist with the TypeScript implementation: ' + legacyModule
    );
  }

  const documentViewsAdapter = read('renderer/compat/document-views-adapter.ts');
  assert.match(documentViewsAdapter, /services\.require\(THEME_SERVICE_ID\)/);
  assert.doesNotMatch(documentViewsAdapter, /themeManager/);
  const editorCoreSource = read('src/editor-core.ts');
  const editorCoreAdapter = read('renderer/compat/editor-core-adapter.ts');
  assert.match(editorCoreSource, /EDITOR_CORE_SERVICE_ID\s*=\s*['"]workbench\.editorCore['"]/);
  assert.match(editorCoreAdapter, /EDITOR_CORE_SERVICE_ID/);
  assert.match(editorCoreAdapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(editorCoreAdapter, /pluginView\s*:/);
  assert.match(editorCoreAdapter,
    /BOBO\.editorCore\s*=\s*\{\s*init:\s*editorCore\.init,[\s\S]*checkActiveOnSave:\s*editorCore\.checkActiveOnSave\s*\}/);

  const serverCommSource = read('src/server-comm.ts');
  const serverCommAdapter = read('renderer/compat/server-comm-adapter.ts');
  assert.match(serverCommSource,
    /SERVER_COMM_SERVICE_ID\s*=\s*['"]workbench\.serverComm['"]/);
  assert.match(serverCommSource, /createServerCommService\s*\(/);
  assert.match(serverCommAdapter, /SERVER_COMM_SERVICE_ID/);
  assert.match(serverCommAdapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(serverCommAdapter, /pluginView\s*:/);
  assert.match(serverCommAdapter,
    /BOBO\.updateRunOutput\s*=\s*serverComm\.updateRunOutput/);
  assert.match(serverCommAdapter,
    /BOBO\.sendToServer\s*=\s*serverComm\.sendToServer/);

  const aiContextSource = read('src/ai-context.ts');
  const aiContextAdapter = read('renderer/compat/ai-context-adapter.ts');
  assert.match(aiContextSource,
    /AI_CONTEXT_SERVICE_ID\s*=\s*['"]workbench\.aiContext['"]/);
  assert.match(aiContextSource, /createAiContextService\s*\(/);
  assert.match(aiContextAdapter, /AI_CONTEXT_SERVICE_ID/);
  assert.match(aiContextAdapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(aiContextAdapter, /pluginView\s*:/);
  assert.match(aiContextAdapter,
    /BOBO\.aiContext\s*=\s*\{\s*getCurrentFileContext:\s*aiContext\.getCurrentFileContext,[\s\S]*getInlineContext:\s*aiContext\.getInlineContext\s*\}/);

  const aiServiceSource = read('src/ai-service.ts');
  const aiServiceAdapter = read('renderer/compat/ai-service-adapter.ts');
  assert.match(aiServiceSource,
    /AI_SERVICE_ID\s*=\s*['"]workbench\.aiService['"]/);
  assert.match(aiServiceSource, /createAiService\s*\(/);
  assert.match(aiServiceAdapter, /AI_SERVICE_ID/);
  assert.match(aiServiceAdapter, /services\.require\(['"]host\.ai['"]\)/);
  assert.match(aiServiceAdapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(aiServiceAdapter, /pluginView\s*:/);
  assert.match(aiServiceAdapter,
    /BOBO\.aiService\s*=\s*\{[\s\S]*init:\s*aiService\.init,[\s\S]*fingerprint:\s*aiService\.fingerprint/);

  const aiInlineSource = read('src/ai-inline.ts');
  const aiInlineAdapter = read('renderer/compat/ai-inline-adapter.ts');
  assert.match(aiInlineSource,
    /AI_INLINE_SERVICE_ID\s*=\s*['"]workbench\.aiInline['"]/);
  assert.match(aiInlineSource, /createAiInlineService\s*\(/);
  assert.match(aiInlineAdapter, /AI_INLINE_SERVICE_ID/);
  assert.match(aiInlineAdapter, /services\.require\(AI_SERVICE_ID\)/);
  assert.match(aiInlineAdapter, /services\.require\(AI_CONTEXT_SERVICE_ID\)/);
  assert.match(aiInlineAdapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(aiInlineAdapter, /pluginView\s*:/);
  assert.match(aiInlineAdapter,
    /BOBO\.aiInline\s*=\s*\{[\s\S]*init:\s*aiInline\.init,[\s\S]*_createProvider:\s*aiInline\._createProvider/);

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
  assert.equal(manifest.entries.core.orderedModules.includes('../src/ai-chat-panel.ts'), false);
  assert.ok(manifest.entries.aiUi.orderedModules.includes('./compat/ai-chat-panel-adapter.ts'));
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
  const layout = read('src/workbench-layout.ts');
  const sidebar = read('src/plugin-manager-ui.ts');
  const sidebarAdapter = read('renderer/compat/plugin-manager-ui-adapter.ts');
  const details = read('src/plugin-details.ts');
  const detailsAdapter = read('renderer/compat/plugin-details-adapter.ts');

  assert.match(html, /id="activity-extensions"[^>]*data-workbench-view="extensions"/);
  assert.match(html, /id="extensions-sidebar"[^>]*data-sidebar-view="extensions"/);
  assert.match(html, /id="extensions-marketplace-view"/);
  assert.match(html, /id="extensions-installed-view"/);
  assert.doesNotMatch(html, /settings-plugins-tab|data-spane="plugins"|data-sfoot="plugins"/);
  assert.match(layout, /'extensions'/);
  assert.match(sidebar, /dependencies\.getPluginDetails\(\)/);
  assert.match(sidebar, /bobo:open-plugin-details/);
  assert.match(details, /registerWorkbenchTabProvider\('plugin-details'/);
  assert.match(sidebarAdapter, /PLUGIN_MANAGER_UI_SERVICE_ID/);
  assert.match(sidebarAdapter, /BOBO\.pluginManagerUI\s*=\s*\{\s*init:\s*pluginManagerUI\.init,\s*open:\s*pluginManagerUI\.open,\s*refresh:\s*pluginManagerUI\.refresh,\s*refreshMarketplace:\s*pluginManagerUI\.refreshMarketplace,\s*getPlugins:\s*pluginManagerUI\.getPlugins,\s*getMarketplace:\s*pluginManagerUI\.getMarketplace\s*\}/);
  assert.match(detailsAdapter, /BOBO\.pluginDetails\s*=\s*Object\.freeze\(\{\s*open:\s*pluginDetails\.open\s*\}\)/);
});
