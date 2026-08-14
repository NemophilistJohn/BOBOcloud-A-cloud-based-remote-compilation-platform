const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const rclone = require('../rclone');

test('normalizes a directory named rclone to its executable', () => {
  const directory = path.resolve(__dirname, '..', 'rclone');
  assert.equal(
    rclone.normalizeRequestedPath(directory),
    path.join(directory, 'rclone.exe')
  );
});

test('strips quotes around a configured executable', () => {
  const executable = path.resolve(__dirname, '..', 'rclone', 'rclone.exe');
  assert.equal(rclone.normalizeRequestedPath('"' + executable + '"'), executable);
});

test('falls back from a stale configured path to the bundled development binary', async () => {
  const stalePath = path.join('C:\\', 'missing-bobocloud-rclone', 'rclone.exe');
  const result = await rclone.checkVersion(stalePath);

  assert.equal(result.available, true);
  assert.equal(result.source, 'development');
  assert.match(result.version, /^rclone v/);
  assert.equal(result.attempts[0].source, 'configured');
  assert.equal(result.attempts[0].code, 'ENOENT');
});

test('resolves a configured rclone directory without relying on PATH', () => {
  const directory = path.resolve(__dirname, '..', 'rclone');
  const result = rclone.resolveExecutable(directory);

  assert.equal(result.source, 'configured');
  assert.equal(result.path, path.join(directory, 'rclone.exe'));
});

test('repairs a non-executable bundled Unix binary in user-writable storage', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-mode-'));
  const bundled = path.join(sandbox, 'bundled-rclone');
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalHome = process.env.HOME;
  try {
    fs.writeFileSync(bundled, 'unix binary fixture');
    fs.chmodSync(bundled, 0o644);
    process.env.HOME = path.join(sandbox, 'home');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    delete require.cache[require.resolve('../rclone')];
    const linuxRclone = require('../rclone');
    const repaired = linuxRclone.ensureExecutableCandidate({ path: bundled, source: 'bundled' });

    assert.equal(repaired.source, 'bundled');
    assert.notEqual(repaired.path, bundled);
    assert.equal(fs.readFileSync(repaired.path, 'utf8'), 'unix binary fixture');
    if (originalPlatform.value !== 'win32') assert.notEqual(fs.statSync(repaired.path).mode & 0o111, 0);
    assert.equal(fs.statSync(bundled).mode & 0o111, 0);
  } finally {
    delete require.cache[require.resolve('../rclone')];
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
