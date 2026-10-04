'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  UNTRUSTED_WORKBENCH_IPC_CODE,
  IPC_CHANNEL_NOT_ALLOWED_CODE,
  assertTrustedWorkbenchFrame,
  createTrustedIpcMain,
  createTrustedRendererSender
} = require('../main/trusted-ipc');

test('renderer events enforce the preload policy and remain bound to their original window', () => {
  const delivered = [];
  const first = { webContents: { send: (...args) => delivered.push(args) } };
  const second = { webContents: { send: (...args) => delivered.push(args) } };
  let current = first;
  let reads = 0;
  const sender = createTrustedRendererSender({
    getWindow: () => { reads += 1; return current; },
    allowedChannels: { invoke: [], send: [], event: ['run-result'] }
  });
  assert.equal(sender.send('run-result', { code: 0 }), true);
  assert.equal(reads, 1);
  assert.throws(() => sender.send('undeclared-event', {}), { code: IPC_CHANNEL_NOT_ALLOWED_CODE });
  current = second;
  assert.equal(sender.sendToWindow(first, 'run-result', { code: 1 }), false);
  assert.equal(sender.sendToWindow(second, 'run-result', { code: 2 }), true);
  second.isDestroyed = () => true;
  assert.equal(sender.send('run-result', { code: 3 }), false);
  assert.deepEqual(delivered, [['run-result', { code: 0 }], ['run-result', { code: 2 }]]);
});

test('headless renderer sender safely drops optional notifications', () => {
  const sender = createTrustedRendererSender({});
  assert.equal(sender.send('run-result', {}), false);
  assert.equal(sender.sendToWindow({}, 'run-result', {}), false);
});

test('trusted IPC rejects channels registered in the wrong preload direction', () => {
  const registrations = [];
  const ipc = createTrustedIpcMain({
    ipcMain: { handle: (channel) => registrations.push(channel), on: (channel) => registrations.push(channel) },
    getWindow: () => null,
    allowedChannels: { invoke: ['workspace-read'], send: ['auth-state-update'], event: [] }
  });
  assert.throws(() => ipc.handle('auth-state-update', () => {}), { code: IPC_CHANNEL_NOT_ALLOWED_CODE });
  assert.throws(() => ipc.on('workspace-read', () => {}), { code: IPC_CHANNEL_NOT_ALLOWED_CODE });
  assert.deepEqual(registrations, []);
});

function harness() {
  const handlers = new Map();
  const listeners = new Map();
  const registrations = [];
  const mainFrame = { routingId: 5 };
  const webContents = { mainFrame, isDestroyed: () => false };
  let window = { webContents, isDestroyed: () => false };
  const rawIpcMain = {
    handle(channel, listener) {
      handlers.set(channel, listener);
      registrations.push(['handle', channel]);
      return `handle:${channel}`;
    },
    on(channel, listener) {
      listeners.set(channel, listener);
      registrations.push(['on', channel]);
      return `on:${channel}`;
    }
  };
  const trustedIpcMain = createTrustedIpcMain({ ipcMain: rawIpcMain, getWindow: () => window });
  return {
    handlers,
    listeners,
    mainFrame,
    registrations,
    trustedIpcMain,
    validEvent: { sender: webContents, senderFrame: mainFrame },
    webContents,
    setWindow(value) { window = value; }
  };
}

function assertUntrusted(action, reason) {
  assert.throws(action, (error) => {
    assert.equal(error.code, UNTRUSTED_WORKBENCH_IPC_CODE);
    assert.match(error.message, reason);
    return true;
  });
}

test('trusted handlers preserve channels, arguments, return values, and listener context', async () => {
  const value = harness();
  const context = { marker: 'context' };
  const registration = value.trustedIpcMain.handle('workspace-read', function (event, one, two) {
    assert.equal(this, context);
    assert.equal(event, value.validEvent);
    return { one, two };
  });

  assert.equal(registration, 'handle:workspace-read');
  assert.deepEqual(value.registrations, [['handle', 'workspace-read']]);
  assert.deepEqual(
    await Reflect.apply(value.handlers.get('workspace-read'), context, [value.validEvent, 1, { value: 2 }]),
    { one: 1, two: { value: 2 } }
  );
});

test('trusted event listeners are guarded before application state can change', () => {
  const value = harness();
  let received = null;
  const registration = value.trustedIpcMain.on('auth-state-update', (_event, state) => { received = state; });
  assert.equal(registration, 'on:auth-state-update');

  assert.doesNotThrow(() => value.listeners.get('auth-state-update')({
    sender: value.webContents,
    senderFrame: { routingId: 9 }
  }, { loggedIn: true }));
  assert.equal(received, null);

  value.listeners.get('auth-state-update')(value.validEvent, { loggedIn: true });
  assert.deepEqual(received, { loggedIn: true });
});

test('other windows and sandboxed subframes cannot reach workbench IPC handlers', () => {
  const value = harness();
  let invoked = false;
  value.trustedIpcMain.handle('plugins:rpc', () => { invoked = true; });
  assertUntrusted(() => value.handlers.get('plugins:rpc')({
    sender: value.webContents,
    senderFrame: { routingId: 12 }
  }), /only the workbench main frame/);
  assert.equal(invoked, false);

  assertUntrusted(() => assertTrustedWorkbenchFrame({
    sender: { mainFrame: {} },
    senderFrame: {}
  }, () => ({ webContents: value.webContents, isDestroyed: () => false }), 'read-file'), /not the active workbench/);

  assertUntrusted(() => assertTrustedWorkbenchFrame({
    sender: value.webContents,
    senderFrame: { routingId: 13 }
  }, () => ({ webContents: value.webContents, isDestroyed: () => false }), 'plugins:rpc'), /only the workbench main frame/);
});

test('IPC fails closed while the workbench or its renderer is unavailable', () => {
  const value = harness();
  value.setWindow(null);
  assertUntrusted(() => assertTrustedWorkbenchFrame(
    value.validEvent,
    () => null,
    'workspace-identity'
  ), /no active workbench window/);

  value.setWindow({ webContents: value.webContents, isDestroyed: () => true });
  assertUntrusted(() => assertTrustedWorkbenchFrame(value.validEvent, () => ({
    webContents: value.webContents,
    isDestroyed: () => true
  }), 'workspace-identity'), /no active workbench window/);

  const destroyedContents = { mainFrame: value.mainFrame, isDestroyed: () => true };
  assertUntrusted(() => assertTrustedWorkbenchFrame({ sender: destroyedContents, senderFrame: value.mainFrame }, () => ({
    webContents: destroyedContents,
    isDestroyed: () => false
  }), 'workspace-identity'), /renderer is unavailable/);
});

test('main-process composition exposes only the guarded ipcMain facade to feature owners', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /ipcMain:\s*electronIpcMain/);
  assert.match(source,
    /createTrustedIpcMain\(\{\s*ipcMain:\s*electronIpcMain,\s*getWindow(?:,\s*allowedChannels:\s*IPC_CHANNEL_POLICY)?\s*\}\)/);
  assert.equal((source.match(/\belectronIpcMain\b/g) || []).length, 2,
    'raw Electron ipcMain must only be imported and wrapped');
});
