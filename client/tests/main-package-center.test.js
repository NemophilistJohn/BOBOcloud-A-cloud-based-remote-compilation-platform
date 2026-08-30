'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPackageCenterController,
  normalizeRelativeManifestPath,
  resolveWorkspaceRoot,
  sha256
} = require('../main/package-center');
const { createWorkspaceController } = require('../main/workspace');

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-center-'));
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-user-data-'));
  const identity = { rootPath: root, workspaceIdentity: 7 };
  const changed = [];
  const controller = createPackageCenterController({
    ipcMain: { handle() {} },
    getWorkspaceIdentity: () => Object.assign({}, identity),
    onFilesChanged: files => changed.push(...files),
    beforeCompareAndSwap: options.beforeCompareAndSwap,
    onJournalCheckpoint: options.onJournalCheckpoint,
    userDataPath
  });
  return {
    root,
    identity,
    userDataPath,
    changed,
    controller,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  };
}

function simulatedCrash(message) {
  const error = new Error(message || 'simulated process crash');
  error.simulateProcessCrash = true;
  return error;
}

function recoveryController(current, options = {}) {
  return createPackageCenterController({
    ipcMain: { handle() {} },
    getWorkspaceIdentity: () => Object.assign({}, current.identity),
    onFilesChanged: files => current.changed.push(...files),
    onJournalCheckpoint: options.onJournalCheckpoint,
    userDataPath: current.userDataPath
  });
}

function journalDirectories(current) {
  const root = path.join(current.userDataPath, 'package-center-transactions');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(name => path.join(root, name));
}

function pathIsInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function plan(testFixture, options = {}) {
  const relativePath = options.path || 'requirements.txt';
  const target = path.join(testFixture.root, ...relativePath.split('/'));
  const oldContent = Object.prototype.hasOwnProperty.call(options, 'oldContent') ? options.oldContent : 'requests==2.31.0\n';
  const newContent = Object.prototype.hasOwnProperty.call(options, 'newContent') ? options.newContent : 'requests==2.32.4\n';
  const newDigest = sha256(Buffer.from(newContent, 'utf8'));
  if (options.create !== true) fs.writeFileSync(target, oldContent, 'utf8');
  return {
    workspaceRoot: testFixture.root,
    workspaceIdentity: testFixture.identity.workspaceIdentity,
    planId: options.planId || 'plan-1',
    revision: options.revision || 'revision-1',
    language: options.language || 'python',
    localChanges: [{
      path: relativePath,
      oldExists: options.create !== true,
      oldSha256: options.create === true ? '' : sha256(Buffer.from(oldContent, 'utf8')),
      newContent,
      newSha256: newDigest
    }],
    manifestBindings: [{ path: relativePath, sha256: newDigest }]
  };
}

function reinstallPlan(testFixture, options = {}) {
  const relativePath = options.path || 'requirements.txt';
  const content = options.content || 'requests==2.32.4\n';
  fs.writeFileSync(path.join(testFixture.root, ...relativePath.split('/')), content, 'utf8');
  return {
    workspaceRoot: testFixture.root,
    workspaceIdentity: testFixture.identity.workspaceIdentity,
    planId: options.planId || 'reinstall-plan-1',
    revision: options.revision || 'revision-1',
    language: options.language || 'python',
    reinstall: true,
    changes: [{ operation: 'update', name: 'requests', version: '2.32.4' }],
    localChanges: [],
    manifestBindings: [{ path: relativePath, sha256: sha256(Buffer.from(content, 'utf8')) }]
  };
}

