'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TerminalTransport, normalizeTerminalUrl, cleanSetupCommands } = require('../terminal-transport');

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

async function stopWithServerExit(transport, socket, reason = 'test') {
  const pending = transport.stop(reason);
  assert.equal(transport.snapshot().state, 'closing');
  assert.equal(socket.closed, false, 'the client must keep the socket open for the cleanup acknowledgement');
  assert.deepEqual(socket.sent.at(-1), { type: 'terminal.close', reason });
  socket.fire('message', JSON.stringify({ type: 'terminal.exit', reason: 'closed', exitCode: 0 }));
  const result = await pending;
  assert.equal(result.confirmed, true);
  assert.equal(result.dependenciesChanged, false);
  assert.equal(result.environmentChanged, false);
  return result;
}

test('normalizes the terminal endpoint without exposing the HTTP route', () => {
  assert.equal(normalizeTerminalUrl('cloud.example'), 'ws://cloud.example:3101/terminal');
  assert.equal(normalizeTerminalUrl('https://cloud.example:8443/base?q=1'), 'wss://cloud.example:8443/terminal');
});

test('bounds and normalizes setup commands used by the project cache digest', () => {
  assert.deepEqual(cleanSetupCommands(['  pip install numpy==2.1.0  ']), ['pip install numpy==2.1.0']);
  assert.throws(() => cleanSetupCommands(Array.from({ length: 65 }, () => 'pip install demo')), /invalid/);
  assert.throws(() => cleanSetupCommands(['pip install demo\nwhoami']), /invalid/);
  assert.throws(() => cleanSetupCommands(['x'.repeat(513)]), /invalid/);
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
    setupCommands: ['  pip install numpy==2.1.0  '],
    cols: 100,
    rows: 28,
    localContext: { workspaceIdentity: 3 }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent[0], {
    type: 'terminal.start', protocol: 1, token: 'secret-token', runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    setupCommands: ['pip install numpy==2.1.0'], cols: 100, rows: 28
  });
  socket.fire('message', JSON.stringify({
    type: 'terminal.ready', sessionId: 'term-1', runtimeId: 'python:3.12', snapshot: true,
    capabilities: { tty: true, resize: true, isolatedWorkspace: true },
    environment: {
      runtimeId: 'python:3.12', displayName: 'Python 3.12', language: 'python', version: '3.12',
      dockerImage: 'python:3.12-slim', workspaceKind: 'personal'
    }
  }));
  assert.deepEqual(await started, {
    sessionId: 'term-1', runtimeId: 'python:3.12', snapshot: true, limits: null,
    capabilities: { tty: true, resize: true, isolatedWorkspace: true },
    environment: {
      runtimeId: 'python:3.12', displayName: 'Python 3.12', language: 'python', version: '3.12',
      dockerImage: 'python:3.12-slim', workspaceKind: 'personal'
    }
  });
  assert.equal(transport.snapshot().environment.dockerImage, 'python:3.12-slim');

  const bytes = Buffer.from('你好 \x1b[31mred\x1b[0m', 'utf8');
  socket.fire('message', JSON.stringify({ type: 'terminal.output', stream: 'stdout', encoding: 'base64', data: bytes.subarray(0, 2).toString('base64') }));
  socket.fire('message', JSON.stringify({ type: 'terminal.output', stream: 'stdout', encoding: 'base64', data: bytes.subarray(2).toString('base64') }));
  assert.equal(events.filter((event) => event.channel === 'output').map((event) => event.payload.data).join(''), '你好 \x1b[31mred\x1b[0m');

  const progress = ['Downloading 10%\r', 'Downloading 50%\r', 'Downloading 100%\r\n'];
  progress.forEach((data) => socket.fire('message', JSON.stringify({
    type: 'terminal.output', stream: 'stdout', encoding: 'base64', data: Buffer.from(data).toString('base64')
  })));
  assert.equal(
    events.filter((event) => event.channel === 'output').slice(-3).map((event) => event.payload.data).join(''),
    progress.join(''),
    'carriage returns must reach xterm unchanged so progress updates replace the current row'
  );

  transport.write('echo hi\r');
  transport.resize(120, 40);
  assert.deepEqual(socket.sent.slice(1), [
    { type: 'terminal.stdin', data: 'echo hi\r' },
    { type: 'terminal.resize', cols: 120, rows: 40 }
  ]);
  await stopWithServerExit(transport, socket);
});

test('rejects Local runtime and stale input without opening a general command channel', async () => {
  const transport = new TerminalTransport({ webSocketFactory: () => new MockSocket(), pingIntervalMs: 0 });
  await assert.rejects(
    transport.start({ serverHost: 'cloud.example', runtimeId: 'Local', workspace: { kind: 'personal', folderKey: 'demo' } }),
    /Docker runtime/
  );
  assert.throws(() => transport.write('echo unsafe'), /offline/);
});

