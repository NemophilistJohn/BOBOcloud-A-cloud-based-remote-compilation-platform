'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceWriteQueue, createWorkspaceWriteTracker } = require('../main/workspace-write-tracker');

test('managed workspace writes keep watcher echoes on one mutation identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'main.js');
  fs.writeFileSync(filePath, 'before\n');
  const tracker = createWorkspaceWriteTracker({ namespace: 'test', ttlMs: 1000 });

  const write = tracker.begin(filePath, 7, 'workspace-save-test-1', 'after\n', 'utf8');
  assert.deepEqual(tracker.classify(filePath, 7), {
    state: 'pending',
    mutationId: write.id
  }, 'an echo delivered before write completion is held until commit');
  fs.writeFileSync(filePath, 'after\n');
  assert.equal(await tracker.complete(write), true);
  assert.deepEqual(tracker.classify(filePath, 7), { state: 'echo', mutationId: write.id });
  assert.deepEqual(tracker.classify(filePath, 7), {
    state: 'echo',
    mutationId: write.id
  }, 'multiple watcher echoes retain the same identity');
  assert.equal(tracker.classify(filePath, 8), null, 'workspace identities cannot share managed writes');

  fs.writeFileSync(filePath, 'external\n');
  assert.equal(tracker.classify(filePath, 7), null, 'different on-disk content is an external mutation');
  assert.equal(tracker.classify(filePath, 7), null, 'the stale managed-write record is discarded');
});

test('successive saves use distinct identities and stale completions cannot replace the latest write', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'main.js');
  fs.writeFileSync(filePath, 'zero\n');
  const tracker = createWorkspaceWriteTracker({ namespace: 'test' });

  const first = tracker.begin(filePath, 3, '', 'one\n', 'utf8');
  fs.writeFileSync(filePath, 'one\n');
  assert.equal(await tracker.complete(first), true);
  const second = tracker.begin(filePath, 3, '', 'two\n', 'utf8');
  assert.notEqual(first.id, second.id);
  assert.equal(await tracker.complete(first), false);
  fs.writeFileSync(filePath, 'two\n');
  assert.equal(await tracker.complete(second), true);
  assert.deepEqual(tracker.classify(filePath, 3), { state: 'echo', mutationId: second.id });
});

test('managed write tracking is bounded and expires completed records', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-bound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let timestamp = 100;
  const tracker = createWorkspaceWriteTracker({
    namespace: 'test',
    maxEntries: 1,
    ttlMs: 10,
    now: () => timestamp
  });
  const firstPath = path.join(root, 'first.js');
  const secondPath = path.join(root, 'second.js');
  fs.writeFileSync(firstPath, 'first\n');
  fs.writeFileSync(secondPath, 'second\n');

  const first = tracker.begin(firstPath, 1, '', 'first\n', 'utf8');
  await tracker.complete(first);
  const second = tracker.begin(secondPath, 1, '', 'second\n', 'utf8');
  await tracker.complete(second);
  assert.equal(tracker.classify(firstPath, 1), null, 'the oldest completed record is evicted');
  assert.deepEqual(tracker.classify(secondPath, 1), { state: 'echo', mutationId: second.id });

  timestamp += 11;
  assert.equal(tracker.classify(secondPath, 1), null, 'completed records expire after the echo window');
});

test('capacity pressure never evicts an in-flight write identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-pending-bound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstPath = path.join(root, 'first.js');
  const secondPath = path.join(root, 'second.js');
  fs.writeFileSync(firstPath, 'first\n');
  fs.writeFileSync(secondPath, 'second\n');
  const tracker = createWorkspaceWriteTracker({ namespace: 'test', maxEntries: 1 });
  const first = tracker.begin(firstPath, 1, '', 'first\n', 'utf8');

  assert.throws(() => tracker.begin(secondPath, 1, '', 'second\n', 'utf8'), /Too many workspace writes/);
  assert.equal(tracker.classify(firstPath, 1).mutationId, first.id);
});

