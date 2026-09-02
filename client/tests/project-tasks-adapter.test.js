'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { directBridgeAccessCount } = require('./support/renderer-bridge-access');

const ROOT = path.resolve(__dirname, '..');
const NATIVE_HOST_ADAPTER = 'renderer/core/native-host-adapter.ts';
const PROJECT_TASKS_SLICE = Object.freeze([
  'renderer/compat/project-tasks-adapter.ts',
  'src/project-tasks.ts'
]);

function emptyConfiguration() {
  return {
    version: '2.0.0',
    workspaceRoot: '',
    tasks: [],
    inputs: [],
    warnings: [],
    sources: []
  };
}

function populatedConfiguration() {
  return {
    version: '2.0.0',
    workspaceRoot: 'C:\\workspace',
    tasks: [{
      id: 'vscode:Build',
      label: 'Build',
      type: 'shell',
      kind: 'build',
      command: 'npm',
      args: ['run', 'build'],
      options: { env: { PRIVATE_VALUE: 'not-for-plugins' } },
      dependsOn: [],
      dependsOrder: 'parallel',
      isDefault: true,
      hide: false,
      executable: true,
      source: 'vscode',
      sourcePath: 'C:\\workspace\\.vscode\\tasks.json',
      raw: { command: 'npm', private: true },
      warnings: [{ code: 'TASK_PLATFORM_CLOUD_LINUX', message: 'host detail' }],
      presentation: { reveal: 'always', echo: true, focus: false, clear: false },
      runOptions: { reevaluateOnRerun: true, runOn: 'default' }
    }],
    inputs: [],
    warnings: [],
    sources: []
  };
}

