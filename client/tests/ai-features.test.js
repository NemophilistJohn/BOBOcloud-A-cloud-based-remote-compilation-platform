'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { completionMessages, resolveApiContract } = require('../main/ai');

const projectRoot = path.resolve(__dirname, '..');

function profile(id, purpose = 'chat', overrides = {}) {
  const value = {
    id,
    name: id,
    provider: 'openai-compatible',
    apiKey: 'mock-key',
    endpoint: `https://${id}.example/${purpose === 'inline' ? 'beta/completions' : 'v1/chat/completions'}`,
    modelId: `${id}-${purpose}`,
    mode: purpose === 'inline' ? 'fim' : 'chat',
    options: { connection: purpose }
  };
  return Object.assign(value, overrides);
}

function settings(overrides = {}) {
  const value = {
    schemaVersion: 3,
    chatProfiles: [profile('chat-profile', 'chat')],
    inlineProfiles: [profile('inline-profile', 'inline')],
    chatProfileId: 'chat-profile',
    inlineProfileId: 'inline-profile',
    globalInstructions: 'Follow repository conventions.',
    chat: {
      instructions: 'Cite the relevant file.',
      parameters: { maxTokens: 1234, temperature: 0.35, topP: 0.8, stop: ['CHAT_STOP'] },
      context: {
        maxInputChars: 8000,
        currentFileChars: 2200,
        selectionChars: 900,
        projectChars: 700,
        referencedFileChars: 600,
        maxReferencedFiles: 2,
        historyMessages: 3,
        historyMessageChars: 500
      }
    },
    inline: {
      enabled: true,
      instructions: 'Continue with the local naming style.',
      debounceMs: 150,
      parameters: { maxTokens: 96, temperature: 0.05, topP: 0.6, stop: ['INLINE_STOP'] },
      context: { prefixChars: 500, suffixChars: 0 }
    },
    chatOpen: false
  };
  return Object.assign(value, overrides);
}

function loadAiCore(overrides = {}) {
  const calls = { inline: [], cancelInline: [], chat: [], writes: [], tests: [] };
  const listeners = {};
  const api = {
    aiReadSettings: async () => settings(),
    aiWriteSettings: async value => { calls.writes.push(value); return true; },
    aiChatRequest: async payload => { calls.chat.push(payload); return { success: true }; },
    aiInlineRequest: async payload => {
      calls.inline.push(payload);
      return { success: true, data: { choices: [{ text: 'suggestion' }] } };
    },
    aiCancelInline: requestId => { calls.cancelInline.push(requestId); return Promise.resolve({ success: true }); },
    aiCancelStream: async () => ({ success: true }),
    aiTestConnection: async payload => {
      calls.tests.push(payload);
      return payload.mode === 'fim'
        ? { success: true, data: { choices: [{ text: 'OK' }] } }
        : { success: true, data: { choices: [{ message: { content: 'OK' } }] } };
    },
    onAiChunk: callback => { listeners.chunk = callback; },
    onAiStreamEnd: callback => { listeners.end = callback; },
    onAiStreamError: callback => { listeners.error = callback; }
  };
  Object.assign(api, overrides.api || {});

  const window = { api, BOBO: { state: { ai: {} } } };
  const context = vm.createContext({ window, console, Map, Date, Promise, setTimeout, clearTimeout });
  ['ai-settings-schema.js', 'ai-prompts.js'].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, 'src', file), 'utf8'), context, { filename: `src/${file}` });
  });
  const canonical = window.BOBO.aiSettingsSchema.normalizeSettings(overrides.settings || settings());
  Object.assign(window.BOBO.state.ai, canonical, {
    status: 'idle',
    inlineStatus: 'idle',
    chatStreaming: false,
    chatMessages: overrides.chatMessages || [],
    referencedFiles: [],
    excludedAutoContextPaths: [],
    connectionHealth: { chat: {}, inline: {} }
  });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'src', 'ai-service.js'), 'utf8'), context, { filename: 'src/ai-service.js' });
  return {
    service: window.BOBO.aiService,
    schema: window.BOBO.aiSettingsSchema,
    prompts: window.BOBO.aiPrompts,
    state: window.BOBO.state.ai,
    calls,
    listeners
  };
}

