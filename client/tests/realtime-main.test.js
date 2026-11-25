'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createRealtimeController } = require('../main/realtime');
const { createWorkspaceController } = require('../main/workspace');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-realtime-main-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) };
  const messages = [];
  const preferences = { ip: 'one.example.test', httpPort: 3100, secureTransport: false, apiKey: 'fallback-key' };
  let account = 'alice';
  const settings = {
    readServerSettings: async () => ({ ...preferences }),
    readAuth: () => ({ servers: { [preferences.ip]: { token: 'token-' + account, user: { id: account } } } }),
    readProjectNames: () => ({}), saveProjectName: () => true, rememberRecentWorkspace() {}
  };
  const workspace = createWorkspaceController({
    ipcMain, dialog: {}, getWindow: () => null, settings,
    sendToRenderer: () => {}, t: value => value
  });
  workspace.registerIpc();
  t.after(() => workspace.clearWatchers());
  const invoke = (name, ...args) => handlers.get(name)({}, ...args);
  function mapping(directory, branch = 'main') {
    fs.writeFileSync(path.join(directory, '.bobocloud-team.json'), JSON.stringify({
      teamId: 'team-one', projectId: 'project-one', branch, localPath: directory
    }));
  }
  mapping(first);
  mapping(second);
  await invoke('pick-workspace', first);
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    send(encoded) {
      const request = JSON.parse(encoded);
      if (request.type === 'join') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
        type: 'state', state: { enabled: true, epoch: request.epoch, files: [], presence: [], deletions: [] }
      }))));
    }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const controller = createRealtimeController({
    ipcMain, settings, dialog: {}, getWindow: () => null,
    getWorkspaceIdentity: workspace.getIdentity, runMutation: workspace.runMutation,
    notifyWorkspaceFiles: () => {}, sendToRenderer: (channel, payload) => messages.push({ channel, payload }),
    userDataPath: path.join(root, 'user-data'),
    factory: () => () => {
      const socket = new Socket();
      setImmediate(() => socket.emit('open'));
      return socket;
    },
    verifier: () => () => true
  });
  t.after(() => controller.close());
  async function connect(epoch = 'epoch-one') {
    await invoke('realtime:connect', { teamId: 'team-one', projectId: 'project-one', sessionId: 'session-test', epoch });
    return { epoch, workspaceIdentity: workspace.getIdentity().workspaceIdentity };
  }
  return {
    root, first, second, invoke, connect, controller, preferences, mapping, messages,
    account(value) { account = value; }
  };
}

test('realtime materialization rejects stale epochs and workspace identities before writes', async t => {
  const f = await fixture(t);
  const original = path.join(f.first, 'keep.txt');
  fs.writeFileSync(original, 'original');
  const context = await f.connect();
  for (const options of [{}, { ...context, epoch: 'wrong' }, { ...context, workspaceIdentity: -1 }]) {
    await assert.rejects(f.invoke('realtime:materialize', [{ path: 'keep.txt', content: 'overwritten' }], options), /Stale collaboration snapshot/);
    assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  }
  await f.invoke('pick-workspace', f.second);
  await f.connect();
  await assert.rejects(f.invoke('realtime:materialize', [{ path: 'late.txt', content: 'old workspace' }], context), /Stale collaboration snapshot/);
  assert.equal(fs.existsSync(path.join(f.second, 'late.txt')), false);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original');
});

test('persisted live epochs fence normal sync until an offline final snapshot is reconciled', async t => {
  const f = await fixture(t);
  const context = await f.connect();
  const marker = path.join(f.first, '.bobocloud-team.json');
  assert.equal(JSON.parse(fs.readFileSync(marker)).realtimeEpoch, context.epoch);
  await f.invoke('realtime:close');
  fs.writeFileSync(path.join(f.first, 'unopened.txt'), 'stale local file');
  const final = [{ path: 'unopened.txt', content: 'final Git content' }, { path: 'empty.txt', content: '' }];
  const options = { reconcile: true, epoch: 'disabled-epoch', previousEpoch: context.epoch, workspaceIdentity: context.workspaceIdentity };
  await assert.rejects(f.invoke('realtime:materialize', final, { ...options, previousEpoch: 'stale' }), /Stale collaboration transition/);
  assert.equal(fs.readFileSync(path.join(f.first, 'unopened.txt'), 'utf8'), 'stale local file');
  await f.invoke('realtime:materialize', final, options);
  assert.equal(fs.readFileSync(path.join(f.first, 'unopened.txt'), 'utf8'), 'final Git content');
  assert.equal(fs.readFileSync(path.join(f.first, 'empty.txt'), 'utf8'), '');
  assert.equal(JSON.parse(fs.readFileSync(marker)).realtimeEpoch, '');
  await assert.rejects(f.invoke('realtime:materialize', final, options), /Stale collaboration transition/);
});

