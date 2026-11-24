'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { componentChanges, chooseBaseline, changedSince, shouldRelease } = require('../../scripts/auto-release/plan.cjs');
const { expectedAssets, digest, main: publish } = require('../../scripts/auto-release/publish.cjs');
const { verifyPe } = require('../../scripts/auto-release/verify-pe.cjs');
const { satisfiesVersionRange } = require('../shared/plugin-semver');

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

test('the packaged numeric host version remains compatible with official plugin engine ranges', () => {
  const version = require('../package.json').version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(satisfiesVersionRange(version, '>=2.6.0 <3.0.0'), true);
  assert.equal(satisfiesVersionRange(version + '-ci.123.1', '>=2.6.0 <3.0.0'), false);
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

test('draft assets and commit are verified before creating a tag and publishing', (t) => {
  const original = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-release-draft-'));
  const keys = ['RELEASE_HEAD', 'RELEASE_BASELINE', 'RELEASE_VERSION', 'RELEASE_APP_VERSION', 'RELEASE_TAG', 'GITHUB_REPOSITORY', 'RUNNER_TEMP'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    process.chdir(original);
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root); fs.mkdirSync('release-assets');
  const head = 'a'.repeat(40); const baseline = 'b'.repeat(40);
  const version = '2.8.1-ci.123.1'; const tag = 'auto-v' + version;
  Object.assign(process.env, { RELEASE_HEAD: head, RELEASE_BASELINE: baseline, RELEASE_VERSION: version, RELEASE_APP_VERSION: '2.8.1', RELEASE_TAG: tag, GITHUB_REPOSITORY: 'owner/repo', RUNNER_TEMP: root });
  for (const name of expectedAssets(version)) fs.writeFileSync(path.join('release-assets', name), name);
  const events = []; let draft = true;
  const fakeGh = (...args) => {
    if (args[0] === 'release' && args[1] === 'create') { events.push('draft'); return ''; }
    if (args[0] === 'release' && args[1] === 'view' && draft) {
      events.push('verify-draft');
      const assets = fs.readdirSync('release-assets').map((name) => ({ name, size: fs.statSync(path.join('release-assets', name)).size, digest: 'sha256:' + digest(path.join('release-assets', name)) }));
      return JSON.stringify({ isDraft: true, tagName: tag, targetCommitish: head, assets });
    }
    if (args[0] === 'api' && args[1] === '--method') { events.push('create-tag'); return '{}'; }
    if (args[0] === 'api') { events.push('verify-tag'); return JSON.stringify({ object: { type: 'commit', sha: head } }); }
    if (args[0] === 'release' && args[1] === 'edit') { events.push('publish'); draft = false; return ''; }
    if (args[0] === 'release' && args[1] === 'view') { events.push('verify-published'); return JSON.stringify({ isDraft: false, tagName: tag }); }
    throw new Error('Unexpected GitHub call');
  };
  publish({ gh: fakeGh, log: () => '- Test', check: () => events.push('check') });
  assert.deepEqual(events, ['check', 'draft', 'verify-draft', 'check', 'create-tag', 'verify-tag', 'check', 'publish', 'verify-published']);
});
