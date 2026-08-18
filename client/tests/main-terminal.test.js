'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalController } = require('../main/terminal');

class FakeTransport {
  constructor(options) {
    this.options = options;
    this.state = 'idle';
    this.config = null;
    this.writes = [];
    this.resizes = [];
  }
  async start(config) {
    this.config = config;
    this.state = 'ready';
    this.options.emit('status', { state: 'ready', sessionId: 'term-1', contextToken: config.localContext });
    return { sessionId: 'term-1', runtimeId: config.runtimeId, snapshot: true };
  }
  snapshot() { return { state: this.state, sessionId: this.state === 'ready' ? 'term-1' : '', contextToken: this.config && this.config.localContext }; }
  write(data) { this.writes.push(data); return { accepted: true }; }
  resize(cols, rows) { this.resizes.push({ cols, rows }); return { accepted: true }; }
  stop() { this.state = 'idle'; this.options.emit('status', { state: 'idle', sessionId: '', contextToken: this.config && this.config.localContext }); return { state: 'idle' }; }
  async dispose() { this.stop(); }
}

function createHarness() {
  const handlers = new Map();
  const sent = [];
  const webContents = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const window = { isDestroyed: () => false, webContents };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  let workspace = { rootPath: 'C:/work/demo', workspaceIdentity: 7 };
  let created;
  const controller = createTerminalController({
    ipcMain,
    getWindow: () => window,
    getWorkspaceIdentity: () => workspace,
    settings: {
      readServerSettings: async () => ({ ip: 'cloud.example', wsPort: 3101, apiKey: 'fallback-key' }),
      readAuth: () => ({ servers: { 'cloud.example': { token: 'stored-token', expiresAt: Date.now() + 60000 } } })
    },
    Transport: class extends FakeTransport { constructor(options) { super(options); created = this; } }
  });
  controller.registerIpc();
  return {
    handlers, sent, controller, get transport() { return created; }, event: { sender: webContents },
    moveWorkspace: () => { workspace = { rootPath: 'C:/work/other', workspaceIdentity: 8 }; }
  };
}

test('terminal main controller keeps credentials in main and binds the session to its workspace', async () => {
  const harness = createHarness();
  const start = harness.handlers.get('terminal:start');
  const result = await start(harness.event, {
    runtimeId: 'python:3.12', cols: 110, rows: 30,
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    context: { workspaceRoot: 'C:/work/demo', workspaceIdentity: 7, workspaceGeneration: 4, authEpoch: 2 }
  });
  assert.deepEqual(result, {
    sessionId: 'term-1', runtimeId: 'python:3.12', snapshot: true,
    context: { workspaceRoot: 'C:/work/demo', workspaceIdentity: 7, workspaceGeneration: 4, authEpoch: 2 }
  });
  assert.equal(harness.transport.config.serverHost, 'http://cloud.example:3101');
  assert.deepEqual(harness.transport.config.workspace, { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' });
  assert.doesNotMatch(JSON.stringify(result), /stored-token|fallback-key/);
  assert.equal(harness.sent.at(-1).channel, 'terminal:status');
  assert.doesNotMatch(JSON.stringify(harness.sent.at(-1).payload), /stored-token|fallback-key/);

  const write = harness.handlers.get('terminal:write');
  await write(harness.event, 'echo hello\r');
  assert.deepEqual(harness.transport.writes, ['echo hello\r']);
  harness.moveWorkspace();
  await assert.rejects(write(harness.event, 'echo old\r'), /workspace changed/);
  assert.deepEqual(harness.transport.writes, ['echo hello\r']);
});

test('terminal main controller rejects stale start contexts, Local runtime, and foreign renderers', async () => {
  const harness = createHarness();
  const start = harness.handlers.get('terminal:start');
  const valid = {
    runtimeId: 'python:3.12', workspace: { kind: 'personal', folderKey: 'demo-key' },
    context: { workspaceRoot: 'C:/work/demo', workspaceIdentity: 7 }
  };
  await assert.rejects(start(harness.event, Object.assign({}, valid, { runtimeId: 'Local' })), /Docker runtime/);
  await assert.rejects(start(harness.event, Object.assign({}, valid, { context: { workspaceRoot: 'C:/work/stale', workspaceIdentity: 7 } })), /workspace changed/);
  await assert.rejects(start({ sender: {} }, valid), /active workbench/);
});
