'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAgentPlatformBroker } = require('../main/agent-platform');
const { createDapController } = require('../main/dap');
const {
  MAX_WORKSPACE_BATCH_BYTES,
  MAX_WORKSPACE_BATCH_FILES,
  MAX_WORKSPACE_TEXT_FILE_BYTES,
  createWorkspaceController,
  readDirectoryEntriesBounded
} = require('../main/workspace');
const { createWorkspaceWriteQueue } = require('../main/workspace-write-tracker');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for workspace transition state');
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-transition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  if (typeof options.setup === 'function') options.setup({ source, target });
  const handlers = new Map();
  const events = [];
  const lifecycle = [];
  const transitions = [];
  const baseQueue = createWorkspaceWriteQueue();
  const queue = {
    run: baseQueue.run,
    transition(reason, operation) {
      transitions.push(reason);
      return baseQueue.transition(reason, operation);
    }
  };
  const webContents = {
    isDestroyed: () => false,
    isLoadingMainFrame: () => true,
    send(channel, payload) { events.push({ channel, payload }); }
  };
  const controller = createWorkspaceController({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => handlers.set(channel, handler)
    },
    dialog: {},
    getWindow: () => ({ isDestroyed: () => false, webContents }),
    settings: {
      rememberRecentWorkspace() {},
      readProjectNames: () => ({}),
      saveProjectName: () => true
    },
    t: (value) => value,
    assertSafeLocalRoot: (value) => fs.realpathSync(path.resolve(value)),
    workspaceWriteQueue: queue,
    beforeWorkspaceChange: (reason) => { lifecycle.push('before:' + reason); },
    afterWorkspaceChange: (reason) => { lifecycle.push('after:' + reason); },
    stopTerminal: (reason) => { lifecycle.push('stop:' + reason); },
    syncMeasurementLimits: options.syncMeasurementLimits,
    treeScanLimits: options.treeScanLimits,
    watcherLimits: options.watcherLimits
  });
  controller.registerIpc();
  t.after(() => controller.clearWatchers());
  const opened = await handlers.get('pick-workspace')({}, source);
  return { controller, events, handlers, lifecycle, opened, source, target, transitions };
}

test('workspace switch drains an accepted create and blocks late mutations before changing identity', async (t) => {
  const value = await fixture(t);
  const originalWriteFile = fs.promises.writeFile;
  const entered = deferred();
  const release = deferred();
  const slowPath = path.join(value.source, 'slow.txt');
  fs.promises.writeFile = async function(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(slowPath)) {
      entered.resolve();
      await release.promise;
    }
    return originalWriteFile.call(this, filePath, ...args);
  };
  t.after(() => { fs.promises.writeFile = originalWriteFile; });

  const sourceIdentity = value.controller.getIdentity().workspaceIdentity;
  const creating = value.handlers.get('create-file')({}, { parentDir: value.source, name: 'slow.txt' });
  await entered.promise;
  const switching = value.handlers.get('pick-workspace')({}, value.target);
  await waitFor(() => value.transitions.filter((reason) => reason === 'workspace-switch').length === 2);

  await assert.rejects(
    value.handlers.get('create-folder')({}, { parentDir: value.source, name: 'late' }),
    (error) => error && error.code === 'WORKSPACE_TRANSITION_IN_PROGRESS'
  );
  assert.equal(value.controller.getIdentity().rootPath, fs.realpathSync(value.source));
  assert.deepEqual(value.lifecycle, []);

  release.resolve();
  await Promise.all([creating, switching]);
  assert.equal(fs.readFileSync(slowPath, 'utf8'), '');
  assert.equal(fs.existsSync(path.join(value.source, 'late')), false);
  assert.equal(value.controller.getIdentity().rootPath, fs.realpathSync(value.target));
  assert.deepEqual(value.lifecycle, [
    'before:workspace-switch',
    'stop:workspace-switch',
    'after:workspace-switch-complete'
  ]);
  const created = value.events.find((event) => event.channel === 'file-event' && event.payload.path === slowPath);
  assert.ok(created);
  assert.equal(created.payload.rootPath, fs.realpathSync(value.source));
  assert.equal(created.payload.workspaceIdentity, sourceIdentity);
});

