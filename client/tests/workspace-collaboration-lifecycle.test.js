'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const workspaceSource = fs.readFileSync(path.join(projectRoot, 'src/workspace.js'), 'utf8');
const collaborationSource = fs.readFileSync(path.join(projectRoot, 'src/collaboration.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(message || 'Timed out waiting for lifecycle state');
}

function createClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    toggle(value, force) {
      if (force === true) values.add(value);
      else if (force === false) values.delete(value);
      else if (values.has(value)) values.delete(value);
      else values.add(value);
    },
    contains(value) { return values.has(value); }
  };
}

function createElement() {
  return {
    classList: createClassList(),
    style: {},
    attributes: {},
    childNodes: [],
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    isConnected: true,
    appendChild(child) { this.childNodes.push(child); return child; },
    insertBefore(child) { this.childNodes.unshift(child); return child; },
    prepend(child) { this.childNodes.unshift(child); return child; },
    remove() {},
    focus() {},
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; },
    getClientRects() { return [1]; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

function createModel(initialValue) {
  let value = initialValue;
  let version = 1;
  return {
    getValue() { return value; },
    getVersionId() { return version; },
    setValue(next) { value = next; version += 1; }
  };
}

function createEditor(model) {
  return {
    readOnly: false,
    updateOptions(options) { this.readOnly = options.readOnly === true; },
    type(nextValue) {
      if (this.readOnly) return false;
      model.setValue(nextValue);
      return true;
    }
  };
}

function loadWorkspace(overrides) {
  overrides = overrides || {};
  const model = overrides.model || createModel('dirty content');
  const editor = createEditor(model);
  const splitEditor = createEditor(model);
  const splitRightEditor = createEditor(model);
  splitEditor.rightEditor = splitRightEditor;
  const tab = { path: 'C:\\workspace\\main.txt', name: 'main.txt', model, dirty: true, language: 'plaintext' };
  const state = {
    tabs: [tab],
    activeTabPath: tab.path,
    workspaceRoot: 'C:\\workspace',
    workspaceTree: null,
    workspaceIdentity: 7,
    workspaceGeneration: 3,
    workspaceTransitionLocked: false,
    workspaceTransitionToken: null,
    workspaceTransitionEditorStates: null,
    workspaceLeaveApprovals: new Map(),
    expandedPaths: new Set(),
    editor,
    splitEditor
  };
  const elements = {
    tabbar: createElement(),
    'workspace-label': createElement()
  };
  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelectorAll() { return []; },
    createElement() { return createElement(); }
  };
  const api = Object.assign({
    chooseWorkspaceLeave() { return Promise.resolve('cancel'); },
    saveFile() { return Promise.resolve({ success: true }); }
  }, overrides.api || {});
  const errors = [];
  const BOBO = {
    state,
    runner: { prepareWorkspaceLeave() { return Promise.resolve(); } },
    toast: { error(message) { errors.push(message); } }
  };
  const windowObject = {
    BOBO,
    api,
    addEventListener() {},
    dispatchEvent() {}
  };
  vm.runInNewContext(workspaceSource, {
    window: windowObject,
    document,
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    Map,
    Set,
    Promise,
    Date,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }, { filename: 'src/workspace.js' });
  return { BOBO: windowObject.BOBO, state, tab, model, editor, splitEditor, splitRightEditor, errors };
}

test('Save choice freezes normal editor input before save I/O starts', async () => {
  const choice = deferred();
  const save = deferred();
  const saveObservations = [];
  let fixture;
  fixture = loadWorkspace({
    api: {
      chooseWorkspaceLeave() { return choice.promise; },
      saveFile(payload) {
        saveObservations.push({
          payload,
          locked: fixture.state.workspaceTransitionLocked,
          editorReadOnly: fixture.editor.readOnly,
          splitReadOnly: fixture.splitEditor.readOnly,
          splitRightReadOnly: fixture.splitRightEditor.readOnly
        });
        return save.promise;
      }
    }
  });

  const leaving = fixture.BOBO.workspace.canLeaveWorkspace({ reason: 'switch', leaveToken: 'save-token' });
  await Promise.resolve();
  assert.equal(fixture.state.workspaceTransitionLocked, false, 'dialog phase should not lock the editor');

  choice.resolve('save');
  await waitFor(() => saveObservations.length === 1, 'save did not start');
  assert.equal(saveObservations[0].payload.filePath, fixture.tab.path);
  assert.equal(saveObservations[0].payload.content, 'dirty content');
  assert.equal(saveObservations[0].locked, true);
  assert.equal(saveObservations[0].editorReadOnly, true);
  assert.equal(saveObservations[0].splitReadOnly, true);
  assert.equal(saveObservations[0].splitRightReadOnly, true);
  assert.equal(fixture.editor.type('edit attempted during save'), false);
  assert.equal(fixture.model.getValue(), 'dirty content');
  assert.equal(fixture.tab.dirty, true);

  save.resolve({ success: true });
  assert.equal(await leaving, true);
  assert.equal(fixture.tab.dirty, false);
  assert.equal(fixture.state.workspaceTransitionLocked, true, 'approved transition stays frozen until consumed or aborted');
});

test('failed Save choice unlocks and preserves the dirty model', async () => {
  const originalModel = createModel('unsaved content');
  const fixture = loadWorkspace({
    model: originalModel,
    api: {
      chooseWorkspaceLeave() { return Promise.resolve('save'); },
      saveFile() { return Promise.reject(new Error('disk full')); }
    }
  });

  const allowed = await fixture.BOBO.workspace.canLeaveWorkspace({ reason: 'switch', leaveToken: 'failed-save-token' });

  assert.equal(allowed, false);
  assert.equal(fixture.state.workspaceTransitionLocked, false);
  assert.equal(fixture.state.workspaceTransitionToken, null);
  assert.equal(fixture.editor.readOnly, false);
  assert.equal(fixture.splitEditor.readOnly, true);
  assert.equal(fixture.splitRightEditor.readOnly, false);
  assert.equal(fixture.state.tabs.length, 1);
  assert.equal(fixture.state.tabs[0].model, originalModel);
  assert.equal(fixture.state.tabs[0].dirty, true);
  assert.equal(originalModel.getValue(), 'unsaved content');
  assert.match(fixture.errors.at(-1), /disk full/);
  assert.equal(fixture.editor.type('editing resumes'), true);
  assert.equal(originalModel.getValue(), 'editing resumes');
});

test('a newer editor version stays dirty when an older save finishes', async () => {
  const save = deferred();
  const payloads = [];
  const fixture = loadWorkspace({
    api: {
      saveFile(payload) {
        payloads.push(payload);
        return save.promise;
      }
    }
  });

  const saving = fixture.BOBO.workspace.saveAllTabs();
  await waitFor(() => payloads.length === 1, 'save did not start');
  fixture.model.setValue('newer unsaved content');
  save.resolve(true);

  assert.equal(await saving, false);
  assert.equal(payloads[0].content, 'dirty content');
  assert.match(payloads[0].mutationId, /^workspace-save-7-3-/);
  assert.equal(fixture.tab.dirty, true);
  assert.equal(fixture.model.getValue(), 'newer unsaved content');
});

test('a renamed tab and a replaced workspace cannot be cleared by an older save', async () => {
  for (const changeContext of ['path', 'workspace']) {
    const save = deferred();
    const payloads = [];
    const fixture = loadWorkspace({
      api: {
        saveFile(payload) {
          payloads.push(payload);
          return save.promise;
        }
      }
    });
    const originalPath = fixture.tab.path;
    const saving = fixture.BOBO.workspace.saveAllTabs();
    await waitFor(() => payloads.length === 1, 'save did not start');
    if (changeContext === 'path') fixture.tab.path = 'C:\\workspace\\renamed.txt';
    else {
      fixture.state.workspaceIdentity += 1;
      fixture.state.workspaceGeneration += 1;
    }
    save.resolve(true);

    assert.equal(await saving, false, changeContext + ' change must invalidate the save result');
    assert.equal(payloads[0].filePath, originalPath);
    assert.equal(fixture.tab.dirty, true);
  }
});

function createMemoryStorage(initialEntries) {
  const entries = new Map(initialEntries || []);
  return {
    get length() { return entries.size; },
    key(index) { return Array.from(entries.keys())[index] || null; },
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
    has(key) { return entries.has(key); }
  };
}

function loadCollaboration(options) {
  options = options || {};
  const project = { id: 'project-1', team_id: 'team-1', name: 'Compiler' };
  const current = {
    teamId: project.team_id,
    teamName: 'Team One',
    projectId: project.id,
    projectName: project.name,
    branch: 'main',
    localPath: 'C:\\workspace'
  };
  const modelMarker = { value: 'dirty team file' };
  const state = {
    auth: { user: { id: 'user-1', uid: 'U001', name: 'Tester' }, token: 'token' },
    serverSettings: { ip: 'compiler.example' },
    collaboration: { current, teams: [] },
    workspaceRoot: current.localPath,
    workspaceIdentity: 7,
    tabs: [{ path: current.localPath + '\\main.go', model: modelMarker, dirty: true }],
    workspaceTransitionLocked: false,
    activePanel: 'output'
  };
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  }
  element('collab-action-body').querySelector = selector => /input/.test(selector) ? element('action-delete-project-name') : null;
  const document = {
    activeElement: null,
    getElementById(id) { return element(id); },
    querySelectorAll() { return []; },
    createElement() { return createElement(); }
  };
  const mappingKey = 'bobo-team-map-v1:compiler.example:U001:team-1:project-1:main';
  const localStorage = createMemoryStorage([[mappingKey, current.localPath]]);
  const events = [];
  let closeCalls = 0;
  let abortCalls = 0;
  let applyCalls = 0;
  const BOBO = {
    state,
    sendToServer(action, data) {
      events.push({ type: 'api', action, data });
      return options.sendToServer ? options.sendToServer(action, data) : Promise.resolve({ success: true, data: null });
    },
    workspace: {
      async canLeaveWorkspace(details) {
        events.push({ type: 'canLeave', details });
        const allowed = options.canLeave == null ? true : await options.canLeave(details);
        if (allowed) state.workspaceTransitionLocked = true;
        return allowed;
      },
      async closeWorkspace(details) {
        closeCalls += 1;
        events.push({ type: 'closeWorkspace', details });
        state.workspaceRoot = null;
        state.tabs = [];
        state.workspaceTransitionLocked = false;
        return true;
      },
      abortWorkspaceLeave() {
        abortCalls += 1;
        events.push({ type: 'abortWorkspaceLeave' });
        state.workspaceTransitionLocked = false;
        return true;
      },
      async applyWorkspace(rootPath, tree, workspaceIdentity, leaveToken, details) {
        applyCalls += 1;
        events.push({ type: 'applyWorkspace', rootPath, tree, workspaceIdentity, leaveToken, details });
        const applied = options.applyWorkspace == null
          ? true
          : await options.applyWorkspace(rootPath, tree, workspaceIdentity, leaveToken, details);
        if (applied) {
          state.workspaceRoot = rootPath;
          state.workspaceIdentity = workspaceIdentity;
          state.tabs = [];
          state.workspaceTransitionLocked = false;
        }
        return applied;
      }
    },
    rclone: {
      async pull(details) {
        events.push({ type: 'pull', details });
        return options.pull ? options.pull(details) : { success: true };
      }
    },
    toast: { info() {}, success() {}, error() {} },
    workbench: { refreshContext() {} }
  };
  const windowApi = Object.assign({
    async localPathInfo(localPath) {
      events.push({ type: 'localPathInfo', localPath });
      return { exists: true, directory: true, empty: false, grantId: 'active-workspace-grant' };
    },
    async writeTeamMapping(details) {
      events.push({ type: 'writeTeamMapping', details });
      return true;
    },
    async pickWorkspace(localPath) {
      events.push({ type: 'pickWorkspace', localPath });
      return { rootPath: localPath, tree: { path: localPath }, workspaceIdentity: 8, leaveToken: 'pick-token' };
    },
    async readTree(localPath) {
      events.push({ type: 'readTree', localPath });
      return { path: localPath, type: 'folder', children: [] };
    },
    async refreshWorkspace() {
      events.push({ type: 'refreshWorkspace' });
      return { path: state.workspaceRoot, type: 'folder', children: [] };
    },
    async getWorkspaceIdentity() {
      events.push({ type: 'getWorkspaceIdentity' });
      return { rootPath: state.workspaceRoot, workspaceIdentity: state.workspaceIdentity };
    }
  }, options.windowApi || {});
  const instrumentedSource = collaborationSource.replace(
    /\}\)\(window\);\s*$/,
    'BOBO.collaboration.__test = { deleteProject: deleteProject, manualPull: manualPull, openProject: openProject, runActionConfirm: runActionConfirm };\n})(window);'
  );
  assert.notEqual(instrumentedSource, collaborationSource, 'collaboration test hooks were not injected');
  const windowObject = { BOBO, api: windowApi, addEventListener() {} };
  vm.runInNewContext(instrumentedSource, {
    window: windowObject,
    document,
    localStorage,
    navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
    URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    Image: function Image() {},
    Promise,
    Date,
    console,
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {}
  }, { filename: 'src/collaboration.js' });
  element('action-delete-project-name').value = project.name;

  return {
    BOBO: windowObject.BOBO,
    hooks: windowObject.BOBO.collaboration.__test,
    project,
    current,
    modelMarker,
    state,
    events,
    localStorage,
    mappingKey,
    closeCalls: () => closeCalls,
    abortCalls: () => abortCalls,
    applyCalls: () => applyCalls,
    element
  };
}

