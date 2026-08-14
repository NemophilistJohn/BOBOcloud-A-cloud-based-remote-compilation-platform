'use strict';

const APP_VERSION = require('./package.json').version;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 45000;

function byteLength(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return typeof Buffer !== 'undefined'
    ? Buffer.byteLength(text, 'utf8')
    : new TextEncoder().encode(text).length;
}

function normalizeLspUrl(serverHost) {
  let input = String(serverHost || '').trim();
  if (!input) throw new Error('Server address is not configured');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'http://' + input;
  const parsed = new URL(input);
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  parsed.protocol = secure ? 'wss:' : 'ws:';
  parsed.port = '3100';
  parsed.pathname = '/lsp';
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
  if (!value.folderName || !value.folderKey || /[/\\]/.test(String(value.folderName))) {
    throw new Error('Invalid personal workspace identity');
  }
  return { kind: 'personal', folderName: String(value.folderName), folderKey: String(value.folderKey) };
}

function normalizeConfig(config) {
  const value = config && typeof config === 'object' ? config : {};
  const mode = ['local', 'standard', 'full'].includes(value.mode) ? value.mode : 'local';
  if (mode === 'local') return { mode: 'local' };
  if (!value.languageId) throw new Error('Language is required for remote analysis');
  return {
    mode,
    serverHost: String(value.serverHost || '').trim(),
    languageId: String(value.languageId),
    runtimeId: String(value.runtimeId || ''),
    workspace: cleanWorkspace(value.workspace)
  };
}

function normalizeDependency(dependency, config = {}) {
  if (!dependency || typeof dependency !== 'object') return null;
  const allowedStatuses = ['ready', 'mixed', 'empty', 'unavailable'];
  const status = String(dependency.status || '').toLowerCase();
  const configuration = dependency.configuration && typeof dependency.configuration === 'object' && !Array.isArray(dependency.configuration)
    ? dependency.configuration
    : {};
  return {
    status: allowedStatuses.includes(status) ? status : 'unavailable',
    revision: dependency.revision === undefined || dependency.revision === null ? '' : String(dependency.revision),
    languageId: String(dependency.languageId || config.languageId || ''),
    runtimeId: String(dependency.runtimeId || config.runtimeId || ''),
    source: String(dependency.source || ''),
    configuration,
    detail: String(dependency.detail || '')
  };
}

function resolveConfigurationSection(configuration, rawSection) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
  const section = typeof rawSection === 'string' ? rawSection.trim() : '';
  if (!section) return null;
  const parts = section.split('.');
  if (parts.some((part) => !part || part === '__proto__' || part === 'prototype' || part === 'constructor')) return null;
  if (Object.prototype.hasOwnProperty.call(configuration, section)) {
    return configuration[section] === undefined ? null : configuration[section];
  }
  let current = configuration;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return null;
    }
    current = current[part];
  }
  return current === undefined ? null : current;
}

class LspTransport {
  constructor(options = {}) {
    this.webSocketFactory = options.webSocketFactory || ((url) => new WebSocket(url));
    this.getCredential = options.getCredential || (() => '');
    this.emit = options.emit || (() => {});
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs || DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.socket = null;
    this.config = { mode: 'local' };
    this.generation = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.keyToId = new Map();
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.intentionalStop = false;
    this.metrics = {
      bytesSent: 0,
      bytesReceived: 0,
      latencyMs: null,
      cache: null,
      dependency: null,
      capabilities: null,
      gatewayCapabilities: null,
      sessionId: ''
    };
    this.state = 'local';
    this.lastError = '';
    this.fastReconnect = false;
    this.lifecycleRevision = 0;
    this.lifecycleChain = Promise.resolve();
  }

