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

async function fixture(t, options = {}) {
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
    auth: options.auth || { user: { id: 'alice', name: 'Alice' } }, selectedRuntime: 'python:3.10', setupCommands: []
  };
  const document = Object.assign(new EventTarget(), {
    getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => ({ className: '', innerHTML: '' })
  });
  const intervals = [];
  const events = Object.assign(new EventTarget(), { setTimeout, setInterval(fn, delay) { intervals.push(fn); return setInterval(fn, delay); } });
  const listenerSet = new Set();
  const emit = message => { for (const listener of listenerSet) listener(message); };
  const sent = [], materialized = [], notifications = [], network = [], widgets = [];
  const disk = new Map();
  let snapshotFailure = null;
  let drafts = [], gate, closeGate, draftsGate, stateGate;
  function record(kind) { network.push({ kind, user: state.auth.user?.id, token: state.auth.token }); }
  const host = {
    onMessage(listener) { listenerSet.add(listener); return () => listenerSet.delete(listener); },
    async connect() { record('connect'); return structuredClone(room); },
    async close() { const blocked = closeGate; if (blocked && !blocked.started) { blocked.started = true; blocked.entered.resolve(); await blocked.release.promise; } },
    async drafts(payload) {
      const blocked = !payload && draftsGate;
      if (blocked && !blocked.started) { blocked.started = true; blocked.entered.resolve(); await blocked.release.promise; }
      if (payload) drafts = structuredClone(payload.drafts);
      return { sessionId: 'alice-session', contextKey: 'draft-context', drafts: structuredClone(drafts) };
    },
    async materialize(files, options) {
      if (options?.replace && snapshotFailure) {
        const error = snapshotFailure;
        snapshotFailure = null;
        throw error;
      }
      const snapshot = structuredClone(files);
      const blocked = gate;
      if (blocked && !blocked.started) {
        blocked.started = true;
        blocked.entered.resolve();
        await blocked.release.promise;
      }
      for (const item of snapshot) {
        if (item.previousPath) { disk.set(item.path, disk.get(item.previousPath)); disk.delete(item.previousPath); }
        if (item.deleted) disk.delete(item.path);
        else if (typeof item.content === 'string') disk.set(item.path, item.content);
      }
      materialized.push(snapshot);
    },
    async send(message) {
      record('socket-' + message.type);
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
    createDecorationsCollection: () => ({ set: noop, clear: noop }),
    addContentWidget: widget => widgets.push(widget), removeContentWidget: widget => { const index = widgets.indexOf(widget); if (index >= 0) widgets.splice(index, 1); }
  };
  let visible = [];
  const service = createRealtimeService({
    document, events, state, host,
    async send(action) {
      record(action);
      if (action === 'getRealtimeState') {
        const blocked = stateGate;
        if (blocked && !blocked.started) { blocked.started = true; blocked.entered.resolve(); await blocked.release.promise; }
        return structuredClone(room);
      }
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
    closeGate?.release.resolve(); draftsGate?.release.resolve(); stateGate?.release.resolve();
    await service.leave();
    service.dispose();
  });
  await service.openProject({}, state.collaboration.current);
  await service.prepareFile(tab.path);
  visible = [editor];
  events.dispatchEvent(new Event('bobo:visible-editors-changed'));
  await until(() => model.subscriptionCount === 1, 'the actual realtime service must bind the file model');
  return {
    service, model, tab, sent, server, room, materialized, disk, notifications, state, events, emit, network, widgets,
    failNextSnapshot() { snapshotFailure = new Error('Failed to publish initial workspace'); },
    poll() { intervals.forEach(fn => fn()); },
    blockClose() { closeGate = { entered: deferred(), release: deferred(), started: false }; return closeGate; },
    blockDrafts() { draftsGate = { entered: deferred(), release: deferred(), started: false }; return draftsGate; },
    blockState() { stateGate = { entered: deferred(), release: deferred(), started: false }; return stateGate; },
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

test('reconnect applies offline renames over the existing snapshot without replacing the folder', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const snapshots = f.network.filter(event => event.kind === 'getRealtimeSnapshot').length;
  f.emit({ type: 'disconnected' });
  f.room.files[0] = { ...f.room.files[0], path: 'renamed.py', revision: 2 };
  f.room.revision++;
  await f.service.refresh();
  await until(() => f.disk.has('renamed.py'), 'offline rename must be materialized on reconnect');
  assert.equal(f.disk.has('main.py'), false);
  assert.equal(f.network.filter(event => event.kind === 'getRealtimeSnapshot').length, snapshots);
  assert.ok(f.materialized.some(files => files.some(file => file.path === 'renamed.py' && file.previousPath === 'main.py')));
});

test('initial snapshot publication failures retry the full initialization before edits are allowed', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.service.leave();
  f.failNextSnapshot();
  await f.service.refresh();
  await assert.rejects(f.service.save(), /reconnecting/);
  const firstAttempt = f.network.filter(event => event.kind === 'getRealtimeSnapshot').length;
  await f.service.refresh();
  assert.equal(f.network.filter(event => event.kind === 'getRealtimeSnapshot').length, firstAttempt + 1);
  assert.equal(await f.service.save(), true);
  assert.equal(f.notifications.filter(message => message.endsWith('Failed to publish initial workspace')).length, 1);
});

test('logout gates delayed leave refresh and background polling before the workspace mapping is cleared', { timeout: 5000 }, async t => {
  const f = await fixture(t, { auth: { mode: 'multi', token: 'alice-token', user: { id: 'alice', name: 'Alice' } } });
  const gate = f.blockClose(), before = f.network.length;
  f.state.auth.user = null; f.state.auth.token = '';
  f.events.dispatchEvent(new Event('bobo:auth-changed'));
  await gate.entered.promise;
  // Logout clears credentials before its later workspace-close IPC completes.
  f.state.collaboration.current.realtimeEpoch = undefined;
  await f.service.refresh(); f.poll();
  gate.release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  f.poll(); await f.service.refresh();
  assert.deepEqual(f.network.slice(before), [], 'logout callbacks must not issue HTTP or WebSocket work without credentials');
});

test('logout fences in-flight mode responses and delayed join continuations', { timeout: 5000 }, async t => {
  const f = await fixture(t, { auth: { mode: 'multi', token: 'alice-token', user: { id: 'alice', name: 'Alice' } } });
  await f.service.leave();
  const gate = f.blockDrafts();
  const pending = f.service.refresh();
  await gate.entered.promise;
  const before = f.network.length;
  f.state.auth.user = null; f.state.auth.token = '';
  f.events.dispatchEvent(new Event('bobo:auth-changed'));
  gate.release.resolve(); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.network.slice(before), [], 'a join paused in draft loading must not continue after logout');
});

