'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const pluginRpcTransport = require('../main/plugin-rpc-transport');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');
let temporaryDirectory;
let core;
let fileIconsModule;
let commandPaletteModule;
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

function createCompatibilityContext(consoleObject = console) {
  const emptyTasks = () => ({
    version: '2.0.0', workspaceRoot: '', tasks: [], inputs: [], warnings: [], sources: []
  });
  return {
    console: consoleObject,
    document: {
      getElementById: () => null,
      addEventListener() {},
      removeEventListener() {}
    },
    window: {
      BOBO: { state: {} },
      addEventListener() {},
      removeEventListener() {},
      api: {
        readDiagnosticsSettings: async () => ({}),
        writeDiagnosticsSettings: async () => true,
        onOpenDiagnosticsSettings: () => () => {},
        tasksList: async () => emptyTasks(),
        tasksResolve: async () => ({ success: false, error: { code: 'TEST', message: 'test' } }),
        onWorkspaceOpened: () => () => {},
        onFileEvent: () => () => {},
        rclonePrepareRemote: async () => ({}),
        rcloneSync: async () => ({}),
        rclonePull: async () => ({}),
        rcloneCancel: async () => false,
        rcloneCancelAll: async () => ({}),
        rcloneListBinaries: async () => [],
        rcloneGetSelection: async () => null,
        rcloneSelectBinary: async () => false,
        rcloneCheckVersion: async () => ({}),
        rcloneValidateConnection: async () => ({}),
        onRcloneProgress: () => () => {}
      },
      localStorage: { getItem: () => null, setItem() {} }
    }
  };
}

test.before(async () => {
  temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-renderer-platform-'));
  core = await bundleModule('renderer/core/index.ts', 'core');
  fileIconsModule = await bundleModule('src/file-icons.ts', 'file-icons');
  commandPaletteModule = await bundleModule('src/command-palette.ts', 'command-palette');
  const compatibilityBuild = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: "import { rendererPlatform } from './renderer/core/bootstrap.ts'; import { createFileDecorationService } from './renderer/compat/file-decoration-adapter.ts'; import './renderer/core/native-host-adapter.ts'; import './renderer/compat/platform-adapter.ts'; import './renderer/compat/file-icons-adapter.ts'; import './renderer/compat/project-tasks-adapter.ts'; import './renderer/compat/command-palette-adapter.ts'; window.__rendererPlatform = rendererPlatform; window.__createFileDecorationService = createFileDecorationService; window.__fileIconsPluginView = rendererPlatform.services.getForPlugin('workbench.fileIcons'); window.__tasksPluginView = rendererPlatform.services.getForPlugin('workbench.projectTasks'); window.__commandPaletteService = rendererPlatform.services.require('workbench.commandPalette');",
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

test('plugin RPC envelopes restore failures in the renderer realm', () => {
  assert.equal(core.PLUGIN_RPC_RESULT_MARKER, pluginRpcTransport.PLUGIN_RPC_RESULT_MARKER);
  assert.equal(core.PLUGIN_RPC_RESULT_VERSION, pluginRpcTransport.PLUGIN_RPC_RESULT_VERSION);
  const success = {
    [core.PLUGIN_RPC_RESULT_MARKER]: core.PLUGIN_RPC_RESULT_VERSION,
    ok: true,
    value: { repositories: [] }
  };
  assert.deepEqual(core.unwrapPluginRpcResult(success), { repositories: [] });

  const failure = {
    [core.PLUGIN_RPC_RESULT_MARKER]: core.PLUGIN_RPC_RESULT_VERSION,
    ok: false,
    error: {
      code: 'SCM_GIT_NO_WORKSPACE',
      message: 'Open a local workspace before using source control.'
    }
  };
  assert.throws(
    () => core.unwrapPluginRpcResult(failure),
    (error) => error.code === failure.error.code && error.message === failure.error.message
  );
  assert.throws(
    () => core.unwrapPluginRpcResult({ ok: true, value: 'unmarked' }),
    { code: core.ExtensionErrorCode.PROTOCOL }
  );
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

  const symbolPayload = { visible: true };
  symbolPayload[Symbol('hidden')] = 'not data';
  assert.throws(() => core.cloneExtensionData(symbolPayload), /symbol properties/);

  let accessorReads = 0;
  const accessorArray = [];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'hidden';
    }
  });
  accessorArray.length = 1;
  assert.throws(() => core.cloneExtensionData(accessorArray), /accessors/);
  assert.equal(accessorReads, 0);

  const symbolArray = [];
  symbolArray[Symbol('hidden')] = true;
  assert.throws(() => core.cloneExtensionData(symbolArray), /symbol properties/);
  const customArray = [];
  customArray.metadata = true;
  assert.throws(() => core.cloneExtensionData(customArray), /custom properties/);

  const sparseArray = [];
  sparseArray.length = 3;
  sparseArray[1] = 'present';
  const sparseClone = core.cloneExtensionData(sparseArray);
  assert.equal(sparseClone.length, 3);
  assert.equal(0 in sparseClone, false);
  assert.equal(sparseClone[1], 'present');

  const inheritedSetterIndex = '2048';
  const setterSource = [];
  setterSource.length = 2049;
  Object.defineProperty(setterSource, inheritedSetterIndex, {
    configurable: true,
    enumerable: true,
    value: 'safe',
    writable: true
  });
  const previousSetterDescriptor = Object.getOwnPropertyDescriptor(
    Array.prototype,
    inheritedSetterIndex
  );
  let inheritedSetterCalls = 0;
  Object.defineProperty(Array.prototype, inheritedSetterIndex, {
    configurable: true,
    set() {
      inheritedSetterCalls += 1;
    }
  });
  let setterClone;
  try {
    setterClone = core.cloneExtensionData(setterSource);
  } finally {
    if (previousSetterDescriptor) {
      Object.defineProperty(Array.prototype, inheritedSetterIndex, previousSetterDescriptor);
    } else {
      delete Array.prototype[inheritedSetterIndex];
    }
  }
  assert.equal(inheritedSetterCalls, 0);
  assert.equal(setterClone[inheritedSetterIndex], 'safe');
  assert.equal(Object.prototype.hasOwnProperty.call(setterClone, inheritedSetterIndex), true);

  const oversizedString = 'x'.repeat(600 * 1024);
  const nativeNumber = global.Number;
  let intrinsicError = null;
  try {
    global.Number = { isInteger: () => true, isFinite: () => true };
    try { core.cloneExtensionData(oversizedString); } catch (error) { intrinsicError = error; }
  } finally {
    global.Number = nativeNumber;
  }
  assert.match(intrinsicError && intrinsicError.message || '', /oversized string/);

  const oversizedByKeys = Object.create(null);
  for (let index = 0; index < 1800; index += 1) {
    oversizedByKeys['property-' + index + '-' + 'x'.repeat(640)] = index;
  }
  assert.throws(() => core.cloneExtensionData(oversizedByKeys), /total size limit/);
});

