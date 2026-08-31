'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  MAX_AI_REQUEST_INPUT_BYTES,
  createAiController,
  resolveApiContract,
  validateRequestPayload
} = require('../main/ai');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createHarness(options = {}) {
  const handlers = new Map();
  const events = [];
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload })
    }
  };
  const controller = createAiController({
    ipcMain,
    getWindow: () => window,
    maxStreamOutputBytes: options.maxStreamOutputBytes,
    maxNonStreamRequests: options.maxNonStreamRequests,
    laneLimits: options.laneLimits,
    settings: {
      readAiSettings: () => ({}),
      writeAiSettings: () => true,
      readChatHistory: () => ({ messages: [], referencedFiles: [] }),
      writeChatHistory: () => {}
    }
  });
  controller.registerIpc();
  return { controller, handlers, events };
}

function payloadFor(port, requestId) {
  return {
    requestId,
    mode: 'chat',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
    modelConfig: {
      name: 'Bounded request test',
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      modelId: 'test-model',
      apiKey: 'test-key',
      options: {}
    }
  };
}

test('AI contract selection gives explicit format priority and recognizes chat endpoints', () => {
  const chatUrl = new URL('https://api.deepseek.com/v1/chat/completions');
  const fimUrl = new URL('https://api.deepseek.com/beta/completions');
  assert.equal(resolveApiContract({ mode: 'fim', modelConfig: {} }, chatUrl), 'chat');
  assert.equal(resolveApiContract({ mode: 'fim', modelConfig: {} }, fimUrl), 'fim');
  assert.equal(resolveApiContract({ apiFormat: 'chat', modelConfig: {} }, fimUrl), 'chat');
  assert.equal(resolveApiContract({ modelConfig: { apiFormat: 'fim' } }, chatUrl), 'fim');
});

test('AI request admission bounds bytes, shape, messages, tools, and request ids', () => {
  assert.doesNotThrow(() => validateRequestPayload({ messages: [], stream: false, modelConfig: {} }));
  assert.throws(() => validateRequestPayload({ messages: [], stream: true, modelConfig: {} }), {
    code: 'AI_REQUEST_INVALID'
  });
  assert.throws(() => validateRequestPayload({
    requestId: 'oversized',
    messages: [{ role: 'user', content: 'x'.repeat(MAX_AI_REQUEST_INPUT_BYTES) }],
    modelConfig: {}
  }), { code: 'AI_REQUEST_TOO_LARGE' });
  assert.throws(() => validateRequestPayload({
    requestId: 'messages', messages: Array.from({ length: 97 }, () => ({ role: 'user', content: 'x' })), modelConfig: {}
  }), { code: 'AI_REQUEST_TOO_LARGE' });
  assert.throws(() => validateRequestPayload({
    requestId: 'tools', tools: Array.from({ length: 49 }, () => ({ type: 'function' })), modelConfig: {}
  }), { code: 'AI_REQUEST_TOO_LARGE' });
  let nested = {};
  for (let index = 0; index < 40; index += 1) nested = { nested };
  assert.throws(() => validateRequestPayload({ requestId: 'deep', messages: [], modelConfig: { options: nested } }), {
    code: 'AI_REQUEST_TOO_COMPLEX'
  });
  assert.throws(() => validateRequestPayload({ requestId: '../invalid', messages: [], modelConfig: {} }), {
    code: 'AI_REQUEST_INVALID'
  });
  const wide = {};
  for (let index = 0; index < 20_000; index += 1) wide['field' + index] = index;
  assert.throws(() => validateRequestPayload({ requestId: 'wide', messages: [], modelConfig: { options: wide } }), {
    code: 'AI_REQUEST_TOO_COMPLEX'
  });
});

