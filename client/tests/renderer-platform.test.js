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

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createExtensionSandboxHarness(options) {
  const sent = [];
  let disposed = false;
  const emit = (message) => options.onMessage({ protocolVersion: 1, ...message });
  return {
    ready: Promise.resolve(),
    sent,
    get disposed() { return disposed; },
    postMessage(message) {
      sent.push(message);
      if (message.type === 'initialize') {
        queueMicrotask(() => emit({ type: 'activated' }));
      } else if (message.type === 'request' &&
          (message.method === 'extension.deactivate' || message.method === 'i18n.changed')) {
        queueMicrotask(() => emit({ type: 'response', id: message.id, ok: true, value: null }));
      }
    },
    emit,
    dispose() { disposed = true; }
  };
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

test('extension protocol accepts cross-realm data records but rejects class instances', () => {
  const foreignRecord = vm.runInNewContext('({ operation: "detect", args: { includeNested: true } })');
  assert.deepEqual(JSON.parse(JSON.stringify(core.cloneExtensionData(foreignRecord))), {
    operation: 'detect',
    args: { includeNested: true }
  });

  const foreignClass = vm.runInNewContext('new (class Payload { constructor() { this.value = 1; } })()');
  assert.throws(
    () => core.cloneExtensionData(foreignClass),
    /plain objects only/
  );
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
    color: '',
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

test('installed extension host proxies commands through a sandbox and removes palette entries on disable', async () => {
  const errors = [];
  const platform = core.createRendererPlatform({ onError: (event) => errors.push(event) });
  platform.services.register('workbench.projectTasks', {
    list: () => [{ label: 'Build', executable: true }],
    getSelected: () => ({ type: 'task', label: 'Build' })
  }, {
    owner: 'core.tasks',
    exposeToPlugins: true,
    pluginView: {
      list: () => [{ label: 'Build', executable: true }],
      getSelected: () => ({ type: 'task', label: 'Build' })
    }
  });
  const paletteItems = new Map();
  const palette = {
    supportsDisposables: true,
    register(id, title, hint, category, handler) {
      const item = { id, title, hint, category, handler };
      paletteItems.set(id, item);
      return { dispose() { if (paletteItems.get(id) === item) paletteItems.delete(id); } };
    }
  };
  let sandbox;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: async (_id, method) => {
      if (method === 'host.getInfo') return { apiVersion: '1.0.0' };
      return { authorized: true, method };
    },
    getCommandPalette: () => palette,
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options)),
    onError: (event) => errors.push(event)
  });
  const descriptor = {
    id: 'acme.runner',
    revision: 'first',
    manifest: {
      id: 'acme.runner',
      version: '1.0.0',
      engines: { pluginApi: '^1.0.0' },
      permissions: [
        core.PluginPermission.COMMANDS_REGISTER,
        core.PluginPermission.COMMANDS_EXECUTE,
        core.PluginPermission.CONTRIBUTIONS_REGISTER,
        core.PluginPermission.SERVICES_READ
      ]
    },
    grantedPermissions: [
      core.PluginPermission.COMMANDS_REGISTER,
      core.PluginPermission.COMMANDS_EXECUTE,
      core.PluginPermission.CONTRIBUTIONS_REGISTER,
      core.PluginPermission.SERVICES_READ
    ]
  };
  assert.equal((await host.activate(descriptor)).ok, true);

  sandbox.emit({
    type: 'request',
    id: 1,
    method: 'commands.register',
    args: {
      id: 'acme.runner.build',
      handlerId: 'handler-1',
      metadata: { title: 'Build with Acme', category: 'Build' }
    }
  });
  await nextTurn();
  const commandRegistration = sandbox.sent.find((message) => message.type === 'response' && message.id === 1);
  assert.equal(commandRegistration.ok, true);
  assert.equal(platform.commands.has('acme.runner.build'), true);
  assert.equal(paletteItems.has('acme.runner.build'), true);

  const commandExecution = platform.commands.execute('acme.runner.build', { target: 'debug' });
  await nextTurn();
  const invocation = sandbox.sent.find((message) => message.type === 'request' && message.method === 'command.invoke');
  assert.ok(invocation);
  assert.deepEqual(JSON.parse(JSON.stringify(invocation.args.args)), [{ target: 'debug' }]);
  sandbox.emit({ type: 'response', id: invocation.id, ok: true, value: { completed: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(await commandExecution)), { completed: true });

  sandbox.emit({
    type: 'request',
    id: 2,
    method: 'contributions.register',
    args: {
      point: core.DeclarativeContributionPoint.MENUS,
      contribution: { id: 'acme.runner.menu', command: 'acme.runner.build', location: 'commandPalette' },
      options: { id: 'acme.runner.menu' }
    }
  });
  await nextTurn();
  assert.equal(sandbox.sent.find((message) => message.type === 'response' && message.id === 2).ok, true);
  assert.equal(platform.contributions.list(core.DeclarativeContributionPoint.MENUS).length, 1);

  sandbox.emit({
    type: 'request',
    id: 3,
    method: 'services.get',
    args: { id: 'workbench.projectTasks' }
  });
  await nextTurn();
  const serviceResponse = sandbox.sent.find((message) => message.type === 'response' && message.id === 3);
  assert.deepEqual(JSON.parse(JSON.stringify(serviceResponse.value)), {
    tasks: [{ label: 'Build', executable: true }],
    selected: { type: 'task', label: 'Build' }
  });
  assert.equal(typeof serviceResponse.value.tasks[0].list, 'undefined');

  assert.equal((await host.deactivate('acme.runner')).ok, true);
  assert.equal(platform.commands.has('acme.runner.build'), false);
  assert.equal(platform.contributions.list(core.DeclarativeContributionPoint.MENUS).length, 0);
  assert.equal(paletteItems.has('acme.runner.build'), false);
  assert.equal(sandbox.disposed, true);
  assert.equal(errors.length, 0);
  await platform.dispose();
});