function nodePlan(testFixture, options = {}) {
  const oldPackage = options.oldPackage || '{\n  "name": "demo",\n  "dependencies": {}\n}\n';
  const newPackage = options.newPackage || '{\n  "name": "demo",\n  "dependencies": { "lodash": "4.17.21" }\n}\n';
  const oldLock = options.oldLock || '{\n  "name": "demo",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n';
  const newLock = options.newLock || '{\n  "name": "demo",\n  "lockfileVersion": 3,\n  "packages": { "node_modules/lodash": { "version": "4.17.21" } }\n}\n';
  fs.writeFileSync(path.join(testFixture.root, 'package.json'), oldPackage, 'utf8');
  fs.writeFileSync(path.join(testFixture.root, 'package-lock.json'), oldLock, 'utf8');
  return {
    workspaceRoot: testFixture.root,
    workspaceIdentity: testFixture.identity.workspaceIdentity,
    planId: options.planId || 'node-plan-1',
    revision: options.revision || 'node-revision-1',
    language: 'node',
    localChanges: [
      { path: 'package.json', oldExists: true, oldSha256: sha256(Buffer.from(oldPackage)), newContent: newPackage, newSha256: sha256(Buffer.from(newPackage)) },
      { path: 'package-lock.json', oldExists: true, oldSha256: sha256(Buffer.from(oldLock)), newContent: newLock, newSha256: sha256(Buffer.from(newLock)) }
    ],
    manifestBindings: [
      { path: 'package.json', sha256: sha256(Buffer.from(newPackage)) },
      { path: 'package-lock.json', sha256: sha256(Buffer.from(newLock)) }
    ]
  };
}

test('package file transactions apply idempotently and rollback the complete local change', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const payload = plan(current);

  const applied = await current.controller.applyLocalChanges(payload);
  assert.equal(applied.success, true);
  assert.equal(fs.readFileSync(path.join(current.root, 'requirements.txt'), 'utf8'), 'requests==2.32.4\n');
  assert.equal(current.controller.activeTransactionCount(), 1);

  const retried = await current.controller.applyLocalChanges(payload);
  assert.equal(retried.transactionId, applied.transactionId);
  assert.equal(retried.alreadyApplied, true);

  const rolledBack = await current.controller.rollbackLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity,
    reason: 'sync-failed'
  });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(current.root, 'requirements.txt'), 'utf8'), 'requests==2.31.0\n');
  assert.equal(current.controller.activeTransactionCount(), 0);
  assert.deepEqual(current.changed.map(item => item.event), ['file-changed', 'file-changed']);
  assert.deepEqual(journalDirectories(current), []);
});

test('committing retains dependency files and is idempotent', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const applied = await current.controller.applyLocalChanges(plan(current));
  const request = {
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  };

  const committed = await current.controller.commitLocalChanges(request);
  assert.equal(committed.committed, true);
  assert.equal(fs.readFileSync(path.join(current.root, 'requirements.txt'), 'utf8'), 'requests==2.32.4\n');
  assert.deepEqual(journalDirectories(current), []);
  assert.deepEqual(await current.controller.commitLocalChanges(request), {
    success: true,
    transactionId: applied.transactionId,
    alreadyFinalized: true,
    state: 'committed'
  });
});

test('rollback preserves newer edits and releases the superseded transaction', async (t) => {
  let mutateBeforeRollback = false;
  const newerContent = 'requests==2.32.4\nnumpy==2.3.2\n';
  const current = fixture({
    beforeCompareAndSwap(details) {
      if (details.phase !== 'rollback' || !mutateBeforeRollback) return;
      mutateBeforeRollback = false;
      fs.writeFileSync(details.path, newerContent, 'utf8');
    }
  });
  t.after(current.cleanup);
  const applied = await current.controller.applyLocalChanges(plan(current));
  const target = path.join(current.root, 'requirements.txt');
  mutateBeforeRollback = true;

  const result = await current.controller.rollbackLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  });
  assert.equal(result.superseded, true);
  assert.equal(result.preserved, true);
  assert.equal(result.rolledBack, false);
  assert.equal(result.conflicts[0].path, 'requirements.txt');
  assert.equal(fs.readFileSync(target, 'utf8'), newerContent);
  assert.equal(current.controller.activeTransactionCount(), 0);
});

test('new dependency manifests are removed on rollback', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const payload = plan(current, { create: true, oldContent: '', newContent: 'numpy==2.3.2\n' });
  const applied = await current.controller.applyLocalChanges(payload);
  assert.equal(fs.existsSync(path.join(current.root, 'requirements.txt')), true);

  await current.controller.rollbackLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  });
  assert.equal(fs.existsSync(path.join(current.root, 'requirements.txt')), false);
  assert.equal(current.changed.at(-1).event, 'file-deleted');
});

test('legacy new-manifest plans may omit the empty old digest', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const payload = plan(current, { create: true, planId: 'legacy-new-manifest', newContent: 'numpy==2.3.2\n' });
  delete payload.localChanges[0].oldSha256;

  const applied = await current.controller.applyLocalChanges(payload);
  assert.equal(applied.success, true);
  await current.controller.rollbackLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  });
  assert.equal(fs.existsSync(path.join(current.root, 'requirements.txt')), false);
});

