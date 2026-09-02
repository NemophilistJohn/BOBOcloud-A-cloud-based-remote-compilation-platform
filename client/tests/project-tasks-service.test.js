'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
let temporaryDirectory;
let createProjectTasks;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for Project Tasks state');
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }

  dispatch(type, event = {}) {
    if (!Object.hasOwn(event, 'target')) event.target = this;
    for (const listener of [...(this.listeners.get(type) || [])]) listener.call(this, event);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(ownerDocument, tagName, id = '') {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this._id = '';
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.autocomplete = '';
    this.spellcheck = true;
    this.offsetWidth = 300;
    this.offsetHeight = 200;
    this.selectCount = 0;
    this.classList = {
      add: (...names) => this.updateClasses(names, true),
      remove: (...names) => this.updateClasses(names, false),
      contains: (name) => this.classTokens().has(name)
    };
    this.id = id;
  }

  get id() { return this._id; }

  set id(value) {
    if (this._id && this.ownerDocument.elements.get(this._id) === this) {
      this.ownerDocument.elements.delete(this._id);
    }
    this._id = String(value || '');
    if (this._id) this.ownerDocument.elements.set(this._id, this);
  }

  classTokens() {
    return new Set(String(this.className).split(/\s+/).filter(Boolean));
  }

  updateClasses(names, add) {
    const tokens = this.classTokens();
    for (const name of names) {
      if (add) tokens.add(name);
      else tokens.delete(name);
    }
    this.className = [...tokens].join(' ');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'title') this.title = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
      this.parentNode = null;
    }
    if (this.id && this.ownerDocument.elements.get(this.id) === this) {
      this.ownerDocument.elements.delete(this.id);
    }
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  select() {
    this.selectCount += 1;
  }

  click() {
    this.dispatch('click', {
      target: this,
      preventDefault() {},
      stopPropagation() {}
    });
  }

  getBoundingClientRect() {
    return { left: 8, top: 8, right: 40, bottom: 32 };
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (selector === '.run-target-item:not(:disabled)' &&
            child.classTokens().has('run-target-item') && !child.disabled) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.elements = new Map();
    this.activeElement = null;
    this.body = new FakeElement(this, 'body');
    for (const [id, tagName] of [
      ['run-target-menu', 'div'],
      ['run-target-btn', 'button'],
      ['run-code', 'button'],
      ['run-config-btn', 'button'],
      ['runtime-btn', 'button']
    ]) new FakeElement(this, tagName, id);
    this.elements.get('run-target-menu').hidden = true;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  querySelector(selector) {
    if (selector === '#run-target-menu .run-target-item:not(:disabled)') {
      return this.elements.get('run-target-menu')
        ?.querySelectorAll('.run-target-item:not(:disabled)')[0] || null;
    }
    return null;
  }
}