test('extension messages and errors use strict bounded envelopes', () => {
  const malformedError = core.serializeExtensionError({
    code: 'invalid code with spaces',
    message: 'x'.repeat(16 * 1024)
  });
  assert.equal(malformedError.code, core.ExtensionErrorCode.UNAVAILABLE);
  assert.equal(malformedError.message.length, 8 * 1024);
  assert.equal(core.isSerializedExtensionError(malformedError), true);
  assert.equal(core.isSerializedExtensionError({ code: 'BAD', message: 'ok', extra: true }), false);

  assert.equal(core.isExtensionMessage({
    protocolVersion: 1,
    type: 'response',
    id: 1,
    ok: true,
    value: null
  }), true);
  assert.equal(core.isExtensionMessage({
    protocolVersion: 1,
    type: 'response',
    id: 1,
    ok: true,
    value: null,
    error: { code: 'BAD', message: 'ambiguous' }
  }), false);
  assert.equal(core.isExtensionMessage({
    protocolVersion: 1,
    type: 'request',
    id: 1,
    method: 'services.get'
  }), false);
  assert.equal(core.isExtensionMessage({
    protocolVersion: 1,
    type: 'response',
    id: 'host-1',
    ok: true
  }), false);
  const restored = core.deserializeExtensionError({ code: 'BAD CODE', message: 'unsafe' }, core.ExtensionErrorCode.PROTOCOL);
  assert.equal(restored.code, core.ExtensionErrorCode.PROTOCOL);
  assert.equal(restored.message, 'Extension operation failed.');
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

test('disposable store awaits priority async cleanup before ordinary teardown', async () => {
  const gate = deferred();
  const lateGate = deferred();
  const calls = [];
  const errors = [];
  let reentrantDisposePromise = null;
  let deleteDuringDispose = null;
  const store = new core.DisposableStore({ onError: (event) => errors.push(event) });
  const ordinaryFirst = core.toDisposable(() => calls.push('ordinary-first'));
  store.add(ordinaryFirst);
  store.add(core.toDisposable(() => calls.push('ordinary-last')));
  store.addAsync({
    async dispose() {
      calls.push('priority-first');
    }
  });
  store.addAsync({
    async dispose() {
      calls.push('priority-last:start');
      reentrantDisposePromise = store.disposeAsync();
      deleteDuringDispose = store.delete(ordinaryFirst);
      await gate.promise;
      calls.push('priority-last:end');
      throw new Error('priority cleanup failed');
    }
  });

  const disposePromise = store.disposeAsync();
  let settled = false;
  disposePromise.then(() => { settled = true; });
  assert.equal(store.disposeAsync(), disposePromise);
  await nextTurn();
  assert.deepEqual(calls, ['priority-last:start']);
  assert.equal(reentrantDisposePromise, disposePromise);
  assert.equal(deleteDuringDispose, false);

  store.addAsync({
    async dispose() {
      calls.push('priority-late:start');
      await lateGate.promise;
      calls.push('priority-late:end');
    }
  });

  gate.resolve();
  await nextTurn();
  assert.equal(settled, false);
  assert.deepEqual(calls, [
    'priority-last:start',
    'priority-last:end',
    'priority-late:start'
  ]);

  lateGate.resolve();
  await disposePromise;
  assert.deepEqual(calls, [
    'priority-last:start',
    'priority-last:end',
    'priority-late:start',
    'priority-late:end',
    'priority-first',
    'ordinary-last',
    'ordinary-first'
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /priority cleanup failed/);
});

test('disposeAsync waits for asynchronous cleanup already started by clear', async () => {
  const gate = deferred();
  const calls = [];
  const store = new core.DisposableStore();
  store.addAsync({
    async dispose() {
      calls.push('clear:start');
      await gate.promise;
      calls.push('clear:end');
    }
  });

  store.clear();
  const disposePromise = store.disposeAsync();
  let settled = false;
  disposePromise.then(() => { settled = true; });
  await nextTurn();
  assert.deepEqual(calls, ['clear:start']);
  assert.equal(settled, false);

  gate.resolve();
  await disposePromise;
  assert.deepEqual(calls, ['clear:start', 'clear:end']);
});

test('throwing disposable observers cannot interrupt cleanup', () => {
  const calls = [];
  const store = new core.DisposableStore({
    onError() {
      throw new Error('observer failed');
    }
  });
  store.add(core.toDisposable(() => calls.push('first')));
  store.add(core.toDisposable(() => {
    calls.push('second');
    throw new Error('cleanup failed');
  }));
  store.add(core.toDisposable(() => calls.push('third')));

  assert.doesNotThrow(() => store.dispose());
  assert.deepEqual(calls, ['third', 'second', 'first']);
});

test('renderer platform bootstrap exposes the precise runtime contract without a cast adapter', () => {
  const source = [
    "import { rendererPlatform } from '../renderer/core/bootstrap';",
    "import { createRendererPlatform } from '../renderer/core/platform';",
    "import type { Disposable, PluginExtensionNativeHost, PluginManagementHost, PluginStatusDto, RendererPlatform, RendererPlatformCompatibilityFacade } from '../types/renderer-platform';",
    'declare const compatibility: RendererPlatformCompatibilityFacade;',
    'const bootstrapped: RendererPlatform = rendererPlatform;',
    'const created: RendererPlatform = createRendererPlatform();',
    "const apiVersion: '1.6.0' = created.apiVersion;",
    'const disposed: boolean = created.disposed;',
    'const disposal: Promise<void> = created.dispose();',
    "created.services.require('workbench.projectTasks').refresh();",
    "created.services.require('workbench.fileIcons').clearIconCache();",
    "const extensionNativeHost: PluginExtensionNativeHost = created.services.require('host.pluginExtensions');",
    'const extensionDescriptors: unknown | PromiseLike<unknown> = extensionNativeHost.listDescriptors();',
    "const extensionBrokerResult: unknown | PromiseLike<unknown> | undefined = extensionNativeHost.broker?.('acme.test', 'agent.tools.list');",
    'const extensionChangeSubscription: Disposable | null | undefined = extensionNativeHost.onDidChange?.(() => {});',
    "const pluginManagementHost: PluginManagementHost = created.services.require('host.pluginManagement');",
    'const pluginStatuses: Promise<readonly PluginStatusDto[]> = pluginManagementHost.list();',
    'const pluginChangeSubscription: Disposable = pluginManagementHost.onDidChange(() => {});',
    "created.services.require('workbench.pluginManagerUI').getPlugins();",
    "created.services.require('workbench.pluginDetails').open('acme.test');",
    "created.services.require('workbench.languagePacksPanel').render();",
    "created.services.require('workbench.rcloneSettings').refreshStatus();",
    '// @ts-expect-error Native extension capabilities are private to the renderer host.',
    "created.services.getForPlugin('host.pluginExtensions');",
    '// @ts-expect-error Plugin management capabilities are private to the renderer host.',
    "created.services.getForPlugin('host.pluginManagement');",
    '// @ts-expect-error Plugin management UI is not exposed to downloaded plugins.',
    "created.services.getForPlugin('workbench.pluginManagerUI');",
    '// @ts-expect-error Plugin details UI is not exposed to downloaded plugins.',
    "created.services.getForPlugin('workbench.pluginDetails');",
    '// @ts-expect-error The language packs settings UI is private to the workbench.',
    "created.services.getForPlugin('workbench.languagePacksPanel');",
    '// @ts-expect-error The rclone settings UI is private to the workbench.',
    "created.services.getForPlugin('workbench.rcloneSettings');",
    "created.services.getForPlugin('workbench.fileIcons').getFileIcon('main.ts');",
    '// @ts-expect-error The plugin view cannot invalidate the host icon cache.',
    "created.services.getForPlugin('workbench.fileIcons').clearIconCache();",
    "created.commands.execute('bobocloud.tasks.refresh');",
    "created.contributions.list('agents')[0]?.capabilities.modes;",
    'created.sourceControls.list();',
    'created.agents.list();',
    'created.plugins.list();',
    "const compatibilityApiVersion: '1.6.0' = compatibility.apiVersion;",
    "const compatibilityService: unknown = compatibility.services.get('host.pluginExtensions');",
    "const compatibilityCommand: Promise<unknown> = compatibility.commands.execute('plugin.dynamic', { value: 1 });",
    "const compatibilityContribution: Disposable = compatibility.contributions.register('plugin.dynamic', { id: 'acme.dynamic' });",
    "const compatibilityCollection: Promise<{ values: unknown[]; errors: unknown[] }> = compatibility.contributions.collect('plugin.dynamic', 'provide', { value: 1 });",
    "compatibility.fileDecorations.get('scm', 'src/main.ts', { type: 'file' });",
    "compatibility.sourceControl.createCommandPayload('acme.scm', 'refresh', {});",
    "compatibility.agents.createCommandPayload('acme.agent', 'send', { text: 'hello' });",
    'compatibility.plugins.list();',
    '// @ts-expect-error Unknown host services remain outside the typed service map.',
    "created.services.get('plugin.dynamic');",
    '// @ts-expect-error Unknown host commands remain outside the typed command map.',
    "created.commands.execute('plugin.dynamic');",
    '// @ts-expect-error Unknown contribution points remain outside the typed point map.',
    "created.contributions.list('plugin.dynamic');",
    'void bootstrapped;',
    'void apiVersion;',
    'void disposed;',
    'void disposal;',
    'void extensionNativeHost;',
    'void extensionDescriptors;',
    'void extensionBrokerResult;',
    'void extensionChangeSubscription;',
    'void pluginManagementHost;',
    'void pluginStatuses;',
    'void pluginChangeSubscription;',
    'void compatibilityApiVersion;',
    'void compatibilityService;',
    'void compatibilityCommand;',
    'void compatibilityContribution;',
    'void compatibilityCollection;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__renderer-platform-contract.ts',
    source
  });
});

test('extension bootstrap owns partial subscriptions before later adapter teardown', async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "import { rendererPlatform } from './renderer/core/bootstrap.ts';",
        "import { rendererExtensionHost } from './renderer/core/plugin-extension-bootstrap.ts';",
        "rendererPlatform.lifecycle.add({ dispose() { window.__events.push('adapter:dispose'); } });",
        'window.__extensionBootstrapPlatform = rendererPlatform;',
        'window.__rendererExtensionHost = rendererExtensionHost;'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'extension-bootstrap-lifecycle-test-entry.js'
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });
  const events = [];
  let readyListener = null;
  const context = {
    console: { error: () => events.push('subscribe:error') },
    document: {
      documentElement: { getAttribute: () => 'false' }
    },
    window: {
      __events: events,
      api: {
        plugins: {
          runtimeDescriptors: async () => [],
          loadEntry: async () => ({ source: '' }),
          rpc: async (_id, method) => ({
            __bobocloudPluginRpcResult: 1,
            ok: true,
            value: { method }
          }),
          onChanged() {
            events.push('changed:subscribe');
            return () => events.push('changed:dispose');
          },
          onAgentModelEvent() {
            events.push('model:subscribe');
            throw new Error('model subscription failed');
          }
        }
      },
      addEventListener(type, listener) {
        assert.equal(type, 'bobo:ready');
        readyListener = listener;
        events.push('ready:subscribe');
      },
      removeEventListener(type, listener) {
        assert.equal(type, 'bobo:ready');
        assert.equal(listener, readyListener);
        events.push('ready:dispose');
        readyListener = null;
      }
    }
  };
  vm.runInNewContext(build.outputFiles[0].text, context);

  const extensionNativeHost = context.window.__extensionBootstrapPlatform.services.get('host.pluginExtensions');
  assert.ok(extensionNativeHost);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await extensionNativeHost.broker('acme.test', 'agent.tools.list'))),
    { method: 'agent.tools.list' }
  );
  assert.throws(
    () => context.window.__extensionBootstrapPlatform.services.getForPluginDynamic('host.pluginExtensions'),
    /not exposed/
  );
  await context.window.__extensionBootstrapPlatform.dispose();
  assert.deepEqual(events, [
    'ready:subscribe',
    'changed:subscribe',
    'model:subscribe',
    'subscribe:error',
    'ready:dispose',
    'changed:dispose',
    'adapter:dispose'
  ]);
  assert.equal(readyListener, null);
  assert.equal((await context.window.__rendererExtensionHost.refresh([])).ok, false);
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
  assert.equal(core.decorationLaneForContributionPoint('fileDecorations.sync'), 'sync');
  assert.equal(core.decorationLaneForContributionPoint('fileDecorations.unknown'), null);
  assert.throws(
    () => core.validateFileDecorationProvider(provider, 'fileDecorations.scm'),
    /does not match/
  );
  assert.throws(
    () => core.contributionPointForDecorationLane('constructor'),
    /Unknown file decoration lane/
  );
  assert.throws(
    () => core.validateFileDecorationProvider(Object.assign([], provider), 'fileDecorations.sync'),
    /must be an object/
  );
  assert.throws(
    () => core.validateFileDecorationProvider({ ...provider, id: 42 }, 'fileDecorations.sync'),
    /id must be a non-empty string/
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
  assert.throws(
    () => core.normalizeFileDecoration(Object.assign([], { status: 'synced', badge: 'cloud-check' })),
    /must be an object/
  );
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

test('plugin runtime reports only string manifest ids across validation and disposed lifecycle failures', async () => {
  const reported = [];
  const platform = core.createRendererPlatform({ onError: (event) => reported.push(event) });
  const invalid = await platform.plugins.activate({
    id: ['acme.looks-valid'],
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, { activate() {} });
  assert.equal(invalid.ok, false);
  assert.equal(reported.find((event) => event.source === 'plugin-validate').id, undefined);
  const throwingId = {};
  Object.defineProperty(throwingId, 'id', {
    get() { throw new Error('poisoned id'); }
  });
  const poisoned = await platform.plugins.activate(throwingId, { activate() {} });
  assert.equal(poisoned.ok, false);
  assert.equal(poisoned.error.message, 'poisoned id');
  assert.equal(reported.filter((event) => event.source === 'plugin-validate').at(-1).id, undefined);
  let versionReads = 0;
  let displayNameReads = 0;
  const statefulManifest = {
    id: 'acme.stateful-manifest',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  };
  Object.defineProperties(statefulManifest, {
    version: {
      get() {
        versionReads += 1;
        return versionReads === 1 ? '1.0.0' : 'invalid-after-validation';
      }
    },
    displayName: {
      get() {
        displayNameReads += 1;
        return displayNameReads === 1 ? 'Stable name' : null;
      }
    }
  });
  const normalizedStateful = core.validatePluginManifest(statefulManifest);
  assert.equal(normalizedStateful.version, '1.0.0');
  assert.equal(normalizedStateful.displayName, 'Stable name');
  assert.equal(versionReads, 1);
  assert.equal(displayNameReads, 1);
  assert.throws(() => core.validatePluginManifest({
    id: 'acme.invalid-contributes',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: [],
    contributes: { toJSON() { return null; } }
  }), /serialize to an object/);

  await platform.dispose();
  const disposed = await platform.plugins.activate({
    id: { unsafe: true },
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, { activate() {} });
  assert.equal(disposed.ok, false);
  assert.equal(reported.find((event) => event.source === 'plugin-lifecycle').id, undefined);
});

test('plugin runtime resolves services through its typed dynamic registry port', async () => {
  const expectedService = Object.freeze({ kind: 'expected' });
  let strictReads = 0;
  let dynamicReads = 0;
  let receivedService = null;
  const runtime = new core.PluginRuntime({
    services: {
      getForPlugin(id) {
        strictReads += 1;
        return Object.freeze({ kind: 'wrong', id });
      },
      getForPluginDynamic(id) {
        dynamicReads += 1;
        assert.equal(id, 'known.service');
        return expectedService;
      },
      disposeOwner() {}
    },
    commands: {
      registerDynamic() { throw new Error('not used'); },
      executeDynamic() { return Promise.resolve(undefined); },
      disposeOwner() {}
    },
    contributions: {
      registerDynamic() { throw new Error('not used'); },
      disposeOwner() {}
    }
  });

  const activation = await runtime.activate({
    id: 'acme.typed-services',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: [core.PluginPermission.SERVICES_READ]
  }, {
    activate(context) {
      receivedService = context.services.get('known.service');
    }
  });
  assert.equal(activation.ok, true);
  assert.equal(receivedService, expectedService);
  assert.equal(strictReads, 0);
  assert.equal(dynamicReads, 1);
  await runtime.dispose();
});

test('legacy plugin runtime registers and owns source-control state', async () => {
  const platform = core.createRendererPlatform();
  const pluginId = 'acme.legacy-scm';
  const providerId = pluginId + '.provider';
  const activation = await platform.plugins.activate({
    id: pluginId,
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: [core.PluginPermission.SOURCE_CONTROL_REGISTER]
  }, {
    async activate(context) {
      const provider = await context.sourceControl.register({
        id: providerId,
        title: 'Legacy repository',
        icon: 'git-branch',
        order: 7
      });
      await provider.setState({ phase: 'ready', title: 'Legacy repository' });
    }
  });

  assert.equal(activation.ok, true);
  const contribution = platform.contributions
    .listEntries(core.ContributionPoint.SOURCE_CONTROL)
    .find((entry) => entry.id === providerId);
  assert.equal(contribution.owner, pluginId);
  const state = platform.sourceControls.get(providerId);
  assert.equal(state.owner, pluginId);
  assert.equal(state.state.phase, 'ready');
  assert.equal(state.state.title, 'Legacy repository');

  assert.equal((await platform.plugins.deactivate(pluginId)).ok, true);
  assert.equal(platform.contributions.list(core.ContributionPoint.SOURCE_CONTROL).length, 0);
  assert.equal(platform.sourceControls.get(providerId), null);
  await platform.dispose();
});

test('plugin API ranges are parsed strictly and evaluated against the host version', () => {
  const base = {
    id: 'acme.range-plugin',
    version: '1.0.0',
    permissions: []
  };
  for (const range of ['^1.0.0', '^1', '1.x', '>=1 <2', '>=1.0.0 <2.0.0', '>=2.0.0 || ^1.0.0', '>1.5']) {
    assert.equal(core.validatePluginManifest({ ...base, engines: { pluginApi: range } }).id, base.id);
  }
  for (const range of ['garbage1', '^2.0.0', '>=2.0.0', '>1', '1.0.0 ||']) {
    assert.throws(
      () => core.validatePluginManifest({ ...base, engines: { pluginApi: range } }),
      /incompatible or missing/
    );
  }
  assert.throws(
    () => core.validatePluginManifest({ ...base, version: '01.0.0', engines: { pluginApi: '^1.0.0' } }),
    /valid semver/
  );
  assert.throws(
    () => core.validatePluginManifest({ ...base, version: '1.0.0-01', engines: { pluginApi: '^1.0.0' } }),
    /valid semver/
  );
  assert.equal(core.validatePluginManifest({
    ...base,
    version: '1.0.0+build.7',
    engines: { pluginApi: '^1.0.0' }
  }).version, '1.0.0+build.7');
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

test('deactivation owns cleanup while a sandbox activation is still pending', async () => {
  const reports = [];
  const platform = core.createRendererPlatform();
  let sandboxOptions;
  let disposed = false;
  const sandbox = {
    ready: Promise.resolve(),
    postMessage(message) {
      if (message.type === 'request' && message.method === 'extension.deactivate') {
        setTimeout(() => sandboxOptions.onMessage({
          protocolVersion: 1,
          type: 'response',
          id: message.id,
          ok: true,
          value: null
        }), 10);
      }
    },
    dispose() { disposed = true; }
  };
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export async function activate() { await new Promise(() => {}); }' }),
    broker: async () => ({ authorized: true }),
    sandboxFactory: (options) => {
      sandboxOptions = options;
      return sandbox;
    },
    onError: (event) => reports.push(event)
  });
  const descriptor = {
    id: 'acme.activating-disable',
    manifest: {
      id: 'acme.activating-disable',
      version: '1.0.0',
      engines: { pluginApi: '^1.0.0' },
      permissions: []
    },
    grantedPermissions: []
  };

  const activation = host.activate(descriptor);
  await nextTurn();
  const deactivation = await host.deactivate(descriptor.id);
  const activationResult = await activation;
  assert.equal(activationResult.ok, false);
  assert.equal(activationResult.error.code, core.ExtensionErrorCode.CANCELLED);
  assert.equal(deactivation.ok, true);
  assert.equal(disposed, true);
  assert.equal(reports.some((event) => event.source === 'extension-deactivate'), false);
  await host.dispose();
  await platform.dispose();
});

test('deactivation cancels delayed authorization before command side effects', async () => {
  const platform = core.createRendererPlatform();
  const authorization = deferred();
  let authorizationCalls = 0;
  let commandCalls = 0;
  let sandbox;
  platform.commands.register('core.side-effect', () => {
    commandCalls += 1;
    return 'ran';
  }, { owner: 'core' });
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: (_id, method) => {
      if (method === 'commands.execute') {
        authorizationCalls += 1;
        return authorization.promise;
      }
      return Promise.resolve({ authorized: true });
    },
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options))
  });
  const descriptor = {
    id: 'acme.cancelled-command',
    manifest: {
      id: 'acme.cancelled-command',
      version: '1.0.0',
      engines: { pluginApi: '^1.0.0' },
      permissions: [core.PluginPermission.COMMANDS_EXECUTE]
    },
    grantedPermissions: [core.PluginPermission.COMMANDS_EXECUTE]
  };

  assert.equal((await host.activate(descriptor)).ok, true);
  sandbox.emit({
    type: 'request',
    id: 1,
    method: 'commands.execute',
    args: { id: 'core.side-effect', args: [] }
  });
  await nextTurn();
  assert.equal(authorizationCalls, 1);
  assert.equal((await host.deactivate(descriptor.id)).ok, true);
  authorization.resolve({ authorized: true });
  await nextTurn();
  assert.equal(commandCalls, 0);
  await host.dispose();
  await platform.dispose();
});

