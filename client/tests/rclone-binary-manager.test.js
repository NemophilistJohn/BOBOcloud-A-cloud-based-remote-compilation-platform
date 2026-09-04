'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRcloneBinaryManager } = require('../main/rclone-binary-manager');

function fixture(t, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-manager-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  const bundled = path.join(root, 'app', 'rclone.exe');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, 'bundled-rclone');
  const probes = [];
  let id = 0;
  const options = Object.assign({
    app: { isPackaged: false, getPath: () => userData },
    rclone: {},
    userDataPath: userData,
    bundledPath: bundled,
    platform: 'win32',
    environment: { Path: '' },
    randomId: () => 'opaque-' + (++id),
    probeVersion: async (binaryPath, source) => {
      probes.push({ binaryPath, source });
      return { available: true, path: binaryPath, source, version: 'rclone v1.64.0' };
    }
  }, extra || {});
  return { root, userData, bundled, probes, manager: createRcloneBinaryManager(options), options };
}

function addSystemBinary(root, name, contents) {
  const directory = path.join(root, name);
  const binaryPath = path.join(directory, 'rclone.exe');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(binaryPath, contents || name);
  return { directory, binaryPath: fs.realpathSync(binaryPath) };
}

test('PATH scanning lists all candidates without executing any of them and keeps bundled first', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = addSystemBinary(root, 'first');
  const second = addSystemBinary(root, 'second');
  const value = fixture(t, { environment: { Path: first.directory + ';' + second.directory + ';' + first.directory } });

  const result = await value.manager.listCandidates(41);
  assert.deepEqual(result.candidates.map((candidate) => candidate.source), ['bundled', 'system', 'system']);
  assert.deepEqual(result.candidates.slice(1).map((candidate) => candidate.path), [first.binaryPath, second.binaryPath]);
  assert.equal(value.probes.length, 0, 'enumerating PATH must never execute a candidate');
  assert.equal(result.selection.source, 'bundled');
  assert.equal(result.selection.path, null);
  assert.equal(result.candidates[0].path, null, 'the bundled resource path must not be exposed to the renderer');
  assert.match(result.candidates[0].id, /^opaque-/);
  assert.equal(result.candidates[0].id.includes(value.bundled), false);
});

test('cancelling the native warning leaves bundled active and never probes the external file', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-cancel-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const system = addSystemBinary(outside, 'bin');
  const value = fixture(t, { environment: { Path: system.directory } });
  const scan = await value.manager.listCandidates(7);
  const external = scan.candidates.find((candidate) => candidate.source === 'system');
  let confirmations = 0;
  const result = await value.manager.selectCandidate(7, {
    scanId: scan.scanId,
    candidateId: external.id
  }, async () => { confirmations += 1; return false; });

  assert.equal(confirmations, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.selection.source, 'bundled');
  assert.equal(value.probes.length, 0);
  assert.equal(fs.existsSync(value.manager.paths.state), false);
});

test('confirmed external rclone is copied, hashed and only the managed copy is probed', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-external-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const system = addSystemBinary(outside, 'bin', 'trusted-system-rclone');
  const value = fixture(t, { environment: { Path: system.directory } });
  const scan = await value.manager.listCandidates(11);
  const external = scan.candidates.find((candidate) => candidate.source === 'system');
  const result = await value.manager.selectCandidate(11, {
    scanId: scan.scanId,
    candidateId: external.id
  }, async (candidate) => {
    assert.equal(candidate.path, system.binaryPath);
    return true;
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.selection.source, 'system');
  assert.equal(result.selection.path, system.binaryPath);
  assert.equal(value.probes.length, 1);
  assert.notEqual(value.probes[0].binaryPath, system.binaryPath);
  assert.equal(value.probes[0].binaryPath.startsWith(value.manager.paths.managedRoot), true);
  const selectedExecution = await value.manager.getExecutionDescriptor();
  assert.equal(fs.readFileSync(selectedExecution.path, 'utf8'), 'trusted-system-rclone');
  const persisted = JSON.parse(fs.readFileSync(value.manager.paths.state, 'utf8'));
  assert.equal(persisted.mode, 'external');
  assert.match(persisted.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Number.isFinite(persisted.confirmedAt), true);
  persisted.confirmedAt = 'legacy-invalid-timestamp';
  fs.writeFileSync(value.manager.paths.state, JSON.stringify(persisted));

  const restarted = createRcloneBinaryManager(value.options);
  const execution = await restarted.getExecutionDescriptor();
  assert.equal(execution.source, 'system');
  assert.equal(execution.path, selectedExecution.path);
  assert.equal((await restarted.getSelection()).confirmedAt, null);

  const resetScan = await value.manager.listCandidates(11);
  await value.manager.selectCandidate(11, {
    scanId: resetScan.scanId,
    candidateId: resetScan.candidates[0].id
  }, async () => assert.fail('bundled selection must not request external confirmation'));
  assert.equal(fs.existsSync(selectedExecution.path), false);
  assert.equal(JSON.parse(fs.readFileSync(value.manager.paths.state, 'utf8')).mode, 'bundled');
});