test('runtime has no bundled preset dependency and requires explicit profile selection', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'main', 'ai.js'), 'utf8');
  assert.doesNotMatch(source, /ai-models\.json/);
  assert.doesNotMatch(source, /loadAiPresets/);

  const fixture = loadAiCore({ settings: settings({ chatProfileId: '', inlineProfileId: '' }) });
  assert.equal(fixture.service.getProfileFor('chat'), null);
  assert.equal(fixture.service.getProfileFor('inline'), null);
});

test('inline requests use messages when the configured endpoint is chat completions', () => {
  const payload = { mode: 'fim', prompt: '', suffix: '' };
  assert.equal(resolveApiContract(payload, new URL('https://api.deepseek.com/chat/completions')), 'chat');
  assert.equal(resolveApiContract(payload, new URL('https://api.deepseek.com/beta/completions')), 'fim');

  const messages = completionMessages(payload);
  assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
  assert.match(messages[1].content, /Prefix:\n\n\nSuffix:\n/);
});

test('chat and inline use independent profiles, parameters, and context budgets', () => {
  const fixture = loadAiCore();
  const chatPayload = fixture.service.buildChatPayload(
    fixture.service.getProfileFor('chat'),
    'Review this.',
    { currentFile: { path: 'main.go', language: 'go', content: 'x'.repeat(5000) } },
    'chat-1',
    false
  );
  const inlinePayload = fixture.service.buildInlineRequest(
    fixture.service.getProfileFor('inline'),
    { codeBefore: 'x'.repeat(520), codeAfter: 'must-not-leak', language: 'go', fileName: 'main.go' },
    'inline-1'
  );

  assert.equal(chatPayload.modelConfig.id, 'chat-profile');
  assert.equal(chatPayload.modelConfig.modelId, 'chat-profile-chat');
  assert.equal(chatPayload.maxTokens, 1234);
  assert.equal(chatPayload.temperature, 0.35);
  assert.equal(chatPayload.topP, 0.8);
  assert.equal(JSON.stringify(chatPayload.stop), JSON.stringify(['CHAT_STOP']));
  assert.equal(chatPayload.contextMetadata.maxInputChars, 8000);

  assert.equal(inlinePayload.modelConfig.id, 'inline-profile');
  assert.equal(inlinePayload.modelConfig.modelId, 'inline-profile-inline');
  assert.equal(inlinePayload.mode, 'fim');
  assert.equal(inlinePayload.prompt, 'x'.repeat(500));
  assert.equal(inlinePayload.suffix, '');
  assert.equal(inlinePayload.maxTokens, 96);
  assert.equal(inlinePayload.temperature, 0.05);
  assert.equal(inlinePayload.topP, 0.6);
  assert.equal(JSON.stringify(inlinePayload.stop), JSON.stringify(['INLINE_STOP']));
});