test('an observed pending write is released as an ordinary change when the write fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'main.js');
  fs.writeFileSync(filePath, 'partial\n');
  const tracker = createWorkspaceWriteTracker({ namespace: 'test' });

  const write = tracker.begin(filePath, 4, '', 'complete\n', 'utf8');
  assert.equal(tracker.classify(filePath, 4).state, 'pending');
  assert.equal(tracker.fail(write), true);
  assert.equal(tracker.classify(filePath, 4), null);
});

test('atomic replacement is not mistaken for a managed write echo', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-replace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'main.js');
  const replacementPath = path.join(root, 'replacement.js');
  fs.writeFileSync(filePath, 'same-size\n');
  const tracker = createWorkspaceWriteTracker({ namespace: 'test' });
  const write = tracker.begin(filePath, 5, '', 'same-size\n', 'utf8');
  await tracker.complete(write);

  fs.writeFileSync(replacementPath, 'new-bytes\n');
  fs.rmSync(filePath);
  fs.renameSync(replacementPath, filePath);
  assert.equal(tracker.classify(filePath, 5), null);
});

test('commit rejects bytes that no longer match the save request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-conflict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'main.js');
  fs.writeFileSync(filePath, 'before\n');
  const tracker = createWorkspaceWriteTracker({ namespace: 'test' });
  const write = tracker.begin(filePath, 6, '', 'requested\n', 'utf8');

  fs.writeFileSync(filePath, 'external\n');
  assert.equal(await tracker.complete(write), false);
  assert.equal(tracker.classify(filePath, 6), null);
});

test('commit rejects a file that grows beyond the expected save bytes without buffering it whole', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-growth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'main.js');
  fs.writeFileSync(filePath, 'before');
  const tracker = createWorkspaceWriteTracker({ namespace: 'test' });
  const write = tracker.begin(filePath, 6, '', 'small', 'utf8');
  fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 0x61));
  assert.equal(await tracker.complete(write), false);
  assert.equal(tracker.classify(filePath, 6), null);
});

test('workspace mutations are serialized so structural work cannot overtake a save', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-write-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'main.js');
  fs.writeFileSync(filePath, 'zero\n');
  const queue = createWorkspaceWriteQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });

  const first = queue.run(filePath, async () => {
    firstStarted();
    await firstGate;
    await fs.promises.writeFile(filePath, 'older\n');
  });
  await started;
  const second = queue.run(path.join(root, 'rename-or-delete-scope'), async () => {
    await fs.promises.writeFile(filePath, 'newer\n');
  });
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(fs.readFileSync(filePath, 'utf8'), 'newer\n');
});

test('a failed workspace mutation releases the queue for the next operation', async () => {
  const queue = createWorkspaceWriteQueue();
  await assert.rejects(queue.run('first', async () => {
    throw new Error('fixture failure');
  }), /fixture failure/);
  assert.equal(await queue.run('second', async () => 'completed'), 'completed');
});

test('workspace transition blocks new mutations and drains accepted work before switching', async () => {
  const queue = createWorkspaceWriteQueue();
  let releaseWrite;
  let writeStarted;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const order = [];
  const write = queue.run('old-workspace', async () => {
    order.push('write-start');
    writeStarted();
    await writeGate;
    order.push('write-commit');
  });
  await started;
  const transition = queue.transition('workspace-switch', async () => {
    order.push('transition');
    await assert.rejects(queue.run('reentrant', async () => {}), (error) => {
      assert.equal(error.code, 'WORKSPACE_TRANSITION_IN_PROGRESS');
      return true;
    });
  });
  await assert.rejects(queue.run('late-write', async () => {}), (error) => {
    assert.equal(error.code, 'WORKSPACE_TRANSITION_IN_PROGRESS');
    return true;
  });
  assert.deepEqual(order, ['write-start']);
  releaseWrite();
  await Promise.all([write, transition]);
  assert.deepEqual(order, ['write-start', 'write-commit', 'transition']);
  assert.equal(await queue.run('next-workspace', async () => 'accepted'), 'accepted');
});

test('a failed workspace transition releases the mutation barrier', async () => {
  const queue = createWorkspaceWriteQueue();
  await assert.rejects(queue.transition('failed-switch', async () => {
    throw new Error('switch failed');
  }), /switch failed/);
  assert.equal(await queue.run('after-failure', async () => 'accepted'), 'accepted');
});