test('AI inline admission caps concurrent paid provider requests', async (t) => {
  let received = 0;
  const server = http.createServer((request) => {
    received += 1;
    request.resume();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness({ maxNonStreamRequests: 2, laneLimits: { inline: 2 } });
  t.after(() => harness.controller.dispose());
  const inline = harness.handlers.get('ai-inline-request');
  const first = inline(null, payloadFor(port, 'inline-one'));
  const second = inline(null, payloadFor(port, 'inline-two'));
  for (let attempt = 0; attempt < 100 && received < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(received, 2);
  const rejected = await inline(null, payloadFor(port, 'inline-three'));
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'AI_REQUEST_BUSY');
  assert.equal(received, 2);
  harness.controller.dispose();
  await Promise.all([first, second]);
});

test('FIM request to chat/completions always sends a non-empty messages field', async (t) => {
  let requestBody = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content: '' } }] }));
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());

  const result = await harness.handlers.get('ai-test-connection')(null, {
    requestId: 'connection-test',
    mode: 'fim',
    stream: false,
    prompt: '',
    suffix: '',
    modelConfig: {
      name: 'DeepSeek test',
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      modelId: 'deepseek-v4-flash',
      apiKey: 'test-key',
      options: {}
    }
  });

  assert.equal(result.success, true);
  assert.ok(Array.isArray(requestBody.messages));
  assert.ok(requestBody.messages.length >= 1);
  assert.equal(typeof requestBody.messages[0].content, 'string');
  assert.equal(Object.hasOwn(requestBody, 'prompt'), false);
});

test('xhigh reasoning is preserved for compatible providers and mapped for Anthropic adaptive thinking', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/anthropic') {
        response.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());
  const base = {
    mode: 'chat',
    stream: false,
    reasoningEffort: 'xhigh',
    maxTokens: 16384,
    messages: [{ role: 'user', content: 'think carefully' }]
  };

  const openAi = await harness.handlers.get('ai-chat-request')(null, {
    ...base,
    requestId: 'xhigh-openai',
    modelConfig: {
      name: 'OpenAI-compatible test',
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${port}/openai`,
      modelId: 'reasoning-test',
      apiKey: 'test-key',
      options: { enableReasoningEffort: true }
    }
  });
  const anthropic = await harness.handlers.get('ai-chat-request')(null, {
    ...base,
    requestId: 'xhigh-anthropic',
    modelConfig: {
      name: 'Anthropic test',
      provider: 'anthropic',
      endpoint: `http://127.0.0.1:${port}/anthropic`,
      modelId: 'claude-test',
      apiKey: 'test-key',
      options: { thinkingMode: 'adaptive' }
    }
  });

  assert.equal(openAi.success, true);
  assert.equal(anthropic.success, true);
  assert.equal(requests.find((entry) => entry.url === '/openai').body.reasoning_effort, 'xhigh');
  const anthropicBody = requests.find((entry) => entry.url === '/anthropic').body;
  assert.deepEqual(anthropicBody.thinking, { type: 'adaptive' });
  assert.deepEqual(anthropicBody.output_config, { effort: 'high' });
});

test('streaming proxy batches rapid provider chunks without losing output', async (t) => {
  const pieces = Array.from({ length: 120 }, (_, index) => String(index % 10));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of pieces) {
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());

  const result = await harness.handlers.get('ai-chat-request')(null, {
    requestId: 'long-answer',
    mode: 'chat',
    stream: true,
    messages: [{ role: 'user', content: 'count' }],
    modelConfig: {
      name: 'Streaming test',
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      modelId: 'stream-test',
      apiKey: 'test-key',
      options: {}
    }
  });

  assert.equal(result.success, true);
  const chunks = harness.events.filter((event) => event.channel === 'ai-chunk');
  assert.ok(chunks.length < pieces.length / 4, `expected batching, got ${chunks.length} IPC chunks`);
  assert.equal(chunks.map((event) => event.payload.text).join(''), pieces.join(''));
  assert.equal(harness.events.at(-1).channel, 'ai-stream-end');
});

test('streaming proxy stops oversized output with an explicit truncated event', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let index = 0; index < 20; index += 1) {
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '0123456789' } }] }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness({ maxStreamOutputBytes: 32 });
  t.after(() => harness.controller.dispose());

  const result = await harness.handlers.get('ai-chat-request')(null, {
    requestId: 'oversized-answer',
    mode: 'chat',
    stream: true,
    messages: [{ role: 'user', content: 'long answer' }],
    modelConfig: {
      name: 'Streaming test',
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      modelId: 'stream-test',
      apiKey: 'test-key',
      options: {}
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 'ai.response.truncated');
  const errorEvent = harness.events.find((event) => event.channel === 'ai-stream-error');
  assert.equal(errorEvent.payload.requestId, 'oversized-answer');
  assert.equal(errorEvent.payload.code, 'ai.response.truncated');
  assert.equal(errorEvent.payload.truncated, true);
  assert.equal(harness.events.some((event) => event.channel === 'ai-stream-end'), false);
});
