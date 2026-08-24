// src/terminal.js - Interactive cloud terminal presentation.
// Network ownership stays in the main process. The renderer receives only a
// sender-bound IPC bridge and renders raw terminal bytes with xterm.js.
// xterm itself stays in a lazy bundle so it never delays ordinary editor boot.
import {
  isMultilineTerminalPaste,
  MAX_PENDING_TERMINAL_INPUT_BYTES,
  terminalPasteText,
  utf8ByteLength
} from '../renderer/terminal-input-policy.js';

(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  var terminal = null;
  var fitAddon = null;
  var resizeObserver = null;
  var windowResizeBound = false;
  var eventDispose = null;
  var sessionId = '';
  var sessionKey = '';
  var sessionPhase = 'idle';
  var sessionCapabilities = null;
  var sessionEnvironment = null;
  var sessionGeneration = 0;
  var lastDependencyRefreshSession = '';
  var startPromise = null;
  var startPromiseKey = '';
  var earlyOutputs = new Map();
  var earlyStatuses = new Map();
  var queuedInput = [];
  var queuedInputBytes = 0;
  var inputDispatch = Promise.resolve();
  var pasteConfirmationOpen = false;
  var initialized = false;
  var presentationPromise = null;
  var presentationGeneration = 0;
  var terminalUiLoadPromise = null;
  var capabilitySubscription = null;
  var packageIntentInFlight = null;
  var managedRestartCancellationEpoch = 0;

  function t(key, params) {
    return BOBO.i18n && typeof BOBO.i18n.t === 'function' ? BOBO.i18n.t(key, params) : key;
  }

  function terminalHost() {
    return document.getElementById('terminal-host');
  }

  function terminalAnnouncement() {
    return document.getElementById('terminal-announcements');
  }

  function getTerminalUi() {
    var ui = BOBO.terminalUi;
    return ui && typeof ui.Terminal === 'function' && typeof ui.FitAddon === 'function' ? ui : null;
  }

  function ensureTerminalUi() {
    var available = getTerminalUi();
    if (available) return Promise.resolve(available);
    if (terminalUiLoadPromise) return terminalUiLoadPromise;

    var attempt = new Promise(function(resolve, reject) {
      var stylesheet = document.querySelector('link[data-bobo-terminal-ui]');
      if (!stylesheet) {
        stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = './renderer-dist/bobo-terminal-ui.css';
        stylesheet.dataset.boboTerminalUi = 'true';
        document.head.appendChild(stylesheet);
      }

      var script = document.createElement('script');
      script.src = './renderer-dist/bobo-terminal-ui.js';
      script.async = true;
      script.dataset.boboTerminalUi = 'true';
      script.onload = function() {
        var loaded = getTerminalUi();
        if (loaded) resolve(loaded);
        else {
          script.remove();
          reject(new Error('Terminal UI bundle did not register its public modules.'));
        }
      };
      script.onerror = function() {
        script.remove();
        reject(new Error('Terminal UI bundle could not be loaded.'));
      };
      document.head.appendChild(script);
    });
    terminalUiLoadPromise = attempt.catch(function(error) {
      terminalUiLoadPromise = null;
      console.error('Terminal UI bundle:', error);
      throw error;
    });
    return terminalUiLoadPromise;
  }

  function setAnnouncement(message) {
    var announcement = terminalAnnouncement();
    if (announcement) announcement.textContent = String(message || '');
  }

  function bindContextText(element, key, params) {
    if (!element) return;
    if (BOBO.i18n && typeof BOBO.i18n.bindText === 'function') {
      BOBO.i18n.bindText(element, key, params || null);
      return;
    }
    element.textContent = t(key, params);
  }

  function setContextDetail(key, params, rawText) {
    var detail = document.getElementById('terminal-context-details');
    if (!detail) return;
    if (rawText) {
      if (BOBO.i18n && typeof BOBO.i18n.unbind === 'function') BOBO.i18n.unbind(detail);
      detail.textContent = String(rawText);
      return;
    }
    bindContextText(detail, key, params);
  }

  function runtimeLabel(environment) {
    var value = environment && (environment.displayName || environment.runtimeId);
    return String(value || currentRuntime() || t('No runtime selected'));
  }

  function renderTerminalContext(phase, options) {
    var context = document.getElementById('terminal-context');
    var label = document.getElementById('terminal-context-state');
    if (!context || !label) return;
    var environment = options && options.environment || sessionEnvironment;
    var runtime = runtimeLabel(environment);
    var image = String(environment && environment.dockerImage || '');
    var message = options && options.message ? String(options.message) : '';
    var state = String(phase || 'idle');

    if (state === 'ready') {
      context.dataset.state = 'ready';
      bindContextText(label, 'Cloud terminal connected');
      if (image) setContextDetail('{runtime} · Docker image {image} · Isolated workspace', { runtime: runtime, image: image });
      else setContextDetail('{runtime} · Isolated workspace', { runtime: runtime });
      return;
    }
    if (state === 'preparing') {
      context.dataset.state = 'loading';
      bindContextText(label, 'Synchronizing terminal workspace');
      setContextDetail('Runtime: {runtime}', { runtime: runtime });
      return;
    }
    if (state === 'connecting') {
      context.dataset.state = 'loading';
      bindContextText(label, 'Starting Docker terminal');
      setContextDetail('Runtime: {runtime}', { runtime: runtime });
      return;
    }
    if (state === 'closing') {
      context.dataset.state = 'loading';
      bindContextText(label, 'Closing cloud terminal');
      setContextDetail('Runtime: {runtime}', { runtime: runtime });
      return;
    }
    if (state === 'packages') {
      context.dataset.state = 'loading';
      bindContextText(label, 'Updating project libraries');
      setContextDetail('The terminal will resume automatically after the managed environment is ready.');
      return;
    }
    if (state === 'error') {
      context.dataset.state = 'error';
      bindContextText(label, 'Cloud terminal error');
      setContextDetail('', null, message || t('Unknown error'));
      return;
    }
    context.dataset.state = 'idle';
    bindContextText(label, 'Cloud terminal idle');
    setContextDetail('Runtime: {runtime}', { runtime: runtime });
  }

  function cssVariable(name, fallback) {
    if (!global.getComputedStyle || !document.documentElement) return fallback;
    var value = global.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function terminalTheme() {
    return {
      background: cssVariable('--bg-deep', '#101411'),
      foreground: cssVariable('--text-primary', '#d8ded8'),
      cursor: cssVariable('--text-primary', '#d8ded8'),
      cursorAccent: cssVariable('--bg-deep', '#101411'),
      selectionBackground: cssVariable('--selection-bg', '#364638'),
      black: cssVariable('--bg-deep', '#101411'),
      red: cssVariable('--red', '#e56b6f'),
      green: cssVariable('--green', '#55b583'),
      yellow: cssVariable('--yellow', '#d9ac4a'),
      blue: cssVariable('--blue', '#6fa7e5'),
      magenta: cssVariable('--purple', '#b696d6'),
      cyan: cssVariable('--teal', '#59b7b1'),
      white: cssVariable('--text-primary', '#d8ded8'),
      brightBlack: cssVariable('--text-tertiary', '#849087'),
      brightRed: cssVariable('--red', '#e56b6f'),
      brightGreen: cssVariable('--green', '#55b583'),
      brightYellow: cssVariable('--yellow', '#d9ac4a'),
      brightBlue: cssVariable('--blue', '#6fa7e5'),
      brightMagenta: cssVariable('--purple', '#b696d6'),
      brightCyan: cssVariable('--teal', '#59b7b1'),
      brightWhite: cssVariable('--text-primary', '#d8ded8')
    };
  }

  function fitTerminal() {
    if (!terminal || !fitAddon) return;
    var host = terminalHost();
    if (!host || host.clientWidth < 4 || host.clientHeight < 4) return;
    try {
      fitAddon.fit();
      sendResize();
    } catch (_) {}
  }

  function deferFit() {
    var schedule = global.requestAnimationFrame || function(callback) { return setTimeout(callback, 0); };
    schedule(function() {
      fitTerminal();
      setTimeout(fitTerminal, 80);
    });
  }

  function hasTerminalBridge() {
    return !!(global.api && typeof global.api.terminalStart === 'function' &&
      typeof global.api.terminalWrite === 'function' &&
      typeof global.api.terminalResize === 'function' &&
      typeof global.api.terminalStop === 'function' &&
      typeof global.api.onTerminalOutput === 'function' &&
      typeof global.api.onTerminalStatus === 'function');
  }

  function terminalAvailability() {
    if (BOBO.cloudFeaturePolicy && typeof BOBO.cloudFeaturePolicy.evaluate === 'function') {
      return BOBO.cloudFeaturePolicy.evaluate('terminal');
    }
    return { feature: 'terminal', available: false, state: 'unknown', reason: 'policy_unavailable' };
  }

  function terminalUnavailableText() {
    return t('Cloud terminal is unavailable on this server.');
  }

  function renderCapabilityState() {
    var availability = terminalAvailability();
    var tab = document.querySelector('#panel-tabs .panel-tab[data-panel="terminal"]');
    if (tab) {
      tab.disabled = !availability.available;
      tab.setAttribute('aria-disabled', availability.available ? 'false' : 'true');
      if (availability.available) {
        if (tab.dataset.boboCapabilityTitle === 'true') tab.removeAttribute('title');
        delete tab.dataset.boboCapabilityTitle;
      } else {
        tab.title = terminalUnavailableText();
        tab.dataset.boboCapabilityTitle = 'true';
      }
    }
    return availability;
  }

  function capabilitiesChanged() {
    var availability = renderCapabilityState();
    if (availability.available) return;
    if (sessionId || startPromise) closeTerminal('capability-disabled');
    showUnavailable(terminalUnavailableText());
    if (S.activePanel === 'terminal' && typeof BOBO.switchToPanel === 'function') BOBO.switchToPanel('output');
  }

  function currentRuntime() {
    return String(S.selectedRuntime || '');
  }

  function hasDockerRuntime() {
    var runtime = currentRuntime();
    return !!runtime && runtime.toLowerCase() !== 'local';
  }

  function currentRequest() {
    var rootPath = String(S.workspaceRoot || '');
    var teamProject = S.collaboration && S.collaboration.current;
    var workspace = teamProject ? {
      kind: 'team',
      teamId: String(teamProject.teamId || ''),
      projectId: String(teamProject.projectId || ''),
      branch: String(teamProject.branch || '')
    } : {
      kind: 'personal',
      folderName: rootPath.split(/[/\\]/).pop() || '',
      folderKey: BOBO.projectKey && rootPath ? String(BOBO.projectKey(rootPath) || '') : ''
    };
    return {
      runtimeId: currentRuntime(),
      workspace: workspace,
      setupCommands: Array.isArray(S.setupCommands) ? S.setupCommands.slice() : [],
      packageIntents: true,
      context: {
        workspaceRoot: rootPath,
        workspaceIdentity: S.workspaceIdentity == null ? null : S.workspaceIdentity,
        workspaceGeneration: Number(S.workspaceGeneration || 0),
        authEpoch: Number(S.runIdentityEpoch || 0)
      },
      cols: terminal ? Number(terminal.cols || 120) : 120,
      rows: terminal ? Number(terminal.rows || 32) : 32
    };
  }

  function requestKey(request) {
    var context = request.context || {};
    return String(request.runtimeId || '') + ':' + JSON.stringify(request.workspace || {}) + ':' +
      JSON.stringify(request.setupCommands || []) + ':' +
      String(context.workspaceIdentity == null ? '' : context.workspaceIdentity) + ':' +
      String(context.workspaceGeneration || 0) + ':' + String(context.authEpoch || 0);
  }

  function sessionIdentifier(result) {
    if (!result || typeof result !== 'object') return '';
    return String(result.sessionId || result.id || '');
  }

  function eventSessionIdentifier(event) {
    if (!event || typeof event !== 'object') return '';
    return String(event.sessionId || event.id || '');
  }

  function isSessionReady() {
    return !!sessionId && sessionPhase === 'ready';
  }

  function clearQueuedInput() {
    queuedInput = [];
    queuedInputBytes = 0;
  }

  function resetSessionState(reason) {
    sessionId = '';
    sessionKey = '';
    sessionPhase = 'idle';
    sessionCapabilities = null;
    sessionEnvironment = null;
    startPromise = null;
    startPromiseKey = '';
    clearQueuedInput();
    if (reason) setAnnouncement(reason);
    renderTerminalContext('idle');
  }

  function refreshDependenciesAfterConfirmedClose(closedSessionId, mutation) {
    mutation = mutation || {};
    var dependenciesChanged = mutation.dependenciesChanged === true;
    var environmentChanged = mutation.environmentChanged === true;
    if (!dependenciesChanged && !environmentChanged) return;
    var refreshSession = String(closedSessionId || '');
    if (refreshSession && refreshSession === lastDependencyRefreshSession) return;
    if (refreshSession) lastDependencyRefreshSession = refreshSession;
    var detail = {
      source: 'terminal',
      reason: 'terminal-publish',
      sessionId: refreshSession,
      dependenciesChanged: dependenciesChanged,
      environmentChanged: environmentChanged,
      cacheRevision: String(mutation.cacheRevision || ''),
      generation: String(mutation.generation || ''),
      dependencyDigest: String(mutation.dependencyDigest || ''),
      cacheEntryId: String(mutation.cacheEntryId || '')
    };
    if (BOBO.cacheStore && typeof BOBO.cacheStore.invalidate === 'function') {
      BOBO.cacheStore.invalidate(detail);
    } else if (typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new global.CustomEvent('bobo:cache-changed', { detail: detail }));
    }
    if (typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new global.CustomEvent('bobo:environment-changed', { detail: detail }));
    }
    if (dependenciesChanged && BOBO.lsp && typeof BOBO.lsp.dependenciesChanged === 'function') {
      try { Promise.resolve(BOBO.lsp.dependenciesChanged(detail)).catch(function() {}); } catch (_) {}
    }
  }

  async function stopTerminal(reason) {
    reason = String(reason || 'close');
    if (reason !== 'package-intent' && reason !== 'replace') managedRestartCancellationEpoch += 1;
    var closingSession = sessionId;
    var wasStarting = !!startPromise;
    sessionGeneration += 1;
    if ((!closingSession && !wasStarting) || !global.api || typeof global.api.terminalStop !== 'function') {
      resetSessionState('');
      return { state: 'idle', confirmed: true };
    }
    sessionPhase = 'closing';
    sessionCapabilities = null;
    renderTerminalContext('closing');
    clearQueuedInput();
    try {
      var result = await global.api.terminalStop(reason);
      var confirmed = !result || result.confirmed !== false;
      var closedMessage = confirmed
        ? t('Cloud terminal session closed.')
        : t('Cloud terminal closed locally, but server cleanup was not confirmed.');
      resetSessionState(closedMessage);
      if (confirmed) refreshDependenciesAfterConfirmedClose(closingSession, result);
      else {
        renderTerminalContext('error', { message: closedMessage });
        if (BOBO.toast && typeof BOBO.toast.error === 'function') BOBO.toast.error(closedMessage);
      }
      return Object.assign({ state: 'closed', confirmed: confirmed }, result || {});
    } catch (error) {
      resetSessionState('');
      renderTerminalContext('error', { message: error && error.message ? error.message : t('Unknown error') });
      return { state: 'closed', confirmed: false, reason: 'stop_failed', error: error };
    }
  }

  async function closeTerminal(reason) {
    var result = await stopTerminal(reason);
    return result.confirmed !== false;
  }

  async function prepareSnapshot() {
    if (!BOBO.workspace || typeof BOBO.workspace.saveAllTabs !== 'function') return false;
    if (!(await BOBO.workspace.saveAllTabs())) return false;
    if (!BOBO.runner || typeof BOBO.runner.syncWithServer !== 'function') return false;
    return (await BOBO.runner.syncWithServer()) === true;
  }

  function showUnavailable(message) {
    setAnnouncement(message);
    renderTerminalContext('error', { message: message });
  }

  function terminalStartErrorText(error) {
    var code = String(error && error.code || '');
    var message = String(error && error.message || '');
    // Electron serializes invoke() errors differently between releases; use
    // the stable local main-process wording as a fallback when `code` is not
    // preserved across IPC.
    if (code === 'certificate_mismatch' || message === 'The cloud terminal certificate does not match the configured fingerprint') {
      return t('The cloud terminal certificate does not match the configured fingerprint.');
    }
    if (code === 'certificate_unavailable' || message === 'A certificate fingerprint requires secure terminal transport') {
      return t('A cloud terminal certificate fingerprint requires secure transport.');
    }
    return message || t('Unknown error');
  }

  async function startTerminal() {
    if (!terminal) return false;
    if (packageIntentInFlight) {
      setAnnouncement(t('Wait for the project library update to finish.'));
      renderTerminalContext('packages');
      return false;
    }
    if (!terminalAvailability().available) {
      showUnavailable(terminalUnavailableText());
      return false;
    }
    if (!S.workspaceRoot) {
      showUnavailable(t('Open a workspace before starting a cloud terminal.'));
      return false;
    }
    if (!S.serverSettings || !S.serverSettings.ip) {
      showUnavailable(t('No cloud server is configured. Configure a server before opening the terminal.'));
      return false;
    }
    if (!hasDockerRuntime()) {
      showUnavailable(t('Cloud Terminal requires a Docker runtime. Select a Docker runtime before opening the terminal.'));
      return false;
    }
    if (!hasTerminalBridge()) {
      showUnavailable(t('Streaming terminal support is unavailable in this client build.'));
      return false;
    }

    // Fit synchronously before the handshake so a non-resizable server PTY is
    // created with the same initial width as xterm. Carriage-return progress
    // updates otherwise wrap at the PTY's default width and look like new rows.
    fitTerminal();
    var request = currentRequest();
    var key = requestKey(request);
    if (sessionId && sessionKey === key && (sessionPhase === 'connecting' || sessionPhase === 'ready')) {
      return startPromise || true;
    }
    if (startPromise && startPromiseKey === key) return startPromise;

    await closeTerminal('replace');
    var generation = ++sessionGeneration;
    sessionKey = key;
    sessionPhase = 'preparing';
    setAnnouncement(t('Preparing cloud terminal...'));
    renderTerminalContext('preparing');

    var pending = (async function() {
      var synced;
      try {
        synced = await prepareSnapshot();
      } catch (_) {
        synced = false;
      }
      if (generation !== sessionGeneration) return false;
      if (!synced) {
        sessionPhase = 'error';
        clearQueuedInput();
        showUnavailable(t('Could not synchronize the workspace for the cloud terminal.'));
        return false;
      }

      if (!terminalAvailability().available) {
        sessionPhase = 'idle';
        clearQueuedInput();
        showUnavailable(terminalUnavailableText());
        return false;
      }

      sessionPhase = 'connecting';
      setAnnouncement(t('Connecting cloud terminal...'));
      renderTerminalContext('connecting');
      var result;
      try {
        result = await global.api.terminalStart(request);
      } catch (error) {
        if (generation !== sessionGeneration) return false;
        sessionPhase = 'error';
        clearQueuedInput();
        showUnavailable(t('Could not start cloud terminal: {message}', { message: terminalStartErrorText(error) }));
        return false;
      }

      var startedSession = sessionIdentifier(result);
      if (generation !== sessionGeneration) {
        if (startedSession && global.api && typeof global.api.terminalStop === 'function') {
          try { await global.api.terminalStop('stale-start'); } catch (_) {}
        }
        return false;
      }
      if (!result || result.success === false || !startedSession) {
        sessionPhase = 'error';
        clearQueuedInput();
        showUnavailable(t('Could not start cloud terminal: {message}', {
          message: result && result.error ? result.error : t('Unknown error')
        }));
        return false;
      }

      sessionId = startedSession;
      sessionPhase = 'ready';
      sessionCapabilities = result.capabilities && typeof result.capabilities === 'object'
        ? Object.assign({}, result.capabilities)
        : {};
      sessionEnvironment = result.environment && typeof result.environment === 'object'
        ? Object.assign({}, result.environment)
        : { runtimeId: String(result.runtimeId || request.runtimeId || '') };
      renderTerminalContext('ready', { environment: sessionEnvironment });
      replayEarlyOutput(startedSession);
      replayEarlyStatus(startedSession);
      flushQueuedInput();
      return true;
    })();

    startPromise = pending;
    startPromiseKey = key;
    try {
      return await pending;
    } finally {
      if (startPromise === pending) {
        startPromise = null;
        startPromiseKey = '';
      }
    }
  }

  function contextMatches(event) {
    if (!event || !event.context || typeof event.context !== 'object') return true;
    var context = event.context;
    return context.workspaceIdentity === S.workspaceIdentity &&
      Number(context.workspaceGeneration || 0) === Number(S.workspaceGeneration || 0) &&
      Number(context.authEpoch || 0) === Number(S.runIdentityEpoch || 0);
  }

  function rememberEarlyOutput(event) {
    var id = eventSessionIdentifier(event);
    if (!id) return;
    var events = earlyOutputs.get(id) || [];
    if (events.length < 64) events.push(event);
    earlyOutputs.set(id, events);
    if (earlyOutputs.size > 8) earlyOutputs.delete(earlyOutputs.keys().next().value);
  }

  function replayEarlyOutput(id) {
    var events = earlyOutputs.get(id);
    earlyOutputs.delete(id);
    if (!events) return;
    events.forEach(handleTerminalOutput);
  }

  function rememberEarlyStatus(event) {
    var status = event && event.status;
    var id = eventSessionIdentifier(status);
    if (!id) return;
    var events = earlyStatuses.get(id) || [];
    if (events.length < 16) events.push(event);
    earlyStatuses.set(id, events);
    if (earlyStatuses.size > 8) earlyStatuses.delete(earlyStatuses.keys().next().value);
  }

  function replayEarlyStatus(id) {
    var events = earlyStatuses.get(id);
    earlyStatuses.delete(id);
    if (!events) return;
    events.forEach(handleTerminalStatus);
  }

  function sendResize() {
    // Fitting remains useful locally, but the server only receives a resize
    // when the ready handshake explicitly declares PTY resize support.
    if (!isSessionReady() || !sessionCapabilities || sessionCapabilities.resize !== true ||
        !terminal || !global.api || typeof global.api.terminalResize !== 'function') return;
    var cols = Number(terminal.cols || 0);
    var rows = Number(terminal.rows || 0);
    if (cols < 1 || rows < 1) return;
    global.api.terminalResize({ cols: cols, rows: rows }).catch(function() {});
  }

  function flushQueuedInput() {
    if (!isSessionReady() || queuedInput.length === 0) return;
    var activeKey = sessionKey;
    var next = queuedInput.filter(function(entry) { return entry.key === activeKey; });
    clearQueuedInput();
    next.forEach(function(entry) {
      inputDispatch = inputDispatch.then(function() {
        if (!isSessionReady() || entry.key !== sessionKey) return false;
        return global.api.terminalWrite(entry.data);
      }).catch(function(error) {
        var message = t('Terminal input failed: {message}', {
          message: error && error.message ? error.message : t('Unknown error')
        });
        setAnnouncement(message);
        renderTerminalContext('error', { message: message });
        return false;
      });
    });
  }

  function sendInput(data) {
    var text = String(data == null ? '' : data);
    if (!text) return;
    if (packageIntentInFlight) {
      setAnnouncement(t('Wait for the project library update to finish.'));
      return;
    }
    var byteLength = utf8ByteLength(text);
    if (byteLength > MAX_PENDING_TERMINAL_INPUT_BYTES ||
        queuedInputBytes + byteLength > MAX_PENDING_TERMINAL_INPUT_BYTES) {
      var message = t('Terminal input is too large.');
      setAnnouncement(message);
      renderTerminalContext('error', { message: message });
      return;
    }
    var key = requestKey(currentRequest());
    queuedInput.push({ key: key, data: text, byteLength: byteLength });
    queuedInputBytes += byteLength;
    startTerminal().then(flushQueuedInput);
  }

  function handleTerminalOutput(event) {
    if (!event || typeof event !== 'object') return;
    if (!contextMatches(event)) return;
    var eventSession = eventSessionIdentifier(event);
    if (!eventSession) return;
    if (!sessionId) {
      rememberEarlyOutput(event);
      return;
    }
    if (eventSession !== sessionId) return;
    var data = event.data == null ? '' : String(event.data);
    if (terminal && data) terminal.write(data);
  }

  function handleTerminalStatus(event) {
    if (!event || typeof event !== 'object' || !contextMatches(event)) return;
    var status = event.status && typeof event.status === 'object' ? event.status : {};
    var eventSession = eventSessionIdentifier(status);
    if (!eventSession && status.state === 'error' && startPromise) {
      var startError = t('Cloud terminal error: {message}', { message: status.message || t('Unknown error') });
      setAnnouncement(startError);
      renderTerminalContext('error', { message: startError });
      return;
    }
    if (!eventSession) return;
    if (!sessionId) {
      rememberEarlyStatus(event);
      return;
    }
    if (eventSession !== sessionId) return;

    var state = String(status.state || '');
    if (state === 'ready') {
      sessionPhase = 'ready';
      sessionCapabilities = status.capabilities && typeof status.capabilities === 'object'
        ? Object.assign({}, status.capabilities)
        : (sessionCapabilities || {});
      sessionEnvironment = status.environment && typeof status.environment === 'object'
        ? Object.assign({}, status.environment)
        : (sessionEnvironment || { runtimeId: String(status.runtimeId || currentRuntime()) });
      setAnnouncement(t('Cloud terminal connected.'));
      renderTerminalContext('ready', { environment: sessionEnvironment });
      deferFit();
      flushQueuedInput();
      return;
    }
    if (state === 'error') {
      sessionPhase = 'error';
      clearQueuedInput();
      var errorMessage = t('Cloud terminal error: {message}', { message: status.message || t('Unknown error') });
      setAnnouncement(errorMessage);
      renderTerminalContext('error', { message: errorMessage });
      return;
    }
    if (state === 'closed' || state === 'idle') {
      var exitedSession = sessionId;
      var wasClosing = sessionPhase === 'closing';
      var cleanupPending = status.confirmed === false;
      var closeAnnouncement = cleanupPending
        ? t('Cloud terminal closed locally, but server cleanup was not confirmed.')
        : t('Cloud terminal session closed.');
      sessionId = '';
      sessionKey = '';
      sessionPhase = 'idle';
      sessionCapabilities = null;
      sessionEnvironment = null;
      clearQueuedInput();
      setAnnouncement(closeAnnouncement);
      if (cleanupPending) renderTerminalContext('error', { message: closeAnnouncement });
      else renderTerminalContext('idle');
      if (exitedSession) {
        earlyOutputs.delete(exitedSession);
        earlyStatuses.delete(exitedSession);
      }
      if (cleanupPending && !wasClosing) {
        if (BOBO.toast && typeof BOBO.toast.error === 'function') BOBO.toast.error(closeAnnouncement);
      }
      if (exitedSession && status.confirmed === true) refreshDependenciesAfterConfirmedClose(exitedSession, status);
    }
  }

  function terminalIntentChanges(intent) {
    return (Array.isArray(intent && intent.packages) ? intent.packages : []).map(function(item) {
      return {
        operation: intent.operation === 'remove' ? 'remove' : 'install',
        name: String(item && item.name || ''),
        version: String(item && item.version || ''),
        features: Array.isArray(item && item.features) ? item.features.slice() : [],
        scope: 'runtime'
      };
    });
  }

  function intentMatchesRequest(intent, request) {
    if (!intent || !request || String(intent.runtimeId || '') !== String(request.runtimeId || '')) return false;
    var received = intent.workspace && typeof intent.workspace === 'object' ? intent.workspace : {};
    var expected = request.workspace && typeof request.workspace === 'object' ? request.workspace : {};
    if (String(received.kind || '') !== String(expected.kind || '')) return false;
    if (expected.kind === 'team') {
      return String(received.teamId || '') === String(expected.teamId || '') &&
        String(received.projectId || '') === String(expected.projectId || '') &&
        String(received.branch || '') === String(expected.branch || '');
    }
    var receivedKey = String(received.folderKey || '');
    var expectedKey = String(expected.folderKey || '');
    if (receivedKey && expectedKey) return receivedKey === expectedKey;
    return Boolean(received.folderName && expected.folderName) &&
      String(received.folderName) === String(expected.folderName);
  }

  function decideTerminalPackageIntent(event, accepted, code) {
    var intentId = String(event && event.intentId || '');
    var eventSession = eventSessionIdentifier(event);
    if (!intentId || !eventSession || eventSession !== sessionId || !global.api ||
        typeof global.api.terminalPackageIntentDecision !== 'function') return Promise.resolve(false);
    return global.api.terminalPackageIntentDecision({
      intentId: intentId,
      accepted: accepted === true,
      code: String(code || '')
    }).then(function() { return true; }).catch(function() { return false; });
  }

  function terminalPackageIntentRejectionMessage(code) {
    switch (String(code || '')) {
    case 'unsupported_option':
      return t('This pip option cannot be managed safely in the project environment.');
    case 'unsupported_requirement':
      return t('This package requirement cannot be managed safely. Use a package name with an optional exact version.');
    case 'unknown_source':
      return t('This package source is not configured on the server.');
    case 'unsupported_invocation':
    case 'unsupported_command':
      return t('This pip command is not supported by managed project environments.');
    case 'package_intent_timeout':
      return t('The terminal package request expired before it could be accepted. Run the command again.');
    case 'package_intent_stale':
      return t('This terminal package request is no longer active. Run the command again.');
    case 'package_intent_pending':
      return t('Wait for the project library update to finish.');
    default:
      return t('This terminal library command cannot be managed automatically. Use Package Center instead.');
    }
  }

  function showTerminalPackageIntentRejection(code) {
    var message = terminalPackageIntentRejectionMessage(code);
    setAnnouncement(message);
    if (BOBO.toast && typeof BOBO.toast.warning === 'function') BOBO.toast.warning(message);
    else if (BOBO.toast && typeof BOBO.toast.info === 'function') BOBO.toast.info(message);
  }

  async function processTerminalPackageIntent(event) {
    if (!event) return false;
    var intentId = String(event.intentId || '');
    var intentSessionId = eventSessionIdentifier(event);
    if (packageIntentInFlight) {
      if (intentId && packageIntentInFlight.intentId !== intentId) {
        await decideTerminalPackageIntent(event, false, 'client_busy');
      }
      return false;
    }
    var rejectionCode = '';
    if (!contextMatches(event)) rejectionCode = 'client_context_mismatch';
    else if (!intentId || !intentSessionId || intentSessionId !== sessionId) rejectionCode = 'client_session_mismatch';
    else if (event.requiresTerminalClose !== true || !sessionCapabilities || sessionCapabilities.packageIntents !== true) rejectionCode = 'client_capability_mismatch';
    var request = currentRequest();
    if (!rejectionCode && !intentMatchesRequest(event, request)) rejectionCode = 'client_workspace_mismatch';
    if (rejectionCode) {
      await decideTerminalPackageIntent(event, false, rejectionCode);
      showTerminalPackageIntentRejection(rejectionCode);
      return false;
    }

    var operation = {
      intentId: intentId,
      sessionId: intentSessionId,
      requestKey: requestKey(request),
      request: request,
      restartCancellationEpoch: managedRestartCancellationEpoch
    };
    packageIntentInFlight = operation;
    clearQueuedInput();

    var cleanupConfirmed = false;
    var restartAllowed = false;
    var packagesApplied = false;
    var decisionSent = false;
    try {
      decisionSent = await decideTerminalPackageIntent(event, true, 'managed');
      if (!decisionSent) throw new Error(t('The terminal could not confirm cleanup for this library command.'));
      sessionPhase = 'packages';
      setAnnouncement(t('Moving the terminal command into the managed project environment...'));
      renderTerminalContext('packages');
      var closeResult = await stopTerminal('package-intent');
      cleanupConfirmed = closeResult && closeResult.cleanupConfirmed === true &&
        closeResult.packageIntentPending === true && String(closeResult.packageIntentId || '') === intentId;
      if (!cleanupConfirmed) throw new Error(t('The terminal could not confirm cleanup for this library command.'));
      if (requestKey(currentRequest()) !== operation.requestKey) throw new Error(t('The project changed before dependency files were updated.'));
      if (!BOBO.packageCenter || typeof BOBO.packageCenter.applyManagedPackageChanges !== 'function') {
        throw new Error(t('Library management is unavailable in this client build.'));
      }

      restartAllowed = true;
      sessionPhase = 'packages';
      setAnnouncement(t('Updating project libraries...'));
      renderTerminalContext('packages');
      var applied = await BOBO.packageCenter.applyManagedPackageChanges(terminalIntentChanges(event), {
        source: 'terminal',
        sourceId: String(event.sourceId || ''),
        runtimeId: String(event.runtimeId || ''),
        removalConfirmed: true,
        discardOnFailure: true
      });
      var packageState = BOBO.packageCenter.getState ? BOBO.packageCenter.getState() : {};
      if (!applied || packageState.recovery) {
        restartAllowed = !packageState.recovery;
        throw new Error(packageState.recovery
          ? t('Complete dependency file recovery before reopening the terminal.')
          : t('Library update failed.'));
      }
      packagesApplied = true;
      setAnnouncement(t('Project libraries updated. Restarting the terminal...'));
      return true;
    } catch (error) {
      if (!cleanupConfirmed && decisionSent && isSessionReady()) {
        await decideTerminalPackageIntent(event, false, 'client_apply_cancelled');
      }
      var message = error && error.message ? error.message : t('Library update failed.');
      setAnnouncement(message);
      if (BOBO.toast && typeof BOBO.toast.error === 'function') BOBO.toast.error(message);
      if (!cleanupConfirmed) renderTerminalContext('error', { message: message });
      return false;
    } finally {
      if (packageIntentInFlight === operation) packageIntentInFlight = null;
      if (restartAllowed && operation.restartCancellationEpoch === managedRestartCancellationEpoch &&
          requestKey(currentRequest()) === operation.requestKey) {
        await startTerminal();
      } else if (packagesApplied) {
        setAnnouncement(t('Project libraries updated'));
        renderTerminalContext('idle');
      }
    }
  }

  function handleTerminalPackageIntent(event) {
    void processTerminalPackageIntent(event);
  }

  function handleTerminalPackageIntentRejected(event) {
    if (!event || !contextMatches(event)) return;
    var eventSession = eventSessionIdentifier(event);
    if (eventSession && sessionId && eventSession !== sessionId) return;
    var code = String(event.code || '');
    if ((code === 'package_intent_pending' || code === 'invalid_package_intent') &&
        event.intentId && !packageIntentInFlight) {
      void decideTerminalPackageIntent(event, false, code === 'package_intent_pending' ? 'client_recovered_pending' : 'client_invalid_intent');
    }
    showTerminalPackageIntentRejection(code);
  }

  async function confirmMultilinePaste(text) {
    if (pasteConfirmationOpen || !isMultilineTerminalPaste(text)) return false;
    pasteConfirmationOpen = true;
    try {
      var accepted = BOBO.confirm ? await BOBO.confirm({
        title: t('Run pasted commands?'),
        message: t('Multi-line commands will be sent and executed immediately.'),
        confirmLabel: t('Send and run'),
        cancelLabel: t('Cancel')
      }) : false;
      if (accepted) sendInput(terminalPasteText(text));
      return accepted === true;
    } finally {
      pasteConfirmationOpen = false;
      focusTerminal();
    }
  }

  function bindPasteGuard(host) {
    host.addEventListener('paste', function(event) {
      var clipboard = event.clipboardData;
      var text = clipboard && typeof clipboard.getData === 'function' ? clipboard.getData('text/plain') : '';
      if (!isMultilineTerminalPaste(text)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void confirmMultilinePaste(text);
    }, true);
  }

  function focusTerminal() {
    if (!terminal) return;
    try { terminal.focus(); } catch (_) {}
  }

  function clearTerminal() {
    if (terminal) terminal.clear();
    setAnnouncement('');
  }

  function initTerminal() {
    if (initialized) return true;
    initialized = true;
    renderCapabilityState();
    renderTerminalContext(sessionPhase, { environment: sessionEnvironment });
    if (!capabilitySubscription && BOBO.serverCapabilities && typeof BOBO.serverCapabilities.subscribe === 'function') {
      capabilitySubscription = BOBO.serverCapabilities.subscribe(capabilitiesChanged);
    }
    var host = terminalHost();
    if (host && BOBO.i18n && typeof BOBO.i18n.bindAttribute === 'function') {
      BOBO.i18n.bindAttribute(host, 'aria-label', 'Terminal');
    }
    return true;
  }

  function ensureTerminalPresentation() {
    if (terminal) return Promise.resolve(true);
    if (presentationPromise) return presentationPromise;
    initTerminal();
    var host = terminalHost();
    if (!host) return Promise.resolve(false);
    var generation = ++presentationGeneration;
    host.textContent = '';
    host.classList.remove('terminal-load-error');

    var pending = ensureTerminalUi().then(function(ui) {
      if (!initialized || generation !== presentationGeneration) return false;
      terminal = new ui.Terminal({
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: cssVariable('--font-mono', 'ui-monospace, SFMono-Regular, Consolas, monospace'),
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 6000,
        theme: terminalTheme()
      });
      fitAddon = new ui.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(host);
      terminal.onData(sendInput);
      bindPasteGuard(host);

      if (global.ResizeObserver) {
        resizeObserver = new global.ResizeObserver(deferFit);
        resizeObserver.observe(host);
      } else if (!windowResizeBound) {
        windowResizeBound = true;
        global.addEventListener('resize', deferFit);
      }
      if (global.api && typeof global.api.onTerminalOutput === 'function' && typeof global.api.onTerminalStatus === 'function') {
        var disposeOutput = global.api.onTerminalOutput(handleTerminalOutput);
        var disposeStatus = global.api.onTerminalStatus(handleTerminalStatus);
        var disposePackageIntent = typeof global.api.onTerminalPackageIntent === 'function'
          ? global.api.onTerminalPackageIntent(handleTerminalPackageIntent)
          : null;
        var disposePackageIntentRejected = typeof global.api.onTerminalPackageIntentRejected === 'function'
          ? global.api.onTerminalPackageIntentRejected(handleTerminalPackageIntentRejected)
          : null;
        eventDispose = function() {
          if (typeof disposeOutput === 'function') disposeOutput();
          if (typeof disposeStatus === 'function') disposeStatus();
          if (typeof disposePackageIntent === 'function') disposePackageIntent();
          if (typeof disposePackageIntentRejected === 'function') disposePackageIntentRejected();
        };
      }
      deferFit();
      return true;
    }).catch(function() {
      if (initialized && generation === presentationGeneration) {
        var message = t('Terminal interface could not be loaded.');
        setAnnouncement(message);
        host.classList.add('terminal-load-error');
        host.textContent = message;
      }
      return false;
    });
    presentationPromise = pending;
    pending.then(function(ready) {
      if (!ready && presentationPromise === pending) presentationPromise = null;
    });
    return pending;
  }

  function disposeTerminal(reason) {
    if (!initialized) return Promise.resolve(true);
    initialized = false;
    presentationGeneration += 1;
    presentationPromise = null;
    if (capabilitySubscription) {
      try { capabilitySubscription(); } catch (_) {}
      capabilitySubscription = null;
    }
    if (eventDispose) {
      try { eventDispose(); } catch (_) {}
      eventDispose = null;
    }
    if (resizeObserver) {
      try { resizeObserver.disconnect(); } catch (_) {}
      resizeObserver = null;
    }
    if (terminal) {
      try { terminal.dispose(); } catch (_) {}
      terminal = null;
      fitAddon = null;
    }
    return closeTerminal(reason || 'dispose');
  }

  BOBO.terminal = {
    init: initTerminal,
    activate: async function() {
      if (!renderCapabilityState().available) {
        showUnavailable(terminalUnavailableText());
        return false;
      }
      if (!(await ensureTerminalPresentation())) return false;
      focusTerminal();
      deferFit();
      return startTerminal();
    },
    focus: focusTerminal,
    clear: clearTerminal,
    close: closeTerminal,
    beforeWorkspaceLeave: function() {
      return closeTerminal('workspace-leave');
    },
    dispose: disposeTerminal,
    getState: function() {
      return {
        sessionId: sessionId,
        phase: sessionPhase,
        capabilities: sessionCapabilities && Object.assign({}, sessionCapabilities),
        environment: sessionEnvironment && Object.assign({}, sessionEnvironment),
        cols: terminal ? Number(terminal.cols || 0) : 0,
        rows: terminal ? Number(terminal.rows || 0) : 0,
        generation: sessionGeneration,
        packageIntentId: packageIntentInFlight && packageIntentInFlight.intentId || '',
        connected: isSessionReady()
      };
    }
  };
})(window);
