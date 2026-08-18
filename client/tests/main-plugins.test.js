'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPluginController, readZipEntries } = require('../main/plugins');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeManifest(version, source, options = {}) {
  return {
    schemaVersion: 1,
    id: options.id || 'acme.sample-plugin',
    displayName: 'Sample Plugin',
    description: 'A constrained test plugin.',
    version,
    engines: { pluginApi: '^1.0.0', bobocloud: '>=2.6.0 <3.0.0' },
    main: 'dist/extension.js',
    activationEvents: ['onStartupFinished'],
    permissions: options.permissions || ['commands.register', 'services.read'],
    contributes: { commands: [{ command: 'acme.sample-plugin.hello', title: 'Hello' }] },
    integrity: {
      algorithm: 'sha256',
      files: { 'dist/extension.js': hash(source) }
    }
  };
}

async function writePackage(root, version = '1.0.0', source = 'export function activate() {}\n') {
  await fsp.mkdir(path.join(root, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(root, 'dist', 'extension.js'), source, 'utf8');
  await fsp.writeFile(path.join(root, 'manifest.json'), JSON.stringify(makeManifest(version, source), null, 2), 'utf8');
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '', 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + content.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

async function createHarness(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-plugins-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  await fsp.mkdir(workspaceRoot);
  const workspaceState = { rootPath: workspaceRoot, workspaceIdentity: 1 };
  const handlers = new Map();
  const events = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload })
    }
  };
  const controller = createPluginController({
    app: { getPath: () => root, getVersion: () => '2.6.0' },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: options.dialog || { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '' },
    getWindow: () => window,
    getWorkspaceIdentity: () => ({ ...workspaceState })
  });
  controller.registerIpc();
  await controller.initialize();
  return { root, workspaceRoot, workspaceState, controller, handlers, events };
}

test('plugin packages install atomically, remain disabled, and receive declared permissions by default', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'source');
  await writePackage(source);

  const installed = await harness.controller.installFromPath(source);
  assert.equal(installed.id, 'acme.sample-plugin');
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(installed.status, 'disabled');
  assert.equal(installed.enabled, false);
  assert.deepEqual(installed.grantedPermissions, ['commands.register', 'services.read']);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);
  await assert.rejects(() => harness.controller.loadEntry(installed.id), { code: 'plugins.entry.denied' });
  await assert.rejects(
    () => harness.controller.rpc(installed.id, 'commands.register', { id: 'acme.sample-plugin.hello' }),
    { code: 'plugins.rpc.plugin' }
  );

  const enabled = await harness.controller.setEnabled(installed.id, true);
  assert.equal(enabled.status, 'enabled');
  assert.deepEqual(enabled.grantedPermissions, ['commands.register', 'services.read']);
  const descriptors = harness.controller.runtimeDescriptors();
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].manifest.main, 'dist/extension.js');
  assert.equal(JSON.stringify(descriptors).includes(harness.root), false, 'descriptors must not leak plugin paths');
  const entry = await harness.controller.loadEntry(installed.id);
  assert.match(entry.source, /activate/);
  assert.equal(entry.main, 'dist/extension.js');
  assert.deepEqual(
    await harness.controller.rpc(installed.id, 'commands.register', { id: 'acme.sample-plugin.hello' }),
    { authorized: true, method: 'commands.register', permission: 'commands.register' }
  );
  assert.deepEqual(
    await harness.controller.rpc(installed.id, 'services.get', { id: 'workbench.projectTasks' }),
    { authorized: true, method: 'services.get', permission: 'services.read' }
  );
  await harness.controller.grant(installed.id, 'services.read', false);
  await assert.rejects(
    () => harness.controller.rpc(installed.id, 'services.get', { id: 'workbench.projectTasks' }),
    { code: 'plugins.rpc.permission' }
  );
  await harness.controller.grant(installed.id, 'services.read', true);
  await assert.rejects(
    () => harness.controller.rpc(installed.id, 'services.get', { id: 'workbench.fileIcons' }),
    { code: 'plugins.rpc.service' }
  );
  assert.ok(harness.events.some((event) => event.channel === 'plugins:changed'));
});