test('extension sandbox keeps downloaded source out of the renderer document and blocks direct network', () => {
  const documentSource = core.buildExtensionSandboxDocument();
  const encodedWorker = documentSource.match(/const WORKER_SOURCE = ("(?:\\.|[^"\\])*");/);
  assert.ok(encodedWorker);
  assert.doesNotThrow(() => new Function(JSON.parse(encodedWorker[1])));
  assert.match(core.EXTENSION_SANDBOX_CSP, /connect-src 'none'/);
  assert.match(core.EXTENSION_SANDBOX_CSP, /worker-src blob:/);
  assert.match(documentSource, /new Worker\(/);
  assert.match(documentSource, /event\.source !== window\.parent/);
  assert.match(documentSource, /safeDefineProperty\(self, name/);
  assert.doesNotMatch(documentSource, /window\.api/);
  assert.doesNotMatch(documentSource, /window\.BOBO/);
  assert.match(documentSource, /registerScm/);
  assert.match(documentSource, /scm\.git\.request/);
  assert.match(documentSource, /function scmRequest\(operation, args\)/);
  assert.match(documentSource, /nativePortPostMessage/);
  assert.match(documentSource, /Extension payload exceeds the total size limit/);
  assert.match(documentSource, /createExtensionDataCloner/);
  assert.match(documentSource, /initializationPromise/);
  assert.match(documentSource, /await initializationPromise/);
  assert.doesNotMatch(documentSource, /hardenProtocolIntrinsics/);
  assert.doesNotMatch(documentSource, /port\.postMessage\(/);
  assert.match(documentSource, /clone: \(args\) => scmRequest\('clone', args\)/);
  assert.match(documentSource, /deleteBranch: \(args\) => scmRequest\('deleteBranch', args\)/);
  assert.doesNotMatch(documentSource, /operation: 'detect', args: args \|\| \{\}/);
});

test('extension sandbox disposal settles readiness and closes both transport ports', async () => {
  const channels = [];
  const fatalErrors = [];
  const listeners = new Map();
  const iframe = {
    contentWindow: { postMessage() {} },
    parentNode: null,
    referrerPolicy: '',
    srcdoc: '',
    style: { cssText: '' },
    tabIndex: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    remove() { this.removed = true; },
    setAttribute() {}
  };
  class FakePort {
    constructor() {
      this.closed = false;
      this.onmessage = null;
      this.onmessageerror = null;
    }
    close() { this.closed = true; }
    postMessage() {}
    start() {}
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      channels.push(this);
    }
  }
  const sandbox = core.createSandboxedExtensionSandbox({
    document: {
      body: { appendChild() {} },
      documentElement: null,
      createElement() { return iframe; }
    },
    MessageChannel: FakeMessageChannel,
    connectTimeoutMs: 60_000,
    onFatal(error) { fatalErrors.push(error); }
  });
  const readiness = assert.rejects(sandbox.ready, (error) => {
    assert.equal(error.code, core.ExtensionErrorCode.CANCELLED);
    return true;
  });

  sandbox.dispose();
  await readiness;

  assert.equal(channels.length, 1);
  assert.equal(channels[0].port1.closed, true);
  assert.equal(channels[0].port2.closed, true);
  assert.equal(channels[0].port1.onmessage, null);
  assert.equal(channels[0].port1.onmessageerror, null);
  assert.equal(iframe.removed, true);
  assert.deepEqual(fatalErrors, []);
  assert.throws(
    () => sandbox.postMessage({ type: 'late' }),
    (error) => error.code === core.ExtensionErrorCode.CANCELLED
  );
  sandbox.dispose();
});

test('extension sandbox cleans transport resources when mounting fails', () => {
  const channels = [];
  const listeners = new Map();
  const iframe = {
    contentWindow: { postMessage() {} },
    parentNode: null,
    referrerPolicy: '',
    srcdoc: '',
    style: { cssText: '' },
    tabIndex: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    remove() { this.removed = true; },
    setAttribute() {}
  };
  class FakePort {
    constructor() {
      this.closed = false;
      this.onmessage = null;
      this.onmessageerror = null;
    }
    close() { this.closed = true; }
    postMessage() {}
    start() {}
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      channels.push(this);
    }
  }
  const mountError = new Error('mount failed');

  assert.throws(() => core.createSandboxedExtensionSandbox({
    document: {
      body: { appendChild() { throw mountError; } },
      documentElement: null,
      createElement() { return iframe; }
    },
    MessageChannel: FakeMessageChannel
  }), (error) => error === mountError);

  assert.equal(channels.length, 1);
  assert.equal(channels[0].port1.closed, true);
  assert.equal(channels[0].port2.closed, true);
  assert.equal(channels[0].port1.onmessage, null);
  assert.equal(channels[0].port1.onmessageerror, null);
  assert.equal(listeners.size, 0);
  assert.equal(iframe.removed, true);
});

test('extension host silently ignores valid messages that arrive after cleanup', async () => {
  const platform = core.createRendererPlatform();
  const reports = [];
  let sandbox;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: async () => ({ authorized: true }),
    onError: (event) => reports.push(event),
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options))
  });
  const descriptor = {
    id: 'acme.late-message',
    revision: 'first',
    manifest: {
      id: 'acme.late-message',
      version: '1.0.0',
      engines: { pluginApi: '^1.0.0' },
      permissions: []
    },
    grantedPermissions: []
  };
  assert.equal((await host.activate(descriptor)).ok, true);
  assert.equal((await host.deactivate(descriptor.id)).ok, true);
  const reportCount = reports.length;
  sandbox.emit({ type: 'response', id: 'host-late', ok: true, value: null });
  sandbox.emit({ type: 'activated' });
  await nextTurn();
  assert.equal(reports.length, reportCount);
  await host.dispose();
  await platform.dispose();
});

