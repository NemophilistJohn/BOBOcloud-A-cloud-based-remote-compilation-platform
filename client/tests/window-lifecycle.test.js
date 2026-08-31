'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachWindowLifecycle } = require('../main/window-lifecycle');

function ownerHarness() {
  const events = new Map();
  const webEvents = new Map();
  const owner = {
    webContents: { id: 7, on: (name, handler) => webEvents.set(name, handler) },
    on: (name, handler) => events.set(name, handler),
    isDestroyed: () => false,
    closeCalled: false,
    close() { this.closeCalled = true; }
  };
  return { owner, events, webEvents };
}

test('window lifecycle prepares the workspace barrier and completes it after close', async () => {
  const harness = ownerHarness();
  const calls = [];
  attachWindowLifecycle({
    window: harness.owner,
    dialog: {},
    languagePacks: { t: (value) => value },
    lifecycle: { run: async (reason) => calls.push('lifecycle:' + reason) },
    localDirectories: { revokeSender: (id) => calls.push('revoke:' + id) },
    packageCenter: { preserveAll: async () => calls.push('package:preserve') },
    rcloneService: {
      cancelAll: async () => calls.push('rclone:cancel-all'),
      cancelSender: async (id) => calls.push('rclone:cancel-sender:' + id)
    },
    windowState: { save: () => calls.push('window:save') },
    workspace: {
      requestRendererLeave: async () => ({ allowed: true, leaveToken: 'leave-1' }),
      prepareWindowClose: async () => {
        calls.push('workspace:prepare-close');
        return { complete: async (reason) => calls.push('workspace:finish:' + reason) };
      },
      abortRendererLeave: (token) => calls.push('workspace:abort:' + token),
      handleWindowClosed: () => calls.push('workspace:closed'),
      handleRendererGone: () => calls.push('workspace:gone')
    }
  });
  let prevented = false;
  harness.events.get('close')({ preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(harness.owner.closeCalled, true);
  assert.ok(calls.includes('workspace:prepare-close'));
  harness.events.get('closed')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.includes('workspace:finish:window-close-complete'));
});

test('renderer failure revokes sender grants and cancels sender-scoped rclone work', async () => {
  const harness = ownerHarness();
  const calls = [];
  attachWindowLifecycle({
    window: harness.owner,
    dialog: {}, languagePacks: { t: (value) => value }, windowState: { save() {} },
    lifecycle: { run: async () => {} },
    localDirectories: { revokeSender: (id) => calls.push('revoke:' + id) },
    packageCenter: { preserveAll: async () => {}, beginWorkspaceTransition: async () => {}, endWorkspaceTransition: async () => {} },
    rcloneService: { cancelAll: async () => {}, cancelSender: async (id) => calls.push('cancel:' + id) },
    workspace: { requestRendererLeave: async () => ({ allowed: false }), handleWindowClosed() {}, handleRendererGone() {} }
  });
  harness.webEvents.get('render-process-gone')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['revoke:7', 'cancel:7']);
});

for (const scenario of [
  { name: 'cancel keeps the window open', response: 0, closes: false },
  { name: 'explicit confirmation closes the unresponsive window', response: 1, closes: true }
]) {
  test('window close timeout: ' + scenario.name, async () => {
    const harness = ownerHarness();
    const calls = [];
    let dialogOptions = null;
    attachWindowLifecycle({
      window: harness.owner,
      dialog: {
        async showMessageBox(_owner, options) {
          dialogOptions = options;
          return { response: scenario.response };
        }
      },
      languagePacks: { t: (value) => value },
      lifecycle: { run: async () => {} },
      localDirectories: { revokeSender() {} },
      packageCenter: {
        preserveAll: async () => {}
      },
      rcloneService: {
        cancelAll: async () => calls.push('rclone:cancel-all'),
        cancelSender: async () => {}
      },
      windowState: { save() {} },
      workspace: {
        requestRendererLeave: async () => ({ allowed: false, timedOut: true, leaveToken: 'timeout-token' }),
        prepareWindowClose: async () => {
          calls.push('workspace:prepare-close');
          return { complete: async () => {} };
        },
        abortRendererLeave: (token) => calls.push('workspace:abort:' + token),
        handleWindowClosed() {},
        handleRendererGone() {}
      }
    });
    let prevented = false;
    harness.events.get('close')({ preventDefault: () => { prevented = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.equal(dialogOptions.defaultId, 0);
    assert.equal(dialogOptions.cancelId, 0);
    assert.equal(harness.owner.closeCalled, scenario.closes);
    assert.deepEqual(calls, scenario.closes
      ? ['workspace:prepare-close']
      : ['workspace:abort:timeout-token']);
  });
}

test('window close preparation failure aborts the renderer leave lock', async () => {
  const harness = ownerHarness();
  const calls = [];
  attachWindowLifecycle({
    window: harness.owner,
    dialog: {},
    languagePacks: { t: (value) => value },
    lifecycle: { run: async () => {} },
    localDirectories: { revokeSender() {} },
    packageCenter: { preserveAll: async () => {} },
    rcloneService: { cancelSender: async () => {} },
    windowState: { save() {} },
    workspace: {
      requestRendererLeave: async () => ({ allowed: true, leaveToken: 'leave-failed' }),
      prepareWindowClose: async () => { throw new Error('package transition failed'); },
      abortRendererLeave: (token) => calls.push(token),
      handleWindowClosed() {},
      handleRendererGone() {}
    }
  });
  harness.events.get('close')({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.owner.closeCalled, false);
  assert.deepEqual(calls, ['leave-failed']);
});
