const http = require('http');
const https = require('https');

const MAX_AI_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_AI_STREAM_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_AI_REQUEST_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_AI_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MAX_AI_REQUEST_DEPTH = 32;
const MAX_AI_REQUEST_NODES = 20_000;
const MAX_AI_MESSAGES = 96;
const MAX_AI_TOOLS = 48;
const DEFAULT_MAX_NON_STREAM_REQUESTS = 8;
const DEFAULT_LANE_LIMITS = Object.freeze({ chat: 1, inline: 2, test: 1, agent: 4 });
const AI_CHUNK_FLUSH_MS = 24;

function requestError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function measureStructuredInput(value) {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  let bytes = 0;
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    const item = current.value;
    nodes += 1;
    if (nodes > MAX_AI_REQUEST_NODES) throw requestError('AI request structure is too complex', 'AI_REQUEST_TOO_COMPLEX');
    if (current.depth > MAX_AI_REQUEST_DEPTH) throw requestError('AI request nesting is too deep', 'AI_REQUEST_TOO_COMPLEX');
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8');
    } else if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean') {
      bytes += 8;
    } else if (typeof item === 'object') {
      if (seen.has(item)) throw requestError('AI request contains a cyclic value', 'AI_REQUEST_INVALID');
      seen.add(item);
      if (Array.isArray(item) && item.length > MAX_AI_REQUEST_NODES) {
        throw requestError('AI request structure is too complex', 'AI_REQUEST_TOO_COMPLEX');
      }
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        if (nodes + stack.length + 1 > MAX_AI_REQUEST_NODES) {
          throw requestError('AI request structure is too complex', 'AI_REQUEST_TOO_COMPLEX');
        }
        bytes += Buffer.byteLength(key, 'utf8');
        if (bytes > MAX_AI_REQUEST_INPUT_BYTES) {
          throw requestError('AI request exceeds the 2 MiB input limit', 'AI_REQUEST_TOO_LARGE');
        }
        stack.push({ value: item[key], depth: current.depth + 1 });
      }
    } else {
      throw requestError('AI request contains an unsupported value', 'AI_REQUEST_INVALID');
    }
    if (bytes > MAX_AI_REQUEST_INPUT_BYTES) throw requestError('AI request exceeds the 2 MiB input limit', 'AI_REQUEST_TOO_LARGE');
  }
  return bytes;
}

function validateRequestPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw requestError('AI request must be an object', 'AI_REQUEST_INVALID');
  }
  if (Array.isArray(payload.messages) && payload.messages.length > MAX_AI_MESSAGES) {
    throw requestError('AI request has too many messages', 'AI_REQUEST_TOO_LARGE');
  }
  if (Array.isArray(payload.tools) && payload.tools.length > MAX_AI_TOOLS) {
    throw requestError('AI request has too many tools', 'AI_REQUEST_TOO_LARGE');
  }
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(requestId)) {
    throw requestError('AI request id is invalid', 'AI_REQUEST_INVALID');
  }
  measureStructuredInput(payload);
}

function clampInteger(value, fallback, min, max) {
  value = Number(value);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

function clampNumber(value, fallback, min, max) {
  value = Number(value);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function normalizeStop(primary, fallback) {
  const source = Array.isArray(primary) ? primary : (Array.isArray(fallback) ? fallback : []);
  return source.slice(0, 8).map(String).filter((value) => value && value.length <= 200);
}

function resolveApiContract(payload, url) {
  const modelConfig = payload && payload.modelConfig || {};
  const explicit = String(payload && payload.apiFormat || modelConfig.apiFormat || '').trim().toLowerCase();
  if (explicit === 'fim' || explicit === 'completions') return 'fim';
  if (explicit === 'chat' || explicit === 'chat-completions' || explicit === 'messages') return 'chat';

  const pathname = String(url && url.pathname || '').replace(/\/+$/, '').toLowerCase();
  if (/(^|\/)chat\/completions$/.test(pathname) || /(^|\/)messages$/.test(pathname)) return 'chat';
  if (/(^|\/)completions$/.test(pathname)) return 'fim';
  // Unknown OpenAI-compatible routes are safer with the widely implemented
  // messages contract. FIM is used only when the endpoint explicitly declares it.
  return 'chat';
}

function completionMessages(payload) {
  const supplied = Array.isArray(payload.messages) ? payload.messages.filter((message) => {
    return message && typeof message.role === 'string' && typeof message.content === 'string';
  }) : [];
  if (supplied.length) return supplied;
  return [
    {
      role: 'system',
      content: 'Complete the code at the cursor. Return only the missing code without Markdown fences.'
    },
    {
      role: 'user',
      content: 'Prefix:\n' + String(payload.prompt || '') + '\n\nSuffix:\n' + String(payload.suffix || '')
    }
  ];
}

function normalizeToolDefinitions(value) {
  return Array.isArray(value) ? value.slice(0, 48).filter((tool) => (
    tool && tool.type === 'function' && tool.function && typeof tool.function.name === 'string'
  )) : [];
}

function anthropicToolDefinitions(tools) {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || '',
    input_schema: tool.function.parameters || { type: 'object', properties: {} }
  }));
}