test('provider-specific connection metadata survives the renderer request projection', () => {
  const openai = profile('openai-profile', 'chat', {
    provider: 'openai',
    protocol: 'chat-completions',
    authType: 'bearer',
    organizationId: 'org-test',
    projectId: 'proj-test',
    capabilities: {
      contextWindowTokens: 128000,
      maxOutputTokens: 32768,
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      reasoningEfforts: ['low', 'high'],
      effectiveEffortMap: { max: 'high' },
      source: 'user-override'
    }
  });
  const anthropic = profile('anthropic-profile', 'inline', {
    provider: 'anthropic',
    protocol: 'messages',
    authType: 'bearer',
    apiVersion: '2025-01-01',
    workspaceId: 'workspace-test',
    mode: 'chat'
  });
  const qwen = profile('qwen-profile', 'chat', {
    provider: 'qwen',
    protocol: 'chat-completions',
    authType: 'bearer',
    workspaceId: 'ws-test',
    region: 'ap-southeast-1',
    billingPlan: 'workspace'
  });
  const fixture = loadAiCore({ settings: settings({
    chatProfiles: [openai, qwen],
    inlineProfiles: [anthropic],
    chatProfileId: openai.id,
    inlineProfileId: anthropic.id
  }) });

  const openaiPayload = fixture.service.buildChatPayload(
    fixture.service.getProfileFor('chat'), 'Hello.', {}, 'openai-request', false
  );
  assert.deepEqual(JSON.parse(JSON.stringify(openaiPayload.modelConfig)), {
    id: 'openai-profile',
    name: 'openai-profile',
    provider: 'openai',
    protocol: 'chat-completions',
    authType: 'bearer',
    apiKey: 'mock-key',
    endpoint: 'https://openai-profile.example/v1/chat/completions',
    modelId: 'openai-profile-chat',
    mode: 'chat',
    apiVersion: '',
    organizationId: 'org-test',
    projectId: 'proj-test',
    workspaceId: '',
    region: '',
    billingPlan: '',
    capabilities: {
      contextWindowTokens: 128000,
      maxOutputTokens: 32768,
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      reasoningEfforts: ['low', 'high'],
      effectiveEffortMap: { max: 'high' },
      source: 'user-override'
    },
    options: { connection: 'chat' }
  });

  const anthropicPayload = fixture.service.buildInlineRequest(
    fixture.service.getProfileFor('inline'),
    { codeBefore: 'const value = ', codeAfter: ';', language: 'javascript', fileName: 'value.js' },
    'anthropic-request'
  );
  assert.equal(anthropicPayload.modelConfig.protocol, 'messages');
  assert.equal(anthropicPayload.modelConfig.authType, 'bearer');
  assert.equal(anthropicPayload.modelConfig.apiVersion, '2025-01-01');
  assert.equal(anthropicPayload.modelConfig.workspaceId, '');

  const qwenPayload = fixture.service.buildChatPayload(
    fixture.service.getProfileById(qwen.id, 'chat'), 'Hello.', {}, 'qwen-request', false
  );
  assert.equal(qwenPayload.modelConfig.workspaceId, 'ws-test');
  assert.equal(qwenPayload.modelConfig.region, 'ap-southeast-1');
  assert.equal(qwenPayload.modelConfig.billingPlan, 'workspace');
});

test('profile and policy updates persist only the canonical v4 schema', async () => {
  const fixture = loadAiCore();
  const result = await fixture.service.updateSettings({
    globalInstructions: 'Prefer tests first.',
    inline: { context: { suffixChars: 0 }, parameters: { maxTokens: 128 } }
  });
  assert.equal(result.success, true);
  const written = fixture.calls.writes[0];
  assert.equal(written.schemaVersion, 4);
  assert.equal(written.globalInstructions, 'Prefer tests first.');
  assert.equal(written.inline.context.suffixChars, 0);
  assert.equal(written.inline.parameters.maxTokens, 128);
  assert.equal(Object.hasOwn(written, 'profiles'), false);
  assert.equal(Object.hasOwn(written, 'models'), false);
  assert.equal(Object.hasOwn(written, 'chatModel'), false);
  assert.equal(Object.hasOwn(written, 'inlineInstruction'), false);
});

