'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadCollaboration(options) {
  options = options || {};
  let source = fs.readFileSync(path.join(projectRoot, 'src/collaboration.js'), 'utf8');
  const exportMarker = 'BOBO.collaboration = { init:init';
  assert.ok(source.includes(exportMarker), 'collaboration export marker should remain available');
  source = source.replace(exportMarker,
    'BOBO.__collaborationTest = {' +
      'api:api,' +
      'renewOpenFileLocks:renewOpenFileLocks,' +
      'expireLocalLeases:expireLocalLeases,' +
      'releaseHeldFileLocks:releaseHeldFileLocks,' +
      'heldFileLocks:heldFileLocks,' +
      'blockedFileLocks:blockedFileLocks,' +
      'fileLockRequests:fileLockRequests,' +
      'setCollaborationReadOnly:setCollaborationReadOnly' +
    '};\n\t' + exportMarker);

  const state = Object.assign({
    workspaceRoot: 'C:\\workspace',
    tabs: [],
    auth: { token: 'session-token', user: { id: 'user-1' } },
    collaboration: { current: null }
  }, options.state || {});
  const calls = [];
  const BOBO = {
    state,
    sendToServer(action, data, requestOptions) {
      calls.push({ action, data: clone(data), options: clone(requestOptions) });
      if (options.sendToServer) return options.sendToServer(action, data, requestOptions);
      return Promise.resolve({ success: true, data: {} });
    }
  };
  const windowObject = {
    BOBO,
    addEventListener() {}
  };
  const document = {
    hidden: false,
    hasFocus() { return true; },
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; }
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document,
    navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {}
  }, { filename: 'src/collaboration.js' });

  return { BOBO, state, calls, internals: BOBO.__collaborationTest };
}

function loadServerComm(responsePayload) {
  const source = fs.readFileSync(path.join(projectRoot, 'src/server-comm.js'), 'utf8');
  const requests = [];
  const BOBO = {
    state: {
      serverSettings: { ip: 'compiler.example', apiKey: '' },
      auth: { token: 'session-token' }
    }
  };
  const windowObject = { BOBO };
  vm.runInNewContext(source, {
    window: windowObject,
    document: {
      getElementById() { return null; },
      createDocumentFragment() { return { appendChild() {} }; },
      createElement() { return { appendChild() {} }; },
      createTextNode(value) { return { textContent: String(value) }; }
    },
    fetch(url, request) {
      requests.push({ url, request });
      return Promise.resolve({
        ok: false,
        status: 409,
        json() { return Promise.resolve(responsePayload); }
      });
    },
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout
  }, { filename: 'src/server-comm.js' });
  return { BOBO, requests };
}

test('collaboration maps structured and legacy push conflicts to a human message', async () => {
  const structuredDetails = { branch: 'main', commit: 'abc123' };
  const loaded = loadCollaboration({
    sendToServer() {
      return Promise.resolve({
        success: false,
        error: 'git command failed',
        errorCode: 'push_conflict',
        details: structuredDetails,
        status: 409
      });
    }
  });

  await assert.rejects(
    loaded.internals.api('commitTeamChanges', {}),
    (error) => {
      assert.equal(error.code, 'push_conflict');
      assert.equal(error.status, 409);
      assert.deepEqual(clone(error.details), structuredDetails);
      assert.equal(error.rawMessage, 'git command failed');
      assert.equal(error.message,
        'Another teammate updated this branch while your commit was being published. ' +
        'Your cloud commit is still saved. Wait a moment, then choose Commit & push again.');
      return true;
    }
  );

  loaded.BOBO.sendToServer = function() {
    return Promise.resolve({
      success: false,
      error: 'git push was rejected: non-fast-forward update'
    });
  };
  await assert.rejects(
    loaded.internals.api('commitTeamChanges', {}),
    (error) => {
      assert.equal(error.code, 'push_conflict');
      assert.equal(error.rawMessage, 'git push was rejected: non-fast-forward update');
      assert.match(error.message, /Another teammate updated this branch/);
      assert.doesNotMatch(error.message, /non-fast-forward/i);
      return true;
    }
  );
});

