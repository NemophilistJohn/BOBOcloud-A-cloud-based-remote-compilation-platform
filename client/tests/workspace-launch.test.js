const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

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

  click() {
    (this.listeners.get('click') || []).forEach(listener => listener({ target: this }));
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
}

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

test('workspace launch captures the first-frame click and applies it once services are ready', async () => {
  const buttons = {
    'open-folder': new FakeButton(),
    'empty-state-open': new FakeButton()
  };
  const picked = deferred();
  const pickArguments = [];
  let openedListener = null;
  const sandbox = {
    api: {
      pickWorkspace: directoryPath => {
        pickArguments.push(directoryPath);
        return picked.promise;
      },
      onWorkspaceOpened: listener => { openedListener = listener; }
    },
    BOBO: {},
    console,
    document: { getElementById: id => buttons[id] || null },
    Promise,
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'workspace-launch.js'), 'utf8'), sandbox, {
    filename: 'src/workspace-launch.js'
  });

  buttons['empty-state-open'].click();
  buttons['open-folder'].click();
  assert.deepEqual(pickArguments, [undefined], 'concurrent startup clicks must share one picker request');
  assert.equal(buttons['empty-state-open'].disabled, true);
  assert.equal(buttons['open-folder'].getAttribute('aria-busy'), 'true');

  const firstWorkspace = { rootPath: 'C:\\workspace', tree: { children: [] }, workspaceIdentity: 1 };
  picked.resolve(firstWorkspace);
  await picked.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(buttons['empty-state-open'].disabled, true, 'selection stays busy until the workspace is applied');
  buttons['open-folder'].click();
  assert.deepEqual(pickArguments, [undefined], 'a buffered selection blocks a second picker');

  const applied = [];
  await sandbox.BOBO.workspaceLaunch.setConsumer(async opened => { applied.push(opened); });
  assert.deepEqual(applied, [firstWorkspace]);
  assert.equal(buttons['empty-state-open'].disabled, false);

  const menuWorkspace = { rootPath: 'C:\\menu-workspace', tree: { children: [] }, workspaceIdentity: 2 };
  openedListener(menuWorkspace);
  await sandbox.BOBO.workspaceLaunch.whenIdle();
  assert.deepEqual(applied, [firstWorkspace, menuWorkspace]);
});

test('workspace launch keeps five successful recent projects in most-recent order', async () => {
  const values = new Map();
  const opened = [];
  const sandbox = {
    api: {
      pickWorkspace: async directoryPath => ({ rootPath: directoryPath, tree: { children: [] }, workspaceIdentity: opened.length + 1 })
    },
    BOBO: {},
    console,
    document: {
      getElementById: () => null,
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, value)
    },
    Promise,
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'workspace-launch.js'), 'utf8'), sandbox, {
    filename: 'src/workspace-launch.js'
  });
  await sandbox.BOBO.workspaceLaunch.setConsumer(async workspace => {
    opened.push(workspace.rootPath);
    return workspace.rootPath !== 'C:\\rejected';
  });
  const storedProjects = () => JSON.parse(values.get('bobocloud.recentProjects.v1') || '[]');

  for (let index = 1; index <= 6; index += 1) {
    await sandbox.BOBO.workspaceLaunch.requestOpen(`C:\\projects\\project-${index}\\`);
  }
  assert.deepEqual(storedProjects(), [
    'C:\\projects\\project-6',
    'C:\\projects\\project-5',
    'C:\\projects\\project-4',
    'C:\\projects\\project-3',
    'C:\\projects\\project-2'
  ]);

  await sandbox.BOBO.workspaceLaunch.requestOpen('c:\\PROJECTS\\project-4');
  assert.deepEqual(storedProjects(), [
    'c:\\PROJECTS\\project-4',
    'C:\\projects\\project-6',
    'C:\\projects\\project-5',
    'C:\\projects\\project-3',
    'C:\\projects\\project-2'
  ], 'Windows paths are deduplicated case-insensitively and moved to the front');

  await sandbox.BOBO.workspaceLaunch.requestOpen('C:\\rejected');
  assert.equal(storedProjects().includes('C:\\rejected'), false);
});
