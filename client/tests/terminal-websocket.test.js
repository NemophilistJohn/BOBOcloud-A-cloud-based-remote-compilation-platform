'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { TerminalTransport } = require('../terminal-transport');
const {
  createTerminalWebSocketFactory,
  verifyTerminalPeer,
  peerFingerprint
} = require('../main/terminal-websocket');

function fakeSocket(raw) {
  return {
    _socket: {
      getPeerCertificate: () => ({ raw })
    }
  };
}

test('pinned terminal peer validation compares the SHA-256 certificate before credentials', () => {
  const raw = Buffer.from('terminal-test-certificate');
  const expected = crypto.createHash('sha256').update(raw).digest('hex');
  const socket = fakeSocket(raw);
  assert.equal(peerFingerprint(socket), expected.toUpperCase());
  assert.doesNotThrow(() => verifyTerminalPeer(socket, expected, 'wss://cloud.example:3101/terminal'));
  assert.throws(
    () => verifyTerminalPeer(socket, '00'.repeat(32), 'wss://cloud.example:3101/terminal'),
    (error) => error && error.code === 'certificate_mismatch'
  );
  assert.throws(
    () => verifyTerminalPeer(socket, expected, 'ws://cloud.example:3101/terminal'),
    (error) => error && error.code === 'certificate_unavailable'
  );
});

test('terminal WebSocket factory keeps CA verification unless a configured pin explicitly permits private TLS', () => {
  const calls = [];
  class FakeWebSocket {
    constructor(url, options) { calls.push({ url, options }); }
  }
  createTerminalWebSocketFactory({ certificateFingerprint: '' }, { WebSocket: FakeWebSocket })('wss://cloud.example:3101/terminal');
  createTerminalWebSocketFactory({ certificateFingerprint: 'AA:BB' }, { WebSocket: FakeWebSocket })('wss://cloud.example:3101/terminal');
  createTerminalWebSocketFactory({ certificateFingerprint: 'AA:BB' }, { WebSocket: FakeWebSocket })('ws://cloud.example:3101/terminal');
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(calls[1].options.rejectUnauthorized, false);
  assert.equal(calls[2].options.rejectUnauthorized, undefined);
  assert.equal(calls.every((call) => call.options.perMessageDeflate === false), true);
});

async function createSelfSignedTerminalServer() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-terminal-wss-'));
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'
  ], { stdio: 'ignore' });
  if (generated.status !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    return null;
  }
  const received = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  const sockets = new Set();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('message', (data) => {
      received.push(JSON.parse(data.toString('utf8')));
      socket.send(JSON.stringify({ type: 'terminal.ready', sessionId: 'wss-test', capabilities: { resize: false } }));
    });
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    received,
    url: 'wss://127.0.0.1:' + address.port + '/terminal',
    fingerprint: crypto.createHash('sha256').update(new crypto.X509Certificate(fs.readFileSync(cert)).raw).digest('hex'),
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('real WSS terminal handshake checks a private certificate before the terminal token is sent', { timeout: 30000 }, async (t) => {
  const fixture = await createSelfSignedTerminalServer();
  if (!fixture) {
    t.skip('OpenSSL is unavailable for the local WSS certificate fixture');
    return;
  }
  try {
    const start = (fingerprint) => {
      const transport = new TerminalTransport({
        webSocketFactory: createTerminalWebSocketFactory({ certificateFingerprint: fingerprint }),
        getCredential: async () => 'terminal-secret',
        pingIntervalMs: 0
      });
      const pending = transport.start({
        serverHost: fixture.url,
        runtimeId: 'python:3.12',
        workspace: { kind: 'personal', folderKey: 'demo' },
        verifyPeer: (socket) => verifyTerminalPeer(socket, fingerprint, fixture.url)
      });
      return { transport, pending };
    };

    const good = start(fixture.fingerprint);
    const session = await good.pending;
    assert.equal(session.sessionId, 'wss-test');
    assert.deepEqual(fixture.received, [{
      type: 'terminal.start', protocol: 1, token: 'terminal-secret', runtimeId: 'python:3.12',
      workspace: { kind: 'personal', folderName: '', folderKey: 'demo' }, cols: 120, rows: 32
    }]);
    await good.transport.stop('test');

    const receivedBeforeMismatch = fixture.received.length;
    const wrong = start('00'.repeat(32));
    await assert.rejects(wrong.pending, (error) => error && error.code === 'certificate_mismatch');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.received.length, receivedBeforeMismatch, 'wrong certificate must not receive terminal.start');

    const receivedBeforeUnpinned = fixture.received.length;
    const unpinned = start('');
    await assert.rejects(unpinned.pending);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.received.length, receivedBeforeUnpinned, 'untrusted unpinned certificate must not receive terminal.start');
  } finally {
    await fixture.close();
  }
});
