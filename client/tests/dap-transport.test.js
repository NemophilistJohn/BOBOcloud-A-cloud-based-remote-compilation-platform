'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DapTransport, normalizeDapUrl, normalizeDapChildUrl } = require('../dap-transport');
const {
  BUILTIN_CONFIGURATION_ID,
  readLaunchConfigurations,
  resolveLaunchConfiguration,
  adapterTypeForLanguage
} = require('../main/dap-config');
const { truncateDisplayText, sanitizeVariable, sanitizeRendererMessage } = require('../main/dap');

class MockSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; this.readyState = 3; this.fire('close', {}); }
  fire(type, value) {
    for (const listener of this.listeners.get(type) || []) listener(type === 'message' ? { data: JSON.stringify(value) } : value);
  }
  open() { this.readyState = 1; this.fire('open', {}); }
}

function ready(socket, extra = {}) {
  socket.fire('message', Object.assign({
    type: 'dap.ready',
    sessionId: 'session-1',
    adapter: { id: 'python-debugpy', label: 'Python', languageId: 'python', runtimeId: 'python:3.11' },
    capabilities: { supportsLaunch: true }
  }, extra));
}

test('normalizes DAP endpoint without replacing an explicit reverse-proxy port', () => {
  assert.equal(normalizeDapUrl('example.test'), 'ws://example.test:3100/dap');
  assert.equal(normalizeDapUrl('https://example.test:8443/base?q=1'), 'wss://example.test:8443/dap');
  assert.equal(normalizeDapChildUrl('https://example.test:8443/base?q=1', 3102), 'wss://example.test:3102/dap-child');
});

