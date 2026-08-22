'use strict';

// This transport deliberately has no DAP/LSP dependency. It owns exactly one
// interactive terminal WebSocket in Electron's main process, where credentials
// remain private from renderer code.

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_PING_INTERVAL_MS = 25000;
const DEFAULT_CLOSE_TIMEOUT_MS = 15000;
const MAX_STDIN_CHARS = 64 * 1024;
const MAX_STDIN_BYTES = 16 * 1024;
const MAX_SETUP_COMMANDS = 64;
const MAX_SETUP_COMMAND_BYTES = 512;

function normalizeTerminalUrl(serverHost) {
  let input = String(serverHost || '').trim();
  if (!input) throw new Error('Server address is not configured');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'http://' + input;
  const parsed = new URL(input);
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  parsed.protocol = secure ? 'wss:' : 'ws:';
  if (!parsed.port) parsed.port = '3101';
  parsed.pathname = '/terminal';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function cleanWorkspace(workspace) {
  const value = workspace && typeof workspace === 'object' ? workspace : {};
  if (value.kind === 'team') {
    const teamId = String(value.teamId || '').trim();
    const projectId = String(value.projectId || '').trim();
    const branch = String(value.branch || '').trim();
    if (!teamId || !projectId || !branch) throw new Error('Incomplete team workspace identity');
    return { kind: 'team', teamId, projectId, branch };
  }
  const folderName = String(value.folderName || '').trim();
  const folderKey = String(value.folderKey || '').trim();
  if ((!folderName && !folderKey) || /[/\\]/.test(folderName) || /[/\\]/.test(folderKey)) {
    throw new Error('Invalid personal workspace identity');
  }
  return { kind: 'personal', folderName, folderKey };
}

function cleanSetupCommands(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_SETUP_COMMANDS) {
    throw new Error('Terminal setup commands are invalid');
  }
  return value.map((command) => {
    if (typeof command !== 'string' || Buffer.byteLength(command, 'utf8') > MAX_SETUP_COMMAND_BYTES || /[\0\r\n]/.test(command)) {
      throw new Error('Terminal setup commands are invalid');
    }
    return command.trim();
  });
}

function boundedDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 500) return fallback;
  return number;
}

function socketText(event) {
  const raw = event && event.data !== undefined ? event.data : event;
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return '';
}

function socketBytes(event) {
  const raw = event && event.data !== undefined ? event.data : event;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return null;
}

function terminalError(code, message) {
  const error = new Error(String(message || 'Cloud terminal error'));
  error.code = String(code || 'terminal_error');
  return error;
}