test('lock renewal covers the active and dirty team tabs but skips clean background tabs', async () => {
  const current = { teamId: 'team-1', projectId: 'project-1', branch: 'main' };
  const loaded = loadCollaboration({
    state: {
      workspaceRoot: 'C:\\workspace',
      activeTabPath: 'C:\\workspace\\src\\active.js',
      tabs: [
        { path: 'C:\\workspace\\src\\active.js' },
        { path: 'C:\\workspace\\src\\dirty-background.js', dirty: true },
        { path: 'C:\\workspace\\src\\clean-background.js', dirty: false },
        { path: 'D:\\other\\outside.js' },
        { path: null }
      ],
      auth: { token: 'session-token', user: { id: 'user-1' } },
      collaboration: { current }
    }
  });

  await loaded.internals.renewOpenFileLocks();

  const acquisitions = loaded.calls.filter((entry) => entry.action === 'acquireTeamFileLock');
  assert.deepEqual(acquisitions.map((entry) => entry.data.filePath).sort(), [
    'src/active.js',
    'src/dirty-background.js'
  ]);
  for (const entry of acquisitions) {
    assert.deepEqual(entry.data, {
      teamId: 'team-1',
      projectId: 'project-1',
      branch: 'main',
      filePath: entry.data.filePath,
      ttlMinutes: 2
    });
    assert.deepEqual(entry.options, { quiet: true });
  }
});

test('activating another tab releases a clean background lock but retains a dirty one', async () => {
  const current = { teamId: 'team-1', projectId: 'project-1', branch: 'main' };
  const loaded = loadCollaboration({
    state: {
      workspaceRoot: 'C:\\workspace',
      activeTabPath: 'C:\\workspace\\src\\next.js',
      tabs: [
        { path: 'C:\\workspace\\src\\clean.js', dirty: false },
        { path: 'C:\\workspace\\src\\dirty.js', dirty: true },
        { path: 'C:\\workspace\\src\\next.js', dirty: false }
      ],
      auth: { token: 'session-token', user: { id: 'user-1' } },
      collaboration: { current }
    }
  });
  loaded.internals.heldFileLocks['c:/workspace/src/clean.js'] = {
    filePath: 'C:\\workspace\\src\\clean.js', teamId: 'team-1', projectId: 'project-1', branch: 'main', path: 'src/clean.js', leaseId: 'lease-clean'
  };
  loaded.internals.heldFileLocks['c:/workspace/src/dirty.js'] = {
    filePath: 'C:\\workspace\\src\\dirty.js', teamId: 'team-1', projectId: 'project-1', branch: 'main', path: 'src/dirty.js', leaseId: 'lease-dirty'
  };

  loaded.BOBO.collaboration.onFileActivated('C:\\workspace\\src\\next.js');
  await Promise.resolve();

  const releases = loaded.calls.filter((entry) => entry.action === 'releaseTeamFileLock');
  assert.deepEqual(releases.map((entry) => entry.data.filePath), ['src/clean.js']);
  assert.ok(loaded.internals.heldFileLocks['c:/workspace/src/dirty.js']);
  assert.equal(loaded.internals.heldFileLocks['c:/workspace/src/clean.js'], undefined);
});

test('held locks release only for their recorded project and original context', async () => {
  const projectA = { teamId: 'team-a', projectId: 'project-a', branch: 'main' };
  const projectB = { teamId: 'team-b', projectId: 'project-b', branch: 'feature' };
  const loaded = loadCollaboration({
    state: {
      workspaceRoot: 'C:\\workspace',
      tabs: [],
      auth: { token: 'session-token', user: { id: 'user-1' } },
      collaboration: { current: projectA }
    }
  });

  await loaded.BOBO.collaboration.onFileOpened('C:\\workspace\\src\\alpha.js');
  loaded.state.collaboration.current = projectB;
  await loaded.BOBO.collaboration.onFileOpened('C:\\workspace\\src\\beta.js');
  loaded.state.collaboration.current = { teamId: 'team-c', projectId: 'project-c', branch: 'later' };

  loaded.internals.releaseHeldFileLocks(projectA);
  await Promise.resolve();

  let releases = loaded.calls.filter((entry) => entry.action === 'releaseTeamFileLock');
  assert.deepEqual(releases.map((entry) => entry.data), [{
    teamId: 'team-a',
    projectId: 'project-a',
    branch: 'main',
    filePath: 'src/alpha.js'
  }]);
  assert.deepEqual(Object.keys(loaded.internals.heldFileLocks), [
    'c:/workspace/src/beta.js'
  ]);

  await loaded.BOBO.collaboration.onFileClosed('c:\\WORKSPACE\\src\\BETA.js');
  releases = loaded.calls.filter((entry) => entry.action === 'releaseTeamFileLock');
  assert.deepEqual(releases[1].data, {
    teamId: 'team-b',
    projectId: 'project-b',
    branch: 'feature',
    filePath: 'src/beta.js'
  });
  assert.deepEqual(Object.keys(loaded.internals.heldFileLocks), []);
});