  snapshot(extra = {}) {
    return Object.assign({
      state: this.state,
      mode: this.config.mode,
      languageId: this.config.languageId || '',
      runtimeId: this.config.runtimeId || '',
      reconnectAttempt: this.reconnectAttempt,
      bytesSent: this.metrics.bytesSent,
      bytesReceived: this.metrics.bytesReceived,
      latencyMs: this.metrics.latencyMs,
      cache: this.metrics.cache,
      dependency: this.metrics.dependency,
      capabilities: this.metrics.capabilities,
      gatewayCapabilities: this.metrics.gatewayCapabilities,
      sessionId: this.metrics.sessionId,
      error: this.lastError
    }, extra);
  }

  _setState(state, extra) {
    this.state = state;
    if (extra && extra.error) this.lastError = String(extra.error);
    if (state === 'ready' || state === 'local') this.lastError = '';
    this.emit('status', this.snapshot(extra));
  }

  _enqueueLifecycle(operation) {
    const pending = this.lifecycleChain.catch(() => {}).then(operation);
    this.lifecycleChain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  configure(rawConfig) {
    const next = normalizeConfig(rawConfig);
    const revision = ++this.lifecycleRevision;
    return this._enqueueLifecycle(async () => {
      if (revision !== this.lifecycleRevision) return this.snapshot();
      const signature = JSON.stringify(next);
      const currentSignature = JSON.stringify(this.config);
      const connectionIsUsable = next.mode === 'local'
        ? this.state === 'local'
        : !!this.socket && (this.state === 'ready' || this.state === 'connecting');
      if (signature === currentSignature && connectionIsUsable) {
        return this.snapshot();
      }
      await this._shutdownAndClose('Configuration changed');
      if (revision !== this.lifecycleRevision) return this.snapshot();
      this.config = next;
      this.intentionalStop = next.mode === 'local';
      this.reconnectAttempt = 0;
      this.metrics.latencyMs = null;
      this.metrics.sessionId = '';
      this.metrics.dependency = null;
      this.metrics.capabilities = null;
      this.metrics.gatewayCapabilities = null;
      this.fastReconnect = false;
      this.lastError = '';
      if (next.mode === 'local') {
        this._setState('local');
        return this.snapshot();
      }
      await this._connect();
      return this.snapshot();
    });
  }

  async _connect() {
    const generation = ++this.generation;
    this.intentionalStop = false;
    this.metrics.capabilities = null;
    this.metrics.gatewayCapabilities = null;
    this._setState('connecting');
    let socket;
    try {
      socket = this.webSocketFactory(normalizeLspUrl(this.config.serverHost));
    } catch (error) {
      this._setState('error', { error: error.message });
      this._scheduleReconnect();
      return;
    }
    this.socket = socket;
    const onOpen = async () => {
      if (generation !== this.generation || socket !== this.socket) return;
      try {
        const token = await this.getCredential(this.config.serverHost);
        if (generation !== this.generation || socket !== this.socket) return;
        this._send({
          type: 'lsp.start',
          token: String(token || ''),
          mode: this.config.mode,
          languageId: this.config.languageId,
          runtimeId: this.config.runtimeId,
          workspace: this.config.workspace
        }, true);
      } catch (error) {
        this._setState('error', { error: error.message });
        this._closeSocket(false, error.message);
      }
    };
    const onMessage = (event) => {
      if (generation !== this.generation || socket !== this.socket) return;
      this._onMessage(event && event.data !== undefined ? event.data : event);
    };
    const onError = (event) => {
      if (generation !== this.generation || socket !== this.socket) return;
      const message = event && event.message ? event.message : 'LSP WebSocket error';
      this._setState('error', { error: message });
    };
    const onClose = () => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.socket = null;
      this.metrics.capabilities = null;
      this.metrics.gatewayCapabilities = null;
      this._rejectPending(new Error('Remote language service disconnected'));
      if (!this.intentionalStop && this.config.mode !== 'local') {
        const reconnectDelay = this.fastReconnect ? 75 : undefined;
        this.fastReconnect = false;
        this._setState('disconnected');
        this._scheduleReconnect(reconnectDelay);
      }
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
  }

  _send(payload, allowBeforeReady) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Remote language service is offline');
    if (!allowBeforeReady && this.state !== 'ready') throw new Error('Remote language service is not ready');
    const encoded = JSON.stringify(payload);
    this.socket.send(encoded);
    this.metrics.bytesSent += byteLength(encoded);
  }

