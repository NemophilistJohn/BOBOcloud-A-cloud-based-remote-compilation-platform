'use strict';

const path = require('node:path');
const { endpoint } = require('./server-transport');
const { credentialForServer } = require('./server-identity');
const { createCloudWebSocketFactory, createCloudPeerVerifier } = require('./cloud-websocket');
const { readTeamMapping } = require('./team-mapping');
const { cleanSetupCommands } = require('../terminal-transport');

const MAX_CODE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 240000;
const ERROR_CODES = new Set([
  'disabled', 'invalid_start', 'unauthorized', 'invalid_runtime', 'workspace_denied',
  'workspace_in_use', 'workspace_missing', 'dependencies_unavailable', 'container_unavailable',
  'workspace_copy_failed', 'kernel_failed', 'cell_timeout', 'resource_pressure'
]);

function projectKey(root) {
  const normalized = root.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  return 'p' + Math.abs(hash).toString(36);
}

function normalizeNotebookOptions(payload, root, filePath) {
  if (!/^python:3\.(9|10|11|12|13)$/.test(payload.runtimeId || '')) throw new Error('invalid_runtime');
  const documentDir = path.relative(root, path.dirname(filePath)).split(path.sep).join('/');
  if (documentDir === '..' || documentDir.startsWith('../') || documentDir.length > 1024) throw new Error('workspace_denied');
  const mapping = readTeamMapping(root, { requireLocalPath: true });
  const workspace = mapping
    ? { kind: 'team', teamId: mapping.teamId, projectId: mapping.projectId, branch: mapping.branch }
    : { kind: 'personal', folderName: path.basename(root), folderKey: projectKey(root) };
  return { runtimeId: payload.runtimeId, setupCommands: cleanSetupCommands(payload.setupCommands), workspace, documentDir };
}

function cleanResult(value, count) {
  if (value?.executionCount !== count || typeof value.ok !== 'boolean' ||
      !Array.isArray(value.outputs) || value.outputs.length > 8) return null;
  const bounded = (text, limit = 25000) => typeof text === 'string' && text.length <= limit;
  const outputs = [];
  for (const item of value.outputs) {
    if (item?.output_type === 'stream' && ['stdout', 'stderr'].includes(item.name) && bounded(item.text)) {
      outputs.push({ output_type: 'stream', name: item.name, text: item.text });
    } else if (item?.output_type === 'execute_result' && bounded(item.data?.['text/plain'])) {
      outputs.push({ output_type: 'execute_result', data: { 'text/plain': item.data['text/plain'] }, execution_count: count, metadata: {} });
    } else if (item?.output_type === 'error' && bounded(item.ename, 256) && bounded(item.evalue, 4096) &&
               Array.isArray(item.traceback) && item.traceback.length === 1 && bounded(item.traceback[0])) {
      outputs.push({ output_type: 'error', ename: item.ename, evalue: item.evalue, traceback: [item.traceback[0]] });
    } else if (item?.output_type === 'display_data' && typeof item.data?.['image/png'] === 'string' &&
               item.data['image/png'].length <= 6 * 1024 * 1024 &&
               /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data['image/png']) &&
               Buffer.from(item.data['image/png'], 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      outputs.push({ output_type: 'display_data', data: { 'image/png': item.data['image/png'] }, metadata: {} });
    } else return null;
  }
  return outputs.some(item => item.output_type === 'error') !== value.ok
    ? { ok: true, cellOk: value.ok, executionCount: count, outputs }
    : null;
}

