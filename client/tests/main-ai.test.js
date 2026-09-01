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
  assert.doesNotThrow(() => validateRequestPayload({
    requestId: 'internal-events', messages: [], stream: true, modelConfig: {}, onEvent() {}
  }));
  assert.throws(() => validateRequestPayload({
    requestId: 'invalid-events', messages: [], stream: true, modelConfig: {}, onEvent: 'not-a-function'
  }), { code: 'AI_REQUEST_INVALID' });
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

test('OpenAI uses modern token limits and Anthropic maps xhigh adaptive thinking', async (t) => {
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
    messages: [{ role: 'user', content: 'think carefully' }],
    tools: [{
      type: 'function',
      function: { name: 'workspace_read', description: 'Read a file', parameters: { type: 'object' } }
    }]
  };

  const openAi = await harness.handlers.get('ai-chat-request')(null, {
    ...base,
    requestId: 'xhigh-openai',
    modelConfig: {
      name: 'OpenAI test',
      provider: 'openai',
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
  const kimi = await harness.handlers.get('ai-chat-request')(null, {
    ...base,
    requestId: 'xhigh-kimi',
    modelConfig: {
      name: 'Kimi test',
      provider: 'kimi',
      endpoint: `http://127.0.0.1:${port}/kimi`,
      modelId: 'kimi-test',
      apiKey: 'test-key',
      capabilities: { reasoningEfforts: [] },
      options: {}
    }
  });

  assert.equal(openAi.success, true);
  assert.equal(anthropic.success, true);
  assert.equal(kimi.success, true);
  assert.equal(openAi.effectiveReasoningEffort, 'xhigh');
  assert.equal(anthropic.requestedReasoningEffort, 'xhigh');
  assert.equal(anthropic.effectiveReasoningEffort, 'high');
  const openAiBody = requests.find((entry) => entry.url === '/openai').body;
  assert.equal(openAiBody.reasoning_effort, 'xhigh');
  assert.equal(openAiBody.max_completion_tokens, 16384);
  assert.equal(Object.hasOwn(openAiBody, 'max_tokens'), false);
  const kimiBody = requests.find((entry) => entry.url === '/kimi').body;
  assert.equal(kimiBody.max_completion_tokens, 16384);
  assert.equal(Object.hasOwn(kimiBody, 'max_tokens'), false);
  const anthropicBody = requests.find((entry) => entry.url === '/anthropic').body;
  assert.deepEqual(anthropicBody.thinking, { type: 'adaptive' });
  assert.deepEqual(anthropicBody.output_config, { effort: 'high' });
  assert.equal(anthropicBody.tools[0].name, 'workspace_read');
});

test('GLM reasoning declarations use the provider thinking object instead of a generic effort field', async (t) => {
  let requestBody = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());

  const result = await harness.controller.request({
    requestId: 'glm-thinking',
    mode: 'chat',
    stream: false,
    reasoningEffort: 'max',
    messages: [{ role: 'user', content: 'Think carefully.' }],
    modelConfig: {
      provider: 'glm',
      endpoint: `http://127.0.0.1:${port}/chat/completions`,
      modelId: 'glm-test',
      apiKey: 'test-key',
      capabilities: {
        reasoningEfforts: ['high'],
        effectiveEffortMap: { max: 'high' }
      },
      options: {}
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.effectiveReasoningEffort, 'high');
  assert.deepEqual(requestBody.thinking, { type: 'enabled' });
  assert.equal(Object.hasOwn(requestBody, 'reasoning_effort'), false);
});

test('unknown model reasoning capability is not reported or sent as effective', async (t) => {
  let requestBody = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());

  const result = await harness.controller.request({
    requestId: 'unknown-reasoning',
    mode: 'chat',
    stream: false,
    reasoningEffort: 'max',
    messages: [{ role: 'user', content: 'hello' }],
    modelConfig: {
      providerId: 'zhipu',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      modelId: 'unknown-model',
      apiKey: 'test-key',
      capabilities: { reasoningEfforts: [], effectiveEffortMap: {} },
      options: {}
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.requestedReasoningEffort, 'max');
  assert.equal(result.effectiveReasoningEffort, 'none');
  assert.equal(result.data.effectiveReasoningEffort, 'none');
  assert.equal(Object.hasOwn(requestBody, 'reasoning_effort'), false);
});

test('OpenAI-compatible stream emits normalized model events and resolves an accumulated response', async (t) => {
  let requestBody = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = [
        { id: 'chatcmpl-1', model: 'deepseek-test', choices: [{ index: 0, delta: { reasoning_content: 'think ' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'workspace_', arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '"a.js"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 2 } } }
      ];
      for (const chunk of chunks) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());
  const modelEvents = [];

  const result = await harness.controller.request({
    requestId: 'agent-openai-stream',
    mode: 'chat',
    stream: true,
    reasoningEffort: 'max',
    onEvent: (event) => modelEvents.push(event),
    messages: [{ role: 'user', content: 'inspect' }],
    tools: [{
      type: 'function',
      function: { name: 'workspace_read', description: 'Read a file', parameters: { type: 'object' } }
    }],
    modelConfig: {
      provider: 'openai-compatible',
      providerId: 'deepseek',
      protocol: 'chat-completions',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      modelId: 'deepseek-test',
      apiKey: 'test-key',
      capabilities: {
        reasoningEfforts: ['low', 'medium', 'high'],
        effectiveEffortMap: { max: 'high' }
      },
      options: {}
    }
  }, { lane: 'agent' });

  assert.equal(requestBody.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(requestBody, 'onEvent'), false);
  assert.equal(result.success, true);
  assert.equal(result.requestedReasoningEffort, 'max');
  assert.equal(result.effectiveReasoningEffort, 'high');
  assert.equal(result.data.choices[0].message.content, 'answer');
  assert.equal(result.data.choices[0].message.reasoning_content, 'think ');
  assert.equal(result.data.choices[0].message.tool_calls[0].function.name, 'workspace_read');
  assert.equal(result.data.choices[0].message.tool_calls[0].function.arguments, '{"path":"a.js"}');
  assert.equal(result.data.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.data.usage, {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    completion_tokens_details: { reasoning_tokens: 2 }
  });
  assert.deepEqual(modelEvents.map((event) => event.type), [
    'response.started', 'reasoning.delta', 'content.delta', 'tool_call.delta', 'tool_call.delta', 'usage'
  ]);
  assert.deepEqual(modelEvents[0], {
    type: 'response.started', requestedReasoningEffort: 'max', effectiveReasoningEffort: 'high'
  });
  assert.equal(modelEvents[1].delta, 'think ');
  assert.equal(modelEvents[2].delta, 'answer');
  assert.deepEqual(modelEvents[3], {
    type: 'tool_call.delta', index: 0, id: 'call-1', name: 'workspace_', argumentsDelta: '{"path":'
  });
  assert.deepEqual(modelEvents[4], {
    type: 'tool_call.delta', index: 0, id: 'call-1', name: 'workspace_read', argumentsDelta: '"a.js"}'
  });
  assert.deepEqual(modelEvents.at(-1).usage, {
    inputTokens: 11,
    outputTokens: 7,
    reasoningTokens: 2,
    totalTokens: 18
  });
  assert.ok(modelEvents.every((event) => Object.hasOwn(event, 'requestId') === false));
  assert.equal(harness.events.filter((event) => event.channel === 'ai-chunk').map((event) => event.payload.text).join(''), 'answer');
  assert.equal(harness.events.at(-1).channel, 'ai-stream-end');
});

test('Anthropic stream keeps adaptive thinking with tools and accumulates blocks and usage', async (t) => {
  let requestBody = null;
  let requestHeaders = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      requestHeaders = request.headers;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: {
          id: 'msg-1', role: 'assistant', model: 'claude-test',
          usage: { input_tokens: 8, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 }
        } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'workspace_read', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.js"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' }
      ];
      for (const event of events) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end();
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());
  const modelEvents = [];

  const result = await harness.controller.request({
    requestId: 'agent-anthropic-stream',
    mode: 'chat',
    stream: true,
    reasoningEffort: 'xhigh',
    onEvent: (event) => modelEvents.push(event),
    messages: [{ role: 'user', content: 'inspect' }],
    tools: [{
      type: 'function',
      function: { name: 'workspace_read', description: 'Read a file', parameters: { type: 'object' } }
    }],
    modelConfig: {
      provider: 'openai-compatible',
      providerId: 'anthropic',
      protocol: 'messages',
      authType: 'api-key',
      apiVersion: '2023-06-01',
      endpoint: `http://127.0.0.1:${port}/v1/messages`,
      modelId: 'claude-test',
      apiKey: 'anthropic-key',
      capabilities: {
        reasoningEfforts: ['low', 'medium', 'high'],
        effectiveEffortMap: { xhigh: 'high' }
      },
      options: { thinkingMode: 'adaptive' }
    }
  }, { lane: 'agent' });

  assert.equal(requestHeaders['x-api-key'], 'anthropic-key');
  assert.equal(requestHeaders['anthropic-version'], '2023-06-01');
  assert.deepEqual(requestBody.thinking, { type: 'adaptive' });
  assert.deepEqual(requestBody.output_config, { effort: 'high' });
  assert.equal(requestBody.tools[0].name, 'workspace_read');
  assert.equal(result.success, true);
  assert.equal(result.effectiveReasoningEffort, 'high');
  assert.deepEqual(result.data.content[0], { type: 'thinking', thinking: 'consider ', signature: 'signed' });
  assert.deepEqual(result.data.content[1], { type: 'text', text: 'done' });
  assert.deepEqual(result.data.content[2], {
    type: 'tool_use', id: 'tool-1', name: 'workspace_read', input: { path: 'a.js' }
  });
  assert.equal(result.data.stop_reason, 'tool_use');
  assert.deepEqual(result.data.usage, {
    input_tokens: 8, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 5
  });
  assert.equal(modelEvents.some((event) => event.type === 'reasoning.delta' && event.delta === 'consider '), true);
  assert.equal(modelEvents.some((event) => event.type === 'content.delta' && event.delta === 'done'), true);
  assert.equal(modelEvents.filter((event) => event.type === 'tool_call.delta').length, 3);
  assert.deepEqual(modelEvents.filter((event) => event.type === 'usage').map((event) => event.usage), [
    { inputTokens: 11, cachedInputTokens: 2 },
    { outputTokens: 5 }
  ]);
});

test('provider stream errors notify the internal listener and keep the Promise rejection contract', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({
      type: 'error', error: { type: 'overloaded_error', message: 'provider busy' }
    }) + '\n\n');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());
  const modelEvents = [];

  await assert.rejects(() => harness.controller.request({
    requestId: 'agent-stream-error',
    mode: 'chat',
    stream: true,
    onEvent: (event) => modelEvents.push(event),
    messages: [{ role: 'user', content: 'hello' }],
    modelConfig: {
      providerId: 'anthropic',
      endpoint: `http://127.0.0.1:${port}/v1/messages`,
      modelId: 'claude-test',
      apiKey: 'test-key',
      options: {}
    }
  }, { lane: 'agent' }), { code: 'AI_PROVIDER_STREAM_ERROR', message: 'provider busy' });

  assert.equal(modelEvents.length, 2);
  assert.deepEqual(modelEvents[0], {
    type: 'response.started', requestedReasoningEffort: 'none', effectiveReasoningEffort: 'none'
  });
  assert.deepEqual(modelEvents[1], {
    type: 'error',
    code: 'AI_PROVIDER_STREAM_ERROR',
    message: 'provider busy'
  });
  assert.equal(harness.events.some((event) => event.channel === 'ai-stream-end'), false);
  assert.equal(harness.events.filter((event) => event.channel === 'ai-stream-error').length, 1);
});

test('Anthropic stream reports none from start through completion when thinking is not enabled', async (t) => {
  let requestBody = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start', message: { id: 'msg-none', role: 'assistant', usage: { input_tokens: 3 } }
      }) + '\n\n');
      response.write('event: content_block_start\ndata: ' + JSON.stringify({
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
      }) + '\n\n');
      response.write('event: content_block_delta\ndata: ' + JSON.stringify({
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' }
      }) + '\n\n');
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());
  const modelEvents = [];

  const result = await harness.controller.request({
    requestId: 'anthropic-thinking-disabled',
    mode: 'chat',
    stream: true,
    reasoningEffort: 'high',
    maxTokens: 1_048_576,
    onEvent: (event) => modelEvents.push(event),
    messages: [{ role: 'user', content: 'Answer directly.' }],
    modelConfig: {
      provider: 'anthropic',
      endpoint: `http://127.0.0.1:${port}/v1/messages`,
      modelId: 'claude-test',
      apiKey: 'test-key',
      capabilities: { reasoningEfforts: ['high'], effectiveEffortMap: {} },
      options: {}
    }
  }, { lane: 'agent' });

  assert.equal(Object.hasOwn(requestBody, 'thinking'), false);
  assert.equal(requestBody.max_tokens, 262_144);
  assert.equal(result.requestedReasoningEffort, 'high');
  assert.equal(result.effectiveReasoningEffort, 'none');
  assert.deepEqual(modelEvents[0], {
    type: 'response.started', requestedReasoningEffort: 'high', effectiveReasoningEffort: 'none'
  });
  assert.equal(modelEvents.some((event) => event.type === 'content.delta' && event.delta === 'done'), true);
});

