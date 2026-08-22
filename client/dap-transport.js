'use strict';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const MAX_SETUP_COMMANDS = 64;
const MAX_SETUP_COMMAND_BYTES = 512;

function normalizeDapUrl(serverHost) {
  let input = String(serverHost || '').trim();
  if (!input) throw new Error('Server address is not configured');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'http://' + input;
  const parsed = new URL(input);
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  parsed.protocol = secure ? 'wss:' : 'ws:';
  if (!parsed.port) parsed.port = '3100';
  parsed.pathname = '/dap';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function normalizeDapChildUrl(serverHost, childPort) {
  let input = String(serverHost || '').trim();
  if (!input) throw new Error('Server address is not configured');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'http://' + input;
  const parsed = new URL(input);
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  parsed.protocol = secure ? 'wss:' : 'ws:';
  parsed.port = String(Number.isInteger(Number(childPort)) && Number(childPort) > 0 ? Number(childPort) : 3102);
  parsed.pathname = '/dap-child';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function cleanWorkspace(workspace) {
  const value = workspace && typeof workspace === 'object' ? workspace : {};
  if (value.kind === 'team') {
    if (!value.teamId || !value.projectId || !value.branch) throw new Error('Incomplete team workspace identity');
    return {
      kind: 'team',
      teamId: String(value.teamId),
      projectId: String(value.projectId),
      branch: String(value.branch)
    };
  }
  const folderName = String(value.folderName || '').trim();
  const folderKey = String(value.folderKey || '').trim();
  if ((!folderName && !folderKey) || /[/\\]/.test(folderName)) throw new Error('Invalid personal workspace identity');
  return { kind: 'personal', folderName, folderKey };
}

function cleanSetupCommands(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_SETUP_COMMANDS) {
    const error = new Error('The cloud debugger could not be started.');
    error.code = 'invalid_start';
    throw error;
  }
  return value.map((command) => {
    if (typeof command !== 'string' || Buffer.byteLength(command, 'utf8') > MAX_SETUP_COMMAND_BYTES || /[\0\r\n]/.test(command)) {
      const error = new Error('The cloud debugger could not be started.');
      error.code = 'invalid_start';
      throw error;
    }
    return command.trim();
  });
}

function cleanDependencyCacheStatus(value) {
  if (!value || typeof value !== 'object') return null;
  const allowedStates = new Set([
    'mounted', 'missing', 'busy', 'incomplete', 'stale', 'corrupt',
    'unsupported', 'unavailable', 'error', 'not_applicable'
  ]);
  const state = String(value.state || 'unavailable').toLowerCase();
  return {
    state: allowedStates.has(state) ? state : 'unavailable',
    required: value.required === true,
    digestSource: String(value.digestSource || '').slice(0, 32),
    exact: value.exact === true
  };
}

function socketData(event) {
  const raw = event && event.data !== undefined ? event.data : event;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.toString === 'function') return raw.toString('utf8');
  return '';
}

class DapChildChannel {
  constructor(parent, control) {
    this.parent = parent;
    this.control = control;
    this.socket = null;
    this.nextSeq = 1;
    this.pending = new Map();
    this.ready = false;
    this.closed = false;
  }