function anthropicMessages(messages) {
  const result = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id || '', content: String(message.content || '') };
      const previous = result[result.length - 1];
      if (previous && previous.role === 'user' && Array.isArray(previous.content) && previous.content.every((item) => item.type === 'tool_result')) {
        previous.content.push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const content = message.content ? [{ type: 'text', text: String(message.content) }] : [];
      for (const call of message.tool_calls.slice(0, 32)) {
        let input = {};
        try { input = JSON.parse(call && call.function && call.function.arguments || '{}'); } catch (_) {}
        content.push({
          type: 'tool_use',
          id: String(call && call.id || ''),
          name: String(call && call.function && call.function.name || ''),
          input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}
        });
      }
      result.push({ role: 'assistant', content });
      continue;
    }
    result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') });
  }
  return result;
}

function createAiController(options) {
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const settings = options.settings;
  const maxStreamOutputBytes = Number.isSafeInteger(options.maxStreamOutputBytes) && options.maxStreamOutputBytes > 0
    ? options.maxStreamOutputBytes
    : MAX_AI_STREAM_OUTPUT_BYTES;
  let activeChatRequest = null;
  const activeInlineRequests = new Map();
  const activeNonStreamRequests = new Map();
  const maxNonStreamRequests = Number.isSafeInteger(options.maxNonStreamRequests) && options.maxNonStreamRequests > 0
    ? options.maxNonStreamRequests
    : DEFAULT_MAX_NON_STREAM_REQUESTS;
  const laneLimits = Object.assign({}, DEFAULT_LANE_LIMITS, options.laneLimits || {});

  function send(channel, payload) {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  function finishRequest(requestId, request) {
    if (requestId && activeInlineRequests.get(requestId) === request) activeInlineRequests.delete(requestId);
    activeNonStreamRequests.delete(request);
    if (activeChatRequest === request) activeChatRequest = null;
  }

  function assertNonStreamCapacity(lane, requestId) {
    const previous = activeInlineRequests.get(requestId);
    if (previous) {
      activeInlineRequests.delete(requestId);
      activeNonStreamRequests.delete(previous);
      previous.destroy();
    }
    let laneCount = 0;
    for (const value of activeNonStreamRequests.values()) if (value === lane) laneCount += 1;
    const laneLimit = Number.isSafeInteger(laneLimits[lane]) && laneLimits[lane] > 0
      ? laneLimits[lane]
      : 1;
    if (activeNonStreamRequests.size >= maxNonStreamRequests || laneCount >= laneLimit) {
      throw requestError('Too many AI requests are already active', 'AI_REQUEST_BUSY');
    }
  }

  function request(payload, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      payload = payload || {};
      try { validateRequestPayload(payload); }
      catch (error) { reject(error); return; }
      const { modelConfig } = payload;
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const stream = payload.stream === true;
      const requestId = payload.requestId;
      const mode = payload.mode === 'fim' ? 'fim' : 'chat';
      const lane = Object.prototype.hasOwnProperty.call(DEFAULT_LANE_LIMITS, requestOptions.lane)
        ? requestOptions.lane
        : 'agent';
      if (!modelConfig || !modelConfig.endpoint) {
        reject(new Error('No AI model configured'));
        return;
      }
      const apiKey = modelConfig.apiKey || '';
      if (!apiKey) {
        reject(new Error('API key not set for: ' + modelConfig.name + '. Go to Manage Models to set it.'));
        return;
      }

      let url;
      try {
        url = new URL(modelConfig.endpoint);
      } catch (_) {
        reject(new Error('AI endpoint is not a valid URL'));
        return;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        reject(new Error('AI endpoint must use HTTP or HTTPS'));
        return;
      }

      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'BOBOCLOUD-Editor/2.0'
      };
      if (modelConfig.provider === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = 'Bearer ' + apiKey;
      }

      const modelOptions = modelConfig.options && typeof modelConfig.options === 'object' ? modelConfig.options : {};
      const providerOptions = Object.assign({}, modelOptions);
      delete providerOptions.enableReasoningEffort;
      delete providerOptions.enableThinking;
      delete providerOptions.thinkingMode;
      const temperature = clampNumber(payload.temperature, clampNumber(modelOptions.temperature, mode === 'fim' ? 0 : 0.2, 0, 2), 0, 2);
      const topP = clampNumber(payload.topP, clampNumber(modelOptions.top_p, 1, 0, 1), 0, 1);
      const stop = normalizeStop(payload.stop, modelOptions.stop);
      const nativeFim = mode === 'fim' && resolveApiContract(payload, url) === 'fim';
      const effectiveMessages = mode === 'fim' && !nativeFim ? completionMessages(payload) : messages;
      const tools = normalizeToolDefinitions(payload.tools);
      const reasoningEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(payload.reasoningEffort)
        ? payload.reasoningEffort
        : '';
      let body;
      if (nativeFim) {
        body = JSON.stringify({
          model: modelConfig.modelId,
          prompt: String(payload.prompt || ''),
          suffix: String(payload.suffix || ''),
          max_tokens: clampInteger(payload.maxTokens, 160, 1, 2048),
          temperature,
          top_p: topP,
          stop: stop.length ? stop : undefined,
          stream: false
        });
      } else if (modelConfig.provider === 'anthropic') {
        const systemMessage = effectiveMessages.find((message) => message.role === 'system');
        const chatMessages = anthropicMessages(effectiveMessages);
        const anthropicEffort = reasoningEffort === 'xhigh' ? 'high' : reasoningEffort;
        const thinkingMode = !tools.length && reasoningEffort && modelOptions.thinkingMode === 'adaptive'
          ? 'adaptive'
          : (!tools.length && reasoningEffort && modelOptions.enableThinking === true ? 'enabled' : '');
        const thinking = thinkingMode === 'adaptive'
          ? { type: 'adaptive' }
          : (thinkingMode === 'enabled'
              ? { type: 'enabled', budget_tokens: reasoningEffort === 'max' ? 16000 : reasoningEffort === 'xhigh' ? 12000 : reasoningEffort === 'high' ? 8000 : reasoningEffort === 'medium' ? 4000 : 1600 }
              : undefined);
        body = JSON.stringify({
          model: modelConfig.modelId,
          max_tokens: clampInteger(payload.maxTokens, mode === 'fim' ? 160 : 4096, 1, 32768),
          stream,
          temperature: thinking ? undefined : temperature,
          top_p: thinking ? undefined : topP,
          stop_sequences: stop.length ? stop : undefined,
          system: systemMessage ? systemMessage.content : undefined,
          messages: chatMessages,
          tools: tools.length ? anthropicToolDefinitions(tools) : undefined,
          thinking,
          output_config: thinkingMode === 'adaptive' ? { effort: anthropicEffort } : undefined
        });
      } else {
        body = JSON.stringify(Object.assign({}, providerOptions, {
          model: modelConfig.modelId,
          max_tokens: clampInteger(payload.maxTokens, mode === 'fim' ? 160 : 4096, 1, 32768),
          stream,
          messages: effectiveMessages,
          temperature,
          top_p: topP,
          stop: stop.length ? stop : undefined,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined,
          reasoning_effort: reasoningEffort && modelOptions.enableReasoningEffort === true ? reasoningEffort : undefined
        }));
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_AI_REQUEST_BODY_BYTES) {
        reject(requestError('AI request exceeds the 4 MiB provider body limit', 'AI_REQUEST_TOO_LARGE'));
        return;
      }

      if (!stream) {
        try { assertNonStreamCapacity(lane, requestId); }
        catch (error) { reject(error); return; }
      }

      const transportOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: 60000
      };
      let settled = false;

      const req = transport.request(transportOptions, (res) => {
        if (res.statusCode >= 400) {
          let errorData = '';
          res.on('data', (chunk) => {
            if (errorData.length < 64 * 1024) errorData += chunk.toString();
          });
          res.on('end', () => {
            let message = 'HTTP ' + res.statusCode;
            try {
              const providerError = JSON.parse(errorData).error;
              if (providerError) message = providerError.message || JSON.stringify(providerError);
            } catch (_) {}
            console.error('[AI] API Error:', message);
            if (stream) send('ai-stream-error', { requestId, message });
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              reject(new Error(message));
            }
          });
          return;
        }

        console.log('[AI] Response status:', res.statusCode, 'stream:', stream);
        if (stream) {
          let buffer = '';
          let pendingText = '';
          let pendingReasoning = '';
          let flushTimer = null;
          let outputBytes = 0;
          let streamFinished = false;
          const flush = () => {
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = null;
            if (!pendingText && !pendingReasoning) return;
            send('ai-chunk', { requestId, text: pendingText, reasoning: pendingReasoning });
            pendingText = '';
            pendingReasoning = '';
          };
          const stopTruncated = () => {
            if (streamFinished) return;
            streamFinished = true;
            flush();
            const message = 'AI response stopped after reaching the 2 MiB display safety limit';
            send('ai-stream-error', {
              requestId,
              code: 'ai.response.truncated',
              truncated: true,
              message
            });
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              resolve({ success: false, code: 'ai.response.truncated', truncated: true, error: message });
            }
            res.destroy();
          };
          const queueChunk = (text, reasoning) => {
            const chunkBytes = Buffer.byteLength(text || '', 'utf8') + Buffer.byteLength(reasoning || '', 'utf8');
            if (outputBytes + chunkBytes > maxStreamOutputBytes) {
              stopTruncated();
              return;
            }
            outputBytes += chunkBytes;
            pendingText += text || '';
            pendingReasoning += reasoning || '';
            if (!flushTimer) flushTimer = setTimeout(flush, AI_CHUNK_FLUSH_MS);
          };

          res.on('data', (chunk) => {
            if (streamFinished) return;
            buffer += chunk.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            if (Buffer.byteLength(buffer, 'utf8') > maxStreamOutputBytes) {
              stopTruncated();
              return;
            }
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const raw = line.trim();
              if (!raw || raw === 'data: [DONE]' || !raw.startsWith('data: ')) continue;
              try {
                const parsed = JSON.parse(raw.slice(6));
                let text = '';
                let reasoning = '';
                if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) text = parsed.delta.text;
                if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
                  text = parsed.choices[0].delta.content || '';
                  reasoning = parsed.choices[0].delta.reasoning_content || '';
                }
                if (text || reasoning) queueChunk(text, reasoning);
              } catch (error) {
                console.error('[AI] Stream parse error:', error.message);
              }
            }
          });
          res.on('end', () => {
            if (streamFinished) return;
            streamFinished = true;
            flush();
            console.log('[AI] Stream ended successfully');
            send('ai-stream-end', { requestId });
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              resolve({ success: true });
            }
          });
          res.on('error', (error) => {
            if (streamFinished) return;
            streamFinished = true;
            flush();
            console.error('[AI] Stream response error:', error.message);
            send('ai-stream-error', { requestId, message: error.message });
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
        } else {
          let data = '';
          let responseBytes = 0;
          res.on('data', (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_AI_RESPONSE_BYTES) {
              res.destroy(new Error('AI response exceeded the 16 MiB safety limit'));
              return;
            }
            data += chunk.toString();
          });
          res.on('end', () => {
            finishRequest(requestId, req);
            if (settled) return;
            settled = true;
            try {
              const parsed = JSON.parse(data);
              console.log('[AI] Non-stream response received, model:', parsed.model || '?');
              resolve({ success: true, data: parsed });
            } catch (error) {
              console.error('[AI] Non-stream JSON parse error:', error.message);
              resolve({ success: false, code: 'ai.error.connectionFailed', error: 'Provider returned invalid JSON' });
            }
          });
          res.on('error', (error) => {
            console.error('[AI] Non-stream response error:', error.message);
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
        }
      });

      req.on('timeout', () => {
        if (!settled) {
          settled = true;
          finishRequest(requestId, req);
          req.destroy();
          reject(new Error('Request timed out after 60s'));
        }
      });
      req.on('error', (error) => {
        finishRequest(requestId, req);
        if (!settled) {
          console.error('[AI] Request error:', error.message);
          if (stream) send('ai-stream-error', { requestId, message: error.message });
          settled = true;
          reject(error);
        }
      });
      if (stream) {
        if (activeChatRequest && activeChatRequest !== req) activeChatRequest.destroy();
        activeChatRequest = req;
      } else if (requestId) {
        activeInlineRequests.set(requestId, req);
        activeNonStreamRequests.set(req, lane);
      }
      try {
        req.end(body);
      } catch (error) {
        finishRequest(requestId, req);
        reject(error);
      }
    });
  }

  function cancel(requestId) {
    if (typeof requestId !== 'string' || !requestId) return { success: true, cancelled: false };
    const activeRequest = activeInlineRequests.get(requestId);
    if (!activeRequest) return { success: true, cancelled: false };
    activeInlineRequests.delete(requestId);
    activeRequest.destroy();
    return { success: true, cancelled: true };
  }

  function registerIpc() {
    ipcMain.handle('ai-chat-request', async (_event, payload) => {
      try {
        return await request(payload, { lane: 'chat' });
      } catch (error) {
        return { success: false, code: error.code || '', error: error.message };
      }
    });
    ipcMain.handle('ai-cancel-stream', async () => {
      try {
        if (activeChatRequest) {
          activeChatRequest.destroy();
          activeChatRequest = null;
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    ipcMain.handle('ai-inline-cancel', async (_event, requestId) => {
      try {
        return cancel(requestId);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    ipcMain.handle('ai-inline-request', async (_event, payload) => {
      try {
        return await request(Object.assign({}, payload, { stream: false }), { lane: 'inline' });
      } catch (error) {
        return { success: false, code: error.code || '', error: error.message };
      }
    });
    ipcMain.handle('ai-read-settings', async () => settings.readAiSettings());
    ipcMain.handle('ai-write-settings', async (_event, nextSettings) => settings.writeAiSettings(nextSettings));
    ipcMain.handle('ai-test-connection', async (_event, payload) => {
      try {
        return await request(Object.assign({}, payload, { stream: false }), { lane: 'test' });
      } catch (error) {
        return { success: false, code: error.code || '', error: error.message };
      }
    });
    ipcMain.handle('chat-history-read', async (_event, workspaceRoot) => settings.readChatHistory(workspaceRoot));
    ipcMain.handle('chat-history-write', async (_event, payload) => {
      return settings.writeChatHistory(payload.wsRoot, payload.data);
    });
  }

  function dispose() {
    if (activeChatRequest) activeChatRequest.destroy();
    activeChatRequest = null;
    for (const activeRequest of activeInlineRequests.values()) activeRequest.destroy();
    activeInlineRequests.clear();
    activeNonStreamRequests.clear();
  }

  return { registerIpc, request, cancel, dispose };
}

module.exports = {
  MAX_AI_REQUEST_BODY_BYTES,
  MAX_AI_REQUEST_INPUT_BYTES,
  createAiController,
  anthropicMessages,
  anthropicToolDefinitions,
  completionMessages,
  measureStructuredInput,
  normalizeToolDefinitions,
  resolveApiContract,
  validateRequestPayload
};