class FakeWindow extends FakeEventTarget {
  constructor() {
    super();
    this.innerWidth = 800;
    this.innerHeight = 600;
    this.nextTimerId = 1;
    this.timers = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  runAllTimers() {
    let turns = 0;
    while (this.timers.size > 0) {
      if (++turns > 50) throw new Error('Project Tasks timer loop did not settle');
      const pending = [...this.timers.entries()];
      this.timers.clear();
      for (const [, timer] of pending) timer.callback();
    }
  }
}

function configuration(label = '', workspaceRoot = 'C:\\workspace') {
  const tasks = label ? [{
    id: 'task-' + label,
    label,
    type: 'process',
    kind: 'build',
    command: 'echo',
    args: [],
    options: {},
    dependsOn: [],
    dependsOrder: 'parallel',
    isDefault: false,
    hide: false,
    executable: true,
    source: 'bobocloud',
    sourcePath: workspaceRoot + '\\.bobocloud\\tasks.json',
    presentation: { reveal: 'always', echo: true, focus: false, clear: false },
    runOptions: { reevaluateOnRerun: true, runOn: 'default' },
    raw: {},
    warnings: []
  }] : [];
  return {
    version: '2.0.0',
    workspaceRoot,
    tasks,
    inputs: [],
    warnings: [],
    sources: []
  };
}

function createHost(overrides = {}) {
  const workspaceListeners = new Set();
  const configurationListeners = new Set();
  let workspaceSubscriptions = 0;
  let workspaceDisposals = 0;
  let configurationSubscriptions = 0;
  let configurationDisposals = 0;
  let listCalls = 0;
  let resolveCalls = 0;
  return {
    host: {
      list() {
        listCalls += 1;
        return overrides.list ? overrides.list(listCalls) : Promise.resolve(configuration());
      },
      resolve(request) {
        resolveCalls += 1;
        return overrides.resolve
          ? overrides.resolve(request, resolveCalls)
          : Promise.resolve({ success: false, error: { code: 'TEST', message: 'not configured' } });
      },
      onWorkspaceOpened(listener) {
        workspaceSubscriptions += 1;
        workspaceListeners.add(listener);
        let active = true;
        return {
          dispose() {
            if (!active) return;
            active = false;
            workspaceDisposals += 1;
            workspaceListeners.delete(listener);
          }
        };
      },
      onConfigurationChanged(listener) {
        configurationSubscriptions += 1;
        configurationListeners.add(listener);
        let active = true;
        return {
          dispose() {
            if (!active) return;
            active = false;
            configurationDisposals += 1;
            configurationListeners.delete(listener);
          }
        };
      }
    },
    emitWorkspaceOpened(event = {}) {
      for (const listener of [...workspaceListeners]) listener(event);
    },
    emitConfigurationChanged() {
      for (const listener of [...configurationListeners]) listener();
    },
    get listCalls() { return listCalls; },
    get resolveCalls() { return resolveCalls; },
    get workspaceSubscriptions() { return workspaceSubscriptions; },
    get workspaceDisposals() { return workspaceDisposals; },
    get configurationSubscriptions() { return configurationSubscriptions; },
    get configurationDisposals() { return configurationDisposals; },
    get workspaceListenerCount() { return workspaceListeners.size; },
    get configurationListenerCount() { return configurationListeners.size; }
  };
}

function createHarness(options = {}) {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const state = options.state || {
    workspaceRoot: 'C:\\workspace',
    workspaceIdentity: 7,
    selectedRuntime: 'node:20',
    activeTabPath: ''
  };
  const hostFixture = options.hostFixture || createHost(options.host || {});
  const storageValues = new Map(Object.entries(options.storage || {}));
  const outputs = [];
  const languageListeners = new Set();
  let languageSubscriptions = 0;
  let languageDisposals = 0;
  let canRerun = false;
  let rerunCalls = 0;
  let refreshControlCalls = 0;
  const runner = {
    runActive: async () => true,
    runProjectTask: async () => true,
    canRerunLastProjectTask: () => canRerun,
    rerunLastProjectTask: () => { rerunCalls += 1; return false; },
    refreshControls: () => { refreshControlCalls += 1; },
    ...(options.runner || {})
  };
  const i18n = {
    t(source, replacements) {
      return String(source).replace(/\{([^}]+)\}/g, (match, key) => (
        replacements && replacements[key] !== undefined ? String(replacements[key]) : match
      ));
    },
    onChange(listener) {
      languageSubscriptions += 1;
      languageListeners.add(listener);
      let active = true;
      return {
        dispose() {
          if (!active) return;
          active = false;
          languageDisposals += 1;
          languageListeners.delete(listener);
        }
      };
    }
  };
  const service = createProjectTasks({
    host: hostFixture.host,
    document,
    window,
    storage: {
      getItem: (key) => storageValues.get(key) ?? null,
      setItem: (key, value) => storageValues.set(key, value)
    },
    getState: () => state,
    getI18n: () => i18n,
    getCloudFeaturePolicy: () => ({ evaluate: () => ({ available: true, state: 'enabled' }) }),
    getRunner: () => runner,
    updateRunOutput: (message) => outputs.push(message)
  });
  return {
    service,
    document,
    window,
    state,
    hostFixture,
    runner,
    outputs,
    storageValues,
    setCanRerun(value) { canRerun = value; },
    get rerunCalls() { return rerunCalls; },
    get refreshControlCalls() { return refreshControlCalls; },
    get languageSubscriptions() { return languageSubscriptions; },
    get languageDisposals() { return languageDisposals; },
    get languageListenerCount() { return languageListeners.size; }
  };
}

