// src/runner.js — Code execution + rclone sync
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // ──── Sync ────
  var syncInFlight = false;
  var syncPromise = null;
  var syncOperation = null;
  var runNonceSequence = 0;
  var runPreparationSequence = 0;
  var activeRunPreparation = null;
  var syncedIdentityEpoch = S.runIdentityEpoch || 0;

  function tr(source, replacements) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function taskInteractiveStage(taskExecution) {
    if (!taskExecution || !Array.isArray(taskExecution.steps)) return '';
    var terminals = new Set(taskExecution.steps.map(function(step) { return step.id; }));
    taskExecution.steps.forEach(function(step) {
      (step.dependsOn || []).forEach(function(dependency) { terminals.delete(dependency); });
    });
    if (terminals.size !== 1) return '';
    var terminalId = Array.from(terminals)[0];
    var terminalStep = taskExecution.steps.find(function(step) { return step.id === terminalId; });
    return terminalStep ? 'task:' + (terminalStep.kind || 'custom').toLowerCase() + ':' + terminalStep.id : '';
  }

  function createRunContext() {
    return {
      rootPath: S.workspaceRoot,
      workspaceIdentity: S.workspaceIdentity,
      generation: S.workspaceGeneration || 0,
      identityEpoch: S.runIdentityEpoch || 0,
      preparation: 0,
      nonce: ++runNonceSequence
    };
  }

  function isRunEnvironmentCurrent(context) {
    return !!context &&
      S.workspaceRoot === context.rootPath &&
      S.workspaceIdentity === context.workspaceIdentity &&
      (S.workspaceGeneration || 0) === context.generation &&
      (S.runIdentityEpoch || 0) === context.identityEpoch;
  }

  function isRunPreparationCurrent(context) {
    return activeRunPreparation === context && isRunEnvironmentCurrent(context) &&
      context.preparation === runPreparationSequence;
  }

  function beginRunPreparation(context) {
    context.preparation = ++runPreparationSequence;
    activeRunPreparation = context;
    setRunControlsActive();
  }

  function finishRunPreparation(context) {
    if (activeRunPreparation === context) activeRunPreparation = null;
    if (!S.activeRunContext && !S.activeRunId && !S.activeRunSocket) setRunControlsIdle();
  }

  function isRunContextCurrent(context) {
    return S.activeRunContext === context && isRunEnvironmentCurrent(context);
  }

  function setRunControlsIdle() {
    var stopButton = document.getElementById('stop-code');
    if (stopButton) { stopButton.disabled = true; stopButton.style.opacity = '0.5'; }
    hideStdinInput();
  }

  function setRunControlsActive() {
    var stopButton = document.getElementById('stop-code');
    if (stopButton) { stopButton.disabled = false; stopButton.style.opacity = '1'; }
  }

  function requestRunCancellation(runId) {
    return new Promise(function(resolve) {
      var settled = false;
      var timeoutId = setTimeout(finish, 2000);
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      }
      try {
        Promise.resolve(BOBO.sendToServer('cancelRun', { runId: runId }, { quiet: true })).then(finish, finish);
      } catch (error) {
        finish();
      }
    });
  }

  async function cancelActiveRun(options) {
    options = options || {};
    var socket = S.activeRunSocket;
    var runId = S.activeRunId;
    var runContext = S.activeRunContext;
    if (!socket && !runId && !runContext) return false;

    S.activeRunContext = null;
    S.activeRunCancelled = true;
    S.artifactInflight = new Map();
    S.activeRunSocket = null;
    S.activeRunId = null;
    if (socket && socket.readyState === WebSocket.OPEN && runId) {
      try { socket.send(JSON.stringify({ type: 'cancel', runId: runId })); } catch (e) {}
    }
    if (runId && !options.skipHttp && BOBO.sendToServer) {
      await requestRunCancellation(runId);
    }
    if (socket) {
      try { socket.close(); } catch (e) {}
    }
    if (global.api && global.api.setArtifactRunContext && runContext) {
      try { await global.api.setArtifactRunContext({ clear: true, runNonce: runContext.nonce }); } catch (e) {}
    }
    setRunControlsIdle();
    return true;
  }

  async function prepareWorkspaceLeave(options) {
    runPreparationSequence += 1;
    activeRunPreparation = null;
    var cancelled = await cancelActiveRun(options);
    if (!cancelled) setRunControlsIdle();
    return cancelled;
  }

  async function invalidateRunIdentity(options) {
    S.runIdentityEpoch = (S.runIdentityEpoch || 0) + 1;
    runPreparationSequence += 1;
    activeRunPreparation = null;
    var cancelled = await cancelActiveRun(options);
    if (!cancelled) setRunControlsIdle();
    return cancelled;
  }

  async function clearRunContext(runContext, runId) {
    if (S.activeRunContext !== runContext || (runId && S.activeRunId !== runId)) return;
    S.activeRunContext = null;
    S.activeRunSocket = null;
    S.activeRunId = null;
    S.activeRunCancelled = false;
    S.artifactInflight = new Map();
    if (global.api && global.api.setArtifactRunContext && runContext) {
      try { await global.api.setArtifactRunContext({ clear: true, runNonce: runContext.nonce }); } catch (e) {}
    }
    setRunControlsIdle();
  }

  function markWorkspaceChanged() {
    S.workspaceChangeVersion = (S.workspaceChangeVersion || 0) + 1;
  }

  function hasCloudAuth() {
    return !(S.auth && S.auth.mode === 'multi') || !!(S.auth.token && S.auth.user);
  }

  function currentSyncIdentity() {
    return {
      rootPath: S.workspaceRoot,
      generation: S.workspaceGeneration || 0,
      identityEpoch: S.runIdentityEpoch || 0
    };
  }

  function syncOperationMatchesCurrent(operation) {
    return !!operation && operation.rootPath === S.workspaceRoot &&
      operation.generation === (S.workspaceGeneration || 0) &&
      operation.identityEpoch === (S.runIdentityEpoch || 0);
  }

  function canSyncCurrentWorkspace() {
    return !!S.workspaceRoot && !S.workspaceTransitionLocked &&
      !!S.serverSettings.ip && !!S.serverSettings.user && hasCloudAuth();
  }

  async function doSyncWithServer() {
    // No folder open or server not configured -> skip silently.
    // This guards the auto-sync interval from spamming the output panel
    // with errors when no workspace is opened.
    if (!canSyncCurrentWorkspace()) return false;
    if (syncPromise) {
      if (syncOperationMatchesCurrent(syncOperation)) return syncPromise;
      await syncPromise;
      if (!canSyncCurrentWorkspace()) return false;
      if (syncPromise) return doSyncWithServer();
    }
    return startSync(false);
  }

  // Manual Sync is intentionally forceful; pre-run sync uses version checks.
  async function manualSyncWithServer() {
    if (!S.workspaceRoot || S.workspaceTransitionLocked || !S.serverSettings.ip || !S.serverSettings.user) return false;
    if (!hasCloudAuth()) {
      BOBO.updateRunOutput('Cloud sync requires login. Click the account button in the status bar to sign in.');
      return false;
    }
    // A user-triggered upload must run after any background sync so edits
    // saved immediately before clicking Sync cannot be skipped.
    if (syncPromise) await syncPromise;
    if (!canSyncCurrentWorkspace()) return false;
    return startSync(true);
  }

  // Runs only need a server upload when the watched workspace changed. A
  // manual Sync remains forceful, but repeatedly running unchanged code must
  // not pay for another directory scan, SSH handshake and rclone traversal.
  async function ensureWorkspaceSyncedForRun() {
    if (syncPromise) await syncPromise;
    if (!canSyncCurrentWorkspace()) return false;
    if (syncedIdentityEpoch === (S.runIdentityEpoch || 0) && S.lastSyncedVersion === S.workspaceChangeVersion) {
      BOBO.updateRunOutput('Workspace unchanged - using the existing server copy');
      return true;
    }
    return startSync(true);
  }

  function startSync(verbose) {
    var operation = currentSyncIdentity();
    var syncStatusContext = BOBO.workspaceSyncStatus && BOBO.workspaceSyncStatus.beginSync({ force: verbose === true });
    syncInFlight = true;
    syncOperation = operation;
    var operationPromise = doSyncWithServerInternal(verbose, operation).then(function(result) {
      if (BOBO.workspaceSyncStatus && syncStatusContext) {
        BOBO.workspaceSyncStatus.finishSync(syncStatusContext, {
          success: result === true,
          error: operation.error || null
        });
      }
      return result;
    }, function(error) {
      operation.error = error;
      if (BOBO.workspaceSyncStatus && syncStatusContext) {
        BOBO.workspaceSyncStatus.finishSync(syncStatusContext, { success: false, error: error });
      }
      throw error;
    }).finally(function() {
      if (syncOperation !== operation) return;
      syncInFlight = false;
      syncPromise = null;
      syncOperation = null;
    });
    syncPromise = operationPromise;
    return operationPromise;
  }

  async function uploadWorkspace() {
    if (BOBO.workspace && BOBO.workspace.saveAllTabs) {
      var saved = await BOBO.workspace.saveAllTabs();
      if (!saved) return false;
    }
    return manualSyncWithServer();
  }

  async function doSyncWithServerInternal(verbose, operation) {
    try {
      var syncRoot = S.workspaceRoot;
      var syncGeneration = S.workspaceGeneration || 0;
      var syncIdentityEpoch = S.runIdentityEpoch || 0;
      if (!syncRoot) return false;
      var syncVersion = S.workspaceChangeVersion || 0;
      var projectName = syncRoot.split(/[/\\]/).pop();
      var projectKey = BOBO.projectKey(syncRoot);
	  var teamProject = S.collaboration && S.collaboration.current;

      // 记录 folderKey -> projectName 映射到本地（用于项目列表显示真实名称）
	  if (!teamProject && projectKey && projectName) {
        try { await window.api.saveProjectName(projectKey, projectName); } catch (e) {}
      }

      // Calculate local workspace size for quota pre-check
      var totalSize = 0;
      try {
        var sizeResult = await window.api.calculateDirSize(syncRoot);
        totalSize = sizeResult.size || 0;
      } catch (e) { /* ignore size calculation errors */ }

      var checkResult = await BOBO.sendToServer('checkFolder', {
        folderName: projectName,
        folderKey: projectKey,
		totalSize: totalSize,
		teamId: teamProject ? teamProject.teamId : undefined,
		projectId: teamProject ? teamProject.projectId : undefined,
		branch: teamProject ? teamProject.branch : undefined
      }, { quiet: true });
      if (S.workspaceRoot !== syncRoot || (S.workspaceGeneration || 0) !== syncGeneration ||
          (S.runIdentityEpoch || 0) !== syncIdentityEpoch) return false;
      if (!checkResult) {
        if (verbose) BOBO.updateRunOutput('Error checking folder on server');
        return false;
      }
      if (!checkResult.success) {
        // Quota exceeded: show error and open Server Projects panel
        if (checkResult.error && checkResult.error.toLowerCase().indexOf('quota') !== -1) {
          BOBO.updateRunOutput('[Error] ' + checkResult.error);
          BOBO.updateRunOutput('Use File -> Server Projects to manage your storage.');
          if (BOBO.projects && typeof BOBO.projects.openWithQuotaError === 'function') {
            BOBO.projects.openWithQuotaError(checkResult.error);
          }
        } else {
          if (verbose) BOBO.updateRunOutput('Error preparing server folder: ' + checkResult.error);
        }
        return false;
      }

      var remotePath = checkResult.folderPath || ('/shareOnling/' + projectName);
      var result = await BOBO.rclone.sync({
        src: syncRoot,
        remotePath: remotePath,
        onProgress: verbose ? function(line) { BOBO.updateRunOutput('Sync: ' + line); } : undefined
      });
      if (S.workspaceRoot !== syncRoot || (S.workspaceGeneration || 0) !== syncGeneration ||
          (S.runIdentityEpoch || 0) !== syncIdentityEpoch) return false;

      if (!result.success) {
        if (verbose) BOBO.updateRunOutput('Sync failed: ' + result.error.message);
        if (result.error.type === 'BINARY_NOT_FOUND') {
          if (verbose) BOBO.updateRunOutput('Please specify rclone path in server settings.');
        } else if (result.error.type === 'AUTH_FAILED') {
          if (verbose) BOBO.updateRunOutput('Check server username/password in settings.');
        } else if (result.error.type === 'CONNECTION_FAILED') {
          if (verbose) BOBO.updateRunOutput('Ensure SFTP port 22 is open on the server.');
        }
        return false;
      }

      if (verbose) BOBO.updateRunOutput('Sync completed - all files synced');
      // Preserve changes that happened while rclone was running: only the
      // version captured at start is considered synchronized.
      S.lastSyncedVersion = syncVersion;
      syncedIdentityEpoch = syncIdentityEpoch;
      return true;
    } catch (error) {
      if (operation) operation.error = error;
      if (verbose) BOBO.updateRunOutput('Sync exception: ' + error.message);
      return false;
    }
  }

  // ──── Artifacts ────
  function handleArtifactChunk(payload, runContext) {
    if (!isRunContextCurrent(runContext)) return null;
    var filePath = payload.path;
    if (!filePath) return null;

    var total = Number(payload.chunkCount || 1);
    var index = Number(payload.chunkIndex || 0);
    if (!Number.isInteger(total) || total < 1 || total > 4096 ||
        !Number.isInteger(index) || index < 0 || index >= total) {
      return Promise.reject(new Error('Invalid artifact chunk metadata for ' + filePath));
    }
    var kind = payload.fileType || 'text';
    var entry = S.artifactInflight.get(filePath) || {
      fileType: kind,
      chunkCount: total,
      chunks: new Array(total).fill(''),
      received: 0
    };

    if (entry.chunks[index] === '') entry.received += 1;
    entry.fileType = kind;
    entry.chunkCount = total;
    entry.chunks[index] = payload.data || payload.content || '';
    S.artifactInflight.set(filePath, entry);

    if (entry.received < entry.chunkCount) return null;

    var combined = entry.chunks.join('');
    S.artifactInflight.delete(filePath);
    return window.api.saveArtifact({
      relativePath: filePath,
      content: combined,
      binary: entry.fileType === 'binary',
      workspaceRoot: runContext.rootPath,
      workspaceIdentity: runContext.workspaceIdentity,
      runNonce: runContext.nonce
    });
  }

  async function refreshWorkspaceTree(runContext) {
    var rootPath = runContext ? runContext.rootPath : S.workspaceRoot;
    var generation = runContext ? runContext.generation : (S.workspaceGeneration || 0);
    if (!rootPath) return;
    var tree;
    try {
      tree = await window.api.readTree(rootPath);
    } catch (error) {
      if (S.workspaceRoot !== rootPath || (S.workspaceGeneration || 0) !== generation) return;
      throw error;
    }
    if (S.workspaceRoot !== rootPath || (S.workspaceGeneration || 0) !== generation) return;
    if (tree && BOBO.workspace) BOBO.workspace.renderTree(tree);
  }

  // Public sync function (wraps doSyncWithServer with mutex)
  function syncWithServer() {
    return doSyncWithServer();
  }

  // ──── Auto Sync ────
  function setupAutoSync() {
    if (S.autoSyncInterval) { clearInterval(S.autoSyncInterval); S.autoSyncInterval = null; }
    // syncInterval 以毫秒为单位（默认 30000ms = 30s）。
    // 兼容旧配置：若值 < 1000 视为秒并换算为毫秒；旧的 3000 已是毫秒，保持原值（=3s）。
    var raw = S.serverSettings.syncInterval;
    var intervalMs;
    if (!raw) {
      intervalMs = 30000;
    } else if (raw < 1000) {
      intervalMs = raw * 1000;
    } else {
      intervalMs = raw;
    }
    if (intervalMs > 0) {
      S.autoSyncInterval = setInterval(function() {
        if (syncInFlight) return; // Previous sync still running — skip this round
        if (!S.workspaceRoot) return; // No folder open — skip silently
        if (S.lastSyncedVersion === S.workspaceChangeVersion) return; // No local changes
        syncWithServer();
      }, intervalMs);
    }
  }

  // ──── Run Code ────
  function runActive() {
    if (S.workspaceTransitionLocked) return;
    var active = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    if (!active) {
      BOBO.updateRunOutput('Open a runnable source file before starting a run.');
      return;
    }
    runCodeOnServer(active.path);
  }

  // 中止当前运行：通过 WebSocket 发送 cancel 消息，服务端取消运行上下文
  async function stopActiveRun() {
    var hadPreparation = !!activeRunPreparation;
    if (hadPreparation) {
      runPreparationSequence += 1;
      activeRunPreparation = null;
    }
    if (!hadPreparation && !S.activeRunSocket && !S.activeRunId && !S.activeRunContext) {
      BOBO.updateRunOutput('[Stop] No active run to stop');
      return;
    }
    BOBO.updateRunOutput('[Stop] Cancelling run...');
    var cancelledActive = await cancelActiveRun();
    if (!cancelledActive) setRunControlsIdle();
  }

  async function runCodeOnServer(filePath) {
    return runOnServer({ filePath: filePath, taskExecution: null });
  }

  async function runProjectTask(taskRequest) {
    var hasExecutionPlan = taskRequest && Array.isArray(taskRequest.steps);
    if (!taskRequest || !taskRequest.label || (!hasExecutionPlan && typeof taskRequest.context !== 'object')) {
      BOBO.updateRunOutput(tr('Error: Invalid project task request'));
      return false;
    }
    if (!S.selectedRuntime) {
      BOBO.updateRunOutput(tr('Error: Project tasks require a Docker runtime; Local cannot execute workspace tasks.'));
      return false;
    }
    return runOnServer({
      filePath: null,
      taskExecution: hasExecutionPlan ? taskRequest : null,
      taskRequest: hasExecutionPlan ? null : taskRequest
    });
  }

  async function runOnServer(options) {
    options = options || {};
    var filePath = options.filePath;
    var taskExecution = options.taskExecution;
    var taskRequest = options.taskRequest;
    var isProjectTask = Boolean(taskExecution || taskRequest);
    if (S.workspaceTransitionLocked) return;
    if (BOBO.dap && BOBO.dap.isActive && BOBO.dap.isActive()) {
      BOBO.updateRunOutput(tr('Cannot run code while a debug session is active.'));
      return false;
    }
    if (!S.workspaceRoot || !S.serverSettings.ip) {
      BOBO.updateRunOutput('Error: Workspace not opened or server not configured');
      return;
    }

    // 多人模式下未登录：云编译（含 Local 直跑）需要登录态，直接拦截并提示
    if (S.auth && S.auth.mode === 'multi' && !(S.auth.token && S.auth.user)) {
      BOBO.updateRunOutput('Error: Account not logged in. Cloud compile requires login - click the account button in the status bar to log in.');
      if (BOBO.auth && typeof BOBO.auth.openAuthModal === 'function') {
        BOBO.auth.openAuthModal('Cloud compile requires login');
      }
      return;
    }

    var runContext = createRunContext();
    var projectName = runContext.rootPath.split(/[/\\]/).pop();
    var relativeFilePath = isProjectTask ? '' : filePath.replace(runContext.rootPath, '').replace(/^[/\\]/, '');
    var rcLang = !isProjectTask && BOBO.runConfig ? BOBO.runConfig.languageForFile(relativeFilePath) : null;
    if (!isProjectTask && BOBO.runConfig && !rcLang) {
      BOBO.updateRunOutput('Error: This file type is not runnable. Open a C, C++, Java, Go, Rust, Python, or JavaScript file.');
      return;
    }
    beginRunPreparation(runContext);

    BOBO.clearRunOutput();
    BOBO.updateRunOutput(isProjectTask
      ? tr('Preparing project task: {task}', { task: taskExecution ? taskExecution.label : taskRequest.label })
      : 'Preparing run: ' + relativeFilePath);

    // Save before running
    var tab = !isProjectTask && S.tabs.find(function(t) { return t.path === filePath; });
    var needsSave = isProjectTask ? S.tabs.some(function(candidate) { return candidate.dirty; }) : Boolean(tab && tab.dirty);
    if (needsSave) {
      if (BOBO.workspace) {
        var saved = isProjectTask && BOBO.workspace.saveAllTabs
          ? await BOBO.workspace.saveAllTabs()
          : await BOBO.workspace.saveActiveTab();
        if (!isRunPreparationCurrent(runContext)) return;
        if (!saved) {
          finishRunPreparation(runContext);
          BOBO.updateRunOutput(isProjectTask
            ? tr('Error: Project files could not be saved, so the task was cancelled.')
            : 'Error: The active file could not be saved, so the run was cancelled.');
          return;
        }
        // File watcher delivery is asynchronous. Mark this save immediately so
        // the pre-run version check can never race ahead of the watcher event.
        markWorkspaceChanged();
      }
    }

    if (taskRequest) {
      try {
        var resolvedTask = await global.api.tasksResolve(taskRequest.label, taskRequest.context || {});
        if (!isRunPreparationCurrent(runContext)) return;
        if (!resolvedTask || !resolvedTask.success || !resolvedTask.execution) {
          var taskError = resolvedTask && resolvedTask.error || { code: 'TASK_RESOLVE_FAILED', message: 'Unknown task resolution error' };
          finishRunPreparation(runContext);
          BOBO.updateRunOutput(tr('Task could not be resolved [{code}]: {message}', {
            code: taskError.code,
            message: taskError.message
          }));
          return false;
        }
        taskExecution = resolvedTask.execution;
      } catch (error) {
        finishRunPreparation(runContext);
        BOBO.updateRunOutput(tr('Error: Task configuration could not be loaded: {message}', { message: error.message }));
        return false;
      }
    }

    try {
      var syncSuccess = await ensureWorkspaceSyncedForRun();
      if (!isRunPreparationCurrent(runContext)) return;
      if (!syncSuccess) {
        finishRunPreparation(runContext);
        BOBO.updateRunOutput('Error: Failed to sync with server before running');
        return;
      }

      var runId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'run-' + Date.now();

      // 读取当前语言的运行配置（编译参数 / 程序参数，按 工作区×语言 记忆）
      var rc = (BOBO.runConfig && rcLang) ? BOBO.runConfig.getArgs(rcLang) : { compileArgs: [], runArgs: [] };

      await cancelActiveRun();
      if (!isRunPreparationCurrent(runContext)) return;

      S.activeRunContext = runContext;
      S.activeRunSocket = null;
      S.activeRunId = runId;
      S.activeRunCancelled = false;
      S.artifactInflight = new Map();
      activeRunPreparation = null;
      if (global.api && global.api.setArtifactRunContext) {
        try {
          await global.api.setArtifactRunContext({
            workspaceRoot: runContext.rootPath,
            workspaceIdentity: runContext.workspaceIdentity,
            runNonce: runContext.nonce
          });
        } catch (error) {
          await clearRunContext(runContext, runId);
          BOBO.updateRunOutput('Run error: ' + error.message);
          return;
        }
      }
      if (!isRunContextCurrent(runContext)) return;
      setRunControlsActive();

      BOBO.updateRunOutput(taskExecution
        ? tr('Running project task: {task}', { task: taskExecution.label })
        : 'Running code: ' + relativeFilePath);
      if (!taskExecution && rc.compileArgs.length > 0) BOBO.updateRunOutput('Compile args: ' + rc.compileArgs.join(' '));
      if (!taskExecution && rc.runArgs.length > 0) BOBO.updateRunOutput('Program args: ' + rc.runArgs.join(' '));

      var requestPayload = {
        folderName: projectName,
        folderKey: BOBO.projectKey(runContext.rootPath),
        runId: runId,
        runtime: S.selectedRuntime,
        setupCommands: S.setupCommands.length > 0 ? S.setupCommands : undefined,
		teamId: S.collaboration && S.collaboration.current ? S.collaboration.current.teamId : undefined,
		projectId: S.collaboration && S.collaboration.current ? S.collaboration.current.projectId : undefined,
		branch: S.collaboration && S.collaboration.current ? S.collaboration.current.branch : undefined
      };
      if (taskExecution) {
        requestPayload.task = taskExecution;
      } else {
        requestPayload.filePath = relativeFilePath;
        requestPayload.compileArgs = rc.compileArgs.length > 0 ? rc.compileArgs : undefined;
        requestPayload.runArgs = rc.runArgs.length > 0 ? rc.runArgs : undefined;
      }
      var runResult = await BOBO.sendToServer(taskExecution ? 'runTask' : 'runCode', requestPayload);
      if (!isRunContextCurrent(runContext)) return;

      if (!runResult) {
        BOBO.updateRunOutput('Error: Failed to get run result from server');
        await cancelActiveRun();
        return;
      }

      if (!runResult.success) {
        BOBO.updateRunOutput('\n=== RUN FAILED ===');
        if (runResult.error) BOBO.updateRunOutput('Error: ' + runResult.error);
        await cancelActiveRun();
        return;
      }

      // WebSocket streaming
      var token = runResult.token;
      var wsPath = runResult.wsPath || '/ws';
      var wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
      var wsUrl = wsProtocol + '://' + S.serverSettings.ip + ':3101' + wsPath;

      var streamReady = await new Promise(function(resolve) {
        var settled = false;
        var socket = new WebSocket(wsUrl);
        if (!isRunContextCurrent(runContext)) { socket.close(); resolve(false); return; }
        S.activeRunSocket = socket;
        var artifactWrites = [];
        var artifactFailures = 0;

        var timeoutId = setTimeout(function() {
          if (settled) return;
          settled = true;
          try { socket.close(); } catch (e) {}
          BOBO.updateRunOutput('WebSocket connect timeout');
          resolve(false);
        }, 8000);

        socket.onopen = function() {
          clearTimeout(timeoutId);
          if (!isRunContextCurrent(runContext)) { socket.close(); resolve(false); return; }
          try { socket.send(JSON.stringify({ type: 'attach', runId: runId, token: token })); } catch (e) {}
          settled = true;
          S.activeRunCancelled = false; // 重置取消标志
          BOBO.updateRunOutput('WebSocket stream connected');
          var sb = document.getElementById('stop-code'); if (sb) { sb.disabled = false; sb.style.opacity = '1'; }
          resolve(true);
        };

        // stdin 输入框显示时机：
        //   - 收到 stdout 时立即显示（此时程序提示文字已出现在输出面板，如 input("plz...") 的提示）
        //   - 兜底：收到 run: 阶段状态后 300ms 仍无 stdout，也显示（处理 scanf 无提示的场景）
        var stdinShown = false;
        var stdinFallbackTimer = null;
        var interactiveTaskStage = taskInteractiveStage(taskExecution);

        function showStdinOnce() {
          if (stdinShown) return;
          stdinShown = true;
          if (stdinFallbackTimer) { clearTimeout(stdinFallbackTimer); stdinFallbackTimer = null; }
          showStdinInput(socket);
        }

        socket.onmessage = async function(event) {
          if (!isRunContextCurrent(runContext)) return;
          try {
            var payload = JSON.parse(event.data);
            if (payload.type === 'status' && payload.message) {
              BOBO.updateRunOutput(payload.message);
              // run 步骤开始：启动兜底计时器（300ms 后若无 stdout 则显示输入框）
              if (payload.stage && ((!taskExecution && payload.stage.indexOf('run:') === 0) || payload.stage === interactiveTaskStage) && !stdinShown) {
                stdinFallbackTimer = setTimeout(showStdinOnce, 300);
              }
            }
            if (payload.type === 'stdout' && payload.line !== undefined && !S.activeRunCancelled) {
              BOBO.updateRunOutput(payload.line);
              // 程序有输出（如 input() 的提示文字）：立即显示输入框
              if (!taskExecution || payload.stage === interactiveTaskStage) showStdinOnce();
            }
            if (payload.type === 'stderr' && payload.line !== undefined && !S.activeRunCancelled) BOBO.updateRunOutput('[stderr] ' + payload.line);
            if (payload.type === 'artifact') {
              var write = handleArtifactChunk(payload, runContext);
              if (write) {
                artifactWrites.push(Promise.resolve(write).catch(function(err) {
                  artifactFailures += 1;
                  BOBO.updateRunOutput('Artifact save failed: ' + err.message);
                }));
              }
            }
            if (payload.type === 'artifactsComplete') {
              await Promise.all(artifactWrites);
              if (!isRunContextCurrent(runContext)) return;
              BOBO.updateRunOutput(artifactFailures === 0
                ? 'Artifacts received'
                : 'Artifacts completed with ' + artifactFailures + ' save error(s)');
              await refreshWorkspaceTree(runContext);
            }
            if (payload.type === 'result') {
              BOBO.updateRunOutput('Return code: ' + payload.returncode);
              BOBO.updateRunOutput(payload.success ? 'Run finished successfully' : 'Run finished with errors');
              if (BOBO.environmentActivity && typeof BOBO.environmentActivity.record === 'function') {
                BOBO.environmentActivity.record('compile', { outcome: payload.success ? 'completed' : 'failed' });
                if (payload.success && S.setupCommands.length > 0) {
                  BOBO.environmentActivity.record('install', { outcome: 'completed' });
                }
              }
              if (S.setupCommands.length > 0 && BOBO.lsp && typeof BOBO.lsp.dependenciesChanged === 'function') {
                BOBO.lsp.dependenciesChanged();
              }
              if (stdinFallbackTimer) { clearTimeout(stdinFallbackTimer); stdinFallbackTimer = null; }
              hideStdinInput();
            }
            if (payload.type === 'error' && payload.message) BOBO.updateRunOutput('Error: ' + payload.message);
          } catch (error) {
            BOBO.updateRunOutput('Stream parse error: ' + error.message);
          }
        };

        socket.onerror = function() {
          clearTimeout(timeoutId);
          if (!settled) { settled = true; resolve(false); }
          if (isRunContextCurrent(runContext)) BOBO.updateRunOutput('WebSocket stream error');
        };

        socket.onclose = function() {
          clearTimeout(timeoutId);
          if (!settled) { settled = true; resolve(false); }
          if (stdinFallbackTimer) { clearTimeout(stdinFallbackTimer); stdinFallbackTimer = null; }
          if (isRunContextCurrent(runContext)) {
            BOBO.updateRunOutput('WebSocket stream closed');
            clearRunContext(runContext, runId);
          }
        };
      });

      if (!streamReady) {
        if (isRunContextCurrent(runContext)) {
          BOBO.updateRunOutput('Error: Failed to establish output stream (check server port 3101 and WS endpoint)');
          await cancelActiveRun();
        }
      }
    } catch (error) {
      if (isRunPreparationCurrent(runContext) || isRunContextCurrent(runContext)) {
        BOBO.updateRunOutput('Run error: ' + error.message);
      }
      finishRunPreparation(runContext);
      if (isRunContextCurrent(runContext)) await cancelActiveRun();
    }
  }

  // ──── Interactive stdin (input()/scanf/etc.) ────
  // 运行中显示输入框，用户输入文本按 Enter 后通过 WS 发送给进程的 stdin。

  function showStdinInput(socket) {
    var row = document.getElementById('stdin-input-row');
    var input = document.getElementById('stdin-input');
    if (!row || !input) return;
    row.style.display = '';
    input.value = '';
    input.disabled = false;

    // 移除旧监听器（避免累积绑定）
    var newInput = input.cloneNode(true);
    input.parentNode.replaceChild(newInput, input);

    newInput.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var text = newInput.value;
      if (!text && e.shiftKey) return; // 空行+Shift 不发送
      // 发送到服务端进程 stdin（追加换行符，模拟终端行为）
      var data = text + '\n';
      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'stdin', runId: S.activeRunId, data: data }));
        }
      } catch (err) {
        BOBO.updateRunOutput('[stdin send error: ' + err.message + ']');
      }
      // echo：在输出面板显示用户输入（本地回显，不靠服务端返回）
      BOBO.updateRunOutput('› ' + text);
      newInput.value = '';
    });

    // 点击输出区域时自动聚焦到输入框
    setTimeout(function() { newInput.focus(); }, 50);
  }

  function hideStdinInput() {
    var row = document.getElementById('stdin-input-row');
    if (row) row.style.display = 'none';
  }

  // ──── Server settings ────
  async function loadServerSettings() {
    try {
      S.serverSettings = await window.api.readServerSettings();
      if (BOBO.runtime) BOBO.runtime.fetchRuntimes();
      setupAutoSync();
    } catch (e) {}
  }

  async function checkRcloneAvailability() {
    try {
      var result = await BOBO.rclone.checkVersion();
      if (result.available) {
        BOBO.updateRunOutput('rclone available: ' + result.version);
      } else {
        BOBO.updateRunOutput('Warning: rclone not found - ' + result.error);
      }
    } catch (error) {
      BOBO.updateRunOutput('Error checking rclone: ' + error.message);
    }
  }

  BOBO.runner = {
    // Sync
    syncWithServer: syncWithServer,
    manualSyncWithServer: manualSyncWithServer,
    uploadWorkspace: uploadWorkspace,
    ensureWorkspaceSyncedForRun: ensureWorkspaceSyncedForRun,
    setupAutoSync: setupAutoSync,
    loadServerSettings: loadServerSettings,
    checkRcloneAvailability: checkRcloneAvailability,
    markWorkspaceChanged: markWorkspaceChanged,

    // Run
    runActive: runActive,
    runCodeOnServer: runCodeOnServer,
    runProjectTask: runProjectTask,
    stopActiveRun: stopActiveRun,
    prepareWorkspaceLeave: prepareWorkspaceLeave,
    invalidateRunIdentity: invalidateRunIdentity,
    isRunContextCurrent: isRunContextCurrent,
    isBusy: function() { return Boolean(activeRunPreparation || S.activeRunSocket || S.activeRunId || S.activeRunContext); },
    refreshWorkspaceTree: refreshWorkspaceTree
  };
})(window);