test('realtime draft contexts isolate accounts, branches, servers and late saves from previous workspaces', async t => {
  const f = await fixture(t);
  const draft = { fileId: 'file-one', path: 'main.txt', epoch: 'epoch-one', text: 'unsent', pending: [], nodes: [], clock: 0 };
  const first = await f.invoke('realtime:drafts');
  await f.invoke('realtime:drafts', { drafts: [draft], contextKey: first.contextKey });
  f.account('bob');
  const bob = await f.invoke('realtime:drafts');
  assert.notEqual(bob.contextKey, first.contextKey);
  assert.deepEqual(bob.drafts, []);
  f.account('alice');
  f.mapping(f.first, 'feature');
  const branch = await f.invoke('realtime:drafts');
  assert.notEqual(branch.contextKey, first.contextKey);
  assert.deepEqual(branch.drafts, []);
  f.mapping(f.first, 'main');
  f.preferences.ip = 'two.example.test';
  const server = await f.invoke('realtime:drafts');
  assert.notEqual(server.contextKey, first.contextKey, 'the same account id on another server has a separate namespace');
  f.preferences.ip = 'one.example.test';
  await f.invoke('pick-workspace', f.second);
  const second = await f.invoke('realtime:drafts');
  assert.notEqual(second.contextKey, first.contextKey);
  await f.invoke('realtime:drafts', { contextKey: first.contextKey, drafts: [{ ...draft, text: 'saved after switch' }] });
  assert.deepEqual((await f.invoke('realtime:drafts')).drafts, []);
  await f.invoke('pick-workspace', f.first);
  const restored = await f.invoke('realtime:drafts');
  assert.equal(restored.sessionId, first.sessionId);
  assert.equal(restored.drafts[0].text, 'saved after switch');
  await assert.rejects(f.invoke('realtime:drafts', { contextKey: '../invented', drafts: [] }), /Unknown collaboration draft context/);
});

test('an in-flight file write rechecks its session before atomically replacing the existing file', async t => {
  const f = await fixture(t);
  const context = await f.connect();
  const target = path.join(f.first, 'keep.txt');
  fs.writeFileSync(target, 'original');
  const originalOpen = fs.promises.open;
  let interrupted = false;
  fs.promises.open = async function(filePath, ...args) {
    const handle = await originalOpen.call(this, filePath, ...args);
    if (path.dirname(filePath) === f.first && path.basename(filePath).startsWith('.keep.txt.')) {
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await originalSync();
        interrupted = true;
        f.controller.close('account-changed');
      };
    }
    return handle;
  };
  try {
    await assert.rejects(f.invoke('realtime:materialize', [{ path: 'keep.txt', content: 'must not publish' }], context), /Collaboration workspace changed/);
  } finally { fs.promises.open = originalOpen; }
  assert.equal(interrupted, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.first).filter(name => name.startsWith('.keep.txt.')), []);
});

test('realtime materialization rejects traversal, reserved paths and symlinks without escaping the workspace', async t => {
  const f = await fixture(t);
  const context = await f.connect();
  for (const entry of ['../escape.txt', '/absolute.txt', 'nested/../../escape', 'C:/escape', 'x\\escape', '.git/config', '.BOBOCLOUD-TEAM.JSON', 'CON.txt', 'LPT9', 'trailing.', 'space ', 'control\nname']) {
    await assert.rejects(f.invoke('realtime:materialize', [{ path: entry, content: 'bad' }], context), /Invalid shared file path|escapes workspace/);
  }
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
  const link = path.join(f.first, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.invoke('realtime:materialize', [{ path: 'link/keep.txt', content: 'bad' }], context), /outside|Symbolic links/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(f.root, 'escape.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.first, '.bobocloud-team.json'))).teamId, 'team-one');
});

test('snapshot staging validates the complete snapshot before replacement and rolls back a partial publication', async t => {
  const f = await fixture(t);
  const context = await f.connect();
  fs.writeFileSync(path.join(f.first, 'keep-a.txt'), 'A');
  fs.mkdirSync(path.join(f.first, 'old-dir'));
  fs.writeFileSync(path.join(f.first, 'old-dir', 'keep-b.txt'), 'B');
  await assert.rejects(f.invoke('realtime:materialize', [{ path: 'new.txt', content: 'new' }, { path: '../unsafe', content: 'bad' }], { ...context, replace: true }), /Invalid shared file path/);
  assert.equal(fs.readFileSync(path.join(f.first, 'keep-a.txt'), 'utf8'), 'A');
  assert.equal(fs.existsSync(path.join(f.first, 'new.txt')), false);
  const originalRename = fs.promises.rename;
  let failPublication = true;
  fs.promises.rename = async function(source, target) {
    if (failPublication && String(source).includes('.bobo-live-stage-') && path.basename(source) === 'new-b.txt') {
      failPublication = false;
      throw new Error('Injected snapshot publication failure');
    }
    return originalRename.call(this, source, target);
  };
  try {
    await assert.rejects(f.invoke('realtime:materialize', [{ path: 'new-a.txt', content: 'new A' }, { path: 'new-b.txt', content: 'new B' }], { ...context, replace: true }), /Injected snapshot publication failure/);
  } finally { fs.promises.rename = originalRename; }
  assert.equal(failPublication, false, 'the failure must occur after moving the original files and publishing the first entry');
  assert.equal(fs.readFileSync(path.join(f.first, 'keep-a.txt'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(f.first, 'old-dir', 'keep-b.txt'), 'utf8'), 'B');
  assert.equal(fs.existsSync(path.join(f.first, 'new-a.txt')), false);
  assert.equal(fs.existsSync(path.join(f.first, 'new-b.txt')), false);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => /^\.bobo-live-(stage|backup)-/.test(name)), []);
});

test('an empty authoritative snapshot removes ordinary files and preserves the team mapping', async t => {
  const f = await fixture(t);
  const context = await f.connect();
  fs.writeFileSync(path.join(f.first, 'remove.txt'), 'old');
  await f.invoke('realtime:materialize', [], { ...context, replace: true });
  assert.deepEqual(fs.readdirSync(f.first), ['.bobocloud-team.json']);
  f.controller.close('server-settings-changed');
  assert.equal(f.messages.at(-1).payload.type, 'reset');
  assert.equal(f.messages.at(-1).payload.reason, 'server-settings-changed');
});