  _onMessage(raw) {
    let text;
    if (typeof raw === 'string') text = raw;
    else if (raw && typeof raw.toString === 'function') text = raw.toString('utf8');
    else return;
    this.metrics.bytesReceived += byteLength(text);
    let message;
    try { message = JSON.parse(text); } catch (_) { return; }

    if (message && message.type) {
      if (message.type === 'lsp.ready') {
        this.metrics.sessionId = String(message.sessionId || '');
        this.metrics.cache = message.cache || null;
        this.metrics.dependency = normalizeDependency(message.dependency || message.dependencyView, this.config);
        this.metrics.gatewayCapabilities = message.capabilities && typeof message.capabilities === 'object'
          ? message.capabilities
          : null;
        this._beginInitialize(message.capabilities || {});
      } else if (message.type === 'lsp.error') {
        this._setState('error', { error: message.message || 'Remote language service error', code: message.code || '' });
      } else if (message.type === 'lsp.cache') {
        if (message.cache) this.metrics.cache = message.cache;
        this.emit('cache', Object.assign({}, message, { bytesSent: this.metrics.bytesSent, bytesReceived: this.metrics.bytesReceived }));
        this.emit('status', this.snapshot());
      } else if (message.type === 'lsp.dependency') {
        const dependency = normalizeDependency(message.dependency || message.dependencyView, this.config);
        if (dependency) this.metrics.dependency = dependency;
        const changed = message.success !== false && message.changed === true;
        const restartRequired = changed && message.restartRequired !== false;
        this.fastReconnect = restartRequired;
        if (changed && !restartRequired && this.state === 'ready') {
          try {
            this._send({
              jsonrpc: '2.0',
              method: 'workspace/didChangeConfiguration',
              params: { settings: dependency ? dependency.configuration : {} }
            });
          } catch (_) {}
        }
        this.emit('status', this.snapshot({
          dependencyRefresh: {
            success: message.success !== false,
            changed,
            restartRequired
          }
        }));
      } else if (message.type === 'lsp.dependency.index') {
        // This is a server-issued, bounded dependency-summary page. Keep it
        // distinct from generic controls so a renderer can subscribe without
        // treating arbitrary future control frames as cached index content.
        this.emit('dependency-index', message);
      } else {
        this.emit('control', message);
      }
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.key) this.keyToId.delete(pending.key);
      this.clearTimer(pending.timer);
      this.metrics.latencyMs = Math.max(0, this.now() - pending.startedAt);
      this.emit('status', this.snapshot());
      if (message.error) {
        const error = new Error(message.error.message || 'LSP request failed');
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message && message.method && message.id === undefined) {
      this.emit('notification', message);
      return;
    }

    if (message && message.method && message.id !== undefined) {
      this._handleServerRequest(message);
    }
  }

  _handleServerRequest(message) {
    let result;
    switch (message.method) {
      case 'workspace/configuration': {
        const items = message.params && Array.isArray(message.params.items) ? message.params.items : [];
        const configuration = this.metrics.dependency && this.metrics.dependency.configuration;
        result = items.map((item) => resolveConfigurationSection(configuration, item && item.section));
        break;
      }
      case 'workspace/workspaceFolders': {
        const workspace = this.config.workspace || {};
        result = [{
          uri: 'bobocloud-lsp:///',
          name: workspace.kind === 'team'
            ? String(workspace.projectId || 'team-workspace')
            : String(workspace.folderName || 'workspace')
        }];
        break;
      }
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/showMessageRequest':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/diagnostic/refresh':
        result = null;
        break;
      case 'workspace/applyEdit':
        result = { applied: false, failureReason: 'Server-initiated workspace edits require explicit client review' };
        break;
      case 'window/showDocument':
        result = { success: false };
        break;
      default:
        try {
          this._send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method is not supported' } }, true);
        } catch (_) {}
        return;
    }
    try { this._send({ jsonrpc: '2.0', id: message.id, result }, true); } catch (_) {}
  }

