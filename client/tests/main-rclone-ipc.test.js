'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLocalDirectoryAuthority } = require('../main/local-directory-authority');
const { directoryIsEmptyExceptMarker, registerRcloneIpc, workspaceProjectKey } = require('../main/rclone-ipc');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  const handlers = new Map();
  const calls = { prepare: [], sync: [], pull: [], cancel: [], cancelAll: [], validate: [], measure: [], list: [], select: [], dialogs: [], progress: [] };
  const mainFrame = {};
  const webContents = { id: 73, mainFrame, send: (...args) => calls.progress.push(args) };
  const owner = { webContents, isDestroyed: () => false };
  const workspaceIdentity = { rootPath: workspaceRoot, workspaceIdentity: 4 };
  const authority = createLocalDirectoryAuthority({ assertSafeLocalRoot: (candidate) => path.resolve(candidate) });
  let dialogResponse = 0;
  let openDialogResult = { canceled: true, filePaths: [] };
  let measure = async () => ({ size: 777 });
  const service = {
    async prepareRemote(payload) {
      calls.prepare.push(payload);
      if (typeof payload.measure === 'function') await payload.measure(new AbortController().signal);
      return { success: true, remoteGrantId: 'remote-grant-' + calls.prepare.length };
    },
    async sync(payload) { calls.sync.push(payload); return { success: true }; },
    async pull(payload) { calls.pull.push(payload); return { success: true }; },
    async cancelOperation(senderId, operationId) { calls.cancel.push({ senderId, operationId }); return { cancelled: 1 }; },
    async cancelSender(senderId, reason) { calls.cancelAll.push({ senderId, reason }); return { cancelled: 1 }; },
    async listBinaries(senderId) { calls.list.push(senderId); return { scanId: 'opaque-scan', candidates: [] }; },
    async getSelection() { return { source: 'bundled' }; },
    async checkVersion() { return { available: true, source: 'bundled' }; },
    async validateConnection(senderId) { calls.validate.push(senderId); return { success: true }; },
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
    measureDirectory: async (directory, options) => {
      calls.measure.push(directory);
      return measure(directory, options);
    },
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
    setOpenDialogResult(value) { openDialogResult = value; },
    setMeasure(value) { measure = value; }
  };
}

function workspaceScope(value) {
  return {
    type: 'workspace',
    rootPath: value.workspaceIdentity.rootPath,
    workspaceIdentity: value.workspaceIdentity.workspaceIdentity
  };
}

test('mapping emptiness ignores only the marker and stops on the first project entry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.bobocloud-team.json'), '{}');
  assert.equal(await directoryIsEmptyExceptMarker(root), true);
  fs.writeFileSync(path.join(root, 'project.txt'), 'content');
  assert.equal(await directoryIsEmptyExceptMarker(root), false);
});

test('rclone IPC rejects renderer executable/local paths and resolves the active workspace in main', async (t) => {
  const value = fixture(t);
  await assert.rejects(value.handlers.get('rclone:sync')(value.event, {
    operationId: 'evil', src: 'C:\\private', remotePath: '/remote'
  }), /paths and exclusion policy are not accepted/);
  assert.equal(value.calls.sync.length, 0);

  await assert.rejects(value.handlers.get('rclone:sync')(value.event, {
    operationId: 'evil-remote', localScope: workspaceScope(value), remotePath: '/remote/workspace'
  }), /paths and exclusion policy are not accepted/);
  await assert.rejects(value.handlers.get('rclone:sync')(value.event, {
    operationId: 'evil-excludes', localScope: workspaceScope(value), excludes: []
  }), /paths and exclusion policy are not accepted/);

  const prepared = await value.handlers.get('rclone:prepare-remote')(value.event, {
    operationId: 'prepare-sync',
    kind: 'workspace',
    localScope: workspaceScope(value),
    request: { folderName: 'workspace', folderKey: 'p123', totalSize: 12 }
  });
  await value.handlers.get('rclone:sync')(value.event, {
    operationId: 'sync', localScope: workspaceScope(value), remoteGrantId: prepared.remoteGrantId
  });
  assert.equal(value.calls.prepare[0].senderId, 73);
  assert.equal(value.calls.prepare[0].kind, 'workspace');
  assert.equal(value.calls.prepare[0].request.folderName, 'workspace');
  assert.equal(value.calls.prepare[0].request.folderKey, workspaceProjectKey(value.workspaceIdentity.rootPath));
  assert.equal(value.calls.prepare[0].request.totalSize, undefined, 'renderer-supplied quota size must be discarded before service measurement');
  assert.deepEqual(value.calls.measure, [fs.realpathSync(value.workspaceIdentity.rootPath)]);
  assert.equal(value.calls.prepare[0].request.teamId, undefined, 'renderer cannot turn a personal workspace into an arbitrary team target');
  assert.equal(value.calls.sync[0].localPath, fs.realpathSync(value.workspaceIdentity.rootPath));
  assert.equal(value.calls.sync[0].remoteGrantId, 'remote-grant-1');
  value.calls.sync[0].onProgress('copying');
  assert.deepEqual(value.calls.progress[0], ['rclone:progress', { operationId: 'sync', line: 'copying' }]);

  await assert.rejects(value.handlers.get('rclone:pull')(value.event, {
    operationId: 'pull-stale-workspace',
    localScope: { type: 'workspace', rootPath: value.workspaceIdentity.rootPath, workspaceIdentity: 3 },
    remoteGrantId: 'remote-grant'
  }), /scope is stale/);
});

