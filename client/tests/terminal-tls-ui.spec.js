'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

test('Electron terminal validates the normalized WSS URL before credentials and recovers after trust changes', async () => {
  test.setTimeout(60000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-terminal-tls-'));
  const received = [];
  const sockets = new Set();
  let app, server, wss;
  try {
    const keyPath = path.join(directory, 'key.pem');
    const certPath = path.join(directory, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'], { encoding: 'utf8' });
    expect(generated.status, 'OpenSSL is required for the real Electron terminal TLS regression').toBe(0);
    const cert = fs.readFileSync(certPath);
    const fingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex');
    server = https.createServer({ key: fs.readFileSync(keyPath), cert });
    wss = new WebSocketServer({ server, path: '/terminal' });
    wss.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('message', data => {
        const message = JSON.parse(data.toString());
        received.push(message);
        if (message.type === 'terminal.start') socket.send(JSON.stringify({ type: 'terminal.ready', sessionId: 'terminal-tls' }));
        if (message.type === 'terminal.close') socket.send(JSON.stringify({ type: 'terminal.exit', reason: 'closed', exitCode: 0 }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app = await electron.launch({ args: ['.', '--user-data-dir=' + path.join(directory, 'chromium')],
      env: { ...process.env, APPDATA: path.join(directory, 'appdata'), HOME: path.join(directory, 'home'),
        USERPROFILE: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true');
    await app.evaluate(({ app: electronApp, BrowserWindow }, settings) => {
      const mainRequire = process.getBuiltinModule('module').createRequire(electronApp.getAppPath() + '/package.json');
      const { createTerminalController } = mainRequire('./main/terminal');
      const probe = globalThis.__terminalTlsProbe = { settings, credentialReads: 0, controller: null };
      probe.start = async pin => {
        if (probe.controller) await probe.controller.dispose();
        probe.settings.certificateFingerprint = pin;
        const handlers = new Map();
        const window = BrowserWindow.getAllWindows()[0];
        probe.controller = createTerminalController({
          ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getWindow: () => window,
          getWorkspaceIdentity: () => ({ rootPath: 'fixture-workspace', workspaceIdentity: 1 }),
          sendToRenderer: () => {},
          settings: { readServerSettings: async () => probe.settings,
            readAuth: () => { probe.credentialReads++; return {}; } }
        });
        probe.controller.registerIpc();
        try {
          const result = await handlers.get('terminal:start')({ sender: window.webContents }, {
            runtimeId: 'python:3.12', workspace: { kind: 'personal', folderKey: 'fixture' },
            context: { workspaceRoot: 'fixture-workspace', workspaceIdentity: 1 }
          });
          return { success: true, sessionId: result.sessionId };
        } catch (error) {
          return { success: false, code: error.code, message: error.message };
        }
      };
    }, { ip: '127.0.0.1', wsPort: server.address().port, secureTransport: true, apiKey: 'terminal-fixture-secret' });

    const start = pin => app.evaluate((_electron, value) => globalThis.__terminalTlsProbe.start(value), pin);
    const reads = () => app.evaluate(() => globalThis.__terminalTlsProbe.credentialReads);
    expect(await start(fingerprint)).toEqual({ success: true, sessionId: 'terminal-tls' });
    expect(received.find(message => message.type === 'terminal.start').token).toBe('terminal-fixture-secret');
    const readsBefore = await reads();
    const startsBefore = received.filter(message => message.type === 'terminal.start').length;
    expect(await start('00'.repeat(32))).toMatchObject({ success: false, code: 'certificate_mismatch' });
    expect(await reads()).toBe(readsBefore);
    expect(await start('')).toMatchObject({ success: false });
    expect(await reads()).toBe(readsBefore);
    expect(received.filter(message => message.type === 'terminal.start').length).toBe(startsBefore);
    expect(await start(fingerprint)).toEqual({ success: true, sessionId: 'terminal-tls' });
    expect(received.filter(message => message.type === 'terminal.start').length).toBe(startsBefore + 1);
  } finally {
    if (app) {
      try { await app.evaluate(async () => { await globalThis.__terminalTlsProbe?.controller?.dispose(); }); } catch {}
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    for (const socket of sockets) socket.terminate();
    if (wss) await new Promise(resolve => wss.close(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
