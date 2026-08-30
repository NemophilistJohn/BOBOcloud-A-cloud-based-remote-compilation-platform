'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLocalDirectoryAuthority } = require('../main/local-directory-authority');
const { registerRcloneIpc } = require('../main/rclone-ipc');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  const handlers = new Map();
  const calls = { sync: [], pull: [], list: [], select: [], dialogs: [], progress: [] };
  const mainFrame = {};
  const webContents = { id: 73, mainFrame, send: (...args) => calls.progress.push(args) };
  const owner = { webContents, isDestroyed: () => false };
  const workspaceIdentity = { rootPath: workspaceRoot, workspaceIdentity: 4 };
  const authority = createLocalDirectoryAuthority({ assertSafeLocalRoot: (candidate) => path.resolve(candidate) });
  let dialogResponse = 0;
  let openDialogResult = { canceled: true, filePaths: [] };
  const service = {
    async sync(payload) { calls.sync.push(payload); return { success: true }; },
    async pull(payload) { calls.pull.push(payload); return { success: true }; },
    async listBinaries(senderId) { calls.list.push(senderId); return { scanId: 'opaque-scan', candidates: [] }; },
    async getSelection() { return { source: 'bundled' }; },
    async checkVersion() { return { available: true, source: 'bundled' }; },
    async selectBinary(senderId, payload, confirm) {
      calls.select.push({ senderId, payload });
      const confirmed = await confirm({ path: 'C:\\Tools\\rclone.exe' });
      return { cancelled: !confirmed };
    }
  };
  registerRcloneIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: () => owner },
    dialog: {
      async showMessageBox(_owner, options) {
        calls.dialogs.push(options);
        return { response: dialogResponse };
      },
      async showOpenDialog() { return openDialogResult; }
    },
    getWindow: () => owner,
    getWorkspaceIdentity: () => workspaceIdentity,
    localDirectoryAuthority: authority,
    service,
    t: (value, replacements) => String(value).replace(/\{([^}]+)\}/g, (match, key) => (
      replacements && replacements[key] !== undefined ? replacements[key] : match
    ))
  });
  return {
    authority,
    calls,
    handlers,
    workspaceIdentity,
    event: { sender: webContents, senderFrame: mainFrame },
    setDialogResponse(value) { dialogResponse = value; },
    setOpenDialogResult(value) { openDialogResult = value; }
  };
}

function workspaceScope(value) {
  return {
    type: 'workspace',
    rootPath: value.workspaceIdentity.rootPath,
    workspaceIdentity: value.workspaceIdentity.workspaceIdentity
  };
}

test('rclone IPC rejects renderer executable/local paths and resolves the active workspace in main', async (t) => {
  const value = fixture(t);
  await assert.rejects(value.handlers.get('rclone:sync')(value.event, {
    operationId: 'evil', src: 'C:\\private', remotePath: '/remote'
  }), /local paths are no longer accepted/);
  assert.equal(value.calls.sync.length, 0);

  await value.handlers.get('rclone:sync')(value.event, {
    operationId: 'sync', localScope: workspaceScope(value), remotePath: '/remote/workspace'
  });
  await value.handlers.get('rclone:pull')(value.event, {
    operationId: 'pull', localScope: workspaceScope(value), remotePath: '/remote/workspace'
  });
  assert.equal(value.calls.sync[0].src, fs.realpathSync(value.workspaceIdentity.rootPath));
  assert.equal(value.calls.pull[0].dest, fs.realpathSync(value.workspaceIdentity.rootPath));
  value.calls.sync[0].onProgress('copying');
  assert.deepEqual(value.calls.progress[0], ['rclone:progress', { operationId: 'sync', line: 'copying' }]);

  await assert.rejects(value.handlers.get('rclone:pull')(value.event, {
    localScope: { type: 'workspace', rootPath: value.workspaceIdentity.rootPath, workspaceIdentity: 3 },
    remotePath: '/remote/workspace'
  }), /scope is stale/);
  await assert.rejects(value.handlers.get('rclone:sync')(value.event, {
    localScope: workspaceScope(value), remotePath: '/remote/../etc'
  }), /Invalid remote workspace path/);
});

test('team pulls require an opaque grant created by the native directory picker', async (t) => {
  const value = fixture(t);
  const mapping = path.join(path.dirname(value.workspaceIdentity.rootPath), 'mapping');
  fs.mkdirSync(mapping);
  value.setOpenDialogResult({ canceled: false, filePaths: [mapping] });
  const picked = await value.handlers.get('pick-local-mapping')(value.event);
  assert.equal(picked.path, fs.realpathSync(mapping));
  assert.ok(picked.grantId);

  await value.handlers.get('rclone:pull')(value.event, {
    localScope: { type: 'mapping', grantId: picked.grantId },
    remotePath: '/remote/team'
  });
  assert.equal(value.calls.pull[0].dest, fs.realpathSync(mapping));
  await assert.rejects(value.handlers.get('rclone:pull')(value.event, {
    localScope: { type: 'mapping', grantId: 'invented' },
    remotePath: '/remote/team'
  }), /missing or expired/);
});

test('version checks and candidate scans are bound to the active main frame', async (t) => {
  const value = fixture(t);
  const scan = await value.handlers.get('rclone:list-binaries')(value.event);
  assert.equal(scan.scanId, 'opaque-scan');
  assert.deepEqual(value.calls.list, [73]);
  const checked = await value.handlers.get('rclone:check-version')(value.event, 'C:\\workspace\\evil.exe');
  assert.equal(checked.source, 'bundled');

  await assert.rejects(value.handlers.get('rclone:check-version')({
    sender: { id: 99, mainFrame: {} }, senderFrame: {}
  }), /Untrusted rclone IPC sender/);
  await assert.rejects(value.handlers.get('rclone:list-binaries')({
    sender: value.event.sender, senderFrame: {}
  }), /only available to the main frame/);
});

test('external selection uses a native warning with cancel as the safe default', async (t) => {
  const value = fixture(t);
  let result = await value.handlers.get('rclone:select-binary')(value.event, {
    scanId: 'opaque-scan', candidateId: 'opaque-candidate'
  });
  assert.equal(result.cancelled, true);
  assert.equal(value.calls.dialogs[0].type, 'warning');
  assert.equal(value.calls.dialogs[0].defaultId, 0);
  assert.equal(value.calls.dialogs[0].cancelId, 0);
  assert.match(value.calls.dialogs[0].detail, /C:\\Tools\\rclone\.exe/);

  value.setDialogResponse(1);
  result = await value.handlers.get('rclone:select-binary')(value.event, {
    scanId: 'opaque-scan', candidateId: 'opaque-candidate'
  });
  assert.equal(result.cancelled, false);
});