test('team pulls require an opaque grant created by the native directory picker', async (t) => {
  const value = fixture(t);
  const mapping = path.join(path.dirname(value.workspaceIdentity.rootPath), 'mapping');
  fs.mkdirSync(mapping);
  value.setOpenDialogResult({ canceled: false, filePaths: [mapping] });
  const picked = await value.handlers.get('pick-local-mapping')(value.event);
  assert.equal(picked.path, fs.realpathSync(mapping));
  assert.ok(picked.grantId);

  const prepared = await value.handlers.get('rclone:prepare-remote')(value.event, {
    operationId: 'prepare-team',
    kind: 'team-pull',
    localScope: { type: 'mapping', grantId: picked.grantId },
    request: { teamId: 'team-1', projectId: 'project-1', branch: 'main', reset: true }
  });
  await value.handlers.get('rclone:pull')(value.event, {
    operationId: 'pull-team',
    localScope: { type: 'mapping', grantId: picked.grantId },
    remoteGrantId: prepared.remoteGrantId
  });
  assert.equal(value.calls.pull[0].localPath, fs.realpathSync(mapping));
  await assert.rejects(value.handlers.get('rclone:pull')(value.event, {
    operationId: 'pull-invented',
    localScope: { type: 'mapping', grantId: 'invented' },
    remoteGrantId: prepared.remoteGrantId
  }), /missing or expired/);
});

test('renderer cancellation is sender-scoped and awaited through IPC', async (t) => {
  const value = fixture(t);
  await value.handlers.get('rclone:cancel')(value.event, { operationId: 'sync-1' });
  await value.handlers.get('rclone:cancel-all')(value.event, { reason: 'workspace-change' });
  assert.deepEqual(value.calls.cancel, [{ senderId: 73, operationId: 'sync-1' }]);
  assert.deepEqual(value.calls.cancelAll, [{ senderId: 73, reason: 'workspace-change' }]);
});

test('workspace preparation delegates cancellable measurement through the service operation', async (t) => {
  const value = fixture(t);
  let receivedSignal = null;
  value.setMeasure((_directory, options) => {
    receivedSignal = options && options.signal;
    return Promise.resolve({ size: 99 });
  });
  await value.handlers.get('rclone:prepare-remote')(value.event, {
    operationId: 'prepare-one', kind: 'workspace', localScope: workspaceScope(value), request: {}
  });
  assert.equal(value.calls.measure.length, 1);
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(value.calls.prepare.at(-1).request.totalSize, undefined);
});

test('version checks and candidate scans are bound to the active main frame', async (t) => {
  const value = fixture(t);
  const scan = await value.handlers.get('rclone:list-binaries')(value.event);
  assert.equal(scan.scanId, 'opaque-scan');
  assert.deepEqual(value.calls.list, [73]);
  const checked = await value.handlers.get('rclone:check-version')(value.event, 'C:\\workspace\\evil.exe');
  assert.equal(checked.source, 'bundled');
  assert.deepEqual(await value.handlers.get('rclone:validate-connection')(value.event), { success: true });
  assert.deepEqual(value.calls.validate, [73]);

  await assert.rejects(value.handlers.get('rclone:check-version')({
    sender: { id: 99, mainFrame: {} }, senderFrame: {}
  }), /Untrusted rclone IPC sender/);
  await assert.rejects(value.handlers.get('rclone:list-binaries')({
    sender: value.event.sender, senderFrame: {}
  }), /only available to the main frame/);
});

test('oversized team markers are ignored before parsing or remote preparation', async (t) => {
  const value = fixture(t);
  fs.writeFileSync(path.join(value.workspaceIdentity.rootPath, '.bobocloud-team.json'), ' '.repeat(32 * 1024 + 1));
  await value.handlers.get('rclone:prepare-remote')(value.event, {
    operationId: 'prepare-oversized-marker',
    kind: 'workspace',
    localScope: workspaceScope(value),
    request: {}
  });
  assert.equal(value.calls.prepare[0].request.teamId, undefined);
  assert.equal(value.calls.prepare[0].request.folderKey, workspaceProjectKey(value.workspaceIdentity.rootPath));
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
