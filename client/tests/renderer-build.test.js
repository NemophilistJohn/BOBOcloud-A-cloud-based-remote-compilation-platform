'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const packageJson = require('../package.json');
const { buildRenderer, parseMode, readOrderedImports } = require('../scripts/build-renderer');
const { inspectRendererBundleEntries } = require('../scripts/audit-release');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_MODULES = [
  './core/bootstrap.ts',
  './core/native-host-adapter.ts',
  './compat/platform-adapter.js',
  '../theme-manager.js',
  '../editor-rules/completion-engine.js',
  '../completion-rules.js',
  '../editor-rules/symbol-extractor.js',
  '../editor-rules/diagnostics/c-family-checker.js',
  '../editor-rules/plugins/python.js',
  '../editor-rules/plugins/c.js',
  '../editor-rules/plugins/cpp.js',
  '../editor-rules/plugins/java.js',
  '../editor-rules/plugins/go.js',
  '../editor-rules/plugins/rust.js',
  '../src/state.js',
  '../src/tab-order.js',
  './compat/i18n-adapter.ts',
  './compat/diagnostics-settings-adapter.ts',
  '../src/workspace-launch.js',
  '../src/icons.js',
  '../src/confirm-dialog.js',
  '../src/toast.js',
  '../src/command-palette.js',
  './core/plugin-extension-bootstrap.js',
  '../src/workbench-layout.js',
  './compat/source-control-view-adapter.ts',
  '../src/file-search.js',
  '../src/settings.js',
  '../src/plugin-manager-ui.js',
  '../src/language-packs-panel.js',
  '../src/utils.js',
  './compat/server-transport-adapter.ts',
  '../src/server-comm.js',
  '../src/run-output.js',
  './compat/server-capabilities-adapter.ts',
  './compat/cloud-feature-policy-adapter.ts',
  '../src/lsp-client.js',
  '../src/output-panel.js',
  '../src/terminal.js',
  '../src/runtime.js',
  './compat/file-icons-adapter.ts',
  '../src/workspace-sync-status.js',
  '../src/workspace-settings.js',
  '../src/editor-core.js',
  './compat/document-views-adapter.ts',
  '../src/workspace.js',
  '../src/agent-workbench.js',
  '../src/plugin-details.js',
  './compat/rclone-client-adapter.ts',
  '../src/rclone-settings.js',
  '../src/run-config.js',
  '../src/task-problem-matcher.js',
  '../src/runner.js',
  './compat/project-tasks-adapter.ts',
  '../src/dap-client.js',
  './compat/dap-adapter.js',
  '../src/environment-activity.js',
  '../src/cache-model.js',
  '../src/cache-store.js',
  '../src/cache-center.js',
  '../src/environment-center.js',
  '../src/package-center.js',
  '../src/views.js',
  '../src/auth.js',
  '../src/projects.js',
  '../src/collaboration.js',
  '../src/account-profile.js',
  '../src/ai-settings-schema.js',
  '../src/ai-prompts.js',
  '../src/ai-service.js',
  '../src/ai-context.js',
  './ai-ui-loader.js',
  '../src/ai-agent-button.js',
  '../src/ai-inline.js',
  '../src/app.js'
];
const EXPECTED_AI_UI_MODULES = [
  '../src/ai-settings-center.js',
  './temml-runtime.js',
  '../src/ai-markdown.js',
  '../src/stream-render-scheduler.js',
  '../src/ai-chat-panel.js'
];
const EXPECTED_TERMINAL_UI_MODULES = [
  '@xterm/xterm',
  '@xterm/addon-fit',
  '@xterm/xterm/css/xterm.css'
];

test('renderer entry is the single source of truth for legacy module order', () => {
  const entrySource = fs.readFileSync(path.join(ROOT, 'renderer', 'entry.js'), 'utf8');
  const modules = readOrderedImports(entrySource);
  assert.deepEqual(modules, EXPECTED_MODULES);
  assert.equal(new Set(modules).size, modules.length);
  assert.equal(modules.at(-1), '../src/app.js');

  const aiUiSource = fs.readFileSync(path.join(ROOT, 'renderer', 'ai-ui-entry.js'), 'utf8');
  assert.deepEqual(readOrderedImports(aiUiSource), EXPECTED_AI_UI_MODULES);

  const terminalUiSource = fs.readFileSync(path.join(ROOT, 'renderer', 'terminal-ui-entry.js'), 'utf8');
  assert.deepEqual(readOrderedImports(terminalUiSource), EXPECTED_TERMINAL_UI_MODULES);
});

