'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_DOCUMENT_SESSION_READS,
  MAX_DOCUMENT_SENDER_READS,
  createPluginDocumentBroker
} = require('../main/plugin-documents');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeStat(overrides = {}) {
  return Object.freeze({
    size: 8,
    mtimeMs: 1_000,
    ctimeMs: 900,
    dev: 7,
    ino: 11,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides
  });
}

function createHarness(options = {}) {
  const pendingReads = [];
  const stat = fakeStat();
  let handleStatCalls = 0;
  let lstatCalls = 0;
  const fileSystem = {
    async lstat() {
      lstatCalls += 1;
      if (options.lstatGate && lstatCalls === 1) {
        if (options.lstatStarted) options.lstatStarted.resolve();
        await options.lstatGate.promise;
      }
      return stat;
    },
    async open() {
      return {
        async stat() {
          handleStatCalls += 1;
          return options.finalStat && handleStatCalls > 1 ? options.finalStat : stat;
        },
        read(buffer, offset, length) {
          const gate = deferred();
          pendingReads.push({
            resolve() {
              buffer.fill(7, offset, offset + length);
              gate.resolve({ bytesRead: length, buffer });
            }
          });
          return gate.promise;
        },
        async close() {
          if (options.closeStarted) options.closeStarted.resolve();
          if (options.closeGate) await options.closeGate.promise;
        }
      };
    }
  };
  const broker = createPluginDocumentBroker({
    fileSystem,
    authorize: options.authorize || (async () => ({ id: 'acme.preview.viewer' })),
    getWorkspaceIdentity: () => ({ workspaceIdentity: 1 }),
    resolveWorkspaceFile: options.resolveWorkspaceFile || ((filePath) => ({ filePath, workspaceIdentity: 1 }))
  });
  const sender = { id: 41, once() {} };
  const event = { sender };
  return { broker, event, pendingReads };
}

async function waitForReads(pendingReads, expected) {
  for (let attempt = 0; attempt < 40 && pendingReads.length < expected; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pendingReads.length, expected);
}

async function openDocument(harness, suffix = 'sample.bin') {
  return harness.broker.open(harness.event, {
    pluginId: 'acme.preview',
    viewerId: 'acme.preview.viewer',
    filePath: 'C:\\workspace\\' + suffix
  });
}

function readDocument(harness, documentId) {
  return harness.broker.read(harness.event, { documentId, offset: 0, length: 1 });
}

test('document broker bounds reads per session and restores capacity after settlement', async () => {
  const harness = createHarness();
  const opened = await openDocument(harness);
  const reads = Array.from({ length: MAX_DOCUMENT_SESSION_READS }, () => (
    readDocument(harness, opened.documentId)
  ));
  await waitForReads(harness.pendingReads, MAX_DOCUMENT_SESSION_READS);

  await assert.rejects(
    () => readDocument(harness, opened.documentId),
    { code: 'DOCUMENT_VIEW_BUSY' }
  );
  assert.equal(harness.pendingReads.length, MAX_DOCUMENT_SESSION_READS);

  harness.pendingReads[0].resolve();
  assert.deepEqual([...((await reads[0]).data)], [7]);
  const recovered = readDocument(harness, opened.documentId);
  await waitForReads(harness.pendingReads, MAX_DOCUMENT_SESSION_READS + 1);

  for (const pending of harness.pendingReads.slice(1)) pending.resolve();
  await Promise.all([...reads.slice(1), recovered]);
  harness.broker.dispose();
});

test('document broker bounds aggregate reads from one renderer sender', async () => {
  const harness = createHarness();
  const sessionCount = MAX_DOCUMENT_SENDER_READS / MAX_DOCUMENT_SESSION_READS;
  assert.equal(Number.isInteger(sessionCount), true);
  const sessions = await Promise.all(Array.from({ length: sessionCount + 1 }, (_, index) => (
    openDocument(harness, 'sample-' + index + '.bin')
  )));
  const reads = [];
  for (const session of sessions.slice(0, sessionCount)) {
    for (let index = 0; index < MAX_DOCUMENT_SESSION_READS; index += 1) {
      reads.push(readDocument(harness, session.documentId));
    }
  }
  await waitForReads(harness.pendingReads, MAX_DOCUMENT_SENDER_READS);

  await assert.rejects(
    () => readDocument(harness, sessions.at(-1).documentId),
    { code: 'DOCUMENT_VIEW_BUSY' }
  );

  harness.pendingReads[0].resolve();
  await reads[0];
  const recovered = readDocument(harness, sessions.at(-1).documentId);
  await waitForReads(harness.pendingReads, MAX_DOCUMENT_SENDER_READS + 1);
  for (const pending of harness.pendingReads.slice(1)) pending.resolve();
  await Promise.all([...reads.slice(1), recovered]);
  harness.broker.dispose();
});

