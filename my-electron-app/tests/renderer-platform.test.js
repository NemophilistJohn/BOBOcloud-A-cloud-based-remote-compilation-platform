'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
let temporaryDirectory;
let core;
let fileIconsModule;
let compatibilityBundle;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function bundleModule(entry, outputName) {
  const output = path.join(temporaryDirectory, outputName + '.cjs');
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'silent'
  });
  delete require.cache[require.resolve(output)];
  return require(output);
}

test.before(async () => {
  temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-renderer-platform-'));
  core = await bundleModule('renderer/core/index.js', 'core');
  fileIconsModule = await bundleModule('src/file-icons.js', 'file-icons');
  const compatibilityBuild = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: "import { rendererPlatform } from './renderer/core/bootstrap.js'; import './renderer/compat/platform-adapter.js'; import './renderer/compat/file-icons-adapter.js'; import './src/project-tasks.js'; import './renderer/compat/project-tasks-adapter.js'; window.__tasksPluginView = rendererPlatform.services.getForPlugin('workbench.projectTasks');",
      resolveDir: ROOT,
      sourcefile: 'compatibility-test-entry.js'
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });
  compatibilityBundle = compatibilityBuild.outputFiles[0].text;
});

test.after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('disposable store tears down in reverse order and isolates cleanup errors', () => {
  const calls = [];
  const errors = [];
  const store = new core.DisposableStore({ onError: (event) => errors.push(event) });
  store.add(core.toDisposable(() => calls.push('first')));
  store.add(core.toDisposable(() => {
    calls.push('second');
    throw new Error('dispose failed');
  }));
  store.add(core.toDisposable(() => calls.push('third')));

  store.dispose();
  store.dispose();
  assert.deepEqual(calls, ['third', 'second', 'first']);
  assert.equal(errors.length, 1);

  store.add(core.toDisposable(() => calls.push('late')));
  assert.deepEqual(calls, ['third', 'second', 'first', 'late']);
});

test('service registry owns visibility, duplicate protection, and disposal', () => {
  const disposed = [];
  const services = new core.ServiceRegistry();
  services.register('private.service', { value: 1 }, { owner: 'core.private' });
  services.register('public.service', {
    value: 2,
    dispose: () => disposed.push('public')
  }, { owner: 'acme.services', exposeToPlugins: true, pluginView: Object.freeze({ value: 2 }) });

  assert.equal(services.require('private.service').value, 1);
  assert.equal(services.getForPlugin('public.service').value, 2);
  assert.notEqual(services.getForPlugin('public.service'), services.get('public.service'));
  assert.throws(() => services.getForPlugin('private.service'), /not exposed/);
  assert.throws(() => services.register('public.service', {}), /already registered/);

  services.disposeOwner('acme.services');
  assert.deepEqual(disposed, ['public']);
  assert.equal(services.has('public.service'), false);
});

test('command and contribution failures are attributed without corrupting registries', async () => {
  const errors = [];
  const commands = new core.CommandRegistry({ onError: (event) => errors.push(event) });
  commands.register('acme.ok', (value) => value * 2, { owner: 'acme.plugin' });
  commands.register('acme.fail', () => { throw new Error('command failed'); }, { owner: 'acme.plugin' });

  assert.equal(await commands.execute('acme.ok', 3), 6);
  const failedCommand = await commands.executeIsolated('acme.fail');
  assert.equal(failedCommand.ok, false);
  assert.equal(commands.has('acme.ok'), true);

  const contributions = new core.ContributionRegistry({ onError: (event) => errors.push(event) });
  contributions.register(core.ContributionPoint.FILE_DECORATIONS_SYNC, {
    id: 'acme.sync-good',
    namespace: 'acme.sync',
    lane: 'sync',
    priority: 50,
    getDecoration: (resourcePath) => ({ resourcePath })
  }, { owner: 'acme.plugin' });
  contributions.register(core.ContributionPoint.FILE_DECORATIONS_SYNC, {
    id: 'acme.sync-fail',
    namespace: 'acme.sync-fail',
    lane: 'sync',
    getDecoration: () => { throw new Error('provider failed'); }
  }, { owner: 'acme.plugin' });
  contributions.register(core.ContributionPoint.FILE_DECORATIONS_SCM, {
    id: 'acme.scm',
    namespace: 'acme.scm',
    lane: 'scm',
    getDecoration: () => ({ status: 'modified' })
  }, { owner: 'acme.plugin' });

  const collected = await contributions.collect(
    core.ContributionPoint.FILE_DECORATIONS_SYNC,
    'getDecoration',
    'src/app.js',
    { type: 'file', name: 'app.js' }
  );
  assert.deepEqual(collected.values, [{ resourcePath: 'src/app.js' }]);
  assert.equal(collected.errors.length, 1);
  assert.equal(contributions.list(core.ContributionPoint.FILE_DECORATIONS_SCM).length, 1);
  assert.equal(errors.length, 2);
});