test('routes js-debug target requests through a ticket-bound child WebSocket', async () => {
  const sockets = [];
  const transport = new DapTransport({
    webSocketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token'
  });
  const starting = transport.start({
    serverHost: 'https://cloud.test:3100', childPort: 3102, languageId: 'node', runtimeId: 'node:22',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  sockets[0].open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(sockets[0], { adapter: { id: 'node-js-debug', languageId: 'node', runtimeId: 'node:22', supportsChildSessions: true } });
  await starting;
  const initialized = transport.request('initialize', { clientID: 'test', supportsVariablePaging: true });
  sockets[0].fire('message', { seq: 1, type: 'response', request_seq: 1, command: 'initialize', success: true, body: {} });
  await initialized;
  const launch = transport.request('launch', { type: 'pwa-node', request: 'launch', program: '/workspace/app.js' });
  sockets[0].fire('message', {
    type: 'dap.child', ticket: 'one-use-ticket', request: {
      seq: 90, type: 'request', command: 'startDebugging',
      arguments: { configuration: { type: 'pwa-node', request: 'launch', program: '/workspace/app.js', __pendingTargetId: 'target-1' } }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sockets[1].sent[0], { type: 'dap.child.attach', token: 'token', ticket: 'one-use-ticket' });
  sockets[1].fire('message', { type: 'dap.child.ready', parentSessionId: 'session-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[1].sent[1].command, 'initialize');
  sockets[1].fire('message', { seq: 2, type: 'response', request_seq: 1, command: 'initialize', success: true, body: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[1].sent[2].command, 'launch');
  assert.equal(sockets[1].sent[3].command, 'configurationDone');
  sockets[1].fire('message', { seq: 3, type: 'response', request_seq: 3, command: 'configurationDone', success: true, body: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sockets[0].sent.at(-1), { seq: 3, type: 'response', request_seq: 90, command: 'startDebugging', success: true, body: {} });
  sockets[0].fire('message', { seq: 4, type: 'response', request_seq: 2, command: 'launch', success: true, body: {} });
  await launch;
  const breakpoints = transport.request('setBreakpoints', { source: { path: '/workspace/app.js' }, breakpoints: [] });
  assert.equal(sockets[1].sent.at(-1).command, 'setBreakpoints');
  sockets[1].fire('message', { seq: 4, type: 'response', request_seq: 4, command: 'setBreakpoints', success: true, body: {} });
  await breakpoints;
  await transport.stop('test');
});

test('uses one gateway handshake then exchanges raw DAP messages', async () => {
  const events = [];
  let socket;
  const transport = new DapTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: async () => 'token',
    emit: (channel, value) => events.push({ channel, value })
  });
  const started = transport.start({
    serverHost: 'cloud.test', languageId: 'python', runtimeId: 'python:3.11',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-a1' }
  });
  await Promise.resolve();
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent[0], {
    type: 'dap.start', token: 'token', languageId: 'python', runtimeId: 'python:3.11',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-a1' }
  });
  ready(socket);
  const status = await started;
  assert.equal(status.state, 'ready');

  const pending = transport.request('initialize', { clientID: 'test' });
  assert.deepEqual(socket.sent[1], { seq: 1, type: 'request', command: 'initialize', arguments: { clientID: 'test' } });
  socket.fire('message', { seq: 50, type: 'response', request_seq: 1, command: 'initialize', success: true, body: { supportsConfigurationDoneRequest: true } });
  assert.deepEqual(await pending, { supportsConfigurationDoneRequest: true });
  assert.equal(events.at(-1).value.message.type, 'response');
  assert.equal(events.at(-1).value.generation, status.generation);
});

test('adapter request failures use a stable client error and retain raw details only as protocol data', async () => {
  const events = [];
  let socket;
  const transport = new DapTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: async () => 'token',
    emit: (channel, value) => events.push({ channel, value })
  });
  const started = transport.start({
    serverHost: 'cloud.test', languageId: 'python', runtimeId: 'python:3.11',
    workspace: { kind: 'personal', folderKey: 'demo-a1' }
  });
  await Promise.resolve();
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(socket);
  await started;

  const pending = transport.request('pause', { threadId: 7 });
  socket.fire('message', {
    seq: 51,
    type: 'response',
    request_seq: 1,
    command: 'pause',
    success: false,
    message: 'adapter-specific English detail'
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'DAP_REQUEST_FAILED');
    assert.equal(error.message, 'DAP request failed: pause');
    assert.equal(error.details, 'adapter-specific English detail');
    return true;
  });
  assert.equal(events.at(-1).value.message.message, 'adapter-specific English detail');
});

test('fatal dap.error rejects pending requests and closes an established socket', async () => {
  let socket;
  const transport = new DapTransport({ webSocketFactory: () => (socket = new MockSocket()), getCredential: () => 'token' });
  const starting = transport.start({
    serverHost: 'cloud.test', languageId: 'go', runtimeId: 'go:1.24',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  await Promise.resolve();
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(socket);
  await starting;
  const pending = transport.request('threads', {});
  socket.fire('message', { type: 'dap.error', code: 'ADAPTER_EXITED', message: 'adapter exited' });
  await assert.rejects(pending, /adapter exited/);
  assert.equal(socket.closed, true);
  assert.equal(transport.snapshot().state, 'error');
});

test('terminated followed by socket close is an idle session, not a lost connection', async () => {
  let socket;
  const transport = new DapTransport({ webSocketFactory: () => (socket = new MockSocket()), getCredential: () => '' });
  const starting = transport.start({
    serverHost: 'cloud.test', languageId: 'javascript', runtimeId: 'node:22',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  await Promise.resolve();
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(socket);
  await starting;
  socket.fire('message', { seq: 10, type: 'event', event: 'terminated', body: {} });
  socket.readyState = 3;
  socket.fire('close', {});
  assert.equal(transport.snapshot().state, 'idle');
});

test('request sequence wraps inside signed 32-bit range without reusing a pending id', async () => {
  let socket;
  const transport = new DapTransport({ webSocketFactory: () => (socket = new MockSocket()), getCredential: () => '' });
  const starting = transport.start({
    serverHost: 'cloud.test', languageId: 'python', runtimeId: 'python:3.11',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  await Promise.resolve();
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(socket);
  await starting;
  transport.nextSeq = 0x7fffffff;
  const last = transport.request('threads', {});
  const first = transport.request('stackTrace', { threadId: 1 });
  assert.equal(socket.sent.at(-2).seq, 0x7fffffff);
  assert.equal(socket.sent.at(-1).seq, 1);
  socket.fire('message', { seq: 8, type: 'response', request_seq: 0x7fffffff, command: 'threads', success: true, body: {} });
  socket.fire('message', { seq: 9, type: 'response', request_seq: 1, command: 'stackTrace', success: true, body: {} });
  await Promise.all([last, first]);
});

test('stop settles a DAP start that is still connecting', async () => {
  let socket;
  const transport = new DapTransport({ webSocketFactory: () => (socket = new MockSocket()), getCredential: () => 'token' });
  const starting = transport.start({
    serverHost: 'cloud.test', languageId: 'python', runtimeId: 'python:3.11',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  await transport.stop('workspace-change');
  await assert.rejects(starting, (error) => error.code === 'DAP_START_CANCELLED');
  assert.equal(socket.closed, true);
  assert.equal(transport.snapshot().state, 'idle');
});

test('stop settles a DAP start while the credential provider is pending', async () => {
  let socket;
  let releaseCredential;
  const credential = new Promise((resolve) => { releaseCredential = resolve; });
  const transport = new DapTransport({ webSocketFactory: () => (socket = new MockSocket()), getCredential: () => credential });
  const starting = transport.start({
    serverHost: 'cloud.test', languageId: 'go', runtimeId: 'go:1.24',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  await transport.stop('logout');
  await assert.rejects(starting, (error) => error.code === 'DAP_START_CANCELLED');
  releaseCredential('late-token');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.length, 0);
});

test('a second DAP start cancels the first without cross-wiring sockets', async () => {
  const sockets = [];
  const transport = new DapTransport({ webSocketFactory: () => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket;
  }, getCredential: () => 'token' });
  const first = transport.start({
    serverHost: 'first.test', languageId: 'python', runtimeId: 'python:3.11',
    workspace: { kind: 'personal', folderKey: 'first' }
  });
  const second = transport.start({
    serverHost: 'second.test', languageId: 'node', runtimeId: 'node:22',
    workspace: { kind: 'personal', folderKey: 'second' }
  });
  await assert.rejects(first, (error) => error.code === 'DAP_START_CANCELLED');
  assert.equal(sockets[0].closed, true);
  sockets[1].open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(sockets[1], {
    adapter: { id: 'node-inspector', label: 'Node', languageId: 'node', runtimeId: 'node:22' }
  });
  const status = await second;
  assert.equal(status.adapter.id, 'node-inspector');
  assert.equal(sockets[1].sent[0].workspace.folderKey, 'second');
});

test('late protocol events keep their immutable transport context and cannot enter a replacement session', async () => {
  const sockets = [];
  const messages = [];
  const transport = new DapTransport({
    webSocketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token',
    emit: (channel, payload) => { if (channel === 'message') messages.push(payload); }
  });
  const first = transport.start({
    serverHost: 'cloud.test', languageId: 'python', runtimeId: 'python:3.11',
    workspace: { kind: 'personal', folderKey: 'first' }, localContext: { clientSessionId: 'first' }
  });
  sockets[0].open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(sockets[0]);
  await first;
  const second = transport.start({
    serverHost: 'cloud.test', languageId: 'node', runtimeId: 'node:22',
    workspace: { kind: 'personal', folderKey: 'second' }, localContext: { clientSessionId: 'second' }
  });
  sockets[0].fire('message', { seq: 70, type: 'event', event: 'output', body: { output: 'late' } });
  sockets[1].open();
  await new Promise((resolve) => setImmediate(resolve));
  ready(sockets[1], { adapter: { id: 'node-inspector', languageId: 'node', runtimeId: 'node:22' } });
  await second;
  sockets[1].fire('message', { seq: 71, type: 'event', event: 'output', body: { output: 'current' } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.body.output, 'current');
  assert.deepEqual(messages[0].contextToken, { clientSessionId: 'second' });
});

test('launch configuration parser accepts JSONC and BOBO overrides VS Code by name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-dap-config-'));
  try {
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.mkdirSync(path.join(root, '.bobocloud'));
    fs.writeFileSync(path.join(root, '.vscode', 'launch.json'), `{
      // standard VS Code JSONC
      "version": "0.2.0",
      "configurations": [
        { "name": "Project", "type": "python", "request": "launch", "program": "${'${workspaceFolder}'}/old.py" },
      ]
    }`);
    fs.writeFileSync(path.join(root, '.bobocloud', 'launch.json'), `{
      "version": "0.2.0",
      "configurations": [
        { "name": "Project", "type": "python", "request": "launch", "program": "${'${workspaceFolder}'}/app.py" }
      ]
    }`);
    const parsed = readLaunchConfigurations(root);
    assert.equal(parsed.configurations.length, 1);
    assert.equal(parsed.configurations[0].sourceKind, 'bobocloud');
    assert.equal(parsed.warnings.some((item) => item.code === 'overrides'), true);
    const resolved = resolveLaunchConfiguration(parsed, parsed.configurations[0].id, { languageId: 'python' });
    assert.equal(resolved.configuration.program, '/workspace/app.py');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only file-derived launch variables require an active editor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-dap-file-var-'));
  try {
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.writeFileSync(path.join(root, '.vscode', 'launch.json'), JSON.stringify({
      version: '0.2.0',
      configurations: [{ name: 'File', type: 'python', request: 'launch', program: '${file}' }]
    }));
    const parsed = readLaunchConfigurations(root);
    assert.throws(() => resolveLaunchConfiguration(parsed, parsed.configurations[0].id, {}), /Open a source file/);
    assert.throws(() => resolveLaunchConfiguration(parsed, BUILTIN_CONFIGURATION_ID, { languageId: 'python' }), /Open a source file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported VS Code task and compound features are explicit and non-executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-dap-vscode-subset-'));
  try {
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.writeFileSync(path.join(root, '.vscode', 'launch.json'), JSON.stringify({
      version: '0.2.0',
      inputs: [{ id: 'target', type: 'promptString' }],
      compounds: [{ name: 'All', configurations: ['Project'] }],
      configurations: [{ name: 'Project', type: 'python', request: 'launch', program: '${workspaceFolder}/app.py', preLaunchTask: 'Build' }]
    }));
    const parsed = readLaunchConfigurations(root);
    assert.equal(parsed.configurations[0].executable, false);
    assert.equal(parsed.configurations[0].warnings.some((item) => item.code === 'unsupported-prelaunch-task'), true);
    assert.equal(parsed.warnings.some((item) => item.code === 'unsupported-compounds'), true);
    assert.equal(parsed.warnings.some((item) => item.code === 'unsupported-inputs'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderer-bound DAP text and variable fields are bounded', () => {
  const huge = 'x'.repeat(1000000);
  const text = truncateDisplayText(huge, 100);
  assert.equal(text.truncated, true);
  assert.equal(text.value.length, 103);
  const variable = sanitizeVariable({ name: huge, value: huge, type: huge, variablesReference: 7 });
  assert.equal(variable.name.length, 1027);
  assert.equal(variable.value.length, 16387);
  assert.deepEqual(variable.__bobocloudTruncated, { name: true, value: true, type: true });
  const payload = sanitizeRendererMessage({ message: { type: 'event', event: 'output', body: { output: huge } }, generation: 1 });
  assert.equal(payload.message.body.output.length, 65539);
  assert.equal(payload.message.body.__bobocloudTruncated, true);
});

test('builtin adapter inference only advertises adapters implemented by the first server catalog', () => {
  assert.equal(adapterTypeForLanguage('python'), 'python');
  assert.equal(adapterTypeForLanguage('typescript'), 'node');
  assert.equal(adapterTypeForLanguage('go'), 'go');
  assert.equal(adapterTypeForLanguage('cpp'), '');
  assert.equal(adapterTypeForLanguage('java'), '');
});

test('DAP implementation does not import or instantiate LSP modules', () => {
  for (const file of ['../dap-transport.js', '../main/dap.js', '../main/dap-config.js', '../src/dap-client.js']) {
    const body = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(body, /require\([^)]*lsp|from\s+['"][^'"]*lsp|BOBO\.lsp|S\.lsp/i, file);
  }
});
