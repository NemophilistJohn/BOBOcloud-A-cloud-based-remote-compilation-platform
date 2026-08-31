'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { authStorageKey } = require('../main/server-identity');
const {
  MAX_SERVER_RESPONSE_BYTES,
  MAX_REMOTE_GRANTS_PER_SENDER,
  createRcloneService,
  readBoundedResponse
} = require('../main/rclone-service');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(value); }
  };
}

test('server preparation responses are bounded before full-body allocation', async () => {
  let textRead = false;
  await assert.rejects(readBoundedResponse({
    headers: { get: () => String(MAX_SERVER_RESPONSE_BYTES + 1) },
    async text() { textRead = true; return ''; }
  }, MAX_SERVER_RESPONSE_BYTES), /exceeded/);
  assert.equal(textRead, false, 'oversized Content-Length must be rejected before response.text()');

  let cancelled = false;
  const chunks = [Buffer.alloc(MAX_SERVER_RESPONSE_BYTES), Buffer.from('x')];
  await assert.rejects(readBoundedResponse({
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() { return chunks.length ? { done: false, value: chunks.shift() } : { done: true }; },
          async cancel() { cancelled = true; },
          releaseLock() {}
        };
      }
    }
  }, MAX_SERVER_RESPONSE_BYTES), /exceeded/);
  assert.equal(cancelled, true, 'stream reader must be cancelled at the byte limit');
});

function createFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'rclone', 'rclone.conf');
  const calls = { configure: [], validate: [], fetch: [], sync: [], pull: [] };
  let serverSettings = {
    ip: 'compiler-a.test', user: 'root', pass: 'ssh-secret',
    httpPort: 3100, apiKey: ''
  };
  let credential = {
    token: 'session-a', expiresAt: Date.now() + 60_000,
    user: { id: 'account-a' }
  };
  let revision = 'bundled:1';
  let selectionEpoch = 1;
  let id = 0;
  const binaryManager = {
    paths: { config: configPath },
    async getExecutionDescriptor() {
      return { path: 'C:\\app\\rclone.exe', source: 'bundled', revision, selectionEpoch };
    },
    isSelectionCurrent(descriptor) { return descriptor.selectionEpoch === selectionEpoch; },
    async listCandidates(senderId) { return { scanId: 'scan-' + senderId, candidates: [] }; },
    async getSelection() { return { source: 'bundled' }; },
    async checkActiveVersion() { return { available: true, source: 'bundled', version: 'rclone v1' }; },
    async selectCandidate(_senderId, _payload, confirm) {
      await confirm({ path: 'C:\\system\\rclone.exe' });
      revision = 'external:2';
      selectionEpoch += 1;
      return { cancelled: false, selection: { source: 'system' } };
    }
  };
  const rclone = {
    async ensureConfig(value, executablePath, suppliedConfigPath) {
      calls.configure.push({ settings: Object.assign({}, value), executablePath, configPath: suppliedConfigPath });
      fs.mkdirSync(path.dirname(suppliedConfigPath), { recursive: true });
      fs.writeFileSync(suppliedConfigPath, value.ip + ':' + value.user + ':' + revision, 'utf8');
      return { success: true };
    },
    async sync(payload) {
      calls.sync.push(payload);
      return overrides.sync ? overrides.sync(payload) : { success: true, stats: { durationMs: 1 } };
    },
    async pull(payload) {
      calls.pull.push(payload);
      return overrides.pull ? overrides.pull(payload) : { success: true, stats: { durationMs: 1 } };
    },
    async checkConnection(payload) {
      calls.validate.push(payload);
      return overrides.checkConnection ? overrides.checkConnection(payload) : { success: true };
    }
  };
  const settings = {
    async readServerSettings() { return Object.assign({}, serverSettings); },
    readAuth() {
      return { servers: { [authStorageKey(serverSettings)]: credential } };
    }
  };
  const fetch = async (url, request) => {
    const payload = JSON.parse(request.body);
    calls.fetch.push({ url, request, payload });
    if (overrides.fetch) return overrides.fetch(url, request, payload);
    if (payload.action === 'checkFolder') {
      return response({ success: true, folderPath: '/srv/accounts/account-a/workspaces/' + payload.folderKey });
    }
    if (payload.action === 'prepareTeamProject') {
      return response({ success: true, data: { remote_path: '/srv/teams/team-1/project-1/account-a/main', head: 'abc' } });
    }
    return response({ success: false, error: 'unexpected action' }, 400);
  };
  const service = createRcloneService({
    rclone,
    binaryManager,
    settings,
    fetch,
    privateConfigRoot: path.join(root, 'private-rclone'),
    randomId: () => 'id-' + (++id)
  });
  return {
    calls,
    service,
    binaryManager,
    get settings() { return serverSettings; },
    setSettings(value) { serverSettings = Object.assign({}, value); },
    setCredential(value) { credential = value; },
    changeSelection() { selectionEpoch += 1; revision = 'bundled:' + selectionEpoch; }
  };
}