test('negotiates managed package intents and preserves the cleanup gate on exit', async () => {
  const events = [];
  let socket;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: () => 'token',
    emit: (channel, payload) => events.push({ channel, payload }),
    pingIntervalMs: 0
  });
  const starting = transport.start({
    serverHost: 'cloud.example', runtimeId: 'python:3.12', packageIntents: true,
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent[0].packageIntents, true);
  socket.fire('message', JSON.stringify({
    type: 'terminal.ready', sessionId: 'term-intent', runtimeId: 'python:3.12',
    capabilities: { packageIntents: true }
  }));
  await starting;

  socket.fire('message', JSON.stringify({
    type: 'terminal.packageIntent', schema: 1, intentId: 'intent-1', sessionId: 'term-intent',
    runtimeId: 'python:3.12', workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    ecosystem: 'python', manager: 'pip', operation: 'install', packages: [{ name: 'numpy', version: '2.3.1' }],
    sourceId: 'pypi-official', requiresTerminalClose: true
  }));
  const accepted = events.find((event) => event.channel === 'package-intent');
  assert.equal(accepted.payload.intentId, 'intent-1');
  assert.deepEqual(accepted.payload.packages, [{ name: 'numpy', scope: 'runtime', version: '2.3.1' }]);

  assert.deepEqual(transport.decidePackageIntent('intent-1', true, 'managed'), { accepted: true, intentId: 'intent-1' });
  assert.deepEqual(socket.sent.at(-1), {
    type: 'terminal.packageIntentDecision', intentId: 'intent-1', accepted: true, code: 'managed'
  });
  assert.throws(() => transport.decidePackageIntent('../intent', false, 'invalid'), /identity is invalid/);

  socket.fire('message', JSON.stringify({ type: 'terminal.packageIntentRejected', schema: 1, intentId: 'intent-1', code: 'unsupported_requirement' }));
  const rejected = events.find((event) => event.channel === 'package-intent-rejected');
  assert.equal(rejected.payload.code, 'unsupported_requirement');
  assert.equal(rejected.payload.intentId, 'intent-1');

  const stopping = transport.stop('package-intent');
  socket.fire('message', JSON.stringify({
    type: 'terminal.exit', reason: 'closed', cleanupConfirmed: true,
    packageIntentPending: true, packageIntentId: 'intent-1',
    dependenciesChanged: false, environmentChanged: false
  }));
  const closed = await stopping;
  assert.equal(closed.cleanupConfirmed, true);
  assert.equal(closed.packageIntentPending, true);
  assert.equal(closed.packageIntentId, 'intent-1');
  assert.equal(closed.dependenciesChanged, false);
});

test('validates Node package intents and preserves dependency scope', async () => {
  const events = [];
  let socket;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: () => 'token',
    emit: (channel, payload) => events.push({ channel, payload }),
    pingIntervalMs: 0
  });
  const starting = transport.start({
    serverHost: 'cloud.example', runtimeId: 'node:22', packageIntents: true,
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', JSON.stringify({
    type: 'terminal.ready', sessionId: 'term-node', runtimeId: 'node:22',
    capabilities: { packageIntents: true },
    environment: { runtimeId: 'node:22', language: 'node' }
  }));
  await starting;

  socket.fire('message', JSON.stringify({
    type: 'terminal.packageIntent', schema: 1, intentId: 'intent-node', sessionId: 'term-node',
    runtimeId: 'node:22', workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    ecosystem: 'node', manager: 'pnpm', operation: 'install',
    packages: [{ name: '@types/node', version: '22.10.2', scope: 'dev' }],
    sourceId: 'npm-official', requiresTerminalClose: true
  }));
  const accepted = events.find((event) => event.channel === 'package-intent');
  assert.deepEqual(accepted.payload.packages, [{ name: '@types/node', scope: 'dev', version: '22.10.2' }]);
  assert.equal(accepted.payload.manager, 'pnpm');

  socket.fire('message', JSON.stringify({
    type: 'terminal.packageIntent', schema: 1, intentId: 'intent-invalid-scope', sessionId: 'term-node',
    runtimeId: 'node:22', workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    ecosystem: 'node', manager: 'npm', operation: 'install',
    packages: [{ name: 'chalk', version: '5.4.1', scope: 'peer' }],
    sourceId: 'npm-official', requiresTerminalClose: true
  }));
  socket.fire('message', JSON.stringify({
    type: 'terminal.packageIntent', schema: 1, intentId: 'intent-invalid-manager', sessionId: 'term-node',
    runtimeId: 'node:22', workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    ecosystem: 'node', manager: 'yarn', operation: 'install',
    packages: [{ name: 'chalk', version: '5.4.1', scope: 'runtime' }],
    sourceId: 'npm-official', requiresTerminalClose: true
  }));
  socket.fire('message', JSON.stringify({
    type: 'terminal.packageIntent', schema: 1, intentId: 'intent-cross-ecosystem', sessionId: 'term-node',
    runtimeId: 'node:22', workspace: { kind: 'personal', folderName: 'demo', folderKey: 'demo-key' },
    ecosystem: 'python', manager: 'pip', operation: 'install',
    packages: [{ name: 'requests', version: '2.32.3', scope: 'runtime' }],
    sourceId: 'pypi-official', requiresTerminalClose: true
  }));
  const rejected = events.filter((event) => event.channel === 'package-intent-rejected');
  assert.deepEqual(rejected.map((event) => event.payload.intentId), ['intent-invalid-scope', 'intent-invalid-manager', 'intent-cross-ecosystem']);
  assert.ok(rejected.every((event) => event.payload.code === 'invalid_package_intent'));
  await stopWithServerExit(transport, socket);
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
  await stopWithServerExit(transport, socket);
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