test('deleting the current team project stops before the API when leave is cancelled', async () => {
  const fixture = loadCollaboration({ canLeave: async () => false });

  fixture.hooks.deleteProject(fixture.project);
  await fixture.hooks.runActionConfirm();

  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].type, 'canLeave');
  assert.equal(fixture.events[0].details.reason, 'project-deleted');
  assert.equal(fixture.closeCalls(), 0);
  assert.equal(fixture.abortCalls(), 0);
  assert.equal(fixture.state.collaboration.current, fixture.current);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs[0].model, fixture.modelMarker);
  assert.equal(fixture.localStorage.has(fixture.mappingKey), true);
});

test('failed current team project deletion unlocks and preserves the workspace', async () => {
  const fixture = loadCollaboration({
    canLeave: async () => true,
    sendToServer(action) {
      assert.equal(action, 'deleteTeamProject');
      return Promise.resolve({ success: false, error: 'delete failed' });
    }
  });

  fixture.hooks.deleteProject(fixture.project);
  await fixture.hooks.runActionConfirm();

  assert.deepEqual(fixture.events.map(event => event.type === 'api' ? 'api:' + event.action : event.type), [
    'canLeave',
    'api:deleteTeamProject',
    'abortWorkspaceLeave'
  ]);
  assert.equal(fixture.closeCalls(), 0);
  assert.equal(fixture.abortCalls(), 1);
  assert.equal(fixture.state.workspaceTransitionLocked, false);
  assert.equal(fixture.state.collaboration.current, fixture.current);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs[0].model, fixture.modelMarker);
  assert.equal(fixture.state.tabs[0].dirty, true);
  assert.equal(fixture.localStorage.has(fixture.mappingKey), true);
});