test('extension host reloads same-version packages when their content revision changes', async () => {
  const platform = core.createRendererPlatform();
  const sandboxes = [];
  const manifest = {
    id: 'acme.revision-refresh',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  };
  let descriptor = {
    id: manifest.id,
    revision: 'a'.repeat(64),
    manifest,
    grantedPermissions: []
  };
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    listDescriptors: async () => [descriptor],
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: async () => ({ authorized: true }),
    sandboxFactory: (options) => {
      const sandbox = createExtensionSandboxHarness(options);
      sandboxes.push(sandbox);
      return sandbox;
    }
  });

  const started = await host.start();
  assert.deepEqual(started.activated, [manifest.id]);
  descriptor = { ...descriptor, revision: 'b'.repeat(64) };
  const refreshed = await host.refresh();
  assert.deepEqual(refreshed.deactivated, [manifest.id]);
  assert.deepEqual(refreshed.activated, [manifest.id]);
  assert.equal(sandboxes.length, 2);
  assert.equal(sandboxes[0].disposed, true);
  assert.equal(sandboxes[1].disposed, false);

  await host.dispose();
  await platform.dispose();
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
  const context = createCompatibilityContext();
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
  const listeners = new Map();
  const eventTarget = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  const palette = commandPaletteModule.createCommandPalette({
    document: {},
    eventTarget,
    getI18n: () => null,
    setTimer: () => 1,
    clearTimer() {}
  });
  assert.equal(listeners.has('bobo:language-changed'), true);
  const first = palette.register('acme.palette.command', 'One', '', 'Extensions', () => {});
  assert.equal(palette.has('acme.palette.command'), true);
  const replacement = palette.register('acme.palette.command', 'Two', '', 'Extensions', () => {});
  first.dispose();
  assert.equal(palette.has('acme.palette.command'), true);
  replacement.dispose();
  assert.equal(palette.has('acme.palette.command'), false);
  palette.dispose();
  palette.dispose();
  assert.equal(palette.disposed, true);
  assert.equal(listeners.has('bobo:language-changed'), false);
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