test('cancelling an Agent stream drops provider data that arrives after the request finishes', async (t) => {
  let writeLateChunk = null;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'first' } }] }) + '\n\n');
    writeLateChunk = () => {
      if (response.destroyed) return;
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'late' } }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    };
  });
  const port = await listen(server);
  t.after(() => close(server));
  const harness = createHarness();
  t.after(() => harness.controller.dispose());
  const modelEvents = [];
  let firstEventResolve;
  const firstEvent = new Promise((resolve) => { firstEventResolve = resolve; });

  const pending = harness.controller.request({
    requestId: 'cancel-agent-stream',
    mode: 'chat',
    stream: true,
    onEvent: (event) => {
      modelEvents.push(event);
      if (event.type === 'content.delta') firstEventResolve();
    },
    messages: [{ role: 'user', content: 'hello' }],
    modelConfig: {
      providerId: 'custom',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      modelId: 'stream-test',
      apiKey: 'test-key',
      options: {}
    }
  }, { lane: 'agent' });

  await firstEvent;
  assert.deepEqual(harness.controller.cancel('cancel-agent-stream'), { success: true, cancelled: true });
  await assert.rejects(() => pending);
  if (writeLateChunk) writeLateChunk();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(modelEvents.filter((event) => event.type === 'content.delta').map((event) => event.delta).join(''), 'first');
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