test('lock renewals and releases carry the lease returned by the server', async () => {
  let acquireCount = 0;
  const loaded = loadCollaboration({
    state: {
      workspaceRoot: 'C:\\workspace',
      activeTabPath: 'C:\\workspace\\src\\leased.js',
      tabs: [{ path: 'C:\\workspace\\src\\leased.js' }],
      auth: { token: 'session-token', user: { id: 'user-1' } },
      collaboration: { current: { teamId: 'team-1', projectId: 'project-1', branch: 'main' } }
    },
    sendToServer(action) {
      if (action === 'acquireTeamFileLock') {
        acquireCount += 1;
        return Promise.resolve({ success: true, data: { lease_id: 'lease-current' } });
      }
      return Promise.resolve({ success: true, data: {} });
    }
  });

  await loaded.BOBO.collaboration.onFileOpened('C:\\workspace\\src\\leased.js');
  await loaded.internals.renewOpenFileLocks();
  await loaded.BOBO.collaboration.onFileClosed('C:\\workspace\\src\\leased.js');

  assert.equal(acquireCount, 2);
  const acquisitions = loaded.calls.filter((entry) => entry.action === 'acquireTeamFileLock');
  assert.equal(acquisitions[0].data.lockLeaseId, undefined);
  assert.equal(acquisitions[1].data.lockLeaseId, 'lease-current');
  const release = loaded.calls.find((entry) => entry.action === 'releaseTeamFileLock');
  assert.equal(release.data.lockLeaseId, 'lease-current');
});

test('failed lock renewal clears ownership and records a read-only retry state', async () => {
  let acquireCount = 0;
  const loaded = loadCollaboration({
    state: {
      workspaceRoot: 'C:\\workspace',
      activeTabPath: 'C:\\workspace\\src\\leased.js',
      tabs: [{ path: 'C:\\workspace\\src\\leased.js' }],
      auth: { token: 'session-token', user: { id: 'user-1' } },
      collaboration: { current: { teamId: 'team-1', projectId: 'project-1', branch: 'main' } }
    },
    sendToServer(action) {
      if (action !== 'acquireTeamFileLock') return Promise.resolve({ success: true, data: {} });
      acquireCount += 1;
      if (acquireCount === 1) return Promise.resolve({ success: true, data: { lease_id: 'lease-current', expires_at: new Date(Date.now() + 120000).toISOString() } });
      return Promise.resolve({ success: false, error: 'offline' });
    }
  });

  await loaded.BOBO.collaboration.onFileOpened('C:\\workspace\\src\\leased.js');
  await loaded.internals.renewOpenFileLocks();

  assert.deepEqual(Object.keys(loaded.internals.heldFileLocks), []);
  assert.deepEqual(Object.keys(loaded.internals.blockedFileLocks), ['c:/workspace/src/leased.js']);
});

test('collaboration read-only applies to the main editor and editable split pane', () => {
  function editor() {
    return { readOnly: false, updateOptions(options) { this.readOnly = options.readOnly === true; } };
  }
  const main = editor();
  const splitLeft = editor();
  const splitRight = editor();
  splitLeft.rightEditor = splitRight;
  const loaded = loadCollaboration({ state: { editor: main, splitEditor: splitLeft, workspaceTransitionLocked: false } });

  loaded.internals.setCollaborationReadOnly(true);
  assert.equal(main.readOnly, true);
  assert.equal(splitLeft.readOnly, true);
  assert.equal(splitRight.readOnly, true);

  loaded.internals.setCollaborationReadOnly(false);
  assert.equal(main.readOnly, false);
  assert.equal(splitLeft.readOnly, true);
  assert.equal(splitRight.readOnly, false);
});