test('installed extension host rejects malformed or ungranted requests and cancels an in-flight activation', async () => {
  const reports = [];
  const platform = core.createRendererPlatform({ onError: (event) => reports.push(event) });
  let sandbox;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: async () => ({ authorized: true }),
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options)),
    onError: (event) => reports.push(event)
  });
  const descriptor = {
    id: 'acme.restricted',
    manifest: {
      id: 'acme.restricted',
      version: '1.0.0',
      engines: { pluginApi: '^1.0.0' },
      permissions: [core.PluginPermission.COMMANDS_REGISTER]
    },
    grantedPermissions: [core.PluginPermission.COMMANDS_REGISTER]
  };
  assert.equal((await host.activate(descriptor)).ok, true);
  sandbox.emit({ type: 'request', id: 1, method: 'services.get', args: { id: 'workbench.projectTasks' } });
  sandbox.emit({ type: 'request', method: 'commands.register', args: {} });
  await nextTurn();
  const denied = sandbox.sent.find((message) => message.type === 'response' && message.id === 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, core.ExtensionErrorCode.DENIED);
  assert.ok(reports.some((event) => event.source === 'extension-protocol'));
  await host.deactivate('acme.restricted');

  const source = deferred();
  let raceSandboxCreated = false;
  const raceHost = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: () => source.promise,
    broker: async () => ({ authorized: true }),
    sandboxFactory: () => { raceSandboxCreated = true; return createExtensionSandboxHarness({ onMessage() {} }); }
  });
  const pendingActivation = raceHost.activate({
    id: 'acme.race',
    manifest: {
      id: 'acme.race',
      version: '1.0.0',
      engines: { pluginApi: '^1.0.0' },
      permissions: []
    },
    grantedPermissions: []
  });
  const deactivation = raceHost.deactivate('acme.race');
  source.resolve({ id: 'acme.race', source: 'export function activate() {}' });
  assert.equal((await pendingActivation).ok, false);
  assert.equal((await deactivation).ok, true);
  assert.equal(raceSandboxCreated, false);
  assert.deepEqual(raceHost.list(), []);
  await raceHost.dispose();
  await platform.dispose();
});

