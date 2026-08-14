'use strict';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

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

function socketData(event) {
  const raw = event && event.data !== undefined ? event.data : event;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.toString === 'function') return raw.toString('utf8');
  return '';
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
    this.lastError = '';
    this.config = null;
    this.intentionalStop = false;
    this.protocolEnded = false;
    this.localContext = null;
    this.connectAttempt = null;
    this.startIntent = 0;
  }

  snapshot(extra = {}) {
    return Object.assign({
      state: this.state,
      sessionId: this.sessionId,
      adapter: this.adapter,
      capabilities: this.capabilities,
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
      languageId: String(config.languageId),
      runtimeId: String(config.runtimeId),
      workspace: cleanWorkspace(config.workspace)
    };
    this.intentionalStop = false;
    this.protocolEnded = false;
    this.sessionId = '';
    this.adapter = null;
    this.capabilities = null;
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
          this._setState('ready');
          finish(null, this.snapshot());
          return;
        }
        if (message.type === 'dap.error') {
          const detail = message.details && message.details.reason
            ? String(message.details.reason)
            : String(message.message || 'Cloud debug service rejected the session');
          const error = new Error(detail);
          error.code = String(message.code || 'DAP_ERROR');
          error.details = message.details && typeof message.details === 'object' ? message.details : null;
          this._setState('error', { error: error.message, code: error.code, details: error.details });
          this._rejectPending(error);
          this._closeSocket();
          finish(error);
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

  _acceptProtocolMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response' && Number.isInteger(message.request_seq)) {
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

  _sendRaw(message, allowConnecting = false) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Cloud debug service is offline');
    if (!allowConnecting && this.state !== 'ready') throw new Error('Cloud debug service is not ready');
    this.socket.send(JSON.stringify(message));
  }

  send(message) {
    if (!message || typeof message !== 'object') throw new TypeError('DAP message must be an object');
    this._sendRaw(message);
    return true;
  }

  request(command, args, timeoutMs) {
    if (typeof command !== 'string' || !command) return Promise.reject(new TypeError('DAP command is required'));
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
    this._closeSocket();
    this.config = null;
    this.sessionId = '';
    this.adapter = null;
    this.capabilities = null;
    this.protocolEnded = false;
    if (this.state !== 'idle') this._setState('idle', { reason });
    this.localContext = null;
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

module.exports = { DapTransport, normalizeDapUrl, cleanWorkspace };
