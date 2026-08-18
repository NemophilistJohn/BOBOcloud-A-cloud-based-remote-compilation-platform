const http = require('http');
const https = require('https');

const MAX_AI_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_AI_STREAM_OUTPUT_BYTES = 2 * 1024 * 1024;
const AI_CHUNK_FLUSH_MS = 24;

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

function createAiController(options) {
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const settings = options.settings;
  const maxStreamOutputBytes = Number.isSafeInteger(options.maxStreamOutputBytes) && options.maxStreamOutputBytes > 0
    ? options.maxStreamOutputBytes
    : MAX_AI_STREAM_OUTPUT_BYTES;
  let activeChatRequest = null;
  const activeInlineRequests = new Map();

  function send(channel, payload) {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  function finishRequest(requestId, request) {
    if (requestId && activeInlineRequests.get(requestId) === request) activeInlineRequests.delete(requestId);
    if (activeChatRequest === request) activeChatRequest = null;
  }

  function request(payload) {
    return new Promise((resolve, reject) => {
      payload = payload || {};
      const { modelConfig } = payload;
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const stream = payload.stream === true;
      const requestId = typeof payload.requestId === 'string' ? payload.requestId.slice(0, 120) : '';
      const mode = payload.mode === 'fim' ? 'fim' : 'chat';
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
      const temperature = clampNumber(payload.temperature, clampNumber(modelOptions.temperature, mode === 'fim' ? 0 : 0.2, 0, 2), 0, 2);
      const topP = clampNumber(payload.topP, clampNumber(modelOptions.top_p, 1, 0, 1), 0, 1);
      const stop = normalizeStop(payload.stop, modelOptions.stop);
      const nativeFim = mode === 'fim' && resolveApiContract(payload, url) === 'fim';
      const effectiveMessages = mode === 'fim' && !nativeFim ? completionMessages(payload) : messages;
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
        const chatMessages = effectiveMessages.filter((message) => message.role !== 'system');
        body = JSON.stringify({
          model: modelConfig.modelId,
          max_tokens: clampInteger(payload.maxTokens, mode === 'fim' ? 160 : 4096, 1, 32768),
          stream,
          temperature,
          top_p: topP,
          stop_sequences: stop.length ? stop : undefined,
          system: systemMessage ? systemMessage.content : undefined,
          messages: chatMessages
        });
      } else {
        body = JSON.stringify(Object.assign({}, modelOptions, {
          model: modelConfig.modelId,
          max_tokens: clampInteger(payload.maxTokens, mode === 'fim' ? 160 : 4096, 1, 32768),
          stream,
          messages: effectiveMessages,
          temperature,
          top_p: topP,
          stop: stop.length ? stop : undefined
        }));
      }

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: 60000
      };
      let settled = false;

      const req = transport.request(requestOptions, (res) => {
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
        const previous = activeInlineRequests.get(requestId);
        if (previous && previous !== req) previous.destroy();
        activeInlineRequests.set(requestId, req);
      }
      req.end(body);
    });
  }

  function registerIpc() {
    ipcMain.handle('ai-chat-request', async (_event, payload) => {
      try {
        return await request(payload);
      } catch (error) {
        return { success: false, error: error.message };
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
        if (typeof requestId !== 'string' || !requestId) return { success: true, cancelled: false };
        const activeRequest = activeInlineRequests.get(requestId);
        if (!activeRequest) return { success: true, cancelled: false };
        activeInlineRequests.delete(requestId);
        activeRequest.destroy();
        return { success: true, cancelled: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    ipcMain.handle('ai-inline-request', async (_event, payload) => {
      try {
        return await request(Object.assign({}, payload, { stream: false }));
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    ipcMain.handle('ai-read-settings', async () => settings.readAiSettings());
    ipcMain.handle('ai-write-settings', async (_event, nextSettings) => settings.writeAiSettings(nextSettings));
    ipcMain.handle('ai-test-connection', async (_event, payload) => {
      try {
        return await request(Object.assign({}, payload, { stream: false }));
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    ipcMain.handle('chat-history-read', async (_event, workspaceRoot) => settings.readChatHistory(workspaceRoot));
    ipcMain.handle('chat-history-write', async (_event, payload) => {
      settings.writeChatHistory(payload.wsRoot, payload.data);
      return true;
    });
  }

  function dispose() {
    if (activeChatRequest) activeChatRequest.destroy();
    activeChatRequest = null;
    for (const activeRequest of activeInlineRequests.values()) activeRequest.destroy();
    activeInlineRequests.clear();
  }

  return { registerIpc, request, dispose };
}

module.exports = { createAiController, completionMessages, resolveApiContract };