class TerminalTransport {
  constructor(options = {}) {
    this.webSocketFactory = options.webSocketFactory || ((url) => new WebSocket(url));
    this.getCredential = options.getCredential || (async () => '');
    this.emit = options.emit || (() => {});
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs) ? options.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;
    this.pingIntervalMs = Number.isFinite(options.pingIntervalMs) ? options.pingIntervalMs : DEFAULT_PING_INTERVAL_MS;
    this.closeTimeoutMs = Number.isFinite(options.closeTimeoutMs) ? options.closeTimeoutMs : DEFAULT_CLOSE_TIMEOUT_MS;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.socket = null;
    this.generation = 0;
    this.sessionId = '';
    this.capabilities = null;
    this.state = 'idle';
    this.contextToken = null;
    this.startPromise = null;
    this.startReject = null;
    this.connectTimer = null;
    this.pingTimer = null;
    this.closeTimer = null;
    this.closePromise = null;
    this.closeResolve = null;
    this.closeSilent = false;
    this.decoder = new TextDecoder('utf-8');
    this.streamDecoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };
  }

  snapshot() {
    return {
      state: this.state,
      sessionId: this.sessionId,
      capabilities: this.capabilities && Object.assign({}, this.capabilities),
      contextToken: this.contextToken && Object.assign({}, this.contextToken)
    };
  }

  _emitStatus(status) {
    this.emit('status', Object.assign({
      state: this.state,
      sessionId: this.sessionId,
      contextToken: this.contextToken && Object.assign({}, this.contextToken)
    }, status || {}));
  }

  _emitOutput(data) {
    if (!data) return;
    this.emit('output', {
      sessionId: this.sessionId,
      data: String(data),
      contextToken: this.contextToken && Object.assign({}, this.contextToken)
    });
  }

  _clearTimers() {
    if (this.connectTimer) this.clearTimer(this.connectTimer);
    if (this.pingTimer) this.clearInterval(this.pingTimer);
    if (this.closeTimer) this.clearTimer(this.closeTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    this.closeTimer = null;
  }

  _startPing(generation) {
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = this.setInterval(() => {
      if (generation !== this.generation || this.state !== 'ready') return;
      try { this._sendControl({ type: 'terminal.ping' }); } catch (_) {}
    }, this.pingIntervalMs);
  }

  _rejectStart(error) {
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    if (reject) reject(error);
  }

  _resolveStart(value) {
    const resolve = this.startResolve;
    this.startResolve = null;
    this.startReject = null;
    if (resolve) resolve(value);
  }

  _sendControl(message) {
    if (!this.socket || this.socket.readyState !== 1) throw terminalError('terminal_offline', 'Cloud terminal is offline');
    this.socket.send(JSON.stringify(message));
  }

  async start(config = {}) {
    // Multiple renderer requests can be released by the same close
    // acknowledgement. Re-check after every await so only the last request is
    // allowed to create a socket; otherwise the earlier socket loses its
    // generation owner and can leave a server-side terminal running.
    while (this.state === 'connecting' || this.state === 'ready' || this.state === 'closing') {
      await this.stop('restart', { silent: true });
    }
    const serverHost = String(config.serverHost || '').trim();
    const runtimeId = String(config.runtimeId || '').trim();
    if (!runtimeId || runtimeId.toLowerCase() === 'local') throw terminalError('runtime_required', 'A Docker runtime is required for the cloud terminal');
    const workspace = cleanWorkspace(config.workspace);
    const setupCommands = cleanSetupCommands(config.setupCommands);
    const generation = ++this.generation;
    const contextToken = config.localContext && typeof config.localContext === 'object'
      ? Object.freeze(Object.assign({}, config.localContext))
      : null;
    this.contextToken = contextToken;
    this.state = 'connecting';
    this.sessionId = '';
    this.capabilities = null;
    this.decoder = new TextDecoder('utf-8');
    this.streamDecoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };
    this._emitStatus();

    const url = normalizeTerminalUrl(serverHost);
    const cols = boundedDimension(config.cols, 120);
    const rows = boundedDimension(config.rows, 32);
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      let socket;
      try {
        socket = this.webSocketFactory(url);
      } catch (error) {
        this.state = 'error';
        this._emitStatus({ code: 'connection_error', message: String(error && error.message || error) });
        this._rejectStart(error);
        return;
      }
      this.socket = socket;
      try { socket.binaryType = 'arraybuffer'; } catch (_) {}
      const closeWithError = (error) => {
        if (generation !== this.generation || socket !== this.socket) {
          try { socket.close(); } catch (_) {}
          return;
        }
        this._clearTimers();
        this.socket = null;
        this.sessionId = '';
        this.state = 'error';
        this._emitStatus({ code: error.code || 'connection_error', message: error.message });
        this._rejectStart(error);
        try { socket.close(); } catch (_) {}
      };
      const onOpen = async () => {
        try {
          // A main-process transport may require a pinned TLS certificate.
          // Verify it before reading or transmitting the session credential.
          if (typeof config.verifyPeer === 'function') await config.verifyPeer(socket);
          const token = await this.getCredential(serverHost);
          if (generation !== this.generation || socket !== this.socket || this.state !== 'connecting') {
            closeWithError(terminalError('start_cancelled', 'Cloud terminal start was cancelled'));
            return;
          }
          socket.send(JSON.stringify({
            type: 'terminal.start',
            protocol: 1,
            token: String(token || ''),
            runtimeId,
            workspace,
            setupCommands,
            cols,
            rows
          }));
        } catch (error) {
          closeWithError(error);
        }
      };
      const onMessage = (event) => {
        if (generation !== this.generation || socket !== this.socket) return;
        const bytes = socketBytes(event);
        const raw = event && event.data !== undefined ? event.data : event;
        if (bytes && typeof raw !== 'string') {
          this._emitOutput(this.decoder.decode(bytes, { stream: true }));
          return;
        }
        const text = socketText(event);
        if (!text) return;
        let message;
        try { message = JSON.parse(text); } catch (_) {
          this._emitOutput(text);
          return;
        }
        if (message.type === 'terminal.ready') {
          if (this.state !== 'connecting') return;
          this._clearTimers();
          this.sessionId = String(message.sessionId || '');
          if (!this.sessionId) {
            closeWithError(terminalError('protocol_error', 'Cloud terminal did not provide a session identifier'));
            return;
          }
          this.state = 'ready';
          this.capabilities = message.capabilities && typeof message.capabilities === 'object'
            ? Object.assign({}, message.capabilities)
            : {};
          this._emitStatus({ runtimeId: String(message.runtimeId || runtimeId), snapshot: message.snapshot === true, limits: message.limits || null, capabilities: Object.assign({}, this.capabilities) });
          this._startPing(generation);
          this._resolveStart({ sessionId: this.sessionId, runtimeId: String(message.runtimeId || runtimeId), snapshot: message.snapshot === true, limits: message.limits || null, capabilities: Object.assign({}, this.capabilities) });
          return;
        }
        if (message.type === 'terminal.output') {
          if (message.encoding === 'base64') {
            const stream = message.stream === 'stderr' ? 'stderr' : 'stdout';
            const bytes = Buffer.from(typeof message.data === 'string' ? message.data : '', 'base64');
            this._emitOutput(this.streamDecoders[stream].decode(bytes, { stream: true }));
          } else {
            this._emitOutput(message.data);
          }
          return;
        }
        if (message.type === 'terminal.error') {
          const error = terminalError(message.code || 'terminal_error', message.message || message.data);
          if (this.state === 'connecting') closeWithError(error);
          else {
            this._emitStatus({ state: 'error', code: error.code, message: error.message });
          }
          return;
        }
        if (message.type === 'terminal.exit') {
          this._finishClosed({
            reason: String(message.reason || 'exit'),
            exitCode: Number.isInteger(message.exitCode) ? message.exitCode : null,
            confirmed: message.cleanupConfirmed !== false
          });
        }
      };
      const onError = (event) => {
        if (this.state === 'closing') {
          this._finishClosed({ reason: 'connection_error', confirmed: false });
          return;
        }
        closeWithError(terminalError('connection_error', event && event.message || 'Cloud terminal WebSocket error'));
      };
      const onClose = () => {
        if (generation !== this.generation || socket !== this.socket) return;
        const trailing = this.decoder.decode();
        this._emitOutput(trailing);
        this._emitOutput(this.streamDecoders.stdout.decode());
        this._emitOutput(this.streamDecoders.stderr.decode());
        if (this.state === 'connecting') {
          closeWithError(terminalError('connection_closed', 'Connection to the cloud terminal was closed'));
          return;
        }
        if (this.state !== 'closed' && this.state !== 'idle') this._finishClosed({ reason: 'connection_closed', confirmed: false });
      };
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      } else if (typeof socket.on === 'function') {
        // The hardened main-process client is `ws`, which is an EventEmitter
        // rather than a browser EventTarget. Keep the transport protocol
        // agnostic by adapting only the event envelope here.
        socket.on('open', onOpen);
        socket.on('message', (data) => onMessage({ data }));
        socket.on('error', onError);
        socket.on('close', onClose);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = onMessage;
        socket.onerror = onError;
        socket.onclose = onClose;
      }
      this.connectTimer = this.setTimer(() => {
        if (generation !== this.generation || this.state !== 'connecting') return;
        const error = terminalError('connection_timeout', 'Timed out connecting to the cloud terminal');
        try { socket.close(); } catch (_) {}
        closeWithError(error);
      }, this.connectTimeoutMs);
    });
    return this.startPromise;
  }

  _finishClosed(details) {
    const socket = this.socket;
    const resolveClose = this.closeResolve;
    const silent = this.closeSilent;
    const result = Object.assign({ state: 'closed', confirmed: false }, details || {});
    this._clearTimers();
    this.socket = null;
    this.closePromise = null;
    this.closeResolve = null;
    this.closeSilent = false;
    this._emitOutput(this.decoder.decode());
    this._emitOutput(this.streamDecoders.stdout.decode());
    this._emitOutput(this.streamDecoders.stderr.decode());
    this.state = 'closed';
    this.capabilities = null;
    if (!silent) this._emitStatus(result);
    this.sessionId = '';
    if (socket) { try { socket.close(); } catch (_) {} }
    if (resolveClose) resolveClose(result);
  }

  write(data) {
    const value = typeof data === 'string' ? data : '';
    if (!value || value.length > MAX_STDIN_CHARS || Buffer.byteLength(value, 'utf8') > MAX_STDIN_BYTES) {
      throw terminalError('invalid_input', 'Terminal input is invalid or too large');
    }
    if (this.state !== 'ready') throw terminalError('terminal_offline', 'Cloud terminal is offline');
    this._sendControl({ type: 'terminal.stdin', data: value });
    return { accepted: true };
  }

  resize(cols, rows) {
    if (this.state !== 'ready') return { accepted: false };
    if (!this.capabilities || this.capabilities.resize !== true) return { accepted: false };
    const width = boundedDimension(cols, 0);
    const height = boundedDimension(rows, 0);
    if (!width || !height) throw terminalError('invalid_resize', 'Terminal size is invalid');
    this._sendControl({ type: 'terminal.resize', cols: width, rows: height });
    return { accepted: true };
  }

  async stop(reason, options = {}) {
    if (this.state === 'closing' && this.closePromise) return this.closePromise;
    const socket = this.socket;
    const wasActive = this.state === 'connecting' || this.state === 'ready' || this.state === 'closing';
    const closeReason = String(reason || 'close');
    this._clearTimers();
    if (this.state === 'ready' && socket && socket.readyState === 1) {
      this.state = 'closing';
      this.closeSilent = options.silent === true;
      if (!this.closeSilent) this._emitStatus({ reason: closeReason });
      this.closePromise = new Promise((resolve) => { this.closeResolve = resolve; });
      const closePromise = this.closePromise;
      this.closeTimer = this.setTimer(() => {
        if (this.state === 'closing' && socket === this.socket) {
          this._finishClosed({ reason: 'close_timeout', confirmed: false });
        }
      }, this.closeTimeoutMs);
      try {
        socket.send(JSON.stringify({ type: 'terminal.close', reason: closeReason }));
      } catch (_) {
        this._finishClosed({ reason: 'close_send_failed', confirmed: false });
      }
      return closePromise;
    }

    ++this.generation;
    this.socket = null;
    const startError = this.startReject ? terminalError('start_cancelled', 'Cloud terminal start was cancelled') : null;
    if (startError) this._rejectStart(startError);
    if (socket) { try { socket.close(); } catch (_) {} }
    this.sessionId = '';
    this.capabilities = null;
    this.state = 'idle';
    if (!options.silent && wasActive) this._emitStatus({ reason: closeReason, confirmed: false });
    return { state: 'idle', reason: closeReason, confirmed: !wasActive };
  }

  async dispose() {
    try { await this.stop('dispose', { silent: true }); } catch (_) {}
    this.contextToken = null;
  }
}

module.exports = {
  TerminalTransport,
  normalizeTerminalUrl,
  cleanWorkspace,
  boundedDimension,
  cleanSetupCommands,
  MAX_STDIN_CHARS,
  MAX_STDIN_BYTES,
  MAX_SETUP_COMMANDS,
  MAX_SETUP_COMMAND_BYTES
};
