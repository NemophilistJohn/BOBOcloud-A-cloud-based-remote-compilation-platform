(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var S = BOBO.state;
  var monacoRef = null;
  var initialized = false;
  var disposers = [];
  var breakpointDecorations = null;
  var currentLineDecorations = null;
  var configurationSet = { configurations: [], warnings: [], sources: [] };
  var catalog = { loaded: false, error: '', adapters: [] };
  var refreshGeneration = 0;
  var expectedTransportGeneration = 0;
  var initializedWaiters = [];
  var selectedFrameToken = 0;
  var stopping = false;
  var adapterInitialized = false;
  var activeDecorationRelative = '';
  var pauseEpoch = 0;
  var staleSources = new Set();
  var staleSourceNotified = new Set();
  var breakpointSyncStates = new Map();
  var exceptionBreakpointSyncState = { revision: 0, tail: Promise.resolve() };
  var adapterCapabilityProfiles = new Map();
  var exceptionBreakpointSelections = new Map();
  var exceptionBreakpointSelectionKey = '';
  var breakpointPopup = null;
  var VARIABLE_PAGE_SIZE = 200;
  var MAX_BREAKPOINT_TEXT_CHARS = 4096;
  var startPromise = null;
  var activeInspectorSection = 'stack';
  var consoleQueue = [];
  var consoleFlushTimer = 0;
  var consoleRenderPasses = 0;
  var MAX_CONSOLE_LINES = 2000;
  var MAX_CONSOLE_EVENT_CHARS = 65536;
  var CATALOG_CACHE_TTL_MS = 30000;
  var CATALOG_FAILURE_CACHE_TTL_MS = 3000;
  var catalogCache = { key: '', expiresAt: 0, value: null, promise: null };
  var debugLifecycle = null;
  var activeLifecycleTaskHandle = null;
  var finalizePromise = null;
  var finalizeState = null;
  var stopReasonKeys = {
    breakpoint: 'Breakpoint',
    step: 'Step',
    pause: 'Pause',
    exception: 'Exception',
    entry: 'Entry',
    goto: 'Go to',
    'function breakpoint': 'Function breakpoint',
    'data breakpoint': 'Data breakpoint',
    'instruction breakpoint': 'Instruction breakpoint',
    thread: 'Thread'
  };

  function tr(source, replacements) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function stopReasonText(reason) {
    var key = stopReasonKeys[String(reason || '').trim().toLowerCase()] || 'Debug event';
    return tr(key);
  }

  function dapServiceError(code) {
    switch (String(code || '').toLowerCase()) {
      case 'disabled': return tr('Cloud debugging is disabled on this server.');
      case 'unauthorized': return tr('Sign in again to start cloud debugging.');
      case 'invalid_runtime': return tr('The selected cloud runtime is not available for debugging.');
      case 'runtime_mismatch': return tr('The selected debugger does not match the cloud runtime.');
      case 'forbidden':
      case 'workspace_denied': return tr('You do not have access to debug this workspace.');
      case 'workspace_in_use': return tr('This workspace is busy. Wait for the current cloud operation to finish.');
      case 'workspace_copy_failed': return tr('The workspace could not be prepared for debugging.');
      case 'dependency_cache_unavailable': return tr('Project dependencies are unavailable for this debug session. Run or repair the project environment first.');
      case 'start_failed': return tr('The cloud debugger could not be started.');
      case 'adapter_protocol_error': return tr('The debug adapter returned an invalid protocol message.');
      case 'bandwidth_limit': return tr('The debug session exceeded the server bandwidth limit.');
      case 'protocol_error': return tr('The cloud debug protocol failed.');
      case 'adapter_exited': return tr('The debug adapter stopped unexpectedly.');
      case 'dap_start_cancelled': return tr('Debug session start was cancelled.');
      default: return tr('Connection to the debug service was lost.');
    }
  }

  function plainErrorText(error) {
    var value = error && error.message ? error.message : String(error || 'Unknown debug error');
    var ipcPrefix = value.lastIndexOf(': Error: ');
    return ipcPrefix >= 0 ? value.slice(ipcPrefix + 9) : value;
  }

  function localizeDebugError(error) {
    if (error && error.code) return dapServiceError(error.code);
    var value = plainErrorText(error);
    var match = value.match(/^Debug configuration not found: (.+)$/);
    if (match) return tr('Debug configuration not found: {configuration}', { configuration: match[1] });
    match = value.match(/^Debug configuration is not executable: (.+)$/);
    if (match) return tr('Debug configuration is not executable: {configuration}', { configuration: match[1] });
    match = value.match(/^Unsupported debug variable: (.+)$/);
    if (match) return tr('Unsupported debug variable: {variable}', { variable: match[1] });
    match = value.match(/^Unsupported language for cloud debugging: (.+)$/);
    if (match) return tr('Unsupported language for cloud debugging: {language}', { language: match[1] });
    if (value === 'Debug adapter did not send the initialized event') return tr('The debug adapter did not finish initialization.');
    if (value === 'Project files could not be saved') return tr('Project files could not be saved.');
    if (value === 'Workspace synchronization failed') return tr('Workspace synchronization failed.');
    if (value === 'Debug lifecycle task support is unavailable') return tr('Debug lifecycle task support is unavailable.');
    if (value === 'Debug session ended while starting') return tr('The debug session ended while it was starting.');
    if (value === 'The active file is outside the workspace') return tr('The active file is outside the workspace.');
    if (value === 'Open a source file before starting a debug session') return tr('Open a source file before starting a debug session.');
    if (value === 'The workspace changed while preparing the debug session' || value === 'The workspace changed while starting the debug session') {
      return tr('The workspace changed while starting the debug session.');
    }
    if (value === 'No workspace is open') return tr('No workspace is open.');
    if (value === 'Language and cloud runtime are required for debugging') return tr('A language and cloud runtime are required for debugging.');
    if (value === 'Incomplete team workspace identity') return tr('The team workspace identity is incomplete.');
    if (value === 'Invalid personal workspace identity') return tr('The personal workspace identity is invalid.');
    if (value === 'Timed out connecting to the cloud debug service') return tr('Timed out connecting to the cloud debug service.');
    if (value === 'Cloud debug service is offline' || value === 'Cloud debug service is not ready') return tr('The cloud debug service is not ready.');
    match = value.match(/^DAP (.+) request timed out$/);
    if (match) return tr('Debug request {command} timed out.', { command: match[1] });
    match = value.match(/^DAP request failed: (.+)$/);
    if (match) return tr('Debug request {command} failed.', { command: match[1] });
    return tr(value);
  }

  function normalizeLanguage(language) {
    var value = String(language || '').toLowerCase();
    if (value === 'javascript' || value === 'typescript' || value === 'javascriptreact' || value === 'typescriptreact' || value === 'node' || value === 'pwa-node') return 'node';
    return value;
  }

  function languageForType(type) {
    var value = String(type || '').toLowerCase();
    if (value === 'python' || value === 'debugpy' || value.indexOf('python') >= 0) return 'python';
    if (value === 'go' || value === 'delve' || value.indexOf('dlv') >= 0) return 'go';
    if (value === 'node' || value === 'pwa-node' || value.indexOf('javascript') >= 0 || value.indexOf('typescript') >= 0) return 'node';
    return value;
  }

  function dapFeatureDecision() {
    if (BOBO.cloudFeaturePolicy && typeof BOBO.cloudFeaturePolicy.evaluate === 'function') {
      return BOBO.cloudFeaturePolicy.evaluate('dap');
    }
    return { available: false, state: 'unknown', reason: 'policy_unavailable' };
  }

  function dapUnavailableText() {
    return tr('Cloud debugging is unavailable on this server.');
  }

  function activeModel() {
    return S.editor && S.editor.getModel ? S.editor.getModel() : null;
  }

  function currentLanguage() {
    var model = activeModel();
    return model ? normalizeLanguage(model.getLanguageId()) : '';
  }

  function clientSessionId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'debug-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function workspaceBinding() {
    var team = S.collaboration && S.collaboration.current;
    if (team) return { kind: 'team', teamId: team.teamId, projectId: team.projectId, branch: team.branch };
    if (!S.workspaceRoot) return null;
    var parts = String(S.workspaceRoot).split(/[/\\]/).filter(Boolean);
    return {
      kind: 'personal',
      folderName: parts[parts.length - 1] || 'workspace',
      folderKey: BOBO.projectKey ? BOBO.projectKey(S.workspaceRoot) : (parts[parts.length - 1] || 'workspace')
    };
  }

  function contextSnapshot(sessionId) {
    var model = activeModel();
    var position = S.editor && S.editor.getPosition ? S.editor.getPosition() : null;
    var selection = S.editor && S.editor.getSelection ? S.editor.getSelection() : null;
    return {
      workspaceRoot: S.workspaceRoot,
      workspaceIdentity: S.workspaceIdentity,
      workspaceGeneration: Number(S.workspaceGeneration) || 0,
      authEpoch: Number(S.runIdentityEpoch) || 0,
      clientSessionId: sessionId || '',
      activeFile: model && model.uri ? model.uri.fsPath : '',
      languageId: model ? normalizeLanguage(model.getLanguageId()) : '',
      lineNumber: position ? position.lineNumber : 1,
      columnNumber: position ? position.column : 1,
      selectedText: model && selection ? model.getValueInRange(selection) : ''
    };
  }

  function contextIsCurrent(context) {
    return Boolean(context && context.workspaceRoot === S.workspaceRoot &&
      context.workspaceIdentity === S.workspaceIdentity &&
      Number(context.workspaceGeneration) === Number(S.workspaceGeneration || 0) &&
      Number(context.authEpoch) === Number(S.runIdentityEpoch || 0) &&
      context.clientSessionId === S.dap.clientSessionId);
  }

  function eventIsCurrent(payload) {
    return Boolean(payload && contextIsCurrent(payload.context) &&
      (!expectedTransportGeneration || Number(payload.generation) === expectedTransportGeneration));
  }

  function isActive() {
    return S.dap.phase !== 'idle' && S.dap.phase !== 'error';
  }

  function isPaused() {
    return S.dap.phase === 'stopped';
  }

  function setPhase(phase, detail) {
    S.dap.phase = phase;
    var toolbar = document.getElementById('debug-toolbar');
    if (toolbar) toolbar.hidden = phase === 'idle' || phase === 'error';
    var editorHost = document.getElementById('editor');
    if (editorHost) editorHost.classList.toggle('debug-session', phase !== 'idle' && phase !== 'error');
    var status = document.getElementById('debug-toolbar-status');
    var statusKeys = {
      preparing: 'Debug session is starting...',
      connecting: 'Debug session is starting...',
      configuring: 'Debug session is starting...',
      running: 'Debug session is running',
      stopped: 'Debug session paused'
    };
    if (status) status.textContent = detail || tr(statusKeys[phase] || '');
    var paused = phase === 'stopped';
    document.querySelectorAll('#debug-toolbar [data-debug-command]').forEach(function(button) {
      var command = button.getAttribute('data-debug-command');
      if (command === 'continue' || command === 'next' || command === 'stepIn' || command === 'stepOut') button.disabled = !paused;
      else if (command === 'pause') button.disabled = phase !== 'running';
      else button.disabled = phase === 'preparing' || phase === 'connecting';
    });
    var start = document.getElementById('debug-start');
    if (start) start.disabled = !dapFeatureDecision().available || (phase !== 'idle' && phase !== 'error');
    var run = document.getElementById('run-code');
    var runTarget = document.getElementById('run-target-btn');
    var runConfig = document.getElementById('run-config-btn');
    if (isActive()) {
      if (run) run.disabled = true;
      if (runTarget) runTarget.disabled = true;
      if (runConfig) runConfig.disabled = true;
    } else if (BOBO.runner && typeof BOBO.runner.refreshControls === 'function') {
      BOBO.runner.refreshControls();
    }
  }

  function relativeWorkspacePath(filePath) {
    var root = String(S.workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var file = String(filePath || '').replace(/\\/g, '/');
    if (!root || !file) return '';
    var rootCompare = BOBO.isWindows ? root.toLowerCase() : root;
    var fileCompare = BOBO.isWindows ? file.toLowerCase() : file;
    if (fileCompare !== rootCompare && fileCompare.indexOf(rootCompare + '/') !== 0) return '';
    var relative = file.slice(root.length).replace(/^\/+/, '');
    var parts = relative.split('/');
    if (!relative || parts.some(function(part) { return !part || part === '.' || part === '..'; })) return '';
    return relative;
  }

  function localPathForSource(source) {
    var value = String(source && source.path || '').replace(/\\/g, '/');
    var relative = '';
    if (value.indexOf('bobocloud-dap:///') === 0) {
      var encoded = value.slice('bobocloud-dap:///'.length).split('/');
      try { relative = encoded.map(function(segment) { return decodeURIComponent(segment); }).join('/'); } catch (_) { return ''; }
    }
    else if (value.indexOf('/workspace/') === 0) relative = value.slice('/workspace/'.length);
    else if (!/^[a-z]+:/i.test(value) && value[0] !== '/') relative = value;
    var parts = relative.split('/');
    if (!relative || parts.some(function(part) { return !part || part === '.' || part === '..' || part.indexOf(':') >= 0 || /[/\\]/.test(part); })) return '';
    return String(S.workspaceRoot || '') + (BOBO.isWindows ? '\\' : '/') + parts.join(BOBO.isWindows ? '\\' : '/');
  }

  function sourceForRelative(relative) {
    var parts = String(relative).split('/');
    return { name: parts[parts.length - 1], path: 'bobocloud-dap:///' + parts.map(encodeURIComponent).join('/') };
  }

  function debugStorageScope() {
    var binding = workspaceBinding() || {};
    var user = S.auth && S.auth.user || {};
    var project = binding.kind === 'team'
      ? ['team', binding.teamId, binding.projectId, binding.branch]
      : ['personal', binding.folderKey || (BOBO.projectKey && S.workspaceRoot ? BOBO.projectKey(S.workspaceRoot) : S.workspaceRoot)];
    return [String(S.serverSettings && S.serverSettings.ip || 'local'), String(user.id || user.uid || user.username || 'single')]
      .concat(project).join('|');
  }

  function breakpointStorageKey() {
    return 'bobocloud.debug.breakpoints.' + debugStorageScope();
  }

  function exceptionBreakpointStorageKey() {
    return 'bobocloud.debug.exceptions.' + debugStorageScope() + '|' + encodeURIComponent(String(S.dap.configurationId || ''));
  }

  function watchStorageKey() {
    return 'bobocloud.debug.watches.' + debugStorageScope();
  }

  function saveBreakpoints() {
    var value = Object.create(null);
    S.dap.breakpoints.forEach(function(items, relative) {
      value[relative] = items.map(function(item) {
        var saved = { line: item.line, enabled: item.enabled !== false };
        if (Number.isSafeInteger(item.column) && item.column > 0) saved.column = item.column;
        if (item.condition) saved.condition = item.condition;
        if (item.hitCondition) saved.hitCondition = item.hitCondition;
        if (item.logMessage) saved.logMessage = item.logMessage;
        return saved;
      });
    });
    try { localStorage.setItem(breakpointStorageKey(), JSON.stringify(value)); } catch (_) {}
  }

  function boundedBreakpointText(value, preserveWhitespace) {
    if (typeof value !== 'string') return '';
    var text = preserveWhitespace ? value : value.trim();
    return text.slice(0, MAX_BREAKPOINT_TEXT_CHARS);
  }

  function normalizeBreakpoint(item) {
    if (!item || !Number.isSafeInteger(item.line) || item.line < 1) return null;
    var normalized = {
      line: item.line,
      enabled: item.enabled !== false,
      verified: null,
      message: '',
      id: 0,
      condition: boundedBreakpointText(item.condition),
      hitCondition: boundedBreakpointText(item.hitCondition),
      logMessage: boundedBreakpointText(item.logMessage, true)
    };
    if (Number.isSafeInteger(item.column) && item.column > 0) normalized.column = item.column;
    return normalized;
  }

  function capabilityProfileKey() {
    return [debugStorageScope(), String(S.dap.configurationId || ''), String(S.selectedRuntime || '')].join('|');
  }

  function normalizeBreakpointCapabilities(value) {
    var known = Boolean(value && typeof value === 'object');
    value = known ? value : {};
    var seen = new Set();
    var filters = Array.isArray(value.exceptionBreakpointFilters) ? value.exceptionBreakpointFilters.map(function(filter) {
      var id = String(filter && filter.filter || '').trim();
      if (!id || id.length > 256 || seen.has(id)) return null;
      seen.add(id);
      return {
        filter: id,
        label: String(filter.label || id).slice(0, 512),
        description: String(filter.description || '').slice(0, 2048),
        default: filter.default === true,
        supportsCondition: filter.supportsCondition === true,
        conditionDescription: String(filter.conditionDescription || '').slice(0, 1024)
      };
    }).filter(Boolean) : [];
    return {
      known: known,
      supportsConditionalBreakpoints: value.supportsConditionalBreakpoints === true,
      supportsHitConditionalBreakpoints: value.supportsHitConditionalBreakpoints === true,
      supportsLogPoints: value.supportsLogPoints === true,
      supportsExceptionFilterOptions: value.supportsExceptionFilterOptions === true,
      exceptionBreakpointFilters: filters
    };
  }

  function currentBreakpointCapabilities() {
    if (S.dap.capabilities && typeof S.dap.capabilities === 'object') return normalizeBreakpointCapabilities(S.dap.capabilities);
    return adapterCapabilityProfiles.get(capabilityProfileKey()) || normalizeBreakpointCapabilities(null);
  }

  function rememberBreakpointCapabilities(value) {
    var normalized = normalizeBreakpointCapabilities(value);
    adapterCapabilityProfiles.set(capabilityProfileKey(), normalized);
    ensureExceptionBreakpointSelections(normalized);
    renderBreakpoints();
    refreshBreakpointDecorations();
    return normalized;
  }

  function ensureExceptionBreakpointSelections(capabilities) {
    capabilities = capabilities || currentBreakpointCapabilities();
    if (!capabilities.known) return;
    var key = exceptionBreakpointStorageKey();
    var identity = key + '|' + capabilities.exceptionBreakpointFilters.map(function(filter) { return filter.filter; }).join('|');
    if (exceptionBreakpointSelectionKey === identity) return;
    exceptionBreakpointSelectionKey = identity;
    exceptionBreakpointSelections = new Map();
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
    var hasLegacyFilters = Array.isArray(raw);
    var legacyFilters = hasLegacyFilters ? raw.filter(function(value) { return typeof value === 'string'; }) : [];
    var storedFilters = raw && !Array.isArray(raw) && raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
    capabilities.exceptionBreakpointFilters.forEach(function(filter) {
      var stored = Object.prototype.hasOwnProperty.call(storedFilters, filter.filter) ? storedFilters[filter.filter] : null;
      var enabled = stored && typeof stored === 'object' && typeof stored.enabled === 'boolean'
        ? stored.enabled
        : (hasLegacyFilters ? legacyFilters.indexOf(filter.filter) >= 0 : filter.default);
      exceptionBreakpointSelections.set(filter.filter, {
        enabled: enabled,
        condition: stored && typeof stored === 'object' ? boundedBreakpointText(stored.condition) : '',
        verified: null,
        message: ''
      });
    });
  }

  function saveExceptionBreakpoints() {
    var filters = Object.create(null);
    exceptionBreakpointSelections.forEach(function(value, id) {
      filters[id] = { enabled: value.enabled === true, condition: boundedBreakpointText(value.condition) };
    });
    try { localStorage.setItem(exceptionBreakpointStorageKey(), JSON.stringify({ version: 1, filters: filters })); } catch (_) {}
  }

  function breakpointSyncState(relative) {
    var state = breakpointSyncStates.get(relative);
    if (!state) {
      state = { revision: 0, tail: Promise.resolve() };
      breakpointSyncStates.set(relative, state);
    }
    return state;
  }

  function invalidateBreakpointSync(relative) {
    if (!relative) return;
    breakpointSyncState(relative).revision += 1;
  }

  function invalidateAllBreakpointSyncs() {
    breakpointSyncStates.forEach(function(state) { state.revision += 1; });
  }

  function reconcileTrackedBreakpointLines() {
    if (!breakpointDecorations || !activeDecorationRelative || typeof breakpointDecorations.getRange !== 'function') return;
    var items = S.dap.breakpoints.get(activeDecorationRelative) || [];
    var changed = false;
    items.forEach(function(item, index) {
      var range = breakpointDecorations.getRange(index);
      if (!range) return;
      var displayLine = Number.isSafeInteger(item.actualLine) && item.actualLine > 0 ? item.actualLine : item.line;
      var displayColumn = Number.isSafeInteger(item.actualColumn) && item.actualColumn > 0
        ? item.actualColumn
        : (Number.isSafeInteger(item.column) && item.column > 0 ? item.column : 1);
      var lineDelta = range.startLineNumber - displayLine;
      var columnDelta = range.startColumn - displayColumn;
      if (lineDelta || columnDelta) {
        item.line = Math.max(1, item.line + lineDelta);
        if (Number.isSafeInteger(item.actualLine) && item.actualLine > 0) item.actualLine = Math.max(1, item.actualLine + lineDelta);
        if (Number.isSafeInteger(item.column) && item.column > 0) item.column = Math.max(1, item.column + columnDelta);
        if (Number.isSafeInteger(item.actualColumn) && item.actualColumn > 0) item.actualColumn = Math.max(1, item.actualColumn + columnDelta);
        item.verified = isActive() ? false : item.verified;
        changed = true;
      }
    });
    if (changed) {
      invalidateBreakpointSync(activeDecorationRelative);
      saveBreakpoints();
    }
  }

  function loadWorkspaceState() {
    invalidateAllBreakpointSyncs();
    breakpointSyncStates = new Map();
    S.dap.breakpoints = new Map();
    try {
      var raw = JSON.parse(localStorage.getItem(breakpointStorageKey()) || '{}');
      Object.keys(raw || {}).forEach(function(relative) {
        if (relativeWorkspacePath(String(S.workspaceRoot) + (BOBO.isWindows ? '\\' : '/') + relative) !== relative) return;
        var items = Array.isArray(raw[relative]) ? raw[relative] : [];
        var normalized = items.map(normalizeBreakpoint).filter(Boolean);
        if (normalized.length) S.dap.breakpoints.set(relative, normalized);
      });
    } catch (_) {}
    try {
      var watches = JSON.parse(localStorage.getItem(watchStorageKey()) || '[]');
      S.dap.watches = Array.isArray(watches) ? watches.filter(function(value) { return typeof value === 'string' && value.trim(); }) : [];
    } catch (_) { S.dap.watches = []; }
    exceptionBreakpointSelectionKey = '';
    exceptionBreakpointSelections = new Map();
    exceptionBreakpointSyncState = { revision: 0, tail: Promise.resolve() };
    refreshBreakpointDecorations();
    renderBreakpoints();
    renderWatches();
  }

  function saveWatches() {
    try { localStorage.setItem(watchStorageKey(), JSON.stringify(S.dap.watches)); } catch (_) {}
  }

  function sortBreakpoints(items) {
    items.sort(function(left, right) {
      return left.line - right.line || (Number(left.column) || 0) - (Number(right.column) || 0);
    });
    return items;
  }

  function breakpointCapabilityProblem(item, capabilities) {
    capabilities = capabilities || currentBreakpointCapabilities();
    if (item.condition && !capabilities.supportsConditionalBreakpoints) return tr('Conditional breakpoints are not supported by this debugger.');
    if (item.hitCondition && !capabilities.supportsHitConditionalBreakpoints) return tr('Hit count breakpoints are not supported by this debugger.');
    if (item.logMessage && !capabilities.supportsLogPoints) return tr('Logpoints are not supported by this debugger.');
    return '';
  }

  function breakpointDescription(item) {
    var values = [];
    if (item.condition) values.push(tr('Expression: {value}', { value: item.condition }));
    if (item.hitCondition) values.push(tr('Hit Count: {value}', { value: item.hitCondition }));
    if (item.logMessage) values.push(tr('Log Message: {value}', { value: item.logMessage }));
    return values.join(' | ');
  }

  function actualBreakpointLine(item) {
    return Number.isSafeInteger(item.actualLine) && item.actualLine > 0 ? item.actualLine : item.line;
  }

  function actualBreakpointColumn(item) {
    if (Number.isSafeInteger(item.actualColumn) && item.actualColumn > 0) return item.actualColumn;
    return Number.isSafeInteger(item.column) && item.column > 0 ? item.column : 1;
  }

  function refreshBreakpointDecorations(options) {
    if (!breakpointDecorations || !monacoRef || !S.editor) return;
    if (!(options && options.skipReconcile)) reconcileTrackedBreakpointLines();
    var model = S.editor.getModel();
    var relative = model && model.uri ? relativeWorkspacePath(model.uri.fsPath) : '';
    var items = relative ? (S.dap.breakpoints.get(relative) || []) : [];
    breakpointDecorations.set(items.map(function(item) {
      var capabilityProblem = breakpointCapabilityProblem(item);
      var className = item.enabled === false || capabilityProblem
        ? 'dap-breakpoint-disabled'
        : (item.verified === false
          ? (item.stale ? 'dap-breakpoint-unverified' : (item.message ? 'dap-breakpoint-rejected' : 'dap-breakpoint-unverified'))
          : (item.logMessage ? 'dap-logpoint' : 'dap-breakpoint'));
      if (item.condition || item.hitCondition) className += ' dap-breakpoint-conditional';
      var title = capabilityProblem || (item.enabled === false
        ? tr('Disabled breakpoint')
        : (item.verified === false
          ? (item.message ? tr('Breakpoint rejected: {message}', { message: item.message }) : tr('Unverified breakpoint'))
          : (item.logMessage ? tr('Logpoint') : tr('Breakpoint'))));
      var description = breakpointDescription(item);
      if (description) title += '\n' + description;
      if (actualBreakpointLine(item) !== item.line || actualBreakpointColumn(item) !== (Number(item.column) || 1)) {
        title += '\n' + tr('Actual breakpoint location: {line}:{column}', {
          line: actualBreakpointLine(item), column: actualBreakpointColumn(item)
        });
      }
      return {
        range: new monacoRef.Range(actualBreakpointLine(item), actualBreakpointColumn(item), actualBreakpointLine(item), actualBreakpointColumn(item)),
        options: { isWholeLine: false, glyphMarginClassName: className, glyphMarginHoverMessage: { value: title } }
      };
    }));
    activeDecorationRelative = relative;
  }

  function toggleBreakpoint(filePath, line) {
    reconcileTrackedBreakpointLines();
    var relative = relativeWorkspacePath(filePath);
    if (!relative || !Number.isInteger(line) || line < 1) return false;
    var items = (S.dap.breakpoints.get(relative) || []).slice();
    var index = items.findIndex(function(item) { return item.actualLine === line; });
    if (index < 0) index = items.findIndex(function(item) { return item.line === line; });
    if (index >= 0) items.splice(index, 1);
    else items.push({ line: line, enabled: true, verified: isActive() ? false : null, message: '', id: 0, condition: '', hitCondition: '', logMessage: '' });
    sortBreakpoints(items);
    if (items.length) S.dap.breakpoints.set(relative, items);
    else S.dap.breakpoints.delete(relative);
    invalidateBreakpointSync(relative);
    saveBreakpoints();
    refreshBreakpointDecorations();
    renderBreakpoints();
    if (canSendBreakpoints() && !staleSources.has(relative)) setBreakpointsForSource(relative).catch(reportError);
    return index < 0;
  }

  function canSendBreakpoints() {
    return adapterInitialized && (S.dap.phase === 'configuring' || S.dap.phase === 'running' || S.dap.phase === 'stopped');
  }

  function setBreakpointsForSource(relative) {
    if (!canSendBreakpoints() || staleSources.has(relative)) return;
    if (relative === activeDecorationRelative) reconcileTrackedBreakpointLines();
    var state = breakpointSyncState(relative);
    var revision = state.revision;
    var task = state.tail.catch(function() {}).then(function() {
      return sendBreakpointsForSource(relative, state, revision);
    });
    state.tail = task.catch(function() {});
    return task;
  }

  async function sendBreakpointsForSource(relative, state, revision) {
    if (state.revision !== revision || !canSendBreakpoints() || staleSources.has(relative)) return;
    var items = S.dap.breakpoints.get(relative) || [];
    var capabilities = currentBreakpointCapabilities();
    var requestedItems = items.filter(function(item) {
      return item.enabled !== false && !breakpointCapabilityProblem(item, capabilities);
    });
    var requestedBreakpoints = requestedItems.map(function(item) {
      var request = { line: item.line };
      if (Number.isSafeInteger(item.column) && item.column > 0) request.column = item.column;
      if (item.condition && capabilities.supportsConditionalBreakpoints) request.condition = item.condition;
      if (item.hitCondition && capabilities.supportsHitConditionalBreakpoints) request.hitCondition = item.hitCondition;
      if (item.logMessage && capabilities.supportsLogPoints) request.logMessage = item.logMessage;
      return request;
    });
    var body = await global.api.dapRequest('setBreakpoints', {
      source: sourceForRelative(relative),
      breakpoints: requestedBreakpoints,
      sourceModified: false
    });
    if (state.revision !== revision || !canSendBreakpoints() || staleSources.has(relative)) return;
    items = S.dap.breakpoints.get(relative) || [];
    if (requestedItems.some(function(item) { return items.indexOf(item) < 0 || item.enabled === false; })) return;
    var returned = body && Array.isArray(body.breakpoints) ? body.breakpoints : [];
    items.forEach(function(item) {
      if (requestedItems.indexOf(item) >= 0) return;
      item.verified = null;
      item.message = '';
      item.id = 0;
      item.stale = false;
      delete item.actualLine;
      delete item.actualColumn;
    });
    requestedItems.forEach(function(item, index) {
      var remote = returned[index];
      item.verified = remote ? remote.verified !== false : false;
      item.message = remote ? String(remote.message || '').slice(0, 2048) : '';
      item.stale = false;
      item.id = remote && Number.isInteger(remote.id) ? remote.id : 0;
      delete item.actualLine;
      delete item.actualColumn;
      if (remote && Number.isSafeInteger(remote.line) && remote.line > 0) item.actualLine = remote.line;
      if (remote && Number.isSafeInteger(remote.column) && remote.column > 0) item.actualColumn = remote.column;
    });
    sortBreakpoints(items);
    saveBreakpoints();
    refreshBreakpointDecorations({ skipReconcile: true });
    renderBreakpoints();
  }

  function renameBreakpoints(oldPath, newPath) {
    reconcileTrackedBreakpointLines();
    var oldRelative = relativeWorkspacePath(oldPath);
    var newRelative = relativeWorkspacePath(newPath);
    if (!oldRelative || !newRelative) return;
    var moved = [];
    S.dap.breakpoints.forEach(function(items, relative) {
      if (relative === oldRelative || relative.indexOf(oldRelative + '/') === 0) {
        moved.push({ from: relative, to: newRelative + relative.slice(oldRelative.length), items: items });
      }
    });
    moved.forEach(function(entry) {
      invalidateBreakpointSync(entry.from);
      invalidateBreakpointSync(entry.to);
      S.dap.breakpoints.delete(entry.from);
      S.dap.breakpoints.set(entry.to, entry.items);
    });
    if (moved.length) {
      saveBreakpoints();
      refreshBreakpointDecorations();
      renderBreakpoints();
      if (canSendBreakpoints()) moved.forEach(function(entry) {
        var state = breakpointSyncState(entry.from);
        var revision = state.revision;
        var clearTask = state.tail.catch(function() {}).then(function() {
          if (state.revision !== revision || !canSendBreakpoints()) return;
          return global.api.dapRequest('setBreakpoints', { source: sourceForRelative(entry.from), breakpoints: [], sourceModified: false });
        });
        state.tail = clearTask.catch(function() {});
        clearTask.then(function() { return setBreakpointsForSource(entry.to); }).catch(reportError);
      });
    }
  }

  function removeBreakpoints(entryPath) {
    reconcileTrackedBreakpointLines();
    var relativePath = relativeWorkspacePath(entryPath);
    if (!relativePath) return;
    var removed = [];
    S.dap.breakpoints.forEach(function(_items, relative) {
      if (relative === relativePath || relative.indexOf(relativePath + '/') === 0) removed.push(relative);
    });
    removed.forEach(function(relative) {
      invalidateBreakpointSync(relative);
      S.dap.breakpoints.delete(relative);
    });
    if (removed.length) {
      saveBreakpoints();
      refreshBreakpointDecorations();
      renderBreakpoints();
      if (canSendBreakpoints()) removed.forEach(function(relative) {
        var state = breakpointSyncState(relative);
        var revision = state.revision;
        var task = state.tail.catch(function() {}).then(function() {
          if (state.revision !== revision || !canSendBreakpoints()) return;
          return global.api.dapRequest('setBreakpoints', { source: sourceForRelative(relative), breakpoints: [], sourceModified: false });
        });
        state.tail = task.catch(function() {});
        task.catch(reportError);
      });
    }
  }

  async function syncAllBreakpoints() {
    var sources = Array.from(S.dap.breakpoints.keys());
    for (var index = 0; index < sources.length; index++) await setBreakpointsForSource(sources[index]);
  }

  function invalidateExceptionBreakpointSync() {
    exceptionBreakpointSyncState.revision += 1;
  }

  function setExceptionBreakpoints() {
    if (!canSendBreakpoints()) return;
    var state = exceptionBreakpointSyncState;
    var revision = state.revision;
    var task = state.tail.catch(function() {}).then(function() {
      return sendExceptionBreakpoints(state, revision);
    });
    state.tail = task.catch(function() {});
    return task;
  }

  async function sendExceptionBreakpoints(state, revision) {
    if (state.revision !== revision || !canSendBreakpoints()) return;
    var capabilities = currentBreakpointCapabilities();
    ensureExceptionBreakpointSelections(capabilities);
    var filters = [];
    var filterOptions = [];
    var requestedSelections = [];
    capabilities.exceptionBreakpointFilters.forEach(function(filter) {
      var selection = exceptionBreakpointSelections.get(filter.filter);
      if (!selection || !selection.enabled) return;
      var condition = boundedBreakpointText(selection.condition);
      if (capabilities.supportsExceptionFilterOptions) {
        var option = { filterId: filter.filter };
        if (condition && filter.supportsCondition) option.condition = condition;
        filterOptions.push(option);
      } else {
        filters.push(filter.filter);
      }
      requestedSelections.push(selection);
    });
    var args = { filters: filters };
    if (capabilities.supportsExceptionFilterOptions && filterOptions.length) args.filterOptions = filterOptions;
    var body = await global.api.dapRequest('setExceptionBreakpoints', args);
    if (state.revision !== revision || !canSendBreakpoints()) return;
    var returned = body && Array.isArray(body.breakpoints) ? body.breakpoints : [];
    exceptionBreakpointSelections.forEach(function(selection) {
      selection.verified = null;
      selection.message = '';
    });
    requestedSelections.forEach(function(selection, index) {
      var remote = returned[index];
      selection.verified = remote ? remote.verified !== false : null;
      selection.message = remote ? String(remote.message || '').slice(0, 2048) : '';
    });
    renderBreakpoints();
  }

  function clearCurrentLine() {
    if (currentLineDecorations) currentLineDecorations.clear();
  }

  async function revealFrame(frame, epoch) {
    clearCurrentLine();
    if (!frame || !frame.source || !Number.isInteger(frame.line)) return;
    if (epoch !== pauseEpoch || !isPaused()) return;
    var filePath = localPathForSource(frame.source);
    if (!filePath) return;
    await BOBO.workspace.openFile(filePath, filePath.split(/[/\\]/).pop());
    if (epoch !== pauseEpoch || !isPaused() || !S.editor || !S.editor.getModel()) return;
    S.editor.setPosition({ lineNumber: frame.line, column: Math.max(1, Number(frame.column) || 1) });
    S.editor.revealLineInCenter(frame.line);
    currentLineDecorations.set([{
      range: new monacoRef.Range(frame.line, 1, frame.line, 1),
      options: { isWholeLine: true, className: 'dap-current-line', glyphMarginClassName: 'dap-current-line-glyph' }
    }]);
  }

  function warningPath(item, property) {
    var value = String(item && item[property || 'path'] || '');
    var root = String(S.workspaceRoot || '');
    if (root && value.toLowerCase().indexOf(root.toLowerCase()) === 0) return value.slice(root.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
    return value;
  }

  function warningText(item) {
    item = item || {};
    var values = {
      path: warningPath(item),
      sourcePath: warningPath(item, 'sourcePath'),
      overriddenSourcePath: warningPath(item, 'overriddenSourcePath'),
      line: item.line || 0,
      column: item.column || 0,
      reason: item.reason || item.code || '',
      version: item.version || '',
      index: item.index || 0,
      name: item.name || '',
      request: item.request || '',
      task: item.task || '',
      field: item.field || ''
    };
    var keys = {
      'read-error': 'Debug configuration could not be loaded: {reason}',
      'parse-error': 'Configuration file could not be parsed at {path}:{line}:{column} ({reason}).',
      'not-object': 'Configuration file must contain a JSON object: {path}',
      'unsupported-version': 'Configuration file {path} uses version {version}; only 0.2.0 can run.',
      'missing-configurations': 'Configuration file must define a configurations array: {path}',
      'missing-name': 'Configuration #{index} has no name in {path}.',
      'missing-type': 'Configuration "{name}" has no debugger type.',
      'unsupported-request': 'Configuration "{name}" uses unsupported request "{request}".',
      'invalid-lifecycle-task': 'Configuration "{name}" has an invalid {field} task label.',
      'unsupported-variable': 'Configuration "{name}" uses an input, command, or configuration variable that is not available.',
      'unsupported-compounds': 'Configuration file {path} defines compounds, which are not supported by cloud debugging yet.',
      'unsupported-inputs': 'Configuration file {path} defines inputs, which are not supported by cloud debugging yet.',
      'overrides': 'Configuration "{name}" from {sourcePath} overrides the configuration from {overriddenSourcePath}.'
    };
    return keys[item.code] ? tr(keys[item.code], values) : String(item.message || item.code || tr('Debug configuration warning'));
  }

  function adapterUnavailableReason(reason) {
    switch (String(reason || '').toLowerCase()) {
      case 'image_not_installed': return tr('The server has not installed this debug adapter.');
      case 'image_inspection_timeout': return tr('The server timed out while checking this debug adapter.');
      case 'docker_unavailable': return tr('The server container runtime is unavailable.');
      case 'image_inspection_failed': return tr('The server could not verify this debug adapter.');
      default: return tr('This debug adapter is not available on the server.');
    }
  }

  function catalogCacheKey() {
    var settings = S.serverSettings || {};
    var snapshot = S.serverCapabilities || {};
    var fingerprints = snapshot.catalogFingerprints || {};
    var revisions = snapshot.catalogRevisions || {};
    var user = S.auth && S.auth.user || {};
    var certificateFingerprints = Array.isArray(settings.certificateFingerprints)
      ? settings.certificateFingerprints.map(String)
      : [String(settings.certificateFingerprint || '')];
    return [
      String(settings.ip || ''),
      settings.secureTransport === true ? 'secure' : 'plain',
      String(settings.httpPort || ''),
      String(settings.wsPort || ''),
      String(settings.dapChildWsPort || ''),
      certificateFingerprints.join(','),
      String(snapshot.state || 'unknown'),
      String(fingerprints.dap || ''),
      String(revisions.dap || ''),
      String(S.auth && S.auth.mode || ''),
      String(user.id || user.uid || user.username || ''),
      String(S.runIdentityEpoch || 0)
    ].join('|');
  }

  function cloneCatalog(value) {
    value = value || {};
    return {
      loaded: value.loaded === true,
      error: String(value.error || ''),
      adapters: Array.isArray(value.adapters) ? value.adapters.map(function(adapter) { return Object.assign({}, adapter); }) : [],
      virtualRootUri: String(value.virtualRootUri || 'bobocloud-dap:///')
    };
  }

  function invalidateCatalogCache() {
    catalogCache = { key: '', expiresAt: 0, value: null, promise: null };
  }

  async function loadCatalog() {
    var feature = dapFeatureDecision();
    if (!feature.available) {
      catalog = { loaded: false, error: dapUnavailableText(), adapters: [] };
      return catalog;
    }
    if (!S.serverSettings || !S.serverSettings.ip) {
      catalog = { loaded: false, error: tr('Server address is not configured'), adapters: [] };
      return catalog;
    }
    var key = catalogCacheKey();
    var now = Date.now();
    if (catalogCache.key === key && catalogCache.value && catalogCache.expiresAt > now) {
      catalog = cloneCatalog(catalogCache.value);
      return catalog;
    }
    if (catalogCache.key === key && catalogCache.promise) {
      var joinedRecord = catalogCache;
      var joined = await joinedRecord.promise;
      if (catalogCache !== joinedRecord || catalogCacheKey() !== key) return catalog;
      catalog = cloneCatalog(joined);
      return catalog;
    }
    var pending = (async function() {
      var response = await BOBO.sendToServer('getDAPInfo', {}, { quiet: true });
      var data = response && response.success && response.data;
      if (!data || data.enabled !== true || !Array.isArray(data.adapters)) {
        if (response && response.error) console.warn('[DAP catalog]', response.error);
        return { loaded: false, error: tr('Cloud debug service is unavailable'), adapters: [] };
      }
      return { loaded: true, error: '', adapters: data.adapters.slice(), virtualRootUri: data.virtualRootUri || 'bobocloud-dap:///' };
    })();
    var cacheRecord = { key: key, expiresAt: 0, value: null, promise: pending };
    catalogCache = cacheRecord;
    var loaded;
    try {
      loaded = await pending;
    } finally {
      if (catalogCache === cacheRecord && cacheRecord.promise === pending) cacheRecord.promise = null;
    }
    if (catalogCache !== cacheRecord || catalogCacheKey() !== key) return catalog;
    cacheRecord.value = cloneCatalog(loaded);
    cacheRecord.expiresAt = Date.now() + (loaded.loaded ? CATALOG_CACHE_TTL_MS : CATALOG_FAILURE_CACHE_TTL_MS);
    catalog = cloneCatalog(loaded);
    return catalog;
  }

  function availability(configuration) {
    if (!dapFeatureDecision().available) return { available: false, reason: dapUnavailableText() };
    if (!configuration.executable) return { available: false, reason: (configuration.warnings || []).map(warningText).join('\n') };
    if (!S.selectedRuntime) return { available: false, reason: tr('Select a cloud runtime before debugging.') };
    var language = configuration.id === 'builtin:current-file' ? currentLanguage() : languageForType(configuration.type);
    if (!language) return { available: false, reason: tr('Open a source file before starting a debug session.') };
    if (!catalog.loaded) return { available: false, reason: catalog.error || tr('Cloud debug service is unavailable') };
    var adapter = catalog.adapters.find(function(candidate) {
      return candidate && candidate.available === true && candidate.supportsLaunch !== false &&
        String(candidate.runtimeId || '') === String(S.selectedRuntime) &&
        (normalizeLanguage(candidate.languageId) === language || String(candidate.id || '') === String(configuration.type || ''));
    });
    if (adapter) return { available: true, adapter: adapter, language: language };
    var known = catalog.adapters.find(function(candidate) {
      return candidate && (normalizeLanguage(candidate.languageId) === language || String(candidate.id || '') === String(configuration.type || ''));
    });
    return {
      available: false,
      reason: known && known.unavailableReason
        ? adapterUnavailableReason(known.unavailableReason)
        : tr('No available debug adapter matches {language} on {runtime}.', { language: language, runtime: S.selectedRuntime })
    };
  }

  function builtinConfiguration() {
    return { id: 'builtin:current-file', name: 'Current File', type: '', request: 'launch', sourceKind: 'builtin', sourcePath: '', warnings: [], executable: true };
  }

  async function refreshConfigurations() {
    var generation = ++refreshGeneration;
    if (!S.workspaceRoot) {
      configurationSet = { configurations: [], warnings: [], sources: [] };
      S.dap.configurations = [];
      return configurationSet;
    }
    var results = await Promise.all([global.api.dapConfigurations(), loadCatalog()]);
    if (generation !== refreshGeneration || !S.workspaceRoot) return configurationSet;
    configurationSet = results[0] || { configurations: [], warnings: [], sources: [] };
    S.dap.configurations = [builtinConfiguration()].concat(configurationSet.configurations || []);
    S.dap.warnings = configurationSet.warnings || [];
    if (!S.dap.configurations.some(function(item) { return item.id === S.dap.configurationId; })) S.dap.configurationId = 'builtin:current-file';
    updateStartButton();
    return configurationSet;
  }

  function updateStartButton() {
    var button = document.getElementById('debug-start');
    if (!button) return;
    var selected = S.dap.configurations.find(function(item) { return item.id === S.dap.configurationId; }) || builtinConfiguration();
    var label = selected.id === 'builtin:current-file' ? tr('Current File') : selected.name;
    var feature = dapFeatureDecision();
    button.disabled = !feature.available || isActive();
    button.title = feature.available
      ? tr('Start Debugging: {configuration} (F5)', { configuration: label })
      : dapUnavailableText();
    button.setAttribute('aria-label', button.title);
  }

  function closeConfigMenu(restoreFocus) {
    var menu = document.getElementById('debug-config-menu');
    var trigger = document.getElementById('debug-config-button');
    if (menu) menu.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideConfigMenu, true);
    document.removeEventListener('contextmenu', outsideConfigMenu, true);
    document.removeEventListener('scroll', closeConfigMenu, true);
    global.removeEventListener('resize', closeConfigMenu);
    global.removeEventListener('blur', closeConfigMenu);
    if (restoreFocus && trigger) trigger.focus();
  }

  function outsideConfigMenu(event) {
    var menu = document.getElementById('debug-config-menu');
    var trigger = document.getElementById('debug-config-button');
    if (menu && !menu.contains(event.target) && trigger && !trigger.contains(event.target)) closeConfigMenu(false);
  }

  function createConfigItem(configuration) {
    var state = availability(configuration);
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-config-item';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(configuration.id === S.dap.configurationId));
    button.disabled = !state.available;
    if (!state.available) button.title = state.reason;
    var indicator = document.createElement('span');
    indicator.className = 'debug-config-indicator';
    indicator.textContent = configuration.id === S.dap.configurationId ? '\u2713' : '';
    var copy = document.createElement('span');
    copy.className = 'debug-config-copy';
    var name = document.createElement('span');
    name.className = 'debug-config-name';
    name.textContent = configuration.id === 'builtin:current-file' ? tr('Current File') : configuration.name;
    var source = document.createElement('small');
    source.className = 'debug-config-source';
    source.textContent = configuration.sourceKind === 'bobocloud' ? 'BOBO' : (configuration.sourceKind === 'vscode' ? 'VS Code' : (state.adapter ? state.adapter.label : 'Auto'));
    copy.append(name, source);
    button.append(indicator, copy);
    if (!state.available || (configuration.warnings && configuration.warnings.length)) {
      var mark = document.createElement('span');
      mark.className = 'debug-config-warning';
      mark.textContent = '!';
      button.appendChild(mark);
    }
    button.addEventListener('click', function() {
      S.dap.configurationId = configuration.id;
      exceptionBreakpointSelectionKey = '';
      ensureExceptionBreakpointSelections(currentBreakpointCapabilities());
      try { localStorage.setItem('bobocloud.debug.configuration.' + S.workspaceRoot, configuration.id); } catch (_) {}
      updateStartButton();
      renderBreakpoints();
      closeConfigMenu(true);
    });
    return button;
  }

  async function editLaunchJson() {
    closeConfigMenu(false);
    try {
      var filePath = await global.api.dapEnsureConfiguration();
      await BOBO.workspace.openFile(filePath, 'launch.json');
    } catch (error) { reportError(error); }
  }

  function renderConfigMenu() {
    var menu = document.getElementById('debug-config-menu');
    if (!menu) return;
    menu.replaceChildren();
    var heading = document.createElement('div');
    heading.className = 'debug-config-heading';
    heading.textContent = tr('Debug configurations');
    menu.appendChild(heading);
    S.dap.configurations.forEach(function(configuration) { menu.appendChild(createConfigItem(configuration)); });
    if (S.dap.configurations.length <= 1) {
      var empty = document.createElement('div');
      empty.className = 'debug-config-empty';
      empty.textContent = tr('No debug configurations found') + '\n' + tr('Add a configuration to .vscode/launch.json or .bobocloud/launch.json.');
      menu.appendChild(empty);
    }
    if (S.dap.warnings.length) {
      var warning = document.createElement('div');
      warning.className = 'debug-config-empty debug-config-warning-summary';
      warning.textContent = tr('{count} debug configuration warning(s)', { count: S.dap.warnings.length });
      warning.title = S.dap.warnings.map(warningText).join('\n');
      menu.appendChild(warning);
    }
    var separator = document.createElement('div');
    separator.className = 'debug-config-separator';
    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'debug-config-edit';
    edit.setAttribute('role', 'menuitem');
    edit.textContent = tr('Edit launch.json');
    edit.addEventListener('click', editLaunchJson);
    menu.append(separator, edit);
  }

  function positionConfigMenu() {
    var menu = document.getElementById('debug-config-menu');
    var trigger = document.getElementById('debug-config-button');
    if (!menu || !trigger) return;
    menu.hidden = false;
    var rect = trigger.getBoundingClientRect();
    var left = Math.max(8, Math.min(rect.right - menu.offsetWidth, global.innerWidth - menu.offsetWidth - 8));
    var top = rect.bottom + 6;
    if (top + menu.offsetHeight > global.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  async function openConfigMenu() {
    await refreshConfigurations();
    renderConfigMenu();
    positionConfigMenu();
    var trigger = document.getElementById('debug-config-button');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    var first = document.querySelector('#debug-config-menu .debug-config-item:not(:disabled)');
    if (first) first.focus();
    setTimeout(function() {
      document.addEventListener('pointerdown', outsideConfigMenu, true);
      document.addEventListener('contextmenu', outsideConfigMenu, true);
      document.addEventListener('scroll', closeConfigMenu, true);
      global.addEventListener('resize', closeConfigMenu);
      global.addEventListener('blur', closeConfigMenu);
    }, 0);
  }

  function appendConsole(text, category) {
    var value = String(text || '').slice(0, MAX_CONSOLE_EVENT_CHARS);
    var lines = value.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) lines.push('');
    lines.forEach(function(line) { consoleQueue.push({ text: line, category: category || 'stdout' }); });
    if (consoleQueue.length > MAX_CONSOLE_LINES) consoleQueue.splice(0, consoleQueue.length - MAX_CONSOLE_LINES);
    if (!consoleFlushTimer) consoleFlushTimer = setTimeout(flushConsole, 50);
  }

  function flushConsole() {
    if (consoleFlushTimer) clearTimeout(consoleFlushTimer);
    consoleFlushTimer = 0;
    if (!consoleQueue.length) return;
    var output = document.getElementById('debug-console-output');
    if (!output) { consoleQueue = []; return; }
    var batch = consoleQueue.splice(0);
    var fragment = document.createDocumentFragment();
    batch.forEach(function(entry) {
      var line = document.createElement('div');
      line.className = 'debug-console-line';
      line.dataset.category = entry.category;
      line.textContent = entry.text;
      fragment.appendChild(line);
    });
    output.appendChild(fragment);
    var overflow = output.childNodes.length - MAX_CONSOLE_LINES;
    while (overflow-- > 0 && output.firstChild) output.removeChild(output.firstChild);
    output.scrollTop = output.scrollHeight;
    consoleRenderPasses += 1;
  }

  function renderCallStack() {
    var container = document.getElementById('debug-call-stack');
    if (!container) return;
    container.replaceChildren();
    if (!S.dap.stackFrames.length) {
      var empty = document.createElement('div');
      empty.className = 'debug-empty';
      empty.textContent = tr('No stack frames');
      container.appendChild(empty);
      return;
    }
    S.dap.stackFrames.forEach(function(frame) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'debug-tree-row' + (frame.id === S.dap.selectedFrameId ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'debug-tree-name';
      name.textContent = frame.name || ('#' + frame.id);
      var meta = document.createElement('span');
      meta.className = 'debug-tree-meta';
      meta.textContent = frame.source && frame.source.name ? frame.source.name + ':' + frame.line : '';
      row.append(name, meta);
      row.addEventListener('click', function() { selectFrame(frame); });
      container.appendChild(row);
    });
  }

  function closeBreakpointPopup() {
    if (!breakpointPopup) return;
    document.removeEventListener('pointerdown', breakpointPopup.onOutside, true);
    global.removeEventListener('resize', breakpointPopup.close);
    global.removeEventListener('blur', breakpointPopup.close);
    if (breakpointPopup.element && breakpointPopup.element.isConnected) breakpointPopup.element.remove();
    breakpointPopup = null;
  }

  function showBreakpointPopup(element, x, y, focusTarget) {
    closeBreakpointPopup();
    element.classList.add('debug-breakpoint-popup');
    document.body.appendChild(element);
    var left = Math.max(8, Math.min(Number(x) || 8, global.innerWidth - element.offsetWidth - 8));
    var top = Math.max(8, Math.min(Number(y) || 8, global.innerHeight - element.offsetHeight - 8));
    element.style.left = left + 'px';
    element.style.top = top + 'px';
    var state = {
      element: element,
      close: closeBreakpointPopup,
      onOutside: function(event) { if (!element.contains(event.target)) closeBreakpointPopup(); }
    };
    breakpointPopup = state;
    element.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeBreakpointPopup(); }
    });
    setTimeout(function() {
      if (breakpointPopup !== state) return;
      document.addEventListener('pointerdown', state.onOutside, true);
      global.addEventListener('resize', state.close);
      global.addEventListener('blur', state.close);
      if (focusTarget) focusTarget.focus();
    }, 0);
  }

  function popupCoordinates(anchor) {
    if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return { x: global.innerWidth / 2 - 120, y: global.innerHeight / 2 - 80 };
    var rect = anchor.getBoundingClientRect();
    return { x: rect.right + 4, y: rect.top };
  }

  function createToolButton(className, label, glyph) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = glyph;
    return button;
  }

  function requestedBreakpointLocation(relative, item) {
    return relative + ':' + item.line + (Number.isSafeInteger(item.column) && item.column > 0 ? ':' + item.column : '');
  }

  function breakpointLocation(relative, item) {
    var requested = requestedBreakpointLocation(relative, item);
    var requestedColumn = Number.isSafeInteger(item.column) && item.column > 0 ? item.column : 1;
    if (actualBreakpointLine(item) === item.line && actualBreakpointColumn(item) === requestedColumn) return requested;
    var actual = relative + ':' + actualBreakpointLine(item) + ':' + actualBreakpointColumn(item);
    return tr('{requested} (actual: {actual})', { requested: requested, actual: actual });
  }

  function updateBreakpoint(relative, item, values) {
    var items = S.dap.breakpoints.get(relative) || [];
    if (items.indexOf(item) < 0) return false;
    Object.keys(values || {}).forEach(function(key) { item[key] = values[key]; });
    item.verified = canSendBreakpoints() && item.enabled !== false ? false : null;
    item.message = '';
    item.id = 0;
    item.stale = false;
    delete item.actualLine;
    delete item.actualColumn;
    sortBreakpoints(items);
    invalidateBreakpointSync(relative);
    saveBreakpoints();
    refreshBreakpointDecorations({ skipReconcile: true });
    renderBreakpoints();
    if (canSendBreakpoints() && !staleSources.has(relative)) setBreakpointsForSource(relative).catch(reportError);
    return true;
  }

  function addBreakpoint(relative, values) {
    var normalized = normalizeBreakpoint(Object.assign({ enabled: true }, values || {}));
    if (!relative || !normalized) return null;
    var items = (S.dap.breakpoints.get(relative) || []).slice();
    var existing = items.find(function(item) {
      return item.line === normalized.line && (Number(item.column) || 0) === (Number(normalized.column) || 0);
    });
    if (existing) {
      updateBreakpoint(relative, existing, normalized);
      return existing;
    }
    items.push(normalized);
    sortBreakpoints(items);
    S.dap.breakpoints.set(relative, items);
    invalidateBreakpointSync(relative);
    saveBreakpoints();
    refreshBreakpointDecorations();
    renderBreakpoints();
    if (canSendBreakpoints() && !staleSources.has(relative)) setBreakpointsForSource(relative).catch(reportError);
    return normalized;
  }

  function deleteBreakpoint(relative, item) {
    var items = (S.dap.breakpoints.get(relative) || []).slice();
    var index = items.indexOf(item);
    if (index < 0) return false;
    items.splice(index, 1);
    if (items.length) S.dap.breakpoints.set(relative, items);
    else S.dap.breakpoints.delete(relative);
    invalidateBreakpointSync(relative);
    saveBreakpoints();
    refreshBreakpointDecorations();
    renderBreakpoints();
    if (canSendBreakpoints() && !staleSources.has(relative)) setBreakpointsForSource(relative).catch(reportError);
    return true;
  }

  function createBreakpointField(form, labelText, className, value, supported, options) {
    options = options || {};
    var label = document.createElement('label');
    label.className = 'debug-breakpoint-field';
    var caption = document.createElement('span');
    caption.textContent = labelText;
    var input = document.createElement(options.multiline ? 'textarea' : 'input');
    input.className = className;
    if (!options.multiline) input.type = options.type || 'text';
    input.value = value === undefined || value === null ? '' : String(value);
    input.maxLength = options.maxLength || MAX_BREAKPOINT_TEXT_CHARS;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.min) input.min = String(options.min);
    input.disabled = supported === false;
    if (supported === false) label.title = tr('This option is not supported by the current debugger.');
    label.append(caption, input);
    form.appendChild(label);
    return input;
  }

  function openBreakpointEditor(relative, item, seed, mode, anchor, coordinates) {
    var capabilities = currentBreakpointCapabilities();
    var existing = item || null;
    var values = Object.assign({ line: 1, enabled: true, condition: '', hitCondition: '', logMessage: '' }, existing || {}, seed || {});
    var editor = document.createElement('form');
    editor.className = 'debug-breakpoint-editor';
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-label', existing ? tr('Edit Breakpoint') : tr('Add Breakpoint'));
    var heading = document.createElement('strong');
    heading.textContent = existing ? tr('Edit Breakpoint') : tr('Add Breakpoint');
    var location = document.createElement('small');
    location.textContent = requestedBreakpointLocation(relative, values);
    editor.append(heading, location);
    var column = createBreakpointField(editor, tr('Column'), 'debug-breakpoint-column', values.column || '', true, { type: 'number', min: 1, maxLength: 16 });
    var condition = null;
    var hitCondition = null;
    var logMessage = null;
    if (capabilities.supportsConditionalBreakpoints || values.condition) {
      condition = createBreakpointField(editor, tr('Expression'), 'debug-breakpoint-condition', values.condition, capabilities.supportsConditionalBreakpoints, { placeholder: tr('Expression to evaluate') });
    }
    if (capabilities.supportsHitConditionalBreakpoints || values.hitCondition) {
      hitCondition = createBreakpointField(editor, tr('Hit Count'), 'debug-breakpoint-hit-condition', values.hitCondition, capabilities.supportsHitConditionalBreakpoints, { placeholder: tr('Break after a number of hits') });
    }
    if (capabilities.supportsLogPoints || values.logMessage) {
      logMessage = createBreakpointField(editor, tr('Log Message'), 'debug-breakpoint-log-message', values.logMessage, capabilities.supportsLogPoints, { placeholder: tr('Message to log; expressions use {expression}') });
    }
    var actions = document.createElement('div');
    actions.className = 'debug-breakpoint-editor-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = tr('Cancel');
    var save = document.createElement('button');
    save.type = 'submit';
    save.className = 'primary';
    save.textContent = tr('Save');
    actions.append(cancel, save);
    editor.appendChild(actions);
    cancel.addEventListener('click', closeBreakpointPopup);
    editor.addEventListener('submit', function(event) {
      event.preventDefault();
      var parsedColumn = column.value ? Number(column.value) : 0;
      var next = {
        column: Number.isSafeInteger(parsedColumn) && parsedColumn > 0 ? parsedColumn : undefined,
        condition: condition && !condition.disabled ? boundedBreakpointText(condition.value) : values.condition,
        hitCondition: hitCondition && !hitCondition.disabled ? boundedBreakpointText(hitCondition.value) : values.hitCondition,
        logMessage: logMessage && !logMessage.disabled ? boundedBreakpointText(logMessage.value, true) : values.logMessage
      };
      if (existing) updateBreakpoint(relative, existing, next);
      else addBreakpoint(relative, Object.assign({}, values, next));
      closeBreakpointPopup();
    });
    var point = coordinates || popupCoordinates(anchor);
    var focus = mode === 'log' && logMessage && !logMessage.disabled
      ? logMessage
      : (mode === 'condition' && condition && !condition.disabled ? condition : column);
    showBreakpointPopup(editor, point.x, point.y, focus);
  }

  function addBreakpointMenuItem(menu, label, action, disabled) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-breakpoint-menu-item';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.addEventListener('click', function() { closeBreakpointPopup(); action(); });
    menu.appendChild(button);
    return button;
  }

  function openBreakpointContextMenu(relative, line, column, coordinates) {
    var items = S.dap.breakpoints.get(relative) || [];
    var item = items.find(function(candidate) { return candidate.actualLine === line; }) ||
      items.find(function(candidate) { return candidate.line === line; });
    var capabilities = currentBreakpointCapabilities();
    var menu = document.createElement('div');
    menu.className = 'debug-breakpoint-menu';
    menu.setAttribute('role', 'menu');
    if (item) {
      addBreakpointMenuItem(menu, tr('Edit Breakpoint'), function() { openBreakpointEditor(relative, item, null, '', null, coordinates); });
      addBreakpointMenuItem(menu, item.enabled === false ? tr('Enable Breakpoint') : tr('Disable Breakpoint'), function() {
        updateBreakpoint(relative, item, { enabled: item.enabled === false });
      });
      addBreakpointMenuItem(menu, tr('Remove Breakpoint'), function() { deleteBreakpoint(relative, item); });
    } else {
      addBreakpointMenuItem(menu, tr('Add Breakpoint'), function() { addBreakpoint(relative, { line: line, column: column }); });
      if (capabilities.supportsConditionalBreakpoints || capabilities.supportsHitConditionalBreakpoints) {
        addBreakpointMenuItem(menu, tr('Add Conditional Breakpoint'), function() {
          openBreakpointEditor(relative, null, { line: line, column: column }, 'condition', null, coordinates);
        });
      }
      if (capabilities.supportsLogPoints) {
        addBreakpointMenuItem(menu, tr('Add Logpoint'), function() {
          openBreakpointEditor(relative, null, { line: line, column: column }, 'log', null, coordinates);
        });
      }
    }
    showBreakpointPopup(menu, coordinates.x, coordinates.y, menu.querySelector('button:not(:disabled)'));
  }

  function openExceptionBreakpointEditor(filter, selection, anchor) {
    var capabilities = currentBreakpointCapabilities();
    if (!filter.supportsCondition || !capabilities.supportsExceptionFilterOptions) return;
    var editor = document.createElement('form');
    editor.className = 'debug-breakpoint-editor';
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-label', tr('Edit Exception Breakpoint'));
    var heading = document.createElement('strong');
    heading.textContent = filter.label;
    editor.appendChild(heading);
    var condition = createBreakpointField(editor, tr('Expression'), 'debug-exception-condition', selection.condition, true, {
      placeholder: filter.conditionDescription || tr('Exception condition')
    });
    var actions = document.createElement('div');
    actions.className = 'debug-breakpoint-editor-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = tr('Cancel');
    var save = document.createElement('button');
    save.type = 'submit';
    save.className = 'primary';
    save.textContent = tr('Save');
    actions.append(cancel, save);
    editor.appendChild(actions);
    cancel.addEventListener('click', closeBreakpointPopup);
    editor.addEventListener('submit', function(event) {
      event.preventDefault();
      selection.enabled = true;
      selection.condition = boundedBreakpointText(condition.value);
      selection.verified = null;
      selection.message = '';
      invalidateExceptionBreakpointSync();
      saveExceptionBreakpoints();
      renderBreakpoints();
      if (canSendBreakpoints()) setExceptionBreakpoints().catch(reportError);
      closeBreakpointPopup();
    });
    var point = popupCoordinates(anchor);
    showBreakpointPopup(editor, point.x, point.y, condition);
  }

  function renderBreakpoints() {
    var container = document.getElementById('debug-breakpoints');
    if (!container) return;
    container.replaceChildren();
    var sourceCount = 0;
    S.dap.breakpoints.forEach(function(items) { sourceCount += items.length; });
    if (sourceCount) {
      var sourceHeading = document.createElement('div');
      sourceHeading.className = 'debug-breakpoint-group-title';
      sourceHeading.textContent = tr('Source Breakpoints');
      container.appendChild(sourceHeading);
    }
    S.dap.breakpoints.forEach(function(items, relative) {
      items.forEach(function(item) {
        var row = document.createElement('div');
        row.className = 'debug-breakpoint-row';
        row.dataset.path = relative;
        row.dataset.line = String(item.line);
        var enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.className = 'debug-breakpoint-enabled';
        enabled.checked = item.enabled !== false;
        enabled.setAttribute('aria-label', item.enabled === false ? tr('Enable Breakpoint') : tr('Disable Breakpoint'));
        var location = document.createElement('button');
        location.type = 'button';
        location.className = 'debug-breakpoint-location';
        location.textContent = breakpointLocation(relative, item);
        location.title = location.textContent;
        var summary = document.createElement('span');
        summary.className = 'debug-breakpoint-summary';
        var capabilityProblem = breakpointCapabilityProblem(item);
        summary.textContent = capabilityProblem || item.message || breakpointDescription(item);
        summary.title = summary.textContent;
        if (capabilityProblem || item.message) row.classList.add('debug-breakpoint-problem');
        var edit = createToolButton('debug-breakpoint-edit', tr('Edit Breakpoint'), '\u270e');
        var remove = createToolButton('debug-breakpoint-remove', tr('Remove Breakpoint'), '\u00d7');
        enabled.addEventListener('change', function() { updateBreakpoint(relative, item, { enabled: enabled.checked }); });
        location.addEventListener('click', async function() {
          var filePath = localPathForSource(sourceForRelative(relative));
          if (!filePath || !BOBO.workspace || !BOBO.workspace.openFile) return;
          await BOBO.workspace.openFile(filePath, relative.split('/').pop());
          if (S.editor) {
            S.editor.setPosition({ lineNumber: actualBreakpointLine(item), column: actualBreakpointColumn(item) });
            S.editor.revealLineInCenter(actualBreakpointLine(item));
            S.editor.focus();
          }
        });
        edit.addEventListener('click', function() { openBreakpointEditor(relative, item, null, '', edit); });
        remove.addEventListener('click', function() { deleteBreakpoint(relative, item); });
        row.append(enabled, location, summary, edit, remove);
        container.appendChild(row);
      });
    });
    var capabilities = currentBreakpointCapabilities();
    ensureExceptionBreakpointSelections(capabilities);
    if (capabilities.exceptionBreakpointFilters.length) {
      var exceptionHeading = document.createElement('div');
      exceptionHeading.className = 'debug-breakpoint-group-title';
      exceptionHeading.textContent = tr('Exception Breakpoints');
      container.appendChild(exceptionHeading);
      capabilities.exceptionBreakpointFilters.forEach(function(filter) {
        var selection = exceptionBreakpointSelections.get(filter.filter);
        if (!selection) return;
        var row = document.createElement('div');
        row.className = 'debug-exception-breakpoint-row';
        row.dataset.filter = filter.filter;
        var enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.className = 'debug-exception-enabled';
        enabled.checked = selection.enabled === true;
        enabled.setAttribute('aria-label', tr('Toggle exception breakpoint: {label}', { label: filter.label }));
        var copy = document.createElement('span');
        copy.className = 'debug-exception-copy';
        var label = document.createElement('span');
        label.className = 'debug-exception-label';
        label.textContent = filter.label;
        var description = document.createElement('small');
        description.textContent = selection.message || selection.condition || filter.description;
        copy.append(label, description);
        row.append(enabled, copy);
        if (filter.supportsCondition && capabilities.supportsExceptionFilterOptions) {
          var edit = createToolButton('debug-breakpoint-edit', tr('Edit Exception Breakpoint'), '\u270e');
          edit.addEventListener('click', function() { openExceptionBreakpointEditor(filter, selection, edit); });
          row.appendChild(edit);
        }
        enabled.addEventListener('change', function() {
          selection.enabled = enabled.checked;
          selection.verified = null;
          selection.message = '';
          invalidateExceptionBreakpointSync();
          saveExceptionBreakpoints();
          renderBreakpoints();
          if (canSendBreakpoints()) setExceptionBreakpoints().catch(reportError);
        });
        container.appendChild(row);
      });
    }
    if (!sourceCount && !capabilities.exceptionBreakpointFilters.length) {
      var empty = document.createElement('div');
      empty.className = 'debug-empty';
      empty.textContent = capabilities.known
        ? tr('No breakpoints')
        : tr('No breakpoints. Start debugging to discover debugger capabilities.');
      container.appendChild(empty);
    }
  }

  function selectInspectorSection(section, focus) {
    var allowed = ['stack', 'variables', 'watch', 'breakpoints', 'console'];
    if (allowed.indexOf(section) < 0) return;
    activeInspectorSection = section;
    document.querySelectorAll('[data-debug-inspector-tab]').forEach(function(tab) {
      var selected = tab.getAttribute('data-debug-inspector-tab') === section;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    document.querySelectorAll('.debug-section[data-debug-section]').forEach(function(panel) {
      panel.classList.toggle('debug-section-active', panel.getAttribute('data-debug-section') === section);
    });
  }

  function bindInspectorTabs() {
    var tabs = Array.from(document.querySelectorAll('[data-debug-inspector-tab]'));
    tabs.forEach(function(tab, index) {
      tab.addEventListener('click', function() { selectInspectorSection(tab.getAttribute('data-debug-inspector-tab')); });
      tab.addEventListener('keydown', function(event) {
        var nextIndex = -1;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabs.length - 1;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (nextIndex < 0) return;
        event.preventDefault();
        selectInspectorSection(tabs[nextIndex].getAttribute('data-debug-inspector-tab'), true);
      });
    });
    selectInspectorSection(activeInspectorSection);
  }

  function variableRow(variable, depth, epoch) {
    var wrapper = document.createElement('div');
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'debug-tree-row';
    row.style.paddingLeft = (8 + depth * 13) + 'px';
    var name = document.createElement('span');
    name.className = 'debug-tree-name';
    name.textContent = (variable.variablesReference ? '\u203a ' : '') + String(variable.name || '');
    var value = document.createElement('span');
    value.className = 'debug-tree-value';
    value.textContent = String(variable.value === undefined ? '' : variable.value);
    var type = document.createElement('span');
    type.className = 'debug-tree-type';
    type.textContent = String(variable.type || '');
    var truncated = variable.__bobocloudTruncated || {};
    if (truncated.name) name.title = tr('Variable name was truncated for display.');
    if (truncated.value) value.title = tr('Variable value was truncated for display.');
    if (truncated.type) type.title = tr('Variable type was truncated for display.');
    row.append(name, value, type);
    wrapper.appendChild(row);
    if (variable.variablesReference) row.addEventListener('click', async function() {
      var child = wrapper.querySelector(':scope > .debug-variable-children');
      if (child) { child.hidden = !child.hidden; return; }
      child = document.createElement('div');
      child.className = 'debug-variable-children';
      wrapper.appendChild(child);
      try {
        await appendVariablePage(child, variable.variablesReference, depth + 1, 0, epoch);
      } catch (error) { child.textContent = error.message; }
    });
    return wrapper;
  }

  async function loadVariablePage(variablesReference, start) {
    var result = await global.api.dapRequest('variables', {
      variablesReference: variablesReference,
      start: start,
      count: VARIABLE_PAGE_SIZE
    });
    var received = Array.isArray(result.variables) ? result.variables : [];
    var paging = result.__bobocloudPage || {};
    return {
      variables: received.slice(0, VARIABLE_PAGE_SIZE),
      hasMore: paging.adapterIgnoredCount !== true && paging.hasMore === true,
      truncated: paging.adapterIgnoredCount === true,
      signature: received.slice(0, VARIABLE_PAGE_SIZE).map(function(variable) {
        return [variable.name, variable.value, variable.type, variable.variablesReference].join('\u0000');
      }).join('\u0001')
    };
  }

  function appendVariableTruncation(container, depth) {
    var note = document.createElement('div');
    note.className = 'debug-tree-row debug-variable-truncated';
    note.style.paddingLeft = (8 + depth * 13) + 'px';
    note.textContent = tr('More variables are available; this debug adapter does not support paging.');
    container.appendChild(note);
  }

  async function appendVariablePage(container, variablesReference, depth, start, epoch, previousSignature) {
    epoch = epoch === undefined ? pauseEpoch : epoch;
    var page = await loadVariablePage(variablesReference, start);
    if (epoch !== pauseEpoch || !isPaused() || !container.isConnected) return [];
    if (start > 0 && page.signature && page.signature === previousSignature) {
      appendVariableTruncation(container, depth);
      return [];
    }
    page.variables.forEach(function(entry) { container.appendChild(variableRow(entry, depth, epoch)); });
    if (page.truncated) appendVariableTruncation(container, depth);
    if (page.hasMore) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'debug-tree-row debug-load-more';
      more.style.paddingLeft = (8 + depth * 13) + 'px';
      more.textContent = tr('Load more variables');
      more.addEventListener('click', async function() {
        more.disabled = true;
        try { await appendVariablePage(container, variablesReference, depth, start + VARIABLE_PAGE_SIZE, epoch, page.signature); }
        finally { more.remove(); }
      });
      container.appendChild(more);
    }
    return page.variables;
  }

  function renderVariables(groups) {
    var container = document.getElementById('debug-variables');
    if (!container) return;
    container.replaceChildren();
    if (!groups || !groups.length) {
      var empty = document.createElement('div');
      empty.className = 'debug-empty';
      empty.textContent = tr('No variables');
      container.appendChild(empty);
      return;
    }
    groups.forEach(function(group) {
      var label = document.createElement('div');
      label.className = 'debug-tree-row debug-scope-label';
      var text = document.createElement('span');
      text.className = 'debug-tree-name';
      text.textContent = group.name;
      label.appendChild(text);
      var entries = document.createElement('div');
      entries.className = 'debug-variable-scope';
      container.append(label, entries);
      group.page.variables.forEach(function(variable) { entries.appendChild(variableRow(variable, 1, group.epoch)); });
      if (group.page.truncated) appendVariableTruncation(entries, 1);
      if (group.page.hasMore) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'debug-tree-row debug-load-more';
        more.style.paddingLeft = '21px';
        more.textContent = tr('Load more variables');
        more.addEventListener('click', async function() {
          more.disabled = true;
          try { await appendVariablePage(entries, group.variablesReference, 1, VARIABLE_PAGE_SIZE, group.epoch, group.page.signature); }
          finally { more.remove(); }
        });
        entries.appendChild(more);
      }
    });
  }

  async function evaluateWatches(epoch) {
    epoch = epoch === undefined ? pauseEpoch : epoch;
    if (!isPaused() || !S.dap.selectedFrameId) { renderWatches(); return; }
    var values = await Promise.all(S.dap.watches.map(async function(expression) {
      try {
        var result = await global.api.dapRequest('evaluate', { expression: expression, frameId: S.dap.selectedFrameId, context: 'watch' });
        return { expression: expression, value: result.result, type: result.type, variablesReference: result.variablesReference || 0 };
      } catch (error) { return { expression: expression, value: error.message, error: true }; }
    }));
    if (epoch === pauseEpoch && isPaused()) renderWatches(values);
  }

  function renderWatches(values) {
    var container = document.getElementById('debug-watch-list');
    if (!container) return;
    container.replaceChildren();
    if (!S.dap.watches.length) {
      var empty = document.createElement('div');
      empty.className = 'debug-empty';
      empty.textContent = tr('No watch expressions');
      container.appendChild(empty);
      return;
    }
    S.dap.watches.forEach(function(expression, index) {
      var result = values && values[index];
      var row = document.createElement('div');
      row.className = 'debug-tree-row';
      var name = document.createElement('span');
      name.className = 'debug-tree-name';
      name.textContent = expression;
      var value = document.createElement('span');
      value.className = 'debug-tree-value';
      value.textContent = result ? String(result.value || '') : (isPaused() ? '' : tr('Not available while the program is running'));
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'debug-watch-remove';
      remove.title = tr('Remove Watch Expression');
      remove.setAttribute('aria-label', remove.title);
      remove.textContent = '\u00d7';
      remove.addEventListener('click', function() {
        S.dap.watches.splice(index, 1);
        saveWatches();
        evaluateWatches(pauseEpoch);
      });
      row.append(name, value, remove);
      container.appendChild(row);
    });
  }

  function beginAddWatch() {
    selectInspectorSection('watch');
    var container = document.getElementById('debug-watch-list');
    if (!container || container.querySelector('.debug-watch-input')) return;
    var row = document.createElement('div');
    row.className = 'debug-tree-row debug-watch-input';
    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('aria-label', tr('Add Watch Expression'));
    row.appendChild(input);
    container.appendChild(row);
    input.focus();
    function finish(save) {
      var value = input.value.trim();
      if (save && value && S.dap.watches.indexOf(value) < 0) S.dap.watches.push(value);
      saveWatches();
      evaluateWatches(pauseEpoch);
    }
    input.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function() { if (row.isConnected) finish(Boolean(input.value.trim())); }, { once: true });
  }

  async function selectFrame(frame, epoch) {
    epoch = epoch === undefined ? pauseEpoch : epoch;
    if (epoch !== pauseEpoch || !isPaused()) return;
    var token = ++selectedFrameToken;
    S.dap.selectedFrameId = frame.id;
    renderCallStack();
    await revealFrame(frame, epoch);
    try {
      var scopes = await global.api.dapRequest('scopes', { frameId: frame.id });
      if (token !== selectedFrameToken || epoch !== pauseEpoch || !isPaused()) return;
      var groups = await Promise.all((scopes.scopes || []).map(async function(scope) {
        return {
          name: scope.name,
          variablesReference: scope.variablesReference,
          page: await loadVariablePage(scope.variablesReference, 0),
          epoch: epoch
        };
      }));
      if (token !== selectedFrameToken || epoch !== pauseEpoch || !isPaused()) return;
      renderVariables(groups);
      await evaluateWatches(epoch);
    } catch (error) { if (token === selectedFrameToken && epoch === pauseEpoch && isPaused()) renderVariables([]); }
  }

  async function refreshStoppedState(threadId, reason) {
    if (!isActive()) return;
    var epoch = ++pauseEpoch;
    selectedFrameToken += 1;
    setPhase('stopped', tr('Paused on {reason}', { reason: stopReasonText(reason) }));
    selectInspectorSection('stack');
    if (BOBO.switchToPanel) BOBO.switchToPanel('debug');
    try {
      var threads = await global.api.dapRequest('threads', {});
      if (epoch !== pauseEpoch || !isPaused()) return;
      S.dap.threads = threads.threads || [];
      S.dap.selectedThreadId = Number(threadId) || (S.dap.threads[0] && S.dap.threads[0].id) || 0;
      var stack = await global.api.dapRequest('stackTrace', { threadId: S.dap.selectedThreadId, startFrame: 0, levels: 100 });
      if (epoch !== pauseEpoch || !isPaused()) return;
      S.dap.stackFrames = stack.stackFrames || [];
      S.dap.selectedFrameId = S.dap.stackFrames[0] ? S.dap.stackFrames[0].id : 0;
      renderCallStack();
      if (S.dap.stackFrames[0]) await selectFrame(S.dap.stackFrames[0], epoch);
      else { renderVariables([]); renderWatches(); }
    } catch (error) { reportError(error); }
  }

  function handleBreakpointEvent(body) {
    var remote = body && body.breakpoint;
    if (!remote) return;
    var local = localPathForSource(remote.source || {});
    var relative = relativeWorkspacePath(local);
    var items = relative ? (S.dap.breakpoints.get(relative) || []) : [];
    var item = items.find(function(candidate) { return remote.id && candidate.id === remote.id; }) ||
      items.find(function(candidate) {
        var lineMatches = remote.line && (candidate.line === remote.line || candidate.actualLine === remote.line);
        var columnMatches = !remote.column || (!candidate.column && !candidate.actualColumn) ||
          candidate.column === remote.column || candidate.actualColumn === remote.column;
        return lineMatches && columnMatches;
      });
    if (!item && remote.id) {
      S.dap.breakpoints.forEach(function(candidates, candidateRelative) {
        if (item) return;
        var candidate = candidates.find(function(value) { return value.id === remote.id; });
        if (candidate) { relative = candidateRelative; items = candidates; item = candidate; }
      });
    }
    if (!item || !relative || staleSources.has(relative)) return;
    if (body.reason === 'removed') {
      var index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
      if (!items.length) S.dap.breakpoints.delete(relative);
      invalidateBreakpointSync(relative);
      saveBreakpoints();
      refreshBreakpointDecorations({ skipReconcile: true });
      renderBreakpoints();
      return;
    }
    item.verified = remote.verified !== false;
    item.message = String(remote.message || '').slice(0, 2048);
    item.stale = false;
    delete item.actualLine;
    delete item.actualColumn;
    if (Number.isSafeInteger(remote.line) && remote.line > 0) item.actualLine = remote.line;
    if (Number.isSafeInteger(remote.column) && remote.column > 0) item.actualColumn = remote.column;
    sortBreakpoints(items);
    saveBreakpoints();
    refreshBreakpointDecorations({ skipReconcile: true });
    renderBreakpoints();
  }

  async function handleReverseRequest(request) {
    var message = request.command === 'runInTerminal'
      ? tr('The cloud debug adapter owns the terminal process.')
      : tr('This debug adapter request is not supported by the client.');
    try { await global.api.dapRespond(request, false, {}, message); } catch (_) {}
  }

  function handleDapMessage(payload) {
    if (!eventIsCurrent(payload)) return;
    var message = payload.message;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'request') { handleReverseRequest(message); return; }
    if (message.type === 'response' && message.success === false) {
      if (message.message) appendConsole(tr('Details: {message}', { message: String(message.message) }), 'stderr');
      return;
    }
    if (message.type !== 'event') return;
    var body = message.body || {};
    if (message.event === 'initialized') {
      adapterInitialized = true;
      initializedWaiters.splice(0).forEach(function(resolve) { resolve(); });
    } else if (message.event === 'stopped') {
      refreshStoppedState(body.threadId, body.reason);
    } else if (message.event === 'continued') {
      pauseEpoch += 1;
      selectedFrameToken += 1;
      clearCurrentLine();
      S.dap.threads = [];
      S.dap.stackFrames = [];
      S.dap.scopes = [];
      S.dap.variables = [];
      S.dap.selectedThreadId = 0;
      S.dap.selectedFrameId = 0;
      renderCallStack();
      renderVariables([]);
      setPhase('running');
      renderWatches();
    } else if (message.event === 'output') {
      appendConsole(body.output || '', body.category || 'stdout');
    } else if (message.event === 'breakpoint') {
      handleBreakpointEvent(body);
    } else if (message.event === 'capabilities' && body.capabilities && typeof body.capabilities === 'object') {
      S.dap.capabilities = Object.assign({}, S.dap.capabilities || {}, body.capabilities);
      rememberBreakpointCapabilities(S.dap.capabilities);
      invalidateAllBreakpointSyncs();
      invalidateExceptionBreakpointSync();
      if (canSendBreakpoints()) {
        syncAllBreakpoints().catch(reportError);
        setExceptionBreakpoints().catch(reportError);
      }
    } else if (message.event === 'exited') {
      appendConsole(tr('Process exited with code {code}', { code: body.exitCode }), 'console');
    } else if (message.event === 'terminated') {
      finalizeDebugSession('terminated', { runPost: true, message: tr('Debug session ended') }).catch(function() {});
    } else if (message.event === 'thread' && isPaused()) {
      refreshStoppedState(S.dap.selectedThreadId, 'thread');
    }
  }

  function handleDapStatus(payload) {
    var status = payload && payload.status;
    if (!status || !payload.context || !contextIsCurrent(payload.context)) return;
    if (status.state === 'idle' && isActive() && !stopping) {
      finalizeDebugSession('transport-idle', { runPost: true, message: tr('Debug session ended') }).catch(function() {});
      return;
    }
    if ((status.state === 'disconnected' || status.state === 'error') && isActive() && !stopping) {
      var friendly = dapServiceError(status.code);
      var detail = status.details && status.details.reason ? String(status.details.reason) : String(status.error || '');
      finalizeDebugSession(status.state, { runPost: true, phase: 'error', message: friendly }).then(function() {
        if (detail && detail !== friendly) appendConsole(tr('Details: {message}', { message: detail }), 'stderr');
      }).catch(function() {});
      if (BOBO.toast) BOBO.toast.error(friendly);
    }
  }

  function waitForInitialized(timeoutMs) {
    if (adapterInitialized) return Promise.resolve();
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        var index = initializedWaiters.indexOf(done);
        if (index >= 0) initializedWaiters.splice(index, 1);
        reject(new Error(tr('The debug adapter did not finish initialization.')));
      }, timeoutMs || 10000);
      function done(error) {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }
      initializedWaiters.push(done);
    });
  }

  function selectedConfiguration() {
    return S.dap.configurations.find(function(item) { return item.id === S.dap.configurationId; }) || builtinConfiguration();
  }

  function lifecycleTaskRequest(label, context) {
    return {
      label: label,
      context: {
        activeFile: context.activeFile || '',
        lineNumber: context.lineNumber || 1,
        columnNumber: context.columnNumber || 1,
        selectedText: context.selectedText || ''
      }
    };
  }

  async function runLifecycleTask(label, stage, context) {
    if (!label) return { success: true, returnCode: 0, cancelled: false, code: 'skipped', message: '' };
    if (!BOBO.runner || typeof BOBO.runner.startProjectTaskExecution !== 'function') {
      throw new Error('Debug lifecycle task support is unavailable');
    }
    if (!contextIsCurrent(context)) {
      return { success: false, returnCode: null, cancelled: true, code: 'context-changed', message: '' };
    }
    var isPreLaunch = stage === 'preLaunchTask';
    var runningMessage = isPreLaunch
      ? tr('Running pre-launch task: {task}', { task: label })
      : tr('Running post-debug task: {task}', { task: label });
    appendConsole(runningMessage, 'console');
    setPhase('preparing', runningMessage);
    var handle = BOBO.runner.startProjectTaskExecution(lifecycleTaskRequest(label, context), { owner: 'dap-lifecycle' });
    activeLifecycleTaskHandle = handle;
    var outcome;
    try {
      outcome = await handle.completion;
    } finally {
      if (activeLifecycleTaskHandle === handle) activeLifecycleTaskHandle = null;
    }
    if (outcome.success) {
      appendConsole(isPreLaunch
        ? tr('Pre-launch task completed: {task}', { task: label })
        : tr('Post-debug task completed: {task}', { task: label }), 'console');
    }
    return outcome;
  }

  function lifecycleTaskError(stage, label, outcome) {
    var isPreLaunch = stage === 'preLaunchTask';
    if (outcome && outcome.cancelled) {
      return new Error(isPreLaunch
        ? tr('Pre-launch task was cancelled: {task}', { task: label })
        : tr('Post-debug task was cancelled: {task}', { task: label }));
    }
    if (outcome && Number.isInteger(outcome.returnCode)) {
      return new Error(isPreLaunch
        ? tr('Pre-launch task "{task}" failed with exit code {code}.', { task: label, code: outcome.returnCode })
        : tr('Post-debug task "{task}" failed with exit code {code}.', { task: label, code: outcome.returnCode }));
    }
    return new Error(isPreLaunch
      ? tr('Pre-launch task failed: {task}', { task: label })
      : tr('Post-debug task failed: {task}', { task: label }));
  }

  async function runPostDebugTask(lifecycle) {
    if (!lifecycle || !lifecycle.reachedRunning || !lifecycle.postDebugTask || lifecycle.postStarted) return;
    if (!contextIsCurrent(lifecycle.context)) return;
    lifecycle.postStarted = true;
    try {
      var outcome = await runLifecycleTask(lifecycle.postDebugTask, 'postDebugTask', lifecycle.context);
      if (!outcome.success && !outcome.cancelled) {
        var error = lifecycleTaskError('postDebugTask', lifecycle.postDebugTask, outcome);
        appendConsole(error.message, 'stderr');
        if (BOBO.toast) BOBO.toast.error(error.message);
      }
    } catch (error) {
      var message = localizeDebugError(error);
      appendConsole(message, 'stderr');
      if (BOBO.toast) BOBO.toast.error(message);
    }
  }

  async function finalizeDebugSession(reason, options) {
    options = options || {};
    if (finalizePromise) {
      if (options.runPost === false) {
        if (finalizeState) finalizeState.suppressPost = true;
        if (activeLifecycleTaskHandle && typeof activeLifecycleTaskHandle.cancel === 'function') {
          try { await activeLifecycleTaskHandle.cancel(reason || 'identity-change'); } catch (_) {}
        }
      }
      return finalizePromise;
    }
    var lifecycle = debugLifecycle;
    var state = { suppressPost: options.runPost === false };
    finalizeState = state;
    var operation = (async function() {
      stopping = true;
      invalidateAllBreakpointSyncs();
      invalidateExceptionBreakpointSync();
      if (activeLifecycleTaskHandle && typeof activeLifecycleTaskHandle.cancel === 'function') {
        try { await activeLifecycleTaskHandle.cancel(reason || 'debug-ended'); } catch (_) {}
      }
      if (options.disconnect === true && lifecycle && lifecycle.transportStarted) {
        try { await global.api.dapRequest('disconnect', { restart: false, terminateDebuggee: true }, 2500); } catch (_) {}
      }
      try { await global.api.dapStop(reason || 'stop'); } catch (_) {}
      if (options.runPost === true && !state.suppressPost) await runPostDebugTask(lifecycle);
      if (debugLifecycle === lifecycle) debugLifecycle = null;
      finishSession(options.phase === 'error' ? 'error' : 'idle', options.message || tr('Debug session ended'));
      return true;
    })();
    finalizePromise = operation;
    try {
      return await operation;
    } finally {
      if (finalizePromise === operation) finalizePromise = null;
      if (finalizeState === state) finalizeState = null;
      stopping = false;
    }
  }

  async function startInternal(configurationId) {
    if (isActive()) return false;
    if (!dapFeatureDecision().available) { reportError(new Error(dapUnavailableText())); updateStartButton(); return false; }
    if (!S.workspaceRoot) { reportError(new Error(tr('No workspace is open.'))); return false; }
    if (BOBO.runner && BOBO.runner.isBusy && BOBO.runner.isBusy()) { reportError(new Error(tr('Cannot start debugging while code is running.'))); return false; }
    if (!S.selectedRuntime) { reportError(new Error(tr('Select a cloud runtime before debugging.'))); return false; }
    var sessionId = clientSessionId();
    S.dap.clientSessionId = sessionId;
    adapterInitialized = false;
    exceptionBreakpointSyncState = { revision: 0, tail: Promise.resolve() };
    var initialContext = contextSnapshot(sessionId);
    S.dap.authEpoch = initialContext.authEpoch;
    setPhase('preparing');
    clearConsole();
    try {
      var hadDirtyTabs = Array.isArray(S.tabs) && S.tabs.some(function(tab) { return tab && tab.dirty; });
      if (!BOBO.workspace || !await BOBO.workspace.saveAllTabs()) throw new Error(tr('Project files could not be saved.'));
      if (hadDirtyTabs && BOBO.runner && typeof BOBO.runner.markWorkspaceChanged === 'function') BOBO.runner.markWorkspaceChanged();
      if (!contextIsCurrent(initialContext)) throw new Error(tr('The workspace changed while starting the debug session.'));
      await refreshConfigurations();
      if (!contextIsCurrent(initialContext)) throw new Error(tr('The workspace changed while starting the debug session.'));
      if (configurationId) S.dap.configurationId = configurationId;
      var selected = selectedConfiguration();
      var available = availability(selected);
      if (!available.available) {
        reportError(new Error(available.reason));
        finishSession('idle');
        return false;
      }
      invalidateAllBreakpointSyncs();
      staleSources.clear();
      staleSourceNotified.clear();
      S.dap.breakpoints.forEach(function(items) {
        items.forEach(function(item) {
          item.verified = null;
          item.message = '';
          item.id = 0;
          item.stale = false;
          delete item.actualLine;
          delete item.actualColumn;
        });
      });
      var resolved = await global.api.dapResolve(selected.id, initialContext);
      if (!contextIsCurrent(initialContext)) throw new Error(tr('The workspace changed while starting the debug session.'));
      debugLifecycle = {
        context: initialContext,
        preLaunchTask: String(resolved.preLaunchTask || ''),
        postDebugTask: String(resolved.postDebugTask || ''),
        transportStarted: false,
        reachedRunning: false,
        postStarted: false
      };
      if (debugLifecycle.preLaunchTask) {
        var preLaunchOutcome = await runLifecycleTask(debugLifecycle.preLaunchTask, 'preLaunchTask', initialContext);
        if (!preLaunchOutcome.success) throw lifecycleTaskError('preLaunchTask', debugLifecycle.preLaunchTask, preLaunchOutcome);
      } else {
        if (!BOBO.runner || !await BOBO.runner.ensureWorkspaceSyncedForRun()) throw new Error(tr('Workspace synchronization failed.'));
      }
      if (!contextIsCurrent(initialContext)) throw new Error(tr('The workspace changed while starting the debug session.'));
      var language = available.language || languageForType(resolved.type);
      setPhase('connecting');
      var started = await global.api.dapStart({
        languageId: language,
        runtimeId: S.selectedRuntime,
        setupCommands: Array.isArray(S.setupCommands) ? S.setupCommands.slice() : [],
        workspace: workspaceBinding(),
        context: initialContext
      });
      if (started && started.status && started.status.state === 'error') {
        var startError = new Error(String(started.status.error || ''));
        startError.code = String(started.status.code || 'start_failed');
        throw startError;
      }
      if (!contextIsCurrent(initialContext)) throw new Error(tr('The workspace changed while starting the debug session.'));
      debugLifecycle.transportStarted = true;
      expectedTransportGeneration = Number(started && started.status && started.status.generation) || 0;
      S.dap.adapter = started.status && started.status.adapter;
      var dependencyCache = started.status && started.status.dependencyCache;
      if (dependencyCache && dependencyCache.required && dependencyCache.state !== 'mounted') {
        appendConsole(tr('Project dependencies are unavailable for this debug session. Run or repair the project environment first.'), 'stderr');
      }
      S.dap.capabilities = await global.api.dapRequest('initialize', {
        clientID: 'bobocloud-editor',
        clientName: 'BOBOCLOUD Editor',
        adapterID: String(resolved.type || ''),
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: true,
        supportsRunInTerminalRequest: false,
        supportsProgressReporting: false,
        locale: document.documentElement.lang || 'en'
      }, 20000);
      rememberBreakpointCapabilities(S.dap.capabilities || {});
      if (!contextIsCurrent(initialContext) || !isActive()) throw new Error(tr('The debug session ended while it was starting.'));
      setPhase('configuring');
      var initializedEvent = waitForInitialized(12000);
      var launchOutcome = global.api.dapRequest('launch', resolved.configuration, 60000).then(function(value) {
        return { ok: true, value: value };
      }, function(error) { return { ok: false, error: error }; });
      await initializedEvent;
      if (!contextIsCurrent(initialContext) || !isActive()) throw new Error(tr('The debug session ended while it was starting.'));
      await syncAllBreakpoints();
      if (!contextIsCurrent(initialContext) || !isActive()) throw new Error(tr('The debug session ended while it was starting.'));
      await setExceptionBreakpoints();
      if (!contextIsCurrent(initialContext) || !isActive()) throw new Error(tr('The debug session ended while it was starting.'));
      if (!S.dap.capabilities || S.dap.capabilities.supportsConfigurationDoneRequest !== false) {
        await global.api.dapRequest('configurationDone', {}, 15000);
      }
      if (!contextIsCurrent(initialContext) || !isActive()) throw new Error(tr('The debug session ended while it was starting.'));
      // js-debug uses the root session as a breakpoint/configuration staging
      // area. configurationDone triggers its reverse startDebugging request;
      // only after that handoff does launch resolve and later requests route
      // to the actual child session.
      var launch = await launchOutcome;
      if (!launch.ok) throw launch.error;
      if (!contextIsCurrent(initialContext) || !isActive()) throw new Error(tr('The debug session ended while it was starting.'));
      debugLifecycle.reachedRunning = true;
      if (S.dap.phase !== 'stopped') setPhase('running', S.dap.adapter ? tr('Adapter: {adapter}', { adapter: S.dap.adapter.label || S.dap.adapter.id }) : '');
      if (BOBO.switchToPanel) BOBO.switchToPanel('debug');
      return true;
    } catch (error) {
      if (finalizePromise || stopping || !contextIsCurrent(initialContext)) return false;
      if (activeLifecycleTaskHandle && typeof activeLifecycleTaskHandle.cancel === 'function') {
        try { await activeLifecycleTaskHandle.cancel('start-failed'); } catch (_) {}
      }
      try { await global.api.dapStop('start-failed'); } catch (_) {}
      var friendly = localizeDebugError(error);
      debugLifecycle = null;
      finishSession('error', tr('Debug session failed: {message}', { message: friendly }));
      var detail = plainErrorText(error);
      if (detail && detail !== friendly) appendConsole(tr('Details: {message}', { message: detail }), 'stderr');
      if (BOBO.toast) BOBO.toast.error(friendly);
      return false;
    }
  }

  function start(configurationId) {
    if (startPromise) return startPromise;
    if (isActive()) return Promise.resolve(false);
    var pending = startInternal(configurationId);
    startPromise = pending;
    pending.then(function() { if (startPromise === pending) startPromise = null; }, function() { if (startPromise === pending) startPromise = null; });
    return pending;
  }

  async function execute(command) {
    if (!isActive()) return false;
    var threadId = S.dap.selectedThreadId || (S.dap.threads[0] && S.dap.threads[0].id) || 0;
    try {
      if (command === 'stop') return stop('user');
      if (command === 'restart') {
        if (S.dap.capabilities && S.dap.capabilities.supportsRestartRequest) {
          await global.api.dapRequest('restart', {});
          setPhase('running');
          return true;
        }
        var id = S.dap.configurationId;
        await stop('restart');
        return start(id);
      }
      if (command === 'pause' && !threadId) {
        var threads = await global.api.dapRequest('threads', {});
        if (!isActive()) return false;
        threadId = threads && threads.threads && threads.threads[0] ? Number(threads.threads[0].id) : 0;
        if (!threadId) throw new Error(tr('The debug adapter did not report a thread that can be paused.'));
      }
      await global.api.dapRequest(command, { threadId: threadId, singleThread: false });
      if (command !== 'pause') { clearCurrentLine(); setPhase('running'); }
      return true;
    } catch (error) { reportError(error); return false; }
  }

  async function stop(reason) {
    if (!isActive() && !S.dap.clientSessionId) return true;
    return finalizeDebugSession(reason || 'stop', {
      disconnect: Boolean(debugLifecycle && debugLifecycle.transportStarted),
      runPost: true,
      message: tr('Debug session ended')
    });
  }

  async function abort(reason) {
    if (!isActive() && !S.dap.clientSessionId) return true;
    return finalizeDebugSession(reason || 'identity-change', {
      disconnect: false,
      runPost: false,
      message: tr('Debug session ended')
    });
  }

  function finishSession(phase, message) {
    pauseEpoch += 1;
    selectedFrameToken += 1;
    initializedWaiters.splice(0).forEach(function(done) { done(new Error(tr('The debug session ended while it was starting.'))); });
    adapterInitialized = false;
    expectedTransportGeneration = 0;
    clearCurrentLine();
    S.dap.threads = [];
    S.dap.stackFrames = [];
    S.dap.selectedThreadId = 0;
    S.dap.selectedFrameId = 0;
    S.dap.adapter = null;
    S.dap.capabilities = null;
    S.dap.clientSessionId = '';
    renderCallStack();
    renderVariables([]);
    renderWatches();
    renderBreakpoints();
    setPhase(phase === 'error' ? 'error' : 'idle');
    if (message) appendConsole(message, phase === 'error' ? 'stderr' : 'console');
    flushConsole();
  }

  function reportError(error) {
    var message = localizeDebugError(error);
    appendConsole(message, 'stderr');
    if (BOBO.toast) BOBO.toast.error(message);
  }

  function clearConsole() {
    if (consoleFlushTimer) clearTimeout(consoleFlushTimer);
    consoleFlushTimer = 0;
    consoleQueue = [];
    var output = document.getElementById('debug-console-output');
    if (output) output.replaceChildren();
  }

  async function beforeWorkspaceLeave() {
    refreshGeneration += 1;
    closeConfigMenu(false);
    closeBreakpointPopup();
    if (isActive() || S.dap.clientSessionId) await abort('workspace-change');
    return true;
  }

  function workspaceChanged() {
    refreshGeneration += 1;
    expectedTransportGeneration = 0;
    S.dap.clientSessionId = '';
    closeBreakpointPopup();
    S.dap.configurationId = 'builtin:current-file';
    try {
      var saved = localStorage.getItem('bobocloud.debug.configuration.' + S.workspaceRoot);
      if (saved) S.dap.configurationId = saved;
    } catch (_) {}
    loadWorkspaceState();
    refreshConfigurations().catch(reportError);
  }

  async function evaluateConsole() {
    var input = document.getElementById('debug-console-input');
    var expression = input ? input.value.trim() : '';
    if (!expression || !isActive()) return;
    input.value = '';
    appendConsole('> ' + expression, 'console');
    try {
      var result = await global.api.dapRequest('evaluate', {
        expression: expression,
        frameId: isPaused() ? S.dap.selectedFrameId : undefined,
        context: 'repl'
      });
      appendConsole(result.result || '', 'stdout');
    } catch (error) { appendConsole(error.message, 'stderr'); }
  }

  function bindDom() {
    var breakpointTab = document.getElementById('debug-inspector-tab-breakpoints');
    if (breakpointTab) breakpointTab.textContent = tr('Breakpoints');
    var breakpointHeading = document.querySelector('#debug-section-breakpoints > header > span');
    if (breakpointHeading) breakpointHeading.textContent = tr('Breakpoints');
    var startButton = document.getElementById('debug-start');
    if (startButton) startButton.addEventListener('click', function() { start(); });
    var configButton = document.getElementById('debug-config-button');
    if (configButton) configButton.addEventListener('click', function() {
      var menu = document.getElementById('debug-config-menu');
      if (menu && !menu.hidden) closeConfigMenu(true);
      else openConfigMenu().catch(reportError);
    });
    var menu = document.getElementById('debug-config-menu');
    if (menu) menu.addEventListener('keydown', function(event) {
      var items = Array.from(menu.querySelectorAll('button:not(:disabled)'));
      var index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closeConfigMenu(true); }
      else if (event.key === 'Tab') closeConfigMenu(false);
      else if (event.key === 'Home' && items.length) { event.preventDefault(); items[0].focus(); }
      else if (event.key === 'End' && items.length) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); items[(index + 1 + items.length) % items.length].focus(); }
      else if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
    });
    document.querySelectorAll('#debug-toolbar [data-debug-command]').forEach(function(button) {
      button.addEventListener('click', function() { execute(button.getAttribute('data-debug-command')); });
    });
    bindInspectorTabs();
    var addWatch = document.getElementById('debug-add-watch');
    if (addWatch) addWatch.addEventListener('click', beginAddWatch);
    var consoleInput = document.getElementById('debug-console-input');
    if (consoleInput) consoleInput.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') { event.preventDefault(); evaluateConsole(); }
    });
  }

  function bindEditor() {
    if (!S.editor) return;
    S.editor.updateOptions({ glyphMargin: true });
    breakpointDecorations = S.editor.createDecorationsCollection();
    currentLineDecorations = S.editor.createDecorationsCollection();
    disposers.push(S.editor.onDidChangeModel(refreshBreakpointDecorations));
    disposers.push(S.editor.onDidChangeModelContent(function() {
      reconcileTrackedBreakpointLines();
      if (!isActive() || !activeDecorationRelative) return;
      staleSources.add(activeDecorationRelative);
      var items = S.dap.breakpoints.get(activeDecorationRelative) || [];
      items.forEach(function(item) {
        item.verified = false;
        item.stale = true;
        item.message = tr('Source changed; restart debugging to apply updated breakpoints.');
      });
      saveBreakpoints();
      refreshBreakpointDecorations();
      renderBreakpoints();
      if (!staleSourceNotified.has(activeDecorationRelative)) {
        staleSourceNotified.add(activeDecorationRelative);
        appendConsole(tr('Source changed; restart debugging to apply updated breakpoints.'), 'important');
      }
    }));
    disposers.push(S.editor.onMouseDown(function(event) {
      var type = event.target && event.target.type;
      if (type !== monacoRef.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.target.position) return;
      var model = S.editor.getModel();
      if (!model || !model.uri) return;
      var relative = relativeWorkspacePath(model.uri.fsPath);
      if (!relative) return;
      var mouse = event.event || {};
      var browserEvent = mouse.browserEvent || {};
      var rightButton = mouse.rightButton === true || browserEvent.button === 2;
      if (rightButton) {
        if (typeof mouse.preventDefault === 'function') mouse.preventDefault();
        if (typeof mouse.stopPropagation === 'function') mouse.stopPropagation();
        openBreakpointContextMenu(relative, event.target.position.lineNumber, event.target.position.column || 1, {
          x: Number(mouse.posx) || Number(browserEvent.clientX) || 8,
          y: Number(mouse.posy) || Number(browserEvent.clientY) || 8
        });
        return;
      }
      if (mouse.leftButton === false || browserEvent.button > 0) return;
      toggleBreakpoint(model.uri.fsPath, event.target.position.lineNumber);
    }));
  }

  function bindKeyboard() {
    global.addEventListener('keydown', function(event) {
      if (event.key === 'F5' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (isPaused()) execute('continue');
        else if (!isActive()) start();
      } else if (event.key === 'F5' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopImmediatePropagation(); stop('keyboard');
      } else if (event.key === 'F5' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); event.stopImmediatePropagation(); execute('restart');
      } else if (event.key === 'F6' && isActive()) {
        event.preventDefault(); event.stopImmediatePropagation(); execute('pause');
      } else if (event.key === 'F9' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        var model = activeModel();
        var position = S.editor && S.editor.getPosition ? S.editor.getPosition() : null;
        if (model && model.uri && position) {
          event.preventDefault(); event.stopImmediatePropagation();
          toggleBreakpoint(model.uri.fsPath, position.lineNumber);
        }
      } else if (event.key === 'F10' && isPaused()) {
        event.preventDefault(); event.stopImmediatePropagation(); execute('next');
      } else if (event.key === 'F11' && isPaused()) {
        event.preventDefault(); event.stopImmediatePropagation(); execute(event.shiftKey ? 'stepOut' : 'stepIn');
      }
    }, true);
  }

  function init(monaco) {
    if (initialized) return;
    initialized = true;
    monacoRef = monaco;
    bindDom();
    bindEditor();
    bindKeyboard();
    disposers.push(global.api.onDapMessage(handleDapMessage));
    disposers.push(global.api.onDapStatus(handleDapStatus));
    var onWorkspace = function() { workspaceChanged(); };
    global.addEventListener('bobo:workspace-changed', onWorkspace);
    disposers.push(function() { global.removeEventListener('bobo:workspace-changed', onWorkspace); });
    var onServerCapabilities = function() {
      invalidateCatalogCache();
      adapterCapabilityProfiles = new Map();
      exceptionBreakpointSelectionKey = '';
      renderBreakpoints();
      updateStartButton();
      if (!dapFeatureDecision().available && (isActive() || S.dap.clientSessionId)) abort('capability-disabled');
      refreshConfigurations().catch(function() {});
    };
    global.addEventListener('bobo:server-capabilities-changed', onServerCapabilities);
    disposers.push(function() { global.removeEventListener('bobo:server-capabilities-changed', onServerCapabilities); });
    disposers.push(global.api.onFileEvent(function(event) {
      var filePath = String(event && event.path || '').replace(/\\/g, '/').toLowerCase();
      if (filePath.endsWith('/.vscode/launch.json') || filePath.endsWith('/.bobocloud/launch.json')) refreshConfigurations().catch(reportError);
    }));
    var authTimer = setInterval(function() {
      if (isActive() && S.auth && S.auth.expiresAt && S.auth.expiresAt <= Date.now()) abort('auth-expired');
    }, 5000);
    disposers.push(function() { clearInterval(authTimer); });
    loadWorkspaceState();
    refreshConfigurations().catch(function() {});
    setPhase('idle');
  }

  BOBO.dap = Object.freeze({
    init: init,
    start: start,
    stop: stop,
    abort: abort,
    execute: execute,
    isActive: isActive,
    isPaused: isPaused,
    refreshConfigurations: refreshConfigurations,
    getConfigurations: function() { return S.dap.configurations.map(function(item) { return Object.assign({}, item); }); },
    getState: function() { return { phase: S.dap.phase, configurationId: S.dap.configurationId, adapter: S.dap.adapter }; },
    toggleBreakpoint: toggleBreakpoint,
    getBreakpoints: function() {
      var result = [];
      S.dap.breakpoints.forEach(function(items, path) { result.push({ path: path, breakpoints: items.map(function(item) { return Object.assign({}, item); }) }); });
      return result;
    },
    getExceptionBreakpoints: function() {
      var capabilities = currentBreakpointCapabilities();
      ensureExceptionBreakpointSelections(capabilities);
      return capabilities.exceptionBreakpointFilters.map(function(filter) {
        return Object.assign({}, filter, exceptionBreakpointSelections.get(filter.filter) || { enabled: false, condition: '', verified: null, message: '' });
      });
    },
    getBreakpointCapabilities: function() { return Object.assign({}, currentBreakpointCapabilities()); },
    beforeWorkspaceLeave: beforeWorkspaceLeave,
    workspaceChanged: workspaceChanged,
    renameBreakpoints: renameBreakpoints,
    removeBreakpoints: removeBreakpoints,
    clearConsole: clearConsole,
    getConsoleStats: function() {
      var output = document.getElementById('debug-console-output');
      return { queued: consoleQueue.length, renderPasses: consoleRenderPasses, lines: output ? output.childNodes.length : 0 };
    },
    dispose: function() {
      abort('dispose');
      closeBreakpointPopup();
      disposers.splice(0).forEach(function(dispose) { try { if (typeof dispose === 'function') dispose(); else if (dispose && dispose.dispose) dispose.dispose(); } catch (_) {} });
      initialized = false;
    }
  });
})(window);
