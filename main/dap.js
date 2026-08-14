'use strict';

const fs = require('fs');
const path = require('path');
const { DapTransport } = require('../dap-transport');
const {
  readLaunchConfigurations,
  resolveLaunchConfiguration
} = require('./dap-config');

const MAX_VARIABLE_NAME_CHARS = 1024;
const MAX_VARIABLE_VALUE_CHARS = 16384;
const MAX_OUTPUT_EVENT_CHARS = 65536;

function truncateDisplayText(value, maxChars) {
  const text = String(value == null ? '' : value);
  return text.length > maxChars
    ? { value: text.slice(0, maxChars) + '...', truncated: true }
    : { value: text, truncated: false };
}

function sanitizeVariable(variable) {
  const source = variable && typeof variable === 'object' ? variable : {};
  const name = truncateDisplayText(source.name, MAX_VARIABLE_NAME_CHARS);
  const value = truncateDisplayText(source.value, MAX_VARIABLE_VALUE_CHARS);
  const type = truncateDisplayText(source.type, MAX_VARIABLE_NAME_CHARS);
  return Object.assign({}, source, {
    name: name.value,
    value: value.value,
    type: type.value,
    __bobocloudTruncated: { name: name.truncated, value: value.truncated, type: type.truncated }
  });
}

function sanitizeRendererMessage(payload) {
  const message = payload && payload.message;
  if (!message || message.type !== 'event' || message.event !== 'output' || !message.body) return payload;
  const output = truncateDisplayText(message.body.output, MAX_OUTPUT_EVENT_CHARS);
  return Object.assign({}, payload, {
    message: Object.assign({}, message, {
      body: Object.assign({}, message.body, { output: output.value, __bobocloudTruncated: output.truncated })
    })
  });
}

