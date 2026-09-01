const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

const MAX_AI_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_AI_STREAM_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_AI_REQUEST_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_AI_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MAX_AI_REQUEST_DEPTH = 32;
const MAX_AI_REQUEST_NODES = 20_000;
const MAX_AI_MESSAGES = 96;
const MAX_AI_TOOLS = 48;
const MAX_AI_OUTPUT_TOKENS = 262_144;
const DEFAULT_MAX_NON_STREAM_REQUESTS = 8;
const DEFAULT_LANE_LIMITS = Object.freeze({ chat: 1, inline: 2, test: 1, agent: 4 });
const AI_CHUNK_FLUSH_MS = 24;
const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const REASONING_EFFORT_SET = new Set(REASONING_EFFORTS);

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
  if (Object.prototype.hasOwnProperty.call(payload, 'onEvent') && payload.onEvent !== undefined && typeof payload.onEvent !== 'function') {
    throw requestError('AI request event handler is invalid', 'AI_REQUEST_INVALID');
  }
  if (Array.isArray(payload.messages) && payload.messages.length > MAX_AI_MESSAGES) {
    throw requestError('AI request has too many messages', 'AI_REQUEST_TOO_LARGE');
  }
  if (Array.isArray(payload.tools) && payload.tools.length > MAX_AI_TOOLS) {
    throw requestError('AI request has too many tools', 'AI_REQUEST_TOO_LARGE');
  }
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  if ((requestId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(requestId)) ||
      (!requestId && payload.stream === true)) {
    throw requestError('AI request id is invalid', 'AI_REQUEST_INVALID');
  }
  if (typeof payload.onEvent === 'function') {
    const measurable = Object.assign({}, payload);
    delete measurable.onEvent;
    measureStructuredInput(measurable);
  } else {
    measureStructuredInput(payload);
  }
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeProviderId(profile) {
  const value = String(profile && (profile.providerId || profile.provider) || '').trim().toLowerCase();
  if (value === 'anthropic' || value === 'claude') return 'anthropic';
  if (value === 'openai') return 'openai';
  if (value === 'deepseek') return 'deepseek';
  if (value === 'glm' || value === 'zhipu' || value === 'zhipuai') return 'glm';
  if (value === 'kimi' || value === 'moonshot' || value === 'moonshotai') return 'kimi';
  if (value === 'qwen' || value === 'dashscope' || value === 'alibaba') return 'qwen';
  return 'custom';
}

function normalizeProtocol(profile, providerId) {
  if (providerId === 'anthropic') return 'messages';
  const value = String(profile && profile.protocol || '').trim().toLowerCase();
  if (value === 'messages' || value === 'anthropic-messages') return 'messages';
  if (value === 'responses' || value === 'openai-responses') return 'responses';
  return 'chat-completions';
}

function modelSettings(profile) {
  return Object.assign(
    {},
    isPlainObject(profile && profile.options) ? profile.options : {},
    isPlainObject(profile && profile.settings) ? profile.settings : {}
  );
}

function resolveReasoning(profile, requestedValue, providerId, settings) {
  const requested = REASONING_EFFORT_SET.has(requestedValue) ? requestedValue : '';
  if (!requested) return { requested: 'none', effective: 'none' };
  const capabilities = isPlainObject(profile && profile.capabilities) ? profile.capabilities : {};
  const supported = Array.isArray(capabilities.reasoningEfforts)
    ? capabilities.reasoningEfforts.filter((effort) => REASONING_EFFORT_SET.has(effort))
    : [];
  const effortMap = isPlainObject(capabilities.effectiveEffortMap)
    ? capabilities.effectiveEffortMap
    : (isPlainObject(profile && profile.effectiveEffortMap) ? profile.effectiveEffortMap : {});
  let effective = 'none';
  if (Object.prototype.hasOwnProperty.call(effortMap, requested)) {
    const mapped = effortMap[requested];
    effective = REASONING_EFFORT_SET.has(mapped) ? mapped : 'none';
  } else if (supported.includes(requested)) {
    effective = requested;
  } else if (!supported.length) {
    const configuredThinking = isPlainObject(settings.thinking) && settings.thinking.type !== 'disabled';
    const legacyExplicit = settings.enableReasoningEffort === true ||
      settings.enableThinking === true ||
      settings.enable_thinking === true ||
      REASONING_EFFORT_SET.has(settings.reasoning_effort) ||
      configuredThinking ||
      ['adaptive', 'enabled'].includes(String(settings.thinkingMode || '').toLowerCase());
    if (legacyExplicit) effective = requested;
  }
  const thinkingMode = String(settings.thinkingMode || '').trim().toLowerCase();
  if (providerId === 'anthropic' && thinkingMode === 'adaptive' && effective === 'xhigh') effective = 'high';
  return { requested, effective };
}