test('failed settings writes leave the active canonical settings unchanged', async () => {
  const fixture = loadAiCore({ api: { aiWriteSettings: async value => {
    fixture.calls.writes.push(value);
    return false;
  } } });
  const before = fixture.service.getSettings();
  const result = await fixture.service.updateSettings({
    globalInstructions: 'This must not become active.',
    inline: { enabled: false }
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'ai.error.settingsWrite');
  assert.equal(JSON.stringify(fixture.service.getSettings()), JSON.stringify(before));
  assert.equal(fixture.calls.writes[0].globalInstructions, 'This must not become active.');
});

test('concurrent settings mutations rebase on the latest successful queued write', async () => {
  const configured = settings({
    chatProfiles: [profile('chat-profile', 'chat'), profile('second-chat', 'chat')],
    inlineProfileId: '',
    inline: Object.assign({}, settings().inline, { enabled: false })
  });
  const fixture = loadAiCore({ settings: configured });
  const selection = fixture.service.setProfileFor('chat', 'second-chat');
  const instructions = fixture.service.updateSettings({ globalInstructions: 'Keep both queued changes.' });

  assert.equal((await selection).success, true);
  assert.equal((await instructions).success, true);
  assert.equal(fixture.calls.writes[0].chatProfileId, 'second-chat');
  assert.equal(fixture.calls.writes[1].chatProfileId, 'second-chat');
  assert.equal(fixture.calls.writes[1].globalInstructions, 'Keep both queued changes.');
  assert.equal(fixture.service.getSettings().chatProfileId, 'second-chat');
  assert.equal(fixture.service.getSettings().globalInstructions, 'Keep both queued changes.');
});

test('a queued mutation rebases after an earlier write failure', async () => {
  let writes = 0;
  const fixture = loadAiCore({ api: { aiWriteSettings: async value => {
    fixture.calls.writes.push(value);
    writes += 1;
    return writes !== 1;
  } } });
  const failed = fixture.service.updateSettings({ globalInstructions: 'must not leak' });
  const next = fixture.service.updateSettings({ chat: { instructions: 'survives' } });

  assert.equal((await failed).success, false);
  assert.equal((await next).success, true);
  assert.equal(fixture.calls.writes[1].globalInstructions, 'Follow repository conventions.');
  assert.equal(fixture.calls.writes[1].chat.instructions, 'survives');
  assert.equal(fixture.service.getSettings().globalInstructions, 'Follow repository conventions.');
  assert.equal(fixture.service.getSettings().chat.instructions, 'survives');
});

test('model status requires a successful matching fingerprint connection test', async () => {
  const fixture = loadAiCore();
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'untested');
  await fixture.service.testProfileConnection(fixture.service.getProfileFor('chat'), 'chat');
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');

  const invalid = profile('invalid', 'inline', { endpoint: '' });
  assert.equal(fixture.service.getModelStatus(invalid, 'inline').code, 'ai.error.endpointRequired');
});

test('settings changes invalidate health and automatically retest active agents', async () => {
  const fixture = loadAiCore();
  await fixture.service.testActiveConnections();
  assert.equal(fixture.calls.tests.length, 2);
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
  await fixture.service.updateSettings({ chatProfiles: [profile('chat-profile', 'chat', { modelId: 'changed-model' })] });
  assert.equal(fixture.calls.tests.length, 4);
  assert.equal(fixture.service.getProfileFor('chat').modelId, 'changed-model');
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
});

test('wire metadata and capability changes invalidate connection health fingerprints', async () => {
  const initial = profile('chat-profile', 'chat', {
    provider: 'openai',
    protocol: 'chat-completions',
    authType: 'bearer',
    organizationId: 'org-one',
    projectId: 'project-one',
    capabilities: { reasoningEfforts: ['low'], source: 'user-override' }
  });
  const fixture = loadAiCore({ settings: settings({ chatProfiles: [initial] }) });
  await fixture.service.testActiveConnections();
  assert.equal(fixture.calls.tests.length, 2);

  await fixture.service.updateSettings({ chatProfiles: [Object.assign({}, initial, {
    organizationId: 'org-two',
    capabilities: { reasoningEfforts: ['low', 'high'], source: 'user-override' }
  })] });

  assert.equal(fixture.calls.tests.length, 4);
  const latestChatProbe = fixture.calls.tests.filter(function(call) { return String(call.requestId).startsWith('test-chat-'); }).at(-1);
  assert.equal(latestChatProbe.modelConfig.organizationId, 'org-two');
  assert.deepEqual(JSON.parse(JSON.stringify(latestChatProbe.modelConfig.capabilities.reasoningEfforts)), ['low', 'high']);
});