test('plugin runtime preserves falsy activation and deactivation failures', async () => {
  const platform = core.createRendererPlatform({ onError() {} });
  const activationStarted = deferred();
  const finishActivation = deferred();
  let deactivateCount = 0;
  const activationPromise = platform.plugins.activate({
    id: 'acme.falsy-activation',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, {
    async activate() {
      activationStarted.resolve();
      await finishActivation.promise;
      throw null;
    },
    deactivate() {
      deactivateCount += 1;
    }
  });
  await activationStarted.promise;
  const deactivationPromise = platform.plugins.deactivate('acme.falsy-activation');
  finishActivation.resolve();
  const [activation, deactivation] = await Promise.all([activationPromise, deactivationPromise]);
  assert.equal(activation.ok, false);
  assert.equal(activation.error, null);
  assert.equal(deactivation.ok, true);
  assert.equal(deactivateCount, 0);

  assert.equal((await platform.plugins.activate({
    id: 'acme.falsy-deactivation',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, {
    activate() {},
    deactivate() { throw 0; }
  })).ok, true);
  const failedDeactivation = await platform.plugins.deactivate('acme.falsy-deactivation');
  assert.equal(failedDeactivation.ok, false);
  assert.equal(failedDeactivation.error, 0);
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
  const concurrentDisposePromise = platform.dispose();
  let disposalSettled = false;
  disposePromise.then(() => { disposalSettled = true; });
  assert.equal(concurrentDisposePromise, disposePromise);
  assert.equal(platform.disposed, true);
  await nextTurn();
  assert.equal(disposalSettled, false);
  finishActivation.resolve();
  const activation = await activationPromise;
  await disposePromise;

  assert.equal(activation.ok, false);
  assert.equal(deactivateCount, 1);
  assert.equal(disposeCount, 1);
  assert.deepEqual(platform.plugins.list(), []);
  assert.equal(platform.disposed, true);
});

test('platform disposal awaits an asynchronous legacy plugin disposable', async () => {
  const platform = core.createRendererPlatform();
  const gate = deferred();
  const calls = [];
  const activation = await platform.plugins.activate({
    id: 'acme.async-disposable',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, {
    activate() {
      return {
        async dispose() {
          calls.push('plugin:start');
          await gate.promise;
          calls.push('plugin:end');
        }
      };
    }
  });
  assert.equal(activation.ok, true);

  const disposePromise = platform.dispose();
  let settled = false;
  disposePromise.then(() => { settled = true; });
  await nextTurn();
  assert.deepEqual(calls, ['plugin:start']);
  assert.equal(settled, false);

  gate.resolve();
  await disposePromise;
  assert.deepEqual(calls, ['plugin:start', 'plugin:end']);
  assert.equal(platform.plugins.list().length, 0);
});

test('plugin subscription disposal awaits asynchronous entries in LIFO order', async () => {
  const platform = core.createRendererPlatform();
  const gate = deferred();
  const calls = [];
  const activation = await platform.plugins.activate({
    id: 'acme.async-subscriptions',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: []
  }, {
    activate(context) {
      context.subscriptions.add({
        dispose() { calls.push('first'); }
      });
      context.subscriptions.add({
        async dispose() {
          calls.push('second:start');
          await gate.promise;
          calls.push('second:end');
        }
      });
    }
  });
  assert.equal(activation.ok, true);

  const deactivationPromise = platform.plugins.deactivate('acme.async-subscriptions');
  let settled = false;
  deactivationPromise.then(() => { settled = true; });
  await nextTurn();
  assert.deepEqual(calls, ['second:start']);
  assert.equal(settled, false);

  gate.resolve();
  const deactivation = await deactivationPromise;
  assert.equal(deactivation.ok, true);
  assert.deepEqual(calls, ['second:start', 'second:end', 'first']);
  await platform.dispose();
});

test('plugin cleanup keeps its owner id reserved until asynchronous teardown completes', async () => {
  const platform = core.createRendererPlatform({ onError() {} });
  const cleanupStarted = deferred();
  const finishCleanup = deferred();
  const manifest = {
    id: 'acme.cleanup-owner',
    version: '1.0.0',
    engines: { pluginApi: '^1.0.0' },
    permissions: [core.PluginPermission.COMMANDS_REGISTER]
  };
  const replacementModule = {
    activate(context) {
      context.commands.register('acme.cleanup-owner.new-command', () => 'new');
    }
  };
  assert.equal((await platform.plugins.activate(manifest, {
    activate(context) {
      context.commands.register('acme.cleanup-owner.old-command', () => 'old');
      return {
        async dispose() {
          cleanupStarted.resolve();
          await finishCleanup.promise;
        }
      };
    }
  })).ok, true);

  const deactivationPromise = platform.plugins.deactivate(manifest.id);
  await cleanupStarted.promise;
  const overlappingReplacement = await platform.plugins.activate(manifest, replacementModule);
  assert.equal(overlappingReplacement.ok, false);
  assert.match(overlappingReplacement.error.message, /already active/);
  assert.equal(platform.commands.has('acme.cleanup-owner.old-command'), true);

  finishCleanup.resolve();
  assert.equal((await deactivationPromise).ok, true);
  assert.equal(platform.commands.has('acme.cleanup-owner.old-command'), false);
  assert.deepEqual(platform.plugins.list(), []);

  assert.equal((await platform.plugins.activate(manifest, replacementModule)).ok, true);
  assert.equal(await platform.commands.execute('acme.cleanup-owner.new-command'), 'new');
  await platform.dispose();
});

test('platform disposal waits for priority lifecycle work before later adapters and registries', async () => {
  const platform = core.createRendererPlatform();
  const gate = deferred();
  const calls = [];
  platform.lifecycle.addAsync({
    async dispose() {
      calls.push('extension:start');
      await gate.promise;
      calls.push('extension:end');
    }
  });
  platform.lifecycle.add(core.toDisposable(() => calls.push('adapter')));
  platform.services.register('late.service', {}, {
    dispose: () => calls.push('service')
  });

  const disposePromise = platform.dispose();
  let settled = false;
  disposePromise.then(() => { settled = true; });
  await nextTurn();
  assert.equal(settled, false);
  assert.deepEqual(calls, ['extension:start']);
  assert.equal(platform.services.has('late.service'), true);

  gate.resolve();
  await disposePromise;
  assert.deepEqual(calls, ['extension:start', 'extension:end', 'adapter', 'service']);
  assert.equal(platform.services.has('late.service'), false);
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
  assert.equal(icons.getFileIcon('docker-compose.yml'), 'assets/icons/file_type_docker.svg');
  assert.equal(icons.getFileIcon('.gitignore'), 'assets/icons/file_type_git.svg');
  assert.equal(icons.getFolderIcon('.git'), 'assets/icons/file_type_git.svg');
  assert.equal(icons.getFileIcon('unknown.file'), null);

  icons.extensionMap['.file'] = 'yaml';
  assert.equal(icons.getFileIcon('unknown.file'), null);
  assert.equal(icons.getFileIcon('UNKNOWN.FILE'), 'assets/icons/file_type_yaml.svg');
  icons.clearIconCache();
  assert.equal(icons.getFileIcon('unknown.file'), 'assets/icons/file_type_yaml.svg');
  assert.equal(icons.getFileIcon('constructor'), null);
  assert.equal(icons.getFolderIcon('constructor'), null);
  assert.equal(Object.isFrozen(icons), true);
  assert.equal(Object.isFrozen(icons.extensionMap), false);
  assert.equal(Object.getPrototypeOf(icons.extensionMap), Object.prototype);
  assert.deepEqual(Object.keys(icons), [
    'getFileIcon', 'getFolderIcon', 'clearIconCache',
    'extensionMap', 'filenameMap', 'folderIconMap'
  ]);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(icons))), [
    'extensionMap', 'filenameMap', 'folderIconMap'
  ]);
});