test('contribution registry emits owned add/remove changes and isolates listener failures', () => {
  const errors = [];
  const changes = [];
  const contributions = new core.ContributionRegistry({ onError: (event) => errors.push(event) });
  contributions.onDidChange((event) => changes.push({ type: event.type, point: event.point, id: event.id, owner: event.owner }));
  contributions.onDidChange(() => { throw new Error('listener failed'); });

  const first = contributions.register(core.ContributionPoint.TASKS, {
    id: 'acme.tasks',
    provideTasks: () => []
  }, { owner: 'acme.plugin' });
  assert.deepEqual(contributions.listEntries(core.ContributionPoint.TASKS).map((entry) => entry.id), ['acme.tasks']);
  first.dispose();

  contributions.register(core.ContributionPoint.SETTINGS, { id: 'acme.settings' }, { owner: 'acme.plugin' });
  contributions.disposeOwner('acme.plugin');
  assert.deepEqual(changes, [
    { type: 'added', point: 'tasks', id: 'acme.tasks', owner: 'acme.plugin' },
    { type: 'removed', point: 'tasks', id: 'acme.tasks', owner: 'acme.plugin' },
    { type: 'added', point: 'settings', id: 'acme.settings', owner: 'acme.plugin' },
    { type: 'removed', point: 'settings', id: 'acme.settings', owner: 'acme.plugin' }
  ]);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((event) => event.source === 'contribution-listener'));
});

test('file decoration contract keeps sync and SCM lanes separate', () => {
  const provider = {
    id: 'acme.sync',
    namespace: 'acme.sync',
    lane: core.FileDecorationLane.SYNC,
    priority: 100,
    getDecoration: () => null
  };
  assert.equal(
    core.contributionPointForDecorationLane(provider.lane),
    core.ContributionPoint.FILE_DECORATIONS_SYNC
  );
  assert.equal(core.validateFileDecorationProvider(provider, 'fileDecorations.sync'), provider);
  assert.throws(
    () => core.validateFileDecorationProvider(provider, 'fileDecorations.scm'),
    /does not match/
  );
  assert.deepEqual(core.normalizeFileDecoration({
    status: 'synced',
    badge: 'cloud-check',
    tooltip: 'Synchronized'
  }), {
    status: 'synced',
    badge: 'cloud-check',
    tooltip: 'Synchronized',
    ariaLabel: '',
    transient: false
  });
});