test('prompt and generation policy autosaves do not spend connection probes', async () => {
  const fixture = loadAiCore();
  await fixture.service.testActiveConnections();
  assert.equal(fixture.calls.tests.length, 2);

  const result = await fixture.service.updateSettings({
    globalInstructions: 'Prefer concise explanations.',
    chat: { parameters: { temperature: 0.4 } },
    inline: { debounceMs: 700 }
  });

  assert.equal(result.success, true);
  assert.equal(fixture.calls.tests.length, 2);
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('inline'), 'inline').state, 'ready');
});

test('an older connection test cannot overwrite health for a newer profile configuration', async () => {
  const pending = [];
  const fixture = loadAiCore({ api: {
    aiTestConnection: payload => {
      fixture.calls.tests.push(payload);
      return new Promise(resolve => pending.push({ payload, resolve }));
    }
  } });
  const oldTest = fixture.service.testProfileConnection(fixture.service.getProfileFor('chat'), 'chat');
  const update = fixture.service.updateSettings({
    chatProfiles: [profile('chat-profile', 'chat', { modelId: 'new-chat-model' })],
    inlineProfileId: '',
    inline: { enabled: false }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pending.length, 2);
  pending[1].resolve({ success: true, data: { choices: [{ message: { content: 'new ready' } }] } });
  await update;
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
  pending[0].resolve({ success: false, error: 'stale failure' });
  assert.equal((await oldTest).code, 'ai.error.cancelled');
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
});

test('testing an unsaved profile draft reports its result without changing global health', async () => {
  const fixture = loadAiCore();
  const draft = profile('chat-profile', 'chat', { endpoint: 'https://draft.example/v1/chat/completions', modelId: 'draft-model' });
  const result = await fixture.service.testProfileConnection(draft, 'chat');

  assert.equal(result.success, true);
  assert.equal(fixture.service.getConnectionHealth('chat', 'chat-profile'), null);
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'untested');
});

test('testing a draft does not cancel the saved profile health check', async () => {
  const pending = [];
  const fixture = loadAiCore({ api: {
    aiTestConnection: payload => new Promise(resolve => pending.push({ payload, resolve }))
  } });
  const savedTest = fixture.service.testProfileConnection(fixture.service.getProfileFor('chat'), 'chat');
  const draftTest = fixture.service.testProfileConnection(
    profile('chat-profile', 'chat', { endpoint: 'https://draft.example/v1/chat/completions' }),
    'chat'
  );

  pending[1].resolve({ success: true, data: { choices: [{ message: { content: 'draft ready' } }] } });
  assert.equal((await draftTest).success, true);
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'testing');
  pending[0].resolve({ success: true, data: { choices: [{ message: { content: 'saved ready' } }] } });
  assert.equal((await savedTest).success, true);
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
});

test('overall status includes every enabled channel and preserves active chat status', async () => {
  const fixture = loadAiCore({ api: {
    aiTestConnection: async payload => payload.mode === 'fim'
      ? { success: false, error: 'inline unavailable' }
      : { success: true, data: { choices: [{ message: { content: 'OK' } }] } }
  } });
  await fixture.service.testActiveConnections();
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('inline'), 'inline').state, 'error');
  assert.equal(fixture.state.status, 'error');

  fixture.state.chatStreaming = true;
  await fixture.service.testProfileConnection(fixture.service.getProfileFor('chat'), 'chat');
  assert.equal(fixture.state.status, 'thinking');
});

test('enabled completion without a selected agent cannot report overall ready', async () => {
  const configured = settings({ inlineProfileId: '', inline: Object.assign({}, settings().inline, { enabled: true }) });
  const fixture = loadAiCore({ settings: configured });
  await fixture.service.testActiveConnections();
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'ready');
  assert.equal(fixture.state.inline.enabled, false);
  assert.equal(fixture.state.status, 'idle');
});

