'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLocalDirectoryAuthority } = require('../main/local-directory-authority');
const { createRcloneBinaryManager } = require('../main/rclone-binary-manager');
const { createWorkspaceController } = require('../main/workspace');

test('workspace write APIs cannot reach app resources or rclone private storage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-protected-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'app');
  const userData = path.join(root, 'user-data');
  const bundled = path.join(appRoot, 'rclone', 'rclone.exe');
  const safeWorkspace = path.join(root, 'project');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.mkdirSync(userData);
  fs.mkdirSync(safeWorkspace);
  fs.writeFileSync(bundled, 'bundled-rclone');

  const manager = createRcloneBinaryManager({
    app: { isPackaged: false, getPath: () => userData, getAppPath: () => appRoot },
    rclone: {},
    userDataPath: userData,
    bundledPath: bundled,
    appRoot,
    platform: 'win32',
    environment: { Path: '' },
    probeVersion: async () => ({ available: true, version: 'rclone v1' })
  });
  const authority = createLocalDirectoryAuthority({ assertSafeLocalRoot: manager.assertSafeLocalRoot });
  const handlers = new Map();
  const controller = createWorkspaceController({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => handlers.set(channel, handler)
    },
    dialog: {},
    getWindow: () => null,
    settings: { readProjectNames: () => ({}), saveProjectName: () => true },
    t: (value) => value,
    assertSafeLocalRoot: manager.assertSafeLocalRoot,
    localDirectoryAuthority: authority
  });
  controller.registerIpc();
  t.after(() => controller.clearWatchers());

  await assert.rejects(handlers.get('pick-workspace')({ sender: { id: 1 } }, userData), /reserved by BOBOCLOUD/);
  await assert.rejects(handlers.get('pick-workspace')({ sender: { id: 1 } }, appRoot), /reserved by BOBOCLOUD/);
  await assert.rejects(handlers.get('pick-workspace')({ sender: { id: 1 } }, root), /reserved by BOBOCLOUD/);

  await handlers.get('pick-workspace')({ sender: { id: 1 } }, safeWorkspace);
  const textSave = await handlers.get('save-file')({ sender: { id: 1 } }, {
    filePath: path.join(safeWorkspace, 'main.js'),
    content: 'console.log("safe");\n',
    mutationId: 'workspace-save-test-1'
  });
  assert.equal(textSave, true);
  assert.equal(fs.readFileSync(path.join(safeWorkspace, 'main.js'), 'utf8'), 'console.log("safe");\n');
  await handlers.get('save-binary-file')({ sender: { id: 1 } }, {
    filePath: path.join(safeWorkspace, 'asset.bin'),
    content: Buffer.from('safe').toString('base64')
  });
  assert.equal(fs.readFileSync(path.join(safeWorkspace, 'asset.bin'), 'utf8'), 'safe');

  await assert.rejects(handlers.get('write-team-mapping')({ sender: { id: 1 } }, {
    localPath: safeWorkspace,
    localGrant: 'invented',
    mapping: { teamId: 'team', projectId: 'project', branch: 'main', remotePath: '/remote/team' }
  }), /missing or expired/);
  const grant = authority.grant(1, safeWorkspace, 'test');
  await handlers.get('write-team-mapping')({ sender: { id: 1 } }, {
    localPath: safeWorkspace,
    localGrant: grant.grantId,
    mapping: { teamId: 'team', projectId: 'project', branch: 'main', remotePath: '/remote/team' }
  });
  assert.equal(fs.existsSync(path.join(safeWorkspace, '.bobocloud-team.json')), true);
});
