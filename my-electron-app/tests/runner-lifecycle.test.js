'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runnerSource = fs.readFileSync(path.resolve(__dirname, '../src/runner.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for runner lifecycle state');
}

function loadRunner(overrides) {
  overrides = overrides || {};
  const workspaceRoot = 'C:\\workspace';
  const elements = {
    'stop-code': { disabled: false, style: {} },
    'stdin-input-row': { style: {} }
  };
  const document = {
    getElementById(id) { return elements[id] || null; }
  };
  const state = Object.assign({
    workspaceRoot,
    workspaceIdentity: 7,
    workspaceGeneration: 3,
    runIdentityEpoch: 0,
    serverSettings: { ip: 'compiler.example', user: 'tester' },
    auth: { mode: 'single' },
    tabs: [],
    activeTabPath: null,
    activeRunContext: null,
    activeRunSocket: null,
    activeRunId: null,
    activeRunCancelled: false,
    artifactInflight: new Map(),
    setupCommands: [],
    selectedRuntime: 'node:20',
    collaboration: { current: null },
    workspaceChangeVersion: 1,
    lastSyncedVersion: 1
  }, overrides.state || {});
  const outputs = [];
  const apiCalls = [];
  const api = Object.assign({
    setArtifactRunContext(payload) {
      apiCalls.push(payload);
      return Promise.resolve(true);
    },
    saveProjectName() { return Promise.resolve(true); },
    calculateDirSize() { return Promise.resolve({ size: 0 }); },
    saveArtifact() { return Promise.resolve(true); },
    readTree() { return Promise.resolve(null); },
    readServerSettings() { return Promise.resolve(state.serverSettings); }
  }, overrides.api || {});
  const BOBO = Object.assign({
    state,
    updateRunOutput(message) { outputs.push(String(message)); },
    clearRunOutput() {},
    projectKey() { return 'workspace-key'; },
    runConfig: {
      languageForFile(filePath) {
        return /\.js$/i.test(filePath) ? 'javascript' : null;
      },
      getArgs() { return { compileArgs: [], runArgs: [] }; }
    }
  }, overrides.BOBO || {});

  let webSocketConstructions = 0;
  function FakeWebSocket(url) {
    webSocketConstructions += 1;
    this.url = url;
    this.readyState = 0;
    this.close = function() { this.readyState = 3; };
    this.send = function() {};
  }
  FakeWebSocket.OPEN = 1;

  const windowObject = { BOBO, api };
  vm.runInNewContext(runnerSource, {
    window: windowObject,
    document,
    WebSocket: FakeWebSocket,
    location: { protocol: 'http:' },
    crypto: { randomUUID: () => 'run-id-1' },
    Date,
    Map,
    Promise,
    JSON,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }, { filename: 'src/runner.js' });

  return {
    BOBO: windowObject.BOBO,
    state,
    outputs,
    apiCalls,
    webSocketConstructions: () => webSocketConstructions
  };
}

test('a sync from the previous workspace cannot swallow the new workspace sync', async () => {
  const firstSync = deferred();
  const secondSync = deferred();
  const syncCalls = [];
  const statusEvents = [];
  let statusSequence = 0;
  const fixture = loadRunner({
    state: { workspaceChangeVersion: 2, lastSyncedVersion: 1 },
    BOBO: {
      sendToServer(action) {
        if (action === 'checkFolder') return Promise.resolve({ success: true, folderPath: '/remote/workspace' });
        throw new Error('Unexpected server action: ' + action);
      },
      rclone: {
        sync(payload) {
          syncCalls.push(payload.src);
          return syncCalls.length === 1 ? firstSync.promise : secondSync.promise;
        }
      },
      workspaceSyncStatus: {
        beginSync() {
          const context = { id: ++statusSequence };
          statusEvents.push({ type: 'begin', context });
          return context;
        },
        finishSync(context, result) {
          statusEvents.push({ type: 'finish', context, result });
        }
      }
    }
  });

  const oldWorkspacePromise = fixture.BOBO.runner.manualSyncWithServer();
  await waitFor(() => syncCalls.length === 1);

  fixture.state.workspaceRoot = 'C:\\workspace-next';
  fixture.state.workspaceIdentity = 8;
  fixture.state.workspaceGeneration = 4;
  fixture.state.runIdentityEpoch = 1;
  fixture.state.workspaceChangeVersion = 1;
  fixture.state.lastSyncedVersion = -1;
  const newWorkspacePromise = fixture.BOBO.runner.syncWithServer();

  firstSync.resolve({ success: true });
  await waitFor(() => syncCalls.length === 2);
  assert.deepEqual(syncCalls, ['C:\\workspace', 'C:\\workspace-next']);

  secondSync.resolve({ success: true });
  assert.equal(await oldWorkspacePromise, false);
  assert.equal(await newWorkspacePromise, true);
  assert.deepEqual(statusEvents.map(event => event.type), ['begin', 'finish', 'begin', 'finish']);
  assert.equal(statusEvents[1].result.success, false);
  assert.equal(statusEvents[3].result.success, true);
});

