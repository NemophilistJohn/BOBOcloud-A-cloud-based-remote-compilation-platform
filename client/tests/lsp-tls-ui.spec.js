'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

test('Electron LSP accepts pinned private TLS, rejects wrong pins before credentials and recovers after trust changes', async () => {
  test.setTimeout(60000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-lsp-tls-'));
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  let app;
  let server;
  let wss;
  let wrongPortServer;
  const received = [];
  try {
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { encoding: 'utf8' });
    expect(generated.status, 'OpenSSL is required for the hermetic TLS baseline: ' + (generated.error || '')).toBe(0);
    const fingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(fs.readFileSync(cert)).raw).digest('hex');
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => { res.writeHead(404); res.end(); });
    wss = new WebSocketServer({ server, path: '/lsp' });
    wss.on('connection', socket => {
      socket.on('message', data => {
        const message = JSON.parse(data.toString());
        received.push(message);
        if (message.type === 'lsp.start') socket.send(JSON.stringify({ type: 'lsp.ready', sessionId: 'tls-baseline',
          dependency: { status: 'empty', revision: 'baseline' } }));
        else if (message.method === 'initialize') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          result: { capabilities: { textDocumentSync: 1, completionProvider: { triggerCharacters: ['.'] } } } }));
        else if (message.method === 'textDocument/completion') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          result: { items: [{ label: 'array', insertText: 'array' }] } }));
        else if (message.method === 'shutdown') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const settings = { ip: '127.0.0.1', secureTransport: true, wsPort: server.address().port,
      httpPort: 1, certificateFingerprint: fingerprint, apiKey: 'fixture-secret' };
    const packagedExecutable = String(process.env.BOBO_LSP_PACKAGED_EXE || '').trim();
    app = await electron.launch({ ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
      args: [...(packagedExecutable ? [] : ['.']), '--user-data-dir=' + path.join(directory, 'chromium')],
      env: { ...process.env, APPDATA: path.join(directory, 'appdata'), HOME: path.join(directory, 'home'),
        USERPROFILE: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-bobo-ready') === 'true');
    await app.evaluate(({ app: electronApp }, serverSettings) => {
      const mainRequire = process.getBuiltinModule('module').createRequire(electronApp.getAppPath() + '/package.json');
      const { createLspController } = mainRequire('./main/lsp');
      const handlers = new Map();
      const probe = globalThis.__lspTls = { settings: serverSettings, handlers, credentialReads: 0 };
      probe.controller = createLspController({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getWindow: () => null, sendToRenderer: () => {}, settings: {
          readServerSettings: async () => probe.settings,
          readAuth: () => { probe.credentialReads += 1; return {}; }
        } });
      probe.controller.registerIpc();
      probe.configure = () => handlers.get('lsp:configure')({}, { mode: 'full', languageId: 'python', runtimeId: 'python:3.10',
        workspace: { kind: 'personal', folderName: 'fixture', folderKey: 'fixture' } });
      return probe.configure();
    }, settings);
    const status = () => app.evaluate(() => globalThis.__lspTls.handlers.get('lsp:status')({}));
    await expect.poll(async () => (await status()).state).toBe('ready');
    expect(received[0].type).toBe('lsp.start');
    expect(received[0].token).toBe('fixture-secret');
    const completion = await app.evaluate(async () => {
      const handlers = globalThis.__lspTls.handlers;
      await handlers.get('lsp:notify')({}, { method: 'textDocument/didOpen', params: { textDocument: {
        uri: 'bobocloud-lsp:///probe.py', languageId: 'python', version: 1, text: 'numpy.' } } });
      return handlers.get('lsp:request')({}, { method: 'textDocument/completion', params: {
        textDocument: { uri: 'bobocloud-lsp:///probe.py' }, position: { line: 0, character: 6 } } });
    });
    expect(completion.items[0].label).toBe('array');
    const startsBefore = received.filter(message => message.type === 'lsp.start').length;
    const credentialReads = await app.evaluate(() => globalThis.__lspTls.credentialReads);
    await app.evaluate(() => { const probe = globalThis.__lspTls; probe.settings.certificateFingerprint = '00'.repeat(32); return probe.configure(); });
    await expect.poll(async () => (await status()).code).toBe('certificate_mismatch');
    expect((await status()).retryBlocked).toBe(true);
    expect(await app.evaluate(() => globalThis.__lspTls.credentialReads)).toBe(credentialReads);
    expect(received.filter(message => message.type === 'lsp.start').length).toBe(startsBefore);
    await app.evaluate(() => { const probe = globalThis.__lspTls; probe.settings.certificateFingerprint = ''; return probe.configure(); });
    await expect.poll(async () => (await status()).code).toBe('certificate_untrusted');
    expect((await status()).retryBlocked).toBe(true);
    expect(await app.evaluate(() => globalThis.__lspTls.credentialReads)).toBe(credentialReads);
    wrongPortServer = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise(resolve => wrongPortServer.listen(0, '127.0.0.1', resolve));
    await app.evaluate((_electron, port) => { const probe = globalThis.__lspTls; probe.settings.secureTransport = false;
      probe.settings.wsPort = port; return probe.configure(); }, wrongPortServer.address().port);
    await expect.poll(async () => (await status()).code).toBe('upgrade_rejected');
    expect((await status()).retryBlocked).toBe(true);
    expect(await app.evaluate(() => globalThis.__lspTls.credentialReads)).toBe(credentialReads);
    await app.evaluate((_electron, trustedSettings) => { const probe = globalThis.__lspTls; probe.settings = trustedSettings;
      return probe.configure(); }, settings);
    await expect.poll(async () => (await status()).state).toBe('ready');
    expect(received.filter(message => message.type === 'lsp.start').length).toBe(startsBefore + 1);
  } finally {
    if (app) {
      await app.evaluate(() => globalThis.__lspTls?.controller.dispose()).catch(() => {});
      await app.close();
    }
    if (wss) { for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); }
    if (server) await new Promise(resolve => server.close(resolve));
    if (wrongPortServer) await new Promise(resolve => wrongPortServer.close(resolve));
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
