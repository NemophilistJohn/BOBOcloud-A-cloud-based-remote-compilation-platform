'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSettingsStore } = require('../main/settings-store');
const { BOOTSTRAP_RESOURCE_DESTINATION } = require('../main/server-settings-bootstrap');
const {
  createInternalBuildConfig,
  packageInternalInstaller,
  resolveSettingsPath
} = require('../scripts/package-internal-test');

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-server-bootstrap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeBootstrap(resourcesPath, contents) {
  const target = path.join(resourcesPath, BOOTSTRAP_RESOURCE_DESTINATION);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(contents, null, 2), 'utf8');
  return target;
}

function packagedApp(userDataPath) {
  return {
    isPackaged: true,
    getPath(name) {
      assert.equal(name, 'userData');
      return userDataPath;
    }
  };
}

test('a packaged bootstrap seeds only server connection fields into a fresh user profile', async (t) => {
  const root = makeTempDirectory(t);
  const userDataPath = path.join(root, 'user-data');
  const resourcesPath = path.join(root, 'resources');
  const configured = [];
  writeBootstrap(resourcesPath, {
    ip: 'compiler.example.test',
    user: 'bootstrap-user',
    pass: 'bootstrap-secret',
    secureTransport: true,
    httpPort: 4100,
    wsPort: 4101,
    dapChildWsPort: 4102,
    certificateFingerprint: 'AA:BB',
    certificateFingerprints: ['CC:DD', 'AA:BB'],
    syncInterval: 45000,
    apiKey: 'must-not-be-copied',
    rclonePath: 'must-not-be-copied',
    unrelatedPreference: 'must-not-be-copied'
  });
  const store = createSettingsStore({
    app: packagedApp(userDataPath),
    resourcesPath,
    rclone: { ensureConfig: async (settings) => { configured.push(settings); return { success: true }; } }
  });

  const settings = await store.readServerSettings();
  const persisted = JSON.parse(fs.readFileSync(path.join(userDataPath, 'server-settings.json'), 'utf8'));

  assert.equal(settings.firstRunRequired, false);
  assert.equal(settings.setupCompleted, true);
  assert.equal(persisted.ip, 'compiler.example.test');
  assert.equal(persisted.user, 'bootstrap-user');
  assert.equal(persisted.pass, 'bootstrap-secret');
  assert.equal(persisted.apiKey, '');
  assert.equal(persisted.rclonePath, '');
  assert.deepEqual(persisted.certificateFingerprints, ['AA:BB', 'CC:DD']);
  assert.equal(Object.hasOwn(persisted, 'unrelatedPreference'), false);
  assert.equal(configured.length, 1);
  assert.equal(configured[0].apiKey, '');
  assert.equal(configured[0].rclonePath, '');
});

test('a packaged bootstrap never overwrites an existing user server profile', async (t) => {
  const root = makeTempDirectory(t);
  const userDataPath = path.join(root, 'user-data');
  const resourcesPath = path.join(root, 'resources');
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'server-settings.json'), JSON.stringify({
    ip: 'existing.example.test', user: 'existing-user', pass: 'existing-secret', setupCompleted: true
  }), 'utf8');
  writeBootstrap(resourcesPath, { ip: 'bootstrap.example.test', user: 'bootstrap-user', pass: 'bootstrap-secret' });
  const configured = [];
  const store = createSettingsStore({
    app: packagedApp(userDataPath),
    resourcesPath,
    rclone: { ensureConfig: async (settings) => { configured.push(settings); return { success: true }; } }
  });

  const settings = await store.readServerSettings();
  assert.equal(settings.ip, 'existing.example.test');
  assert.equal(settings.user, 'existing-user');
  assert.equal(configured.length, 1);
  assert.equal(configured[0].ip, 'existing.example.test');
});

test('a normal packaged profile without the internal bootstrap still requires first-run setup', async (t) => {
  const root = makeTempDirectory(t);
  const userDataPath = path.join(root, 'user-data');
  const store = createSettingsStore({
    app: packagedApp(userDataPath),
    resourcesPath: path.join(root, 'resources-without-bootstrap'),
    rclone: { ensureConfig: async () => assert.fail('a blank server profile must not configure rclone') }
  });

  const settings = await store.readServerSettings();
  assert.equal(settings.setupCompleted, false);
  assert.equal(settings.firstRunRequired, true);
  assert.equal(fs.existsSync(path.join(userDataPath, 'server-settings.json')), true);
});

test('the dedicated internal build stages a short-lived bootstrap resource without changing public build settings', async (t) => {
  const root = makeTempDirectory(t);
  const projectDirectory = path.join(root, 'project');
  fs.mkdirSync(projectDirectory, { recursive: true });
  const packageJson = {
    name: 'fixture', version: '1.0.0', build: {
      directories: { output: 'dist' },
      win: { extraResources: [{ from: 'rclone/rclone.exe', to: 'rclone/rclone.exe' }] }
    }
  };
  fs.writeFileSync(path.join(projectDirectory, 'package.json'), JSON.stringify(packageJson), 'utf8');
  const settingsPath = path.join(projectDirectory, 'internal-server.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    ip: 'compiler.example.test', user: 'bootstrap-user', pass: 'bootstrap-secret', apiKey: 'excluded'
  }), 'utf8');

  let received;
  const artifacts = await packageInternalInstaller({
    projectDirectory,
    settingsPath,
    outputDirectory: 'dist/internal-fixture',
    build: async (options) => {
      received = options;
      const resource = options.config.win.extraResources.at(-1);
      assert.equal(resource.to, BOOTSTRAP_RESOURCE_DESTINATION);
      const staged = JSON.parse(fs.readFileSync(resource.from, 'utf8'));
      assert.equal(staged.ip, 'compiler.example.test');
      assert.equal(staged.apiKey, undefined);
      assert.equal(staged.rclonePath, undefined);
      assert.equal(staged.setupCompleted, true);
      return ['fixture-installer.exe'];
    }
  });

  assert.deepEqual(artifacts, ['fixture-installer.exe']);
  assert.equal(received.publish, 'never');
  assert.equal(received.config.directories.output, path.join(projectDirectory, 'dist', 'internal-fixture'));
  assert.deepEqual(packageJson.build.win.extraResources, [{ from: 'rclone/rclone.exe', to: 'rclone/rclone.exe' }]);
  assert.equal(fs.existsSync(received.config.win.extraResources.at(-1).from), false);

  const publicConfig = createInternalBuildConfig({
    win: { extraResources: [{ from: 'rclone/rclone.exe', to: 'rclone/rclone.exe' }] }
  }, 'bootstrap.json', 'dist/test');
  assert.equal(publicConfig.win.extraResources.length, 1);
  assert.equal(publicConfig.win.extraResources[0].to, BOOTSTRAP_RESOURCE_DESTINATION);
  assert.deepEqual(publicConfig.win.extraResources[0], {
    from: 'bootstrap.json', to: BOOTSTRAP_RESOURCE_DESTINATION
  });
});

test('internal client packaging accepts a root-local settings file during the repository transition', (t) => {
  const repositoryDirectory = makeTempDirectory(t);
  const clientDirectory = path.join(repositoryDirectory, 'client');
  const rootSettings = path.join(repositoryDirectory, 'server-settings.json');
  fs.mkdirSync(clientDirectory, { recursive: true });
  fs.writeFileSync(rootSettings, JSON.stringify({ ip: 'compiler.example.test', user: 'bootstrap-user' }), 'utf8');

  assert.equal(resolveSettingsPath(clientDirectory), rootSettings);
});