test('extension sandbox keeps downloaded source out of the renderer document and blocks direct network', () => {
  const documentSource = core.buildExtensionSandboxDocument();
  assert.match(core.EXTENSION_SANDBOX_CSP, /connect-src 'none'/);
  assert.match(core.EXTENSION_SANDBOX_CSP, /worker-src blob:/);
  assert.match(documentSource, /new Worker\(/);
  assert.match(documentSource, /Object\.defineProperty\(self, name/);
  assert.doesNotMatch(documentSource, /window\.api/);
  assert.doesNotMatch(documentSource, /window\.BOBO/);
  assert.match(documentSource, /registerScm/);
  assert.match(documentSource, /scm\.git\.request/);
  assert.match(documentSource, /function scmRequest\(operation, args\)/);
  assert.match(documentSource, /clone: \(args\) => scmRequest\('clone', args\)/);
  assert.match(documentSource, /deleteBranch: \(args\) => scmRequest\('deleteBranch', args\)/);
  assert.doesNotMatch(documentSource, /operation: 'detect', args: args \|\| \{\}/);
});

test('document views are manifest-authorized, lifecycle-owned, and rendered in a separate networkless sandbox', async () => {
  const platform = core.createRendererPlatform();
  let sandbox;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: async (_id, method, args) => ({
      authorized: true,
      method,
      viewer: method === 'documentViews.register' ? {
        id: args.id,
        title: args.title,
        extensions: ['.pdf'],
        entry: 'dist/view.js',
        resources: ['dist/view.css'],
        priority: 20
      } : undefined
    }),
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options))
  });
  const descriptor = {
    id: 'acme.documents',
    revision: 'first',
    manifest: {
      id: 'acme.documents',
      version: '1.0.0',
      engines: { pluginApi: '^1.3.0' },
      permissions: [core.PluginPermission.DOCUMENT_VIEWS_REGISTER, core.PluginPermission.DOCUMENTS_READ],
      contributes: { documentViewers: [{ id: 'acme.documents.pdf' }] }
    },
    grantedPermissions: [core.PluginPermission.DOCUMENT_VIEWS_REGISTER, core.PluginPermission.DOCUMENTS_READ]
  };
  assert.equal((await host.activate(descriptor)).ok, true);
  sandbox.emit({ type: 'request', id: 1, method: 'documentViews.register', args: { id: 'acme.documents.pdf', title: 'PDF Preview' } });
  await nextTurn();
  const response = sandbox.sent.find((message) => message.type === 'response' && message.id === 1);
  assert.equal(response.ok, true);
  const entries = platform.contributions.listEntries(core.ContributionPoint.DOCUMENT_VIEWS);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].owner, 'acme.documents');
  assert.equal(core.selectDocumentView(entries, 'REPORT.PDF').id, 'acme.documents.pdf');

  const sandboxDocument = core.buildDocumentViewSandboxDocument();
  assert.match(core.DOCUMENT_VIEW_SANDBOX_CSP, /connect-src 'none'/);
  assert.match(core.DOCUMENT_VIEW_SANDBOX_CSP, /worker-src blob:/);
  assert.doesNotMatch(sandboxDocument, /window\.api/);
  assert.doesNotMatch(sandboxDocument, /window\.BOBO/);
  assert.doesNotMatch(sandboxDocument, /allow-same-origin/);
  assert.match(sandboxDocument, /Direct document-view network access is disabled/);
  assert.match(sandboxDocument, /document\.read/);

  await host.deactivate('acme.documents');
  assert.equal(platform.contributions.listEntries(core.ContributionPoint.DOCUMENT_VIEWS).length, 0);
  await platform.dispose();
});