function reasoningMetadata(reasoning) {
  return {
    requestedReasoningEffort: reasoning.requested,
    effectiveReasoningEffort: reasoning.effective
  };
}

function attachReasoningMetadata(data, reasoning) {
  return isPlainObject(data) ? Object.assign({}, data, reasoningMetadata(reasoning)) : data;
}

function successResponse(data, reasoning) {
  return Object.assign({ success: true, data }, reasoningMetadata(reasoning));
}

function normalizeUsage(value) {
  if (!isPlainObject(value)) return null;
  const number = (input) => {
    if (input === undefined || input === null || input === '') return null;
    return Number.isFinite(Number(input)) && Number(input) >= 0 ? Math.round(Number(input)) : null;
  };
  let inputTokens = number(value.input_tokens !== undefined ? value.input_tokens : value.prompt_tokens);
  const cacheCreationTokens = number(value.cache_creation_input_tokens);
  const cacheReadTokens = number(value.cache_read_input_tokens);
  if (value.prompt_tokens === undefined && (cacheCreationTokens !== null || cacheReadTokens !== null)) {
    inputTokens = (inputTokens || 0) + (cacheCreationTokens || 0) + (cacheReadTokens || 0);
  }
  const outputTokens = number(value.output_tokens !== undefined ? value.output_tokens : value.completion_tokens);
  const reasoningTokens = number(value.reasoning_tokens !== undefined
    ? value.reasoning_tokens
    : value.completion_tokens_details && value.completion_tokens_details.reasoning_tokens);
  const cachedInputTokens = number(value.cached_input_tokens !== undefined
    ? value.cached_input_tokens
    : (value.cache_read_input_tokens !== undefined
        ? value.cache_read_input_tokens
        : (value.prompt_cache_hit_tokens !== undefined
            ? value.prompt_cache_hit_tokens
            : value.prompt_tokens_details && value.prompt_tokens_details.cached_tokens)));
  let totalTokens = number(value.total_tokens);
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) totalTokens = inputTokens + outputTokens;
  if ([inputTokens, outputTokens, reasoningTokens, cachedInputTokens, totalTokens].every((item) => item === null)) return null;
  const result = {};
  if (inputTokens !== null) result.inputTokens = inputTokens;
  if (outputTokens !== null) result.outputTokens = outputTokens;
  if (reasoningTokens !== null) result.reasoningTokens = reasoningTokens;
  if (cachedInputTokens !== null) result.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== null) result.totalTokens = totalTokens;
  return result;
}

function providerStreamError(value) {
  const detail = value && value.error;
  const message = detail && (detail.message || detail.type) || 'Provider returned a stream error';
  return requestError(String(message), 'AI_PROVIDER_STREAM_ERROR');
}