test.before(async () => {
  temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-project-tasks-'));
  const output = path.join(temporaryDirectory, 'project-tasks.cjs');
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['src/project-tasks.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'silent'
  });
  ({ createProjectTasks } = require(output));
});

test.after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('dispose and re-init resubscribe once while an older epoch refresh cannot commit', async () => {
  const oldList = deferred();
  const newList = deferred();
  const hostFixture = createHost({ list: (call) => call === 1 ? oldList.promise : newList.promise });
  const harness = createHarness({ hostFixture });

  harness.service.init();
  harness.service.init();
  assert.equal(hostFixture.listCalls, 1);
  assert.equal(hostFixture.workspaceSubscriptions, 1);
  assert.equal(hostFixture.configurationSubscriptions, 1);
  assert.equal(hostFixture.workspaceListenerCount, 1);
  assert.equal(hostFixture.configurationListenerCount, 1);
  assert.equal(harness.languageSubscriptions, 1);
  assert.equal(harness.window.listenerCount('bobo:workspace-changed'), 1);
  assert.equal(harness.window.listenerCount('bobo:server-capabilities-changed'), 1);
  assert.equal(harness.document.getElementById('run-target-btn').listenerCount('click'), 1);
  assert.equal(harness.document.getElementById('run-target-menu').listenerCount('keydown'), 1);

  harness.service.dispose();
  harness.service.dispose();
  assert.equal(hostFixture.workspaceDisposals, 1);
  assert.equal(hostFixture.configurationDisposals, 1);
  assert.equal(hostFixture.workspaceListenerCount, 0);
  assert.equal(hostFixture.configurationListenerCount, 0);
  assert.equal(harness.languageDisposals, 1);
  assert.equal(harness.languageListenerCount, 0);
  assert.equal(harness.window.listenerCount('bobo:workspace-changed'), 0);
  assert.equal(harness.window.listenerCount('bobo:server-capabilities-changed'), 0);
  assert.equal(harness.document.getElementById('run-target-btn').listenerCount('click'), 0);
  assert.equal(harness.document.getElementById('run-target-menu').listenerCount('keydown'), 0);

  harness.service.init();
  harness.service.init();
  assert.equal(hostFixture.listCalls, 2);
  assert.equal(hostFixture.workspaceSubscriptions, 2);
  assert.equal(hostFixture.configurationSubscriptions, 2);
  assert.equal(hostFixture.workspaceListenerCount, 1);
  assert.equal(hostFixture.configurationListenerCount, 1);
  assert.equal(harness.languageSubscriptions, 2);
  assert.equal(harness.languageListenerCount, 1);
  assert.equal(harness.window.listenerCount('bobo:workspace-changed'), 1);
  assert.equal(harness.window.listenerCount('bobo:server-capabilities-changed'), 1);
  assert.equal(harness.document.getElementById('run-target-btn').listenerCount('click'), 1);
  assert.equal(harness.document.getElementById('run-target-menu').listenerCount('keydown'), 1);

  oldList.resolve(configuration('Late task'));
  await nextTurn();
  assert.deepEqual(harness.service.getConfiguration().tasks, []);
  newList.resolve(configuration('Fresh task'));
  await nextTurn();
  assert.equal(harness.service.getConfiguration().tasks[0].label, 'Fresh task');

  harness.service.dispose();
  harness.service.dispose();
  assert.equal(hostFixture.workspaceDisposals, 2);
  assert.equal(hostFixture.configurationDisposals, 2);
  assert.equal(harness.languageDisposals, 2);
  assert.equal(harness.window.listenerCount('bobo:workspace-changed'), 0);
  assert.equal(harness.document.getElementById('run-target-btn').listenerCount('click'), 0);
});

