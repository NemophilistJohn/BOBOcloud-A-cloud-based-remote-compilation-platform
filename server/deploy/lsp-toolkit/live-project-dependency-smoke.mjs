#!/usr/bin/env node

const url = process.env.BOBO_LSP_URL || 'ws://127.0.0.1:3100/lsp';
const token = process.env.BOBO_LSP_TOKEN || '';
const folderName = process.env.BOBO_LSP_FOLDER_NAME || 'tryjava';
const folderKey = process.env.BOBO_LSP_FOLDER_KEY || 'pqwvdum';
const runtimeId = process.env.BOBO_LSP_RUNTIME || 'python:3.10';
const languageId = process.env.BOBO_LSP_LANGUAGE || 'python';
const fileName = process.env.BOBO_LSP_FILE || 'gd_descent_animation.py';
const timeoutMs = Number(process.env.BOBO_LSP_TIMEOUT_MS || 60000);
const holdMs = Number(process.env.BOBO_LSP_HOLD_MS || 0);
const source = process.env.BOBO_LSP_SOURCE || 'import numpy as np\nimport matplotlib.pyplot as plt\n';
const expectedImports = (process.env.BOBO_LSP_EXPECT_IMPORTS || 'numpy,matplotlib')
  .split(',').map((value) => value.trim()).filter(Boolean);

if (typeof WebSocket !== 'function') throw new Error('Node.js 22 or newer is required');
if (!token) throw new Error('BOBO_LSP_TOKEN is required');

const socket = new WebSocket(url);
const queued = [];
const waiters = [];
let nextId = 0;
let dependency = null;
let latestDiagnostics = null;

function fail(error) {
  while (waiters.length) {
    const waiter = waiters.shift();
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function dispatch(message) {
  const index = waiters.findIndex((waiter) => waiter.predicate(message));
  if (index < 0) {
    queued.push(message);
    return;
  }
  const [waiter] = waiters.splice(index, 1);
  clearTimeout(waiter.timer);
  waiter.resolve(message);
}

function waitFor(predicate, label, timeout = timeoutMs) {
  const index = queued.findIndex(predicate);
  if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const position = waiters.indexOf(waiter);
      if (position >= 0) waiters.splice(position, 1);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeout);
    waiters.push(waiter);
  });
}

function send(message) {
  socket.send(JSON.stringify(message));
}

function request(method, params) {
  const id = ++nextId;
  send({ jsonrpc: '2.0', id, method, params });
  return waitFor(
    (message) => message.id === id && (message.result !== undefined || message.error),
    `${method} response`,
  ).then((message) => {
    if (message.error) throw new Error(`${method} failed: ${message.error.message || 'unknown error'}`);
    return message.result;
  });
}

function configurationSection(configuration, section) {
  if (!configuration || typeof configuration !== 'object' || !section) return null;
  if (Object.prototype.hasOwnProperty.call(configuration, section)) return configuration[section];
  let current = configuration;
  for (const part of String(section).split('.')) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return null;
    current = current[part];
  }
  return current === undefined ? null : current;
}

function answerServerRequest(message) {
  let result;
  switch (message.method) {
    case 'workspace/configuration':
      result = (message.params?.items || []).map((item) => configurationSection(dependency?.configuration, item?.section));
      break;
    case 'workspace/workspaceFolders':
      result = [{ uri: 'bobocloud-lsp:///', name: folderName }];
      break;
    case 'window/workDoneProgress/create':
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'workspace/semanticTokens/refresh':
    case 'workspace/inlayHint/refresh':
    case 'workspace/codeLens/refresh':
    case 'workspace/diagnostic/refresh':
      result = null;
      break;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported smoke-client method' } });
      return;
  }
  send({ jsonrpc: '2.0', id: message.id, result });
}

socket.addEventListener('message', (event) => {
  try {
    const message = JSON.parse(String(event.data));
    if (message.type === 'lsp.error') {
      fail(new Error(`${message.code || 'lsp_error'}: ${message.message || 'unknown error'}`));
      return;
    }
    if (message.type === 'lsp.ready') dependency = message.dependency || null;
    if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri === `bobocloud-lsp:///${fileName}`) {
      latestDiagnostics = message.params.diagnostics || [];
    }
    if (message.method && message.id !== undefined) {
      answerServerRequest(message);
      return;
    }
    dispatch(message);
  } catch (error) {
    fail(error);
  }
});
socket.addEventListener('error', () => fail(new Error('WebSocket connection failed')));
socket.addEventListener('close', () => fail(new Error('WebSocket closed unexpectedly')));

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out opening WebSocket')), 10000);
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    reject(new Error('Could not open WebSocket'));
  }, { once: true });
});

send({
  type: 'lsp.start', token, mode: 'standard', languageId, runtimeId,
  workspace: { kind: 'personal', folderName, folderKey },
});
const ready = await waitFor((message) => message.type === 'lsp.ready', 'lsp.ready');
if (!ready.sessionId) throw new Error('Gateway did not create an LSP session');
if (!dependency || !['ready', 'mixed'].includes(String(dependency.status || '').toLowerCase())) {
  throw new Error(`Project dependency view is not ready: ${dependency?.status || 'missing'}`);
}

await request('initialize', {
  processId: null,
  clientInfo: { name: 'bobocloud-live-project-dependency-smoke', version: '1' },
  rootUri: 'bobocloud-lsp:///',
  workspaceFolders: [{ uri: 'bobocloud-lsp:///', name: folderName }],
  capabilities: {
    workspace: { configuration: true, workspaceFolders: true },
    textDocument: { publishDiagnostics: { relatedInformation: true } },
  },
});
send({ jsonrpc: '2.0', method: 'initialized', params: {} });
send({
  jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
    textDocument: { uri: `bobocloud-lsp:///${fileName}`, languageId, version: 1, text: source },
  },
});
await waitFor(
  (message) => message.method === 'textDocument/publishDiagnostics' && message.params?.uri === `bobocloud-lsp:///${fileName}`,
  'publishDiagnostics',
);
await new Promise((resolve) => setTimeout(resolve, 1500));

const diagnostics = latestDiagnostics || [];
const unresolved = diagnostics.filter((diagnostic) => {
  const message = String(diagnostic?.message || '').toLowerCase();
  return expectedImports.some((name) => message.includes(name.toLowerCase())) &&
    (message.includes('could not be resolved') || message.includes('unresolved import'));
});
if (unresolved.length) {
  throw new Error(`Installed imports remain unresolved: ${unresolved.map((item) => item.message).join('; ')}`);
}

if (Number.isFinite(holdMs) && holdMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, holdMs));
}

try {
  await request('shutdown', null);
  send({ jsonrpc: '2.0', method: 'exit', params: null });
} finally {
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'smoke complete');
}

console.log(JSON.stringify({
  success: true,
  runtimeId,
  languageId,
  dependencyStatus: dependency.status,
  dependencyRevision: dependency.revision || '',
  diagnostics: diagnostics.length,
  unresolvedImports: unresolved.length,
}));