  async connect() {
    const parent = this.parent;
    const generation = parent.generation;
    const config = parent.config;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(this);
      };
      let socket;
      try {
        socket = parent.webSocketFactory(normalizeDapChildUrl(config.serverHost, config.childPort));
      } catch (error) {
        finish(error);
        return;
      }
      this.socket = socket;
      const onOpen = async () => {
        try {
          const token = await parent.getCredential(config.serverHost);
          if (this.closed || generation !== parent.generation || socket !== this.socket) {
            finish(parent._cancelledStartError());
            return;
          }
          socket.send(JSON.stringify({ type: 'dap.child.attach', token: String(token || ''), ticket: String(this.control.ticket || '') }));
        } catch (error) {
          finish(error);
        }
      };
      const onMessage = (event) => {
        if (this.closed || generation !== parent.generation || socket !== this.socket) return;
        const text = socketData(event);
        if (!text) return;
        let message;
        try { message = JSON.parse(text); } catch (_) { return; }
        if (message.type === 'dap.child.ready') {
          this.ready = true;
          finish(null);
          return;
        }
        if (message.type === 'dap.error') {
          const error = parent._controlError(message);
          this._rejectPending(error);
          finish(error);
          this.close();
          return;
        }
        if (this.ready) parent._acceptProtocolMessage(message, this);
      };
      const onError = (event) => {
        const error = new Error(event && event.message ? event.message : 'Debug child WebSocket error');
        error.code = 'connection_error';
        this._rejectPending(error);
        finish(error);
      };
      const onClose = () => {
        this.socket = null;
        const error = new Error('Connection to the debug service was lost');
        this._rejectPending(error);
        if (!this.closed) finish(error);
      };
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = onMessage;
        socket.onerror = onError;
        socket.onclose = onClose;
      }
    });
  }

  request(command, args, timeoutMs) {
    const seq = this._allocateSeq();
    const message = { seq, type: 'request', command, arguments: args && typeof args === 'object' ? args : {} };
    return new Promise((resolve, reject) => {
      const timer = this.parent.setTimer(() => {
        if (!this.pending.has(seq)) return;
        this.pending.delete(seq);
        reject(new Error(`DAP ${command} request timed out`));
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.parent.requestTimeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
      try { this.sendRaw(message); } catch (error) {
        this.pending.delete(seq);
        this.parent.clearTimer(timer);
        reject(error);
      }
    });
  }

  sendRaw(message) {
    if (!this.ready || !this.socket || this.socket.readyState !== 1) throw new Error('Cloud debug child service is offline');
    this.socket.send(JSON.stringify(message));
  }

  startTarget(command, configuration) {
    const request = {
      seq: this._allocateSeq(),
      type: 'request',
      command: String(command || 'launch'),
      arguments: configuration && typeof configuration === 'object' ? configuration : {}
    };
    // js-debug can keep this child launch response pending for the life of
    // the target. Root launch/events report startup, so do not create a
    // timeout-bound pending request for this protocol handoff.
    this.sendRaw(request);
    return request.seq;
  }

  respond(request, success, body, message) {
    const response = { seq: this._allocateSeq(), type: 'response', request_seq: request.seq, command: String(request.command || ''), success: success !== false };
    if (body !== undefined) response.body = body;
    if (message) response.message = String(message);
    this.sendRaw(response);
  }

  accept(message) {
    if (message.type === 'response' && Number.isInteger(message.request_seq)) {
      const pending = this.pending.get(message.request_seq);
      if (pending) {
        this.pending.delete(message.request_seq);
        this.parent.clearTimer(pending.timer);
        if (message.success === false) {
          const error = new Error(`DAP request failed: ${pending.command}`);
          error.code = 'DAP_REQUEST_FAILED';
          error.command = pending.command;
          error.details = String(message.message || '');
          pending.reject(error);
        } else {
          pending.resolve(message.body || {});
        }
      }
    }
  }

  _allocateSeq() {
    for (let attempts = 0; attempts < 0x7fffffff; attempts++) {
      const seq = this.nextSeq;
      this.nextSeq = this.nextSeq >= 0x7fffffff ? 1 : this.nextSeq + 1;
      if (!this.pending.has(seq)) return seq;
    }
    throw new Error('No DAP child request sequence is available');
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      this.parent.clearTimer(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this._rejectPending(new Error('Debug child session stopped'));
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.close(); } catch (_) {} }
  }
}

