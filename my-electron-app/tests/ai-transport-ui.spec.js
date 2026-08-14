'use strict';

const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise(resolve => server.close(resolve));
}

test('main AI transport sends chat and DeepSeek FIM bodies and cancels by requestId', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-ai-transport-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const received = [];
  const slowResponses = new Map();
  const closedSlowRequests = new Set();
  const sockets = new Set();
  const mockServer = http.createServer((request, response) => {
    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { rawBody += chunk; });
    request.on('end', () => {
      const entry = {
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: JSON.parse(rawBody)
      };
      received.push(entry);
      if (request.url.startsWith('/slow/')) {
        slowResponses.set(request.url, response);
        response.on('close', () => {
          if (!response.writableEnded) closedSlowRequests.add(request.url);
        });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'local-response',
        model: entry.body.model,
        choices: [{ text: 'local completion', message: { content: 'local reply' } }]
      }));
    });
  });
  mockServer.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let app;
  await listen(mockServer);
  const origin = `http://127.0.0.1:${mockServer.address().port}`;
  try {
    app = await electron.launch({
      executablePath: electronPath(),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: appData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
      })
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    const chatMessages = [
      { role: 'system', content: 'Answer from the supplied context.' },
      { role: 'user', content: 'Summarize main.go.' }
    ];
    const chatResult = await page.evaluate(async ({ endpoint, messages }) => {
      return window.api.aiChatRequest({
        modelConfig: {
          name: 'Local chat mock',
          provider: 'openai-compatible',
          apiKey: 'chat-test-key',
          endpoint,
          modelId: 'chat-model-local',
          options: { temperature: 0.25, top_p: 0.9 }
        },
        messages,
        maxTokens: 321,
        stream: false
      });
    }, { endpoint: origin + '/v1/chat/completions?source=chat', messages: chatMessages });
    expect(chatResult).toMatchObject({ success: true, data: { model: 'chat-model-local' } });

    const fimResult = await page.evaluate(async endpoint => {
      return window.api.aiInlineRequest({
        requestId: 'fim-request-1',
        mode: 'fim',
        modelConfig: {
          name: 'Local DeepSeek FIM mock',
          provider: 'openai-compatible',
          apiKey: 'fim-test-key',
          endpoint,
          modelId: 'deepseek-fim-local'
        },
        prompt: 'function add(a, b) { return ',
        suffix: '; }',
        maxTokens: 222,
        temperature: 0.3,
        stop: ['\n\n', '<END>']
      });
    }, origin + '/beta/completions?source=fim');
    expect(fimResult).toMatchObject({ success: true, data: { model: 'deepseek-fim-local' } });

    expect(received.slice(0, 2)).toEqual([
      {
        path: '/v1/chat/completions?source=chat',
        authorization: 'Bearer chat-test-key',
        contentType: 'application/json',
        body: {
          model: 'chat-model-local',
          max_tokens: 321,
          stream: false,
          messages: chatMessages,
          temperature: 0.25,
          top_p: 0.9
        }
      },
      {
        path: '/beta/completions?source=fim',
        authorization: 'Bearer fim-test-key',
        contentType: 'application/json',
        body: {
          model: 'deepseek-fim-local',
          prompt: 'function add(a, b) { return ',
          suffix: '; }',
          max_tokens: 222,
          temperature: 0.3,
          top_p: 1,
          stop: ['\n\n', '<END>'],
          stream: false
        }
      }
    ]);

    await page.evaluate(originValue => {
      const config = requestId => ({
        requestId,
        mode: 'fim',
        modelConfig: {
          name: 'Local cancellation mock',
          provider: 'openai-compatible',
          apiKey: 'cancel-test-key',
          endpoint: originValue + '/slow/' + requestId,
          modelId: 'cancel-model-local'
        },
        prompt: requestId,
        suffix: '',
        maxTokens: 32
      });
      window.__aiTransportPending = {
        first: window.api.aiInlineRequest(config('request-a')),
        second: window.api.aiInlineRequest(config('request-b'))
      };
    }, origin);

    await expect.poll(() => received.filter(entry => entry.path.startsWith('/slow/')).length).toBe(2);
    const cancelResult = await page.evaluate(() => window.api.aiCancelInline('request-a'));
    expect(cancelResult).toEqual({ success: true, cancelled: true });
    await expect.poll(() => closedSlowRequests.has('/slow/request-a')).toBe(true);
    expect(closedSlowRequests.has('/slow/request-b')).toBe(false);

    const repeatedCancel = await page.evaluate(() => window.api.aiCancelInline('request-a'));
    expect(repeatedCancel).toEqual({ success: true, cancelled: false });

    const secondResponse = slowResponses.get('/slow/request-b');
    expect(secondResponse).toBeTruthy();
    secondResponse.writeHead(200, { 'content-type': 'application/json' });
    secondResponse.end(JSON.stringify({
      model: 'cancel-model-local',
      choices: [{ text: 'second request completed' }]
    }));

    const pendingResults = await page.evaluate(async () => {
      const timeout = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 5000));
      return Promise.race([
        Promise.all([window.__aiTransportPending.first, window.__aiTransportPending.second]),
        timeout
      ]);
    });
    expect(pendingResults).not.toEqual({ timeout: true });
    expect(pendingResults[0]).toMatchObject({ success: false });
    expect(pendingResults[1]).toMatchObject({
      success: true,
      data: { choices: [{ text: 'second request completed' }] }
    });
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await closeServer(mockServer, sockets);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
