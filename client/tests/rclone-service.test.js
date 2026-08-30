'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRcloneService } = require('../main/rclone-service');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'rclone', 'rclone.conf');
  const calls = { configure: [], sync: [], pull: [] };
  const serverSettings = { ip: 'compiler.test', user: 'root', pass: 'secret' };
  let revision = 'bundled:1';
  let epoch = 1;
  const binaryManager = {
    paths: { config: configPath },
    async getExecutionDescriptor() {
      return { path: 'C:\\app\\rclone.exe', source: 'bundled', revision, selectionEpoch: epoch };
    },
    isSelectionCurrent(descriptor) { return descriptor.selectionEpoch === epoch; },
    async listCandidates(senderId) { return { scanId: 'scan-' + senderId, candidates: [] }; },
    async getSelection() { return { source: 'bundled' }; },
    async checkActiveVersion() { return { available: true, source: 'bundled', version: 'rclone v1' }; },
    async selectCandidate(_senderId, _payload, confirm) {
      await confirm({ path: 'C:\\system\\rclone.exe' });
      revision = 'external:2';
      epoch += 1;
      return { cancelled: false, selection: { source: 'system' } };
    }
  };
  const rclone = {
    async ensureConfig(settings, executablePath, suppliedConfigPath) {
      calls.configure.push({ settings, executablePath, configPath: suppliedConfigPath });
      fs.mkdirSync(path.dirname(suppliedConfigPath), { recursive: true });
      fs.writeFileSync(suppliedConfigPath, 'configured:' + revision, 'utf8');
      return { success: true };
    },
    async sync(payload) { calls.sync.push(payload); return { success: true }; },
    async pull(payload) { calls.pull.push(payload); return { success: true }; }
  };
  const settings = { async readServerSettings() { return serverSettings; } };
  return {
    calls,
    configPath,
    binaryManager,
    service: createRcloneService({ rclone, binaryManager, settings })
  };
}

test('sync and pull use only the manager executable and app-private config', async (t) => {
  const fixture = createFixture(t);
  await fixture.service.sync({ src: 'src', remotePath: 'remote', rclonePath: 'C:\\workspace\\evil.exe' });
  await fixture.service.pull({ dest: 'dest', remotePath: 'remote', rclonePath: 'C:\\workspace\\evil.exe' });
  assert.equal(fixture.calls.configure.length, 1);
  assert.equal(fixture.calls.configure[0].executablePath, 'C:\\app\\rclone.exe');
  assert.equal(fixture.calls.configure[0].configPath, fixture.configPath);
  assert.equal(fixture.calls.sync[0].executablePath, 'C:\\app\\rclone.exe');
  assert.equal(fixture.calls.sync[0].configPath, fixture.configPath);
  assert.equal(fixture.calls.pull[0].configPath, fixture.configPath);
  assert.equal(Object.hasOwn(fixture.calls.sync[0], 'rclonePath'), false);
  assert.equal(Object.hasOwn(fixture.calls.pull[0], 'rclonePath'), false);
});

test('changing the selected binary invalidates and rebuilds rclone configuration', async (t) => {
  const fixture = createFixture(t);
  await fixture.service.ensureConfigured({ ip: 'compiler.test', user: 'root', pass: 'secret' });
  await fixture.service.selectBinary(1, { scanId: 'scan', candidateId: 'candidate' }, async () => true);
  assert.equal(fixture.calls.configure.length, 2);
});

test('deleting the app-private config invalidates the memoized configuration', async (t) => {
  const fixture = createFixture(t);
  await fixture.service.ensureConfigured({ ip: 'compiler.test', user: 'root', pass: 'secret' });
  fs.unlinkSync(fixture.configPath);
  await fixture.service.ensureConfigured({ ip: 'compiler.test', user: 'root', pass: 'secret' });
  assert.equal(fixture.calls.configure.length, 2);
  assert.equal(fs.existsSync(fixture.configPath), true);
});

test('a selection change during configuration never starts sync with the stale binary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'rclone.conf');
  const firstConfigureStarted = deferred();
  const releaseFirstConfigure = deferred();
  const configuredExecutables = [];
  const syncedExecutables = [];
  let epoch = 1;
  const binaryManager = {
    paths: { config: configPath },
    async getExecutionDescriptor() {
      return { path: 'C:\\managed\\rclone-' + epoch + '.exe', revision: 'revision-' + epoch, selectionEpoch: epoch };
    },
    isSelectionCurrent(value) { return value.selectionEpoch === epoch; },
    async selectCandidate() {
      epoch = 2;
      return { cancelled: false, selection: { source: 'system' } };
    },
    async listCandidates() { return { candidates: [] }; },
    async getSelection() { return { source: 'system' }; },
    async checkActiveVersion() { return { available: true }; }
  };
  const rclone = {
    async ensureConfig(_settings, executablePath, suppliedConfigPath) {
      configuredExecutables.push(executablePath);
      if (configuredExecutables.length === 1) {
        firstConfigureStarted.resolve();
        await releaseFirstConfigure.promise;
      }
      fs.writeFileSync(suppliedConfigPath, executablePath, 'utf8');
      return { success: true };
    },
    async sync(payload) {
      syncedExecutables.push(payload.executablePath);
      return { success: true };
    },
    async pull() { return { success: true }; }
  };
  const settings = { async readServerSettings() { return { ip: 'compiler.test', user: 'root', pass: 'secret' }; } };
  const service = createRcloneService({ rclone, binaryManager, settings });
  const syncing = service.sync({ src: 'project', remotePath: '/remote' });
  await firstConfigureStarted.promise;
  const selecting = service.selectBinary(1, { scanId: 'scan', candidateId: 'next' }, async () => true);
  releaseFirstConfigure.resolve();
  await Promise.all([syncing, selecting]);

  assert.deepEqual(syncedExecutables, ['C:\\managed\\rclone-2.exe']);
  assert.equal(configuredExecutables[0], 'C:\\managed\\rclone-1.exe');
  assert.equal(configuredExecutables.slice(1).every((value) => value === 'C:\\managed\\rclone-2.exe'), true);
});