test('package plans require oldExists and reject contradictory old digests', async (t) => {
  const current = fixture();
  t.after(current.cleanup);

  const missingIdentity = plan(current, { planId: 'missing-old-exists' });
  delete missingIdentity.localChanges[0].oldExists;
  await assert.rejects(current.controller.applyLocalChanges(missingIdentity), error => error.code === 'PACKAGE_CHANGE_INVALID');

  const contradictory = plan(current, { create: true, planId: 'contradictory-old-digest' });
  contradictory.localChanges[0].oldSha256 = sha256(Buffer.from('not-present\n', 'utf8'));
  await assert.rejects(current.controller.applyLocalChanges(contradictory), error => error.code === 'PACKAGE_CHANGE_DIGEST_INVALID');
});

test('package plans reject stale files, traversal, and cross-language manifests before writing', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const stale = plan(current);
  fs.writeFileSync(path.join(current.root, 'requirements.txt'), 'locally-edited\n', 'utf8');
  await assert.rejects(current.controller.applyLocalChanges(stale), error => error.code === 'PACKAGE_CHANGE_OLD_DIGEST_MISMATCH');
  assert.equal(fs.readFileSync(path.join(current.root, 'requirements.txt'), 'utf8'), 'locally-edited\n');

  assert.throws(() => normalizeRelativeManifestPath('../requirements.txt', 'python'), error => error.code === 'PACKAGE_CHANGE_PATH_INVALID');
  assert.throws(() => normalizeRelativeManifestPath('package.json', 'python'), error => error.code === 'PACKAGE_CHANGE_FILE_NOT_ALLOWED');
});

test('workspace root aliases resolve by file identity while symbolic roots remain forbidden', async (t) => {
  const ordinaryDirectory = {
    dev: 7,
    ino: 11,
    isDirectory: () => true,
    isSymbolicLink: () => false
  };
  const canonical = await resolveWorkspaceRoot('lexical-workspace-alias', {
    lstat: async () => ordinaryDirectory,
    realpath: async () => path.resolve('canonical-workspace-root'),
    stat: async () => ordinaryDirectory
  });
  assert.equal(canonical, path.resolve('canonical-workspace-root'));

  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-real-root-'));
  const realChild = path.join(realRoot, 'workspace');
  fs.mkdirSync(realChild);
  const linkedRoot = realRoot + '-link';
  t.after(() => {
    try { fs.rmSync(linkedRoot, { recursive: true, force: true }); } catch (_) {}
    fs.rmSync(realRoot, { recursive: true, force: true });
  });
  try {
    fs.symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip('directory links are unavailable on this test host: ' + error.message);
    return;
  }
  await assert.rejects(resolveWorkspaceRoot(linkedRoot), error => error.code === 'PACKAGE_WORKSPACE_SYMLINK');
  await assert.rejects(resolveWorkspaceRoot(path.join(linkedRoot, 'workspace')), error => error.code === 'PACKAGE_WORKSPACE_SYMLINK');
});

test('package plans accept a bounded multi-file transaction or an exact reinstall binding', async (t) => {
  const current = fixture();
  t.after(current.cleanup);

  const empty = plan(current, { planId: 'empty-plan' });
  empty.localChanges = [];
  await assert.rejects(current.controller.applyLocalChanges(empty), error => error.code === 'PACKAGE_CHANGE_SET_INVALID');

  const multiple = nodePlan(current);
  const appliedMultiple = await current.controller.applyLocalChanges(multiple);
  assert.deepEqual(appliedMultiple.changedFiles.map(item => item.path), ['package.json', 'package-lock.json']);
  assert.match(fs.readFileSync(path.join(current.root, 'package.json'), 'utf8'), /lodash/);
  assert.match(fs.readFileSync(path.join(current.root, 'package-lock.json'), 'utf8'), /node_modules\/lodash/);
  await current.controller.rollbackLocalChanges({
    transactionId: appliedMultiple.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  });
  assert.doesNotMatch(fs.readFileSync(path.join(current.root, 'package.json'), 'utf8'), /lodash/);
  assert.doesNotMatch(fs.readFileSync(path.join(current.root, 'package-lock.json'), 'utf8'), /node_modules\/lodash/);

  const unchanged = plan(current, {
    planId: 'noop-plan',
    oldContent: 'requests==2.32.4\n',
    newContent: 'requests==2.32.4\n'
  });
  await assert.rejects(current.controller.applyLocalChanges(unchanged), error => error.code === 'PACKAGE_CHANGE_NOOP');
  assert.equal(current.controller.activeTransactionCount(), 0);

  const changedBeforeReinstall = current.changed.length;
  const reinstall = await current.controller.applyLocalChanges(reinstallPlan(current));
  assert.equal(reinstall.reinstall, true);
  assert.deepEqual(reinstall.changedFiles, []);
  assert.equal(reinstall.publishedFiles[0].path, 'requirements.txt');
  assert.equal(current.changed.length, changedBeforeReinstall, 'a read-only reinstall binding must not emit file changes');
  assert.equal(fs.readFileSync(path.join(current.root, 'requirements.txt'), 'utf8'), 'requests==2.32.4\n');
  await current.controller.rollbackLocalChanges({
    transactionId: reinstall.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  });
});

