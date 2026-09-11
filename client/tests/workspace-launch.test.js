'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/workspace-launch.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node20'],
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;
const SERVICE_MODULE = { exports: {} };
new Function('require', 'module', 'exports', SERVICE_BUNDLE)(
  require,
  SERVICE_MODULE,
  SERVICE_MODULE.exports
);
const { createWorkspaceLaunchService, RECENT_WORKSPACE_STORAGE_KEY } = SERVICE_MODULE.exports;

class FakeButton {
  constructor() {
    this.disabled = false;
    this.attributes = new Map();
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  click() {
    (this.listeners.get('click') || []).forEach((listener) => listener({
      target: this,
      preventDefault() {},
      stopPropagation() {}
    }));
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function createDocument(buttons) {
  return {
    getElementById: (id) => buttons[id] || null,
    querySelectorAll: () => []
  };
}

function createHost({ pick } = {}) {
  let listener = null;
  return {
    pick: pick || (async () => null),
    forgetRecent: async () => true,
    onDidOpen(next) {
      listener = next;
      return { dispose() { listener = null; } };
    },
    emit(opened) {
      if (listener) listener(opened);
    },
    get listener() { return listener; }
  };
}

function createI18n() {
  const listeners = new Set();
  return {
    t(source, replacements) {
      return replacements && replacements.name
        ? String(source).replace('{name}', replacements.name)
        : String(source);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() { listeners.forEach((listener) => listener()); },
    get size() { return listeners.size; }
  };
}

function createService({ host, buttons, storage, i18n } = {}) {
  const service = createWorkspaceLaunchService({
    document: createDocument(buttons || {}),
    host: host || createHost(),
    storage: storage || null,
    getI18n: () => i18n || null,
    reportError: () => {}
  });
  service.init();
  return service;
}

test('workspace launch captures the first-frame click and applies it once services are ready', async () => {
  const buttons = {
    'open-folder': new FakeButton(),
    'empty-state-open': new FakeButton()
  };
  const picked = deferred();
  const pickArguments = [];
  const host = createHost({
    pick: (directoryPath) => {
      pickArguments.push(directoryPath);
      return picked.promise;
    }
  });
  const service = createService({ host, buttons });

  buttons['empty-state-open'].click();
  buttons['open-folder'].click();
  assert.deepEqual(pickArguments, [undefined], 'concurrent startup clicks must share one picker request');
  assert.equal(buttons['empty-state-open'].disabled, true);
  assert.equal(buttons['open-folder'].getAttribute('aria-busy'), 'true');

  const firstWorkspace = {
    rootPath: 'C:\\workspace',
    tree: { name: 'workspace', path: 'C:\\workspace', type: 'folder', children: [] },
    workspaceIdentity: 1,
    leaveToken: null,
    teamMapping: null
  };
  picked.resolve(firstWorkspace);
  await picked.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(buttons['empty-state-open'].disabled, true, 'selection stays busy until the workspace is applied');
  buttons['open-folder'].click();
  assert.deepEqual(pickArguments, [undefined], 'a buffered selection blocks a second picker');

  const applied = [];
  await service.setConsumer(async (opened) => { applied.push(opened); });
  assert.deepEqual(applied, [firstWorkspace]);
  assert.equal(buttons['empty-state-open'].disabled, false);

  const menuWorkspace = {
    rootPath: 'C:\\menu-workspace',
    tree: { name: 'menu-workspace', path: 'C:\\menu-workspace', type: 'folder', children: [] },
    workspaceIdentity: 2,
    leaveToken: null,
    teamMapping: null
  };
  host.emit(menuWorkspace);
  await service.whenIdle();
  assert.deepEqual(applied, [firstWorkspace, menuWorkspace]);
  service.dispose();
  assert.equal(host.listener, null, 'registry disposal removes the host listener');
});

test('workspace launch keeps five successful recent projects in most-recent order', async () => {
  const values = new Map();
  const opened = [];
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value)
  };
  const host = createHost({
    pick: async (directoryPath) => ({
      rootPath: directoryPath,
      tree: { name: 'workspace', path: directoryPath, type: 'folder', children: [] },
      workspaceIdentity: opened.length + 1,
      leaveToken: null,
      teamMapping: null
    })
  });
  const service = createService({ host, storage });
  await service.setConsumer(async (workspace) => {
    opened.push(workspace.rootPath);
    return workspace.rootPath !== 'C:\\rejected';
  });
  const storedProjects = () => JSON.parse(values.get(RECENT_WORKSPACE_STORAGE_KEY) || '[]');

  for (let index = 1; index <= 6; index += 1) {
    await service.requestOpen(`C:\\projects\\project-${index}\\`);
  }
  assert.deepEqual(storedProjects(), [
    'C:\\projects\\project-6',
    'C:\\projects\\project-5',
    'C:\\projects\\project-4',
    'C:\\projects\\project-3',
    'C:\\projects\\project-2'
  ]);

  await service.requestOpen('c:\\PROJECTS\\project-4');
  assert.deepEqual(storedProjects(), [
    'c:\\PROJECTS\\project-4',
    'C:\\projects\\project-6',
    'C:\\projects\\project-5',
    'C:\\projects\\project-3',
    'C:\\projects\\project-2'
  ], 'Windows paths are deduplicated case-insensitively and moved to the front');

  await service.requestOpen('C:\\rejected');
  assert.equal(storedProjects().includes('C:\\rejected'), false);
});

test('workspace launch refreshes translated recent controls and ignores late events after disposal', async () => {
  const i18n = createI18n();
  const host = createHost();
  const service = createService({ host, i18n });
  assert.equal(i18n.size, 1);
  service.dispose();
  assert.equal(i18n.size, 0);
  host.emit({
    rootPath: 'C:\\late',
    tree: { name: 'late', path: 'C:\\late', type: 'folder' },
    workspaceIdentity: 3,
    leaveToken: null,
    teamMapping: null
  });
  await service.whenIdle();
  assert.equal(service.disposed, true);
});
