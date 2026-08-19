'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createModel(filePath, languageId, options) {
  let language = languageId;
  let modelOptions = Object.assign({ tabSize: 4, insertSpaces: true }, options);
  return {
    uri: { fsPath: filePath },
    getLanguageId: () => language,
    setLanguageId: (value) => { language = value; },
    getOptions: () => Object.assign({}, modelOptions),
    updateOptions: (value) => { modelOptions = Object.assign({}, modelOptions, value); },
    getValue: () => 'template',
    options: () => Object.assign({}, modelOptions)
  };
}

test('renderer applies trusted settings to existing models and rejects stale workspace snapshots', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/workspace-settings.js'), 'utf8');
  const root = path.resolve('C:/work/example');
  const model = createModel(path.join(root, 'view.templ'), 'plaintext');
  const splitModel = createModel(path.join(root, 'view.templ-split'), 'plaintext');
  const state = {
    workspaceRoot: root,
    workspaceIdentity: 9,
    workspaceSettings: null,
    tabs: [{ name: 'view.templ', path: path.join(root, 'view.templ'), model, language: 'plaintext' }],
    editor: null,
    splitEditor: null
  };
  let changedListener = null;
  let createdListener = null;
  let editorModelListener = null;
  let wordWrap = null;
  let splitLeftWrap = null;
  let splitRightWrap = null;
  let lspRefreshes = 0;
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    updateOptions: (options) => { wordWrap = options.wordWrap; },
    onDidChangeModel: (listener) => { editorModelListener = listener; }
  };
  state.editor = editor;
  const splitRight = {
    getModel: () => splitModel,
    updateOptions: (options) => { splitRightWrap = options.wordWrap; },
    onDidChangeModel: () => {}
  };
  state.splitEditor = {
    rightEditor: splitRight,
    getModel: () => model,
    updateOptions: (options) => { splitLeftWrap = options.wordWrap; },
    onDidChangeModel: () => {}
  };
  const monaco = {
    editor: {
      getModels: () => [model, splitModel],
      onDidCreateModel: (listener) => { createdListener = listener; },
      setModelLanguage: (target, languageId) => target.setLanguageId(languageId)
    }
  };
  const window = {
    api: { onWorkspaceSettingsChanged: (listener) => { changedListener = listener; } },
    BOBO: {
      state,
      detectLanguage: () => 'plaintext',
      lsp: { workspaceChanged: () => { lspRefreshes += 1; } },
      runtime: { autoSelectForLanguage: () => {} },
      environmentActivity: { contextChanged: () => {} },
      editorCore: { updateStatusBar: () => {} }
    }
  };
  const context = vm.createContext({ window, Set, Map, WeakMap, Object, Array, Number, String, Boolean, RegExp, Math, Promise });
  vm.runInContext(source, context, { filename: 'workspace-settings.js' });
  const service = window.BOBO.workspaceSettings;
  service.setMonaco(monaco);
  service.attachEditor(editor);

  const applied = service.applySnapshot({
    schemaVersion: 1,
    rootPath: root,
    workspaceIdentity: 9,
    settings: {
      editor: { tabSize: 2, wordWrap: 'bounded' },
      languages: { html: { insertSpaces: false } },
      associations: [{ pattern: '*.templ', languageId: 'html' }]
    },
    warnings: [{ code: 'WORKSPACE_SETTING_UNSUPPORTED', count: 1 }]
  });
  assert.equal(applied, true);
  assert.equal(model.getLanguageId(), 'html');
  assert.equal(splitModel.getLanguageId(), 'html');
  assert.deepEqual(model.options(), { tabSize: 2, insertSpaces: false });
  assert.deepEqual(splitModel.options(), { tabSize: 2, insertSpaces: false });
  assert.equal(state.tabs[0].language, 'html');
  assert.equal(wordWrap, 'bounded');
  assert.equal(splitLeftWrap, 'bounded');
  assert.equal(splitRightWrap, 'bounded');
  assert.equal(lspRefreshes, 1);
  assert.equal(Object.isFrozen(state.workspaceSettings), true);
  assert.equal(typeof changedListener, 'function');
  assert.equal(typeof createdListener, 'function');
  assert.equal(typeof editorModelListener, 'function');

  const stale = service.applySnapshot({
    schemaVersion: 1,
    rootPath: root,
    workspaceIdentity: 8,
    settings: { editor: { tabSize: 12 }, languages: {}, associations: [] },
    warnings: []
  });
  assert.equal(stale, false);
  assert.equal(model.options().tabSize, 2);
});