test('workspace close drains active mutations and releases the barrier afterward', async (t) => {
  const value = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const active = value.controller.runMutation('slow-save', async (mutation) => {
    entered.resolve();
    await release.promise;
    mutation.assertCurrent();
  });
  await entered.promise;
  const closing = value.handlers.get('close-workspace')({});
  await waitFor(() => value.transitions.includes('workspace-close'));
  await assert.rejects(
    value.handlers.get('create-file')({}, { parentDir: value.source, name: 'late.txt' }),
    (error) => error && error.code === 'WORKSPACE_TRANSITION_IN_PROGRESS'
  );
  assert.equal(value.controller.getIdentity().rootPath, fs.realpathSync(value.source));
  assert.equal(value.lifecycle.includes('before:workspace-close'), false);
  release.resolve();
  await Promise.all([active, closing]);
  assert.equal(value.controller.getIdentity().rootPath, null);
  assert.deepEqual(value.lifecycle, ['before:workspace-close', 'after:workspace-close-complete']);
});

test('window close holds package completion until the window reports closed', async (t) => {
  const value = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const active = value.controller.runMutation('window-close-write', async (mutation) => {
    entered.resolve();
    await release.promise;
    mutation.assertCurrent();
  });
  await entered.promise;
  const preparing = value.controller.prepareWindowClose();
  await waitFor(() => value.transitions.includes('window-close'));
  assert.equal(value.controller.getIdentity().rootPath, fs.realpathSync(value.source));
  release.resolve();
  const prepared = await preparing;
  await active;
  assert.equal(value.controller.getIdentity().rootPath, null);
  assert.deepEqual(value.lifecycle, ['before:window-close']);
  assert.equal(await prepared.complete('window-close-complete'), true);
  assert.equal(await prepared.complete('window-close-complete'), false);
  assert.deepEqual(value.lifecycle, ['before:window-close', 'after:window-close-complete']);
});

test('artifact context changes cannot overtake an accepted artifact write', async (t) => {
  const value = await fixture(t);
  const identity = value.controller.getIdentity();
  await value.handlers.get('artifact-run-context')({}, {
    workspaceRoot: identity.rootPath,
    workspaceIdentity: identity.workspaceIdentity,
    runNonce: 9
  });
  const entered = deferred();
  const release = deferred();
  const hold = value.controller.runMutation('artifact-hold', async (mutation) => {
    entered.resolve();
    await release.promise;
    mutation.assertCurrent();
  });
  await entered.promise;
  const saving = value.handlers.get('save-artifact')({}, {
    workspaceRoot: identity.rootPath,
    workspaceIdentity: identity.workspaceIdentity,
    runNonce: 9,
    relativePath: 'build/output.txt',
    content: 'artifact'
  });
  const clearing = value.handlers.get('artifact-run-context')({}, { clear: true, runNonce: 9 });
  release.resolve();
  const [saved] = await Promise.all([saving, clearing, hold]);
  assert.equal(saved.success, true);
  assert.equal(fs.readFileSync(path.join(value.source, 'build', 'output.txt'), 'utf8'), 'artifact');
});

test('binary saves distinguish create from overwrite using the captured workspace identity', async (t) => {
  const value = await fixture(t);
  const filePath = path.join(value.source, 'asset.bin');
  await value.handlers.get('save-binary-file')({}, {
    filePath,
    content: Buffer.from('one').toString('base64')
  });
  await value.handlers.get('save-binary-file')({}, {
    filePath,
    content: Buffer.from('two').toString('base64')
  });
  const events = value.events
    .filter((event) => event.channel === 'file-event' && event.payload.path === filePath && event.payload.nodeType === 'file')
    .map((event) => event.payload.event);
  assert.deepEqual(events, ['file-created', 'file-changed']);
});