test('document broker does not return a chunk after its handle is revoked', async () => {
  const closeStarted = deferred();
  const closeGate = deferred();
  const harness = createHarness({ closeStarted, closeGate });
  const opened = await openDocument(harness);
  const reading = readDocument(harness, opened.documentId);
  await waitForReads(harness.pendingReads, 1);
  harness.pendingReads[0].resolve();
  await closeStarted.promise;
  assert.deepEqual(
    harness.broker.close(harness.event, { documentId: opened.documentId }),
    { closed: true }
  );
  closeGate.resolve();
  await assert.rejects(reading, { code: 'DOCUMENT_VIEW_STALE' });
  harness.broker.dispose();
});

test('document broker rejects a file changed on the same inode during a read', async () => {
  const harness = createHarness({ finalStat: fakeStat({ mtimeMs: 2_000, ctimeMs: 2_000 }) });
  const opened = await openDocument(harness);
  const reading = readDocument(harness, opened.documentId);
  await waitForReads(harness.pendingReads, 1);
  harness.pendingReads[0].resolve();
  await assert.rejects(reading, { code: 'DOCUMENT_VIEW_CHANGED' });
  harness.broker.dispose();
});

test('document broker maps workspace resolver failures without leaking paths', async () => {
  let resolutions = 0;
  const harness = createHarness({
    resolveWorkspaceFile(filePath) {
      resolutions += 1;
      if (resolutions > 1) throw new Error('ENOENT: C:\\private\\workspace\\secret.bin');
      return { filePath, workspaceIdentity: 1 };
    }
  });
  const opened = await openDocument(harness);
  await assert.rejects(
    () => readDocument(harness, opened.documentId),
    (error) => {
      assert.equal(error.code, 'DOCUMENT_VIEW_NOT_FOUND');
      assert.equal(error.message.includes('C:\\private'), false);
      return true;
    }
  );
  harness.broker.dispose();
});

test('document broker cannot publish an open handle after lifecycle revocation', async () => {
  const actions = [
    (harness) => harness.broker.closeSender(harness.event.sender.id),
    (harness) => harness.broker.closePlugin('acme.preview'),
    (harness) => harness.broker.dispose()
  ];
  for (const revoke of actions) {
    const lstatStarted = deferred();
    const lstatGate = deferred();
    const harness = createHarness({ lstatStarted, lstatGate });
    const opening = openDocument(harness);
    await lstatStarted.promise;
    revoke(harness);
    lstatGate.resolve();
    await assert.rejects(opening, { code: 'DOCUMENT_VIEW_STALE' });
    harness.broker.dispose();
  }
});

test('an EOF read cannot succeed after revocation during authorization', async () => {
  const authorizationStarted = deferred();
  const authorizationGate = deferred();
  let authorizationCalls = 0;
  const harness = createHarness({
    authorize() {
      authorizationCalls += 1;
      if (authorizationCalls === 3) {
        authorizationStarted.resolve();
        return authorizationGate.promise;
      }
      return Promise.resolve({ id: 'acme.preview.viewer' });
    }
  });
  const opened = await openDocument(harness);
  const reading = harness.broker.read(harness.event, {
    documentId: opened.documentId,
    offset: 8,
    length: 1
  });
  await authorizationStarted.promise;
  assert.deepEqual(harness.broker.close(harness.event, { documentId: opened.documentId }), { closed: true });
  authorizationGate.resolve({ id: 'acme.preview.viewer' });
  await assert.rejects(reading, { code: 'DOCUMENT_VIEW_STALE' });
  harness.broker.dispose();
});

test('an authorization denial permanently revokes the document handle', async () => {
  let authorized = true;
  const harness = createHarness({
    authorize() {
      if (!authorized) {
        const error = new Error('Document access was revoked.');
        error.code = 'plugins.documentView.permission';
        throw error;
      }
      return { id: 'acme.preview.viewer' };
    }
  });
  const opened = await openDocument(harness);

  authorized = false;
  await assert.rejects(
    () => readDocument(harness, opened.documentId),
    { code: 'plugins.documentView.permission' }
  );

  authorized = true;
  await assert.rejects(
    () => readDocument(harness, opened.documentId),
    { code: 'DOCUMENT_VIEW_NOT_FOUND' }
  );
  harness.broker.dispose();
});