test('explicit stop waits for server cleanup acknowledgement and has a bounded fallback', async () => {
  let socket;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: () => 'token',
    pingIntervalMs: 0,
    closeTimeoutMs: 10
  });
  const starting = transport.start({
    serverHost: 'cloud.example', runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', JSON.stringify({ type: 'terminal.ready', sessionId: 'term-close', capabilities: {} }));
  await starting;

  let settled = false;
  const stopping = transport.stop('panel-close').then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'stop resolved before terminal.exit');
  assert.equal(socket.closed, false);
  socket.fire('message', JSON.stringify({ type: 'terminal.exit', reason: 'closed', exitCode: 0 }));
  assert.equal((await stopping).confirmed, true);

  const restarting = transport.start({
    serverHost: 'cloud.example', runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', JSON.stringify({ type: 'terminal.ready', sessionId: 'term-timeout', capabilities: {} }));
  await restarting;
  const timedOut = await transport.stop('panel-close');
  assert.equal(timedOut.confirmed, false);
  assert.equal(timedOut.reason, 'close_timeout');
  assert.equal(socket.closed, true);
});

test('concurrent replacement starts cannot orphan an earlier WebSocket', async () => {
  const sockets = [];
  const transport = new TerminalTransport({
    webSocketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token',
    pingIntervalMs: 0
  });
  const config = (folderKey) => ({
    serverHost: 'cloud.example', runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderKey }
  });

  const initial = transport.start(config('initial'));
  sockets[0].open();
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].fire('message', JSON.stringify({ type: 'terminal.ready', sessionId: 'term-initial', capabilities: {} }));
  await initial;

  const closing = transport.stop('replace');
  const firstReplacement = transport.start(config('first'));
  const secondReplacement = transport.start(config('second'));
  sockets[0].fire('message', JSON.stringify({ type: 'terminal.exit', reason: 'closed', exitCode: 0 }));
  await closing;
  await assert.rejects(firstReplacement, (error) => error && error.code === 'start_cancelled');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sockets.length, 3);
  assert.equal(sockets[1].closed, true, 'superseded replacement socket remained open');
  sockets[2].open();
  await new Promise((resolve) => setImmediate(resolve));
  sockets[2].fire('message', JSON.stringify({ type: 'terminal.ready', sessionId: 'term-second', capabilities: {} }));
  assert.equal((await secondReplacement).sessionId, 'term-second');
  await stopWithServerExit(transport, sockets[2]);
});

test('terminal.exit can report that server cleanup is still pending', async () => {
  let socket;
  const transport = new TerminalTransport({
    webSocketFactory: () => (socket = new MockSocket()),
    getCredential: () => 'token', pingIntervalMs: 0
  });
  const starting = transport.start({
    serverHost: 'cloud.example', runtimeId: 'python:3.12',
    workspace: { kind: 'personal', folderKey: 'demo' }
  });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', JSON.stringify({ type: 'terminal.ready', sessionId: 'term-pending', capabilities: {} }));
  await starting;

  const stopping = transport.stop('panel-close');
  socket.fire('message', JSON.stringify({
    type: 'terminal.exit', reason: 'cleanup_pending', exitCode: 1, cleanupConfirmed: false,
    environmentMutation: {
      dependenciesChanged: true,
      environmentChanged: true,
      cacheRevision: 'revision-4',
      generation: 'generation-4',
      dependencyDigest: 'digest-4',
      cacheEntryId: 'cache-entry-4'
    }
  }));
  const result = await stopping;
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'cleanup_pending');
  assert.equal(result.dependenciesChanged, true);
  assert.equal(result.environmentChanged, true);
  assert.equal(result.cacheRevision, 'revision-4');
  assert.equal(result.generation, 'generation-4');
  assert.equal(result.dependencyDigest, 'digest-4');
  assert.equal(result.cacheEntryId, 'cache-entry-4');
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
