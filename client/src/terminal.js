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
  var sessionGeneration = 0;
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

  function writeLocal(message, tone) {
    if (!terminal) return;
    var color = tone === 'error' ? '31' : tone === 'warning' ? '33' : '90';
    terminal.write('\r\n\x1b[' + color + 'm' + String(message || '') + '\x1b[0m\r\n');
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
    startPromise = null;
    startPromiseKey = '';
    clearQueuedInput();
    if (reason) setAnnouncement(reason);
  }

  async function closeTerminal(reason) {
    var closingSession = sessionId;
    var wasReady = sessionPhase === 'ready';
    var wasStarting = !!startPromise;
    sessionGeneration += 1;
    if (closingSession && wasReady && terminal) writeLocal(t('Cloud terminal session closed.'), 'warning');
    resetSessionState('');
    if ((!closingSession && !wasStarting) || !global.api || typeof global.api.terminalStop !== 'function') return true;
    try {
      await global.api.terminalStop(String(reason || 'close'));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function prepareSnapshot() {
    if (!BOBO.workspace || typeof BOBO.workspace.saveAllTabs !== 'function') return false;
    if (!(await BOBO.workspace.saveAllTabs())) return false;
    if (!BOBO.runner || typeof BOBO.runner.syncWithServer !== 'function') return false;
    return (await BOBO.runner.syncWithServer()) === true;
  }

  function showUnavailable(message) {
    setAnnouncement(message);
    writeLocal(message, 'warning');
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

      sessionPhase = 'connecting';
      setAnnouncement(t('Connecting cloud terminal...'));
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
        if (terminal) writeLocal(t('Terminal input failed: {message}', {
          message: error && error.message ? error.message : t('Unknown error')
        }), 'error');
        return false;
      });
    });
  }

  function sendInput(data) {
    var text = String(data == null ? '' : data);
    if (!text) return;
    var byteLength = utf8ByteLength(text);
    if (byteLength > MAX_PENDING_TERMINAL_INPUT_BYTES ||
        queuedInputBytes + byteLength > MAX_PENDING_TERMINAL_INPUT_BYTES) {
      if (terminal) writeLocal(t('Terminal input is too large.'), 'error');
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
      setAnnouncement(t('Cloud terminal error: {message}', { message: status.message || t('Unknown error') }));
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
      setAnnouncement(t('Cloud terminal connected.'));
      deferFit();
      flushQueuedInput();
      return;
    }
    if (state === 'error') {
      sessionPhase = 'error';
      clearQueuedInput();
      var errorMessage = t('Cloud terminal error: {message}', { message: status.message || t('Unknown error') });
      setAnnouncement(errorMessage);
      writeLocal(errorMessage, 'error');
      return;
    }
    if (state === 'closed' || state === 'idle') {
      var exitedSession = sessionId;
      sessionId = '';
      sessionKey = '';
      sessionPhase = 'idle';
      sessionCapabilities = null;
      clearQueuedInput();
      setAnnouncement(t('Cloud terminal session closed.'));
      if (exitedSession) {
        earlyOutputs.delete(exitedSession);
        earlyStatuses.delete(exitedSession);
      }
    }
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
        eventDispose = function() {
          if (typeof disposeOutput === 'function') disposeOutput();
          if (typeof disposeStatus === 'function') disposeStatus();
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
        generation: sessionGeneration,
        connected: isSessionReady()
      };
    }
  };
})(window);