test('Project Tasks adapters own one service, keep the host private, and dispose subscriptions once', async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "import { rendererPlatform } from './renderer/core/bootstrap.ts';",
        "import './renderer/core/native-host-adapter.ts';",
        "import './renderer/compat/project-tasks-adapter.ts';",
        'window.__projectTasksAdapterPlatform = rendererPlatform;'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'project-tasks-adapter-test-entry.js'
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });

  const windowListeners = new Map();
  const addWindowListener = (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(listener);
  };
  const removeWindowListener = (type, listener) => windowListeners.get(type)?.delete(listener);
  let workspaceSubscriptions = 0;
  let workspaceUnsubscriptions = 0;
  let fileSubscriptions = 0;
  let fileUnsubscriptions = 0;
  let workspaceListener = null;
  let fileListener = null;
  let resolveArguments = null;
  let listCalls = 0;
  let listedConfiguration = emptyConfiguration();
  const api = {
    tasksList: async () => {
      listCalls += 1;
      return listedConfiguration;
    },
    tasksResolve(label, context, inputs) {
      resolveArguments = { label, context, inputs };
      return Promise.resolve({ success: false, error: { code: 'TEST', message: 'test' } });
    },
    onWorkspaceOpened(listener) {
      workspaceSubscriptions += 1;
      workspaceListener = listener;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        workspaceUnsubscriptions += 1;
      };
    },
    onFileEvent(listener) {
      fileSubscriptions += 1;
      fileListener = listener;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        fileUnsubscriptions += 1;
      };
    }
  };
  const window = {
    BOBO: { state: { workspaceRoot: '', workspaceIdentity: 0 } },
    api,
    localStorage: { getItem: () => null, setItem() {} },
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: addWindowListener,
    removeEventListener: removeWindowListener,
    setTimeout,
    clearTimeout
  };
  const document = {
    body: { appendChild() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    createElement() { throw new Error('Project Tasks should not create DOM before an input or menu opens.'); },
    addEventListener() {},
    removeEventListener() {}
  };
  vm.runInNewContext(build.outputFiles[0].text, { console, document, window, setTimeout, clearTimeout });

  const platform = window.__projectTasksAdapterPlatform;
  const controller = platform.services.require('workbench.projectTasks');
  const host = platform.services.require('host.projectTasks');
  assert.equal(controller, window.BOBO.projectTasks);
  assert.notEqual(host, api);

  const descriptions = platform.services.describe().filter(({ id }) => (
    id === 'host.projectTasks' || id === 'workbench.projectTasks'
  ));
  assert.deepEqual(JSON.parse(JSON.stringify(descriptions)), [
    { id: 'host.projectTasks', owner: 'core', exposeToPlugins: false },
    { id: 'workbench.projectTasks', owner: 'core.tasks', exposeToPlugins: true }
  ]);
  assert.equal(descriptions.filter(({ id }) => id === 'host.projectTasks').length, 1);
  assert.equal(descriptions.filter(({ id }) => id === 'workbench.projectTasks').length, 1);
  assert.throws(() => platform.services.getForPlugin('host.projectTasks'), /not exposed to plugins/);

  listedConfiguration = populatedConfiguration();
  window.BOBO.state.workspaceRoot = listedConfiguration.workspaceRoot;
  await controller.refresh();
  const pluginView = platform.services.getForPlugin('workbench.projectTasks');
  assert.notEqual(pluginView, controller);
  assert.equal(Object.isFrozen(pluginView), true);
  assert.deepEqual(Object.keys(pluginView).sort(), ['getSelected', 'list']);
  const pluginTasks = pluginView.list();
  assert.equal(Object.isFrozen(pluginTasks), true);
  assert.equal(Object.isFrozen(pluginTasks[0]), true);
  assert.equal(Object.isFrozen(pluginTasks[0].warnings), true);
  assert.deepEqual(JSON.parse(JSON.stringify(pluginTasks)), [{
    label: 'Build',
    kind: 'build',
    type: 'shell',
    source: 'vscode',
    executable: true,
    warnings: ['TASK_PLATFORM_CLOUD_LINUX']
  }]);
  for (const privilegedField of ['command', 'args', 'options', 'sourcePath', 'raw', 'presentation', 'runOptions']) {
    assert.equal(privilegedField in pluginTasks[0], false, `plugin task leaked ${privilegedField}`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(pluginView.getSelected())), { type: 'file', label: '' });
  assert.equal(pluginView.init, undefined);
  assert.equal(pluginView.dispose, undefined);
  assert.equal(pluginView.resolveTask, undefined);

  const commandDescriptions = platform.commands.describe().filter(({ id }) => id.startsWith('bobocloud.tasks.'));
  assert.deepEqual(JSON.parse(JSON.stringify(commandDescriptions)), [
    {
      id: 'bobocloud.tasks.runSelected',
      owner: 'core.tasks',
      title: 'Run Selected Task',
      category: 'Tasks',
      permissions: []
    },
    {
      id: 'bobocloud.tasks.refresh',
      owner: 'core.tasks',
      title: 'Refresh Project Tasks',
      category: 'Tasks',
      permissions: []
    }
  ]);
  assert.equal(await platform.commands.execute('bobocloud.tasks.runSelected'), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await platform.commands.execute('bobocloud.tasks.refresh'))),
    listedConfiguration
  );

  const resolveRequest = {
    label: 'Build',
    context: { activeFile: 'C:\\workspace\\main.ts' },
    inputs: { mode: 'fast' }
  };
  await host.resolve(resolveRequest);
  assert.equal(resolveArguments.label, 'Build');
  assert.equal(resolveArguments.context.activeFile, 'C:\\workspace\\main.ts');
  assert.equal(resolveArguments.inputs.mode, 'fast');

  let configurationChanges = 0;
  const configurationSubscription = host.onConfigurationChanged(() => { configurationChanges += 1; });
  assert.equal(fileSubscriptions, 1);
  fileListener({ path: 'C:\\workspace\\src\\main.ts' });
  fileListener({ path: 'C:\\workspace\\.VSCODE\\TASKS.JSON' });
  fileListener({ path: 'C:/workspace/.bobocloud/tasks.json' });
  assert.equal(configurationChanges, 2);
  configurationSubscription.dispose();
  configurationSubscription.dispose();
  assert.equal(fileUnsubscriptions, 1);

  controller.init();
  controller.init();
  assert.equal(workspaceSubscriptions, 1);
  assert.equal(fileSubscriptions, 2);
  assert.equal(typeof workspaceListener, 'function');
  assert.equal(typeof fileListener, 'function');
  assert.equal(windowListeners.get('bobo:workspace-changed')?.size, 1);
  assert.equal(windowListeners.get('bobo:server-capabilities-changed')?.size, 1);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const listCallsBeforeDispose = listCalls;
  fileListener({ path: 'C:\\workspace\\.vscode\\tasks.json' });
  await platform.dispose();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(workspaceUnsubscriptions, 1);
  assert.equal(fileUnsubscriptions, 2);
  assert.equal(listCalls, listCallsBeforeDispose, 'platform disposal must cancel the pending configuration refresh');
  assert.equal(windowListeners.get('bobo:workspace-changed')?.size || 0, 0);
  assert.equal(windowListeners.get('bobo:server-capabilities-changed')?.size || 0, 0);

  await platform.dispose();
  assert.equal(workspaceUnsubscriptions, 1);
  assert.equal(fileUnsubscriptions, 2);
  assert.equal(platform.services.has('host.projectTasks'), false);
  assert.equal(platform.services.has('workbench.projectTasks'), false);
});

test('Project Tasks reuses the bootstrap registry and only the native adapter reads the bridge', () => {
  const nativeSource = fs.readFileSync(path.join(ROOT, NATIVE_HOST_ADAPTER), 'utf8');
  assert.equal(directBridgeAccessCount(NATIVE_HOST_ADAPTER, nativeSource), 1);
  assert.match(nativeSource, /from\s+['"]\.\/bootstrap['"]/);
  assert.equal(fs.existsSync(path.join(ROOT, 'renderer/core/typed-platform.ts')), false);

  for (const file of PROJECT_TASKS_SLICE) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(directBridgeAccessCount(file, source), 0,
      `Project Tasks module bypasses the native host adapter: ${file}`);
    assert.doesNotMatch(source, /\bcreateRendererPlatform\s*\(/,
      `Project Tasks module creates a second renderer platform: ${file}`);
    assert.doesNotMatch(source, /\bnew\s+ServiceRegistry\s*\(/,
      `Project Tasks module creates a second service registry: ${file}`);
  }

  const runnerSource = fs.readFileSync(path.join(ROOT, 'src/runner.js'), 'utf8');
  assert.doesNotMatch(runnerSource, /\bapi\.tasksResolve\b/);
  assert.match(runnerSource, /\bBOBO\.projectTasks\.resolveTask\s*\(/);
});
