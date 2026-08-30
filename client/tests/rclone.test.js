'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const rclone = require('../rclone');

test('checks exactly the managed rclone executable supplied by main', async () => {
  const executable = path.resolve(__dirname, '..', 'rclone', rclone.EXE_NAME);
  const result = await rclone.checkVersion(executable, 'bundled');
  assert.equal(result.available, true);
  assert.equal(result.path, executable);
  assert.equal(result.source, 'bundled');
  assert.match(result.version, /^rclone v/);
});

test('does not search PATH or accept relative executable names', async () => {
  const result = await rclone.checkVersion(rclone.EXE_NAME, 'system');
  assert.equal(result.available, false);
  assert.match(result.error, /managed absolute rclone executable path is required/);
});

test('rejects an arbitrary executable that does not identify itself as rclone', async () => {
  const result = await rclone.checkVersion(process.execPath, 'system');
  assert.equal(result.available, false);
  assert.equal(result.code, 'INVALID_RCLONE');
  assert.match(result.error, /identify itself as rclone/);
});

test('sync fails closed when main does not provide a managed executable', async () => {
  const result = await rclone.sync({ src: 'source', remotePath: 'remote', retries: 0 });
  assert.equal(result.success, false);
  assert.equal(result.error.type, 'EXECUTABLE_UNAVAILABLE');
});

test('rclone config must use an explicit app-managed absolute file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'private', 'rclone.conf');
  assert.equal(rclone.requireManagedConfig(configPath, true), configPath);
  assert.equal(fs.statSync(path.dirname(configPath)).isDirectory(), true);
  assert.throws(() => rclone.requireManagedConfig('rclone.conf', true), /app-managed absolute/);
  assert.throws(() => rclone.requireManagedConfig(configPath, false), /config is missing/);
  fs.writeFileSync(configPath, '[remote]\n');
  assert.equal(rclone.requireManagedConfig(configPath, false), configPath);
});
