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
const { createDapController } = require('../main/dap');

async function createSelfSignedDAPServer() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-dap-wss-'));
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
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'));
      received.push(message);
      if (message.type === 'dap.start') {
        socket.send(JSON.stringify({
          type: 'dap.ready',
          sessionId: 'wss-test',
          adapter: { id: 'python-debugpy', languageId: 'python', runtimeId: 'python:3.12' },
          capabilities: { supportsLaunch: true }
        }));
      }
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
    port: address.port,
    fingerprint: crypto.createHash('sha256')
      .update(new crypto.X509Certificate(fs.readFileSync(cert)).raw)
      .digest('hex'),
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('DAP controller validates a pinned private TLS peer before reading the credential', { timeout: 30000 }, async (t) => {
  const fixture = await createSelfSignedDAPServer();
  if (!fixture) {
    t.skip('OpenSSL is unavailable for the local WSS certificate fixture');
    return;
  }
  try {
    for (const [pin, expectedError] of [
      [fixture.fingerprint, null],
      ['00'.repeat(32), 'certificate_mismatch'],
      ['', 'connection_error']
    ]) {
      const handlers = new Map();
      const webContents = { isDestroyed: () => false };
      let credentialReads = 0;
      const controller = createDapController({
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getWindow: () => ({ isDestroyed: () => false, webContents }),
        getWorkspaceIdentity: () => ({ rootPath: 'C:/demo', workspaceIdentity: 7 }),
        runWorkspaceMutation: async (_scope, operation) => operation({}),
        sendToRenderer: () => {},
        settings: {
          readServerSettings: async () => ({
            ip: '127.0.0.1', httpPort: fixture.port, secureTransport: true,
            certificateFingerprint: pin, apiKey: 'controller-secret'
          }),
          readAuth: () => { credentialReads += 1; return {}; }
        }
      });
      controller.registerIpc();
      const receivedBefore = fixture.received.length;
      try {
        const result = await handlers.get('dap:start')({ sender: webContents }, {
          languageId: 'python',
          runtimeId: 'python:3.12',
          workspace: { kind: 'personal', folderKey: 'demo' },
          context: { workspaceRoot: 'C:/demo', workspaceIdentity: 7 }
        });
        if (!expectedError) {
          assert.equal(result.status.state, 'ready');
          assert.equal(credentialReads, 1);
          assert.deepEqual(fixture.received.at(-1), {
            type: 'dap.start', token: 'controller-secret', runtimeId: 'python:3.12', languageId: 'python',
            setupCommands: [], workspace: { kind: 'personal', folderName: '', folderKey: 'demo' }
          });
          await handlers.get('dap:stop')({}, 'test');
        } else {
          assert.equal(result.status.code, expectedError);
          assert.equal(credentialReads, 0);
          assert.equal(fixture.received.length, receivedBefore, 'failed TLS validation must not send dap.start');
        }
      } finally {
        await controller.dispose();
      }
    }
  } finally {
    await fixture.close();
  }
});