test('multi-file apply restores earlier dependency files when a later CAS fails', async (t) => {
  let mutateLock = true;
  const externalLock = '{"lockfileVersion":3,"external":true}\n';
  const current = fixture({
    beforeCompareAndSwap(details) {
      if (details.phase === 'apply' && details.path.endsWith('package-lock.json') && mutateLock) {
        mutateLock = false;
        fs.writeFileSync(details.path, externalLock, 'utf8');
      }
    }
  });
  t.after(current.cleanup);
  const payload = nodePlan(current);
  const originalPackage = fs.readFileSync(path.join(current.root, 'package.json'), 'utf8');

  await assert.rejects(
    current.controller.applyLocalChanges(payload),
    error => error.code === 'PACKAGE_CHANGE_OLD_DIGEST_MISMATCH'
  );
  assert.equal(fs.readFileSync(path.join(current.root, 'package.json'), 'utf8'), originalPackage);
  assert.equal(fs.readFileSync(path.join(current.root, 'package-lock.json'), 'utf8'), externalLock);
  assert.equal(current.controller.activeTransactionCount(), 0);
});

test('startup recovery rolls back a partial multi-file apply from a private metadata-only journal', async (t) => {
  let appliedFiles = 0;
  const current = fixture({
    onJournalCheckpoint(details) {
      if (details.phase === 'file-applied' && ++appliedFiles === 1) throw simulatedCrash('after first manifest');
    }
  });
  t.after(current.cleanup);
  const secret = 'registry-token-must-not-enter-journal';
  const payload = nodePlan(current, {
    oldPackage: `{\n  "name": "demo",\n  "privateToken": "${secret}",\n  "dependencies": {}\n}\n`,
    newPackage: `{\n  "name": "demo",\n  "privateToken": "${secret}",\n  "dependencies": { "lodash": "4.17.21" }\n}\n`
  });
  const oldPackage = payload.localChanges[0].oldSha256;
  const oldLock = payload.localChanges[1].oldSha256;

  await assert.rejects(current.controller.applyLocalChanges(payload), error => error.simulateProcessCrash === true);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package.json'))), payload.localChanges[0].newSha256);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package-lock.json'))), oldLock);
  assert.equal(fs.existsSync(path.join(current.root, '.bobocloud')), false);

  const directories = journalDirectories(current);
  assert.equal(directories.length, 1);
  assert.equal(pathIsInside(current.userDataPath, directories[0]), true);
  const journalText = fs.readFileSync(path.join(directories[0], 'journal.json'), 'utf8');
  assert.equal(journalText.includes(secret), false);
  const journal = JSON.parse(journalText);
  assert.deepEqual(Object.keys(journal).sort(), ['files', 'schema', 'state', 'transactionId', 'workspaceRoot']);
  assert.deepEqual(Object.keys(journal.files[0]).sort(), ['newSha256', 'oldExists', 'oldSha256', 'target']);

  const recovered = recoveryController(current);
  const recovery = await recovered.ready();
  assert.equal(recovery[0].state, 'rolled-back');
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package.json'))), oldPackage);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package-lock.json'))), oldLock);
  assert.deepEqual(journalDirectories(current), []);
});