function createNotebookKernels({ settings, getWorkspaceIdentity, factory = createCloudWebSocketFactory, verifier = createCloudPeerVerifier }) {
  const sessions = new Map();
  const failed = (code) => ({ ok: false, code });

  function forget(session, code = 'kernel_closed') {
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    if (session.pending) {
      clearTimeout(session.pending.timer);
      session.pending.resolve(failed(code));
      session.pending = null;
    }
    if (session.shutdown) {
      clearTimeout(session.shutdown.timer);
      session.shutdown.resolve(failed(code));
      session.shutdown = null;
    }
    try { session.socket?.terminate(); } catch (_) {}
  }

  function close(id) {
    const session = sessions.get(id);
    if (session) forget(session);
  }

  function closeAll() {
    for (const session of sessions.values()) forget(session);
  }

  async function control(document, request) {
    const id = document.id;
    if (request.kind === 'restart') {
      const session = sessions.get(id);
      if (!session?.started) {
        close(id);
        return { ok: true };
      }
      if (session.shutdown) return failed('kernel_busy');
      return new Promise(resolve => {
        const timer = setTimeout(() => forget(session, 'kernel_failed'), 20000);
        timer.unref?.();
        session.shutdown = { resolve, timer };
        if (session.pending) {
          clearTimeout(session.pending.timer);
          session.pending.resolve(failed('kernel_closed'));
          session.pending = null;
        }
        try { session.socket.send(JSON.stringify({ type: 'notebook.shutdown' })); }
        catch (_) { forget(session, 'kernel_failed'); }
      });
    }
    if (request.kind !== 'execute' || typeof request.code !== 'string' ||
        Buffer.byteLength(request.code) > MAX_CODE_BYTES) return failed('invalid_cell');
    const identity = getWorkspaceIdentity();
    if (!identity?.rootPath || identity.workspaceIdentity !== document.workspaceIdentity) return failed('kernel_closed');
    let options;
    try { options = normalizeNotebookOptions(request, identity.rootPath, document.filePath); }
    catch (error) { return failed(ERROR_CODES.has(error.message) ? error.message : 'invalid_start'); }
    const signature = JSON.stringify(options);
    let session = sessions.get(id);
    if (session?.pending || session?.shutdown) return failed('kernel_busy');
    if (session && session.signature !== signature) {
      forget(session);
      return failed('kernel_closed');
    }
    if (!session) {
      if (sessions.size >= 8) return failed('resource_pressure');
      session = { id, signature, socket: null, count: 0, pending: null };
      sessions.set(id, session);
    }
    const expected = session;
    const next = session.count + 1;
    const operation = new Promise(resolve => {
      const timer = setTimeout(() => forget(expected, 'kernel_failed'), REQUEST_TIMEOUT_MS);
      timer.unref?.();
      expected.pending = { resolve, timer, next };
    });
    const send = () => expected.socket.send(JSON.stringify({ type: 'notebook.execute', id: next, code: request.code }));
    if (expected.socket) {
      try { send(); } catch (_) { forget(expected, 'kernel_failed'); }
      return operation;
    }
    void (async () => {
      try {
        const prefs = await settings.readServerSettings();
        if (sessions.get(id) !== expected) return;
        const base = endpoint(prefs, 'http');
        if (!base) { forget(expected, 'not_configured'); return; }
        const stored = credentialForServer(settings.readAuth(), prefs).credential;
        const token = (stored?.token && (!stored.expiresAt || stored.expiresAt > Date.now()) ? stored.token : prefs.apiKey) || '';
        if (!token) { forget(expected, 'unauthorized'); return; }
        const url = new URL('/notebook', base);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = factory(prefs, { maxPayload: MAX_RESULT_BYTES })(url.toString());
        expected.socket = socket;
        socket.on('error', () => forget(expected, 'network_error'));
        socket.on('close', () => forget(expected, 'kernel_closed'));
        socket.once('open', () => {
          if (sessions.get(id) !== expected) return;
          try {
            verifier(prefs)(socket, url.toString());
            socket.send(JSON.stringify({ type: 'notebook.start', protocol: 1, token, ...options }));
            send();
            expected.started = true;
          } catch (_) { forget(expected, 'network_error'); }
        });
        socket.on('message', (data) => {
          if (sessions.get(id) !== expected) return;
          try {
            if (data.length > MAX_RESULT_BYTES) throw new Error();
            const message = JSON.parse(data);
            if (expected.shutdown) {
              if (message?.type === 'notebook.stopped') {
                const { resolve, timer } = expected.shutdown;
                expected.shutdown = null;
                clearTimeout(timer);
                forget(expected);
                resolve({ ok: true });
              }
              return;
            }
            if (message?.type === 'notebook.error' && ERROR_CODES.has(message.code)) {
              forget(expected, message.code);
              return;
            }
            const pending = expected.pending;
            const result = message?.type === 'notebook.result' && pending && message.id === pending.next
              ? cleanResult(message.result, pending.next) : null;
            if (!result) throw new Error();
            expected.count = pending.next;
            expected.pending = null;
            clearTimeout(pending.timer);
            pending.resolve(result);
          } catch (_) { forget(expected, 'kernel_failed'); }
        });
      } catch (_) { forget(expected, 'network_error'); }
    })();
    return operation;
  }

  return { control, close, closeAll };
}

module.exports = { createNotebookKernels };
