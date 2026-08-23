// src/app.js - Main entry point, wires everything together.
// CRITICAL: language preference and require.config must resolve before Monaco.
(async function bootstrap() {
  function preloadMonacoLocale(locale) {
    var bundled = ['cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'zh-cn', 'zh-tw'];
    if (!locale || bundled.indexOf(locale) < 0) return Promise.resolve('');
    return new Promise(function(resolve) {
      var script = document.createElement('script');
      script.src = './node_modules/monaco-editor/min/vs/nls.messages.' + locale + '.js.js';
      script.onload = function() { script.remove(); resolve(locale + '.js'); };
      script.onerror = function() { script.remove(); resolve(''); };
      document.head.appendChild(script);
    });
  }

  var loaderConfig = { paths: { 'vs': './node_modules/monaco-editor/min/vs' } };
  try {
    if (window.BOBO && window.BOBO.i18n) {
      await window.BOBO.i18n.init();
      var monacoLocale = window.BOBO.i18n.getMonacoLocale();
      if (monacoLocale) {
        // Monaco 0.55's AMD distribution publishes locale modules as
        // `nls.messages.<locale>.js.js`. Pre-register the existing module so
        // the loader does not request the single-suffix path.
        var monacoModuleLocale = await preloadMonacoLocale(monacoLocale);
        if (monacoModuleLocale) loaderConfig['vs/nls'] = { availableLanguages: { '*': monacoModuleLocale } };
      }
    }
  } catch (error) {
    console.error('Language pack bootstrap:', error);
  }
  require.config(loaderConfig);

  require(['vs/editor/editor.main'], async function(_monaco) {
  // _monaco is the AMD-loaded module; also available as window.monaco.
  var monacoInstance = _monaco || window.monaco;
  var BOBO = window.BOBO;
  if (!BOBO) { console.error('BOBO namespace missing'); return; }
  var S = BOBO.state;
  if (!S)   { console.error('BOBO.state missing'); return; }

  // Restore the workbench geometry before Monaco measures its container.
  try { if (BOBO.workbench) BOBO.workbench.init(); } catch (e) { console.error('workbench init:', e); }

  // ── Phase 1: Create editor ──
  try {
    BOBO.editorCore.init(monacoInstance);
  } catch (e) {
    console.error('Editor init failed:', e);
    return;
  }

  // ── Phase 2: Load server settings (also fetches runtimes) ──
  try { await BOBO.runner.loadServerSettings(); } catch (e) { console.error('loadServerSettings:', e); }

  // Team entry points must remain interactive while auth detection waits for
  // a slow or unreachable server.
  try { BOBO.collaboration.init(); } catch (e) { console.error('collaboration init:', e); }
	try { if (BOBO.accountProfile) BOBO.accountProfile.init(); } catch (e) { console.error('account profile init:', e); }

  // Bundled rclone detection is entirely local. Bind it before the auth probe
  // so Server Settings remains useful even when the remote server is slow.
  try { initializeRcloneStatusControls(); } catch (e) { console.error('rclone status init:', e); }

  // ── Phase 2.5: Auth — 探测单机/多人模式；多人模式用本地计时凭证免登，
  //    无有效凭证则弹出登录/注册窗口（本地编辑功能不受影响）
  try { await BOBO.auth.init(); } catch (e) { console.error('auth init:', e); }

  // ── Phase 3: Runtime selector ──
  try { BOBO.runtime.init(); } catch (e) { console.error('runtime init:', e); }

  // Register remote providers after authentication. Credentials stay behind
  // preload and are resolved by the main process for each connection.
  try { await BOBO.lsp.init(monacoInstance); } catch (e) { console.error('LSP init:', e); }

  // ── Phase 4: Terminal ──
  try { BOBO.terminal.init(); } catch (e) { console.error('terminal init:', e); }

  // Project environment diagnosis is event-driven and becomes active only
  // after auth, runtime, LSP, and terminal workflows are ready.
  try { if (BOBO.environmentCenter) BOBO.environmentCenter.init(); } catch (e) { console.error('environment center init:', e); }

  // ── Phase 5: Output panel tabs ──
  try { BOBO.outputPanel.init(); } catch (e) { console.error('outputPanel init:', e); }

  // ── Phase 5.5: Run configuration (compile & program args popover) ──
  try { BOBO.runConfig.init(); } catch (e) { console.error('runConfig init:', e); }
  try { if (BOBO.projectTasks) BOBO.projectTasks.init(); } catch (e) { console.error('projectTasks init:', e); }
  try { if (BOBO.dap) BOBO.dap.init(monacoInstance); } catch (e) { console.error('debug adapter init:', e); }

  // ── Phase 5.6: Server Projects panel ──
  try { BOBO.projects.init(); } catch (e) { console.error('projects init:', e); }

  // ── Phase 6: Views (theme, image-preview, diff close) ──
  try { BOBO.views.init(); } catch (e) { console.error('views init:', e); }
  try { if (BOBO.documentViews) BOBO.documentViews.init(); } catch (e) { console.error('document views init:', e); }

  // ── Phase 7: Resizers ──
  if (!BOBO.workbench) {
    try { BOBO.workspace.setupSidebarResizer(); } catch (e) { console.error('sidebarResizer:', e); }
    try { BOBO.outputPanel.setupOutputResizer(); } catch (e) { console.error('outputResizer:', e); }
  }

  // ── Phase 8: Global keyboard handler (bound once, not per-tab) ──
  try { BOBO.workspace.setupGlobalKeys(); } catch (e) { console.error('globalKeys:', e); }

  // ── Phase 9: AI Agent modules ──
  try { await BOBO.aiService.init(); } catch (e) { console.error('aiService:', e); }
  try { BOBO.aiChatPanel.init(); } catch (e) { console.error('aiChatPanel:', e); }
  try { BOBO.aiAgentButton.init(); } catch (e) { console.error('aiAgentButton:', e); }
  try { BOBO.aiInline.init(monacoInstance); } catch (e) { console.error('aiInline:', e); }

  // ═══════════════════════════════════════
  //  UI BUTTON HANDLERS
  // ═══════════════════════════════════════

  async function applyOpenedWorkspace(res) {
    if (!res) return false;
    var applied = await BOBO.workspace.applyWorkspace(res.rootPath, res.tree, res.workspaceIdentity, res.leaveToken);
    if (!applied) return false;
    if (BOBO.collaboration) {
      if (res.teamMapping) BOBO.collaboration.restoreMapping(res.teamMapping, res.rootPath);
      else BOBO.collaboration.clearCurrent();
    }
    return true;
  }

  // Requests from the first painted frame are buffered until workspace/editor
  // services can apply the selected tree without losing the user's click.
  if (BOBO.workspaceLaunch) await BOBO.workspaceLaunch.setConsumer(applyOpenedWorkspace);

  var cloudSyncButton = document.getElementById('cloud-sync-btn');
  if (cloudSyncButton) {
    cloudSyncButton.addEventListener('click', async function() {
      var label = cloudSyncButton.querySelector('span');
      cloudSyncButton.disabled = true;
      if (label) label.textContent = 'Syncing...';
      try {
        var uploaded = await BOBO.runner.uploadWorkspace();
        if (!uploaded) throw new Error('Workspace synchronization failed. Check the Output panel for details.');
        var teamProject = S.collaboration && S.collaboration.current;
        if (BOBO.toast) BOBO.toast.success(teamProject ? 'Uploaded to your team cloud worktree. Commit & push when ready.' : 'Workspace synchronized');
        if (teamProject && BOBO.collaboration) await BOBO.collaboration.refreshWorkbench();
      } catch (error) {
        if (BOBO.toast) BOBO.toast.error(error.message);
      } finally {
        cloudSyncButton.disabled = false;
        if (label) label.textContent = 'Sync';
      }
    });
  }

  // Run button
  document.getElementById('run-code').addEventListener('click', function() {
    try {
      if (BOBO.projectTasks) BOBO.projectTasks.runSelected();
      else BOBO.runner.runActive();
    } catch (e) { console.error('run:', e); }
  });

  // Stop button - 中止当前运行
  document.getElementById('stop-code').addEventListener('click', function() {
    try { BOBO.runner.stopActiveRun(); } catch (e) { console.error('stop:', e); }
  });

  // History button + modal
  document.getElementById('history-btn').addEventListener('click', function() {
    try { loadAndShowHistory(); } catch (e) { console.error('history:', e); }
  });
  document.getElementById('history-close').addEventListener('click', function() {
    document.getElementById('history-modal').style.display = 'none';
  });

  async function loadAndShowHistory() {
    var modal = document.getElementById('history-modal');
    var list = document.getElementById('history-list');
    var detail = document.getElementById('history-detail');
    list.innerHTML = '<div class="history-empty">Loading...</div>';
    detail.style.display = 'none';
    modal.style.display = 'flex';
    var res = await BOBO.sendToServer('listRunHistory');
    if (!res || !res.success || !res.history || res.history.length === 0) {
      list.innerHTML = '<div class="history-empty">No run history yet.</div>';
      return;
    }
    list.innerHTML = '';
    res.history.forEach(function(rec) {
      function historyText(source, replacements) {
        return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(source, replacements) : source.replace(/\{([^}]+)\}/g, function(match, key) {
          return replacements && replacements[key] !== undefined ? replacements[key] : match;
        });
      }
      var kindKeys = { build: 'Build', test: 'Test', run: 'Run', custom: 'Custom' };
      var statusKeys = { completed: 'Completed', failed: 'Failed', timed_out: 'Timed out', cancelled: 'Cancelled' };
      var target = rec.file_path || '?';
      if (rec.target_type === 'task' && rec.task_label) {
        target = historyText('{kind} task: {label}', {
          kind: historyText(kindKeys[rec.task_kind] || 'Custom'),
          label: rec.task_label
        });
      }
      var row = document.createElement('div');
      row.className = 'history-row';
      var statusColor = rec.status === 'completed' ? 'var(--green)' : (rec.status === 'timed_out' ? 'var(--yellow)' : 'var(--red)');
      var time = rec.created_at ? new Date(rec.created_at).toLocaleString() : '';
      var status = document.createElement('span');
      status.className = 'history-row-status';
      status.style.color = statusColor;
      status.textContent = '\u25cf';
      var targetElement = document.createElement('span');
      targetElement.className = 'history-row-file';
      targetElement.textContent = target;
      var metadata = document.createElement('span');
      metadata.className = 'history-row-meta';
      metadata.textContent = '[' + (rec.runtime || 'local') + '] ' + historyText(statusKeys[rec.status] || rec.status || 'Failed') +
        ' rc=' + rec.exit_code + ' ' + (rec.duration_ms || 0) + 'ms ' + time;
      row.append(status, document.createTextNode(' '), targetElement, document.createTextNode(' '), metadata);
      row.onclick = function() {
        var output = rec.output_summary || '(no output captured)';
        if (rec.output_truncated) {
          output = historyText('Earlier output was not retained.') + '\n\n' + output;
        }
        document.getElementById('history-detail-output').textContent = output;
        detail.style.display = 'block';
      };
      list.appendChild(row);
    });
  }

  // ── IPC events ──

  window.api.onWorkspaceLeaveRequest(async function(request) {
    var allowed = false;
    try {
      allowed = await BOBO.workspace.canLeaveWorkspace({
        reason: request.reason,
        targetRoot: request.targetRoot,
        leaveToken: request.leaveToken
      });
    } catch (e) {
      console.error('workspace leave:', e);
    }
    window.api.respondWorkspaceLeave(request.requestId, allowed);
  });

  window.api.onWorkspaceLeaveAborted(function(request) {
    try {
      if (BOBO.workspace && BOBO.workspace.abortWorkspaceLeave) {
        BOBO.workspace.abortWorkspaceLeave(request && request.leaveToken);
      }
    } catch (e) { console.error('workspace leave abort:', e); }
  });

  // Workspace refresh from main process (full rebuild — used for debounced watcher)
  window.api.onWorkspaceRefresh(function(data) {
    try {
      if (data.rootPath === S.workspaceRoot && data.workspaceIdentity === S.workspaceIdentity) {
        BOBO.workspace.renderTree(data.tree);
        if (BOBO.runner && BOBO.runner.markWorkspaceChanged) BOBO.runner.markWorkspaceChanged();
      }
    } catch (e) { console.error(e); }
  });

  // Incremental file event from main process (lightweight, no full tree rebuild)
  window.api.onFileEvent(function(data) {
    try {
      if (!data || data.rootPath !== S.workspaceRoot || data.workspaceIdentity !== S.workspaceIdentity) return;
      if (BOBO.runner && BOBO.runner.markWorkspaceChanged) BOBO.runner.markWorkspaceChanged();
      if (BOBO.workspace && BOBO.workspace.handleFileEvent) {
        BOBO.workspace.handleFileEvent(data);
      }
    } catch (e) { console.error(e); }
  });

  // Theme picker from View menu
  if (window.api && typeof window.api.onThemeOpenPicker === 'function') {
    window.api.onThemeOpenPicker(function() {
      try { BOBO.views.openThemePicker(); } catch (e) { console.error(e); }
    });
  }

  // Save from File menu
  if (window.api && typeof window.api.onMenuSave === 'function') {
    window.api.onMenuSave(function() {
      try { BOBO.workspace.saveActiveTab(); } catch (e) { console.error(e); }
    });
  }

  // ── Server Settings (opens in unified Settings center, Server tab) ──
  window.api.onOpenServerSettings(function() {
    try { if (BOBO.settings) BOBO.settings.open('server'); } catch (e) { console.error(e); }
  });

  async function refreshRcloneStatus(requestedPath) {
    var status = document.getElementById('rclone-status');
    var detectButton = document.getElementById('rclone-detect');
    var translate = BOBO.i18n && BOBO.i18n.t
      ? BOBO.i18n.t
      : function(source, replacements) {
          return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
            return replacements && replacements[key] !== undefined ? replacements[key] : match;
          });
        };
    if (!status) return null;

    status.dataset.state = 'checking';
    status.textContent = translate('Checking rclone...');
    status.removeAttribute('title');
    if (detectButton) detectButton.disabled = true;

    try {
      var result = await BOBO.rclone.checkVersion(requestedPath);
      if (result.available) {
        var sourceNames = {
          bundled: translate('Bundled'),
          configured: translate('Configured'),
          path: translate('System PATH'),
          development: translate('Development')
        };
        status.dataset.state = 'available';
        status.textContent = translate('{source} rclone available: {version}', {
          source: sourceNames[result.source] || result.source || translate('Detected'),
          version: result.version || translate('unknown version')
        });
        if (result.path) status.title = result.path;
      } else {
        status.dataset.state = 'unavailable';
        status.textContent = translate('rclone unavailable: {error}', {
          error: result.error || translate('unknown error')
        });
        var attemptedPaths = (result.attempts || []).map(function(attempt) {
          return attempt.path + ': ' + attempt.error;
        });
        if (attemptedPaths.length) status.title = attemptedPaths.join('\n');
      }
      return result;
    } catch (error) {
      status.dataset.state = 'unavailable';
      status.textContent = translate('rclone unavailable: {error}', { error: error.message });
      return null;
    } finally {
      if (detectButton) detectButton.disabled = false;
    }
  }

  function initializeRcloneStatusControls() {
    var rcloneDetectButton = document.getElementById('rclone-detect');
    if (rcloneDetectButton) {
      rcloneDetectButton.onclick = function() {
        var input = document.getElementById('rclone-path');
        refreshRcloneStatus(input ? input.value : '');
      };
    }
    BOBO.rclone.refreshStatus = refreshRcloneStatus;

    // Settings may have been opened from the native menu while Monaco was
    // still loading. Recover that early-open case without another user click.
    var settingsModal = document.getElementById('settings-modal');
    if (settingsModal && settingsModal.style.display === 'flex') {
      var currentInput = document.getElementById('rclone-path');
      refreshRcloneStatus(currentInput ? currentInput.value : '');
    }
  }

  document.getElementById('server-save').onclick = async function() {
    try {
      var connectStatus = document.getElementById('server-connect-status');
      var serverSaveButton = document.getElementById('server-save');
      var firstRunConnection = Boolean(BOBO.settings && BOBO.settings.isFirstRunOpen && BOBO.settings.isFirstRunOpen());
      var config = {
        ip: document.getElementById('server-ip').value.trim(),
        user: document.getElementById('server-user').value.trim(),
        pass: document.getElementById('server-pass').value,
        apiKey: document.getElementById('server-apikey').value || '',
		secureTransport: document.getElementById('server-secure-transport').checked,
		httpPort: Number(document.getElementById('server-http-port').value) || 3100,
		wsPort: Number(document.getElementById('server-ws-port').value) || 3101,
		dapChildWsPort: Number(document.getElementById('server-dap-child-port').value) || 3102,
        certificateFingerprint: document.getElementById('server-cert-fingerprint').value.trim(),
		certificateFingerprints: (function() {
		  var entered = document.getElementById('server-cert-fingerprint').value.trim();
		  if (!entered) return [];
		  var existing = S.serverSettings && Array.isArray(S.serverSettings.certificateFingerprints)
		    ? S.serverSettings.certificateFingerprints : [];
		  return [entered].concat(existing.filter(function(fingerprint) { return fingerprint !== entered; }));
		})(),
        rclonePath: document.getElementById('rclone-path').value || '',
        syncInterval: (parseInt(document.getElementById('sync-interval').value) || 30) * 1000,
        setupCompleted: !firstRunConnection
      };
      if (!config.ip || !config.user || !config.pass) {
        if (connectStatus) { connectStatus.dataset.state = 'error'; connectStatus.textContent = BOBO.i18n.t('Server address, SSH account, and password are required'); }
        return;
      }
      if (serverSaveButton) serverSaveButton.disabled = true;
      if (connectStatus) { connectStatus.dataset.state = 'checking'; connectStatus.textContent = BOBO.i18n.t('Connecting...'); }
      var previousConfig = S.serverSettings || {};
      var serverIdentityChanged = previousConfig.ip !== config.ip || previousConfig.user !== config.user ||
        previousConfig.pass !== config.pass || previousConfig.apiKey !== config.apiKey ||
		previousConfig.secureTransport !== config.secureTransport || previousConfig.httpPort !== config.httpPort ||
		previousConfig.wsPort !== config.wsPort || previousConfig.dapChildWsPort !== config.dapChildWsPort ||
		previousConfig.certificateFingerprint !== config.certificateFingerprint;
      if (serverIdentityChanged && BOBO.terminal && typeof BOBO.terminal.close === 'function') {
        await BOBO.terminal.close('server-change');
      }
      if (serverIdentityChanged && BOBO.dap && typeof BOBO.dap.abort === 'function') {
        await BOBO.dap.abort('server-change');
      }
      if (serverIdentityChanged && BOBO.runner && typeof BOBO.runner.invalidateRunIdentity === 'function') {
        await BOBO.runner.invalidateRunIdentity();
      }
      var wrote = await window.api.writeServerSettings(config);
      if (!wrote) throw new Error('Failed to save server settings');
      S.serverSettings = config;
      refreshRcloneStatus(config.rclonePath);
      // Only a transport or credential change invalidates cloud sessions.
      // Sync cadence and the local rclone path are client preferences and
      // must not tear down an otherwise healthy debug/LSP/auth session.
      var connectionResult = { success: true };
      if (serverIdentityChanged && BOBO.auth && BOBO.auth.onServerChanged) {
        try { connectionResult = await BOBO.auth.onServerChanged({ runInvalidated: true }); } catch (e) { connectionResult = { success: false, error: e.message }; }
      }
      if (!connectionResult || !connectionResult.success) {
        // A failed validation must not leave the application pointed at a
        // server that it could not authenticate with. Restore the last
        // known-good persisted settings before keeping the dialog open.
        if (serverIdentityChanged) {
          try { await window.api.writeServerSettings(previousConfig); } catch (_) {}
          S.serverSettings = previousConfig;
          try {
            if (BOBO.auth && BOBO.auth.onServerChanged) await BOBO.auth.onServerChanged({ runInvalidated: true });
          } catch (_) {}
          if (BOBO.lsp && BOBO.lsp.workspaceChanged) BOBO.lsp.workspaceChanged();
        }
        if (connectStatus) { connectStatus.dataset.state = 'error'; connectStatus.textContent = BOBO.i18n.t('Could not connect to the server. Check the address and try again.'); }
        return;
      }
      if (serverIdentityChanged && BOBO.lsp && BOBO.lsp.workspaceChanged) BOBO.lsp.workspaceChanged();
      config.setupCompleted = true;
      config.firstRunRequired = false;
      await window.api.writeServerSettings(config);
      S.serverSettings = config;
      if (connectStatus) { connectStatus.dataset.state = 'ready'; connectStatus.textContent = BOBO.i18n.t('Connected to {server}', { server: config.ip }); }
      BOBO.runner.setupAutoSync();
      BOBO.runner.checkRcloneAvailability();
      if (BOBO.settings && BOBO.settings.finishFirstRun) BOBO.settings.finishFirstRun();
      if (BOBO.settings) BOBO.settings.close();
      BOBO.runner.manualSyncWithServer();
    } catch (e) {
      console.error('server-save:', e);
      var status = document.getElementById('server-connect-status');
      if (status) { status.dataset.state = 'error'; status.textContent = e.message; }
    } finally {
      var button = document.getElementById('server-save');
      if (button) button.disabled = false;
    }
  };

  document.getElementById('server-close').onclick = function() {
    try { if (BOBO.settings) BOBO.settings.close(); } catch (e) {}
  };

  var skipFirstRun = document.getElementById('server-skip-first-run');
  if (skipFirstRun) skipFirstRun.onclick = async function() {
    var config = Object.assign({}, S.serverSettings || {}, { setupCompleted: true, firstRunRequired: false });
    await window.api.writeServerSettings(config);
    S.serverSettings = config;
    if (BOBO.settings && BOBO.settings.finishFirstRun) BOBO.settings.finishFirstRun();
    if (BOBO.settings) BOBO.settings.close();
    BOBO.updateRunOutput(BOBO.i18n.t('Local editor mode selected. Cloud features remain available after you add a server.'));
  };

  // ── Initial label ──
  document.getElementById('workspace-label').textContent = BOBO.i18n.t('No folder opened');

  // ═══ Command Palette Registration ═══
  if (BOBO.commands) {
    BOBO.commands.register('open-folder', 'Open Folder', '', 'File', async function() {
      if (BOBO.workspaceLaunch) await BOBO.workspaceLaunch.requestOpen();
    });
    BOBO.commands.register('save', 'Save File', 'Ctrl+S', 'File', function() {
      BOBO.workspace.saveActiveTab();
    });
    BOBO.commands.register('sync-workspace', 'Sync Workspace to Cloud', '', 'File', function() {
      var button = document.getElementById('cloud-sync-btn');
      if (button && button.style.display !== 'none') button.click();
    });
    BOBO.commands.register('run', 'Run Code', 'Ctrl+F5', 'Run', function() {
      if (BOBO.projectTasks) BOBO.projectTasks.runSelected();
      else BOBO.runner.runActive();
    });
    BOBO.commands.register('debug-start', 'Start Debugging', 'F5', 'Debug', function() {
      if (BOBO.dap) BOBO.dap.start();
    });
    BOBO.commands.register('debug-continue', 'Continue', 'F5', 'Debug', function() {
      if (BOBO.dap) BOBO.dap.execute('continue');
    });
    BOBO.commands.register('debug-step-over', 'Step Over', 'F10', 'Debug', function() {
      if (BOBO.dap) BOBO.dap.execute('next');
    });
    BOBO.commands.register('debug-step-into', 'Step Into', 'F11', 'Debug', function() {
      if (BOBO.dap) BOBO.dap.execute('stepIn');
    });
    BOBO.commands.register('debug-step-out', 'Step Out', 'Shift+F11', 'Debug', function() {
      if (BOBO.dap) BOBO.dap.execute('stepOut');
    });
    BOBO.commands.register('debug-stop', 'Stop Debugging', 'Shift+F5', 'Debug', function() {
      if (BOBO.dap) BOBO.dap.stop('command');
    });
    BOBO.commands.register('stop', 'Stop Running', '', 'Run', function() {
      BOBO.runner.stopActiveRun();
    });
    BOBO.commands.register('history', 'Run History', '', 'Run', function() {
      loadAndShowHistory();
    });
    BOBO.commands.register('settings-local', 'Local Settings', 'Ctrl+,', 'Settings', function() {
      BOBO.settings.open('local');
    });
    BOBO.commands.register('settings-server', 'Server Settings', '', 'Settings', function() {
      BOBO.settings.open('server');
    });
    BOBO.commands.register('settings-language', 'Language Packs', '', 'Settings', function() {
      BOBO.settings.open('language');
    });
    BOBO.commands.register('settings-ai', 'AI Settings', '', 'Settings', function() {
      if (BOBO.aiSettingsCenter) BOBO.aiSettingsCenter.open();
    });
    BOBO.commands.register('ai-inline-trigger', 'Trigger AI Completion', 'Alt+\\', 'AI', function() {
      if (BOBO.aiInline) BOBO.aiInline.trigger();
    });
    BOBO.commands.register('environment-center', 'Project Environment', '', 'View', function() {
      if (BOBO.workbench) BOBO.workbench.setPrimaryView('environment');
    });
    BOBO.commands.register('theme', 'Change Theme', '', 'View', function() {
      BOBO.settings.open('local');
    });
    BOBO.commands.register('split', 'Toggle Split View', '', 'View', function() {
      if (BOBO.views) {
        if (S.currentViewMode === 'split') BOBO.views.closeSplit();
        else BOBO.views.openSplit();
      }
    });
    BOBO.commands.register('close-tab', 'Close Tab', 'Ctrl+W', 'File', function() {
      if (S.activeTabPath) BOBO.workspace.closeTab(S.activeTabPath);
    });
    BOBO.commands.register('toggle-ai', 'Toggle AI Panel', '', 'AI', function() {
      if (BOBO.aiAgentButton) BOBO.aiAgentButton.toggleChat(!(S.ai && S.ai.chatOpen));
    });
    BOBO.commands.register('clear-output', 'Clear Output', '', 'View', function() {
      var el = document.getElementById('run-log');
      if (el) el.textContent = '';
    });
  }

  // Init settings module
  if (BOBO.settings) BOBO.settings.init();
  if (BOBO.languagePacksPanel) BOBO.languagePacksPanel.init();
  if (BOBO.i18n) BOBO.i18n.apply();

  document.documentElement.setAttribute('data-bobo-ready', 'true');
  try { window.dispatchEvent(new CustomEvent('bobo:ready')); } catch (e) {}
  console.log('BOBOCLOUD Editor initialized successfully');
  if (BOBO.settings && BOBO.settings.openFirstRun) BOBO.settings.openFirstRun();
  });
})();
