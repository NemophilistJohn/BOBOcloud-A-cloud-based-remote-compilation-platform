'use strict';

const { TerminalTransport, MAX_STDIN_CHARS, MAX_STDIN_BYTES } = require('../terminal-transport');
const { endpoint: serverEndpoint } = require('./server-transport');
const { createTerminalWebSocketFactory, createTerminalPeerVerifier } = require('./terminal-websocket');

const MAX_DIMENSION = 500;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_DIMENSION) return fallback;
  return number;
}

function cleanRendererWorkspace(value) {
  const workspace = plainObject(value) ? value : {};
  if (workspace.kind === 'team') {
    const teamId = String(workspace.teamId || '').trim();
    const projectId = String(workspace.projectId || '').trim();
    const branch = String(workspace.branch || '').trim();
    if (!teamId || !projectId || !branch) throw new Error('Incomplete team workspace identity');
    return { kind: 'team', teamId, projectId, branch };
  }
  const folderName = String(workspace.folderName || '').trim();
  const folderKey = String(workspace.folderKey || '').trim();
  if ((!folderName && !folderKey) || /[/\\]/.test(folderName) || /[/\\]/.test(folderKey)) {
    throw new Error('Invalid personal workspace identity');
  }
  return { kind: 'personal', folderName, folderKey };
}

function createTerminalController(options) {
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const getWorkspaceIdentity = options.getWorkspaceIdentity;
  const settings = options.settings;
  const Transport = options.Transport || TerminalTransport;
  let transport = null;
  let sessionContext = null;

  async function currentCredential() {
    const serverSettings = await settings.readServerSettings();
    const serverKey = serverSettings.ip || '';
    const stored = settings.readAuth().servers[serverKey];
    if (stored && stored.token && (!stored.expiresAt || stored.expiresAt > Date.now())) return stored.token;
    return serverSettings.apiKey || '';
  }

  function currentWindow() {
    const window = getWindow();
    return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : null;
  }

  function assertSender(event) {
    const window = currentWindow();
    if (!window || !event || event.sender !== window.webContents) throw new Error('Terminal request is not from the active workbench');
  }

  function publicContext(context) {
    if (!context) return null;
    return {
      workspaceRoot: context.workspaceRoot,
      workspaceIdentity: context.workspaceIdentity,
      workspaceGeneration: context.workspaceGeneration,
      authEpoch: context.authEpoch
    };
  }

  function send(channel, payload) {
    const window = currentWindow();
    if (!window) return;
    window.webContents.send('terminal:' + channel, Object.assign({}, payload || {}, {
      context: publicContext(sessionContext)
    }));
  }

  function assertCurrentWorkspace(expected) {
    const current = getWorkspaceIdentity();
    if (!current || !current.rootPath) throw new Error('No workspace is open');
    if (!expected || !plainObject(expected)) throw new Error('Terminal workspace context is required');
    const root = String(expected.workspaceRoot || expected.rootPath || '');
    const identity = expected.workspaceIdentity;
    if (root !== current.rootPath || identity !== current.workspaceIdentity) {
      throw new Error('The workspace changed while preparing the cloud terminal');
    }
    return current;
  }

  function ensureTransport(serverSettings) {
    if (transport) return transport;
    transport = new Transport({
      webSocketFactory: createTerminalWebSocketFactory(serverSettings),
      getCredential: currentCredential,
      emit: (channel, payload) => {
        if (channel === 'output') {
          send('output', { sessionId: payload.sessionId, data: String(payload.data || '') });
          return;
        }
        const status = Object.assign({}, payload || {});
        delete status.contextToken;
        send('status', { status });
      }
    });
    return transport;
  }

  function buildContext(value, current) {
    const supplied = plainObject(value.context) ? value.context : {};
    return Object.freeze({
      workspaceRoot: current.rootPath,
      workspaceIdentity: current.workspaceIdentity,
      workspaceGeneration: Number.isInteger(supplied.workspaceGeneration) ? supplied.workspaceGeneration : 0,
      authEpoch: Number.isInteger(supplied.authEpoch) ? supplied.authEpoch : 0
    });
  }

  async function start(event, payload) {
    assertSender(event);
    const value = plainObject(payload) ? payload : {};
    const current = assertCurrentWorkspace(value.context);
    const runtimeId = String(value.runtimeId || '').trim();
    if (!runtimeId || runtimeId.toLowerCase() === 'local') throw new Error('A Docker runtime is required for the cloud terminal');
    const serverSettings = await settings.readServerSettings();
    if (!serverSettings.ip) throw new Error('Server address is not configured');
    const context = buildContext(value, current);
    const workspace = cleanRendererWorkspace(value.workspace);
    sessionContext = context;
    try {
      const terminalEndpoint = serverEndpoint(serverSettings, 'ws');
      const result = await ensureTransport(serverSettings).start({
        serverHost: terminalEndpoint,
        runtimeId,
        workspace,
        cols: boundedInteger(value.cols, 120),
        rows: boundedInteger(value.rows, 32),
        localContext: context,
        verifyPeer: (socket) => createTerminalPeerVerifier(serverSettings)(socket, terminalEndpoint)
      });
      return Object.assign({}, result, { context: publicContext(context) });
    } catch (error) {
      if (sessionContext === context) sessionContext = null;
      throw error;
    }
  }

  function assertLiveSession(event) {
    assertSender(event);
    const snapshot = transport && transport.snapshot();
    if (!transport || !sessionContext || !snapshot || snapshot.state !== 'ready') throw new Error('Cloud terminal is offline');
    const current = getWorkspaceIdentity();
    if (!current || current.rootPath !== sessionContext.workspaceRoot || current.workspaceIdentity !== sessionContext.workspaceIdentity) {
      void stop('workspace-changed');
      throw new Error('The workspace changed while the cloud terminal was active');
    }
    return transport;
  }

  async function stop(reason) {
    const active = transport;
    if (!active) return { state: 'idle' };
    try {
      return await active.stop(String(reason || 'stop'));
    } finally {
      sessionContext = null;
    }
  }

  function registerIpc() {
    ipcMain.handle('terminal:start', start);
    ipcMain.handle('terminal:write', async (event, data) => {
      const active = assertLiveSession(event);
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_STDIN_CHARS || Buffer.byteLength(data, 'utf8') > MAX_STDIN_BYTES) {
        throw new Error('Terminal input is invalid or too large');
      }
      return active.write(data);
    });
    ipcMain.handle('terminal:resize', async (event, payload) => {
      const active = assertLiveSession(event);
      const value = plainObject(payload) ? payload : {};
      const cols = boundedInteger(value.cols, 0);
      const rows = boundedInteger(value.rows, 0);
      if (!cols || !rows) throw new Error('Terminal size is invalid');
      return active.resize(cols, rows);
    });
    ipcMain.handle('terminal:stop', async (event, reason) => {
      assertSender(event);
      return stop(reason);
    });
    ipcMain.handle('terminal:status', async (event) => {
      assertSender(event);
      const status = transport ? transport.snapshot() : { state: 'idle' };
      delete status.contextToken;
      return Object.assign({}, status, { context: publicContext(sessionContext) });
    });
  }

  async function dispose() {
    const active = transport;
    try {
      if (active) await active.dispose();
    } finally {
      sessionContext = null;
      transport = null;
    }
  }

  return {
    registerIpc,
    dispose,
    stop,
    snapshot: () => transport ? transport.snapshot() : { state: 'idle' }
  };
}

module.exports = { createTerminalController, cleanRendererWorkspace, boundedInteger };