test('startup recovery is restartable when the process exits between restored files', async (t) => {
  let appliedFiles = 0;
  const current = fixture({
    onJournalCheckpoint(details) {
      if (details.phase === 'file-applied' && ++appliedFiles === 2) throw simulatedCrash('after all manifests');
    }
  });
  t.after(current.cleanup);
  const payload = nodePlan(current);
  await assert.rejects(current.controller.applyLocalChanges(payload), error => error.simulateProcessCrash === true);

  let recoveryWrites = 0;
  const interruptedRecovery = recoveryController(current, {
    onJournalCheckpoint(details) {
      if (details.phase === 'recovery-file-restored' && ++recoveryWrites === 1) throw simulatedCrash('during recovery');
    }
  });
  const interrupted = await interruptedRecovery.ready();
  assert.equal(interrupted[0].success, false);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package.json'))), payload.localChanges[0].newSha256);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package-lock.json'))), payload.localChanges[1].oldSha256);
  assert.equal(journalDirectories(current).length, 1);

  const recovered = recoveryController(current);
  const completed = await recovered.ready();
  assert.equal(completed[0].state, 'rolled-back');
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package.json'))), payload.localChanges[0].oldSha256);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package-lock.json'))), payload.localChanges[1].oldSha256);
  assert.deepEqual(journalDirectories(current), []);
});

test('startup recovery never overwrites a newer user edit and preserves reconciliation metadata', async (t) => {
  let appliedFiles = 0;
  const current = fixture({
    onJournalCheckpoint(details) {
      if (details.phase === 'file-applied' && ++appliedFiles === 2) throw simulatedCrash('after all manifests');
    }
  });
  t.after(current.cleanup);
  const payload = nodePlan(current);
  await assert.rejects(current.controller.applyLocalChanges(payload), error => error.simulateProcessCrash === true);
  const userContent = '{\n  "name": "demo",\n  "dependencies": { "user-owned": "1.0.0" }\n}\n';
  fs.writeFileSync(path.join(current.root, 'package.json'), userContent, 'utf8');

  const recovered = recoveryController(current);
  const recovery = await recovered.ready();
  assert.equal(recovery[0].reconciliationRequired, true);
  assert.equal(fs.readFileSync(path.join(current.root, 'package.json'), 'utf8'), userContent);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package-lock.json'))), payload.localChanges[1].newSha256);
  const directories = journalDirectories(current);
  assert.equal(directories.length, 1);
  const journal = JSON.parse(fs.readFileSync(path.join(directories[0], 'journal.json'), 'utf8'));
  assert.equal(journal.state, 'rollback-reconciliation-required');

  const identity = { workspaceRoot: current.root, workspaceIdentity: current.identity.workspaceIdentity };
  const pending = await recovered.listPendingRecoveries(identity);
  assert.equal(pending.recoveries.length, 1);
  assert.equal(pending.recoveries[0].files.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(pending.recoveries[0], 'workspaceRoot'), false);
  await assert.rejects(recovered.applyLocalChanges(payload), error =>
    error.code === 'PACKAGE_RECOVERY_RECONCILIATION_REQUIRED' && error.transactionId === pending.recoveries[0].transactionId);

  const retried = await recovered.resolvePendingRecovery(Object.assign({}, identity, {
    transactionId: pending.recoveries[0].transactionId,
    action: 'retry'
  }));
  assert.equal(retried.resolved, false);
  fs.writeFileSync(path.join(current.root, 'package.json'), userContent.replace('1.0.0', '1.0.1'), 'utf8');
  await assert.rejects(recovered.resolvePendingRecovery(Object.assign({}, identity, {
    transactionId: pending.recoveries[0].transactionId,
    action: 'accept-current',
    files: retried.recovery.files
  })), error => error.code === 'PACKAGE_RECOVERY_CAS_MISMATCH');

  const refreshed = await recovered.listPendingRecoveries(identity);
  const accepted = await recovered.resolvePendingRecovery(Object.assign({}, identity, {
    transactionId: pending.recoveries[0].transactionId,
    action: 'accept-current',
    files: refreshed.recoveries[0].files
  }));
  assert.equal(accepted.state, 'preserved');
  assert.deepEqual(journalDirectories(current), []);
  const followUp = await recovered.applyLocalChanges(plan(current, { planId: 'after-recovery' }));
  await recovered.rollbackLocalChanges(Object.assign({}, identity, { transactionId: followUp.transactionId }));
});