test('overlapping refreshes share one flight and coalesce into one final host read', async () => {
  const first = deferred();
  const second = deferred();
  const hostFixture = createHost({
    list(call) {
      if (call === 1) return first.promise;
      if (call === 2) return second.promise;
      throw new Error('refresh was not coalesced');
    }
  });
  const harness = createHarness({ hostFixture });

  const firstRefresh = harness.service.refresh();
  const secondRefresh = harness.service.refresh();
  const thirdRefresh = harness.service.refresh();
  assert.equal(firstRefresh, secondRefresh);
  assert.equal(secondRefresh, thirdRefresh);
  assert.equal(hostFixture.listCalls, 1);

  first.resolve(configuration('Intermediate'));
  await waitFor(() => hostFixture.listCalls === 2);
  second.resolve(configuration('Final'));
  const results = await Promise.all([firstRefresh, secondRefresh, thirdRefresh]);
  assert.deepEqual(results.map((result) => result.tasks[0].label), ['Final', 'Final', 'Final']);
  assert.equal(harness.service.getConfiguration().tasks[0].label, 'Final');
  assert.equal(hostFixture.listCalls, 2);
  harness.service.dispose();
});

test('configuration event bursts use one timer and at most one trailing refresh', async () => {
  const inFlight = deferred();
  const trailing = deferred();
  const hostFixture = createHost({
    list(call) {
      if (call === 1) return Promise.resolve(configuration('Initial'));
      if (call === 2) return inFlight.promise;
      if (call === 3) return trailing.promise;
      throw new Error('configuration events caused an extra host read');
    }
  });
  const harness = createHarness({ hostFixture });
  harness.service.init();
  await waitFor(() => harness.service.getConfiguration().tasks[0]?.label === 'Initial');

  hostFixture.emitConfigurationChanged();
  hostFixture.emitConfigurationChanged();
  hostFixture.emitConfigurationChanged();
  assert.equal(harness.window.timers.size, 1);
  assert.equal(hostFixture.listCalls, 1);

  harness.window.runAllTimers();
  assert.equal(hostFixture.listCalls, 2);
  hostFixture.emitConfigurationChanged();
  hostFixture.emitConfigurationChanged();
  assert.equal(harness.window.timers.size, 1);
  harness.window.runAllTimers();
  hostFixture.emitConfigurationChanged();
  harness.window.runAllTimers();
  assert.equal(hostFixture.listCalls, 2, 'events during the flight queue rather than overlap another read');

  inFlight.resolve(configuration('Intermediate'));
  await waitFor(() => hostFixture.listCalls === 3);
  trailing.resolve(configuration('Final'));
  await waitFor(() => harness.service.getConfiguration().tasks[0]?.label === 'Final');
  assert.equal(hostFixture.listCalls, 3);
  assert.equal(harness.window.timers.size, 0);
  harness.service.dispose();
});

test('a refresh from an older workspace identity is ignored before a current result commits', async () => {
  const stale = deferred();
  const current = deferred();
  const hostFixture = createHost({ list: (call) => call === 1 ? stale.promise : current.promise });
  const harness = createHarness({ hostFixture });

  const staleRefresh = harness.service.refresh();
  harness.state.workspaceIdentity = 8;
  stale.resolve(configuration('Stale'));
  await staleRefresh;
  assert.deepEqual(harness.service.getConfiguration().tasks, []);

  const currentRefresh = harness.service.refresh();
  current.resolve(configuration('Current'));
  await currentRefresh;
  assert.equal(harness.service.getConfiguration().tasks[0].label, 'Current');
  harness.service.dispose();
});

test('a host snapshot for another root is rejected while a normalized current root commits', async () => {
  const wrongRoot = deferred();
  const currentRoot = deferred();
  const hostFixture = createHost({ list: (call) => call === 1 ? wrongRoot.promise : currentRoot.promise });
  const harness = createHarness({
    hostFixture,
    state: {
      workspaceRoot: 'C:\\Workspace\\Project\\',
      workspaceIdentity: 7,
      selectedRuntime: 'node:20'
    }
  });

  const rejected = harness.service.refresh();
  wrongRoot.resolve(configuration('Wrong root', 'D:\\Other'));
  await rejected;
  assert.deepEqual(harness.service.getConfiguration().tasks, []);

  const accepted = harness.service.refresh();
  currentRoot.resolve(configuration('Current root', 'c:/workspace/project'));
  await accepted;
  assert.equal(harness.service.getConfiguration().tasks[0].label, 'Current root');
  harness.service.dispose();
});