  _beginInitialize(gatewayCapabilities) {
    if (this.state === 'initializing' || this.state === 'ready') return;
    this._setState('initializing', { gatewayCapabilities });
    const id = this.nextId++;
    const startedAt = this.now();
    const timer = this.setTimer(() => {
      this.pending.delete(id);
      this._setState('error', { error: 'Language service initialization timed out' });
      this._closeSocket(false, 'Initialization timed out');
      this.intentionalStop = false;
      this._scheduleReconnect();
    }, this.initializeTimeoutMs);
    this.pending.set(id, {
      key: '',
      startedAt,
      timer,
      internal: 'initialize',
      resolve: (result) => {
        try {
          this._send({ jsonrpc: '2.0', method: 'initialized', params: {} }, true);
          this.reconnectAttempt = 0;
          this.metrics.capabilities = result && result.capabilities || {};
          this._setState('ready');
        } catch (error) {
          this._setState('error', { error: error.message });
          this._closeSocket(false, error.message);
          this.intentionalStop = false;
          this._scheduleReconnect();
        }
      },
      reject: (error) => {
        if (!this.socket) return;
        this._setState('error', { error: error.message || 'Language service initialization failed' });
        this._closeSocket(false, error.message);
        this.intentionalStop = false;
        this._scheduleReconnect();
      }
    });
    try {
      this._send({ jsonrpc: '2.0', id, method: 'initialize', params: this._initializeParams() }, true);
    } catch (error) {
      this.pending.delete(id);
      this.clearTimer(timer);
      this._setState('error', { error: error.message });
    }
  }

