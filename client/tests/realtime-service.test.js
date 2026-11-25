'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const output = esbuild.buildSync({
  absWorkingDir: root,
  stdin: {
    contents: "export { createRealtimeService } from './src/realtime'; export { SharedDocument } from './src/realtime-document';",
    resolveDir: root, sourcefile: 'realtime-service-test-entry.ts'
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
}).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(output, { module: moduleValue, exports: moduleValue.exports, require, Event, setTimeout, clearTimeout, setInterval, clearInterval });
const { createRealtimeService, SharedDocument } = moduleValue.exports;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, message) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function modelFor(initial) {
  let value = initial;
  const subscriptions = new Set();
  const model = {
    uri: { fsPath: '/workspace/main.py', toString: () => 'file:///workspace/main.py' },
    getValue: () => value,
    isDisposed: () => false,
    getOffsetAt(position) {
      const lines = value.split('\n');
      let offset = 0;
      for (let line = 1; line < position.lineNumber; line++) offset += lines[line - 1].length + 1;
      return offset + position.column - 1;
    },
    getPositionAt(offset) {
      const lines = value.slice(0, offset).split('\n');
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
    },
    getFullModelRange() {
      const end = model.getPositionAt(value.length);
      return { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column };
    },
    onDidChangeContent(listener) {
      subscriptions.add(listener);
      return { dispose: () => subscriptions.delete(listener) };
    },
    applyEdits(edits) {
      const changes = edits.map(edit => {
        const start = model.getOffsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn });
        const end = model.getOffsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn });
        return { rangeOffset: start, rangeLength: end - start, text: edit.text };
      });
      for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
        value = value.slice(0, change.rangeOffset) + change.text + value.slice(change.rangeOffset + change.rangeLength);
      }
      for (const listener of subscriptions) listener({ changes });
    },
    insert(offset, text) {
      const position = model.getPositionAt(offset);
      model.applyEdits([{ range: { startLineNumber: position.lineNumber, startColumn: position.column,
        endLineNumber: position.lineNumber, endColumn: position.column }, text }]);
    },
    get subscriptionCount() { return subscriptions.size; }
  };
  return model;
}