test('legacy permission state migrates installed plugins to declared default grants once', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'legacy-permission-package');
  await writePackage(source);
  await harness.controller.installFromPath(source);
  const permissionsPath = path.join(harness.root, 'plugins', '.permissions.json');
  await fsp.writeFile(permissionsPath, JSON.stringify({
    schemaVersion: 1,
    grants: { 'acme.sample-plugin': [] }
  }, null, 2) + '\n', 'utf8');

  const upgraded = createPluginController({
    app: { getPath: () => harness.root, getVersion: () => '2.6.0' },
    ipcMain: { handle() {} },
    getWindow: () => null,
    getWorkspaceIdentity: () => ({ rootPath: harness.workspaceRoot, workspaceIdentity: 1 })
  });
  await upgraded.initialize();

  assert.deepEqual(upgraded.get('acme.sample-plugin').grantedPermissions, [
    'commands.register',
    'services.read'
  ]);
  const persisted = JSON.parse(await fsp.readFile(permissionsPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.initialized['acme.sample-plugin'], true);
});

test('plugin-localization loader returns only a verified selected flat message table', async (t) => {
  const harness = await createHarness(t);
  const sourceRoot = path.join(harness.root, 'localized-package');
  const entry = 'export function activate() {}\n';
  const english = JSON.stringify({ 'Workspace records': 'Workspace records' });
  const japanese = JSON.stringify({ 'Workspace records': 'Workspace records ja' });
  await fsp.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
  await fsp.mkdir(path.join(sourceRoot, 'language-packs', 'en'), { recursive: true });
  await fsp.mkdir(path.join(sourceRoot, 'language-packs', 'ja'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'dist', 'extension.js'), entry, 'utf8');
  await fsp.writeFile(path.join(sourceRoot, 'language-packs', 'en', 'messages.json'), english, 'utf8');
  await fsp.writeFile(path.join(sourceRoot, 'language-packs', 'ja', 'messages.json'), japanese, 'utf8');
  const manifest = makeManifest('1.0.0', entry, { permissions: [] });
  manifest.localization = {
    default: 'language-packs/en/messages.json',
    ja: 'language-packs/ja/messages.json'
  };
  manifest.integrity.files = {
    'dist/extension.js': hash(entry),
    'language-packs/en/messages.json': hash(english),
    'language-packs/ja/messages.json': hash(japanese)
  };
  await fsp.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  await harness.controller.installFromPath(sourceRoot);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const loaded = await harness.controller.loadLocalization('acme.sample-plugin', 'ja');
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), { locale: 'ja', messages: { 'Workspace records': 'Workspace records ja' } });
  assert.equal(JSON.stringify(loaded).includes(harness.root), false, 'localization payload must not leak package paths');
  const fallback = await harness.controller.loadLocalization('acme.sample-plugin', 'zh-CN');
  assert.deepEqual(JSON.parse(JSON.stringify(fallback)), { locale: 'zh-CN', messages: { 'Workspace records': 'Workspace records' } });

  const nestedRoot = path.join(harness.root, 'nested-localization-package');
  const nestedEntry = 'export function activate() {}\n';
  const nestedMessages = JSON.stringify({ invalid: { nested: true } });
  await fsp.mkdir(path.join(nestedRoot, 'dist'), { recursive: true });
  await fsp.mkdir(path.join(nestedRoot, 'language-packs', 'en'), { recursive: true });
  await fsp.writeFile(path.join(nestedRoot, 'dist', 'extension.js'), nestedEntry, 'utf8');
  await fsp.writeFile(path.join(nestedRoot, 'language-packs', 'en', 'messages.json'), nestedMessages, 'utf8');
  const nestedManifest = makeManifest('1.0.0', nestedEntry, { id: 'acme.nested-localization', permissions: [] });
  nestedManifest.localization = { default: 'language-packs/en/messages.json' };
  nestedManifest.integrity.files = {
    'dist/extension.js': hash(nestedEntry),
    'language-packs/en/messages.json': hash(nestedMessages)
  };
  await fsp.writeFile(path.join(nestedRoot, 'manifest.json'), JSON.stringify(nestedManifest, null, 2), 'utf8');
  await harness.controller.installFromPath(nestedRoot);
  await harness.controller.setEnabled('acme.nested-localization', true);
  await assert.rejects(
    () => harness.controller.loadLocalization('acme.nested-localization', 'en'),
    { code: 'plugins.localization.invalid' }
  );

  const installedJapanese = path.join(harness.root, 'plugins', 'acme.sample-plugin', 'language-packs', 'ja', 'messages.json');
  await fsp.writeFile(installedJapanese, JSON.stringify({ nested: { notAllowed: true } }), 'utf8');
  await assert.rejects(
    () => harness.controller.loadLocalization('acme.sample-plugin', 'ja'),
    { code: 'plugins.integrity.mismatch' }
  );
  assert.equal(harness.controller.get('acme.sample-plugin').status, 'invalid');
});