test('SCM data contracts reject path escape and keep presentation host-controlled', () => {
  const provider = core.createScmFileDecorationProvider({
    id: 'acme.scm.decorations',
    namespace: 'acme.scm',
    priority: 20,
    localize: (key) => key === 'Source control: Modified' ? 'Changed by source control' : key
  });
  const events = [];
  provider.onDidChange((paths) => events.push(Array.from(paths)));

  const result = provider.set([
    { path: 'src\\app.js', status: 'modified' },
    { path: 'README.md', status: 'untracked' }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    changedPaths: ['src/app.js', 'README.md'],
    entryCount: 2
  });
  assert.deepEqual(JSON.parse(JSON.stringify(provider.getDecoration('src/app.js'))), {
    status: 'modified',
    badge: 'M',
    color: 'warning',
    tooltip: 'Changed by source control',
    ariaLabel: 'Changed by source control'
  });
  assert.deepEqual(events, [['src/app.js', 'README.md']]);
  assert.throws(() => provider.set([{ path: '../outside.js', status: 'modified' }]), /workspace-relative|traverse/);
  assert.throws(() => provider.set([{ path: 'src/app.js', status: 'arbitrary-badge' }]), /status/);
  assert.throws(() => provider.set([{ path: 'src/app.js', status: 'added', badge: '<svg>' }]), /unsupported field/);
  assert.equal(provider.clear(['src/app.js']).entryCount, 1);
  assert.equal(provider.getDecoration('src/app.js'), null);
  provider.dispose();
  assert.throws(() => provider.set([]), /disposed/);

  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'stage',
    args: { repositoryId: 'scm-1234567890abcdef', paths: ['src/app.js'] }
  }))), {
    operation: 'stage',
    permission: 'scm.git.write',
    args: { repositoryId: 'scm-1234567890abcdef', paths: ['src/app.js'] }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'stageAll',
    args: { repositoryId: 'scm-1234567890abcdef' }
  }))), {
    operation: 'stageAll',
    permission: 'scm.git.write',
    args: { repositoryId: 'scm-1234567890abcdef' }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'detect',
    args: { includeNested: false }
  }))), {
    operation: 'detect',
    permission: 'scm.git.read',
    args: { includeNested: false }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'history',
    args: { repositoryId: 'scm-1234567890abcdef', offset: 25, limit: 500, ref: 'main' }
  }))), {
    operation: 'history',
    permission: 'scm.git.read',
    args: { repositoryId: 'scm-1234567890abcdef', offset: 25, limit: 500, ref: 'main' }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'status',
    args: { repositoryId: 'scm-1234567890abcdef', offset: 50, limit: 200 }
  }))), {
    operation: 'status',
    permission: 'scm.git.read',
    args: { repositoryId: 'scm-1234567890abcdef', offset: 50, limit: 200 }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'diff',
    args: { repositoryId: 'scm-1234567890abcdef', path: 'src/app.js', ref: 'main', staged: true }
  }))), {
    operation: 'diff',
    permission: 'scm.git.read',
    args: { repositoryId: 'scm-1234567890abcdef', path: 'src/app.js', ref: 'main', staged: true }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'checkout',
    args: { repositoryId: 'scm-1234567890abcdef', branch: 'feature/local', force: true }
  }))), {
    operation: 'checkout',
    permission: 'scm.git.write',
    args: { repositoryId: 'scm-1234567890abcdef', branch: 'feature/local', force: true }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'createBranch',
    args: { repositoryId: 'scm-1234567890abcdef', name: 'feature/local', checkout: true }
  }))), {
    operation: 'createBranch',
    permission: 'scm.git.write',
    args: { repositoryId: 'scm-1234567890abcdef', name: 'feature/local', checkout: true }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'clone',
    args: { url: 'https://github.com/example/repository.git', branch: 'main' }
  }))), {
    operation: 'clone',
    permission: 'scm.git.write',
    args: { url: 'https://github.com/example/repository.git', branch: 'main' }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'clone',
    args: { url: 'git@github.com:example/repository.git' }
  }))), {
    operation: 'clone',
    permission: 'scm.git.write',
    args: { url: 'git@github.com:example/repository.git' }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeScmGitRequest({
    operation: 'deleteBranch',
    args: { repositoryId: 'scm-1234567890abcdef', name: 'feature/local', force: true }
  }))), {
    operation: 'deleteBranch',
    permission: 'scm.git.write',
    args: { repositoryId: 'scm-1234567890abcdef', name: 'feature/local', force: true }
  });
  assert.throws(() => core.normalizeScmGitRequest({
    operation: 'history',
    args: { repositoryId: 'scm-1234567890abcdef', limit: 501 }
  }), /1 to 500/);
  assert.throws(() => core.normalizeScmGitRequest({
    operation: 'status',
    args: { repositoryId: 'scm-1234567890abcdef', limit: 201 }
  }), /1 to 200/);
  assert.throws(() => core.normalizeScmGitRequest({
    operation: 'clone',
    args: { url: 'file:///tmp/not-allowed.git' }
  }), /HTTPS or SSH/);
  assert.throws(() => core.normalizeScmGitRequest({
    operation: 'clone',
    args: { url: 'file:relative-repository.git' }
  }), /HTTPS or SSH/);
  assert.throws(() => core.normalizeScmGitRequest({
    operation: 'clone',
    args: { url: 'C:/local-repository.git' }
  }), /HTTPS or SSH/);
  assert.throws(() => core.normalizeScmGitRequest({
    operation: 'clone',
    args: { url: 'https://github.com/example/repository.git', target: '../outside' }
  }), /does not accept/);
  assert.throws(() => core.normalizeScmGitRequest({
    operation: 'status',
    args: { repositoryId: 'scm-1234567890abcdef', cwd: 'C:/outside' }
  }), /does not accept/);
  assert.throws(() => core.normalizeScmGitRequest({ operation: 'detect', args: null }), /plain object/);
  assert.throws(() => core.normalizeScmGitRequest({ operation: 'detect', args: false }), /plain object/);
});