test('startup recovery retains published dependency files after a server-applied checkpoint', async (t) => {
  const current = fixture({
    onJournalCheckpoint(details) {
      if (details.phase === 'server-applied') throw simulatedCrash('after server publication');
    }
  });
  t.after(current.cleanup);
  const payload = nodePlan(current);
  const applied = await current.controller.applyLocalChanges(payload);
  await assert.rejects(current.controller.commitLocalChanges({
    transactionId: applied.transactionId,
    planId: applied.planId,
    serverApplied: true,
    publishedFiles: applied.publishedFiles
  }), error => error.simulateProcessCrash === true);
  assert.equal(journalDirectories(current).length, 1);

  const recovered = recoveryController(current);
  const recovery = await recovered.ready();
  assert.equal(recovery[0].state, 'committed');
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package.json'))), payload.localChanges[0].newSha256);
  assert.equal(sha256(fs.readFileSync(path.join(current.root, 'package-lock.json'))), payload.localChanges[1].newSha256);
  assert.deepEqual(journalDirectories(current), []);
});

test('package transactions verify unchanged lock bindings and reject unbound writes', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const payload = nodePlan(current, { planId: 'node-unchanged-lock' });
  payload.localChanges.pop();
  const lockContent = fs.readFileSync(path.join(current.root, 'package-lock.json'));
  payload.manifestBindings[1].sha256 = sha256(lockContent);

  const applied = await current.controller.applyLocalChanges(payload);
  assert.deepEqual(applied.changedFiles.map(item => item.path), ['package.json']);
  assert.deepEqual(applied.publishedFiles.map(item => item.path), ['package.json', 'package-lock.json']);
  await current.controller.rollbackLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  });

  const unbound = nodePlan(current, { planId: 'node-unbound-change' });
  unbound.manifestBindings = unbound.manifestBindings.filter(item => item.path !== 'package.json');
  await assert.rejects(
    current.controller.applyLocalChanges(unbound),
    error => error.code === 'PACKAGE_CHANGE_UNBOUND'
  );
});

test('apply compares the manifest again immediately before atomic replacement', async (t) => {
  let injectRace = true;
  const externalContent = 'requests==2.31.0\n# edited while applying\n';
  const current = fixture({
    beforeCompareAndSwap(details) {
      if (details.phase !== 'apply' || !injectRace) return;
      injectRace = false;
      fs.writeFileSync(details.path, externalContent, 'utf8');
    }
  });
  t.after(current.cleanup);

  await assert.rejects(
    current.controller.applyLocalChanges(plan(current)),
    error => error.code === 'PACKAGE_CHANGE_OLD_DIGEST_MISMATCH'
  );
  assert.equal(fs.readFileSync(path.join(current.root, 'requirements.txt'), 'utf8'), externalContent);
  assert.equal(current.controller.activeTransactionCount(), 0);
});

test('published commit preserves newer files and enters idempotent reconciliation across workspace identity changes', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const applied = await current.controller.applyLocalChanges(plan(current));
  const target = path.join(current.root, 'requirements.txt');
  const newerContent = 'requests==2.32.4\nnumpy==2.3.2\n';
  fs.writeFileSync(target, newerContent, 'utf8');
  const request = {
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  };

  await assert.rejects(current.controller.commitLocalChanges(request), error => error.code === 'PACKAGE_COMMIT_CONFLICT');
  await assert.rejects(
    current.controller.commitLocalChanges(Object.assign({}, request, { serverApplied: true, planId: 'different-plan', publishedFiles: applied.publishedFiles })),
    error => error.code === 'PACKAGE_PLAN_INVALID'
  );
  current.identity.workspaceIdentity = 8;
  const reconciled = await current.controller.commitLocalChanges(Object.assign({}, request, {
    serverApplied: true,
    planId: applied.planId,
    publishedFiles: applied.publishedFiles
  }));
  assert.equal(reconciled.committed, false);
  assert.equal(reconciled.reconciliationRequired, true);
  assert.equal(reconciled.conflicts[0].path, 'requirements.txt');
  assert.equal(fs.readFileSync(target, 'utf8'), newerContent);
  assert.equal(current.controller.activeTransactionCount(), 0);
  const repeated = await current.controller.commitLocalChanges(Object.assign({}, request, {
    serverApplied: true,
    planId: applied.planId,
    publishedFiles: applied.publishedFiles
  }));
  assert.equal(repeated.reconciliationRequired, true);
  assert.equal(repeated.alreadyFinalized, true);
});

