'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createWorkspaceSettingsController,
  loadWorkspaceSettings,
  normalizeWorkspaceSettings,
  safeAssociationPattern
} = require('../main/workspace-settings');

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-workspace-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSettings(root, source) {
  const target = path.join(root, '.vscode', 'settings.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
  return target;
}

test('JSONC settings are reduced to the editor whitelist without reflecting ignored input', async (t) => {
  const root = createWorkspace(t);
  writeSettings(root, `{
    // Only the explicitly supported editor surface is imported.
    "editor.tabSize": 2,
    "editor.insertSpaces": false,
    "editor.wordWrap": "bounded",
    "terminal.integrated.profiles.windows": { "unsafe": "C:/private/tool.exe" },
    "files.associations": {
      "*.component.html": "html",
      "*.templ": "go",
      "../private/*": "python",
      "*.secret": "not-a-language",
    },
    "[javascript][typescript]": {
      "editor.tabSize": 4,
      "editor.insertSpaces": true,
      "editor.formatOnSave": true,
    },
    "[unknown-language]": { "editor.tabSize": 8 },
  }`);

  const snapshot = await loadWorkspaceSettings(root, 7);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.rootPath, path.resolve(root));
  assert.equal(snapshot.workspaceIdentity, 7);
  assert.deepEqual(snapshot.settings.editor, { tabSize: 2, insertSpaces: false, wordWrap: 'bounded' });
  assert.deepEqual(snapshot.settings.languages, {
    javascript: { tabSize: 4, insertSpaces: true },
    typescript: { tabSize: 4, insertSpaces: true }
  });
  assert.deepEqual(snapshot.settings.associations, [
    { pattern: '*.component.html', languageId: 'html' },
    { pattern: '*.templ', languageId: 'go' }
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.settings.editor), true);

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /terminal\.integrated|C:\/private|\.\.\/private|not-a-language|formatOnSave|unknown-language/);
  const warningCodes = new Set(snapshot.warnings.map((warning) => warning.code));
  assert.ok(warningCodes.has('WORKSPACE_SETTING_UNSUPPORTED'));
  assert.ok(warningCodes.has('WORKSPACE_ASSOCIATION_IGNORED'));
  assert.ok(warningCodes.has('WORKSPACE_LANGUAGE_SCOPE_IGNORED'));
});

test('invalid values, unsafe patterns and partial JSONC never become executable settings', async (t) => {
  const normalized = normalizeWorkspaceSettings({
    'editor.tabSize': 0,
    'editor.insertSpaces': 'yes',
    'editor.wordWrap': 'viewport',
    'files.associations': {
      '*.ok': 'python',
      '*.{js,ts}': 'javascript',
      '/absolute/*.go': 'go'
    }
  });
  assert.deepEqual(normalized.settings.editor, {});
  assert.deepEqual(normalized.settings.associations, [{ pattern: '*.ok', languageId: 'python' }]);
  assert.equal(safeAssociationPattern('*.d.ts'), true);
  assert.equal(safeAssociationPattern('../*.js'), false);
  assert.equal(safeAssociationPattern('src/*.js'), false);

  const root = createWorkspace(t);
  writeSettings(root, '{ "editor.tabSize": 2, trailing }');
  const snapshot = await loadWorkspaceSettings(root, 3);
  assert.deepEqual(snapshot.settings, { editor: {}, languages: {}, associations: [] });
  assert.equal(snapshot.warnings[0].code, 'WORKSPACE_SETTINGS_PARSE_FAILED');
});

test('settings.json symlinks are refused instead of resolving through the workspace', async (t) => {
  const root = createWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-outside-settings-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'settings.json'), '{ "editor.tabSize": 9 }', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(root, '.vscode'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory links is not permitted on this host.');
      return;
    }
    throw error;
  }
  const snapshot = await loadWorkspaceSettings(root, 4);
  assert.deepEqual(snapshot.settings.editor, {});
  assert.equal(snapshot.warnings[0].code, 'WORKSPACE_SETTINGS_UNSAFE_PATH');
});

test('IPC reads and change notifications stay bound to the active sender and workspace identity', async (t) => {
  const root = createWorkspace(t);
  const settingsPath = writeSettings(root, '{ "editor.tabSize": 3 }');
  const handlers = new Map();
  const sent = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload })
  };
  const window = { isDestroyed: () => false, webContents };
  let identity = { rootPath: root, workspaceIdentity: 11 };
  const controller = createWorkspaceSettingsController({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWindow: () => window,
    getWorkspaceIdentity: () => identity,
    debounceMs: 0
  });
  controller.registerIpc();
  t.after(() => controller.dispose());

  const read = handlers.get('workspace-settings-read');
  const snapshot = await read({ sender: webContents }, identity);
  assert.equal(snapshot.settings.editor.tabSize, 3);
  await assert.rejects(() => read({ sender: {} }, identity), /sender is not active/);
  await assert.rejects(
    () => read({ sender: webContents }, { rootPath: root, workspaceIdentity: 10 }),
    /Stale workspace settings request/
  );

  fs.writeFileSync(settingsPath, '{ "editor.tabSize": 6 }', 'utf8');
  controller.notifyFilesystemEvent(root, 11, settingsPath);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'workspace-settings-changed');
  assert.equal(sent[0].payload.settings.editor.tabSize, 6);

  identity = { rootPath: root, workspaceIdentity: 12 };
  controller.notifyFilesystemEvent(root, 11, settingsPath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
});