test('Run on an unsupported file leaves the existing active run untouched', async () => {
  let closeCount = 0;
  const existingSocket = {
    readyState: 1,
    send() {},
    close() { closeCount += 1; }
  };
  const existingContext = {
    rootPath: 'C:\\workspace',
    workspaceIdentity: 7,
    generation: 3,
    identityEpoch: 0,
    preparation: 1,
    nonce: 9
  };
  const fixture = loadRunner({
    state: {
      tabs: [{ path: 'C:\\workspace\\notes.txt', dirty: false }],
      activeTabPath: 'C:\\workspace\\notes.txt',
      activeRunContext: existingContext,
      activeRunSocket: existingSocket,
      activeRunId: 'existing-run'
    }
  });

  fixture.BOBO.runner.runActive();
  await Promise.resolve();

  assert.equal(fixture.state.activeRunContext, existingContext);
  assert.equal(fixture.state.activeRunSocket, existingSocket);
  assert.equal(fixture.state.activeRunId, 'existing-run');
  assert.equal(closeCount, 0);
  assert.match(fixture.outputs.at(-1), /file type is not runnable/i);
});

test('workspace leave cancels a registered run before runCode responds and blocks a late WebSocket', async () => {
  const runCodeResult = deferred();
  const serverCalls = [];
  const fixture = loadRunner({
    state: {
      tabs: [{ path: 'C:\\workspace\\main.js', dirty: false }],
      activeTabPath: 'C:\\workspace\\main.js'
    },
    BOBO: {
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        if (action === 'runCode') return runCodeResult.promise;
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  const runPromise = fixture.BOBO.runner.runCodeOnServer('C:\\workspace\\main.js');
  await waitFor(() => serverCalls.some(call => call.action === 'runCode'));

  assert.equal(fixture.state.activeRunId, 'run-id-1');
  assert.ok(fixture.state.activeRunContext);
  assert.equal(fixture.state.activeRunSocket, null);

  await fixture.BOBO.runner.prepareWorkspaceLeave();

  const cancelCall = serverCalls.find(call => call.action === 'cancelRun');
  assert.ok(cancelCall, 'workspace leave should cancel a run whose HTTP request is pending');
  assert.equal(cancelCall.payload.runId, 'run-id-1');
  assert.equal(fixture.state.activeRunContext, null);
  assert.equal(fixture.state.activeRunSocket, null);
  assert.equal(fixture.state.activeRunId, null);
  assert.equal(fixture.state.activeRunCancelled, true);

  runCodeResult.resolve({ success: true, token: 'late-token', wsPath: '/ws' });
  await runPromise;

  assert.equal(fixture.webSocketConstructions(), 0);
  assert.equal(fixture.state.activeRunContext, null);
  assert.equal(fixture.state.activeRunId, null);
});

test('Stop invalidates a run waiting for pre-sync before it can send runCode', async () => {
  const syncResult = deferred();
  const serverCalls = [];
  let syncCalls = 0;
  const fixture = loadRunner({
    state: {
      tabs: [{ path: 'C:\\workspace\\main.js', dirty: false }],
      activeTabPath: 'C:\\workspace\\main.js',
      workspaceChangeVersion: 2,
      lastSyncedVersion: 1
    },
    BOBO: {
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        if (action === 'checkFolder') {
          return Promise.resolve({ success: true, folderPath: '/remote/workspace' });
        }
        if (action === 'runCode') {
          return Promise.resolve({ success: true, token: 'unexpected-token', wsPath: '/ws' });
        }
        throw new Error('Unexpected server action: ' + action);
      },
      rclone: {
        sync() {
          syncCalls += 1;
          return syncResult.promise;
        }
      }
    }
  });

  const runPromise = fixture.BOBO.runner.runCodeOnServer('C:\\workspace\\main.js');
  await waitFor(() => syncCalls === 1);
  assert.equal(serverCalls.some(call => call.action === 'runCode'), false);

  await fixture.BOBO.runner.stopActiveRun();
  syncResult.resolve({ success: true });
  await runPromise;

  assert.equal(serverCalls.some(call => call.action === 'runCode'), false);
  assert.equal(fixture.webSocketConstructions(), 0);
  assert.equal(fixture.state.activeRunContext, null);
  assert.equal(fixture.state.activeRunId, null);
});

test('an identity change prevents an older sync from marking the workspace current', async () => {
  const syncResult = deferred();
  let syncCalls = 0;
  const fixture = loadRunner({
    state: {
      workspaceChangeVersion: 2,
      lastSyncedVersion: 1
    },
    BOBO: {
      sendToServer(action) {
        if (action === 'checkFolder') return Promise.resolve({ success: true, folderPath: '/remote/workspace' });
        throw new Error('Unexpected server action: ' + action);
      },
      rclone: {
        sync() {
          syncCalls += 1;
          return syncResult.promise;
        }
      }
    }
  });

  const pendingSync = fixture.BOBO.runner.manualSyncWithServer();
  await waitFor(() => syncCalls === 1);
  await fixture.BOBO.runner.invalidateRunIdentity({ skipHttp: true });
  syncResult.resolve({ success: true });

  assert.equal(await pendingSync, false);
  assert.equal(fixture.state.lastSyncedVersion, 1);
});

test('a dirty tasks file is saved and re-resolved before the current project run syncs', async () => {
  const events = [];
  const serverCalls = [];
  const freshExecution = {
    schemaVersion: 1,
    label: 'Build current',
    kind: 'build',
    steps: [{
      id: 'task-step-1',
      label: 'Build current',
      kind: 'build',
      type: 'process',
      argv: ['npm', 'run', 'fresh-build'],
      cwd: '',
      env: {},
      dependsOn: []
    }]
  };
  let saved = false;
  const fixture = loadRunner({
    state: {
      tabs: [{ path: 'C:\\workspace\\.bobocloud\\tasks.json', dirty: true }],
      workspaceChangeVersion: 1,
      lastSyncedVersion: 1
    },
    api: {
      tasksResolve(label, context) {
        events.push('resolve');
        assert.equal(saved, true, 'task resolution must observe the saved tasks file');
        assert.equal(label, 'Build current');
        assert.deepEqual(context, { activeFile: '' });
        return Promise.resolve({ success: true, execution: freshExecution });
      }
    },
    BOBO: {
      workspace: {
        saveAllTabs() {
          events.push('save');
          saved = true;
          fixture.state.tabs[0].dirty = false;
          return Promise.resolve(true);
        }
      },
      rclone: {
        sync() {
          events.push('sync');
          return Promise.resolve({ success: true });
        }
      },
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        if (action === 'checkFolder') return Promise.resolve({ success: true, folderPath: '/remote/workspace' });
        if (action === 'runTask') return Promise.resolve({ success: false, error: 'test stop' });
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  await fixture.BOBO.runner.runProjectTask({ label: 'Build current', context: { activeFile: '' } });

  assert.deepEqual(events.slice(0, 3), ['save', 'resolve', 'sync']);
  const runCall = serverCalls.find((call) => call.action === 'runTask');
  assert.ok(runCall);
  assert.deepEqual(runCall.payload.task.steps[0].argv, ['npm', 'run', 'fresh-build']);
});
