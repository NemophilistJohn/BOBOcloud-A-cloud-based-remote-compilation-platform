'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveAsarPath } = require('../scripts/audit-release');

function createAsar(root, unpackedDirectory = 'win-unpacked') {
  const asarPath = path.join(root, 'dist', unpackedDirectory, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, 'fixture');
  return asarPath;
}

test('default release audit uses the Electron Builder dist app.asar', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-release-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const currentAsar = createAsar(root);

  assert.equal(resolveAsarPath(undefined, root, '2.5.2'), currentAsar);
});

test('default release audit never falls back to a stale legacy release directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-release-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staleAsar = path.join(root, 'release', '2.5.1', 'win-unpacked', 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(staleAsar), { recursive: true });
  fs.writeFileSync(staleAsar, 'fixture');

  assert.throws(
    () => resolveAsarPath(undefined, root, '2.5.2'),
    /no app\.asar found at .*dist.*win-unpacked.*app\.asar/
  );
});

test('default release audit ignores non-Windows unpacked artifacts by default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-release-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const currentAsar = createAsar(root, 'win-unpacked');
  createAsar(root, 'linux-unpacked');

  assert.equal(resolveAsarPath(undefined, root, '2.5.2'), currentAsar);
});

test('explicit app.asar path remains supported', () => {
  const explicitPath = path.join('custom-release', 'resources', 'app.asar');
  assert.equal(resolveAsarPath(explicitPath), path.resolve(explicitPath));
});