test('new models inherit editor settings while file associations remain path-only language hints', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/workspace-settings.js'), 'utf8');
  const root = path.resolve('C:/work/new-model');
  const models = [];
  let createdListener = null;
  const state = { workspaceRoot: root, workspaceIdentity: 2, workspaceSettings: null, tabs: [], editor: null, splitEditor: null };
  const window = {
    api: { onWorkspaceSettingsChanged: () => {} },
    BOBO: { state, detectLanguage: () => 'plaintext' }
  };
  const monaco = {
    editor: {
      getModels: () => models,
      onDidCreateModel: (listener) => { createdListener = listener; },
      setModelLanguage: (target, languageId) => target.setLanguageId(languageId)
    }
  };
  vm.runInContext(source, vm.createContext({ window, Set, Map, WeakMap, Object, Array, Number, String, Boolean, RegExp, Math, Promise }));
  const service = window.BOBO.workspaceSettings;
  service.setMonaco(monaco);
  service.applySnapshot({
    schemaVersion: 1,
    rootPath: root,
    workspaceIdentity: 2,
    settings: {
      editor: { tabSize: 8, insertSpaces: false },
      languages: {},
      associations: [{ pattern: '*.widget', languageId: 'javascript' }]
    },
    warnings: []
  });
  assert.equal(service.languageForFile('screen.widget', 'plaintext'), 'javascript');

  const internalModel = createModel('inmemory://model/1', 'json');
  models.push(internalModel);
  createdListener(internalModel);
  assert.equal(internalModel.getLanguageId(), 'json');
  assert.deepEqual(internalModel.options(), { tabSize: 8, insertSpaces: false });
});

test('uncontrolled indentation survives unrelated settings refreshes', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/workspace-settings.js'), 'utf8');
  const root = path.resolve('C:/work/user-indentation');
  const model = createModel(path.join(root, 'main.js'), 'javascript');
  const state = {
    workspaceRoot: root,
    workspaceIdentity: 3,
    workspaceSettings: null,
    tabs: [{ name: 'main.js', path: path.join(root, 'main.js'), model, language: 'javascript' }],
    editor: null,
    splitEditor: null
  };
  const window = { api: { onWorkspaceSettingsChanged: () => {} }, BOBO: { state, detectLanguage: () => 'javascript' } };
  const monaco = {
    editor: {
      getModels: () => [model],
      onDidCreateModel: () => {},
      setModelLanguage: () => {}
    }
  };
  vm.runInContext(source, vm.createContext({ window, Set, Map, WeakMap, WeakSet, Object, Array, Number, String, Boolean, RegExp, Math, Promise }));
  const service = window.BOBO.workspaceSettings;
  service.setMonaco(monaco);
  service.applySnapshot({
    schemaVersion: 1,
    rootPath: root,
    workspaceIdentity: 3,
    settings: { editor: { wordWrap: 'on' }, languages: {}, associations: [] },
    warnings: []
  });

  model.updateOptions({ insertSpaces: false });
  model.updateOptions({ tabSize: 6 });
  service.applySnapshot({
    schemaVersion: 1,
    rootPath: root,
    workspaceIdentity: 3,
    settings: { editor: { tabSize: 2, wordWrap: 'on' }, languages: {}, associations: [] },
    warnings: []
  });
  assert.equal(model.options().tabSize, 2);
  service.applySnapshot({
    schemaVersion: 1,
    rootPath: root,
    workspaceIdentity: 3,
    settings: { editor: { wordWrap: 'bounded' }, languages: {}, associations: [] },
    warnings: []
  });

  assert.equal(model.options().insertSpaces, false);
  assert.equal(model.options().tabSize, 6);
});