test('POSIX and Windows filesystem roots stay distinct from empty and normalize safely', async () => {
  const posixHost = createHost({
    list: (call) => call === 1 ? Promise.resolve(configuration('Empty root', '')) : Promise.resolve(configuration('POSIX root', '/'))
  });
  const posixHarness = createHarness({
    hostFixture: posixHost,
    state: { workspaceRoot: '/', workspaceIdentity: 7, selectedRuntime: 'node:20' }
  });

  await posixHarness.service.refresh();
  assert.deepEqual(posixHarness.service.getConfiguration().tasks, []);
  await posixHarness.service.refresh();
  assert.equal(posixHarness.service.getConfiguration().tasks[0].label, 'POSIX root');
  posixHarness.service.dispose();

  const windowsHost = createHost({ list: () => Promise.resolve(configuration('Windows root', 'c:/')) });
  const windowsHarness = createHarness({
    hostFixture: windowsHost,
    state: { workspaceRoot: 'C:\\', workspaceIdentity: 7, selectedRuntime: 'node:20' }
  });

  await windowsHarness.service.refresh();
  assert.equal(windowsHarness.service.getConfiguration().tasks[0].label, 'Windows root');
  windowsHarness.service.dispose();
});

test('task inputs reject a changed workspace identity and explicit cancellation settles once', async () => {
  const harness = createHarness();
  const request = {
    id: 'name',
    type: 'promptString',
    description: 'Name',
    default: 'guest',
    password: false,
    options: []
  };

  const changedIdentity = harness.service.resolveInputRequests([request]);
  harness.window.runAllTimers();
  const overlay = harness.document.getElementById('task-input-dialog');
  const card = overlay.children[0];
  const control = card.children[0].children[2].children[0];
  control.value = 'accepted';
  harness.state.workspaceIdentity = 8;
  card.dispatch('submit', { target: card, preventDefault() {} });
  assert.equal(await changedIdentity, null);

  const cancelled = harness.service.resolveInputRequests([request]);
  harness.window.runAllTimers();
  assert.equal(harness.service.cancelInput(), true);
  assert.equal(await cancelled, null);
  assert.equal(harness.service.cancelInput(), false);
  harness.service.dispose();
  assert.equal(harness.document.getElementById('task-input-dialog'), null);
});

test('resolveTask preserves the structured request and delegates only to the host service', async () => {
  const expected = { success: false, error: { code: 'TASK_TEST', message: 'test result' } };
  let received;
  const hostFixture = createHost({
    resolve(request) {
      received = request;
      return Promise.resolve(expected);
    }
  });
  const harness = createHarness({ hostFixture });
  const request = {
    label: 'Build',
    context: { activeFile: 'C:\\workspace\\main.ts', lineNumber: 4 },
    inputs: { mode: 'fast' }
  };

  assert.equal(await harness.service.resolveTask(request), expected);
  assert.equal(received, request);
  assert.equal(hostFixture.resolveCalls, 1);
  harness.service.dispose();
});

test('rerun remains a bottom command and never mutates the selected target', async () => {
  const harness = createHarness({ state: { workspaceRoot: '', workspaceIdentity: 0, selectedRuntime: 'node:20' } });
  harness.service.init();
  const trigger = harness.document.getElementById('run-target-btn');
  const menu = harness.document.getElementById('run-target-menu');

  trigger.click();
  let command = menu.children.at(-1);
  assert.equal(command.className, 'run-target-item run-target-command');
  assert.equal(command.getAttribute('role'), 'menuitem');
  assert.equal(command.getAttribute('aria-checked'), null);
  assert.equal(command.disabled, true);
  assert.equal(command.children[1].textContent, 'Rerun Last Task');
  assert.equal(menu.children.at(-2).getAttribute('role'), 'separator');

  trigger.click();
  harness.setCanRerun(true);
  trigger.click();
  command = menu.children.at(-1);
  assert.equal(command.disabled, false);
  const selectionBefore = harness.service.getSelected();
  command.click();
  assert.equal(menu.hidden, true);
  assert.equal(harness.rerunCalls, 1);
  assert.deepEqual(harness.service.getSelected(), selectionBefore);
  harness.service.dispose();
});