test('published commit treats a newer editor buffer as reconciliation even before it reaches disk', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const applied = await current.controller.applyLocalChanges(plan(current));
  const result = await current.controller.commitLocalChanges({
    transactionId: applied.transactionId,
    planId: applied.planId,
    serverApplied: true,
    publishedFiles: applied.publishedFiles,
    editorConflicts: [{
      path: 'requirements.txt',
      expectedSha256: applied.publishedFiles[0].sha256,
      actualSha256: sha256(Buffer.from('editor-only\n', 'utf8')),
      expectedVersion: 3,
      actualVersion: 4
    }]
  });
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.conflicts[0].source, 'editor');
  assert.equal(fs.readFileSync(path.join(current.root, 'requirements.txt'), 'utf8'), 'requests==2.32.4\n');
  assert.equal(current.controller.activeTransactionCount(), 0);
});

test('server publication promotes a preserved local transaction to committed', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const applied = await current.controller.applyLocalChanges(plan(current));
  const preserved = await current.controller.preserveAll('renderer-gone');
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].preserved, true);
  assert.equal(current.controller.activeTransactionCount(), 0);

  current.identity.workspaceIdentity = 9;
  const committed = await current.controller.commitLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: 7,
    planId: applied.planId,
    serverApplied: true,
    publishedFiles: applied.publishedFiles
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.previousState, 'preserved');
  assert.equal(committed.state, 'committed');
  assert.deepEqual(await current.controller.commitLocalChanges({
    transactionId: applied.transactionId,
    planId: applied.planId,
    serverApplied: true,
    publishedFiles: applied.publishedFiles
  }), {
    success: true,
    transactionId: applied.transactionId,
    alreadyFinalized: true,
    state: 'committed'
  });
});

test('workspace transition barriers are nested and block new package applies until every transition ends', async (t) => {
  const current = fixture();
  t.after(current.cleanup);
  const payload = plan(current);

  await current.controller.beginWorkspaceTransition('first');
  await current.controller.beginWorkspaceTransition('nested');
  await assert.rejects(current.controller.applyLocalChanges(payload), error => error.code === 'PACKAGE_WORKSPACE_TRANSITION');
  assert.equal(await current.controller.endWorkspaceTransition(), 1);
  await assert.rejects(current.controller.applyLocalChanges(payload), error => error.code === 'PACKAGE_WORKSPACE_TRANSITION');
  assert.equal(await current.controller.endWorkspaceTransition(), 0);

  const applied = await current.controller.applyLocalChanges(payload);
  assert.equal(applied.success, true);
  await current.controller.rollbackLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: current.root,
    workspaceIdentity: current.identity.workspaceIdentity
  });
});

test('workspace switching preserves local project truth and releases the transition barrier', async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-source-'));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-target-'));
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-user-data-'));
  t.after(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  const handlers = new Map();
  const ipcMain = {
    handle: (name, handler) => handlers.set(name, handler),
    on: (name, handler) => handlers.set(name, handler)
  };
  let packageController = null;
  const workspace = createWorkspaceController({
    ipcMain,
    dialog: {},
    getWindow: () => null,
    settings: { readProjectNames: () => ({}), saveProjectName: () => true },
    t: value => value,
    beforeWorkspaceChange: reason => packageController.beginWorkspaceTransition(reason),
    afterWorkspaceChange: () => packageController.endWorkspaceTransition()
  });
  t.after(() => workspace.clearWatchers());
  workspace.registerIpc();
  await handlers.get('pick-workspace')({}, sourceRoot);
  packageController = createPackageCenterController({
    ipcMain: { handle() {} },
    getWorkspaceIdentity: workspace.getIdentity,
    onFilesChanged: files => workspace.notifyExternalFileChanges(files),
    userDataPath
  });
  const current = {
    root: sourceRoot,
    identity: { workspaceIdentity: workspace.getIdentity().workspaceIdentity }
  };
  await packageController.applyLocalChanges(plan(current));
  const newestSourceContent = 'requests==2.32.4\nnumpy==2.3.2\n';
  fs.writeFileSync(path.join(sourceRoot, 'requirements.txt'), newestSourceContent, 'utf8');

  await handlers.get('pick-workspace')({}, targetRoot);
  assert.equal(workspace.getIdentity().rootPath, path.resolve(targetRoot));
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'requirements.txt'), 'utf8'), newestSourceContent);
  assert.equal(packageController.activeTransactionCount(), 0);

  const target = {
    root: targetRoot,
    identity: { workspaceIdentity: workspace.getIdentity().workspaceIdentity }
  };
  const targetApplied = await packageController.applyLocalChanges(plan(target, { planId: 'target-plan' }));
  assert.equal(targetApplied.success, true);
  await packageController.rollbackLocalChanges({
    transactionId: targetApplied.transactionId,
    workspaceRoot: targetRoot,
    workspaceIdentity: target.identity.workspaceIdentity
  });
});