test('external file notifications reject a stale source workspace identity', async (t) => {
  const value = await fixture(t);
  const sourceIdentity = value.controller.getIdentity();
  await value.handlers.get('pick-workspace')({}, value.target);
  const before = value.events.length;
  assert.equal(value.controller.notifyExternalFileChanges([{
    path: path.join(value.source, 'late.txt'),
    event: 'file-created'
  }], sourceIdentity), false);
  assert.equal(value.events.length, before);

  const targetIdentity = value.controller.getIdentity();
  const targetFile = path.join(value.target, 'current.txt');
  assert.equal(value.controller.notifyExternalFileChanges([{
    path: targetFile,
    event: 'file-created'
  }], targetIdentity), true);
  const notified = value.events.find((event) => event.channel === 'file-event' && event.payload.path === targetFile);
  assert.ok(notified);
  assert.equal(notified.payload.workspaceIdentity, targetIdentity.workspaceIdentity);
});

test('DAP configuration creation uses the workspace mutation coordinator', async (t) => {
  const value = await fixture(t);
  const dap = createDapController({
    ipcMain: {
      handle: (channel, handler) => value.handlers.set(channel, handler),
      on: (channel, handler) => value.handlers.set(channel, handler)
    },
    getWindow: () => null,
    getWorkspaceIdentity: value.controller.getIdentity,
    runWorkspaceMutation: value.controller.runMutation,
    settings: { readServerSettings: async () => ({}), readAuth: () => ({ servers: {} }) }
  });
  dap.registerIpc();
  const entered = deferred();
  const release = deferred();
  const active = value.controller.runMutation('hold', async (mutation) => {
    entered.resolve();
    await release.promise;
    mutation.assertCurrent();
  });
  await entered.promise;
  const switching = value.handlers.get('pick-workspace')({}, value.target);
  await waitFor(() => value.transitions.filter((reason) => reason === 'workspace-switch').length === 2);
  await assert.rejects(
    value.handlers.get('dap:ensure-configuration')({}),
    (error) => error && error.code === 'WORKSPACE_TRANSITION_IN_PROGRESS'
  );
  assert.equal(fs.existsSync(path.join(value.source, '.vscode', 'launch.json')), false);
  assert.equal(fs.existsSync(path.join(value.target, '.vscode', 'launch.json')), false);
  release.resolve();
  await Promise.all([active, switching]);
  const filePath = await value.handlers.get('dap:ensure-configuration')({});
  assert.equal(filePath, path.join(fs.realpathSync(value.target), '.vscode', 'launch.json'));
  assert.equal(fs.existsSync(filePath), true);
});

test('an accepted Agent workspace write completes before workspace switch and keeps its source identity', async (t) => {
  const value = await fixture(t);
  const userData = path.join(path.dirname(value.source), 'agent-user-data');
  const home = path.join(path.dirname(value.source), 'agent-home');
  fs.mkdirSync(userData);
  fs.mkdirSync(home);
  const queued = deferred();
  const broker = createAgentPlatformBroker({
    app: {
      getPath(name) {
        if (name === 'userData') return userData;
        if (name === 'home') return home;
        throw new Error('unexpected path');
      }
    },
    settings: { readAiSettings: async () => ({ chatProfiles: [], inlineProfiles: [] }) },
    getWorkspaceIdentity: value.controller.getIdentity,
    runWorkspaceMutation(scope, operation) {
      queued.resolve();
      return value.controller.runMutation(scope, operation);
    },
    notifyWorkspaceFiles: value.controller.notifyExternalFileChanges,
    requestModel: async () => ({ success: true, data: {} })
  });
  t.after(() => broker.dispose());
  const filePath = path.join(value.source, 'agent.txt');
  fs.writeFileSync(filePath, 'before');
  const current = await broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_read', input: { path: 'agent.txt' }
  });
  const approval = await broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write',
    input: { path: 'agent.txt', content: 'after', expectedSha256: current.sha256 }
  });
  const entered = deferred();
  const release = deferred();
  const hold = value.controller.runMutation('agent-hold', async (mutation) => {
    entered.resolve();
    await release.promise;
    mutation.assertCurrent();
  });
  await entered.promise;
  const writing = broker.decideApproval('acme.agent', approval.approval.id, true);
  await queued.promise;
  const switching = value.handlers.get('pick-workspace')({}, value.target);
  await waitFor(() => value.transitions.filter((reason) => reason === 'workspace-switch').length === 2);
  assert.equal(value.controller.getIdentity().rootPath, fs.realpathSync(value.source));
  release.resolve();
  await Promise.all([hold, writing, switching]);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'after');
  assert.equal(value.controller.getIdentity().rootPath, fs.realpathSync(value.target));
  const event = value.events.find((item) => item.channel === 'file-event' && item.payload.path === filePath);
  assert.ok(event);
  assert.equal(event.payload.rootPath, fs.realpathSync(value.source));
});