test('a replacement package is disabled and receives its declared permissions', async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'first');
  const second = path.join(harness.root, 'second');
  await writePackage(first, '1.0.0');
  await writePackage(second, '1.1.0', 'export const version = 2;\n');
  await harness.controller.installFromPath(first);
  await harness.controller.grant('acme.sample-plugin', 'commands.register', true);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const replacement = await harness.controller.installFromPath(second);
  assert.equal(replacement.version, '1.1.0');
  assert.equal(replacement.enabled, false);
  assert.deepEqual(replacement.grantedPermissions, ['commands.register', 'services.read']);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);
});

test('plugin mutations serialize concurrent replacement requests', async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'first');
  const second = path.join(harness.root, 'second');
  await writePackage(first, '1.0.0');
  await writePackage(second, '1.2.0', 'export const version = 12;\n');
  const [firstResult, secondResult] = await Promise.all([
    harness.controller.installFromPath(first),
    harness.controller.installFromPath(second)
  ]);
  assert.equal(firstResult.version, '1.0.0');
  assert.equal(secondResult.version, '1.2.0');
  assert.equal(harness.controller.get('acme.sample-plugin').version, '1.2.0');
  assert.equal(harness.controller.get('acme.sample-plugin').enabled, false);
});

test('refresh detects post-install tampering and suppresses runtime descriptors', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'source');
  await writePackage(source);
  await harness.controller.installFromPath(source);
  await harness.controller.grant('acme.sample-plugin', 'commands.register', true);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const installedSource = path.join(harness.root, 'plugins', 'acme.sample-plugin', 'dist', 'extension.js');
  await fsp.writeFile(installedSource, 'export const tampered = true;\n', 'utf8');
  const refreshed = await harness.controller.refresh('test-tamper');
  assert.equal(refreshed[0].status, 'invalid');
  assert.equal(refreshed[0].enabled, false);
  assert.equal(refreshed[0].integrity.valid, false);
  assert.deepEqual(refreshed[0].grantedPermissions, []);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);
});

test('ZIP packages install without exposing paths and traversal entries are rejected', async (t) => {
  const harness = await createHarness(t);
  const source = 'export default {};\n';
  const manifest = JSON.stringify(makeManifest('1.0.0', source), null, 2);
  const archive = path.join(harness.root, 'sample.boboplugin');
  await fsp.writeFile(archive, makeZip([
    { name: 'manifest.json', content: manifest },
    { name: 'dist/extension.js', content: source }
  ]));
  const installed = await harness.controller.installFromPath(archive);
  assert.equal(installed.status, 'disabled');
  assert.deepEqual(harness.controller.list().map((record) => record.id), ['acme.sample-plugin']);

  const malicious = makeZip([{ name: '../outside.js', content: 'bad' }]);
  assert.throws(() => readZipEntries(malicious), { code: 'plugins.package.path' });
});