test('an aborted workspace switch releases the barrier without reviving preserved transactions', async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-abort-source-'));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-abort-target-'));
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-user-data-'));
  t.after(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  const handlers = new Map();
  const ipcMain = {
    handle: (name, handler) => handlers.set(name, handler),
    on: (name, handler) => handlers.set(name, handler)
  };
  let packageController = null;
  let rejectStop = false;
  const workspace = createWorkspaceController({
    ipcMain,
    dialog: {},
    getWindow: () => null,
    settings: { readProjectNames: () => ({}), saveProjectName: () => true },
    t: value => value,
    stopTerminal() {
      if (rejectStop) throw new Error('terminal stop failed');
    },
    beforeWorkspaceChange: reason => packageController.beginWorkspaceTransition(reason),
    afterWorkspaceChange: () => packageController.endWorkspaceTransition()
  });
  t.after(() => workspace.clearWatchers());
  workspace.registerIpc();
  await handlers.get('pick-workspace')({}, sourceRoot);
  packageController = createPackageCenterController({
    ipcMain: { handle() {} },
    getWorkspaceIdentity: workspace.getIdentity,
    onFilesChanged: files => workspace.notifyExternalFileChanges(files),
    userDataPath
  });
  const source = {
    root: sourceRoot,
    identity: { workspaceIdentity: workspace.getIdentity().workspaceIdentity }
  };
  await packageController.applyLocalChanges(plan(source));

  rejectStop = true;
  await assert.rejects(handlers.get('pick-workspace')({}, targetRoot), /terminal stop failed/);
  assert.equal(workspace.getIdentity().rootPath, path.resolve(sourceRoot));
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'requirements.txt'), 'utf8'), 'requests==2.32.4\n');
  assert.equal(packageController.activeTransactionCount(), 0);

  const followUp = plan(source, {
    planId: 'after-abort-plan',
    oldContent: 'requests==2.32.4\n',
    newContent: 'requests==2.33.0\n'
  });
  const applied = await packageController.applyLocalChanges(followUp);
  assert.equal(applied.success, true);
  await packageController.rollbackLocalChanges({
    transactionId: applied.transactionId,
    workspaceRoot: sourceRoot,
    workspaceIdentity: source.identity.workspaceIdentity
  });
});

test('package center IPC exposes structured failures and rejects inactive renderer senders', async (t) => {
  const handlers = new Map();
  const activeSender = {};
  const window = { isDestroyed: () => false, webContents: Object.assign(activeSender, { isDestroyed: () => false, send() {} }) };
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-package-user-data-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const controller = createPackageCenterController({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getWindow: () => window,
    getWorkspaceIdentity: () => ({ rootPath: '', workspaceIdentity: 0 }),
    userDataPath
  });
  controller.registerIpc();

  assert.deepEqual([...handlers.keys()], [
    'package-center:apply-local-changes',
    'package-center:rollback-local-changes',
    'package-center:commit-local-changes',
    'package-center:list-pending-recoveries',
    'package-center:resolve-pending-recovery'
  ]);
  const inactive = await handlers.get('package-center:apply-local-changes')({ sender: {} }, {});
  assert.equal(inactive.success, false);
  assert.equal(inactive.error.code, 'PACKAGE_SENDER_INVALID');
});

test('window close releases its package transition before a macOS window can be recreated', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /await packageCenter\.beginWorkspaceTransition\('window-close'\);\s*packageTransitionHeld = true;/);
  assert.match(source, /window\.on\('closed',[\s\S]*?if \(packageTransitionHeld\) \{[\s\S]*?packageCenter\.endWorkspaceTransition\(\);[\s\S]*?\}/);
});