test('workspace text reads reject unsafe and oversized files and bound batches', async (t) => {
  const value = await fixture(t);
  const regular = path.join(value.source, 'regular.txt');
  fs.writeFileSync(regular, 'hello');
  assert.equal(await value.handlers.get('read-file')({}, regular), 'hello');
  const oversizedWrite = path.join(value.source, 'oversized-write.txt');
  await assert.rejects(value.handlers.get('save-file')({}, {
    filePath: oversizedWrite,
    content: '你'.repeat(Math.floor(MAX_WORKSPACE_TEXT_FILE_BYTES / 3) + 1),
    mutationId: 'oversized-multibyte-write'
  }), (error) => error && error.code === 'DATA_TOO_LARGE');
  assert.equal(fs.existsSync(oversizedWrite), false);

  const oversized = path.join(value.source, 'oversized.txt');
  fs.writeFileSync(oversized, Buffer.alloc(MAX_WORKSPACE_TEXT_FILE_BYTES + 1, 0x61));
  await assert.rejects(value.handlers.get('read-file')({}, oversized), (error) => error && error.code === 'DATA_TOO_LARGE');
  await assert.rejects(
    value.handlers.get('read-files')({}, new Array(MAX_WORKSPACE_BATCH_FILES + 1).fill(regular)),
    (error) => error && error.code === 'WORKSPACE_READ_LIMIT'
  );

  const chunkSize = Math.floor(MAX_WORKSPACE_BATCH_BYTES / 3) + 1;
  const batch = [];
  for (let index = 0; index < 3; index += 1) {
    const filePath = path.join(value.source, 'batch-' + index + '.txt');
    fs.writeFileSync(filePath, Buffer.alloc(chunkSize, 0x62));
    batch.push(filePath);
  }
  await assert.rejects(value.handlers.get('read-files')({}, batch), (error) => error && error.code === 'DATA_TOO_LARGE');

  const directory = path.join(value.source, 'directory');
  fs.mkdirSync(directory);
  await assert.rejects(value.handlers.get('read-file')({}, directory), (error) => error && error.code === 'UNSAFE_DATA_FILE');

  const link = path.join(value.source, 'link.txt');
  try {
    fs.symlinkSync(regular, link, 'file');
    await assert.rejects(value.handlers.get('read-file')({}, link), /Symbolic links/);
  } catch (error) {
    if (!error || !['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
});

test('an asynchronous workspace read rejects its result after an identity switch', async (t) => {
  const value = await fixture(t);
  const filePath = path.join(value.source, 'slow-read.txt');
  fs.writeFileSync(filePath, 'old workspace');
  const originalOpen = fs.promises.open;
  const entered = deferred();
  const release = deferred();
  fs.promises.open = async function(candidate, ...args) {
    const handle = await originalOpen.call(this, candidate, ...args);
    if (path.resolve(candidate) !== path.resolve(filePath)) return handle;
    return {
      stat: handle.stat.bind(handle),
      close: handle.close.bind(handle),
      async read(...readArgs) {
        entered.resolve();
        await release.promise;
        return handle.read(...readArgs);
      }
    };
  };
  t.after(() => { fs.promises.open = originalOpen; });

  const reading = value.handlers.get('read-file')({}, filePath);
  await entered.promise;
  await value.handlers.get('pick-workspace')({}, value.target);
  release.resolve();
  await assert.rejects(reading, (error) => error && error.code === 'WORKSPACE_CONTEXT_CHANGED');
});

test('workspace measurement is bounded, cancellable, and excludes virtual environments', async (t) => {
  const value = await fixture(t, {
    setup({ source }) {
      fs.writeFileSync(path.join(source, 'source.txt'), 'source');
      for (const name of ['.venv', 'venv']) {
        fs.mkdirSync(path.join(source, name));
        fs.writeFileSync(path.join(source, name, 'ignored.bin'), Buffer.alloc(1024 * 1024));
      }
    }
  });
  const measured = await value.controller.calculateDirectorySize(value.source);
  assert.equal(measured.size, Buffer.byteLength('source'));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    value.controller.calculateDirectorySize(value.source, { signal: controller.signal }),
    (error) => error && error.code === 'WORKSPACE_SCAN_CANCELLED'
  );

  const limited = await fixture(t, {
    syncMeasurementLimits: { maxEntries: 3 },
    setup({ source }) {
      for (let index = 0; index < 4; index += 1) fs.writeFileSync(path.join(source, 'file-' + index), 'x');
    }
  });
  await assert.rejects(
    limited.controller.calculateDirectorySize(limited.source),
    (error) => error && error.code === 'WORKSPACE_SCAN_LIMIT'
  );
});

test('workspace tree and fallback watchers stop at explicit node and depth budgets', async (t) => {
  const originalWatch = fs.watch;
  let watcherCount = 0;
  fs.watch = function(_directory, options) {
    if (options && options.recursive) throw new Error('recursive watch unavailable');
    watcherCount += 1;
    return { on() {}, close() {} };
  };
  t.after(() => { fs.watch = originalWatch; });
  const value = await fixture(t, {
    treeScanLimits: { maxNodes: 5, maxEntriesPerDirectory: 4, maxDepth: 2, maxPathChars: 32_768 },
    watcherLimits: { maxWatchers: 2, maxDepth: 2 },
    setup({ source }) {
      let current = source;
      for (let depth = 0; depth < 5; depth += 1) {
        current = path.join(current, 'deep-' + depth);
        fs.mkdirSync(current);
      }
      for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(source, 'file-' + index), 'x');
    }
  });
  const pending = [value.opened.tree];
  let nodes = 0;
  let truncated = false;
  while (pending.length) {
    const node = pending.pop();
    nodes += 1;
    truncated = truncated || node.truncated === true;
    if (node.children) pending.push(...node.children);
  }
  assert.equal(truncated, true);
  assert.ok(nodes <= 6, 'tree includes root plus at most maxNodes children');
  assert.ok(watcherCount <= 2);
});

test('bounded directory reads consume only limit plus one lazy entries', async () => {
  let reads = 0;
  let closes = 0;
  const fileSystem = {
    promises: {
      async opendir() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                reads += 1;
                return { done: false, value: { name: 'entry-' + reads } };
              },
              async return() { return { done: true }; }
            };
          },
          async close() { closes += 1; }
        };
      }
    }
  };
  const result = await readDirectoryEntriesBounded('virtual-million-entry-directory', 3, fileSystem);
  assert.equal(result.entries.length, 3);
  assert.equal(result.scanned, 4);
  assert.equal(result.truncated, true);
  assert.equal(reads, 4);
  assert.equal(closes, 1);
});
