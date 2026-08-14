#!/usr/bin/env node

const url = process.env.BOBO_DAP_URL || 'ws://127.0.0.1:3101/dap';
const token = process.env.BOBO_DAP_TOKEN || '';
const folderKey = process.env.BOBO_DAP_FOLDER || 'test-cancel2';
const runtimeId = process.env.BOBO_DAP_RUNTIME || 'python:3.11';
const languageId = process.env.BOBO_DAP_LANGUAGE || 'python';
const program = process.env.BOBO_DAP_PROGRAM || '/workspace/loop.py';
const sourcePath = process.env.BOBO_DAP_SOURCE || program;
const breakpointLine = Number(process.env.BOBO_DAP_LINE || 2);
const expectedVariable = process.env.BOBO_DAP_VARIABLE === undefined
  ? 'i'
  : process.env.BOBO_DAP_VARIABLE;
const timeoutMs = Number(process.env.BOBO_DAP_TIMEOUT_MS || 60000);

if (typeof WebSocket !== 'function') throw new Error('Node.js 22 or newer is required');
if (!token) throw new Error('BOBO_DAP_TOKEN is required');

const socket = new WebSocket(url);
const queued = [];
const waiters = [];
let sequence = 0;

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

async function request(command, args = {}, timeout = timeoutMs) {
  const seq = ++sequence;
  send({ seq, type: 'request', command, arguments: args });
  const response = await waitFor(
    (message) => message.type === 'response' && message.request_seq === seq,
    `${command} response`,
    timeout,
  );
  if (!response.success) throw new Error(`${command} failed: ${response.message || 'unknown error'}`);
  return response.body || {};
}

socket.addEventListener('message', (event) => {
  try {
    const message = JSON.parse(String(event.data));
    if (message.type === 'dap.error') {
      fail(new Error(`${message.code || 'dap_error'}: ${message.message || 'unknown error'}`));
      return;
    }
    if (message.type === 'request') {
      send({
        seq: ++sequence,
        type: 'response',
        request_seq: message.seq,
        command: message.command || '',
        success: false,
        message: 'Reverse requests are not supported by this smoke client',
      });
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
  type: 'dap.start',
  token,
  runtimeId,
  languageId,
  workspace: { kind: 'personal', folderKey },
});
const ready = await waitFor((message) => message.type === 'dap.ready', 'dap.ready');
if (!ready.adapter || ready.adapter.runtimeId !== runtimeId) throw new Error('Unexpected DAP adapter');

await request('initialize', {
  clientID: 'bobocloud-live-smoke',
  clientName: 'BOBOCLOUD live smoke',
  adapterID: languageId,
  pathFormat: 'path',
  linesStartAt1: true,
  columnsStartAt1: true,
  supportsVariableType: true,
  supportsVariablePaging: true,
  supportsRunInTerminalRequest: false,
});

const launchArguments = {
  name: 'BOBOCLOUD live smoke',
  request: 'launch',
  type: languageId,
  program,
  cwd: '/workspace',
  console: 'internalConsole',
};
if (languageId === 'python') launchArguments.justMyCode = true;
if (languageId === 'go') {
  launchArguments.mode = 'debug';
  launchArguments.outputMode = 'remote';
}
const launch = request('launch', launchArguments, 60000);
await waitFor((message) => message.type === 'event' && message.event === 'initialized', 'initialized');
const breakpointBody = await request('setBreakpoints', {
  source: { name: sourcePath.split('/').pop(), path: sourcePath },
  breakpoints: [{ line: breakpointLine }],
  sourceModified: false,
});
if (!breakpointBody.breakpoints || breakpointBody.breakpoints.length !== 1) {
  throw new Error('Adapter did not accept the breakpoint');
}
await request('configurationDone');
await launch;

const stopped = await waitFor(
  (message) => message.type === 'event' && message.event === 'stopped',
  'breakpoint stop',
);
if (stopped.body?.reason !== 'breakpoint') throw new Error(`Unexpected stop reason: ${stopped.body?.reason}`);
const threads = await request('threads');
const threadId = stopped.body?.threadId || threads.threads?.[0]?.id;
if (!threadId) throw new Error('Adapter returned no stopped thread');
const stack = await request('stackTrace', { threadId, startFrame: 0, levels: 20 });
const frame = stack.stackFrames?.[0];
if (!frame || frame.line !== breakpointLine) throw new Error('Adapter stopped on the wrong source line');
const scopes = await request('scopes', { frameId: frame.id });
const variables = [];
for (const scope of scopes.scopes || []) {
  if (!scope.variablesReference) continue;
  const page = await request('variables', { variablesReference: scope.variablesReference, start: 0, count: 200 });
  variables.push(...(page.variables || []));
}
if (expectedVariable && !variables.some((variable) => variable.name === expectedVariable)) {
  throw new Error(`Expected variable was not available: ${expectedVariable}`);
}

await request('next', { threadId });
await waitFor((message) => message.type === 'event' && message.event === 'stopped', 'step stop');
try {
  await request('disconnect', { terminateDebuggee: true }, 10000);
} catch (error) {
  if (socket.readyState === WebSocket.OPEN) throw error;
}
if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'smoke complete');

console.log(JSON.stringify({
  success: true,
  adapter: ready.adapter.id,
  runtimeId,
  breakpointLine,
  expectedVariable: expectedVariable || null,
  stackFrames: stack.stackFrames.length,
  variables: variables.length,
}));