async function fixture(t) {
  const initial = 'print("hello")\n';
  const server = new SharedDocument('server', []);
  server.apply(server.change([{ rangeOffset: 0, rangeLength: 0, text: initial }]));
  const file = { id: 'file-one', path: 'main.py', revision: 1 };
  const room = { enabled: true, epoch: 'epoch-one', branch: 'main', revision: 1, files: [file], presence: [], deletions: [] };
  const model = modelFor(initial);
  const tab = { path: '/workspace/main.py', name: 'main.py', model, dirty: false };
  const state = {
    workspaceRoot: '/workspace', workspaceIdentity: 1, tabs: [tab], activeTabPath: tab.path,
    collaboration: { current: { teamId: 'team', projectId: 'project', branch: 'main', localPath: '/workspace' } },
    auth: { user: { id: 'alice', name: 'Alice' } }, selectedRuntime: 'python:3.10', setupCommands: []
  };
  const document = Object.assign(new EventTarget(), {
    getElementById: () => null, querySelectorAll: () => [], querySelector: () => null
  });
  const events = Object.assign(new EventTarget(), { setTimeout, setInterval });
  const listenerSet = new Set();
  const emit = message => { for (const listener of listenerSet) listener(message); };
  const sent = [], materialized = [], notifications = [];
  const disk = new Map();
  let drafts = [], gate;
  const host = {
    onMessage(listener) { listenerSet.add(listener); return () => listenerSet.delete(listener); },
    async connect() { return structuredClone(room); },
    async close() {},
    async drafts(payload) {
      if (payload) drafts = structuredClone(payload.drafts);
      return { sessionId: 'alice-session', contextKey: 'draft-context', drafts: structuredClone(drafts) };
    },
    async materialize(files) {
      const snapshot = structuredClone(files);
      const blocked = gate;
      if (blocked && !blocked.started) {
        blocked.started = true;
        blocked.entered.resolve();
        await blocked.release.promise;
      }
      for (const item of snapshot) disk.set(item.path, item.content);
      materialized.push(snapshot);
    },
    async send(message) {
      if (message.type === 'open') queueMicrotask(() => emit({ type: 'document', requestId: message.requestId,
        file: { ...file, content: server.text(), nodes: server.snapshot() } }));
      if (message.type === 'edit') {
        sent.push(structuredClone(message));
        server.apply(message);
        queueMicrotask(() => emit({ type: 'ack', requestId: message.requestId }));
      }
    }
  };
  const noop = () => {};
  const editor = {
    getModel: () => model, getSelection: () => null, getPosition: () => ({ lineNumber: 1, column: 1 }),
    updateOptions: noop, createContextKey: () => ({ set: noop }),
    onDidChangeCursorSelection: () => ({ dispose: noop }), addAction: () => ({ dispose: noop }),
    createDecorationsCollection: () => ({ set: noop, clear: noop }), addContentWidget: noop, removeContentWidget: noop
  };
  let visible = [];
  const service = createRealtimeService({
    document, events, state, host,
    async send(action) {
      if (action === 'getRealtimeState') return structuredClone(room);
      if (action === 'getRealtimeSnapshot') return { ...structuredClone(room), files: [{ ...file, content: server.text() }] };
      throw new Error('Unexpected action: ' + action);
    },
    t: key => key, confirm: async () => true, notify: message => notifications.push(message),
    workspace: {
      updateTabbar: noop, updateTitlebar: noop, closeTab: async () => true, renderTree: noop,
      saveAllTabs: async () => true, renameSharedFile: noop, prepareSharedViews: async () => [], applySharedSnapshot: async () => {}
    },
    refreshTree: async () => ({ children: [] }), editors: () => visible,
    runArgs: () => ({}), language: () => 'python', projectKey: () => 'project', output: noop, panel: noop,
    syncPersonal: async () => true, prepareRunnerTransition: async () => {}
  });
  t.after(async () => {
    gate?.release.resolve();
    await service.leave();
    service.dispose();
  });
  await service.openProject({}, state.collaboration.current);
  await service.prepareFile(tab.path);
  visible = [editor];
  events.dispatchEvent(new Event('bobo:visible-editors-changed'));
  await until(() => model.subscriptionCount === 1, 'the actual realtime service must bind the file model');
  return {
    service, model, tab, sent, server, materialized, disk, notifications,
    blockMaterialization() {
      gate = { entered: deferred(), release: deferred(), started: false };
      return gate;
    }
  };
}

test('edits typed during acknowledged-edit disk materialization drain without another keystroke or save', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const gate = f.blockMaterialization();
  f.model.insert(0, '#');
  await gate.entered.promise;
  assert.equal(f.sent.length, 1, 'the first edit was acknowledged before its local disk write blocked');
  assert.equal(f.server.text(), '#print("hello")\n');
  assert.equal(f.tab.dirty, false);

  f.model.insert(1, 'Bob\n');
  assert.equal(f.model.getValue(), '#Bob\nprint("hello")\n');
  assert.equal(f.sent.length, 1, 'typing while the write is blocked queues the tail behind the existing sender');
  assert.equal(f.tab.dirty, true);
  gate.release.resolve();

  // No further model event and no save/refresh call may be needed to restart sending.
  await until(() => f.sent.length === 2, 'the tail edit stayed stranded after the first disk materialization completed');
  await until(() => f.disk.get('main.py') === f.model.getValue(), 'the final materialization must include the queued tail');
  assert.equal(f.server.text(), f.model.getValue());
  assert.equal(f.tab.dirty, false);
  assert.deepEqual(f.notifications, []);
});