test('validation rejects mutable code graphs and native package files before installation', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'multiple-scripts');
  const entry = 'export const entry = true;\n';
  const helper = 'export const helper = true;\n';
  await fsp.mkdir(path.join(source, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(source, 'dist', 'extension.js'), entry, 'utf8');
  await fsp.writeFile(path.join(source, 'dist', 'helper.js'), helper, 'utf8');
  const manifest = makeManifest('1.0.0', entry);
  manifest.integrity.files['dist/helper.js'] = hash(helper);
  await fsp.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await assert.rejects(() => harness.controller.installFromPath(source), { code: 'plugins.manifest.main' });
  assert.deepEqual(harness.controller.list(), []);

  const nativeSource = path.join(harness.root, 'native-file');
  await writePackage(nativeSource);
  await fsp.writeFile(path.join(nativeSource, 'addon.node'), 'native', 'utf8');
  await assert.rejects(() => harness.controller.installFromPath(nativeSource), { code: 'plugins.package.fileType' });
  assert.deepEqual(harness.controller.list(), []);
});

test('plugin IPC surface is explicit and sender-bound', async (t) => {
  const harness = await createHarness(t);
  const expected = [
    'plugins:list', 'plugins:get', 'plugins:install', 'plugins:enable', 'plugins:disable', 'plugins:uninstall',
    'plugins:grant', 'plugins:revoke', 'plugins:runtime-descriptors', 'plugins:load-entry', 'plugins:load-localization', 'plugins:rpc',
    'plugins:open-folder', 'plugins:refresh'
  ];
  assert.deepEqual(Array.from(harness.handlers.keys()), expected);
  const foreignEvent = { sender: {} };
  await assert.rejects(() => harness.handlers.get('plugins:list')(foreignEvent), { code: 'plugins.ipc.sender' });
});

test('plugin install dialog only imports packages and keeps a plugin-specific directory', async (t) => {
  const calls = [];
  let selectedPath = '';
  const dialog = {
    showOpenDialog: async (_owner, options) => {
      calls.push(options);
      if (calls.length === 1) return { canceled: false, filePaths: [selectedPath] };
      if (calls.length === 2) return { canceled: true, filePaths: [] };
      return { canceled: false, filePaths: [path.dirname(selectedPath)] };
    }
  };
  const harness = await createHarness(t, { dialog });
  const source = 'export default {}\n';
  const packageDirectory = path.join(harness.root, 'downloaded-plugin');
  await fsp.mkdir(packageDirectory, { recursive: true });
  selectedPath = path.join(packageDirectory, 'sample.boboplugin');
  await fsp.writeFile(selectedPath, makeZip([
    { name: 'manifest.json', content: JSON.stringify(makeManifest('1.0.0', source), null, 2) },
    { name: 'dist/extension.js', content: source }
  ]));

  const installed = await harness.controller.installFromDialog();
  assert.equal(installed.id, 'acme.sample-plugin');
  assert.deepEqual(calls[0].properties, ['openFile']);
  assert.equal(calls[0].title, 'Plugin package');
  assert.deepEqual(calls[0].filters, [{ name: 'Plugin package', extensions: ['boboplugin'] }]);
  assert.equal(calls[0].defaultPath, path.join(harness.root, 'plugins', '.imports'));
  assert.notEqual(calls[0].defaultPath, harness.workspaceRoot, 'plugin import must not inherit the workspace picker path');
  const persisted = JSON.parse(await fsp.readFile(path.join(harness.root, 'plugins', '.install-dialog.json'), 'utf8'));
  assert.equal(persisted.lastDirectory, packageDirectory);

  assert.equal(await harness.controller.installFromDialog(), null);
  assert.equal(calls[1].defaultPath, packageDirectory, 'next plugin import should restore the plugin-specific location');
  await assert.rejects(() => harness.controller.installFromDialog(), { code: 'plugins.install.type' });
});