function createOpenAiStreamAccumulator() {
  const state = {
    id: '',
    object: 'chat.completion',
    created: undefined,
    model: '',
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    toolCalls: new Map()
  };
  return {
    consume(value) {
      if (value && value.error) throw providerStreamError(value);
      if (typeof value.id === 'string') state.id = value.id;
      if (typeof value.model === 'string') state.model = value.model;
      if (Number.isFinite(value.created)) state.created = value.created;
      if (isPlainObject(value.usage)) state.usage = Object.assign({}, state.usage || {}, value.usage);
      const events = [];
      const choice = Array.isArray(value.choices) ? value.choices.find((item) => !item || item.index === undefined || item.index === 0) : null;
      if (choice) {
        const delta = isPlainObject(choice.delta) ? choice.delta : {};
        const content = typeof delta.content === 'string' ? delta.content : '';
        const reasoning = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : (typeof delta.reasoning === 'string' ? delta.reasoning : (typeof delta.thinking === 'string' ? delta.thinking : ''));
        if (content) {
          state.content += content;
          events.push({ type: 'content.delta', delta: content });
        }
        if (reasoning) {
          state.reasoning += reasoning;
          events.push({ type: 'reasoning.delta', delta: reasoning });
        }
        const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (let offset = 0; offset < toolDeltas.length; offset += 1) {
          const toolDelta = toolDeltas[offset] || {};
          const index = Number.isSafeInteger(toolDelta.index) && toolDelta.index >= 0 ? toolDelta.index : offset;
          if (index > 31) continue;
          const previous = state.toolCalls.get(index) || { id: '', name: '', arguments: '' };
          const functionDelta = isPlainObject(toolDelta.function) ? toolDelta.function : {};
          const id = typeof toolDelta.id === 'string' ? toolDelta.id : '';
          const nameDelta = typeof functionDelta.name === 'string' ? functionDelta.name : '';
          const argumentsDelta = typeof functionDelta.arguments === 'string' ? functionDelta.arguments : '';
          if (id) previous.id = id;
          if (nameDelta) previous.name += nameDelta;
          if (argumentsDelta) previous.arguments += argumentsDelta;
          state.toolCalls.set(index, previous);
          if (id || nameDelta || argumentsDelta) {
            events.push({
              type: 'tool_call.delta',
              index,
              id: previous.id,
              name: previous.name,
              argumentsDelta
            });
          }
        }
        if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
      }
      const usage = normalizeUsage(value.usage);
      if (usage) events.push({ type: 'usage', usage });
      return events;
    },
    result(reasoning) {
      const toolCalls = [...state.toolCalls.entries()].sort((left, right) => left[0] - right[0]).map(([, call], index) => ({
        id: call.id || 'tool-call-' + index,
        type: 'function',
        function: { name: call.name, arguments: call.arguments }
      }));
      const message = { role: 'assistant', content: state.content };
      if (state.reasoning) message.reasoning_content = state.reasoning;
      if (toolCalls.length) message.tool_calls = toolCalls;
      const data = {
        id: state.id || undefined,
        object: state.object,
        created: state.created,
        model: state.model || undefined,
        choices: [{ index: 0, message, finish_reason: state.finishReason }],
        usage: state.usage || undefined
      };
      return attachReasoningMetadata(data, reasoning);
    }
  };
}