async function prepareWorkspace(fixture, values = {}) {
  return fixture.service.prepareRemote({
    senderId: values.senderId || 7,
    operationId: values.operationId || 'prepare-1',
    kind: 'workspace',
    request: { folderName: 'Workspace', folderKey: 'p123', totalSize: 42 },
    bindingKey: values.bindingKey || 'workspace-binding',
    isCurrent: values.isCurrent || (() => true)
  });
}

test('main prepares an authenticated remote grant and keeps the remote path out of renderer results', async (t) => {
  const fixture = createFixture(t);
  const prepared = await prepareWorkspace(fixture);
  assert.equal(prepared.success, true);
  assert.ok(prepared.remoteGrantId);
  assert.equal(Object.hasOwn(prepared, 'folderPath'), false);
  assert.equal(fixture.calls.fetch.length, 1);
  assert.equal(fixture.calls.fetch[0].url, 'http://compiler-a.test:3100');
  assert.equal(fixture.calls.fetch[0].request.headers.Authorization, 'Bearer session-a');
  assert.deepEqual(fixture.calls.fetch[0].payload, {
    action: 'checkFolder',
    folderName: 'Workspace',
    folderKey: 'p123',
    totalSize: 42
  });

  let configObservedDuringRun = '';
  const originalSync = fixture.calls.sync;
  const result = await fixture.service.sync({
    senderId: 7,
    operationId: 'sync-1',
    remoteGrantId: prepared.remoteGrantId,
    localPath: 'C:\\workspace',
    bindingKey: 'workspace-binding',
    isCurrent: () => true
  });
  assert.equal(result.success, true);
  assert.equal(originalSync.length, 1);
  const payload = originalSync[0];
  configObservedDuringRun = fs.readFileSync(fixture.calls.configure[0].configPath, 'utf8');
  assert.equal(payload.remotePath, '/srv/accounts/account-a/workspaces/p123');
  assert.notEqual(payload.configPath, fixture.calls.configure[0].configPath);
  assert.equal(fs.existsSync(payload.configPath), false, 'operation-private config must be removed after exit');
  assert.match(configObservedDuringRun, /^compiler-a\.test:root:/);
  assert.equal(Object.hasOwn(payload, 'rclonePath'), false);
});

test('workspace measurement is tracked and cancelled with its rclone preparation operation', async (t) => {
  const fixture = createFixture(t);
  const entered = deferred();
  const preparing = fixture.service.prepareRemote({
    senderId: 7,
    operationId: 'prepare-measurement',
    kind: 'workspace',
    request: { folderName: 'Workspace', folderKey: 'p123' },
    bindingKey: 'workspace-binding',
    isCurrent: () => true,
    measure(signal) {
      entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('measurement cancelled');
        error.code = 'WORKSPACE_SCAN_CANCELLED';
        reject(error);
      }, { once: true }));
    }
  });
  await entered.promise;
  const cancelled = await fixture.service.cancelAll('workspace-change');
  assert.equal(cancelled.cancelled, 1);
  const result = await preparing;
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'WORKSPACE_SCAN_CANCELLED');
  assert.equal(fixture.calls.fetch.length, 0);
});

test('remote grants are sender-bound, binding-bound, and single use', async (t) => {
  const fixture = createFixture(t);
  const wrongSenderGrant = await prepareWorkspace(fixture, { operationId: 'prepare-sender' });
  const wrongSender = await fixture.service.sync({
    senderId: 8, operationId: 'sync-wrong-sender', remoteGrantId: wrongSenderGrant.remoteGrantId,
    localPath: 'C:\\workspace', bindingKey: 'workspace-binding', isCurrent: () => true
  });
  assert.equal(wrongSender.success, false);
  assert.equal(wrongSender.error.type, 'OPERATION_REJECTED');

  const wrongBinding = await fixture.service.sync({
    senderId: 7, operationId: 'sync-wrong-binding', remoteGrantId: wrongSenderGrant.remoteGrantId,
    localPath: 'C:\\workspace', bindingKey: 'different-binding', isCurrent: () => true
  });
  assert.equal(wrongBinding.success, false);
  assert.equal(wrongBinding.error.type, 'OPERATION_REJECTED');

  const replay = await fixture.service.sync({
    senderId: 7, operationId: 'sync-replay', remoteGrantId: wrongSenderGrant.remoteGrantId,
    localPath: 'C:\\workspace', bindingKey: 'workspace-binding', isCurrent: () => true
  });
  assert.equal(replay.success, false);
  assert.match(replay.error.message, /missing or expired/);
  assert.equal(fixture.calls.sync.length, 0);
});