test('static SCM decoration provider reaches the generic SCM tree lane without touching sync or diagnostics', () => {
  const context = { console, window: {}, document: {} };
  vm.runInNewContext(compatibilityBundle, context);
  const BOBO = context.window.BOBO;
  const provider = core.createScmFileDecorationProvider({
    id: 'acme.tree.decorations',
    namespace: 'acme.tree',
    priority: 40
  });
  const changes = [];
  BOBO.platform.fileDecorations.onDidChange((event) => changes.push(event));
  const registration = BOBO.platform.contributions.register('fileDecorations.scm', provider, {
    id: provider.id,
    owner: 'acme.tree'
  });
  provider.set([{ path: 'src/main.go', status: 'added' }]);
  const decoration = BOBO.platform.fileDecorations.get('scm', 'src/main.go', { type: 'file' });
  assert.equal(decoration.status, 'added');
  assert.equal(decoration.badge, 'A');
  assert.equal(BOBO.platform.fileDecorations.get('sync', 'src/main.go', { type: 'file' }), null);
  assert.equal(BOBO.platform.fileDecorations.get('diagnostic', 'src/main.go', { type: 'file' }), null);
  assert.equal(changes.some((event) => event.lane === 'scm' && event.reason === 'provider'), true);
  registration.dispose();
  assert.equal(BOBO.platform.fileDecorations.get('scm', 'src/main.go', { type: 'file' }), null);
});