test('plugin runtime enforces permissions and cleans partial activation', async () => {
  const reported = [];
  const platform = core.createRendererPlatform({ onError: (event) => reported.push(event) });
  platform.services.register('public.value', { answer: 42 }, {
    owner: 'core.test',
    exposeToPlugins: true
  });
  const manifest = {
    id: 'acme.good-plugin',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: [
      core.PluginPermission.SERVICES_READ,
      core.PluginPermission.COMMANDS_REGISTER,
      core.PluginPermission.COMMANDS_EXECUTE,
      core.PluginPermission.CONTRIBUTIONS_REGISTER
    ]
  };
  let privateDisposeCount = 0;
  const activation = await platform.plugins.activate(manifest, {
    activate(context) {
      assert.equal(context.services.get('public.value').answer, 42);
      context.commands.register('acme.good-plugin.answer', () => 42);
      context.contributions.register(core.ContributionPoint.TASKS, {
        id: 'acme.good-plugin.tasks',
        provideTasks: () => []
      });
      context.subscriptions.add(core.toDisposable(() => { privateDisposeCount += 1; }));
    }
  });

  assert.equal(activation.ok, true);
  assert.equal(await platform.commands.execute('acme.good-plugin.answer'), 42);
  assert.equal(platform.contributions.list(core.ContributionPoint.TASKS).length, 1);
  assert.equal((await platform.plugins.deactivate('acme.good-plugin')).ok, true);
  assert.equal(privateDisposeCount, 1);
  assert.equal(platform.commands.has('acme.good-plugin.answer'), false);
  assert.equal(platform.contributions.list(core.ContributionPoint.TASKS).length, 0);

  const namespaceViolation = await platform.plugins.activate({
    ...manifest,
    id: 'acme.namespace-plugin'
  }, {
    activate(context) {
      context.commands.register('another-owner.command', () => undefined);
    }
  });
  assert.equal(namespaceViolation.ok, false);
  assert.equal(platform.commands.has('another-owner.command'), false);

  const denied = await platform.plugins.activate({
    id: 'acme.denied-plugin',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, {
    activate(context) {
      context.commands.register('acme.denied-plugin.command', () => undefined);
    }
  });
  assert.equal(denied.ok, false);
  assert.equal(platform.commands.has('acme.denied-plugin.command'), false);

  const partial = await platform.plugins.activate(manifest, {
    activate(context) {
      context.commands.register('acme.good-plugin.partial', () => undefined);
      throw new Error('activation failed');
    }
  });
  assert.equal(partial.ok, false);
  assert.equal(platform.commands.has('acme.good-plugin.partial'), false);
  assert.equal(platform.plugins.list().length, 0);
  assert.equal(reported.filter((event) => event.source === 'plugin-activate').length, 3);
  await platform.dispose();
});

test('plugin API ranges are parsed strictly and evaluated against the host version', () => {
  const base = {
    id: 'acme.range-plugin',
    version: '1.0.0',
    permissions: []
  };
  for (const range of ['^1.0.0', '^1', '1.x', '>=1 <2', '>=1.0.0 <2.0.0', '>=2.0.0 || ^1.0.0']) {
    assert.equal(core.validatePluginManifest({ ...base, engines: { pluginApi: range } }).id, base.id);
  }
  for (const range of ['garbage1', '^2.0.0', '>=2.0.0', '1.0.0 ||']) {
    assert.throws(
      () => core.validatePluginManifest({ ...base, engines: { pluginApi: range } }),
      /incompatible or missing/
    );
  }
  assert.throws(
    () => core.validatePluginManifest({ ...base, version: '01.0.0', engines: { pluginApi: '^1.0.0' } }),
    /valid semver/
  );
});

test('deactivation waits for in-flight activation and leaves no late registrations', async () => {
  const platform = core.createRendererPlatform();
  const activationStarted = deferred();
  const finishActivation = deferred();
  let deactivateCount = 0;
  let activationDisposeCount = 0;
  const manifest = {
    id: 'acme.slow-plugin',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: [core.PluginPermission.COMMANDS_REGISTER]
  };

  const activationPromise = platform.plugins.activate(manifest, {
    async activate(context) {
      activationStarted.resolve();
      await finishActivation.promise;
      context.commands.register('acme.slow-plugin.late-command', () => 'late');
      return core.toDisposable(() => { activationDisposeCount += 1; });
    },
    async deactivate() {
      deactivateCount += 1;
    }
  });
  await activationStarted.promise;
  const deactivationPromise = platform.plugins.deactivate(manifest.id);
  assert.equal(platform.plugins.list()[0].status, 'deactivating');
  finishActivation.resolve();

  const [activation, deactivation] = await Promise.all([activationPromise, deactivationPromise]);
  assert.equal(activation.ok, false);
  assert.match(activation.error.message, /cancelled/);
  assert.equal(deactivation.ok, true);
  assert.equal(deactivateCount, 1);
  assert.equal(activationDisposeCount, 1);
  assert.equal(platform.commands.has('acme.slow-plugin.late-command'), false);
  assert.deepEqual(platform.plugins.list(), []);
  await platform.dispose();
});

test('platform disposal waits for in-flight activation and tears it down once', async () => {
  const platform = core.createRendererPlatform();
  const activationStarted = deferred();
  const finishActivation = deferred();
  let deactivateCount = 0;
  let disposeCount = 0;
  const manifest = {
    id: 'acme.dispose-race',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  };
  const activationPromise = platform.plugins.activate(manifest, {
    async activate() {
      activationStarted.resolve();
      await finishActivation.promise;
      return core.toDisposable(() => { disposeCount += 1; });
    },
    deactivate() {
      deactivateCount += 1;
    }
  });
  await activationStarted.promise;
  const disposePromise = platform.dispose();
  finishActivation.resolve();
  const activation = await activationPromise;
  await disposePromise;

  assert.equal(activation.ok, false);
  assert.equal(deactivateCount, 1);
  assert.equal(disposeCount, 1);
  assert.deepEqual(platform.plugins.list(), []);
  assert.equal(platform.disposed, true);
});

test('disposed platform rejects late plugin activation and registry registration', async () => {
  const platform = core.createRendererPlatform({ onError() {} });
  await platform.dispose();
  const activation = await platform.plugins.activate({
    id: 'acme.too-late',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, { activate() {} });
  assert.equal(activation.ok, false);
  assert.match(activation.error.message, /disposed/);
  assert.throws(() => platform.services.register('late.service', {}), /disposed/);
  assert.throws(() => platform.commands.register('late.command', () => undefined), /disposed/);
  assert.throws(() => platform.contributions.register('tasks', { id: 'late.tasks' }), /disposed/);
  assert.throws(() => platform.contributions.onDidChange(() => {}), /disposed/);
});

test('file icon service is an injected ESM service with legacy-compatible maps', () => {
  const icons = fileIconsModule.createFileIconService({
    iconDirectory: 'assets/icons/',
    extensionMap: { '.bobo': 'bobocloud' }
  });
  assert.equal(icons.getFileIcon('main.ts'), 'assets/icons/file_type_typescript.svg');
  assert.equal(icons.getFileIcon('project.bobo'), 'assets/icons/file_type_bobocloud.svg');
  assert.equal(icons.getFolderIcon('.git'), 'assets/icons/file_type_git.svg');
  assert.equal(icons.getFileIcon('unknown.file'), null);

  icons.extensionMap['.file'] = 'yaml';
  icons.clearIconCache();
  assert.equal(icons.getFileIcon('unknown.file'), 'assets/icons/file_type_yaml.svg');
});

test('thin BOBO adapter projects the same registered file icon service', () => {
  const context = { console, window: {}, document: {} };
  vm.runInNewContext(compatibilityBundle, context);

  const BOBO = context.window.BOBO;
  assert.equal(BOBO.platform.apiVersion, '1.0.0');
  assert.equal(BOBO.platform.services.has('workbench.fileIcons'), true);
  assert.equal(BOBO.platform.services.get('workbench.fileIcons'), BOBO.fileIcons);
  assert.equal(BOBO.fileIcons.getFileIcon('main.go'), 'ico/file_type_go.svg');
  assert.equal(BOBO.platform.services.has('workbench.projectTasks'), true);
  assert.equal(BOBO.platform.services.get('workbench.projectTasks'), BOBO.projectTasks);
  const commandIds = BOBO.platform.commands.describe().map((command) => command.id);
  assert.equal(commandIds.includes('bobocloud.tasks.runSelected'), true);
  assert.equal(commandIds.includes('bobocloud.tasks.refresh'), true);
  assert.equal(
    BOBO.platform.services.describe().find((service) => service.id === 'workbench.projectTasks').exposeToPlugins,
    true
  );
  assert.notEqual(context.window.__tasksPluginView, BOBO.projectTasks);
  assert.equal(context.window.__tasksPluginView.dispose, undefined);
  assert.equal(context.window.__tasksPluginView.init, undefined);
  assert.equal(typeof context.window.__tasksPluginView.list, 'function');
  assert.equal(typeof context.window.__tasksPluginView.getSelected, 'function');
});

test('BOBO file decoration facade selects by priority, isolates failures, and forwards lifecycle changes', () => {
  const logged = [];
  const context = {
    window: {},
    document: {},
    console: {
      log: console.log,
      warn: console.warn,
      error: (...args) => logged.push(args)
    }
  };
  vm.runInNewContext(compatibilityBundle, context);
  const BOBO = context.window.BOBO;
  const changes = [];
  let providerListener = null;
  let providerDisposeCount = 0;
  BOBO.platform.fileDecorations.onDidChange((event) => changes.push(event));

  BOBO.platform.contributions.register('fileDecorations.sync', {
    id: 'acme.throwing-sync',
    namespace: 'acme.throwing-sync',
    lane: 'sync',
    priority: 200,
    getDecoration() { throw new Error('provider failed'); }
  }, { owner: 'acme.plugin' });
  const validRegistration = BOBO.platform.contributions.register('fileDecorations.sync', {
    id: 'acme.valid-sync',
    namespace: 'acme.valid-sync',
    lane: 'sync',
    priority: 100,
    getDecoration() {
      return { status: 'queued', badge: 'cloud-upload', tooltip: 'Queued' };
    },
    onDidChange(listener) {
      providerListener = listener;
      return { dispose() { providerDisposeCount += 1; } };
    }
  }, { owner: 'acme.plugin' });

  const decoration = BOBO.platform.fileDecorations.get('sync', 'src/app.js', { type: 'file', name: 'app.js' });
  assert.equal(decoration.status, 'queued');
  assert.equal(decoration.badge, 'cloud-upload');
  assert.equal(logged.length, 1);
  providerListener(['src/app.js']);
  const providerChange = changes.at(-1);
  assert.equal(providerChange.lane, 'sync');
  assert.equal(providerChange.reason, 'provider');
  assert.deepEqual(Array.from(providerChange.paths), ['src/app.js']);

  validRegistration.dispose();
  assert.equal(providerDisposeCount, 1);
  assert.equal(changes.at(-1).reason, 'registry');
  assert.equal(changes.at(-1).providerId, 'acme.valid-sync');
  assert.equal(BOBO.platform.fileDecorations.get('scm', 'src/app.js', { type: 'file', name: 'app.js' }), null);
  assert.throws(() => BOBO.platform.fileDecorations.get('unknown', 'src/app.js', {}), /Unknown file decoration lane/);
});