class DapTransport {
  constructor(options = {}) {
    this.webSocketFactory = options.webSocketFactory || ((url) => new WebSocket(url));
    this.getCredential = options.getCredential || (() => '');
    this.emit = options.emit || (() => {});
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.socket = null;
    this.generation = 0;
    this.nextSeq = 1;
    this.pending = new Map();
    this.state = 'idle';
    this.sessionId = '';
    this.adapter = null;
    this.capabilities = null;
    this.dependencyCache = null;
    this.lastError = '';
    this.config = null;
    this.intentionalStop = false;
    this.protocolEnded = false;
    this.localContext = null;
    this.connectAttempt = null;
    this.startIntent = 0;
    this.child = null;
    this.initializeArguments = null;
    this.childStarting = null;
  }

  snapshot(extra = {}) {
    return Object.assign({
      state: this.state,
      sessionId: this.sessionId,
      adapter: this.adapter,
      capabilities: this.capabilities,
      dependencyCache: this.dependencyCache,
      error: this.lastError,
      generation: this.generation,
      contextToken: this.localContext
    }, extra);
  }

  _setState(state, extra = {}) {
    this.state = state;
    if (Object.prototype.hasOwnProperty.call(extra, 'error')) this.lastError = String(extra.error || '');
    this.emit('status', this.snapshot(extra));
  }

  async start(rawConfig) {
    const intent = ++this.startIntent;
    this._stopNow('restart');
    if (intent !== this.startIntent) throw this._cancelledStartError();
    const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    this.localContext = config.localContext && typeof config.localContext === 'object'
      ? Object.assign({}, config.localContext)
      : null;
    if (!config.languageId || !config.runtimeId) throw new Error('Language and cloud runtime are required for debugging');
    this.config = {
      serverHost: String(config.serverHost || '').trim(),
      childPort: Number(config.childPort) || 3102,
      languageId: String(config.languageId),
      runtimeId: String(config.runtimeId),
      workspace: cleanWorkspace(config.workspace),
      setupCommands: cleanSetupCommands(config.setupCommands)
    };
    this.intentionalStop = false;
    this.protocolEnded = false;
    this.sessionId = '';
    this.adapter = null;
    this.capabilities = null;
    this.dependencyCache = null;
    this.lastError = '';
    const generation = ++this.generation;
    this._setState('connecting');

    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      let attempt;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        if (this.connectAttempt === attempt) this.connectAttempt = null;
        if (error) reject(error);
        else resolve(value);
      };
      const timer = this.setTimer(() => {
        if (generation !== this.generation) return;
        const error = new Error('Timed out connecting to the cloud debug service');
        this._setState('error', { error: error.message });
        this._closeSocket();
        finish(error);
      }, this.connectTimeoutMs);
      attempt = { generation, finish };
      this.connectAttempt = attempt;

      try {
        socket = this.webSocketFactory(normalizeDapUrl(this.config.serverHost));
      } catch (error) {
        this._setState('error', { error: error.message });
        finish(error);
        return;
      }
      this.socket = socket;