test('marketplace identity expectations fail before replacing an installed package', async (t) => {
  const harness = await createHarness(t);
  const existing = path.join(harness.root, 'existing');
  await writePackage(existing, '1.0.0');
  await harness.controller.installFromPath(existing);
  await harness.controller.grant('acme.sample-plugin', 'commands.register', true);
  await harness.controller.setEnabled('acme.sample-plugin', true);

  const replacementSource = 'export const marketplace = true;\n';
  const mismatchedArchive = path.join(harness.root, 'mismatched.boboplugin');
  await fsp.writeFile(mismatchedArchive, makeZip([
    { name: 'manifest.json', content: JSON.stringify(makeManifest('1.1.0', replacementSource, { id: 'acme.other-plugin' }), null, 2) },
    { name: 'dist/extension.js', content: replacementSource }
  ]));
  await assert.rejects(
    () => harness.controller.installArchiveFromPath(mismatchedArchive, { id: 'acme.sample-plugin', version: '1.1.0' }),
    { code: 'plugins.install.identity' }
  );
  const retained = harness.controller.get('acme.sample-plugin');
  assert.equal(retained.version, '1.0.0');
  assert.equal(retained.status, 'enabled');
  assert.deepEqual(retained.grantedPermissions, ['commands.register', 'services.read']);
  assert.equal(harness.controller.get('acme.other-plugin'), null);
});

test('serialized marketplace installs cannot overwrite a newer concurrent local import', async (t) => {
  const harness = await createHarness(t);
  const localNewer = path.join(harness.root, 'local-newer');
  await writePackage(localNewer, '2.0.0', 'export const local = 2;\n');
  const marketplaceSource = 'export const marketplace = 1;\n';
  const marketplaceArchive = path.join(harness.root, 'marketplace-v1.boboplugin');
  await fsp.writeFile(marketplaceArchive, makeZip([
    { name: 'manifest.json', content: JSON.stringify(makeManifest('1.0.0', marketplaceSource), null, 2) },
    { name: 'dist/extension.js', content: marketplaceSource }
  ]));

  // This mirrors a v1 marketplace download completing after the user started
  // a local v2 import. The second request must observe v2 inside the queue.
  const localInstall = harness.controller.installFromPath(localNewer);
  const staleMarketplaceInstall = harness.controller.installArchiveFromPath(marketplaceArchive, {
    id: 'acme.sample-plugin',
    version: '1.0.0',
    expectedMinimumVersion: '1.0.0'
  });
  await localInstall;
  await assert.rejects(staleMarketplaceInstall, { code: 'plugins.install.downgrade' });
  const retained = harness.controller.get('acme.sample-plugin');
  assert.equal(retained.version, '2.0.0');
  assert.equal(retained.status, 'disabled');
  assert.deepEqual(retained.grantedPermissions, ['commands.register', 'services.read']);
});

test('SCM and static source-control permissions remain main-process authorized', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'scm-package');
  await writePackage(source);
  const manifestPath = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  manifest.permissions = ['scm.git.read', 'scm.git.write', 'sourceControl.register', 'fileDecorations.scm'];
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  await harness.controller.installFromPath(source);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  assert.deepEqual(
    await harness.controller.rpc('acme.sample-plugin', 'scm.git.detect', { includeNested: false }),
    { repositories: [] }
  );
  assert.deepEqual(
    await harness.controller.rpc('acme.sample-plugin', 'sourceControl.register', {
      id: 'acme.sample-plugin.source-control',
      title: 'Source Control',
      icon: 'git-branch',
      order: 10,
      openCommand: 'acme.sample-plugin.openSourceControl'
    }),
    { authorized: true, method: 'sourceControl.register', permission: 'sourceControl.register' }
  );
  assert.deepEqual(
    await harness.controller.rpc('acme.sample-plugin', 'fileDecorations.scm.register', {
      id: 'acme.sample-plugin.decorations',
      priority: 25
    }),
    { authorized: true, method: 'fileDecorations.scm.register', permission: 'fileDecorations.scm' }
  );
  await assert.rejects(
    () => harness.controller.rpc('acme.sample-plugin', 'fileDecorations.scm.set', {}),
    { code: 'plugins.rpc.denied' }
  );
});