test('default file icon maps reference packaged SVG assets', () => {
  const icons = fileIconsModule.createFileIconService({ iconDirectory: 'ico' });
  const iconNames = new Set([
    ...Object.values(icons.extensionMap),
    ...Object.values(icons.filenameMap),
    ...Object.values(icons.folderIconMap)
  ]);
  for (const iconName of iconNames) {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'ico', 'file_type_' + iconName + '.svg')),
      true,
      'missing packaged file icon: ' + iconName
    );
  }
});

test('thin BOBO adapters project registered file icon and command palette services', () => {
  const context = createCompatibilityContext();
  vm.runInNewContext(compatibilityBundle, context);

  const BOBO = context.window.BOBO;
  assert.equal(BOBO.platform.apiVersion, '1.6.0');
  assert.equal(Object.isFrozen(BOBO.platform), true);
  for (const key of [
    'fileDecorations', 'sourceControl', 'agents', 'services', 'commands', 'contributions', 'plugins'
  ]) {
    assert.equal(Object.isFrozen(BOBO.platform[key]), true, key + ' facade must remain frozen');
  }
  assert.equal(BOBO.platform.services.has('workbench.fileIcons'), true);
  assert.equal(BOBO.platform.services.get('workbench.fileIcons'), BOBO.fileIcons);
  assert.equal(BOBO.fileIcons.getFileIcon('main.go'), 'ico/file_type_go.svg');
  assert.notEqual(context.window.__fileIconsPluginView, BOBO.fileIcons);
  assert.equal(Object.isFrozen(context.window.__fileIconsPluginView), true);
  assert.deepEqual(Object.keys(context.window.__fileIconsPluginView), ['getFileIcon', 'getFolderIcon']);
  assert.equal(context.window.__fileIconsPluginView.getFileIcon('main.go'), 'ico/file_type_go.svg');
  assert.equal(context.window.__fileIconsPluginView.clearIconCache, undefined);
  assert.equal(context.window.__fileIconsPluginView.extensionMap, undefined);
  const fileIconDescription = BOBO.platform.services.describe()
    .find((service) => service.id === 'workbench.fileIcons');
  assert.equal(fileIconDescription.owner, 'core.file-icons');
  assert.equal(fileIconDescription.exposeToPlugins, true);
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
  assert.equal(BOBO.platform.services.has('workbench.commandPalette'), true);
  assert.equal(
    BOBO.platform.services.get('workbench.commandPalette'),
    context.window.__commandPaletteService
  );
  assert.notEqual(BOBO.commands, context.window.__commandPaletteService);
  assert.deepEqual(Object.keys(BOBO.commands), [
    'register', 'unregister', 'has', 'supportsDisposables', 'show', 'hide'
  ]);
  assert.equal(BOBO.commands.dispose, undefined);
  assert.equal(BOBO.commands.supportsDisposables, true);
  assert.throws(
    () => context.window.__rendererPlatform.services.getForPlugin('workbench.commandPalette'),
    /not exposed to plugins/
  );
  assert.equal(
    BOBO.platform.services.describe()
      .find((service) => service.id === 'workbench.commandPalette').exposeToPlugins,
    false
  );
  context.window.__rendererPlatform.lifecycle.clear();
  assert.equal(BOBO.platform.services.has('workbench.fileIcons'), false);
  assert.equal(BOBO.platform.services.has('workbench.commandPalette'), false);
  assert.equal(BOBO.fileIcons.getFileIcon('main.go'), 'ico/file_type_go.svg');
});