test('successful current team project deletion closes only after the API succeeds', async () => {
  const deletion = deferred();
  let deleteResolved = false;
  const fixture = loadCollaboration({
    canLeave: async () => true,
    sendToServer(action) {
      if (action === 'deleteTeamProject') {
        return deletion.promise.then(result => {
          deleteResolved = true;
          return result;
        });
      }
      if (action === 'getTeam') return Promise.resolve({ success: false, error: 'refresh skipped' });
      throw new Error('Unexpected API action: ' + action);
    }
  });

  fixture.hooks.deleteProject(fixture.project);
  const confirming = fixture.hooks.runActionConfirm();
  await waitFor(() => fixture.events.some(event => event.type === 'api' && event.action === 'deleteTeamProject'));
  assert.equal(fixture.state.workspaceTransitionLocked, true);
  assert.equal(fixture.closeCalls(), 0);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);

  deletion.resolve({ success: true, data: null });
  await confirming;

  const sequence = fixture.events.map(event => event.type === 'api' ? 'api:' + event.action : event.type);
  assert.deepEqual(sequence.slice(0, 4), [
    'canLeave',
    'api:deleteTeamProject',
    'closeWorkspace',
    'api:getTeam'
  ]);
  assert.equal(deleteResolved, true);
  assert.equal(fixture.closeCalls(), 1);
  assert.equal(fixture.abortCalls(), 0);
  assert.equal(fixture.state.workspaceRoot, null);
  assert.equal(fixture.state.tabs.length, 0);
  assert.equal(fixture.state.collaboration.current, null);
  assert.equal(fixture.localStorage.has(fixture.mappingKey), false);
});