test('a mode response from the previous auth generation cannot reconnect after logout', { timeout: 5000 }, async t => {
  const f = await fixture(t, { auth: { mode: 'multi', token: 'alice-token', user: { id: 'alice', name: 'Alice' } } });
  const gate = f.blockState(), pending = f.service.refresh();
  await gate.entered.promise;
  const before = f.network.length;
  f.state.auth.user = null; f.state.auth.token = '';
  f.events.dispatchEvent(new Event('bobo:auth-changed'));
  gate.release.resolve(); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.network.slice(before), [], 'the stale mode response must not open a socket or request another snapshot');
});

test('legacy single-user mode can refresh without a login token', { timeout: 5000 }, async t => {
  const f = await fixture(t, { auth: { mode: 'single', user: null, token: '' } });
  assert.ok(f.network.some(call => call.kind === 'connect'));
});

test('peer caret labels keep one color per user across presence ordering and multiple sessions', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const anchor = f.server.snapshot()[0].id;
  const person = (userId, name, sessionId) => ({ userId, name, sessionId, panes: [{ paneId: 'main', fileId: 'file-one', editing: true, cursor: { anchor, focus: anchor } }] });
  const bob = person('bob', 'Bob', 'bob-one'), carol = person('carol', 'Carol', 'carol-one'), bobOther = person('bob', 'Bob', 'bob-two');
  f.emit({ type: 'presence', presence: [bob, carol, bobOther], deletions: [] });
  const classes = () => new Map(f.widgets.map(widget => [widget.getId(), widget.getDomNode().className]));
  const first = classes();
  assert.equal(first.get('shared-cursor-bob-one-main'), first.get('shared-cursor-bob-two-main'));
  assert.ok(f.widgets.every(widget => widget.getDomNode().innerHTML.includes('<span>')));
  f.emit({ type: 'presence', presence: [carol, bobOther, bob], deletions: [] });
  assert.deepEqual(classes(), first, 'changing presence order must not change cursor colors');
});