test('a candidate changed after scanning is rejected without execution or persistence', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-swap-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const system = addSystemBinary(outside, 'bin', 'first');
  const value = fixture(t, { environment: { Path: system.directory } });
  const scan = await value.manager.listCandidates(9);
  const external = scan.candidates.find((candidate) => candidate.source === 'system');
  fs.writeFileSync(system.binaryPath, 'replacement-with-a-different-size');

  await assert.rejects(value.manager.selectCandidate(9, {
    scanId: scan.scanId,
    candidateId: external.id
  }, async () => true), /changed after it was scanned/);
  assert.equal(value.probes.length, 0);
  assert.equal(fs.existsSync(value.manager.paths.state), false);
});

test('unknown and cross-sender candidate IDs are rejected before confirmation', async (t) => {
  const value = fixture(t);
  const scan = await value.manager.listCandidates(1);
  let confirmed = false;
  await assert.rejects(value.manager.selectCandidate(2, {
    scanId: scan.scanId,
    candidateId: scan.candidates[0].id
  }, async () => { confirmed = true; return true; }), /missing or expired/);
  await assert.rejects(value.manager.selectCandidate(1, {
    scanId: scan.scanId,
    candidateId: 'C:\\workspace\\evil.exe'
  }, async () => { confirmed = true; return true; }), /candidate is invalid/);
  assert.equal(confirmed, false);
});

test('a non-executable bundled Unix resource is repaired only in app-managed storage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-unix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundled = path.join(root, 'resources', 'rclone');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, 'unix-rclone');
  fs.chmodSync(bundled, 0o644);
  const manager = createRcloneBinaryManager({
    app: { isPackaged: true, getPath: () => path.join(root, 'user-data') },
    rclone: {},
    userDataPath: path.join(root, 'user-data'),
    bundledPath: bundled,
    platform: 'linux',
    environment: { PATH: '' },
    probeVersion: async () => ({ available: true, version: 'rclone v1.64.0' })
  });
  const execution = await manager.getExecutionDescriptor();
  assert.notEqual(execution.path, bundled);
  assert.equal(fs.statSync(bundled).mode & 0o111, 0);
  if (process.platform !== 'win32') assert.notEqual(fs.statSync(execution.path).mode & 0o111, 0);
});

test('the Windows bundled resource is also copied into app-managed storage before execution', async (t) => {
  const value = fixture(t);
  const execution = await value.manager.getExecutionDescriptor();
  assert.notEqual(execution.path, value.bundled);
  assert.equal(execution.path.startsWith(value.manager.paths.managedRoot), true);
  assert.equal(fs.readFileSync(execution.path, 'utf8'), 'bundled-rclone');
  assert.match(execution.revision, /^bundled:[a-f0-9]{64}$/);
});

test('a broken bundled candidate does not replace a working external selection', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-rollback-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const system = addSystemBinary(outside, 'bin', 'working-external');
  const value = fixture(t, { environment: { Path: system.directory } });
  const scan = await value.manager.listCandidates(4);
  await value.manager.selectCandidate(4, {
    scanId: scan.scanId,
    candidateId: scan.candidates.find((candidate) => candidate.source === 'system').id
  }, async () => true);
  fs.unlinkSync(value.bundled);

  const reset = await value.manager.listCandidates(4);
  await assert.rejects(value.manager.selectCandidate(4, {
    scanId: reset.scanId,
    candidateId: reset.candidates.find((candidate) => candidate.source === 'bundled').id
  }, async () => true));
  assert.equal((await value.manager.getSelection()).source, 'system');
  assert.equal((await value.manager.getExecutionDescriptor()).source, 'system');
});

test('an updated system binary is not displayed as the selected pinned copy', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-updated-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const system = addSystemBinary(outside, 'bin', 'first-system');
  const value = fixture(t, { environment: { Path: system.directory } });
  const scan = await value.manager.listCandidates(8);
  await value.manager.selectCandidate(8, {
    scanId: scan.scanId,
    candidateId: scan.candidates.find((candidate) => candidate.source === 'system').id
  }, async () => true);
  fs.writeFileSync(system.binaryPath, 'updated-system-binary');

  const rescanned = await value.manager.listCandidates(8);
  assert.equal(rescanned.candidates.find((candidate) => candidate.source === 'system').selected, false);
  assert.equal((await value.manager.getExecutionDescriptor()).source, 'system', 'the pinned managed copy remains active');
});

test('app resources, user data and their ancestor directories are protected workspace roots', (t) => {
  const value = fixture(t);
  assert.throws(() => value.manager.assertSafeLocalRoot(value.userData), /reserved by BOBOCLOUD/);
  assert.throws(() => value.manager.assertSafeLocalRoot(path.dirname(value.bundled)), /reserved by BOBOCLOUD/);
  assert.throws(() => value.manager.assertSafeLocalRoot(value.root), /reserved by BOBOCLOUD/);
  const separate = path.join(os.tmpdir(), 'bobo-safe-project-' + Date.now());
  fs.mkdirSync(separate);
  t.after(() => fs.rmSync(separate, { recursive: true, force: true }));
  assert.equal(value.manager.assertSafeLocalRoot(separate), fs.realpathSync(separate));
});