function eventSequence(fixture) {
  return fixture.events.map(event => event.type === 'api' ? 'api:' + event.action : event.type);
}

function prepareProjectResponse(action) {
  if (action === 'prepareTeamProject') {
    return Promise.resolve({ success: true, data: { remote_path: 'remote:team/project/main' } });
  }
  throw new Error('Unexpected API action: ' + action);
}

test('manual pull cancellation leaves the dirty same-path workspace untouched', async () => {
  const fixture = loadCollaboration({
    canLeave: async () => false,
    sendToServer: prepareProjectResponse
  });

  fixture.hooks.manualPull();
  await fixture.hooks.runActionConfirm();

  assert.deepEqual(eventSequence(fixture), ['canLeave']);
  assert.equal(fixture.events[0].details.targetRoot, fixture.current.localPath);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs.length, 1);
  assert.equal(fixture.state.tabs[0].model, fixture.modelMarker);
  assert.equal(fixture.state.tabs[0].dirty, true);
  assert.equal(fixture.state.workspaceTransitionLocked, false);
  assert.equal(fixture.applyCalls(), 0);
  assert.equal(fixture.abortCalls(), 0);
});

test('approved manual pull refreshes and applies the current workspace', async () => {
  const fixture = loadCollaboration({
    canLeave: async () => true,
    sendToServer: prepareProjectResponse
  });

  fixture.hooks.manualPull();
  await fixture.hooks.runActionConfirm();

  assert.deepEqual(eventSequence(fixture), [
    'canLeave',
    'api:prepareTeamProject',
    'pull',
    'refreshWorkspace',
    'getWorkspaceIdentity',
    'applyWorkspace'
  ]);
  const apply = fixture.events.at(-1);
  assert.equal(apply.rootPath, fixture.current.localPath);
  assert.equal(apply.workspaceIdentity, 7);
  assert.equal(apply.details.approved, true);
  assert.equal(fixture.applyCalls(), 1);
  assert.equal(fixture.abortCalls(), 0);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs.length, 0);
  assert.equal(fixture.state.workspaceTransitionLocked, false);
});