test('source-control state providers are bounded, localized, and removed with their extension', async () => {
  const platform = core.createRendererPlatform();
  let sandbox;
  let activeLocale = 'en';
  let localeListener;
  const localizationLoads = [];
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    sourceControls: platform.sourceControls,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    loadLocalization: async (id, locale) => {
      localizationLoads.push({ id, locale });
      return {
        locale,
        messages: locale === 'ja'
          ? { 'Workspace records': 'Workspace records ja' }
          : { 'Workspace records': 'Workspace records' }
      };
    },
    getLocale: () => activeLocale,
    onLocaleChange: (listener) => {
      localeListener = listener;
      return () => { localeListener = null; };
    },
    broker: async () => ({ authorized: true }),
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options))
  });
  const descriptor = {
    id: 'acme.source-panel',
    revision: 'first',
    manifest: {
      id: 'acme.source-panel',
      version: '1.0.0',
      engines: { pluginApi: '^1.2.0' },
      permissions: [core.PluginPermission.SOURCE_CONTROL_REGISTER]
    },
    grantedPermissions: [core.PluginPermission.SOURCE_CONTROL_REGISTER]
  };
  assert.equal((await host.activate(descriptor)).ok, true);
  assert.deepEqual(localizationLoads, [{ id: 'acme.source-panel', locale: 'en' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.sent.find((message) => message.type === 'initialize').localization)), {
    locale: 'en', messages: { 'Workspace records': 'Workspace records' }
  });

  sandbox.emit({
    type: 'request', id: 1, method: 'sourceControl.register', args: {
      id: 'acme.source-panel.view', title: 'Workspace records', icon: 'git-branch', order: 3,
      openCommand: 'acme.source-panel.open'
    }
  });
  await nextTurn();
  const registration = sandbox.sent.find((message) => message.id === 1);
  assert.equal(registration.ok, true);
  const handle = registration.value.handle;

  sandbox.emit({
    type: 'request', id: 2, method: 'sourceControl.setState', args: {
      handle,
      state: {
        phase: 'ready',
        title: 'Workspace records',
        summary: { items: [{ label: 'Selected', value: '1' }] },
        sections: [{
          id: 'records', title: 'Records', items: [{
            id: 'first', title: 'First record', command: 'acme.source-panel.select'
          }],
          loadMore: { command: 'acme.source-panel.loadMore' }
        }],
        actions: [{
          id: 'refresh', title: 'Refresh', command: 'acme.source-panel.refresh', placement: 'toolbar', icon: 'refresh',
          form: { fields: [{ id: 'note', label: 'Note', type: 'textarea', maxLength: 128 }] }
        }]
      }
    }
  });
  await nextTurn();
  assert.equal(sandbox.sent.find((message) => message.id === 2).ok, true);
  const state = platform.sourceControls.get('acme.source-panel.view');
  assert.equal(state.state.phase, 'ready');
  assert.equal(state.state.sections[0].loadMore.command, 'acme.source-panel.loadMore');
  assert.equal(state.state.actions[0].form.fields[0].maxLength, 128);
  assert.equal(state.state.actions[0].placement, 'toolbar');
  assert.equal(state.state.actions[0].icon, 'refresh');
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.normalizeSourceControlFormValues(state.state.actions[0].form, { note: 'hello', extra: 'ignored' }))),
    { note: 'hello' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.createSourceControlCommandPayload(state.id, 'refresh', { note: 'hello' }, { kind: 'action' }))),
    { sourceControlId: 'acme.source-panel.view', actionId: 'refresh', values: { note: 'hello' }, kind: 'action' }
  );

  sandbox.emit({
    type: 'request', id: 3, method: 'sourceControl.setState', args: {
      handle,
      state: { actions: [{ id: 'unsafe', title: 'Unsafe', command: 'outside.command' }] }
    }
  });
  await nextTurn();
  assert.equal(sandbox.sent.find((message) => message.id === 3).ok, false);
  assert.equal(sandbox.sent.find((message) => message.id === 3).error.code, core.ExtensionErrorCode.INVALID_REQUEST);

  activeLocale = 'ja';
  localeListener();
  await nextTurn();
  await nextTurn();
  const localeUpdate = sandbox.sent.find((message) => message.type === 'request' && message.method === 'i18n.changed');
  assert.deepEqual(JSON.parse(JSON.stringify(localeUpdate.args)), {
    locale: 'ja', messages: { 'Workspace records': 'Workspace records ja' }
  });

  sandbox.emit({ type: 'request', id: 4, method: 'sourceControl.clearState', args: { handle } });
  await nextTurn();
  assert.equal(sandbox.sent.find((message) => message.id === 4).ok, true);
  assert.equal(platform.sourceControls.get('acme.source-panel.view').state, null);

  assert.equal((await host.deactivate(descriptor.id)).ok, true);
  assert.equal(platform.sourceControls.get('acme.source-panel.view'), null);
  await platform.dispose();
});

