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
  var cancellingRun = false;
  var syncedIdentityEpoch = S.runIdentityEpoch || 0;
  var taskExecutionSequence = 0;
  var activeTaskExecution = null;
  var lastProjectTask = null;

  function tr(source, replacements) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function cloudFeatureDecision(feature) {
    if (BOBO.cloudFeaturePolicy && typeof BOBO.cloudFeaturePolicy.evaluate === 'function') {
      return BOBO.cloudFeaturePolicy.evaluate(feature);
    }
    return { available: false, state: 'unknown', reason: 'policy_unavailable' };
  }

  function cloudFeatureUnavailableText(feature) {
    return feature === 'tasks'
      ? tr('Cloud tasks are unavailable on this server.')
      : tr('Cloud run is unavailable on this server.');
  }

  function bestEffort(callback) {
    try { return callback(); } catch (_) { return undefined; }
  }

  function runOutputOptions(options, runContext) {
    var scoped = Object.assign({}, options || {});
    if (runContext && runContext.outputSessionId !== undefined) scoped.sessionId = runContext.outputSessionId;
    return scoped;
  }

  function beginRunOutput(target, runContext) {
    if (BOBO.runOutput && typeof BOBO.runOutput.begin === 'function') {
      var sessionId = BOBO.runOutput.begin({ target: target });
      if (runContext) runContext.outputSessionId = sessionId;
      return sessionId;
    }
    BOBO.updateRunOutput('Preparing run: ' + target);
    return undefined;
  }

  function runOutputDetail(message, options, runContext) {
    if (BOBO.runOutput && typeof BOBO.runOutput.detail === 'function') {
      var handled = BOBO.runOutput.detail(message, runOutputOptions(options, runContext));
      if (handled !== false || runContext) return handled;
    }
    BOBO.updateRunOutput(message);
    return true;
  }

  function runOutputPhase(phase, message, options, runContext) {
    if (BOBO.runOutput && typeof BOBO.runOutput.phase === 'function') {
      return BOBO.runOutput.phase(phase, message, runOutputOptions(options, runContext));
    }
    if (message) BOBO.updateRunOutput(message);
    return true;
  }

  function finishRunOutput(options, runContext) {
    if (BOBO.runOutput && typeof BOBO.runOutput.finish === 'function') {
      return BOBO.runOutput.finish(runOutputOptions(options, runContext));
    }
    return false;
  }

  function cancelTaskInputPrompt() {
    if (BOBO.projectTasks && typeof BOBO.projectTasks.cancelInput === 'function') {
      bestEffort(function() { BOBO.projectTasks.cancelInput(); });
    }
  }

  function hasTaskProblemMatcher(taskExecution) {
    var matcher = taskExecution && taskExecution.problemMatcher;
    if (Array.isArray(matcher)) return matcher.length > 0;
    return Boolean(matcher);
  }

  function applyTaskPresentation(taskExecution) {
    var presentation = taskExecution && taskExecution.presentation || {};
    if (presentation.clear === true) BOBO.clearRunOutput();
    var reveal = presentation.reveal || 'always';
    var shouldReveal = reveal === 'always' || (reveal === 'silent' && !hasTaskProblemMatcher(taskExecution));
    if (!shouldReveal) return;
    if (typeof BOBO.switchToPanel === 'function') BOBO.switchToPanel('output');
    else if (BOBO.workbench && typeof BOBO.workbench.revealPanel === 'function') BOBO.workbench.revealPanel();
    if (presentation.focus === true) {
      var outputPanel = document.getElementById('panel-output');
      if (outputPanel && typeof outputPanel.focus === 'function') {
        if (typeof outputPanel.setAttribute === 'function') outputPanel.setAttribute('tabindex', '-1');
        outputPanel.focus();
      } else if (typeof document.querySelector === 'function') {
        var outputTab = document.querySelector('#panel-tabs .panel-tab[data-panel="output"]');
        if (outputTab && typeof outputTab.focus === 'function') outputTab.focus();
      }
    }
  }

  function echoTaskCommands(taskExecution) {
    (taskExecution && taskExecution.steps || []).forEach(function(step) {
      if (step && step.echo !== false && step.displayCommand) BOBO.updateRunOutput('$ ' + step.displayCommand);
    });
  }

  function cloudTaskExecution(taskExecution) {
    return {
      schemaVersion: taskExecution.schemaVersion,
      label: taskExecution.label,
      kind: taskExecution.kind,
      source: taskExecution.source,
      steps: (taskExecution.steps || []).map(function(step) {
        return {
          id: step.id,
          label: step.label,
          kind: step.kind,
          type: step.type,
          argv: Array.isArray(step.argv) ? step.argv.slice() : [],
          cwd: step.cwd,
          env: Object.assign({}, step.env || {}),
          dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.slice() : []
        };
      })
    };
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

  function createTaskExecutionHandle(label) {
    var resolveCompletion;
    var record = {
      id: 'task-execution-' + (++taskExecutionSequence),
      label: String(label || ''),
      state: 'preparing',
      runId: '',
      settled: false,
      cancelRequested: false,
      cancelled: false,
      runContext: null,
      completion: new Promise(function(resolve) { resolveCompletion = resolve; }),
      resolveCompletion: resolveCompletion
    };
    record.public = Object.freeze({
      id: record.id,
      label: record.label,
      completion: record.completion,
      cancel: function(reason) { return cancelTaskExecution(record, reason); },
      getState: function() {
        return Object.freeze({ state: record.state, runId: record.runId, cancelled: record.cancelRequested || record.cancelled });
      }
    });
    return record;
  }

  function settleTaskExecution(record, outcome) {
    if (!record || record.settled) return false;
    record.settled = true;
    outcome = outcome || {};
    var cancelled = outcome.cancelled === true;
    var success = outcome.success === true && !cancelled;
    record.cancelled = cancelled;
    record.state = cancelled ? 'cancelled' : (success ? 'completed' : 'failed');
    if (activeTaskExecution === record) activeTaskExecution = null;
    record.resolveCompletion(Object.freeze({
      success: success,
      returnCode: Number.isInteger(outcome.returnCode) ? outcome.returnCode : null,
      cancelled: cancelled,
      code: String(outcome.code || (success ? 'completed' : (cancelled ? 'cancelled' : 'failed'))),
      message: String(outcome.message || ''),
      runId: String(outcome.runId || record.runId || ''),
      label: record.label
    }));
    return true;
  }

  function settleTaskForContext(context, outcome) {
    return settleTaskExecution(context && context.taskExecutionHandle, outcome);
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
    var debugActive = Boolean(BOBO.dap && typeof BOBO.dap.isActive === 'function' && BOBO.dap.isActive());
    var unavailable = Boolean(S.workspaceTransitionLocked || cancellingRun || debugActive);
    var selection = BOBO.projectTasks && typeof BOBO.projectTasks.getSelected === 'function'
      ? BOBO.projectTasks.getSelected()
      : { type: 'file' };
    var runAvailable = cloudFeatureDecision('run').available;
    var tasksAvailable = cloudFeatureDecision('tasks').available;
    var selectedAvailable = selection.type === 'task' ? tasksAvailable : runAvailable;
    var stopButton = document.getElementById('stop-code');
    if (stopButton) { stopButton.disabled = true; stopButton.style.opacity = '0.5'; }
    var runButton = document.getElementById('run-code');
    if (runButton) runButton.disabled = unavailable || !selectedAvailable;
    var targetButton = document.getElementById('run-target-btn');
    if (targetButton) targetButton.disabled = unavailable || (!runAvailable && !tasksAvailable);
    var configButton = document.getElementById('run-config-btn');
    if (configButton) configButton.disabled = unavailable || selection.type === 'task' || !runAvailable;
    hideStdinInput();
  }

  function setRunControlsActive() {
    cancellingRun = false;
    var stopButton = document.getElementById('stop-code');
    if (stopButton) { stopButton.disabled = false; stopButton.style.opacity = '1'; }
    var runButton = document.getElementById('run-code');
    if (runButton) runButton.disabled = true;
    ['run-target-btn', 'run-config-btn'].forEach(function(id) {
      var control = document.getElementById(id);
      if (control) control.disabled = true;
    });
  }

  function refreshRunControls() {
    if (activeRunPreparation || S.activeRunSocket || S.activeRunId || S.activeRunContext) setRunControlsActive();
    else setRunControlsIdle();
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

    finishRunOutput({ success: false, cancelled: true, message: options.message || '' }, runContext);
    S.activeRunContext = null;
    S.activeRunCancelled = true;
    S.artifactInflight = new Map();
    S.activeRunSocket = null;
    S.activeRunId = null;
    settleTaskForContext(runContext, {
      success: false,
      cancelled: true,
      code: String(options.reason || 'cancelled'),
      message: String(options.message || ''),
      runId: runId
    });
    cancellingRun = true;
    // The cancellation request may take up to the HTTP fallback timeout.
    // Disable controls before awaiting it so Stop is visibly single-flight.
    setRunControlsIdle();
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
    cancellingRun = false;
    setRunControlsIdle();
    return true;
  }

  async function cancelTaskExecution(record, reason) {
    if (!record || record.settled) return false;
    record.cancelRequested = true;
    cancelTaskInputPrompt();
    var cancelReason = String(reason || 'cancelled');
    var context = record.runContext;
    if (context && activeRunPreparation === context) {
      finishRunOutput({ success: false, cancelled: true }, context);
      runPreparationSequence += 1;
      activeRunPreparation = null;
      setRunControlsIdle();
    }
    if (context && S.activeRunContext === context) {
      await cancelActiveRun({ reason: cancelReason });
      return true;
    }
    settleTaskExecution(record, {
      success: false,
      cancelled: true,
      code: cancelReason,
      message: tr('Project task was cancelled.')
    });
    return true;
  }

  async function prepareWorkspaceLeave(options) {
    cancelTaskInputPrompt();
    lastProjectTask = null;
    var preparingContext = activeRunPreparation;
    var preparingTask = preparingContext && preparingContext.taskExecutionHandle;
    finishRunOutput({ success: false, cancelled: true }, preparingContext);
    runPreparationSequence += 1;
    activeRunPreparation = null;
    settleTaskExecution(preparingTask, { success: false, cancelled: true, code: 'workspace-change', message: tr('Project task was cancelled.') });
    var cancelled = await cancelActiveRun(options);
    if (!cancelled) setRunControlsIdle();
    return cancelled;
  }

  async function invalidateRunIdentity(options) {
    cancelTaskInputPrompt();
    lastProjectTask = null;
    var preparingContext = activeRunPreparation;
    var preparingTask = preparingContext && preparingContext.taskExecutionHandle;
    finishRunOutput({ success: false, cancelled: true }, preparingContext);
    S.runIdentityEpoch = (S.runIdentityEpoch || 0) + 1;
    runPreparationSequence += 1;
    activeRunPreparation = null;
    settleTaskExecution(preparingTask, { success: false, cancelled: true, code: 'identity-change', message: tr('Project task was cancelled.') });
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
    settleTaskForContext(runContext, {
      success: false,
      code: 'stream-closed',
      message: tr('The project task output stream closed before reporting a result.'),
      runId: runId
    });
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
  async function ensureWorkspaceSyncedForRun(runContext) {
    if (syncPromise) await syncPromise;
    if (!canSyncCurrentWorkspace()) return false;
    if (syncedIdentityEpoch === (S.runIdentityEpoch || 0) && S.lastSyncedVersion === S.workspaceChangeVersion) {
      runOutputDetail('Workspace unchanged - using the existing server copy', { stage: 'sync' }, runContext);
      return true;
    }
    return startSync(true, runContext);
  }

  function startSync(verbose, runContext) {
    var operation = currentSyncIdentity();
    var syncStatusContext = BOBO.workspaceSyncStatus && BOBO.workspaceSyncStatus.beginSync({ force: verbose === true });
    syncInFlight = true;
    syncOperation = operation;
    var operationPromise = doSyncWithServerInternal(verbose, operation, runContext).then(function(result) {
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

  async function doSyncWithServerInternal(verbose, operation, runContext) {
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
        onProgress: verbose ? function(line) { runOutputDetail('Sync: ' + line, { stage: 'sync' }, runContext); } : undefined
      });
      if (S.workspaceRoot !== syncRoot || (S.workspaceGeneration || 0) !== syncGeneration ||
          (S.runIdentityEpoch || 0) !== syncIdentityEpoch) return false;

      if (!result.success) {
        if (verbose) BOBO.updateRunOutput('Sync failed: ' + result.error.message);
        if (result.error.type === 'BINARY_NOT_FOUND') {
          if (verbose) BOBO.updateRunOutput(tr('The bundled rclone is unavailable. Restart BOBOCLOUD or choose another installation in Server settings.'));
        } else if (result.error.type === 'AUTH_FAILED') {
          if (verbose) BOBO.updateRunOutput('Check server username/password in settings.');
        } else if (result.error.type === 'CONNECTION_FAILED') {
          if (verbose) BOBO.updateRunOutput('Ensure SFTP port 22 is open on the server.');
        }
        return false;
      }

      if (verbose) runOutputDetail('Sync completed - all files synced', { stage: 'sync' }, runContext);
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
    if (S.workspaceTransitionLocked) return false;
    var active = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    if (!active) {
      BOBO.updateRunOutput('Open a runnable source file before starting a run.');
      return false;
    }
    return runCodeOnServer(active.path);
  }

  // 中止当前运行：通过 WebSocket 发送 cancel 消息，服务端取消运行上下文
  async function stopActiveRun() {
    var preparingContext = activeRunPreparation;
    var hadPreparation = !!preparingContext;
    var preparingTask = preparingContext && preparingContext.taskExecutionHandle;
    if (hadPreparation) {
      runOutputDetail('[Stop] Cancelling run...', { stage: 'client' }, preparingContext);
      cancelTaskInputPrompt();
      runPreparationSequence += 1;
      activeRunPreparation = null;
      settleTaskExecution(preparingTask, { success: false, cancelled: true, code: 'user-cancelled', message: tr('Project task was cancelled.') });
      finishRunOutput({ success: false, cancelled: true }, preparingContext);
    }
    if (!hadPreparation && !S.activeRunSocket && !S.activeRunId && !S.activeRunContext) {
      BOBO.updateRunOutput('[Stop] No active run to stop');
      return;
    }
    if (!hadPreparation) runOutputDetail('[Stop] Cancelling run...', { stage: 'client' }, S.activeRunContext);
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
      taskRequest: hasExecutionPlan ? null : taskRequest,
      rememberForRerun: true
    });
  }

  function canRerunLastProjectTask() {
    return Boolean(lastProjectTask &&
      lastProjectTask.rootPath === S.workspaceRoot &&
      lastProjectTask.workspaceIdentity === S.workspaceIdentity &&
      lastProjectTask.generation === (S.workspaceGeneration || 0) &&
      lastProjectTask.identityEpoch === (S.runIdentityEpoch || 0));
  }

  function rerunLastProjectTask(context) {
    if (!canRerunLastProjectTask()) {
      BOBO.updateRunOutput(tr('No project task is available to rerun in this workspace.'));
      return false;
    }
    if (lastProjectTask.execution && lastProjectTask.execution.runOptions && lastProjectTask.execution.runOptions.reevaluateOnRerun === false) {
      return runProjectTask(lastProjectTask.execution);
    }
    return runProjectTask({
      label: lastProjectTask.label,
      context: context && typeof context === 'object' ? context : Object.assign({}, lastProjectTask.context || {})
    });
  }

  function startProjectTaskExecution(taskRequest, options) {
    options = options || {};
    var record = createTaskExecutionHandle(taskRequest && taskRequest.label);
    if (!taskRequest || !taskRequest.label || (typeof taskRequest.context !== 'object' && !Array.isArray(taskRequest.steps))) {
      settleTaskExecution(record, { success: false, code: 'invalid-task-request', message: tr('Error: Invalid project task request') });
      return record.public;
    }
    if (!S.selectedRuntime) {
      settleTaskExecution(record, { success: false, code: 'runtime-required', message: tr('Project tasks require a Docker runtime; Local cannot execute workspace tasks.') });
      return record.public;
    }
    if (activeTaskExecution && !activeTaskExecution.settled) {
      settleTaskExecution(record, { success: false, code: 'task-busy', message: tr('A run is already in progress. Stop it before starting another one.') });
      return record.public;
    }
    activeTaskExecution = record;
    Promise.resolve(runOnServer({
      filePath: null,
      taskExecution: Array.isArray(taskRequest.steps) ? taskRequest : null,
      taskRequest: Array.isArray(taskRequest.steps) ? null : taskRequest,
      taskExecutionHandle: record,
      owner: String(options.owner || 'internal')
    })).then(function(started) {
      if (started === false && !record.settled) {
        settleTaskExecution(record, { success: false, code: 'start-failed', message: tr('Project task could not be started.') });
      }
    }, function(error) {
      settleTaskExecution(record, { success: false, code: 'start-failed', message: error && error.message ? error.message : String(error || '') });
    });
    return record.public;
  }

  async function runOnServer(options) {
    options = options || {};
    var filePath = options.filePath;
    var taskExecution = options.taskExecution;
    var taskRequest = options.taskRequest;
    var executionHandle = options.taskExecutionHandle || null;
    var taskProblemSession = null;
    var presentationApplied = false;
    var isProjectTask = Boolean(taskExecution || taskRequest);
    var cloudFeature = isProjectTask ? 'tasks' : 'run';
    if (S.workspaceTransitionLocked) {
      settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'workspace-transition', message: tr('Project task was cancelled.') });
      return false;
    }
    if (BOBO.dap && BOBO.dap.isActive && BOBO.dap.isActive() && options.owner !== 'dap-lifecycle') {
      BOBO.updateRunOutput(tr('Cannot run code while a debug session is active.'));
      settleTaskExecution(executionHandle, { success: false, code: 'debug-active', message: tr('Cannot run code while a debug session is active.') });
      return false;
    }
    if (!cloudFeatureDecision(cloudFeature).available) {
      var unavailableMessage = cloudFeatureUnavailableText(cloudFeature);
      BOBO.updateRunOutput(unavailableMessage);
      settleTaskExecution(executionHandle, { success: false, code: 'feature-disabled', message: unavailableMessage });
      return false;
    }
    if (!S.workspaceRoot || !S.serverSettings.ip) {
      BOBO.updateRunOutput('Error: Workspace not opened or server not configured');
      settleTaskExecution(executionHandle, { success: false, code: 'workspace-or-server-missing', message: tr('Workspace not opened or server not configured') });
      return false;
    }

    // 多人模式下未登录：云编译（含 Local 直跑）需要登录态，直接拦截并提示
    if (S.auth && S.auth.mode === 'multi' && !(S.auth.token && S.auth.user)) {
      BOBO.updateRunOutput('Error: Account not logged in. Cloud compile requires login - click the account button in the status bar to log in.');
      if (BOBO.auth && typeof BOBO.auth.openAuthModal === 'function') {
        BOBO.auth.openAuthModal('Cloud compile requires login');
      }
      settleTaskExecution(executionHandle, { success: false, code: 'unauthorized', message: tr('Account not logged in. Cloud compile requires login.') });
      return false;
    }

    var runContext = createRunContext();
    runContext.feature = cloudFeature;
    runContext.taskExecutionHandle = executionHandle;
    if (executionHandle) executionHandle.runContext = runContext;
    var projectName = runContext.rootPath.split(/[/\\]/).pop();
    var relativeFilePath = isProjectTask ? '' : filePath.replace(runContext.rootPath, '').replace(/^[/\\]/, '');
    var rcLang = !isProjectTask && BOBO.runConfig ? BOBO.runConfig.languageForFile(relativeFilePath) : null;
    if (!isProjectTask && BOBO.runConfig && !rcLang) {
      BOBO.updateRunOutput('Error: This file type is not runnable. Open a C, C++, Java, Go, Rust, Python, or JavaScript file.');
      return;
    }
    if (activeRunPreparation || S.activeRunSocket || S.activeRunId || S.activeRunContext) {
      BOBO.updateRunOutput(tr('A run is already in progress. Stop it before starting another one.'));
      settleTaskExecution(executionHandle, { success: false, code: 'run-busy', message: tr('A run is already in progress. Stop it before starting another one.') });
      return false;
    }
    beginRunPreparation(runContext);

    if (!isProjectTask) {
      BOBO.clearRunOutput();
      beginRunOutput(relativeFilePath, runContext);
    } else {
      beginRunOutput((taskExecution && taskExecution.label) || (taskRequest && taskRequest.label), runContext);
    }
    if (taskExecution) {
      applyTaskPresentation(taskExecution);
      presentationApplied = true;
      runOutputDetail(tr('Preparing project task: {task}', { task: taskExecution.label }), { stage: 'client' }, runContext);
    }

    // Save before running
    var tab = !isProjectTask && S.tabs.find(function(t) { return t.path === filePath; });
    var needsSave = isProjectTask ? S.tabs.some(function(candidate) { return candidate.dirty; }) : Boolean(tab && tab.dirty);
    if (needsSave) {
      if (BOBO.workspace) {
        var saved = isProjectTask && BOBO.workspace.saveAllTabs
          ? await BOBO.workspace.saveAllTabs()
          : await BOBO.workspace.saveActiveTab();
        if (!isRunPreparationCurrent(runContext)) {
          finishRunOutput({ success: false, cancelled: true }, runContext);
          settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.') });
          return false;
        }
        if (!saved) {
          finishRunPreparation(runContext);
          finishRunOutput({ success: false, message: tr('Project files could not be saved.') }, runContext);
          BOBO.updateRunOutput(isProjectTask
            ? tr('Error: Project files could not be saved, so the task was cancelled.')
            : 'Error: The active file could not be saved, so the run was cancelled.');
          settleTaskExecution(executionHandle, { success: false, code: 'save-failed', message: tr('Project files could not be saved.') });
          return false;
        }
        // File watcher delivery is asynchronous. Mark this save immediately so
        // the pre-run version check can never race ahead of the watcher event.
        markWorkspaceChanged();
      }
    }

    if (taskRequest) {
      try {
        var resolvedTask = await global.api.tasksResolve(taskRequest.label, taskRequest.context || {}, undefined);
        if (!isRunPreparationCurrent(runContext)) {
          finishRunOutput({ success: false, cancelled: true }, runContext);
          settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.') });
          return false;
        }
        if (resolvedTask && resolvedTask.inputRequired && Array.isArray(resolvedTask.inputRequests)) {
          var inputValues = BOBO.projectTasks && typeof BOBO.projectTasks.resolveInputRequests === 'function'
            ? await BOBO.projectTasks.resolveInputRequests(resolvedTask.inputRequests)
            : null;
          if (!isRunPreparationCurrent(runContext)) {
            finishRunOutput({ success: false, cancelled: true }, runContext);
            settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.') });
            return false;
          }
          if (inputValues === null) {
            finishRunPreparation(runContext);
            finishRunOutput({ success: false, cancelled: true }, runContext);
            BOBO.updateRunOutput(tr('Project task was cancelled.'));
            settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'input-cancelled', message: tr('Project task was cancelled.') });
            return false;
          }
          resolvedTask = await global.api.tasksResolve(taskRequest.label, taskRequest.context || {}, inputValues);
          if (!isRunPreparationCurrent(runContext)) {
            finishRunOutput({ success: false, cancelled: true }, runContext);
            settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.') });
            return false;
          }
        }
        if (!resolvedTask || !resolvedTask.success || !resolvedTask.execution) {
          var taskError = resolvedTask && resolvedTask.error || { code: 'TASK_RESOLVE_FAILED', message: 'Unknown task resolution error' };
          finishRunPreparation(runContext);
          finishRunOutput({ success: false, message: taskError.message }, runContext);
          BOBO.updateRunOutput(tr('Task could not be resolved [{code}]: {message}', {
            code: taskError.code,
            message: taskError.message
          }));
          settleTaskExecution(executionHandle, { success: false, code: taskError.code, message: taskError.message });
          return false;
        }
        taskExecution = resolvedTask.execution;
        applyTaskPresentation(taskExecution);
        presentationApplied = true;
        runOutputDetail(tr('Preparing project task: {task}', { task: taskExecution.label }), { stage: 'client' }, runContext);
      } catch (error) {
        var taskResolutionCurrent = isRunPreparationCurrent(runContext);
        finishRunPreparation(runContext);
        finishRunOutput({ success: false, message: error.message }, runContext);
        if (taskResolutionCurrent) {
          BOBO.updateRunOutput(tr('Error: Task configuration could not be loaded: {message}', { message: error.message }));
        }
        settleTaskExecution(executionHandle, { success: false, code: 'task-resolve-failed', message: error.message });
        return false;
      }
    }

    if (taskExecution && options.rememberForRerun) {
      lastProjectTask = {
        rootPath: runContext.rootPath,
        workspaceIdentity: runContext.workspaceIdentity,
        generation: runContext.generation,
        identityEpoch: runContext.identityEpoch,
        label: taskExecution.label,
        context: Object.assign({}, taskRequest && taskRequest.context || {}),
        execution: taskExecution
      };
    }
    if (taskExecution && !presentationApplied) applyTaskPresentation(taskExecution);

    if (taskExecution && BOBO.taskProblemMatcher && BOBO.taskProblemMatcher.begin) {
      taskProblemSession = BOBO.taskProblemMatcher.begin(taskExecution);
    }

    try {
      runOutputPhase('syncing', '', null, runContext);
      var syncSuccess = await ensureWorkspaceSyncedForRun(runContext);
      if (!isRunPreparationCurrent(runContext)) {
        finishRunOutput({ success: false, cancelled: true }, runContext);
        settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.') });
        return false;
      }
      if (!syncSuccess) {
        finishRunPreparation(runContext);
        finishRunOutput({ success: false, message: tr('Workspace synchronization failed.') }, runContext);
        BOBO.updateRunOutput('Error: Failed to sync with server before running');
        settleTaskExecution(executionHandle, { success: false, code: 'sync-failed', message: tr('Workspace synchronization failed.') });
        return false;
      }

      var runId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'run-' + Date.now();

      // 读取当前语言的运行配置（编译参数 / 程序参数，按 工作区×语言 记忆）
      var rc = (BOBO.runConfig && rcLang) ? BOBO.runConfig.getArgs(rcLang) : { compileArgs: [], runArgs: [], buildTarget: '' };

      await cancelActiveRun();
      if (!isRunPreparationCurrent(runContext)) {
        finishRunOutput({ success: false, cancelled: true }, runContext);
        settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.') });
        return false;
      }

      S.activeRunContext = runContext;
      S.activeRunSocket = null;
      S.activeRunId = runId;
      if (executionHandle) {
        executionHandle.runId = runId;
        executionHandle.state = 'running';
      }
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
          finishRunOutput({ success: false, message: error.message }, runContext);
          settleTaskExecution(executionHandle, { success: false, code: 'artifact-context-failed', message: error.message, runId: runId });
          await clearRunContext(runContext, runId);
          BOBO.updateRunOutput('Run error: ' + error.message);
          return false;
        }
      }
      if (!isRunContextCurrent(runContext)) {
        finishRunOutput({ success: false, cancelled: true }, runContext);
        settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.'), runId: runId });
        return false;
      }
      setRunControlsActive();

      runOutputPhase('runtime', taskExecution
        ? tr('Running project task: {task}', { task: taskExecution.label })
        : 'Running code: ' + relativeFilePath, { stage: 'client' }, runContext);
      if (taskExecution) echoTaskCommands(taskExecution);
      if (!taskExecution && rc.compileArgs.length > 0) runOutputDetail('Compile args: ' + rc.compileArgs.join(' '), { stage: 'client' }, runContext);
      if (!taskExecution && rc.runArgs.length > 0) runOutputDetail('Program args: ' + rc.runArgs.join(' '), { stage: 'client' }, runContext);
      if (!taskExecution && rc.buildTarget) {
        var targetLabel = BOBO.runConfig && BOBO.runConfig.describeTarget ? BOBO.runConfig.describeTarget(rc.buildTarget) : rc.buildTarget;
        runOutputDetail(tr('Build target: {target}', { target: targetLabel }), { stage: 'client' }, runContext);
      }

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
        // Matchers, presentation and rerun state are renderer-only. The cloud
        // runner receives only the resolved execution DAG.
        requestPayload.task = cloudTaskExecution(taskExecution);
      } else {
        requestPayload.filePath = relativeFilePath;
        requestPayload.compileArgs = rc.compileArgs.length > 0 ? rc.compileArgs : undefined;
        requestPayload.runArgs = rc.runArgs.length > 0 ? rc.runArgs : undefined;
        requestPayload.buildTarget = rc.buildTarget || undefined;
      }
      var runResult = await BOBO.sendToServer(taskExecution ? 'runTask' : 'runCode', requestPayload);
      if (!isRunContextCurrent(runContext)) {
        settleTaskExecution(executionHandle, { success: false, cancelled: true, code: 'context-changed', message: tr('Project task was cancelled.'), runId: runId });
        return false;
      }

      if (!runResult) {
        BOBO.updateRunOutput('Error: Failed to get run result from server');
        finishRunOutput({ success: false, message: tr('Failed to get a run response from the server.') }, runContext);
        settleTaskExecution(executionHandle, { success: false, code: 'empty-run-response', message: tr('Failed to get a run response from the server.'), runId: runId });
        await cancelActiveRun();
        return false;
      }

      if (!runResult.success) {
        BOBO.updateRunOutput('\n=== RUN FAILED ===');
        if (runResult.error) BOBO.updateRunOutput('Error: ' + runResult.error);
        finishRunOutput({ success: false, message: String(runResult.error || '') }, runContext);
        settleTaskExecution(executionHandle, { success: false, code: String(runResult.code || 'run-rejected'), message: String(runResult.error || ''), runId: runId });
        await cancelActiveRun();
        return false;
      }

      // WebSocket streaming
      var token = runResult.token;
      var wsPath = runResult.wsPath || '/ws';
      var wsUrl = BOBO.serverTransport && BOBO.serverTransport.websocket
        ? BOBO.serverTransport.websocket(S.serverSettings, wsPath, 'ws')
        : 'ws://' + S.serverSettings.ip + ':3101' + wsPath;

      var streamReady = await new Promise(function(resolve) {
        var settled = false;
        var socket = new WebSocket(wsUrl);
        if (!isRunContextCurrent(runContext)) { socket.close(); resolve(false); return; }
        S.activeRunSocket = socket;
        var artifactWrites = [];
        var artifactFailures = 0;
        var artifactPaths = new Set();
        var artifactFinalization = Promise.resolve();
        var resultReceived = false;
        var streamErrorReported = false;
        var lastRunError = '';
        var terminalFinalization = null;

        var timeoutId = setTimeout(function() {
          if (settled) return;
          settled = true;
          streamErrorReported = true;
          BOBO.updateRunOutput('WebSocket connect timeout');
          finishRunOutput({ success: false, message: tr('The output stream connection timed out.') }, runContext);
          try { socket.close(); } catch (e) {}
          resolve(false);
        }, 8000);

        socket.onopen = function() {
          clearTimeout(timeoutId);
          if (!isRunContextCurrent(runContext)) { socket.close(); resolve(false); return; }
          try { socket.send(JSON.stringify({ type: 'attach', runId: runId, token: token })); } catch (e) {}
          settled = true;
          S.activeRunCancelled = false; // 重置取消标志
          runOutputDetail('WebSocket stream connected', { stage: 'transport' }, runContext);
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
              if (BOBO.runOutput && typeof BOBO.runOutput.handleStatus === 'function') BOBO.runOutput.handleStatus(payload, runContext.outputSessionId);
              else BOBO.updateRunOutput(payload.message);
              // run 步骤开始：启动兜底计时器（300ms 后若无 stdout 则显示输入框）
              if (payload.stage && ((!taskExecution && payload.stage.indexOf('run:') === 0) || payload.stage === interactiveTaskStage) && !stdinShown) {
                stdinFallbackTimer = setTimeout(showStdinOnce, 300);
              }
            }
            if (payload.type === 'stdout' && payload.line !== undefined && !S.activeRunCancelled) {
              if (String(payload.stage || '') === 'setup') runOutputDetail(payload.line, { stage: 'setup' }, runContext);
              else BOBO.updateRunOutput(payload.line);
              if (taskProblemSession) taskProblemSession.consume(payload.line, payload.stage);
              // 程序有输出（如 input() 的提示文字）：立即显示输入框
              if (!taskExecution || payload.stage === interactiveTaskStage) showStdinOnce();
            }
            if (payload.type === 'stderr' && payload.line !== undefined && !S.activeRunCancelled) {
              BOBO.updateRunOutput('[stderr] ' + payload.line);
              if (taskProblemSession) taskProblemSession.consume(payload.line, payload.stage);
            }
            if (payload.type === 'artifact') {
              if (payload.path) artifactPaths.add(String(payload.path));
              var write = handleArtifactChunk(payload, runContext);
              if (write) {
                artifactWrites.push(Promise.resolve(write).catch(function(err) {
                  artifactFailures += 1;
                  BOBO.updateRunOutput('Artifact save failed: ' + err.message);
                }));
              }
            }
            if (payload.type === 'artifactsComplete') {
              artifactFinalization = Promise.all(artifactWrites).then(async function() {
                if (!isRunContextCurrent(runContext)) return;
                if (artifactFailures > 0) {
                  BOBO.updateRunOutput(tr('Artifacts completed with {count} save error(s).', { count: artifactFailures }));
                } else if (artifactPaths.size > 0) {
                  runOutputPhase('artifacts', tr('Artifacts processed: {count}', { count: artifactPaths.size }), { stage: 'artifact' }, runContext);
                }
                try {
                  await refreshWorkspaceTree(runContext);
                } catch (error) {
                  BOBO.updateRunOutput('Workspace refresh failed: ' + error.message);
                }
              });
              await artifactFinalization;
            }
            if (payload.type === 'result') {
              if (terminalFinalization) {
                await terminalFinalization;
                return;
              }
              resultReceived = true;
              terminalFinalization = (async function() {
                await artifactFinalization;
                await Promise.all(artifactWrites);
                if (!isRunContextCurrent(runContext)) return;
                var artifactMessage = artifactFailures > 0
                  ? tr('Run completed, but {count} artifact(s) could not be saved.', { count: artifactFailures })
                  : '';
                var finalSuccess = payload.success === true && artifactFailures === 0;
                var finalMessage = artifactMessage || String(payload.message || lastRunError || '');
                settleTaskExecution(executionHandle, {
                  success: finalSuccess,
                  returnCode: Number(payload.returncode),
                  code: finalSuccess ? 'completed' : (artifactFailures > 0 ? 'artifact-save-failed' : 'task-failed'),
                  message: finalMessage,
                  runId: runId
                });
                bestEffort(function() {
                  finishRunOutput({ success: finalSuccess, returnCode: Number(payload.returncode), message: finalMessage }, runContext);
                });
                bestEffort(function() {
                  if (!BOBO.environmentActivity || typeof BOBO.environmentActivity.record !== 'function') return;
                  BOBO.environmentActivity.record('compile', { outcome: finalSuccess ? 'completed' : 'failed' });
                  if (payload.success && S.setupCommands.length > 0) BOBO.environmentActivity.record('install', { outcome: 'completed' });
                });
                bestEffort(function() {
                  if (S.setupCommands.length > 0 && BOBO.lsp && typeof BOBO.lsp.dependenciesChanged === 'function') BOBO.lsp.dependenciesChanged();
                });
                if (stdinFallbackTimer) { clearTimeout(stdinFallbackTimer); stdinFallbackTimer = null; }
                bestEffort(hideStdinInput);
                bestEffort(function() { if (taskProblemSession) taskProblemSession.finish(); });
                try { await clearRunContext(runContext, runId); } finally { try { socket.close(); } catch (_) {} }
              })();
              await terminalFinalization;
            }
            if (payload.type === 'error' && payload.message) {
              if (terminalFinalization) {
                await terminalFinalization;
                return;
              }
              resultReceived = true;
              streamErrorReported = true;
              lastRunError = String(payload.message);
              terminalFinalization = (async function() {
                await artifactFinalization;
                if (!isRunContextCurrent(runContext)) return;
                settleTaskExecution(executionHandle, { success: false, code: String(payload.code || 'stream-error'), message: payload.message, runId: runId });
                bestEffort(function() { finishRunOutput({ success: false, message: lastRunError }, runContext); });
                bestEffort(function() { BOBO.updateRunOutput('Error: ' + payload.message); });
                bestEffort(function() { if (taskProblemSession) taskProblemSession.finish(); });
                try { await clearRunContext(runContext, runId); } finally { try { socket.close(); } catch (_) {} }
              })();
              await terminalFinalization;
            }
          } catch (error) {
            bestEffort(function() { BOBO.updateRunOutput('Stream parse error: ' + error.message); });
          }
        };

        socket.onerror = function() {
          clearTimeout(timeoutId);
          if (!settled) { settled = true; resolve(false); }
          if (isRunContextCurrent(runContext) && !resultReceived && !streamErrorReported) {
            streamErrorReported = true;
            BOBO.updateRunOutput('WebSocket stream error');
            finishRunOutput({ success: false, message: tr('The output stream was interrupted.') }, runContext);
          }
        };

        socket.onclose = function() {
          clearTimeout(timeoutId);
          if (!settled) { settled = true; resolve(false); }
          if (stdinFallbackTimer) { clearTimeout(stdinFallbackTimer); stdinFallbackTimer = null; }
          if (terminalFinalization) {
            Promise.resolve(terminalFinalization).catch(function(error) {
              bestEffort(function() { BOBO.updateRunOutput('Run finalization failed: ' + error.message); });
            });
            return;
          }
          if (isRunContextCurrent(runContext)) {
            var cleanup = clearRunContext(runContext, runId);
            if (!resultReceived && !S.activeRunCancelled && !streamErrorReported) {
              streamErrorReported = true;
              bestEffort(function() { BOBO.updateRunOutput('Error: The output stream closed before the run result was received.'); });
              bestEffort(function() { finishRunOutput({ success: false, message: lastRunError || tr('The output stream closed before the run result was received.') }, runContext); });
            }
            bestEffort(function() { if (taskProblemSession) taskProblemSession.finish(); });
            Promise.resolve(cleanup).catch(function(error) {
              bestEffort(function() { BOBO.updateRunOutput('Run cleanup failed: ' + error.message); });
            });
          }
        };
      });

      if (!streamReady) {
        settleTaskExecution(executionHandle, { success: false, code: 'stream-connect-failed', message: tr('Failed to establish the project task output stream.'), runId: runId });
        finishRunOutput({ success: false, message: tr('Failed to establish the project task output stream.') }, runContext);
        if (isRunContextCurrent(runContext)) {
          BOBO.updateRunOutput('Error: Failed to establish output stream (check server port 3101 and WS endpoint)');
          await cancelActiveRun();
        }
        if (taskProblemSession) taskProblemSession.finish();
      }
      return streamReady;
    } catch (error) {
      if (isRunPreparationCurrent(runContext) || isRunContextCurrent(runContext)) {
        BOBO.updateRunOutput('Run error: ' + error.message);
      }
      finishRunOutput({ success: false, message: error.message }, runContext);
      finishRunPreparation(runContext);
      settleTaskExecution(executionHandle, { success: false, code: 'run-error', message: error.message, runId: executionHandle && executionHandle.runId });
      if (isRunContextCurrent(runContext)) await cancelActiveRun();
      if (taskProblemSession) taskProblemSession.finish();
      return false;
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
    canRerunLastProjectTask: canRerunLastProjectTask,
    rerunLastProjectTask: rerunLastProjectTask,
    startProjectTaskExecution: startProjectTaskExecution,
    stopActiveRun: stopActiveRun,
    prepareWorkspaceLeave: prepareWorkspaceLeave,
    invalidateRunIdentity: invalidateRunIdentity,
    isRunContextCurrent: isRunContextCurrent,
    isBusy: function() { return Boolean(activeRunPreparation || S.activeRunSocket || S.activeRunId || S.activeRunContext); },
    refreshControls: refreshRunControls,
    refreshWorkspaceTree: refreshWorkspaceTree
  };

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('bobo:server-capabilities-changed', function() {
      var context = activeRunPreparation || S.activeRunContext;
      if (context && !cloudFeatureDecision(context.feature || 'run').available) {
        stopActiveRun();
        return;
      }
      if (!activeRunPreparation && !S.activeRunContext && !S.activeRunId && !S.activeRunSocket) setRunControlsIdle();
    });
  }
})(window);
