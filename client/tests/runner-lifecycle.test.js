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
    'run-code': { disabled: false, style: {} },
    'run-target-btn': { disabled: false, style: {} },
    'run-config-btn': { disabled: false, style: {} },
    'stop-code': { disabled: false, style: {} },
    'stdin-input-row': { style: {} },
    'panel-output': { setAttribute() {}, focus() { focusedElement = 'panel-output'; } },
    'output-tab': { focus() { focusedElement = 'output-tab'; } }
  };
  let focusedElement = null;
  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelector(selector) { return selector === '#panel-tabs .panel-tab[data-panel="output"]' ? elements['output-tab'] : null; }
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
    cloudFeaturePolicy: { evaluate() { return { available: true, state: 'legacy', reason: '' }; } },
    runConfig: {
      languageForFile(filePath) {
        return /\.js$/i.test(filePath) ? 'javascript' : null;
      },
      getArgs() { return { compileArgs: [], runArgs: [] }; }
    }
  }, overrides.BOBO || {});

  let webSocketConstructions = 0;
  const webSockets = [];
  function FakeWebSocket(url) {
    webSocketConstructions += 1;
    webSockets.push(this);
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
    elements,
    outputs,
    apiCalls,
    webSockets,
    focusedElement: () => focusedElement,
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

test('a second Run click cannot replace an in-flight preparation and Stop locks immediately', async () => {
  const runCodeResult = deferred();
  const cancelResult = deferred();
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
        if (action === 'cancelRun') return cancelResult.promise;
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  const first = fixture.BOBO.runner.runActive();
  await waitFor(() => serverCalls.some((call) => call.action === 'runCode'));
  const second = await fixture.BOBO.runner.runActive();

  assert.equal(second, false);
  assert.equal(serverCalls.filter((call) => call.action === 'runCode').length, 1);
  assert.equal(fixture.BOBO.state.activeRunId, 'run-id-1');
  assert.match(fixture.outputs.at(-1), /already in progress/i);

  const stop = fixture.BOBO.runner.stopActiveRun();
  assert.equal(fixture.BOBO.state.activeRunId, null);
  assert.equal(fixture.BOBO.state.activeRunSocket, null);
  assert.equal(fixture.BOBO.state.activeRunCancelled, true);
  assert.equal(fixture.BOBO.state.activeRunId, null);
  assert.equal(fixture.BOBO.state.activeRunContext, null);
  assert.equal(fixture.elements['run-code'].disabled, true);
  assert.equal(fixture.elements['run-target-btn'].disabled, true);
  assert.equal(fixture.elements['run-config-btn'].disabled, true);
  cancelResult.resolve({ success: true });
  runCodeResult.resolve({ success: true, token: 'late-token', wsPath: '/ws' });
  await Promise.all([first, stop]);
  assert.equal(fixture.webSocketConstructions(), 0);
  assert.equal(fixture.elements['run-code'].disabled, false);
  assert.equal(fixture.elements['run-target-btn'].disabled, false);
  assert.equal(fixture.elements['run-config-btn'].disabled, false);
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

test('an internal project task handle waits for the final server result and exposes its exit code', async () => {
  const execution = {
    schemaVersion: 1,
    label: 'Build before debug',
    kind: 'build',
    steps: [{ id: 'build', label: 'Build', kind: 'build', type: 'process', argv: ['npm', 'run', 'build'], cwd: '', env: {}, dependsOn: [] }]
  };
  const fixture = loadRunner({
    BOBO: {
      dap: { isActive: () => true },
      environmentActivity: { record: () => { throw new Error('observer failed'); } },
      sendToServer(action) {
        if (action === 'runTask') return Promise.resolve({ success: true, token: 'task-token', wsPath: '/ws' });
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  const handle = fixture.BOBO.runner.startProjectTaskExecution(execution, { owner: 'dap-lifecycle' });
  await waitFor(() => fixture.webSockets.length === 1);
  assert.equal(handle.getState().state, 'running');
  fixture.webSockets[0].readyState = 1;
  fixture.webSockets[0].onopen();
  fixture.webSockets[0].onmessage({ data: JSON.stringify({ type: 'result', success: false, returncode: 7 }) });

  assert.deepEqual(JSON.parse(JSON.stringify(await handle.completion)), {
    success: false,
    returnCode: 7,
    cancelled: false,
    code: 'task-failed',
    message: '',
    runId: 'run-id-1',
    label: 'Build before debug'
  });
  assert.equal(handle.getState().state, 'failed');
  assert.equal(fixture.BOBO.runner.isBusy(), false);
});

test('a project task stream close settles even when problem cleanup throws', async () => {
  const execution = {
    schemaVersion: 1,
    label: 'Interrupted build',
    kind: 'build',
    problemMatcher: ['$test'],
    steps: [{ id: 'build', label: 'Build', kind: 'build', type: 'process', argv: ['build'], cwd: '', env: {}, dependsOn: [] }]
  };
  const fixture = loadRunner({
    BOBO: {
      dap: { isActive: () => true },
      taskProblemMatcher: {
        begin: () => ({ consume() {}, finish() { throw new Error('matcher cleanup failed'); } })
      },
      sendToServer(action) {
        if (action === 'runTask') return Promise.resolve({ success: true, token: 'task-token', wsPath: '/ws' });
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  const handle = fixture.BOBO.runner.startProjectTaskExecution(execution, { owner: 'dap-lifecycle' });
  await waitFor(() => fixture.webSockets.length === 1);
  fixture.webSockets[0].readyState = 1;
  fixture.webSockets[0].onopen();
  fixture.webSockets[0].onclose();

  const outcome = await handle.completion;
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, 'stream-closed');
  assert.equal(fixture.BOBO.runner.isBusy(), false);
});

test('cancelling an internal project task during sync prevents runTask from being sent', async () => {
  const syncResult = deferred();
  const serverCalls = [];
  const execution = {
    schemaVersion: 1,
    label: 'Cancelled build',
    kind: 'build',
    steps: [{ id: 'build', label: 'Build', kind: 'build', type: 'process', argv: ['npm', 'run', 'build'], cwd: '', env: {}, dependsOn: [] }]
  };
  const fixture = loadRunner({
    state: { workspaceChangeVersion: 2, lastSyncedVersion: 1 },
    BOBO: {
      dap: { isActive: () => true },
      rclone: { sync: () => syncResult.promise },
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        if (action === 'checkFolder') return Promise.resolve({ success: true, folderPath: '/remote/workspace' });
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        if (action === 'runTask') return Promise.resolve({ success: true, token: 'unexpected', wsPath: '/ws' });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  const handle = fixture.BOBO.runner.startProjectTaskExecution(execution, { owner: 'dap-lifecycle' });
  await waitFor(() => serverCalls.some((call) => call.action === 'checkFolder'));
  assert.equal(await handle.cancel('debug-cancelled'), true);
  const outcome = await handle.completion;
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.code, 'debug-cancelled');
  syncResult.resolve({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverCalls.some((call) => call.action === 'runTask'), false);
  assert.equal(fixture.webSocketConstructions(), 0);
});

test('identity invalidation marks an internal task handle as cancelled', async () => {
  const syncResult = deferred();
  const serverCalls = [];
  const fixture = loadRunner({
    state: { workspaceChangeVersion: 2, lastSyncedVersion: 1 },
    BOBO: {
      dap: { isActive: () => true },
      rclone: { sync: () => syncResult.promise },
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        if (action === 'checkFolder') return Promise.resolve({ success: true, folderPath: '/remote/workspace' });
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });
  const handle = fixture.BOBO.runner.startProjectTaskExecution({
    schemaVersion: 1,
    label: 'Invalidated build',
    kind: 'build',
    steps: [{ id: 'build', label: 'Build', kind: 'build', type: 'process', argv: ['build'], cwd: '', env: {}, dependsOn: [] }]
  }, { owner: 'dap-lifecycle' });

  await waitFor(() => serverCalls.some((call) => call.action === 'checkFolder'));
  await fixture.BOBO.runner.invalidateRunIdentity({ skipHttp: true });
  const outcome = await handle.completion;
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.code, 'identity-change');
  assert.deepEqual(JSON.parse(JSON.stringify(handle.getState())), { state: 'cancelled', runId: '', cancelled: true });
  syncResult.resolve({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverCalls.some((call) => call.action === 'runTask'), false);
});

test('negotiated run and task gates stop requests before server transport', async () => {
  const serverCalls = [];
  const fixture = loadRunner({
    state: {
      tabs: [{ path: 'C:\\workspace\\main.js', dirty: false }],
      activeTabPath: 'C:\\workspace\\main.js'
    },
    BOBO: {
      cloudFeaturePolicy: { evaluate: feature => ({ available: false, state: 'compatible', reason: 'feature_disabled', feature }) },
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        return Promise.resolve({ success: true });
      }
    }
  });

  assert.equal(await fixture.BOBO.runner.runActive(), false);
  const handle = fixture.BOBO.runner.startProjectTaskExecution({
    schemaVersion: 1,
    label: 'Blocked task',
    kind: 'build',
    steps: [{ id: 'build', label: 'Build', kind: 'build', type: 'process', argv: ['build'], cwd: '', env: {}, dependsOn: [] }]
  }, { owner: 'dap-lifecycle' });
  const outcome = await handle.completion;
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, 'feature-disabled');
  assert.equal(serverCalls.length, 0);
  assert.equal(fixture.webSocketConstructions(), 0);
});

test('cancelling an interactive task input settles preparation without syncing or starting a server run', async () => {
  const serverCalls = [];
  let resolveCalls = 0;
  const fixture = loadRunner({
    api: {
      tasksResolve() {
        resolveCalls += 1;
        return Promise.resolve({
          success: false,
          inputRequired: true,
          inputRequests: [{ id: 'name', type: 'promptString', description: 'Name', default: '', password: false, options: [] }]
        });
      }
    },
    BOBO: {
      projectTasks: { resolveInputRequests: () => Promise.resolve(null) },
      rclone: { sync: () => { throw new Error('sync must not start before task inputs are accepted'); } },
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        return Promise.resolve({ success: true });
      }
    }
  });

  assert.equal(await fixture.BOBO.runner.runProjectTask({ label: 'Interactive', context: {} }), false);
  assert.equal(resolveCalls, 1);
  assert.deepEqual(serverCalls, []);
  assert.equal(fixture.webSocketConstructions(), 0);
  assert.match(fixture.outputs.at(-1), /cancelled/i);
});

test('accepted task inputs are resolved before synchronization and the server receives only the final plan', async () => {
  const events = [];
  const execution = {
    schemaVersion: 1,
    label: 'Interactive',
    kind: 'custom',
    presentation: { reveal: 'never', echo: false, focus: false, clear: false },
    runOptions: { reevaluateOnRerun: true, runOn: 'default' },
    steps: [{ id: 'step', label: 'Interactive', kind: 'custom', type: 'process', argv: ['echo', 'accepted'], cwd: '', env: {}, dependsOn: [], echo: false, displayCommand: 'echo accepted' }]
  };
  let resolveCalls = 0;
  const fixture = loadRunner({
    api: {
      tasksResolve(_label, _context, inputs) {
        resolveCalls += 1;
        events.push(resolveCalls === 1 ? 'resolve:inputs' : 'resolve:plan');
        if (resolveCalls === 1) return Promise.resolve({ success: false, inputRequired: true, inputRequests: [{ id: 'name', type: 'promptString' }] });
        assert.deepEqual(inputs, { name: 'accepted' });
        return Promise.resolve({ success: true, execution });
      }
    },
    BOBO: {
      projectTasks: {
        resolveInputRequests() { events.push('input'); return Promise.resolve({ name: 'accepted' }); }
      },
      sendToServer(action, payload) {
        if (action === 'runTask') {
          events.push('runTask');
          assert.deepEqual(payload.task.steps[0].argv, ['echo', 'accepted']);
          return Promise.resolve({ success: false, error: 'test stop' });
        }
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  await fixture.BOBO.runner.runProjectTask({ label: 'Interactive', context: {} });
  assert.deepEqual(events, ['resolve:inputs', 'input', 'resolve:plan', 'runTask']);
});

test('task presentation is applied locally and UI metadata never crosses the server boundary', async () => {
  const serverCalls = [];
  const panels = [];
  let clearCount = 0;
  const fixture = loadRunner({
    BOBO: {
      clearRunOutput() { clearCount += 1; },
      switchToPanel(panel) { panels.push(panel); },
      sendToServer(action, payload) {
        serverCalls.push({ action, payload });
        if (action === 'runTask') return Promise.resolve({ success: false, error: 'test stop' });
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });
  const execution = {
    schemaVersion: 1,
    label: 'Presented',
    kind: 'build',
    source: 'vscode',
    presentation: { reveal: 'always', echo: true, focus: true, clear: true },
    runOptions: { reevaluateOnRerun: false, runOn: 'default' },
    problemMatcher: '$test',
    steps: [{
      id: 'build', label: 'Build', kind: 'build', type: 'process', argv: ['node', 'build.js'], cwd: '', env: {}, dependsOn: [],
      echo: true, displayCommand: 'node build.js'
    }]
  };

  assert.equal(await fixture.BOBO.runner.runProjectTask(execution), false);
  assert.equal(clearCount, 1);
  assert.deepEqual(panels, ['output']);
  assert.equal(fixture.focusedElement(), 'panel-output');
  assert.ok(fixture.outputs.includes('$ node build.js'));
  const runCall = serverCalls.find((call) => call.action === 'runTask');
  assert.ok(runCall);
  assert.deepEqual(Object.keys(runCall.payload.task).sort(), ['kind', 'label', 'schemaVersion', 'source', 'steps']);
  assert.deepEqual(Object.keys(runCall.payload.task.steps[0]).sort(), ['argv', 'cwd', 'dependsOn', 'env', 'id', 'kind', 'label', 'type']);
  assert.equal(runCall.payload.task.source, 'vscode');
  assert.equal(runCall.payload.task.presentation, undefined);
  assert.equal(runCall.payload.task.runOptions, undefined);
  assert.equal(runCall.payload.task.problemMatcher, undefined);
  assert.equal(runCall.payload.task.steps[0].displayCommand, undefined);
  assert.equal(runCall.payload.task.steps[0].echo, undefined);
  assert.deepEqual(runCall.payload.task.steps[0].argv, ['node', 'build.js']);

  const silentWithMatcher = Object.assign({}, execution, {
    presentation: { reveal: 'silent', echo: false, focus: false, clear: false }
  });
  await fixture.BOBO.runner.runProjectTask(silentWithMatcher);
  assert.deepEqual(panels, ['output'], 'silent tasks with a problem matcher keep the output panel hidden');
  const silentWithoutMatcher = Object.assign({}, silentWithMatcher);
  delete silentWithoutMatcher.problemMatcher;
  await fixture.BOBO.runner.runProjectTask(silentWithoutMatcher);
  assert.deepEqual(panels, ['output', 'output'], 'silent tasks without problem scanning reveal the output panel');
  await fixture.BOBO.runner.runProjectTask(Object.assign({}, silentWithoutMatcher, {
    presentation: { reveal: 'never', echo: false, focus: false, clear: false }
  }));
  assert.deepEqual(panels, ['output', 'output'], 'never keeps the output panel hidden even without a problem matcher');
});

test('reevaluateOnRerun false reuses the resolved plan inside the same workspace identity', async () => {
  const runPayloads = [];
  let resolveCalls = 0;
  const execution = {
    schemaVersion: 1,
    label: 'Stable rerun',
    kind: 'test',
    presentation: { reveal: 'never', echo: false, focus: false, clear: false },
    runOptions: { reevaluateOnRerun: false, runOn: 'default' },
    steps: [{ id: 'test', label: 'Test', kind: 'test', type: 'process', argv: ['test', 'first-value'], cwd: '', env: {}, dependsOn: [], echo: false, displayCommand: 'test first-value' }]
  };
  const fixture = loadRunner({
    api: {
      tasksResolve() {
        resolveCalls += 1;
        return Promise.resolve({ success: true, execution });
      }
    },
    BOBO: {
      sendToServer(action, payload) {
        if (action === 'runTask') {
          runPayloads.push(payload.task);
          return Promise.resolve({ success: false, error: 'test stop' });
        }
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  assert.equal(fixture.BOBO.runner.canRerunLastProjectTask(), false);
  await fixture.BOBO.runner.runProjectTask({ label: 'Stable rerun', context: { activeFile: 'first.js' } });
  assert.equal(fixture.BOBO.runner.canRerunLastProjectTask(), true);
  await fixture.BOBO.runner.rerunLastProjectTask({ activeFile: 'second.js' });
  assert.equal(resolveCalls, 1);
  assert.equal(runPayloads.length, 2);
  assert.deepEqual(runPayloads.map((task) => task.steps[0].argv), [
    ['test', 'first-value'],
    ['test', 'first-value']
  ]);

  fixture.state.workspaceIdentity = 8;
  assert.equal(fixture.BOBO.runner.canRerunLastProjectTask(), false);
  assert.equal(fixture.BOBO.runner.rerunLastProjectTask({ activeFile: 'third.js' }), false);
  assert.match(fixture.outputs.at(-1), /no project task/i);
});

test('reevaluateOnRerun true resolves again with the current editor context', async () => {
  const resolvedContexts = [];
  const runArguments = [];
  const fixture = loadRunner({
    api: {
      tasksResolve(_label, context) {
        const activeFile = String(context.activeFile || '');
        resolvedContexts.push(activeFile);
        return Promise.resolve({
          success: true,
          execution: {
            schemaVersion: 1,
            label: 'Dynamic rerun',
            kind: 'test',
            presentation: { reveal: 'never', echo: false, focus: false, clear: false },
            runOptions: { reevaluateOnRerun: true, runOn: 'default' },
            steps: [{ id: 'test', label: 'Test', kind: 'test', type: 'process', argv: ['test', activeFile], cwd: '', env: {}, dependsOn: [], echo: false, displayCommand: 'test' }]
          }
        });
      }
    },
    BOBO: {
      sendToServer(action, payload) {
        if (action === 'runTask') {
          runArguments.push(payload.task.steps[0].argv.slice());
          return Promise.resolve({ success: false, error: 'test stop' });
        }
        if (action === 'cancelRun') return Promise.resolve({ success: true });
        throw new Error('Unexpected server action: ' + action);
      }
    }
  });

  await fixture.BOBO.runner.runProjectTask({ label: 'Dynamic rerun', context: { activeFile: 'first.js' } });
  await fixture.BOBO.runner.rerunLastProjectTask({ activeFile: 'second.js' });
  assert.deepEqual(resolvedContexts, ['first.js', 'second.js']);
  assert.deepEqual(runArguments, [['test', 'first.js'], ['test', 'second.js']]);
});