test('installed extensions receive only data-only source control, SCM, and local Git contracts', async () => {
  const platform = core.createRendererPlatform();
  let sandbox;
  const brokerCalls = [];
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: async (id, method, args) => {
      brokerCalls.push({ id, method, args: JSON.parse(JSON.stringify(args)) });
      if (method === 'scm.git.status') return { repositoryId: args.repositoryId, changes: [] };
      return { authorized: true, method };
    },
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options))
  });
  const descriptor = {
    id: 'acme.local-scm',
    revision: 'first',
    manifest: {
      id: 'acme.local-scm',
      version: '1.0.0',
      engines: { pluginApi: '^1.0.0' },
      permissions: [
        core.PluginPermission.SOURCE_CONTROL_REGISTER,
        core.PluginPermission.FILE_DECORATIONS_SCM,
        core.PluginPermission.SCM_GIT_READ,
        core.PluginPermission.SCM_GIT_WRITE
      ]
    },
    grantedPermissions: [
      core.PluginPermission.SOURCE_CONTROL_REGISTER,
      core.PluginPermission.FILE_DECORATIONS_SCM,
      core.PluginPermission.SCM_GIT_READ,
      core.PluginPermission.SCM_GIT_WRITE
    ]
  };
  assert.equal((await host.activate(descriptor)).ok, true);

  sandbox.emit({
    type: 'request', id: 1, method: 'sourceControl.register', args: {
      id: 'acme.local-scm.provider', title: 'Local source control', icon: 'git-branch', order: 15
    }
  });
  await nextTurn();
  assert.equal(sandbox.sent.find((message) => message.id === 1).ok, true);
  assert.equal(platform.contributions.list(core.ContributionPoint.SOURCE_CONTROL).length, 1);

  sandbox.emit({
    type: 'request', id: 2, method: 'fileDecorations.scm.register', args: {
      id: 'acme.local-scm.decorations', priority: 75
    }
  });
  await nextTurn();
  const registration = sandbox.sent.find((message) => message.id === 2);
  assert.equal(registration.ok, true);
  const handle = registration.value.handle;
  sandbox.emit({
    type: 'request', id: 3, method: 'fileDecorations.scm.set', args: {
      handle,
      entries: [{ path: 'src/app.js', status: 'conflicted' }]
    }
  });
  await nextTurn();
  assert.equal(sandbox.sent.find((message) => message.id === 3).ok, true);
  const scmProvider = platform.contributions.list(core.ContributionPoint.FILE_DECORATIONS_SCM)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(scmProvider.getDecoration('src/app.js'))), {
    status: 'conflicted', badge: '!', color: 'danger', tooltip: 'Source control: Conflicted', ariaLabel: 'Source control: Conflicted'
  });

  sandbox.emit({
    type: 'request', id: 4, method: 'scm.git.request', args: {
      operation: 'status', args: { repositoryId: 'scm-1234567890abcdef' }
    }
  });
  await nextTurn();
  const statusResult = sandbox.sent.find((message) => message.id === 4);
  assert.equal(statusResult.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(statusResult.value)), { repositoryId: 'scm-1234567890abcdef', changes: [] });
  assert.equal(brokerCalls.some((call) => call.method === 'scm.git.status' && call.args.repositoryId === 'scm-1234567890abcdef'), true);

  sandbox.emit({
    type: 'request', id: 41, method: 'scm.git.request', args: {
      operation: 'clone', args: { url: 'https://github.com/example/repository.git', branch: 'main' }
    }
  });
  await nextTurn();
  const cloneResult = sandbox.sent.find((message) => message.id === 41);
  assert.equal(cloneResult.ok, true);
  assert.equal(
    brokerCalls.some((call) => call.method === 'scm.git.clone' && call.args.url === 'https://github.com/example/repository.git' && call.args.branch === 'main'),
    true
  );

  const brokerCallsBeforeInvalid = brokerCalls.length;
  sandbox.emit({
    type: 'request', id: 5, method: 'fileDecorations.scm.set', args: {
      handle, entries: [{ path: '../outside.js', status: 'modified' }]
    }
  });
  sandbox.emit({
    type: 'request', id: 6, method: 'scm.git.request', args: {
      operation: 'stage', args: { repositoryId: 'scm-1234567890abcdef', paths: ['../outside.js'] }
    }
  });
  await nextTurn();
  assert.equal(sandbox.sent.find((message) => message.id === 5).error.code, core.ExtensionErrorCode.INVALID_REQUEST);
  assert.equal(sandbox.sent.find((message) => message.id === 6).error.code, core.ExtensionErrorCode.INVALID_REQUEST);
  assert.equal(brokerCalls.length, brokerCallsBeforeInvalid);

  assert.equal((await host.deactivate(descriptor.id)).ok, true);
  assert.equal(platform.contributions.list(core.ContributionPoint.SOURCE_CONTROL).length, 0);
  assert.equal(platform.contributions.list(core.ContributionPoint.FILE_DECORATIONS_SCM).length, 0);
  await platform.dispose();
});

test('command palette registrations are disposable and do not leave disabled extension commands behind', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'command-palette.js'), 'utf8');
  const context = { window: {}, document: {} };
  vm.runInNewContext(source, context);
  const palette = context.window.BOBO.commands;
  const first = palette.register('acme.palette.command', 'One', '', 'Extensions', () => {});
  assert.equal(palette.has('acme.palette.command'), true);
  const replacement = palette.register('acme.palette.command', 'Two', '', 'Extensions', () => {});
  first.dispose();
  assert.equal(palette.has('acme.palette.command'), true);
  replacement.dispose();
  assert.equal(palette.has('acme.palette.command'), false);
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
  assert.equal(BOBO.platform.apiVersion, '1.4.0');
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