test('failed manual pull unlocks and preserves the dirty current workspace', async () => {
  const fixture = loadCollaboration({
    canLeave: async () => true,
    sendToServer: prepareProjectResponse,
    pull: async () => ({ success: false, error: { message: 'pull failed' } })
  });

  fixture.hooks.manualPull();
  await fixture.hooks.runActionConfirm();

  assert.deepEqual(eventSequence(fixture), [
    'canLeave',
    'api:prepareTeamProject',
    'pull',
    'abortWorkspaceLeave'
  ]);
  assert.equal(fixture.abortCalls(), 1);
  assert.equal(fixture.applyCalls(), 0);
  assert.equal(fixture.state.workspaceTransitionLocked, false);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs.length, 1);
  assert.equal(fixture.state.tabs[0].model, fixture.modelMarker);
  assert.equal(fixture.state.tabs[0].dirty, true);
});

async function prepareSamePathOpenProject(fixture) {
  await fixture.hooks.openProject(fixture.project, 'main');
  fixture.element('action-open-branch').value = 'main';
  fixture.element('action-mapping-path').setAttribute('data-path', fixture.current.localPath);
  fixture.element('action-open-mode').value = 'pull';
}

function openProjectServer(action) {
  if (action === 'listTeamBranches') {
    return Promise.resolve({ success: true, data: [{ name: 'main' }] });
  }
  return prepareProjectResponse(action);
}