test('BOBO file decoration facade selects by priority, isolates failures, and forwards lifecycle changes', () => {
  const logged = [];
  const context = createCompatibilityContext({
    log: console.log,
    warn: console.warn,
    error: (...args) => logged.push(args)
  });
  vm.runInNewContext(compatibilityBundle, context);
  const BOBO = context.window.BOBO;
  const changes = [];
  let providerListener = null;
  let providerDisposeCount = 0;
  let activeProviderListener = null;
  let activeProviderDisposeCount = 0;
  let reentrantProviderListener = null;
  let reentrantProviderDisposeCount = 0;
  BOBO.platform.fileDecorations.onDidChange((event) => changes.push(event));
  assert.equal(BOBO.platform.services.has('workbench.fileDecorations'), true);
  assert.equal(
    BOBO.platform.services.describe()
      .find((service) => service.id === 'workbench.fileDecorations').exposeToPlugins,
    false
  );

  BOBO.platform.contributions.register('fileDecorations.sync', {
    id: 'acme.async-sync',
    namespace: 'acme.async-sync',
    lane: 'sync',
    priority: 300,
    getDecoration() {
      return { then(_resolve, reject) { reject(new Error('async provider failed')); } };
    }
  }, { owner: 'acme.plugin' });
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

  const registryChange = changes.find((event) => (
    event.reason === 'registry' && event.providerId === 'acme.valid-sync'
  ));
  assert.deepEqual(Array.from(Object.keys(registryChange)), ['lane', 'paths', 'reason', 'providerId']);
  assert.equal(Object.hasOwn(registryChange, 'paths'), true);
  assert.equal(registryChange.paths, undefined);
  assert.equal(Object.isFrozen(registryChange), true);

  const decoration = BOBO.platform.fileDecorations.get('sync', 'src/app.js', { type: 'file', name: 'app.js' });
  assert.equal(decoration.status, 'queued');
  assert.equal(decoration.badge, 'cloud-upload');
  assert.equal(logged.length, 2);
  providerListener(['src/app.js']);
  const providerChange = changes.at(-1);
  assert.equal(providerChange.lane, 'sync');
  assert.equal(providerChange.reason, 'provider');
  assert.deepEqual(Array.from(providerChange.paths), ['src/app.js']);
  assert.equal(Object.isFrozen(providerChange.paths), true);
  assert.equal(Object.isFrozen(providerChange), true);
  providerListener([42]);
  assert.equal(changes.at(-1).reason, 'provider');
  assert.equal(changes.at(-1).paths, undefined);
  let pathIterations = 0;
  const singleReadPaths = ['src/single-read.js'];
  singleReadPaths[Symbol.iterator] = function* () {
    pathIterations += 1;
    yield pathIterations === 1 ? 'src/single-read.js' : 42;
  };
  providerListener(singleReadPaths);
  assert.equal(pathIterations, 1);
  assert.deepEqual(Array.from(changes.at(-1).paths), ['src/single-read.js']);

  validRegistration.dispose();
  assert.equal(providerDisposeCount, 1);
  assert.equal(changes.at(-1).reason, 'registry');
  assert.equal(changes.at(-1).providerId, 'acme.valid-sync');
  assert.equal(BOBO.platform.fileDecorations.get('scm', 'src/app.js', { type: 'file', name: 'app.js' }), null);
  assert.throws(() => BOBO.platform.fileDecorations.get('unknown', 'src/app.js', {}), /Unknown file decoration lane/);

  BOBO.platform.contributions.register('fileDecorations.sync', {
    id: 'acme.reentrant-sync',
    namespace: 'acme.reentrant-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange(listener) {
      reentrantProviderListener = listener;
      context.window.__rendererPlatform.contributions.disposeOwner('acme.reentrant');
      return { dispose() { reentrantProviderDisposeCount += 1; } };
    }
  }, { owner: 'acme.reentrant' });
  assert.equal(reentrantProviderDisposeCount, 1);
  const changesBeforeStaleCallback = changes.length;
  reentrantProviderListener(['src/ghost.js']);
  assert.equal(changes.length, changesBeforeStaleCallback);

  BOBO.platform.contributions.register('fileDecorations.sync', {
    id: 'acme.active-sync',
    namespace: 'acme.active-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange(listener) {
      activeProviderListener = listener;
      return { dispose() { activeProviderDisposeCount += 1; } };
    }
  }, { owner: 'acme.active' });
  context.window.__rendererPlatform.lifecycle.clear();
  assert.equal(BOBO.platform.services.has('workbench.fileDecorations'), false);
  assert.equal(providerDisposeCount, 1);
  assert.equal(reentrantProviderDisposeCount, 1);
  assert.equal(activeProviderDisposeCount, 1);
  const changesAfterServiceDispose = changes.length;
  activeProviderListener(['src/inactive.js']);
  assert.equal(changes.length, changesAfterServiceDispose);
  context.window.__rendererPlatform.lifecycle.clear();
  assert.equal(activeProviderDisposeCount, 1);
});