test('unused remote grants are bounded per renderer sender', async (t) => {
  const fixture = createFixture(t);
  const grants = [];
  for (let index = 0; index <= MAX_REMOTE_GRANTS_PER_SENDER; index += 1) {
    grants.push(await prepareWorkspace(fixture, { operationId: 'prepare-cap-' + index }));
  }
  const oldest = await fixture.service.sync({
    senderId: 7, operationId: 'sync-evicted', remoteGrantId: grants[0].remoteGrantId,
    localPath: 'C:\\workspace', bindingKey: 'workspace-binding', isCurrent: () => true
  });
  assert.equal(oldest.success, false);
  assert.match(oldest.error.message, /missing or expired/);
});

test('team preparation strips the server path and binds the pull to the mapped directory', async (t) => {
  const fixture = createFixture(t);
  const prepared = await fixture.service.prepareRemote({
    senderId: 7,
    operationId: 'prepare-team',
    kind: 'team-pull',
    request: { teamId: 'team-1', projectId: 'project-1', branch: 'main', reset: true },
    bindingKey: 'mapping-grant',
    isCurrent: () => true
  });
  assert.equal(prepared.success, true);
  assert.equal(prepared.data.remote_path, undefined);
  assert.equal(prepared.data.head, 'abc');
  const pulled = await fixture.service.pull({
    senderId: 7,
    operationId: 'pull-team',
    remoteGrantId: prepared.remoteGrantId,
    localPath: 'C:\\team-mapping',
    bindingKey: 'mapping-grant',
    isCurrent: () => true
  });
  assert.equal(pulled.success, true);
  assert.equal(fixture.calls.pull[0].remotePath, '/srv/teams/team-1/project-1/account-a/main');
  assert.equal(fixture.calls.pull[0].dest, 'C:\\team-mapping');
});

test('context cancellation aborts and awaits an active rclone process before returning', async (t) => {
  const entered = deferred();
  let exited = false;
  const fixture = createFixture(t, {
    sync(payload) {
      entered.resolve();
      return new Promise((resolve) => {
        payload.signal.addEventListener('abort', () => {
          setImmediate(() => {
            exited = true;
            resolve({ success: false, error: { type: 'CANCELLED', message: 'cancelled' }, stats: { durationMs: 1 } });
          });
        }, { once: true });
      });
    }
  });
  const prepared = await prepareWorkspace(fixture);
  const syncing = fixture.service.sync({
    senderId: 7, operationId: 'sync-active', remoteGrantId: prepared.remoteGrantId,
    localPath: 'C:\\workspace', bindingKey: 'workspace-binding', isCurrent: () => true
  });
  await entered.promise;
  const cancelled = await fixture.service.cancelAll('server-change');
  assert.equal(cancelled.cancelled, 1);
  assert.equal(exited, true, 'cancelAll must wait for process close, not only send AbortSignal');
  const result = await syncing;
  assert.equal(result.success, false);
  assert.equal(result.error.type, 'STALE_CONTEXT');
});

test('reconfiguring the server cancels the old operation before publishing the new config', async (t) => {
  const entered = deferred();
  let oldConfig = '';
  let aborted = false;
  const fixture = createFixture(t, {
    sync(payload) {
      oldConfig = fs.readFileSync(payload.configPath, 'utf8');
      entered.resolve();
      return new Promise((resolve) => payload.signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ success: false, error: { type: 'CANCELLED', message: 'cancelled' }, stats: { durationMs: 1 } });
      }, { once: true }));
    }
  });
  const prepared = await prepareWorkspace(fixture);
  const syncing = fixture.service.sync({
    senderId: 7, operationId: 'sync-old-server', remoteGrantId: prepared.remoteGrantId,
    localPath: 'C:\\workspace', bindingKey: 'workspace-binding', isCurrent: () => true
  });
  await entered.promise;
  fixture.setSettings({ ip: 'compiler-b.test', user: 'deploy', pass: 'new-secret', httpPort: 4100, apiKey: 'api-b' });
  fixture.setCredential(null);
  await fixture.service.reconfigure(fixture.settings, 'server-change');
  assert.equal(aborted, true);
  assert.match(oldConfig, /^compiler-a\.test:root:/);
  assert.match(fs.readFileSync(fixture.calls.configure.at(-1).configPath, 'utf8'), /^compiler-b\.test:deploy:/);
  const result = await syncing;
  assert.equal(result.error.type, 'STALE_CONTEXT');
});