test('same-path open-project pull cancellation stops before prepare and pull', async () => {
  const fixture = loadCollaboration({
    canLeave: async () => false,
    sendToServer: openProjectServer
  });
  await prepareSamePathOpenProject(fixture);

  await fixture.hooks.runActionConfirm();

  assert.deepEqual(eventSequence(fixture), [
    'api:listTeamBranches',
    'localPathInfo',
    'canLeave'
  ]);
  const leave = fixture.events.find(event => event.type === 'canLeave');
  assert.equal(leave.details.targetRoot, fixture.current.localPath);
  assert.equal(fixture.applyCalls(), 0);
  assert.equal(fixture.abortCalls(), 0);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs[0].model, fixture.modelMarker);
  assert.equal(fixture.state.tabs[0].dirty, true);
});

test('approved same-path open-project pull happens after leave and applies the refresh', async () => {
  const fixture = loadCollaboration({
    canLeave: async () => true,
    sendToServer: openProjectServer
  });
  await prepareSamePathOpenProject(fixture);

  await fixture.hooks.runActionConfirm();

  const sequence = eventSequence(fixture);
  const leaveIndex = sequence.indexOf('canLeave');
  const prepareIndex = sequence.indexOf('api:prepareTeamProject');
  const pullIndex = sequence.indexOf('pull');
  const refreshIndex = sequence.indexOf('refreshWorkspace');
  const applyIndex = sequence.indexOf('applyWorkspace');
  assert.ok(leaveIndex >= 0 && leaveIndex < prepareIndex, 'leave approval must precede prepareTeamProject');
  assert.ok(prepareIndex < pullIndex && pullIndex < refreshIndex && refreshIndex < applyIndex);
  assert.equal(sequence.includes('pickWorkspace'), false, 'same-path pull must refresh the current workspace in place');
  assert.equal(fixture.applyCalls(), 1);
  assert.equal(fixture.abortCalls(), 0);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs.length, 0);
  assert.equal(fixture.state.workspaceTransitionLocked, false);
});

test('failed same-path open-project pull unlocks and preserves the dirty model', async () => {
  const fixture = loadCollaboration({
    canLeave: async () => true,
    sendToServer: openProjectServer,
    pull: async () => ({ success: false, error: { message: 'pull failed' } })
  });
  await prepareSamePathOpenProject(fixture);

  await fixture.hooks.runActionConfirm();

  const sequence = eventSequence(fixture);
  assert.ok(sequence.indexOf('canLeave') < sequence.indexOf('api:prepareTeamProject'));
  assert.deepEqual(sequence, [
    'api:listTeamBranches',
    'localPathInfo',
    'canLeave',
    'api:prepareTeamProject',
    'pull',
    'abortWorkspaceLeave'
  ]);
  assert.equal(fixture.abortCalls(), 1);
  assert.equal(fixture.applyCalls(), 0);
  assert.equal(fixture.state.workspaceTransitionLocked, false);
  assert.equal(fixture.state.workspaceRoot, fixture.current.localPath);
  assert.equal(fixture.state.tabs.length, 1);
  assert.equal(fixture.state.tabs[0].model, fixture.modelMarker);
  assert.equal(fixture.state.tabs[0].dirty, true);
});