test('HTTP success without a parseable completion never marks an agent ready', async () => {
  const fixture = loadAiCore({ api: {
    aiTestConnection: async payload => { fixture.calls.tests.push(payload); return { success: true, data: {} }; }
  } });
  const result = await fixture.service.testProfileConnection(fixture.service.getProfileFor('chat'), 'chat');
  assert.equal(result.success, false);
  assert.equal(result.code, 'ai.error.connectionFailed');
  assert.equal(fixture.service.getModelStatus(fixture.service.getProfileFor('chat'), 'chat').state, 'error');
});

test('connection probes are context-free and accept valid empty provider choices', async () => {
  const fixture = loadAiCore({ api: {
    aiTestConnection: async payload => {
      fixture.calls.tests.push(payload);
      return payload.mode === 'fim'
        ? { success: true, data: { choices: [{ text: '' }] } }
        : { success: true, data: { choices: [{ message: { content: '' } }] } };
    }
  } });
  const chat = await fixture.service.testProfileConnection(fixture.service.getProfileFor('chat'), 'chat');
  const inline = await fixture.service.testProfileConnection(fixture.service.getProfileFor('inline'), 'inline');
  assert.equal(chat.success, true);
  assert.equal(inline.success, true);
  assert.equal(fixture.calls.tests[0].messages.at(-1).content, 'Reply with the single word OK.');
  assert.match(fixture.calls.tests[1].prompt, /connectionProbe/);
  assert.equal(fixture.calls.tests[1].suffix, ';\n}');
});

test('layered chat prompt is deterministic, bounded, and keeps instructions separate', () => {
  const history = [
    { role: 'user', content: 'old '.repeat(1000) },
    { role: 'assistant', content: 'answer '.repeat(1000) },
    { role: 'user', content: 'Review this.' }
  ];
  const fixture = loadAiCore({ chatMessages: history });
  const context = {
    selection: { text: 'selected '.repeat(300), startLine: 4, endLine: 8 },
    currentFile: { path: 'src/main.go', language: 'go', content: 'current '.repeat(1000) },
    referencedFilesContents: {
      'z.go': 'z'.repeat(1000),
      'a.go': 'a'.repeat(1000),
      'ignored.go': 'i'.repeat(1000)
    },
    projectStructure: 'project '.repeat(500)
  };
  const first = fixture.service.buildChatPayload(fixture.service.getProfileFor('chat'), 'Review this.', context, 'chat-1', true);
  const second = fixture.service.buildChatPayload(fixture.service.getProfileFor('chat'), 'Review this.', context, 'chat-2', true);
  const system = first.messages[0].content;

  assert.equal(JSON.stringify(first.messages), JSON.stringify(second.messages));
  assert.ok(first.contextMetadata.inputChars <= first.contextMetadata.maxInputChars);
  assert.equal(first.messages.filter(message => message.role === 'user' && message.content === 'Review this.').length, 1);
  assert.ok(system.indexOf('CORE BEHAVIOR') < system.indexOf('APPLICATION KNOWLEDGE'));
  assert.ok(system.indexOf('APPLICATION KNOWLEDGE') < system.indexOf('CAPABILITY BOUNDARY'));
  assert.ok(system.indexOf('USER GLOBAL INSTRUCTIONS') < system.indexOf('USER CHAT INSTRUCTIONS'));
  assert.match(system, /Follow repository conventions\./);
  assert.match(system, /Cite the relevant file\./);
  assert.match(system, /REFERENCED FILE a\.go/);
  assert.match(system, /REFERENCED FILE ignored\.go/);
  assert.doesNotMatch(system, /REFERENCED FILE z\.go/);
});

test('application knowledge gives exact cache paths without inventing an action', () => {
  const fixture = loadAiCore();
  const knowledge = fixture.prompts.APP_KNOWLEDGE;
  assert.match(knowledge, /Project Environment.*Clear environment cache/);
  assert.match(knowledge, /analysis and local completion caches/);
  assert.match(knowledge, /installed dependencies are preserved/);
  assert.match(knowledge, /Cloud resources.*Storage and cache.*Cache tab/);
  assert.match(knowledge, /Delete on an individual cache module/);
  assert.match(knowledge, /Team workspace.*Team center.*Build cache tab/);
  assert.match(knowledge, /inactive namespace, shared cache, or all team cache/);
});