test('file decoration services reconcile stale initial provider snapshots', () => {
  const context = createCompatibilityContext();
  vm.runInNewContext(compatibilityBundle, context);
  const platform = context.window.__rendererPlatform;
  const callbacks = [];
  let firstSubscribeCount = 0;
  let firstDisposeCount = 0;
  let staleSubscribeCount = 0;
  let staleDisposeCount = 0;

  platform.contributions.register('fileDecorations.sync', {
    id: 'acme.first-sync',
    namespace: 'acme.first-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange() {
      firstSubscribeCount += 1;
      if (firstSubscribeCount === 2) platform.contributions.disposeOwner('acme.stale');
      return { dispose() { firstDisposeCount += 1; } };
    }
  }, { owner: 'acme.first' });
  platform.contributions.register('fileDecorations.sync', {
    id: 'acme.stale-sync',
    namespace: 'acme.stale-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange(listener) {
      staleSubscribeCount += 1;
      callbacks.push(listener);
      return { dispose() { staleDisposeCount += 1; } };
    }
  }, { owner: 'acme.stale' });

  const secondService = context.window.__createFileDecorationService();
  const secondEvents = [];
  secondService.onDidChange((event) => secondEvents.push(event));
  assert.equal(platform.contributions.listEntries('fileDecorations.sync').some(
    (entry) => entry.id === 'acme.stale-sync'
  ), false);
  assert.equal(staleSubscribeCount, 1);
  assert.equal(staleDisposeCount, 1);
  callbacks[0](['src/stale.js']);
  assert.equal(secondEvents.length, 0);

  secondService.dispose();
  assert.equal(firstDisposeCount, 1);
  platform.lifecycle.clear();
  assert.equal(firstDisposeCount, 2);
  assert.equal(staleDisposeCount, 1);
});

test('stale removal events cannot tear down a same-key replacement provider', () => {
  const context = createCompatibilityContext();
  vm.runInNewContext(compatibilityBundle, context);
  const platform = context.window.__rendererPlatform;
  const replacementCallbacks = [];
  let oldDisposeCount = 0;
  let replacementDisposeCount = 0;
  let replacementSubscribeCount = 0;
  let replacementRegistration = null;

  const replacementProvider = {
    id: 'acme.replace-sync',
    namespace: 'acme.replace-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange(listener) {
      replacementSubscribeCount += 1;
      replacementCallbacks.push(listener);
      return { dispose() { replacementDisposeCount += 1; } };
    }
  };
  const reentrantRegistryListener = platform.contributions.onDidChange((event) => {
    if (event.type !== 'removed' || event.id !== 'acme.replace-sync' || replacementRegistration) return;
    replacementRegistration = platform.contributions.register(
      'fileDecorations.sync',
      replacementProvider,
      { owner: 'acme.replacement' }
    );
  });
  const oldRegistration = platform.contributions.register('fileDecorations.sync', {
    id: 'acme.replace-sync',
    namespace: 'acme.replace-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange() {
      return { dispose() { oldDisposeCount += 1; } };
    }
  }, { owner: 'acme.original' });
  const secondService = context.window.__createFileDecorationService();
  const secondEvents = [];
  secondService.onDidChange((event) => secondEvents.push(event));

  oldRegistration.dispose();
  assert.equal(oldDisposeCount, 2);
  assert.equal(replacementSubscribeCount, 2);
  replacementCallbacks.at(-1)(['src/replacement.js']);
  assert.equal(secondEvents.at(-1).reason, 'provider');
  assert.deepEqual(Array.from(secondEvents.at(-1).paths), ['src/replacement.js']);

  secondService.dispose();
  assert.equal(replacementDisposeCount, 1);
  reentrantRegistryListener.dispose();
  platform.lifecycle.clear();
  assert.equal(replacementDisposeCount, 2);
  replacementRegistration.dispose();
});

test('replacement reconciliation re-reads the registry after a reentrant disposer', () => {
  const context = createCompatibilityContext();
  vm.runInNewContext(compatibilityBundle, context);
  const platform = context.window.__rendererPlatform;
  let firstSubscribeCount = 0;
  let firstDisposeCount = 0;
  let secondSubscribeCount = 0;
  let secondDisposeCount = 0;
  let thirdSubscribeCount = 0;
  let thirdDisposeCount = 0;
  let installedSecond = false;

  const thirdProvider = {
    id: 'acme.generation-sync',
    namespace: 'acme.generation-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange() {
      thirdSubscribeCount += 1;
      return { dispose() { thirdDisposeCount += 1; } };
    }
  };
  const secondProvider = {
    id: 'acme.generation-sync',
    namespace: 'acme.generation-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange() {
      secondSubscribeCount += 1;
      return { dispose() { secondDisposeCount += 1; } };
    }
  };
  const firstRegistration = platform.contributions.register('fileDecorations.sync', {
    id: 'acme.generation-sync',
    namespace: 'acme.generation-sync',
    lane: 'sync',
    getDecoration: () => null,
    onDidChange() {
      firstSubscribeCount += 1;
      const subscriptionIndex = firstSubscribeCount;
      return {
        dispose() {
          firstDisposeCount += 1;
          if (subscriptionIndex !== 2) return;
          platform.contributions.disposeOwner('acme.generation-b');
          platform.contributions.register(
            'fileDecorations.sync',
            thirdProvider,
            { owner: 'acme.generation-c' }
          );
        }
      };
    }
  }, { owner: 'acme.generation-a' });
  const replacementListener = platform.contributions.onDidChange((event) => {
    if (
      installedSecond ||
      event.type !== 'removed' ||
      event.owner !== 'acme.generation-a'
    ) return;
    installedSecond = true;
    platform.contributions.register(
      'fileDecorations.sync',
      secondProvider,
      { owner: 'acme.generation-b' }
    );
  });
  const secondService = context.window.__createFileDecorationService();

  firstRegistration.dispose();
  const current = platform.contributions.listEntries('fileDecorations.sync')
    .find((entry) => entry.id === 'acme.generation-sync');
  assert.equal(current.owner, 'acme.generation-c');
  assert.equal(current.contribution, thirdProvider);
  assert.equal(firstSubscribeCount, 2);
  assert.equal(firstDisposeCount, 2);
  assert.equal(secondSubscribeCount, 1);
  assert.equal(secondDisposeCount, 1);
  assert.equal(thirdSubscribeCount, 2);

  secondService.dispose();
  assert.equal(thirdDisposeCount, 1);
  replacementListener.dispose();
  platform.lifecycle.clear();
  assert.equal(thirdDisposeCount, 2);
  assert.equal(thirdDisposeCount, thirdSubscribeCount);
});