function createAnthropicStreamAccumulator() {
  const state = {
    id: '',
    model: '',
    role: 'assistant',
    stopReason: null,
    stopSequence: null,
    usage: {},
    blocks: new Map()
  };
  function blockAt(index, fallbackType) {
    const existing = state.blocks.get(index);
    if (existing) return existing;
    const block = { type: fallbackType || 'text', text: '', thinking: '', signature: '', inputJson: '', id: '', name: '' };
    state.blocks.set(index, block);
    return block;
  }
  return {
    consume(value) {
      if (value && value.type === 'error') throw providerStreamError(value);
      const events = [];
      if (value && value.type === 'message_start' && isPlainObject(value.message)) {
        const message = value.message;
        state.id = typeof message.id === 'string' ? message.id : state.id;
        state.model = typeof message.model === 'string' ? message.model : state.model;
        state.role = typeof message.role === 'string' ? message.role : state.role;
        if (isPlainObject(message.usage)) Object.assign(state.usage, message.usage);
      } else if (value && value.type === 'content_block_start' && isPlainObject(value.content_block)) {
        const source = value.content_block;
        const index = Number.isSafeInteger(value.index) && value.index >= 0 ? value.index : state.blocks.size;
        const block = blockAt(index, source.type);
        block.type = source.type || block.type;
        block.id = typeof source.id === 'string' ? source.id : '';
        block.name = typeof source.name === 'string' ? source.name : '';
        if (typeof source.text === 'string' && source.text) {
          block.text += source.text;
          events.push({ type: 'content.delta', delta: source.text });
        }
        if (typeof source.thinking === 'string' && source.thinking) {
          block.thinking += source.thinking;
          events.push({ type: 'reasoning.delta', delta: source.thinking });
        }
        if (block.type === 'tool_use') {
          if (index <= 31) events.push({ type: 'tool_call.delta', index, id: block.id, name: block.name, argumentsDelta: '' });
        }
      } else if (value && value.type === 'content_block_delta' && isPlainObject(value.delta)) {
        const index = Number.isSafeInteger(value.index) && value.index >= 0 ? value.index : 0;
        const delta = value.delta;
        const block = blockAt(index, delta.type === 'thinking_delta' ? 'thinking' : (delta.type === 'input_json_delta' ? 'tool_use' : 'text'));
        if (typeof delta.text === 'string' && delta.text) {
          block.text += delta.text;
          events.push({ type: 'content.delta', delta: delta.text });
        }
        if (typeof delta.thinking === 'string' && delta.thinking) {
          block.thinking += delta.thinking;
          events.push({ type: 'reasoning.delta', delta: delta.thinking });
        }
        if (typeof delta.signature === 'string') block.signature += delta.signature;
        if (typeof delta.partial_json === 'string' && delta.partial_json) {
          block.inputJson += delta.partial_json;
          if (index <= 31) events.push({ type: 'tool_call.delta', index, id: block.id, name: block.name, argumentsDelta: delta.partial_json });
        }
      } else if (value && value.type === 'message_delta') {
        if (isPlainObject(value.delta)) {
          if (typeof value.delta.stop_reason === 'string') state.stopReason = value.delta.stop_reason;
          if (typeof value.delta.stop_sequence === 'string') state.stopSequence = value.delta.stop_sequence;
        }
        if (isPlainObject(value.usage)) Object.assign(state.usage, value.usage);
      }
      const rawUsage = value && value.type === 'message_start' && value.message && value.message.usage
        ? value.message.usage
        : value && value.usage;
      const usage = normalizeUsage(rawUsage);
      if (usage) events.push({ type: 'usage', usage });
      return events;
    },
    result(reasoning) {
      const content = [...state.blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, block]) => {
        if (block.type === 'thinking') {
          const result = { type: 'thinking', thinking: block.thinking };
          if (block.signature) result.signature = block.signature;
          return result;
        }
        if (block.type === 'tool_use') {
          let input = {};
          try {
            const parsed = JSON.parse(block.inputJson || '{}');
            if (isPlainObject(parsed)) input = parsed;
          } catch (_) {}
          return { type: 'tool_use', id: block.id, name: block.name, input };
        }
        return { type: 'text', text: block.text };
      });
      return attachReasoningMetadata({
        id: state.id || undefined,
        type: 'message',
        role: state.role,
        model: state.model || undefined,
        content,
        stop_reason: state.stopReason,
        stop_sequence: state.stopSequence,
        usage: Object.keys(state.usage).length ? state.usage : undefined
      }, reasoning);
    }
  };
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
  let anonymousRequestSequence = 0;

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
      const requestId = payload.requestId || 'anonymous-' + (++anonymousRequestSequence);
      const onEvent = typeof requestOptions.onEvent === 'function'
        ? requestOptions.onEvent
        : (typeof payload.onEvent === 'function' ? payload.onEvent : null);
      let modelEventsClosed = false;
      let modelErrorEmitted = false;
      const emitModelEvent = (event) => {
        if (!onEvent || modelEventsClosed) return;
        onEvent(event);
      };
      const emitModelError = (error, detail = {}) => {
        if (!onEvent || modelEventsClosed || modelErrorEmitted) return;
        modelErrorEmitted = true;
        try {
          emitModelEvent(Object.assign({
            type: 'error',
            code: error && error.code || '',
            message: error && error.message || String(error || 'AI stream failed')
          }, detail));
        } catch (_) {}
      };
      const closeModelEvents = () => { modelEventsClosed = true; };
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
      const providerId = normalizeProviderId(modelConfig);
      const protocol = normalizeProtocol(modelConfig, providerId);
      const modelOptions = isPlainObject(modelConfig.options) ? modelConfig.options : {};
      const settings = modelSettings(modelConfig);
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'BOBOCLOUD-Editor/2.0'
      };
      if (providerId === 'anthropic') {
        if (String(modelConfig.authType || '').toLowerCase() === 'bearer') headers.Authorization = 'Bearer ' + apiKey;
        else headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = String(modelConfig.apiVersion || settings.apiVersion || '2023-06-01');
      } else {
        headers.Authorization = 'Bearer ' + apiKey;
        if (providerId === 'openai' && modelConfig.organizationId) headers['OpenAI-Organization'] = String(modelConfig.organizationId);
        if (providerId === 'openai' && modelConfig.projectId) headers['OpenAI-Project'] = String(modelConfig.projectId);
      }

      const providerOptions = Object.assign({}, modelOptions);
      for (const key of [
        'enableReasoningEffort', 'enableThinking', 'thinkingMode', 'reasoningMode',
        'reasoningWire', 'reasoningProtocol', 'adaptiveThinking', 'apiVersion',
        'reasoning_effort', 'thinking', 'enable_thinking'
      ]) delete providerOptions[key];
      const temperature = clampNumber(payload.temperature, clampNumber(modelOptions.temperature, mode === 'fim' ? 0 : 0.2, 0, 2), 0, 2);
      const topP = clampNumber(payload.topP, clampNumber(modelOptions.top_p, 1, 0, 1), 0, 1);
      const stop = normalizeStop(payload.stop, modelOptions.stop);
      const nativeFim = mode === 'fim' && resolveApiContract(payload, url) === 'fim';
      const effectiveMessages = mode === 'fim' && !nativeFim ? completionMessages(payload) : messages;
      const tools = normalizeToolDefinitions(payload.tools);
      let reasoning = resolveReasoning(modelConfig, payload.reasoningEffort, providerId, settings);
      let body;
      if (nativeFim) {
        reasoning = { requested: reasoning.requested, effective: 'none' };
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
      } else if (providerId === 'anthropic' || protocol === 'messages') {
        const systemMessage = effectiveMessages.find((message) => message.role === 'system');
        const chatMessages = anthropicMessages(effectiveMessages);
        const maxTokens = clampInteger(payload.maxTokens, mode === 'fim' ? 160 : 4096, 1, MAX_AI_OUTPUT_TOKENS);
        let thinkingMode = String(settings.thinkingMode || '').trim().toLowerCase();
        if (!thinkingMode && settings.adaptiveThinking === true) thinkingMode = 'adaptive';
        if (!thinkingMode && settings.enableThinking === true) thinkingMode = 'enabled';
        if (reasoning.effective === 'none' || !['adaptive', 'enabled'].includes(thinkingMode)) thinkingMode = '';
        if (thinkingMode === 'enabled' && maxTokens <= 1024) {
          thinkingMode = '';
          reasoning = { requested: reasoning.requested, effective: 'none' };
        }
        const desiredBudget = reasoning.effective === 'max' ? 16000
          : reasoning.effective === 'xhigh' ? 12000
            : reasoning.effective === 'high' ? 8000
              : reasoning.effective === 'medium' ? 4000 : 1600;
        const thinking = thinkingMode === 'adaptive'
          ? { type: 'adaptive' }
          : (thinkingMode === 'enabled'
              ? { type: 'enabled', budget_tokens: Math.max(1024, Math.min(desiredBudget, maxTokens - 1)) }
              : undefined);
        if (!thinking) reasoning = { requested: reasoning.requested, effective: 'none' };
        body = JSON.stringify({
          model: modelConfig.modelId,
          max_tokens: maxTokens,
          stream,
          temperature: thinking ? undefined : temperature,
          top_p: thinking ? undefined : topP,
          stop_sequences: stop.length ? stop : undefined,
          system: systemMessage ? systemMessage.content : undefined,
          messages: chatMessages,
          tools: tools.length ? anthropicToolDefinitions(tools) : undefined,
          thinking,
          output_config: thinkingMode === 'adaptive' ? { effort: reasoning.effective } : undefined
        });
      } else {
        const maxTokens = clampInteger(payload.maxTokens, mode === 'fim' ? 160 : 4096, 1, MAX_AI_OUTPUT_TOKENS);
        const requestBody = Object.assign({}, providerOptions, {
          model: modelConfig.modelId,
          stream,
          messages: effectiveMessages,
          temperature,
          top_p: topP,
          stop: stop.length ? stop : undefined,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined
        });
        if (providerId === 'openai' || providerId === 'kimi') requestBody.max_completion_tokens = maxTokens;
        else requestBody.max_tokens = maxTokens;
        if (reasoning.effective !== 'none') {
          const configuredReasoningWire = String(settings.reasoningWire || settings.reasoningProtocol || settings.reasoningMode || '').trim().toLowerCase();
          const reasoningWire = configuredReasoningWire || (providerId === 'glm' ? 'thinking' : '');
          if (reasoningWire === 'thinking') {
            requestBody.thinking = isPlainObject(settings.thinking)
              ? Object.assign({}, settings.thinking)
              : { type: 'enabled' };
          } else {
            requestBody.reasoning_effort = reasoning.effective;
            if (reasoningWire === 'enable_thinking' || settings.enable_thinking === true ||
                (providerId === 'qwen' && settings.enableThinking === true)) {
              requestBody.enable_thinking = true;
            }
          }
        }
        body = JSON.stringify(requestBody);
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_AI_REQUEST_BODY_BYTES) {
        reject(requestError('AI request exceeds the 4 MiB provider body limit', 'AI_REQUEST_TOO_LARGE'));
        return;
      }

      const isChatStream = stream && lane === 'chat';
      if (!isChatStream) {
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
            const error = requestError(message, 'AI_PROVIDER_HTTP_ERROR');
            if (stream) {
              emitModelError(error, { statusCode: res.statusCode });
              send('ai-stream-error', { requestId, message });
            }
            closeModelEvents();
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
          return;
        }

        console.log('[AI] Response status:', res.statusCode, 'stream:', stream);
        if (stream) {
          const accumulator = providerId === 'anthropic' || protocol === 'messages'
            ? createAnthropicStreamAccumulator()
            : createOpenAiStreamAccumulator();
          const decoder = new StringDecoder('utf8');
          let buffer = '';
          let dataLines = [];
          let pendingText = '';
          let pendingReasoning = '';
          let flushTimer = null;
          let outputBytes = 0;
          let responseBytes = 0;
          let streamFinished = false;
          let providerDone = false;
          const flush = () => {
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = null;
            if (!pendingText && !pendingReasoning) return;
            send('ai-chunk', { requestId, text: pendingText, reasoning: pendingReasoning });
            pendingText = '';
            pendingReasoning = '';
          };
          const failStream = (error, detail = {}, resolveFailure = null) => {
            if (streamFinished) return;
            streamFinished = true;
            flush();
            emitModelError(error, detail);
            send('ai-stream-error', Object.assign({
              requestId,
              code: error && error.code || '',
              message: error && error.message || String(error || 'AI stream failed')
            }, detail));
            closeModelEvents();
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              if (resolveFailure) resolve(resolveFailure);
              else reject(error);
            }
            res.destroy();
          };
          const stopTruncated = () => {
            const message = 'AI response stopped after reaching the 2 MiB display safety limit';
            const error = requestError(message, 'ai.response.truncated');
            failStream(error, { truncated: true }, {
              success: false,
              code: 'ai.response.truncated',
              truncated: true,
              error: message
            });
          };
          const deliverEvent = (event) => {
            const chunkBytes = event.type === 'content.delta' || event.type === 'reasoning.delta'
              ? Buffer.byteLength(event.delta || '', 'utf8')
              : (event.type === 'tool_call.delta'
                  ? Buffer.byteLength(event.name || '', 'utf8') + Buffer.byteLength(event.argumentsDelta || '', 'utf8')
                  : 0);
            if (outputBytes + chunkBytes > maxStreamOutputBytes) {
              stopTruncated();
              return false;
            }
            outputBytes += chunkBytes;
            if (event.type === 'content.delta') pendingText += event.delta || '';
            if (event.type === 'reasoning.delta') pendingReasoning += event.delta || '';
            if ((event.type === 'content.delta' || event.type === 'reasoning.delta') && !flushTimer) {
              flushTimer = setTimeout(flush, AI_CHUNK_FLUSH_MS);
            }
            emitModelEvent(event);
            return true;
          };
          const dispatchData = (rawData) => {
            if (providerDone || streamFinished || settled) return;
            const raw = rawData.trim();
            if (!raw) return;
            if (raw === '[DONE]') {
              providerDone = true;
              return;
            }
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch (_) {
              throw requestError('Provider returned malformed stream data', 'AI_PROVIDER_STREAM_INVALID');
            }
            const events = accumulator.consume(parsed);
            for (const event of events) {
              if (!deliverEvent(event)) break;
            }
          };
          const dispatchPendingEvent = () => {
            if (!dataLines.length) return;
            const rawData = dataLines.join('\n');
            dataLines = [];
            dispatchData(rawData);
          };
          const processLine = (line) => {
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (!line) {
              dispatchPendingEvent();
              return;
            }
            if (line.startsWith(':')) return;
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          };
          const consumeDecodedText = (text) => {
            buffer += text;
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              processLine(line);
              if (streamFinished) return;
              newline = buffer.indexOf('\n');
            }
          };

          res.on('data', (chunk) => {
            if (streamFinished || settled) return;
            responseBytes += chunk.length;
            if (responseBytes > MAX_AI_RESPONSE_BYTES) {
              failStream(requestError('AI stream exceeded the 16 MiB provider response limit', 'AI_RESPONSE_TOO_LARGE'));
              return;
            }
            try {
              consumeDecodedText(decoder.write(chunk));
            } catch (error) {
              console.error('[AI] Stream parse error:', error.message);
              failStream(error);
            }
          });
          res.on('end', () => {
            if (streamFinished) return;
            try {
              consumeDecodedText(decoder.end());
              if (buffer) processLine(buffer);
              buffer = '';
              dispatchPendingEvent();
            } catch (error) {
              console.error('[AI] Stream parse error:', error.message);
              failStream(error);
              return;
            }
            if (streamFinished || settled) return;
            streamFinished = true;
            flush();
            console.log('[AI] Stream ended successfully');
            send('ai-stream-end', { requestId });
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              const data = accumulator.result(reasoning);
              closeModelEvents();
              resolve(successResponse(data, reasoning));
            }
          });
          res.on('error', (error) => {
            if (streamFinished) return;
            console.error('[AI] Stream response error:', error.message);
            failStream(error);
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
              const normalized = attachReasoningMetadata(parsed, reasoning);
              closeModelEvents();
              resolve(successResponse(normalized, reasoning));
            } catch (error) {
              console.error('[AI] Non-stream JSON parse error:', error.message);
              closeModelEvents();
              resolve({ success: false, code: 'ai.error.connectionFailed', error: 'Provider returned invalid JSON' });
            }
          });
          res.on('error', (error) => {
            console.error('[AI] Non-stream response error:', error.message);
            finishRequest(requestId, req);
            if (!settled) {
              settled = true;
              closeModelEvents();
              reject(error);
            }
          });
        }
      });

      req.on('timeout', () => {
        if (!settled) {
          const error = requestError('Request timed out after 60s', 'AI_REQUEST_TIMEOUT');
          if (stream) {
            emitModelError(error);
            send('ai-stream-error', { requestId, code: error.code, message: error.message });
          }
          closeModelEvents();
          settled = true;
          finishRequest(requestId, req);
          req.destroy();
          reject(error);
        }
      });
      req.on('error', (error) => {
        finishRequest(requestId, req);
        if (!settled) {
          console.error('[AI] Request error:', error.message);
          if (stream) {
            emitModelError(error);
            send('ai-stream-error', { requestId, code: error.code || '', message: error.message });
          }
          closeModelEvents();
          settled = true;
          reject(error);
        }
      });
      if (isChatStream) {
        if (activeChatRequest && activeChatRequest !== req) activeChatRequest.destroy();
        activeChatRequest = req;
      } else if (requestId) {
        activeInlineRequests.set(requestId, req);
        activeNonStreamRequests.set(req, lane);
      }
      try {
        if (stream) {
          emitModelEvent(Object.assign({ type: 'response.started' }, reasoningMetadata(reasoning)));
        }
        req.end(body);
      } catch (error) {
        finishRequest(requestId, req);
        if (stream) emitModelError(error);
        closeModelEvents();
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
  MAX_AI_OUTPUT_TOKENS,
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