test('native Chat keeps a static read-only boundary and never sends Agent tools', () => {
  const fixture = loadAiCore();
  const payload = fixture.service.buildChatPayload(fixture.service.getProfileFor('chat'), 'Help.', {}, 'chat-cap', false);
  assert.equal('capabilities' in payload.contextMetadata, false);
  assert.equal('tools' in payload, false);
  assert.match(payload.messages[0].content, /Chat surface is read-only and separate from installed Agent plugins/);
  assert.match(payload.messages[0].content, /Never claim that you executed a tool/);
});

test('chat-mode inline prompt layers global and inline instructions without chat instructions', () => {
  const configured = settings();
  configured.inlineProfiles[0].mode = 'chat';
  const fixture = loadAiCore({ settings: configured });
  const payload = fixture.service.buildInlineRequest(
    fixture.service.getProfileFor('inline'),
    { codeBefore: 'const value = ', codeAfter: ';', language: 'javascript', fileName: 'value.js' },
    'inline-chat'
  );
  const content = payload.messages[0].content;
  assert.match(content, /Follow repository conventions\./);
  assert.match(content, /Continue with the local naming style\./);
  assert.doesNotMatch(content, /Cite the relevant file\./);
  assert.match(content, /<CURSOR>/);
});

test('new inline request cancels the older request without waiting and discards late output', async () => {
  const pending = [];
  const fixture = loadAiCore({
    api: {
      aiCancelInline: requestId => {
        fixture.calls.cancelInline.push(requestId);
        return new Promise(() => {});
      },
      aiInlineRequest(payload) {
        fixture.calls.inline.push(payload);
        return new Promise(resolve => pending.push({ id: payload.requestId, resolve }));
      }
    }
  });
  await fixture.service.testProfileConnection(fixture.service.getProfileFor('inline'), 'inline');
  const first = fixture.service.getInlineCompletion({ codeBefore: 'one', codeAfter: '', language: 'js', fileName: 'a.js' });
  const second = fixture.service.getInlineCompletion({ codeBefore: 'two', codeAfter: '', language: 'js', fileName: 'a.js' });

  assert.equal(fixture.calls.inline.length, 2);
  assert.equal(JSON.stringify(fixture.calls.cancelInline), JSON.stringify(['inline-1']));
  pending[0].resolve({ success: true, data: { choices: [{ text: 'old' }] } });
  pending[1].resolve({ success: true, data: { choices: [{ text: 'new' }] } });
  assert.equal((await first).code, 'ai.error.cancelled');
  const latest = await second;
  assert.equal(latest.success, true);
  assert.equal(latest.text, 'new');
});

test('chat stream events are scoped to the active request id', async () => {
  const pending = [];
  const fixture = loadAiCore({ api: {
    aiChatRequest(payload) {
      fixture.calls.chat.push(payload);
      return new Promise(resolve => pending.push({ requestId: payload.requestId, resolve }));
    }
  } });
  await fixture.service.init();
  const chunks = [];
  let ended = 0;
  fixture.service.onStreamChunk(chunk => chunks.push(chunk.text));
  fixture.service.onStreamEnd(() => { ended += 1; });

  const first = fixture.service.sendChat('first', {});
  fixture.service.cancelStream();
  const second = fixture.service.sendChat('second', {});
  const firstId = fixture.calls.chat[0].requestId;
  const secondId = fixture.calls.chat[1].requestId;
  fixture.listeners.chunk({ requestId: firstId, text: 'stale' });
  fixture.listeners.end({ requestId: firstId });
  assert.equal(JSON.stringify(chunks), JSON.stringify([]));
  assert.equal(ended, 0);
  assert.equal(fixture.state.chatStreaming, true);

  fixture.listeners.chunk({ requestId: secondId, text: 'current' });
  fixture.listeners.end({ requestId: secondId });
  assert.equal(JSON.stringify(chunks), JSON.stringify(['current']));
  assert.equal(ended, 1);
  assert.equal(fixture.state.chatStreaming, false);

  pending[0].resolve({ success: false, error: 'cancelled' });
  pending[1].resolve({ success: true });
  assert.equal((await first).code, 'ai.error.cancelled');
  assert.equal((await second).success, true);
});

