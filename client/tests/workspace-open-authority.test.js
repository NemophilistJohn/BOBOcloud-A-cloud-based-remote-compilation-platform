'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceController } = require('../main/workspace');

test('packaged workspace paths require a main-owned recent authorization', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  let recent = [];
  const controller = createWorkspaceController({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    getWindow: () => null,
    settings: {
      readRecentWorkspaces: () => recent.slice(),
      rememberRecentWorkspace: (value) => { recent = [value]; return true; },
      forgetRecentWorkspace: (value) => { recent = recent.filter((item) => item !== value); return true; },
      readProjectNames: () => ({}),
      saveProjectName: () => true
    },
    t: (value) => value,
    assertSafeLocalRoot: (value) => path.resolve(value),
    allowDirectWorkspacePaths: false
  });
  controller.registerIpc();
  t.after(() => controller.clearWatchers());
  await assert.rejects(handlers.get('pick-workspace')({}, root), /native directory picker/);
  recent = [fs.realpathSync(root)];
  const opened = await handlers.get('pick-workspace')({}, root);
  assert.equal(opened.rootPath, fs.realpathSync(root));
  await handlers.get('forget-recent-workspace')({}, root);
  await handlers.get('close-workspace')({});
  await assert.rejects(handlers.get('pick-workspace')({}, root), /native directory picker/);
});
