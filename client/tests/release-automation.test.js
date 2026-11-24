'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { componentChanges, chooseBaseline, changedSince, shouldRelease } = require('../../scripts/auto-release/plan.cjs');
const { expectedAssets, digest } = require('../../scripts/auto-release/publish.cjs');
const { verifyPe } = require('../../scripts/auto-release/verify-pe.cjs');

test('release change detection distinguishes application changes from tests and documentation', () => {
  assert.deepEqual(componentChanges(['client/src/app.ts', 'server/internal/config/config.go']), { client: true, server: true });
  assert.deepEqual(componentChanges(['client/tests/ui.spec.js', 'client/src/example.test.ts', 'server/deploy/test-deploy-server.ps1', 'server/internal/config/config_test.go', 'server/README.md']), { client: false, server: false });
  assert.deepEqual(componentChanges(['client/package-lock.json', 'server/go.mod']), { client: true, server: true });
});

test('automatic publication waits for both components, while emergency force still requires a new commit', () => {
  assert.equal(shouldRelease('head', 'base', { client: true, server: false }, false), false);
  assert.equal(shouldRelease('head', 'base', { client: false, server: true }, false), false);
  assert.equal(shouldRelease('head', 'base', { client: true, server: true }, false), true);
  assert.equal(shouldRelease('head', 'base', { client: true, server: false }, true), true);
  assert.equal(shouldRelease('base', 'base', { client: true, server: true }, true), false);
});

test('release baseline accumulates both components across commits and rejects a forged marker', (t) => {
  const original = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-release-plan-'));
  t.after(() => { process.chdir(original); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  function git(...args) { return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim(); }
  git('init', '--quiet');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  fs.mkdirSync('client'); fs.mkdirSync('server');
  fs.writeFileSync('client/app.js', 'base'); fs.writeFileSync('server/app.go', 'base');
  git('add', '.'); git('commit', '--quiet', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  git('tag', 'auto-v1.0.0-ci.10.1');
  fs.writeFileSync('client/app.js', 'client changed'); git('add', '.'); git('commit', '--quiet', '-m', 'client');
  const clientOnly = git('rev-parse', 'HEAD');
  assert.deepEqual(changedSince(baseline, clientOnly), { client: true, server: false });
  fs.writeFileSync('server/app.go', 'server changed'); git('add', '.'); git('commit', '--quiet', '-m', 'server');
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(changedSince(baseline, head), { client: true, server: true });
  const release = { tag_name: 'auto-v1.0.0-ci.10.1', draft: false, body: '<!-- bobocloud-auto-release:' + baseline + ' -->' };
  assert.equal(chooseBaseline([release], head, null), baseline);
  assert.throws(() => chooseBaseline([{ ...release, body: '<!-- bobocloud-auto-release:' + '0'.repeat(40) + ' -->' }], head, null), /disagree/);
});

test('release asset contract requires every platform, architecture, and server variant', (t) => {
  const names = expectedAssets('2.8.1-ci.123.1');
  assert.equal(names.length, 16);
  assert.equal(new Set(names).size, 16);
  for (const name of ['BOBOCloud-2.8.1-ci.123.1-windows-arm64-setup.exe', 'BOBOCloud-2.8.1-ci.123.1-linux-x64.rpm', 'bobocloud-server-linux-arm64-with-config.tar.gz', 'bobocloud-server-linux-amd64-binary.tar.gz']) assert.ok(names.includes(name), name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-release-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample'); fs.writeFileSync(file, 'abc');
  assert.equal(digest(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('Windows architecture verification rejects incorrectly labelled executables', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-release-pe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'app.exe');
  const bytes = Buffer.alloc(128); bytes.write('MZ', 0, 'ascii'); bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64, 'ascii'); bytes.writeUInt16LE(0xaa64, 68); fs.writeFileSync(file, bytes);
  assert.doesNotThrow(() => verifyPe(file, 'arm64'));
  assert.throws(() => verifyPe(file, 'x64'), /architecture/);
});
