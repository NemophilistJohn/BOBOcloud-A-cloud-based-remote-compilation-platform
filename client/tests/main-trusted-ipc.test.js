'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  UNTRUSTED_WORKBENCH_IPC_CODE,
  assertTrustedWorkbenchFrame,
  createTrustedIpcMain
} = require('../main/trusted-ipc');

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
  assert.match(source, /createTrustedIpcMain\(\{\s*ipcMain:\s*electronIpcMain,\s*getWindow\s*\}\)/);
  assert.equal((source.match(/\belectronIpcMain\b/g) || []).length, 2,
    'raw Electron ipcMain must only be imported and wrapped');
});