test('Monaco AMD loading stays explicit so CommonJS dependencies remain bundleable', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const buildSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-renderer.js'), 'utf8');
  assert.match(appSource, /window\.require\.config\(loaderConfig\)/);
  assert.match(appSource, /window\.require\(\['vs\/editor\/editor\.main'\]/);
  assert.doesNotMatch(buildSource, /require\s*:\s*['"]window\.require['"]/);
});

test('index loads only Monaco AMD loader followed by the renderer bundle', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g), (match) => match[1]);
  assert.deepEqual(scripts, [
    './node_modules/monaco-editor/min/vs/loader.js',
    './renderer-dist/bobo-renderer.js'
  ]);
});

test('production renderer build is minified, source-mapped and records ordered modules', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-renderer-build-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));

  const built = await buildRenderer({ mode: 'production', outputDirectory: directory, logLevel: 'silent' });
  const bundle = await fsp.readFile(built.outputFile, 'utf8');
  const aiUiBundle = await fsp.readFile(built.aiUiOutputFile, 'utf8');
  const terminalUiBundle = await fsp.readFile(built.terminalUiOutputFile, 'utf8');
  const sourceMap = JSON.parse(await fsp.readFile(built.outputFile + '.map', 'utf8'));
  const aiUiSourceMap = JSON.parse(await fsp.readFile(built.aiUiOutputFile + '.map', 'utf8'));
  const terminalUiSourceMap = JSON.parse(await fsp.readFile(built.terminalUiOutputFile + '.map', 'utf8'));
  const terminalCssSourceMap = JSON.parse(await fsp.readFile(path.join(directory, 'bobo-terminal-ui.css.map'), 'utf8'));
  const manifest = JSON.parse(await fsp.readFile(built.manifestFile, 'utf8'));

  assert.match(bundle, /sourceMappingURL=bobo-renderer\.js\.map/);
  assert.match(bundle, /window\.BOBO/);
  const sourceBytes = EXPECTED_MODULES.reduce((total, modulePath) => (
    total + fs.statSync(path.resolve(ROOT, 'renderer', modulePath)).size
  ), 0);
  assert.ok(bundle.length < sourceBytes * 0.75);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/app.js')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/plugin-runtime.js')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/shared/plugin-semver.js')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/plugin-extension-host.js')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/plugin-extension-sandbox.js')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/plugin-extension-protocol.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/plugin-extension-protocol.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/service-registry.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/service-registry.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/command-registry.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/command-registry.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/contribution-registry.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/contribution-registry.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/file-decoration.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/file-decoration.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/file-decoration-adapter.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/file-decoration-adapter.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/source-control.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/source-control.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/scm-file-decoration.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/scm-file-decoration.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/scm-git.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/scm-git.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/disposable.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/disposable.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/platform.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/platform.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/bootstrap.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/bootstrap.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/file-icons-adapter.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/file-icons-adapter.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/file-icons.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/src/file-icons.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/server-transport.ts')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/server-capabilities.ts')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/cloud-feature-policy.ts')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/diagnostics-settings.ts')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/diagnostics-settings-adapter.ts')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/i18n.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/src/i18n.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/i18n-adapter.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/i18n-adapter.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/project-tasks.ts')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/project-tasks-adapter.ts')));
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/source-control-view.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/src/source-control-view.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/source-control-view-adapter.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/source-control-view-adapter.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/document-view.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/document-view.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/core/document-view-sandbox.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/core/document-view-sandbox.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/src/document-views.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/src/document-views.js')), false);
  assert.ok(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/document-views-adapter.ts')));
  assert.equal(sourceMap.sources.some((source) => source.endsWith('/renderer/compat/document-views-adapter.js')), false);
  assert.ok(aiUiSourceMap.sources.some((source) => source.endsWith('/src/ai-chat-panel.js')));
  assert.ok(aiUiSourceMap.sources.some((source) => source.endsWith('/node_modules/temml/dist/temml.mjs')));
  assert.ok(terminalUiSourceMap.sources.some((source) => source.endsWith('/renderer/terminal-ui-entry.js')));
  assert.ok(terminalUiSourceMap.sources.some((source) => source.includes('/node_modules/@xterm/xterm/')));
  assert.equal(sourceMap.sourcesContent, undefined);
  assert.equal(aiUiSourceMap.sourcesContent, undefined);
  assert.equal(terminalUiSourceMap.sourcesContent, undefined);
  assert.equal(terminalCssSourceMap.sourcesContent, undefined);
  assert.ok(aiUiBundle.length > 0);
  assert.ok(terminalUiBundle.length > 0);
  assert.equal(manifest.mode, 'production');
  assert.equal(manifest.compatibilityNamespace, 'window.BOBO');
  assert.deepEqual(manifest.entries.core.orderedModules, EXPECTED_MODULES);
  assert.deepEqual(manifest.entries.aiUi.orderedModules, EXPECTED_AI_UI_MODULES);
  assert.equal(manifest.entries.aiUi.load, 'first-visible-ai-ui');
  assert.deepEqual(manifest.entries.terminalUi.orderedModules, EXPECTED_TERMINAL_UI_MODULES);
  assert.equal(manifest.entries.terminalUi.load, 'first-visible-terminal');
  assert.deepEqual(manifest.entries.terminalUi.outputs, [
    'bobo-terminal-ui.js', 'bobo-terminal-ui.js.map', 'bobo-terminal-ui.css', 'bobo-terminal-ui.css.map'
  ]);
  assert.equal(manifest.entries.extensionHost.implementation, 'opaque-sandboxed-iframe-worker');
  assert.equal(manifest.entries.extensionHost.directNetwork, 'blocked-by-sandbox-csp');
});