function createDapController(options) {
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const getWorkspaceIdentity = options.getWorkspaceIdentity;
  const settings = options.settings;
  let transport = null;
  let sessionContext = null;

  async function currentCredential() {
    const serverSettings = await settings.readServerSettings();
    const serverKey = serverSettings.ip || '';
    const stored = settings.readAuth().servers[serverKey];
    if (stored && stored.token && (!stored.expiresAt || stored.expiresAt > Date.now())) return stored.token;
    return serverSettings.apiKey || '';
  }

  function send(channel, payload) {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const value = Object.assign({}, payload);
    const contextToken = value.contextToken || (value.status && value.status.contextToken);
    const boundContext = contextToken && typeof contextToken === 'object'
      ? Object.assign({}, contextToken)
      : null;
    delete value.contextToken;
    if (value.status && typeof value.status === 'object') {
      value.status = Object.assign({}, value.status);
      delete value.status.contextToken;
    }
    window.webContents.send('dap:' + channel, Object.assign(value, { context: boundContext }));
  }

  function ensureTransport() {
    if (transport) return transport;
    transport = new DapTransport({
      getCredential: currentCredential,
      emit: (channel, payload) => {
        if (channel === 'message') send('message', sanitizeRendererMessage(payload));
        else send('status', { status: payload });
      }
    });
    return transport;
  }

  function assertCurrentWorkspace(expected) {
    const current = getWorkspaceIdentity();
    if (!current || !current.rootPath) throw new Error('No workspace is open');
    if (expected && (expected.workspaceRoot !== current.rootPath || expected.workspaceIdentity !== current.workspaceIdentity)) {
      throw new Error('The workspace changed while preparing the debug session');
    }
    return current;
  }

  async function listConfigurations() {
    const current = getWorkspaceIdentity();
    if (!current || !current.rootPath) return { workspaceRoot: '', configurations: [], warnings: [], sources: [] };
    return readLaunchConfigurations(current.rootPath);
  }

  function registerIpc() {
    ipcMain.handle('dap:configurations', async () => listConfigurations());
    ipcMain.handle('dap:resolve', async (_event, payload) => {
      const value = payload && typeof payload === 'object' ? payload : {};
      const current = assertCurrentWorkspace(value.context);
      const configurations = readLaunchConfigurations(current.rootPath);
      return resolveLaunchConfiguration(configurations, String(value.id || ''), value.context || {});
    });
    ipcMain.handle('dap:ensure-configuration', async () => {
      const current = assertCurrentWorkspace();
      const directory = path.join(current.rootPath, '.vscode');
      const filePath = path.join(directory, 'launch.json');
      await fs.promises.mkdir(directory, { recursive: true });
      if (!fs.existsSync(filePath)) {
        await fs.promises.writeFile(filePath, '{\n  "version": "0.2.0",\n  "configurations": []\n}\n', 'utf8');
      }
      return filePath;
    });
    ipcMain.handle('dap:start', async (_event, payload) => {
      const value = payload && typeof payload === 'object' ? payload : {};
      const current = assertCurrentWorkspace(value.context);
      const serverSettings = await settings.readServerSettings();
      if (!serverSettings.ip) throw new Error('Server address is not configured');
      const localContext = {
        workspaceRoot: current.rootPath,
        workspaceIdentity: current.workspaceIdentity,
        workspaceGeneration: Number(value.context && value.context.workspaceGeneration) || 0,
        authEpoch: Number(value.context && value.context.authEpoch) || 0,
        clientSessionId: String(value.context && value.context.clientSessionId || '')
      };
      sessionContext = localContext;
      try {
        const status = await ensureTransport().start({
          serverHost: serverSettings.ip,
          languageId: value.languageId,
          runtimeId: value.runtimeId,
          workspace: value.workspace,
          localContext
        });
        const publicStatus = Object.assign({}, status);
        delete publicStatus.contextToken;
        return { status: publicStatus, context: Object.assign({}, localContext) };
      } catch (error) {
        if (sessionContext === localContext) sessionContext = null;
        if (error && error.code) {
          return {
            status: { state: 'error', code: String(error.code), error: String(error.message || '') },
            context: Object.assign({}, localContext)
          };
        }
        throw error;
      }
    });
    ipcMain.handle('dap:request', async (_event, payload) => {
      if (!payload || typeof payload.command !== 'string') throw new Error('Invalid DAP request');
      const command = payload.command;
      const args = payload.arguments && typeof payload.arguments === 'object' ? Object.assign({}, payload.arguments) : {};
      if (command === 'evaluate') {
        const body = await ensureTransport().request(command, args, payload.timeoutMs);
        const result = truncateDisplayText(body && body.result, MAX_VARIABLE_VALUE_CHARS);
        const type = truncateDisplayText(body && body.type, MAX_VARIABLE_NAME_CHARS);
        return Object.assign({}, body, {
          result: result.value,
          type: type.value,
          __bobocloudTruncated: { result: result.truncated, type: type.truncated }
        });
      }
      if (command !== 'variables') return ensureTransport().request(command, args, payload.timeoutMs);
      const requestedStart = Math.max(0, Number.isFinite(args.start) ? Math.floor(args.start) : 0);
      const requestedCount = Math.max(1, Math.min(200, Number.isFinite(args.count) ? Math.floor(args.count) : 200));
      args.start = requestedStart;
      args.count = requestedCount;
      const body = await ensureTransport().request(command, args, payload.timeoutMs);
      const received = body && Array.isArray(body.variables) ? body.variables : [];
      return Object.assign({}, body, {
        variables: received.slice(0, requestedCount).map(sanitizeVariable),
        __bobocloudPage: {
          start: requestedStart,
          count: requestedCount,
          adapterIgnoredCount: received.length > requestedCount,
          hasMore: received.length >= requestedCount
        }
      });
    });
    ipcMain.handle('dap:respond', async (_event, payload) => {
      if (!payload || !payload.request) throw new Error('Invalid DAP response');
      return ensureTransport().respond(payload.request, payload.success, payload.body, payload.message);
    });
    ipcMain.handle('dap:stop', async (_event, reason) => {
      const result = transport ? await transport.stop(String(reason || 'stop')) : { state: 'idle' };
      sessionContext = null;
      return result;
    });
    ipcMain.handle('dap:status', async () => {
      const status = transport ? transport.snapshot() : { state: 'idle' };
      const publicStatus = Object.assign({}, status);
      delete publicStatus.contextToken;
      return publicStatus;
    });
  }

  async function dispose() {
    if (transport) await transport.dispose();
    transport = null;
    sessionContext = null;
  }

  return { registerIpc, dispose, listConfigurations };
}

module.exports = { createDapController, truncateDisplayText, sanitizeVariable, sanitizeRendererMessage };