test('closing during acquisition releases the late lease instead of retaining it', async () => {
  let resolveAcquire;
  const acquire = new Promise((resolve) => { resolveAcquire = resolve; });
  const loaded = loadCollaboration({
    state: {
      workspaceRoot: 'C:\\workspace',
      activeTabPath: 'C:\\workspace\\src\\late.js',
      tabs: [{ path: 'C:\\workspace\\src\\late.js' }],
      auth: { token: 'session-token', user: { id: 'user-1' } },
      collaboration: { current: { teamId: 'team-1', projectId: 'project-1', branch: 'main' } }
    },
    sendToServer(action) {
      if (action === 'acquireTeamFileLock') return acquire;
      return Promise.resolve({ success: true, data: {} });
    }
  });

  const opening = loaded.BOBO.collaboration.onFileOpened('C:\\workspace\\src\\late.js');
  const closing = loaded.BOBO.collaboration.onFileClosed('C:\\workspace\\src\\late.js');
  resolveAcquire({ success: true, data: { lease_id: 'lease-late', expires_at: new Date(Date.now() + 120000).toISOString() } });
  await Promise.all([opening, closing]);

  assert.deepEqual(Object.keys(loaded.internals.heldFileLocks), []);
  const release = loaded.calls.find((entry) => entry.action === 'releaseTeamFileLock');
  assert.equal(release.data.lockLeaseId, 'lease-late');
});

test('server-authoritative expiry drops local edit ownership before reacquire', async () => {
  const loaded = loadCollaboration({
    state: {
      workspaceRoot: 'C:\\workspace',
      activeTabPath: 'C:\\workspace\\src\\expired.js',
      tabs: [{ path: 'C:\\workspace\\src\\expired.js' }],
      auth: { token: 'session-token', user: { id: 'user-1' } },
      collaboration: { current: { teamId: 'team-1', projectId: 'project-1', branch: 'main' } }
    }
  });
  loaded.internals.heldFileLocks['c:/workspace/src/expired.js'] = {
    filePath: 'C:\\workspace\\src\\expired.js', teamId: 'team-1', projectId: 'project-1', branch: 'main',
    path: 'src/expired.js', leaseId: 'expired-lease', expires_at: new Date(Date.now() - 1000).toISOString()
  };

  loaded.internals.expireLocalLeases();

  assert.deepEqual(Object.keys(loaded.internals.heldFileLocks), []);
  assert.equal(loaded.internals.blockedFileLocks['c:/workspace/src/expired.js'].errorCode, 'lease_expired');
});

test('quiet server errors preserve structured errorCode and details', async () => {
  const responsePayload = {
    success: false,
    error: 'push rejected',
    errorCode: 'push_conflict',
    details: { branch: 'main', aheadBy: 1 }
  };
  const loaded = loadServerComm(responsePayload);

  const result = await loaded.BOBO.sendToServer(
    'commitTeamChanges',
    { teamId: 'team-1' },
    { quiet: true }
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'push rejected');
  assert.equal(result.errorCode, 'push_conflict');
  assert.deepEqual(clone(result.details), { branch: 'main', aheadBy: 1 });
  assert.equal(result.status, 409);
  assert.equal(loaded.requests.length, 1);
  assert.deepEqual(JSON.parse(loaded.requests[0].request.body), {
    action: 'commitTeamChanges',
    teamId: 'team-1'
  });
});

test('quiet server errors localize known messages without dropping structured fields', async () => {
  const loaded = loadServerComm({
    success: false,
    error: 'Failed to delete user compile activity',
    errorCode: 'activity_delete_failed',
    details: { userId: 'user-1' }
  });
  loaded.BOBO.i18n = {
    t(key) {
      return key === 'Failed to delete user compile activity' ? '删除用户编译活跃度失败' : key;
    }
  };

  const result = await loaded.BOBO.sendToServer('deleteUser', { userId: 'user-1' }, { quiet: true });

  assert.equal(result.error, '删除用户编译活跃度失败');
  assert.equal(result.errorCode, 'activity_delete_failed');
  assert.deepEqual(clone(result.details), { userId: 'user-1' });
  assert.equal(result.status, 409);
});
