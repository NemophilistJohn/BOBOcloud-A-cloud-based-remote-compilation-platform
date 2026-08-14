'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveAsarPath } = require('../scripts/audit-release');

function createAsar(root, version, unpackedDirectory) {
  const asarPath = path.join(root, 'release', version, unpackedDirectory, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, 'fixture');
  return asarPath;
}

test('default release audit discovers only the current version app.asar', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-release-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createAsar(root, '2.5.1', 'win-unpacked');
  const currentAsar = createAsar(root, '2.5.2', 'win-unpacked');

  assert.equal(resolveAsarPath(undefined, root, '2.5.2'), currentAsar);
});

test('default release audit never falls back to an older release', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-release-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createAsar(root, '2.5.1', 'win-unpacked');

  assert.throws(
    () => resolveAsarPath(undefined, root, '2.5.2'),
    /no app\.asar found for release version 2\.5\.2/
  );
});

test('default release audit rejects ambiguous current-version artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-release-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createAsar(root, '2.5.2', 'win-unpacked');
  createAsar(root, '2.5.2', 'linux-unpacked');

  assert.throws(
    () => resolveAsarPath(undefined, root, '2.5.2'),
    /multiple app\.asar files found for release version 2\.5\.2/
  );
});

test('explicit app.asar path remains supported', () => {
  const explicitPath = path.join('custom-release', 'resources', 'app.asar');
  assert.equal(resolveAsarPath(explicitPath), path.resolve(explicitPath));
});
