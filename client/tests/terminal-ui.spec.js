'use strict';

const { test, expect, _electron: electron } = require('playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function electronExecutablePath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function serverFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('Test WebSocket payload is unexpectedly large');
}

function consumeClientFrames(state, onMessage) {
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    let headerLength = 2;
    let payloadLength = second & 0x7f;
    if (payloadLength === 126) {
      if (state.buffer.length < 4) return;
      payloadLength = state.buffer.readUInt16BE(2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (state.buffer.length < 10) return;
      payloadLength = Number(state.buffer.readBigUInt64BE(2));
      headerLength = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    const totalLength = headerLength + maskLength + payloadLength;
    if (state.buffer.length < totalLength) return;
    const payload = Buffer.from(state.buffer.subarray(headerLength + maskLength, totalLength));
    if (masked) {
      const mask = state.buffer.subarray(headerLength, headerLength + 4);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    state.buffer = state.buffer.subarray(totalLength);
    const opcode = first & 0x0f;
    if (opcode === 0x1) onMessage(payload.toString('utf8'));
  }
}

async function createTerminalServer() {
  const messages = [];
  const sockets = new Set();
  let activeSocket = null;
  let sessionCounter = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    activeSocket = socket;
    socket.setNoDelay(true);
    const state = { upgraded: false, buffer: Buffer.alloc(0) };
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      if (!state.upgraded) {
        const boundary = state.buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const request = state.buffer.subarray(0, boundary).toString('utf8');
        state.buffer = state.buffer.subarray(boundary + 4);
        const key = (request.match(/^sec-websocket-key:\s*(.+)$/im) || [])[1];
        if (!key) { socket.destroy(); return; }
        const accept = crypto.createHash('sha1')
          .update(key.trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        state.upgraded = true;
      }
      consumeClientFrames(state, (text) => {
        let message;
        try { message = JSON.parse(text); } catch (_) { return; }
        messages.push(message);
        if (message.type === 'terminal.close') {
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.write(serverFrame(JSON.stringify({
                type: 'terminal.exit', reason: 'closed', exitCode: 0
              })));
            }
          }, 30);
          return;
        }
        if (message.type !== 'terminal.start') return;
        socket.write(serverFrame(JSON.stringify({
          type: 'terminal.ready',
          sessionId: 'terminal-ui-test-' + (++sessionCounter),
          runtimeId: message.runtimeId,
          snapshot: true,
          capabilities: { tty: true, resize: false, isolatedWorkspace: true }
        })));
        socket.write(serverFrame(JSON.stringify({
          type: 'terminal.output',
          stream: 'stdout',
          encoding: 'base64',
          data: Buffer.from('connected\\r\\n$ ', 'utf8').toString('base64')
        })));
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    messages,
    exitActive(reason = 'process_exited') {
      if (activeSocket && !activeSocket.destroyed) {
        activeSocket.write(serverFrame(JSON.stringify({ type: 'terminal.exit', reason, exitCode: 0 })));
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function closeFixture(fixture) {
  if (!fixture) return;
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch (_) {}
  if (fixture.server) await fixture.server.close();
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('cloud terminal streams through the main bridge and confirms only multi-line pasted input', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-terminal-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.py'), 'print("terminal")\n');

  let fixture;
  try {
    const server = await createTerminalServer();
    const app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: path.join(sandbox, 'appdata'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
      })
    });
    fixture = { app, server, sandbox };
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    await page.evaluate(async ({ workspacePath, wsPort }) => {
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      const settings = {
        ip: '127.0.0.1', user: 'test', pass: 'test', apiKey: '', secureTransport: false,
        httpPort: 3100, wsPort, dapChildWsPort: 3102, certificateFingerprint: '',
        rclonePath: '', syncInterval: 30000, setupCompleted: true
      };
      await window.api.writeServerSettings(settings);
      window.BOBO.state.serverSettings = settings;
      window.BOBO.serverCapabilities.applyServerInfo({ success: true, data: {} }, 'test-legacy-server');
      window.BOBO.state.selectedRuntime = 'python:3.12';
      window.BOBO.state.setupCommands = ['pip install numpy==2.1.0'];
      window.BOBO.workspace.saveAllTabs = async () => true;
      window.BOBO.runner.syncWithServer = async () => true;
    }, { workspacePath: workspace, wsPort: server.port });

    await page.locator('#panel-tabs [data-panel="terminal"]').click();
    await expect.poll(() => server.messages.filter((message) => message.type === 'terminal.start').length).toBe(1);
    await page.waitForFunction(() => window.BOBO.terminal.getState().connected === true, null, { timeout: 10000 });
    await expect(page.locator('#terminal-host .xterm')).toBeVisible();
    await expect(page.locator('#terminal-input')).toHaveCount(0);
    await expect(page.locator('.terminal-input-row')).toHaveCount(0);
    await expect(page.locator('#terminal-output')).toHaveCount(0);
    expect(await page.evaluate(() => window.BOBO.terminal.getState().capabilities.resize)).toBe(false);

    const start = server.messages.find((message) => message.type === 'terminal.start');
    const terminalState = await page.evaluate(() => window.BOBO.terminal.getState());
    expect(start.runtimeId).toBe('python:3.12');
    expect(start.setupCommands).toEqual(['pip install numpy==2.1.0']);
    expect(start.workspace.kind).toBe('personal');
    expect(start.workspace.folderName).toBe('workspace');
    expect(start.workspace).not.toHaveProperty('workspaceRoot');
    expect(start.cols).toBe(terminalState.cols);
    expect(Math.abs(start.rows - terminalState.rows)).toBeLessThanOrEqual(1);
    expect(server.messages.some((message) => message.type === 'terminal.resize')).toBe(false);

    const input = page.locator('#terminal-host textarea.xterm-helper-textarea');
    await input.focus();
    const stdinBeforeKeyboard = server.messages.filter((message) => message.type === 'terminal.stdin').length;
    await page.keyboard.type('echo native');
    await page.keyboard.press('Enter');
    await expect.poll(() => server.messages
      .filter((message) => message.type === 'terminal.stdin')
      .slice(stdinBeforeKeyboard)
      .map((message) => message.data)
      .join('')).toBe('echo native\r');

    const pasted = 'echo first\r\necho second\n';
    const prevented = await page.evaluate((value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      document.getElementById('terminal-host').dispatchEvent(event);
      return event.defaultPrevented;
    }, pasted);
    expect(prevented).toBe(true);
    await expect(page.locator('#confirm-dialog.open')).toBeVisible();
    await expect(page.locator('#confirm-dialog .confirm-card')).toHaveAttribute('role', 'alertdialog');
    await expect(page.locator('#confirm-dialog .confirm-card')).toHaveAttribute('aria-modal', 'true');
    await page.locator('#confirm-dialog .confirm-btn-primary').click();
    await expect.poll(() => server.messages.some((message) => message.type === 'terminal.stdin' && message.data === pasted)).toBe(true);

    const stdinBeforeCancel = server.messages.filter((message) => message.type === 'terminal.stdin').length;
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'echo do-not-run\necho cancel\n');
      document.getElementById('terminal-host').dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: data
      }));
    });
    await expect(page.locator('#confirm-dialog.open')).toBeVisible();
    await page.locator('#confirm-dialog .confirm-btn-ghost').click();
    await page.waitForTimeout(250);
    expect(server.messages.filter((message) => message.type === 'terminal.stdin')).toHaveLength(stdinBeforeCancel);

    const closesBeforeTabSwitch = server.messages.filter((message) => message.type === 'terminal.close').length;
    await page.locator('#panel-tabs [data-panel="output"]').click();
    await page.waitForTimeout(100);
    expect(server.messages.filter((message) => message.type === 'terminal.close')).toHaveLength(closesBeforeTabSwitch);

    await page.evaluate(() => {
      window.__terminalLspRestartCount = 0;
      window.__terminalLspRefreshFallbackCount = 0;
      window.BOBO.lsp.restartAnalysis = async () => { window.__terminalLspRestartCount += 1; return true; };
      window.BOBO.lsp.dependenciesChanged = async () => { window.__terminalLspRefreshFallbackCount += 1; return true; };
    });
    await page.locator('#panel-close').click();
    await expect.poll(() => server.messages.some((message) => message.type === 'terminal.close' && message.reason === 'panel-close')).toBe(true);
    await expect(page.locator('#bottom-panel')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.BOBO.terminal.getState().phase)).toBe('idle');
    expect(await page.evaluate(() => ({
      restarts: window.__terminalLspRestartCount,
      fallbacks: window.__terminalLspRefreshFallbackCount
    }))).toEqual({ restarts: 1, fallbacks: 0 });

    await page.evaluate(() => window.BOBO.workbench.setPanelVisible(true));
    await page.locator('#panel-tabs [data-panel="terminal"]').click();
    await expect.poll(() => server.messages.filter((message) => message.type === 'terminal.start').length).toBe(2);
    await page.waitForFunction(() => window.BOBO.terminal.getState().connected === true, null, { timeout: 10000 });

    server.exitActive();
    await expect.poll(() => page.evaluate(() => window.BOBO.terminal.getState().phase)).toBe('idle');
    await expect.poll(() => page.evaluate(() => window.__terminalLspRestartCount)).toBe(2);

    await page.locator('#panel-tabs [data-panel="terminal"]').click();
    await expect.poll(() => server.messages.filter((message) => message.type === 'terminal.start').length).toBe(3);
    await page.waitForFunction(() => window.BOBO.terminal.getState().connected === true, null, { timeout: 10000 });

    await page.evaluate(() => {
      window.BOBO.lsp.restartAnalysis = async () => {
        window.__terminalLspRestartCount += 1;
        throw new Error('restart unavailable');
      };
    });
    await page.evaluate(() => window.BOBO.workspace.closeWorkspace({ approved: true, reason: 'test-close' }));
    await expect.poll(() => server.messages.some((message) => message.type === 'terminal.close' && message.reason === 'workspace-leave')).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__terminalLspRefreshFallbackCount)).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});