      const onOpen = async () => {
        if (generation !== this.generation || socket !== this.socket) return;
        try {
          const token = await this.getCredential(this.config.serverHost);
          if (generation !== this.generation || socket !== this.socket) return;
          this._sendRaw({
            type: 'dap.start',
            token: String(token || ''),
            runtimeId: this.config.runtimeId,
            languageId: this.config.languageId,
            setupCommands: this.config.setupCommands,
            workspace: this.config.workspace
          }, true);
        } catch (error) {
          this._setState('error', { error: error.message });
          this._closeSocket();
          finish(error);
        }
      };
      const onMessage = (event) => {
        if (generation !== this.generation || socket !== this.socket) return;
        const text = socketData(event);
        if (!text) return;
        let message;
        try { message = JSON.parse(text); } catch (_) { return; }
        if (message.type === 'dap.ready' && this.state === 'connecting') {
          this.sessionId = String(message.sessionId || '');
          this.adapter = message.adapter && typeof message.adapter === 'object' ? message.adapter : null;
          this.capabilities = message.capabilities && typeof message.capabilities === 'object' ? message.capabilities : null;
          this.dependencyCache = cleanDependencyCacheStatus(message.dependencyCache);
          this._setState('ready');
          finish(null, this.snapshot());
          return;
        }
        if (message.type === 'dap.error') {
          const error = this._controlError(message);
          this._setState('error', { error: error.message, code: error.code, details: error.details });
          this._rejectPending(error);
          this._closeSocket();
          finish(error);
          return;
        }
        if (message.type === 'dap.child') {
          this._startChild(message).catch((error) => {
            this._respondRoot(message.request, false, {}, error && error.message ? error.message : 'Unable to attach debug child session');
            this._setState('error', { error: error && error.message ? error.message : 'Unable to attach debug session' });
          });
          return;
        }
        if (this.state !== 'ready') return;
        this._acceptProtocolMessage(message);
      };
      const onError = (event) => {
        if (generation !== this.generation || socket !== this.socket) return;
        const message = event && event.message ? event.message : 'Debug WebSocket error';
        const error = new Error(message);
        error.code = 'connection_error';
        this._setState('error', { error: message, code: error.code });
        this._rejectPending(error);
        this._closeSocket();
        finish(error);
      };
      const onClose = () => {
        if (generation !== this.generation || socket !== this.socket) return;
        this.socket = null;
        this._rejectPending(new Error('Connection to the debug service was lost'));
        const wasIntentional = this.intentionalStop || this.protocolEnded;
        this._setState(wasIntentional ? 'idle' : 'disconnected');
        if (!wasIntentional) finish(new Error('Connection to the debug service was lost'));
      };
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = onMessage;
        socket.onerror = onError;
        socket.onclose = onClose;
      }
    });
  }

  _controlError(message) {
    const detail = message && message.details && message.details.reason
      ? String(message.details.reason)
      : String(message && message.message || 'Cloud debug service rejected the session');
    const error = new Error(detail);
    error.code = String(message && message.code || 'DAP_ERROR');
    error.details = message && message.details && typeof message.details === 'object' ? message.details : null;
    return error;
  }

  _acceptProtocolMessage(message, channel = null) {
    if (!message || typeof message !== 'object') return;
    if (channel) channel.accept(message);
    if (!channel && message.type === 'response' && Number.isInteger(message.request_seq)) {
      const pending = this.pending.get(message.request_seq);
      if (pending) {
        this.pending.delete(message.request_seq);
        this.clearTimer(pending.timer);
        if (message.success === false) {
          const error = new Error(`DAP request failed: ${pending.command}`);
          error.code = 'DAP_REQUEST_FAILED';
          error.command = pending.command;
          error.details = String(message.message || '');
          error.body = message.body;
          pending.reject(error);
        } else {
          pending.resolve(message.body || {});
        }
      }
    }
    if (message.type === 'event' && (message.event === 'terminated' || message.event === 'exited')) {
      this.protocolEnded = true;
    }
    this.emit('message', {
      message,
      generation: this.generation,
      sessionId: this.sessionId,
      contextToken: this.localContext
    });
  }

  async _startChild(control) {
    if (!control || !control.ticket || !control.request) throw new Error('Invalid debug child session request');
    if (this.childStarting) return this.childStarting;
    const request = typeof control.request === 'string' ? JSON.parse(control.request) : control.request;
    const configuration = request && request.arguments && request.arguments.configuration;
    if (!request || request.type !== 'request' || request.command !== 'startDebugging' || !configuration || typeof configuration !== 'object') {
      throw new Error('Invalid debug child launch configuration');
    }
    this.childStarting = (async () => {
      const child = new DapChildChannel(this, control);
      await child.connect();
      const initialize = Object.assign({}, this.initializeArguments || {}, { clientID: 'bobocloud-editor', clientName: 'BOBOCLOUD Editor', supportsVariablePaging: true });
      await child.request('initialize', initialize, this.requestTimeoutMs);
      const command = String(configuration.request || 'launch');
      child.startTarget(command, configuration);
      await child.request('configurationDone', {}, this.requestTimeoutMs);
      this.child = child;
      this._respondRoot(request, true, {});
    })();
    try {
      return await this.childStarting;
    } finally {
      this.childStarting = null;
    }
  }

  _sendRaw(message, allowConnecting = false) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Cloud debug service is offline');
    if (!allowConnecting && this.state !== 'ready') throw new Error('Cloud debug service is not ready');
    this.socket.send(JSON.stringify(message));
  }

  send(message) {
    if (!message || typeof message !== 'object') throw new TypeError('DAP message must be an object');
    if (this.child && this.child.ready) {
      this.child.sendRaw(message);
      return true;
    }
    this._sendRaw(message);
    return true;
  }

  request(command, args, timeoutMs) {
    if (typeof command !== 'string' || !command) return Promise.reject(new TypeError('DAP command is required'));
    if (command === 'initialize' && !this.initializeArguments) this.initializeArguments = Object.assign({}, args || {});
    if (this.child && this.child.ready) return this.child.request(command, args, timeoutMs);
    const seq = this._allocateSeq();
    const message = { seq, type: 'request', command, arguments: args && typeof args === 'object' ? args : {} };
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (!this.pending.has(seq)) return;
        this.pending.delete(seq);
        reject(new Error(`DAP ${command} request timed out`));
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.requestTimeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
      try {
        this._sendRaw(message);
      } catch (error) {
        this.pending.delete(seq);
        this.clearTimer(timer);
        reject(error);
      }
    });
  }

  respond(request, success, body, message) {
    if (!request || request.type !== 'request' || !Number.isInteger(request.seq)) throw new TypeError('Invalid DAP reverse request');
    if (this.child && this.child.ready) {
      this.child.respond(request, success, body, message);
      return true;
    }
    return this._respondRoot(request, success, body, message);
  }

  _respondRoot(request, success, body, message) {
    if (!request || request.type !== 'request' || !Number.isInteger(request.seq)) throw new TypeError('Invalid DAP reverse request');
    const response = {
      seq: this._allocateSeq(),
      type: 'response',
      request_seq: request.seq,
      command: String(request.command || ''),
      success: success !== false
    };
    if (body !== undefined) response.body = body;
    if (message) response.message = String(message);
    this._sendRaw(response);
    return true;
  }

  async stop(reason = 'stop') {
    ++this.startIntent;
    return this._stopNow(reason);
  }

  _cancelledStartError() {
    const error = new Error('Debug session start was cancelled');
    error.code = 'DAP_START_CANCELLED';
    return error;
  }

  _stopNow(reason = 'stop') {
    this.intentionalStop = true;
    ++this.generation;
    const attempt = this.connectAttempt;
    this.connectAttempt = null;
    if (attempt) attempt.finish(this._cancelledStartError());
    this._rejectPending(new Error('Debug session stopped'));
    if (this.child) this.child.close();
    this.child = null;
    this.childStarting = null;
    this._closeSocket();
    this.config = null;
    this.sessionId = '';
    this.adapter = null;
    this.capabilities = null;
    this.dependencyCache = null;
    this.protocolEnded = false;
    if (this.state !== 'idle') this._setState('idle', { reason });
    this.localContext = null;
    this.initializeArguments = null;
    return this.snapshot();
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _allocateSeq() {
    for (let attempts = 0; attempts < 0x7fffffff; attempts++) {
      const seq = this.nextSeq;
      this.nextSeq = this.nextSeq >= 0x7fffffff ? 1 : this.nextSeq + 1;
      if (!this.pending.has(seq)) return seq;
    }
    throw new Error('No DAP request sequence is available');
  }

  _closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try { socket.close(); } catch (_) {}
  }

  dispose() {
    return this.stop('dispose');
  }
}

module.exports = {
  DapTransport,
  normalizeDapUrl,
  normalizeDapChildUrl,
  cleanWorkspace,
  cleanSetupCommands,
  cleanDependencyCacheStatus,
  MAX_SETUP_COMMANDS,
  MAX_SETUP_COMMAND_BYTES
};
