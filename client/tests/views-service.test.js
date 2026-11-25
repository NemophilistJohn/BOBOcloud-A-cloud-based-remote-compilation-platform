'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

async function loadService(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-views-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'views.cjs');
  await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: "export { createViewsService } from './src/views.ts';",
      resolveDir: ROOT,
      sourcefile: 'views-service-test-entry.ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    logLevel: 'silent'
  });
  delete require.cache[output];
  return require(output);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createNode(id) {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    style: {},
    textContent: '',
    value: '',
    src: '',
    listeners,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
      toggle(value, force) { if (force) classes.add(value); else classes.delete(value); }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
}

function createHarness() {
  const nodes = new Map([
    'container', 'split-container', 'split-left', 'split-right', 'diff-container',
    'diff-editor', 'diff-original-label', 'diff-modified-label', 'image-preview',
    'image-preview-title', 'preview-image', 'close-image-preview', 'rotate-left',
    'rotate-right', 'zoom-out', 'zoom-in', 'zoom-reset', 'close-diff',
    'theme-modal', 'theme-select', 'theme-apply', 'theme-cancel',
    'split-left-pane', 'split-right-pane', 'split-left-label', 'split-right-label', 'close-split'
  ].map((id) => [id, createNode(id)]));
  const output = [];
  const reads = new Map();
  const timers = new Map();
  const timerClears = [];
  let nextTimer = 1;
  const models = [];
  const editors = [];
  let diffEditor = null;

  function model(value, language, uri = 'file.ts') {
    const listeners = new Set();
    const item = {
      value,
      language,
      uri: { toString: () => uri },
      disposed: false,
      getValue() { return this.value; },
      setValue(next) { this.value = next; },
      getLanguageId() { return this.language; },
      onDidChangeContent(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      trigger() { for (const listener of listeners) listener(); },
      dispose() { this.disposed = true; listeners.clear(); }
    };
    models.push(item);
    return item;
  }

  const primaryModel = model('active', 'typescript', 'active.ts');
  const primaryEditor = {
    model: primaryModel,
    disposed: false,
    getModel() { return this.model; },
    setModel(next) { this.model = next; },
    getOption() { return 'vs-dark'; },
    getPosition() { return { lineNumber: 1, column: 1 }; },
    updateOptions() {},
    dispose() { this.disposed = true; }
  };

  const monaco = {
    editor: {
      EditorOption: { theme: 'theme' },
      create(element, options) {
        const focusListeners = new Set();
        const cursorListeners = new Set();
        const editor = {
          model: options.model || null,
          options: { ...options },
          focus() { for (const listener of focusListeners) listener(); },
          onDidFocusEditorWidget(listener) { focusListeners.add(listener); return { dispose: () => focusListeners.delete(listener) }; },
          onDidChangeCursorPosition(listener) { cursorListeners.add(listener); return { dispose: () => cursorListeners.delete(listener) }; },
          rightEditor: undefined,
          disposed: false,
          getModel() { return this.model; },
          setModel(next) { this.model = next; },
          getOption() { return 'vs-dark'; },
          getPosition() { return { lineNumber: 1, column: 1 }; },
          updateOptions(next) { Object.assign(this.options, next); },
          dispose() { this.disposed = true; }
        };
        editors.push(editor);
        return editor;
      },
      createModel: model,
      setModelLanguage(item, language) { item.language = language; },
      createDiffEditor() {
        diffEditor = {
          current: null,
          disposed: false,
          getModel() { return this.current; },
          setModel(next) { this.current = next; },
          dispose() { this.disposed = true; }
        };
        return diffEditor;
      }
    },
    Uri: { parse: (value) => value }
  };

  const state = {
    editor: primaryEditor,
    splitEditor: null,
    diffEditor: null,
    currentViewMode: 'single',
    tabs: [{ path: 'active.ts', model: primaryModel }],
    activeTabPath: 'active.ts',
    workspaceTransitionLocked: false,
    diffOriginalPath: null,
    diffModifiedPath: null,
    currentImagePath: null,
    imageRotation: 0,
    imageScale: 1
  };

  const dependencies = {
    document: { getElementById: (id) => nodes.get(id) || null },
    state,
    host: {
      readFile(filePath) {
        const item = deferred();
        reads.set(filePath, item);
        return item.promise;
      }
    },
    getMonaco: () => monaco,
    getCollaboration: () => ({ isActiveFileReadOnly: () => false }),
    getWorkspaceSettings: () => ({ attachEditor: () => {} }),
    getEditorCore: () => ({ updateStatusBar: () => {} }),
    getTheme: () => ({ applyTheme: () => {} }),
    getSettings: () => ({ open: () => {} }),
    detectLanguage: () => 'plaintext',
    updateRunOutput: (message) => output.push(message),
    setTimer(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      timerClears.push(id);
      timers.delete(id);
    }
  };

  return {
    dependencies,
    nodes,
    state,
    output,
    reads,
    timers,
    timerClears,
    models,
    editors,
    model,
    get diffEditor() { return diffEditor; },
    resolveRead(filePath, value) {
      const item = reads.get(filePath);
      assert.ok(item, 'missing read: ' + filePath);
      item.resolve(value);
    },
    flushTimers() {
      for (const callback of Array.from(timers.values())) callback();
      timers.clear();
    }
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test('stale diff reads cannot replace a newer view and diff models are released', async (t) => {
  const { createViewsService } = await loadService(t);
  const harness = createHarness();
  const service = createViewsService(harness.dependencies);
  service.init();
  service.init();

  service.openDiff('old-a.ts', 'old-b.ts');
  service.openDiff('new-a.ts', 'new-b.ts');
  harness.resolveRead('old-a.ts', 'old A');
  harness.resolveRead('old-b.ts', 'old B');
  await settle();
  assert.equal(harness.state.diffEditor, null);
  harness.resolveRead('new-a.ts', 'new A');
  harness.resolveRead('new-b.ts', 'new B');
  await settle();
  assert.equal(harness.state.currentViewMode, 'diff');
  assert.equal(harness.diffEditor.current.original.getValue(), 'new A');

  service.closeDiff();
  assert.equal(harness.diffEditor.current, null);
  assert.equal(harness.models.filter((item) => item.disposed).length, 2);
  service.dispose();
  assert.equal(service.disposed, true);
  assert.equal(harness.nodes.get('close-diff').listeners.get('click').size, 0);
});

test('split panes edit file-owned models independently and focus determines tab assignment', async (t) => {
  const { createViewsService } = await loadService(t);
  const harness = createHarness();
  let visibleChanges = 0;
  harness.dependencies.notifyVisibleEditorsChanged = () => { visibleChanges += 1; };
  const service = createViewsService(harness.dependencies);
  harness.dependencies.activateFile = (path) => {
    harness.state.activeTabPath = path;
    service.activateTab(path);
  };
  const first = harness.state.tabs[0].model;
  const second = harness.model('second', 'python', 'second.py');
  const third = harness.model('third', 'typescript', 'third.ts');
  harness.state.tabs.push({ path: 'second.py', model: second }, { path: 'third.ts', model: third });
  service.init();
  service.openSplit();
  const [left, right] = service.getVisibleEditors();
  assert.equal(left.getModel(), first);
  assert.equal(right.getModel(), first, 'same-file panes must share the original model and undo history');
  assert.equal(harness.models.length, 3, 'splitting must never create a cloned model');
  assert.equal(left.options.readOnly, false);
  assert.equal(right.options.readOnly, false);
  harness.state.activeTabPath = 'second.py';
  assert.equal(service.activateTab('second.py'), true);
  assert.equal(left.getModel(), first, 'opening a file in the right pane preserves the left pane');
  assert.equal(right.getModel(), second);
  right.getModel().setValue('changed second');
  assert.equal(first.getValue(), 'active');
  assert.equal(harness.timers.size, 0, 'independent documents must never mirror after a timer');
  left.focus();
  assert.equal(service.getActiveEditor(), left);
  assert.equal(harness.state.activeTabPath, 'active.ts');
  assert.equal(harness.state.editor.getModel(), first, 'legacy run/save model follows focus');
  harness.state.activeTabPath = 'third.ts';
  service.activateTab('third.ts');
  assert.equal(left.getModel(), third);
  assert.equal(right.getModel(), second);
  assert.equal(harness.nodes.get('split-left-label').textContent, 'third.ts');
  assert.ok(visibleChanges >= 4);
  service.closeSplit();
  assert.equal(harness.state.editor.getModel(), third);
  assert.equal(left.getModel(), null);
  assert.equal(right.getModel(), null);
  service.dispose();
  assert.equal(first.disposed, false);
  assert.equal(second.disposed, false);
  assert.equal(third.disposed, false, 'view teardown never disposes workspace-owned documents');
  assert.equal(left.disposed, true);
  assert.equal(right.disposed, true);
});

test('closing a file detaches both panes before disposal and split respects workspace locks', async (t) => {
  const { createViewsService } = await loadService(t);
  const harness = createHarness();
  const service = createViewsService(harness.dependencies);
  const first = harness.state.tabs[0].model;
  const replacement = harness.model('next', 'python', 'next.py');
  harness.state.tabs.push({ path: 'next.py', model: replacement });
  service.openSplit();
  const [left, right] = service.getVisibleEditors();
  harness.state.workspaceTransitionLocked = true;
  service.refreshReadOnly();
  assert.equal(left.options.readOnly, true);
  assert.equal(right.options.readOnly, true);
  harness.state.workspaceTransitionLocked = false;
  service.refreshReadOnly();
  assert.equal(left.options.readOnly, false);
  assert.equal(right.options.readOnly, false);
  service.onTabClosed('active.ts');
  assert.equal(left.getModel(), replacement);
  assert.equal(right.getModel(), replacement);
  first.dispose();
  assert.equal(replacement.disposed, false);
  service.dispose();
});

test('split-right tab action preserves the left file when the left editor is focused', async (t) => {
  const { createViewsService } = await loadService(t);
  const harness = createHarness();
  const service = createViewsService(harness.dependencies);
  harness.dependencies.activateFile = (path) => {
    harness.state.activeTabPath = path;
    service.activateTab(path);
  };
  const first = harness.state.tabs[0].model;
  const second = harness.model('second', 'python', 'second.py');
  harness.state.tabs.push({ path: 'second.py', model: second });
  service.openSplit();
  const [left, right] = service.getVisibleEditors();
  left.focus();
  service.openSplit('second.py');
  assert.equal(left.getModel(), first);
  assert.equal(right.getModel(), second);
  assert.equal(service.getActiveEditor(), right);
  assert.equal(harness.state.activeTabPath, 'second.py');
  service.dispose();
});