test('package and release audit use bundle artifacts instead of raw renderer scripts', () => {
  const files = packageJson.build.files;
  assert.ok(files.includes('main/'));
  assert.ok(files.includes('shared/'));
  assert.ok(files.includes('renderer-dist/'));
  assert.ok(files.includes('src/ai-settings-schema.js'));
  assert.ok(!files.includes('src/'));
  assert.ok(!files.includes('editor-rules/'));

  assert.deepEqual(inspectRendererBundleEntries([
    '/renderer-dist/bobo-renderer.js',
    '/renderer-dist/bobo-renderer.js.map',
    '/renderer-dist/bobo-ai-ui.js',
    '/renderer-dist/bobo-ai-ui.js.map',
    '/renderer-dist/bobo-terminal-ui.js',
    '/renderer-dist/bobo-terminal-ui.js.map',
    '/renderer-dist/bobo-terminal-ui.css',
    '/renderer-dist/bobo-terminal-ui.css.map',
    '/renderer-dist/bobo-renderer.manifest.json',
    '/src/ai-settings-schema.js'
  ]), { missingEntries: [], legacyRendererEntries: [] });

  const invalid = inspectRendererBundleEntries(['/src/app.js', '/editor-rules/plugins/go.js']);
  assert.equal(invalid.missingEntries.length, 9);
  assert.deepEqual(invalid.legacyRendererEntries, ['src/app.js', 'editor-rules/plugins/go.js']);
});

test('renderer mode validation rejects accidental non-production modes', () => {
  assert.equal(parseMode(['--mode=development']), 'development');
  assert.equal(parseMode(['--mode=production']), 'production');
  assert.throws(() => parseMode(['--mode=preview']), /development or production/);
});

test('AI UI proxy stays lazy, single-flights requests, and retries a failed load', async () => {
  const appendedScripts = [];
  const visibleErrors = [];
  const fakeConsoleErrors = [];
  const context = {
    console: { error: (...args) => fakeConsoleErrors.push(args) },
    Promise,
    Error,
    document: {
      createElement: () => ({ dataset: {}, remove() { this.removed = true; } }),
      head: { appendChild: (script) => appendedScripts.push(script) }
    },
    BOBO: {
      i18n: { t: (key) => key },
      toast: { error: (message) => visibleErrors.push(message) }
    }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'renderer', 'ai-ui-loader.js'), 'utf8'), context);

  context.BOBO.aiChatPanel.init();
  assert.equal(appendedScripts.length, 0);

  const firstChatOpen = context.BOBO.aiChatPanel.setVisible(true);
  const firstSettingsOpen = context.BOBO.aiSettingsCenter.open('overview');
  assert.equal(appendedScripts.length, 1);
  appendedScripts[0].onerror();
  await Promise.all([firstChatOpen, firstSettingsOpen]);
  assert.deepEqual(visibleErrors, ['Failed to load']);
  assert.equal(fakeConsoleErrors.length, 1);

  let chatInitCount = 0;
  let settingsOpenCount = 0;
  const retry = context.BOBO.aiSettingsCenter.open('connections');
  assert.equal(appendedScripts.length, 2);
  context.BOBO.aiChatPanel = {
    init: () => { chatInitCount += 1; },
    setVisible: () => undefined
  };
  context.BOBO.aiSettingsCenter = {
    init: () => undefined,
    open: () => { settingsOpenCount += 1; }
  };
  appendedScripts[1].onload();
  await retry;

  assert.equal(context.BOBO.aiUiLoader.isLoaded(), true);
  assert.equal(chatInitCount, 1);
  assert.equal(settingsOpenCount, 1);
  await context.BOBO.aiUiLoader.ensureLoaded();
  assert.equal(appendedScripts.length, 2);
});
