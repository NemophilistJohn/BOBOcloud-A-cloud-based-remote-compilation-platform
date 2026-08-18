'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TerminalTransport, normalizeTerminalUrl } = require('../terminal-transport');

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
  close() {
    this.closed = true;
    this.readyState = 3;
    this.fire('close', {});
  }
  open() {
    this.readyState = 1;
    this.fire('open', {});
  }
  fire(type, value) {
    for (const listener of this.listeners.get(type) || []) {
      listener(type === 'message' ? { data: value } : value);
    }
  }
}

class EmitterSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
}

test('normalizes the terminal endpoint without exposing the HTTP route', () => {
  assert.equal(normalizeTerminalUrl('cloud.example'), 'ws://cloud.example:3101/terminal');
  assert.equal(normalizeTerminalUrl('https://cloud.example:8443/base?q=1'), 'wss://cloud.example:8443/terminal');
});

test('starts an authenticated terminal session and streams binary output losslessly', async () => {
  const events = [];
  let socket;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: async () => 'secret-token',
    emit: (channel, payload) => events.push({ channel, payload }),
    pingIntervalMs: 0
  });
  const started = transport.start({
    serverHost: 'https://cloud.example:3101',
    runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    cols: 100,
    rows: 28,
    localContext: { workspaceIdentity: 3 }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent[0], {
    type: 'terminal.start', protocol: 1, token: 'secret-token', runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' }, cols: 100, rows: 28
  });
  socket.fire('message', JSON.stringify({
    type: 'terminal.ready', sessionId: 'term-1', runtimeId: 'python:3.12', snapshot: true,
    capabilities: { tty: true, resize: true, isolatedWorkspace: true }
  }));
  assert.deepEqual(await started, {
    sessionId: 'term-1', runtimeId: 'python:3.12', snapshot: true, limits: null,
    capabilities: { tty: true, resize: true, isolatedWorkspace: true }
  });

  const bytes = Buffer.from('你好 \x1b[31mred\x1b[0m', 'utf8');
  socket.fire('message', JSON.stringify({ type: 'terminal.output', stream: 'stdout', encoding: 'base64', data: bytes.subarray(0, 2).toString('base64') }));
  socket.fire('message', JSON.stringify({ type: 'terminal.output', stream: 'stdout', encoding: 'base64', data: bytes.subarray(2).toString('base64') }));
  assert.equal(events.filter((event) => event.channel === 'output').map((event) => event.payload.data).join(''), '你好 \x1b[31mred\x1b[0m');

  transport.write('echo hi\r');
  transport.resize(120, 40);
  assert.deepEqual(socket.sent.slice(1), [
    { type: 'terminal.stdin', data: 'echo hi\r' },
    { type: 'terminal.resize', cols: 120, rows: 40 }
  ]);
  await transport.stop('test');
});

test('rejects Local runtime and stale input without opening a general command channel', async () => {
  const transport = new TerminalTransport({ webSocketFactory: () => new MockSocket(), pingIntervalMs: 0 });
  await assert.rejects(
    transport.start({ serverHost: 'cloud.example', runtimeId: 'Local', workspace: { kind: 'personal', folderKey: 'demo' } }),
    /Docker runtime/
  );
  assert.throws(() => transport.write('echo unsafe'), /offline/);
});

test('uses the server byte limit for multibyte terminal input', async () => {
  let socket;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new MockSocket()), getCredential: () => 'token', pingIntervalMs: 0
  });
  const starting = transport.start({ serverHost: 'cloud.example', runtimeId: 'python:3.12', workspace: { kind: 'personal', folderKey: 'demo' } });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', JSON.stringify({ type: 'terminal.ready', sessionId: 'term-2', capabilities: { resize: false } }));
  await starting;
  assert.throws(() => transport.write('你'.repeat(6000)), /too large/);
  assert.equal(socket.sent.length, 1, 'oversized text must not be forwarded to the server');
  await transport.stop('test');
});

test('cancelling a connecting session settles the original start promise', async () => {
  let socket;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: () => 'token',
    pingIntervalMs: 0
  });
  const pending = transport.start({ serverHost: 'cloud.example', runtimeId: 'python:3.12', workspace: { kind: 'personal', folderKey: 'demo' } });
  await transport.stop('workspace-changed');
  await assert.rejects(pending, (error) => error && error.code === 'start_cancelled');
  assert.equal(socket.closed, true);
  assert.equal(transport.snapshot().state, 'idle');
});

test('EventEmitter WebSockets verify a pinned peer before terminal credentials are sent', async () => {
  let socket;
  let credentialCalls = 0;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new EmitterSocket()),
    getCredential: async () => { credentialCalls += 1; return 'secret-token'; },
    pingIntervalMs: 0
  });
  const pending = transport.start({
    serverHost: 'https://cloud.example:3101', runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderKey: 'demo' },
    verifyPeer: async () => {
      const error = new Error('certificate mismatch');
      error.code = 'certificate_mismatch';
      throw error;
    }
  });
  socket.open();
  await assert.rejects(pending, (error) => error && error.code === 'certificate_mismatch');
  assert.equal(credentialCalls, 0);
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closed, true);
});