  _initializeParams() {
    const workspace = this.config.workspace || {};
    const workspaceName = workspace.kind === 'team'
      ? String(workspace.projectId || 'team-workspace')
      : String(workspace.folderName || 'workspace');
    const workspaceCapabilities = {
      applyEdit: false,
      configuration: true,
      workspaceFolders: true
    };
    const textDocumentCapabilities = {
      synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
      completion: {
        dynamicRegistration: false,
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
          insertReplaceSupport: true,
          labelDetailsSupport: true,
          resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
        }
      },
      hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
      definition: { dynamicRegistration: false, linkSupport: true },
      publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: true }
    };
    if (this.config.mode === 'full') {
      workspaceCapabilities.symbol = {
        dynamicRegistration: false,
        symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) }
      };
      textDocumentCapabilities.references = { dynamicRegistration: false };
      textDocumentCapabilities.rename = { dynamicRegistration: false, prepareSupport: true };
    }
    const initializationOptions = { mode: this.config.mode, runtimeId: this.config.runtimeId || '' };
    if (String(this.config.languageId || '').toLowerCase() === 'rust') {
      Object.assign(initializationOptions, {
        cachePriming: { enable: false },
        cargo: { allTargets: false, buildScripts: { enable: false } },
        checkOnSave: false,
        procMacro: { enable: false }
      });
    }
    return {
      processId: null,
      clientInfo: { name: 'BOBOCloudEditer', version: APP_VERSION },
      rootUri: 'bobocloud-lsp:///',
      workspaceFolders: [{ uri: 'bobocloud-lsp:///', name: workspaceName }],
      initializationOptions,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        window: { workDoneProgress: true, showDocument: { support: false } },
        workspace: workspaceCapabilities,
        textDocument: textDocumentCapabilities
      },
      trace: 'off'
    };
  }

  request(method, params, requestKey, timeoutMs) {
    if (this.state !== 'ready') return Promise.reject(new Error('Remote language service is not ready'));
    if (requestKey) this.cancel(requestKey);
    const id = this.nextId++;
    const startedAt = this.now();
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        if (requestKey) this.keyToId.delete(requestKey);
        try { this._send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }); } catch (_) {}
        reject(new Error('LSP request timed out'));
      }, Math.max(250, timeoutMs || this.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer, key: requestKey || '', startedAt });
      if (requestKey) this.keyToId.set(requestKey, id);
      try {
        this._send({ jsonrpc: '2.0', id, method, params: params || {} });
      } catch (error) {
        this.pending.delete(id);
        if (requestKey) this.keyToId.delete(requestKey);
        this.clearTimer(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (this.state !== 'ready') return false;
    this._send({ jsonrpc: '2.0', method, params: params || {} });
    return true;
  }

  cancel(requestKey) {
    const id = this.keyToId.get(requestKey);
    if (id === undefined) return false;
    const pending = this.pending.get(id);
    this.keyToId.delete(requestKey);
    this.pending.delete(id);
    if (pending) {
      this.clearTimer(pending.timer);
      pending.reject(new Error('LSP request cancelled'));
    }
    try { this._send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }); } catch (_) {}
    return true;
  }

  sendControl(type, payload = {}) {
    if (type === 'lsp.restart') {
      return this.restart();
    }
    this._send(Object.assign({}, payload, { type }), true);
    return true;
  }

  restart() {
    const revision = this.lifecycleRevision;
    return this._enqueueLifecycle(async () => {
      if (revision !== this.lifecycleRevision || this.config.mode === 'local') return false;
      await this._shutdownAndClose('Restart requested');
      if (revision !== this.lifecycleRevision) return false;
      this.intentionalStop = false;
      this.reconnectAttempt = 0;
      await this._connect();
      return true;
    });
  }

  _scheduleReconnect(preferredDelay) {
    if (this.reconnectTimer || this.intentionalStop || this.config.mode === 'local') return;
    this.reconnectAttempt += 1;
    const base = Math.min(15000, 500 * Math.pow(2, Math.min(this.reconnectAttempt - 1, 5)));
    const delay = preferredDelay === undefined
      ? Math.round(base * (0.85 + this.random() * 0.3))
      : Math.max(0, Number(preferredDelay) || 0);
    this.emit('status', this.snapshot({ retryInMs: delay }));
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _rejectPending(error) {
    const pendingRequests = Array.from(this.pending.values());
    this.pending.clear();
    this.keyToId.clear();
    for (const pending of pendingRequests) {
      this.clearTimer(pending.timer);
      pending.reject(error);
    }
  }

  async _shutdownAndClose(reason) {
    const socket = this.socket;
    this.intentionalStop = true;
    if (socket && socket.readyState === 1 && this.state === 'ready') {
      try {
        await this.request('shutdown', null, '', 750);
      } catch (_) {}
      if (this.socket === socket && socket.readyState === 1) {
        try { this._send({ jsonrpc: '2.0', method: 'exit', params: null }, true); } catch (_) {}
      }
    }
    this._closeSocket(true, reason);
  }

  _closeSocket(intentional, reason) {
    this.generation += 1;
    this.intentionalStop = intentional;
    this.fastReconnect = false;
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this._rejectPending(new Error(reason || 'Remote language service stopped'));
    if (socket) {
      try { socket.close(1000, String(reason || '').slice(0, 120)); } catch (_) {}
    }
  }

  dispose() {
    this.lifecycleRevision += 1;
    this.config = { mode: 'local' };
    this._closeSocket(true, 'Application closed');
    this.state = 'local';
  }
}

module.exports = {
  LspTransport,
  normalizeLspUrl,
  normalizeConfig,
  cleanWorkspace,
  normalizeDependency,
  resolveConfigurationSection
};
