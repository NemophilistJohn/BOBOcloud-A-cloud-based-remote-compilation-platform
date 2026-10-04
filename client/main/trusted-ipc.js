'use strict';

const UNTRUSTED_WORKBENCH_IPC_CODE = 'ERR_UNTRUSTED_WORKBENCH_IPC';
const IPC_CHANNEL_NOT_ALLOWED_CODE = 'ERR_IPC_CHANNEL_NOT_ALLOWED';

function invalidSender(channel, reason) {
  const error = new Error(`Blocked untrusted workbench IPC sender for "${channel}": ${reason}`);
  error.code = UNTRUSTED_WORKBENCH_IPC_CODE;
  return error;
}

function invalidChannel(channel, direction) {
  const error = new TypeError(`IPC ${direction} channel is not declared by the preload contract: "${channel}"`);
  error.code = IPC_CHANNEL_NOT_ALLOWED_CODE;
  return error;
}

function normalizeChannelSet(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`IPC channel policy ${label} must be an array`);
  const channels = new Set();
  for (const channel of value) {
    if (typeof channel !== 'string' || !channel.trim()) {
      throw new TypeError(`IPC channel policy ${label} contains an invalid channel`);
    }
    const normalized = channel.trim();
    if (channels.has(normalized)) {
      throw new TypeError(`IPC channel policy ${label} contains a duplicate channel: ${normalized}`);
    }
    channels.add(normalized);
  }
  return channels;
}

function normalizeChannelPolicy(policy) {
  if (policy === undefined || policy === null) return null;
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('IPC channel policy must be an object');
  }
  return Object.freeze({
    invoke: normalizeChannelSet(policy.invoke, 'invoke'),
    send: normalizeChannelSet(policy.send, 'send'),
    event: normalizeChannelSet(policy.event, 'event')
  });
}

function assertAllowedChannel(channel, channels, direction) {
  if (typeof channel !== 'string' || !channel.trim()) {
    throw new TypeError('IPC channel must be a non-empty string');
  }
  const normalized = channel.trim();
  if (channels && !channels.has(normalized)) throw invalidChannel(normalized, direction);
  return normalized;
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
  const policy = normalizeChannelPolicy(options && options.allowedChannels);
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('A complete ipcMain implementation is required');
  }
  if (typeof getWindow !== 'function') throw new TypeError('getWindow must be a function');

  function protect(channel, listener, ignoreUntrusted) {
    const direction = ignoreUntrusted ? 'send' : 'invoke';
    const channels = policy && policy[direction];
    channel = assertAllowedChannel(channel, channels, direction);
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

function dispatchRendererEvent(owner, channel, payload) {
  if (!owner || (typeof owner.isDestroyed === 'function' && owner.isDestroyed())) return false;
  const webContents = owner.webContents;
  if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) return false;
  if (typeof webContents.send !== 'function') {
    throw new TypeError('The workbench renderer does not provide webContents.send');
  }
  try {
    webContents.send(channel, payload);
    return true;
  } catch (error) {
    // A renderer can disappear between the checks above and send(). Treat the
    // normal teardown race as a dropped event; preserve all other failures.
    if ((typeof owner.isDestroyed === 'function' && owner.isDestroyed()) ||
        (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) return false;
    throw error;
  }
}

/**
 * Creates the only main-process capability allowed to emit renderer events.
 * The optional sendToWindow form is used by long-lived transports so an event
 * cannot migrate to a newly-created workbench window after the original one
 * has been closed.
 */
function createTrustedRendererSender(options) {
  const getWindow = options && options.getWindow;
  // Pure main-process unit tests and headless maintenance paths may not own a
  // BrowserWindow. Outbound notifications are optional in that context; keep
  // the capability inert instead of making the business controller depend on
  // a renderer just to construct.
  if (typeof getWindow !== 'function') {
    return Object.freeze({
      send() { return false; },
      sendToWindow() { return false; }
    });
  }
  const policy = normalizeChannelPolicy(options && options.allowedChannels);
  const eventChannels = policy && policy.event;

  function sendToWindow(owner, channel, payload) {
    const normalized = assertAllowedChannel(channel, eventChannels, 'renderer event');
    if (owner !== getWindow()) return false;
    return dispatchRendererEvent(owner, normalized, payload);
  }

  return Object.freeze({
    send(channel, payload) {
      const normalized = assertAllowedChannel(channel, eventChannels, 'renderer event');
      return dispatchRendererEvent(getWindow(), normalized, payload);
    },
    sendToWindow
  });
}

module.exports = {
  IPC_CHANNEL_NOT_ALLOWED_CODE,
  UNTRUSTED_WORKBENCH_IPC_CODE,
  assertTrustedWorkbenchFrame,
  createTrustedIpcMain,
  createTrustedRendererSender
};
