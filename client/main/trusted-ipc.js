'use strict';

const UNTRUSTED_WORKBENCH_IPC_CODE = 'ERR_UNTRUSTED_WORKBENCH_IPC';

function invalidSender(channel, reason) {
  const error = new Error(`Blocked untrusted workbench IPC sender for "${channel}": ${reason}`);
  error.code = UNTRUSTED_WORKBENCH_IPC_CODE;
  return error;
}

function assertTrustedWorkbenchFrame(event, getWindow, channel = 'unknown') {
  const owner = getWindow();
  if (!owner || (typeof owner.isDestroyed === 'function' && owner.isDestroyed())) {
    throw invalidSender(channel, 'no active workbench window');
  }

  const expectedSender = owner.webContents;
  if (!expectedSender || (typeof expectedSender.isDestroyed === 'function' && expectedSender.isDestroyed())) {
    throw invalidSender(channel, 'the workbench renderer is unavailable');
  }
  if (!event || event.sender !== expectedSender) {
    throw invalidSender(channel, 'the sender is not the active workbench');
  }

  const mainFrame = expectedSender.mainFrame;
  if (!mainFrame || event.senderFrame !== mainFrame) {
    throw invalidSender(channel, 'only the workbench main frame is allowed');
  }
  return owner;
}

function createTrustedIpcMain(options) {
  const ipcMain = options && options.ipcMain;
  const getWindow = options && options.getWindow;
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('A complete ipcMain implementation is required');
  }
  if (typeof getWindow !== 'function') throw new TypeError('getWindow must be a function');

  function protect(channel, listener, ignoreUntrusted) {
    if (typeof channel !== 'string' || !channel) throw new TypeError('IPC channel must be a non-empty string');
    if (typeof listener !== 'function') throw new TypeError(`IPC listener for "${channel}" must be a function`);
    return function trustedWorkbenchListener(event, ...args) {
      try {
        assertTrustedWorkbenchFrame(event, getWindow, channel);
      } catch (error) {
        if (ignoreUntrusted && error && error.code === UNTRUSTED_WORKBENCH_IPC_CODE) return undefined;
        throw error;
      }
      return Reflect.apply(listener, this, [event, ...args]);
    };
  }

  return Object.freeze({
    handle(channel, listener) {
      return ipcMain.handle(channel, protect(channel, listener, false));
    },
    on(channel, listener) {
      // One-way sends have no rejection channel; ignore them instead of letting an untrusted frame crash main.
      return ipcMain.on(channel, protect(channel, listener, true));
    }
  });
}

module.exports = {
  UNTRUSTED_WORKBENCH_IPC_CODE,
  assertTrustedWorkbenchFrame,
  createTrustedIpcMain
};