test('server changes create a new immutable config and cannot retarget an old operation', async (t) => {
  const fixture = createFixture(t);
  await fixture.service.ensureConfigured(fixture.settings);
  const firstPath = fixture.calls.configure[0].configPath;
  assert.match(fs.readFileSync(firstPath, 'utf8'), /^compiler-a\.test:/);

  fixture.setSettings({
    ip: 'compiler-b.test', user: 'deploy', pass: 'new-secret', httpPort: 4100, apiKey: 'api-b'
  });
  fixture.setCredential(null);
  await fixture.service.reconfigure(fixture.settings, 'server-change');
  const secondPath = fixture.calls.configure.at(-1).configPath;
  assert.notEqual(secondPath, firstPath);
  assert.match(fs.readFileSync(secondPath, 'utf8'), /^compiler-b\.test:deploy:/);
  assert.match(fs.readFileSync(firstPath, 'utf8'), /^compiler-a\.test:root:/);
});

test('changing the selected binary cancels grants and rebuilds configuration', async (t) => {
  const fixture = createFixture(t);
  const staleGrant = await prepareWorkspace(fixture);
  await fixture.service.ensureConfigured(fixture.settings);
  await fixture.service.selectBinary(7, { scanId: 'scan', candidateId: 'candidate' }, async () => true);
  assert.equal(fixture.calls.configure.length, 2);
  const stale = await fixture.service.sync({
    senderId: 7, operationId: 'sync-stale-selection', remoteGrantId: staleGrant.remoteGrantId,
    localPath: 'C:\\workspace', bindingKey: 'workspace-binding', isCurrent: () => true
  });
  assert.equal(stale.success, false);
  assert.match(stale.error.message, /missing or expired/);
});

test('selecting a binary without a server defers SFTP configuration', async (t) => {
  const fixture = createFixture(t);
  fixture.setSettings({ ip: '', user: '', pass: '' });
  const result = await fixture.service.selectBinary(7, { scanId: 'scan', candidateId: 'candidate' }, async () => true);
  assert.equal(result.cancelled, false);
  assert.equal(result.configurationError, undefined);
  assert.equal(fixture.calls.configure.length, 0);
});

test('connection validation is main-owned and uses the current immutable configuration', async (t) => {
  const fixture = createFixture(t);
  const result = await fixture.service.validateConnection(7);
  assert.equal(result.success, true);
  assert.equal(fixture.calls.validate.length, 1);
  assert.equal(fixture.calls.validate[0].executablePath, 'C:\\app\\rclone.exe');
  assert.match(fs.readFileSync(fixture.calls.validate[0].configPath, 'utf8'), /^compiler-a\.test:root:/);
});

test('expired credentials fall back to API-key identity and API-key rotation revokes old grants', async (t) => {
  const fixture = createFixture(t);
  fixture.setCredential({
    token: 'expired-session', expiresAt: Date.now() - 1000,
    user: { id: 'stale-account' }
  });
  fixture.setSettings(Object.assign({}, fixture.settings, { apiKey: 'api-one' }));
  const prepared = await prepareWorkspace(fixture, { operationId: 'prepare-api-one' });
  assert.equal(prepared.success, true);
  assert.equal(fixture.calls.fetch[0].request.headers.Authorization, 'Bearer api-one');

  fixture.setSettings(Object.assign({}, fixture.settings, { apiKey: 'api-two' }));
  await fixture.service.reconfigure(fixture.settings, 'api-key-rotated');
  const stale = await fixture.service.sync({
    senderId: 7,
    operationId: 'sync-old-api-key',
    remoteGrantId: prepared.remoteGrantId,
    localPath: 'C:\\workspace',
    bindingKey: 'workspace-binding',
    isCurrent: () => true
  });
  assert.equal(stale.success, false);
  assert.match(stale.error.message, /missing or expired/);
});