test('main process tags every streaming event with its request id', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'main', 'ai.js'), 'utf8');
  assert.match(source, /send\('ai-chunk', \{ requestId,/);
  assert.match(source, /send\('ai-stream-end', \{ requestId \}\)/);
  assert.match(source, /send\('ai-stream-error', \{ requestId,/);
});

test('main process rejects non-JSON non-stream responses instead of reporting success', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'main', 'ai.js'), 'utf8');
  assert.match(source, /Provider returned invalid JSON/);
  assert.doesNotMatch(source, /resolve\(\{ success: true, data: \{ raw: data \} \}\)/);
});

test('inline cache avoids duplicate transport and failures do not overwrite chat status', async () => {
  const fixture = loadAiCore();
  await fixture.service.testProfileConnection(fixture.service.getProfileFor('inline'), 'inline');
  const context = { codeBefore: 'same', codeAfter: '', language: 'js', fileName: 'a.js' };
  assert.equal((await fixture.service.getInlineCompletion(context)).cached, false);
  assert.equal((await fixture.service.getInlineCompletion(context)).cached, true);
  assert.equal(fixture.calls.inline.length, 1);
  assert.equal(fixture.state.status, 'unconfigured');

  const failing = loadAiCore({ api: { aiInlineRequest: async () => { throw new Error('offline'); } } });
  await failing.service.testProfileConnection(failing.service.getProfileFor('inline'), 'inline');
  failing.state.status = 'thinking';
  const failed = await failing.service.getInlineCompletion(context);
  assert.equal(failed.success, false);
  assert.equal(failed.code, 'ai.error.requestFailed');
  assert.equal(failing.state.inlineStatus, 'degraded');
  assert.equal(failing.state.status, 'thinking');
});

test('inline provider exposes the Monaco disposal contract and reads canonical state', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'ai-inline.js'), 'utf8');
  assert.match(source, /disposeInlineCompletions\s*:\s*function\s*\(/);
  assert.match(source, /inlineSettings\(\)\.enabled/);
});

test('inline enable toggle changes runtime state only after settings persist', async () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'ai-inline.js'), 'utf8');
  const state = { ai: { inline: { enabled: true }, inlineEnabled: true } };
  let cancelCount = 0;
  const BOBO = {
    state,
    aiService: {
      updateSettings: async () => ({ success: false, code: 'ai.error.settingsWrite' }),
      cancelInline() { cancelCount += 1; }
    }
  };
  const windowObject = { BOBO };
  vm.runInNewContext(source, {
    window: windowObject, console, Promise, setTimeout, clearTimeout
  }, { filename: 'src/ai-inline.js' });

  const failed = await BOBO.aiInline.setEnabled(false);
  assert.equal(failed.success, false);
  assert.equal(state.ai.inline.enabled, true);
  assert.equal(state.ai.inlineEnabled, true);
  assert.equal(cancelCount, 0);

  state.ai.inlineProfileId = '';
  const missingAgent = await BOBO.aiInline.setEnabled(true);
  assert.equal(missingAgent.success, false);
  assert.equal(missingAgent.code, 'ai.error.noModel');
  assert.equal(state.ai.inline.enabled, true);

  state.ai.inlineProfileId = 'inline-profile';
  BOBO.aiService.updateSettings = async patch => {
    state.ai.inline.enabled = patch.inline.enabled;
    state.ai.inlineEnabled = patch.inline.enabled;
    return { success: true };
  };
  const saved = await BOBO.aiInline.setEnabled(false);
  assert.equal(saved.success, true);
  assert.equal(state.ai.inline.enabled, false);
  assert.equal(state.ai.inlineEnabled, false);
  assert.equal(cancelCount, 1);
});
