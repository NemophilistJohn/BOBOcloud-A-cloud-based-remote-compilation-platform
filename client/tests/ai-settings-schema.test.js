'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const schema = require('../src/ai-settings-schema');

test('legacy combined profiles migrate into independent chat and inline agents', () => {
  const migrated = schema.normalizeSettings({
    profiles: [{
      id: 'gateway', name: 'Gateway', provider: 'openai-compatible', apiKey: 'keep-key',
      chat: { endpoint: 'https://chat.test/v1', modelId: 'chat-old', options: { channel: 'chat' } },
      inline: { endpoint: 'https://fim.test/v1', modelId: 'fim-old', mode: 'fim', options: { channel: 'inline' } }
    }],
    chatProfileId: 'gateway', inlineProfileId: 'gateway', inline: { enabled: true }
  });

  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.chatProfiles.map(profile => profile.id), ['gateway']);
  assert.deepEqual(migrated.inlineProfiles.map(profile => profile.id), ['gateway']);
  assert.equal(migrated.chatProfiles[0].endpoint, 'https://chat.test/v1');
  assert.equal(migrated.inlineProfiles[0].endpoint, 'https://fim.test/v1');
  assert.equal(migrated.inlineProfiles[0].mode, 'fim');
  assert.equal(migrated.chatProfiles[0].apiKey, 'keep-key');
  assert.equal(migrated.inlineProfiles[0].apiKey, 'keep-key');
  assert.equal(migrated.chatProfileId, 'gateway');
  assert.equal(migrated.inlineProfileId, 'gateway');
});

test('legacy configured presets migrate without reviving unused bundled presets', () => {
  const migrated = schema.normalizeSettings({
    models: [
      { id: 'preset-unused', name: 'Injected only', endpoint: 'https://unused.test/v1', modelId: 'unused', isPreset: true, apiKey: '' },
      { id: 'configured', name: 'Configured', endpoint: 'https://chat.test/v1', modelId: 'chat', inlineEndpoint: 'https://fim.test/v1', inlineModelId: 'fim', inlineMode: 'fim', isPreset: true, apiKey: 'secret' }
    ],
    chatModel: 'configured', inlineModel: 'configured'
  });
  assert.deepEqual(migrated.chatProfiles.map(profile => profile.id), ['configured']);
  assert.deepEqual(migrated.inlineProfiles.map(profile => profile.id), ['configured']);
});

test('canonical chat and inline agent collections normalize independently', () => {
  const normalized = schema.normalizeSettings({
    schemaVersion: 3,
    chatProfiles: [{ id: 'chat', name: 'Chat', endpoint: 'https://chat.test', modelId: 'chat-model', apiKey: 'chat-key' }],
    inlineProfiles: [{ id: 'inline', name: 'Inline', endpoint: 'https://inline.test', modelId: 'inline-model', apiKey: 'inline-key', mode: 'fim' }],
    chatProfileId: 'chat', inlineProfileId: 'inline',
    inline: { enabled: true, debounceMs: 100, context: { suffixChars: 0 } }
  });
  assert.equal(normalized.chatProfiles[0].modelId, 'chat-model');
  assert.equal(normalized.inlineProfiles[0].modelId, 'inline-model');
  assert.equal(normalized.inlineProfiles[0].mode, 'fim');
  assert.equal(normalized.inline.debounceMs, 150);
  assert.equal(normalized.inline.context.suffixChars, 0);
  assert.deepEqual(schema.normalizeSettings(normalized), normalized);
});

test('both channels may be disabled without silently choosing an agent', () => {
  const settings = schema.normalizeSettings({
    chatProfiles: [{ id: 'chat', name: 'Chat', endpoint: 'https://example.test', modelId: 'chat' }],
    inlineProfiles: [{ id: 'inline', name: 'Inline', endpoint: 'https://example.test', modelId: 'inline' }],
    chatProfileId: '', inlineProfileId: '', inline: { enabled: true }
  });
  assert.equal(settings.chatProfileId, '');
  assert.equal(settings.inlineProfileId, '');
  assert.equal(settings.inline.enabled, false);
});

test('provider model ids normalize typographic dashes to API-safe ASCII', () => {
  const settings = schema.normalizeSettings({
    chatProfiles: [{ id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', modelId: 'deepseek\u2011v4\u2011flash' }],
    chatProfileId: 'deepseek'
  });
  assert.equal(settings.chatProfiles[0].modelId, 'deepseek-v4-flash');
});

test('legacy provider profiles gain protocol metadata without losing connection fields or secrets', () => {
  const normalized = schema.normalizeSettings({
    schemaVersion: 3,
    chatProfiles: [
      { id: 'openai', name: 'OpenAI', provider: 'openai', apiKey: 'openai-secret', endpoint: 'https://api.openai.com/v1/chat/completions', modelId: 'gpt-test', options: { seed: 7 } },
      { id: 'claude', name: 'Claude', provider: 'anthropic', apiKey: 'claude-secret', endpoint: 'https://api.anthropic.com/v1/messages', modelId: 'claude-test' },
      { id: 'gateway', name: 'Gateway', provider: 'openai-compatible', apiKey: 'gateway-secret', endpoint: 'https://gateway.test/v1/chat/completions', modelId: 'custom' }
    ]
  });

  assert.equal(normalized.schemaVersion, 4);
  assert.deepEqual(normalized.chatProfiles.map(profile => [profile.provider, profile.protocol, profile.authType]), [
    ['openai', 'chat-completions', 'bearer'],
    ['anthropic', 'messages', 'api-key'],
    ['openai-compatible', 'chat-completions', 'bearer']
  ]);
  assert.equal(normalized.chatProfiles[0].apiKey, 'openai-secret');
  assert.equal(normalized.chatProfiles[0].endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(normalized.chatProfiles[0].options, { seed: 7 });
  assert.equal(normalized.chatProfiles[1].apiVersion, '2023-06-01');
  assert.deepEqual(normalized.chatProfiles[2].capabilities, {
    contextWindowTokens: null,
    maxOutputTokens: null,
    tools: null,
    streaming: null,
    parallelToolCalls: null,
    reasoningEfforts: [],
    effectiveEffortMap: {},
    source: 'unknown'
  });
});

test('provider-specific connection metadata and capability overrides normalize explicitly', () => {
  const profile = schema.normalizeProfile({
    id: 'qwen', name: 'Qwen workspace', provider: 'dashscope', protocol: 'chat-completions',
    authType: 'bearer', apiKey: 'secret', endpoint: 'https://workspace.example/chat/completions', modelId: 'qwen-test',
    region: 'ap-southeast-1', billingPlan: 'workspace', workspaceId: 'ws-123',
    capabilities: {
      contextWindowTokens: '1000000', maxOutputTokens: 128000,
      tools: true, streaming: 'true', parallelToolCalls: false,
      reasoningEfforts: ['low', 'medium', 'xhigh', 'invalid', 'low'],
      effectiveEffortMap: { high: 'xhigh', max: 'xhigh', invalid: 'high' },
      source: 'user-override'
    }
  }, 0, 'chat');

  assert.equal(profile.provider, 'qwen');
  assert.equal(profile.workspaceId, 'ws-123');
  assert.equal(profile.region, 'ap-southeast-1');
  assert.equal(profile.billingPlan, 'workspace');
  assert.deepEqual(profile.capabilities, {
    contextWindowTokens: 1000000,
    maxOutputTokens: 128000,
    tools: true,
    streaming: true,
    parallelToolCalls: false,
    reasoningEfforts: ['low', 'medium', 'xhigh'],
    effectiveEffortMap: { high: 'xhigh', max: 'xhigh' },
    source: 'user-override'
  });
});

test('provider output capability stays exact while chat requests use the host safety ceiling', () => {
  const profile = schema.normalizeProfile({
    id: 'kimi-large-output', provider: 'kimi',
    capabilities: { maxOutputTokens: 1_048_576, source: 'official-catalog' }
  }, 0, 'chat');
  assert.equal(profile.capabilities.maxOutputTokens, 1_048_576);
  assert.equal(schema.MAX_MODEL_REQUEST_OUTPUT_TOKENS, 262_144);

  const settings = schema.normalizeSettings({
    chat: { parameters: { maxTokens: 1_048_576 } }
  });
  assert.equal(settings.chat.parameters.maxTokens, 262_144);
});

test('provider catalog supplies endpoints but never guesses model capabilities', () => {
  assert.equal(schema.defaultEndpointFor('openai', { protocol: 'chat-completions' }), 'https://api.openai.com/v1/chat/completions');
  assert.equal(schema.defaultEndpointFor('anthropic', { protocol: 'messages' }), 'https://api.anthropic.com/v1/messages');
  assert.equal(schema.defaultEndpointFor('deepseek', { protocol: 'chat-completions' }), 'https://api.deepseek.com/chat/completions');
  assert.equal(schema.defaultEndpointFor('glm', { protocol: 'chat-completions' }), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(schema.defaultEndpointFor('kimi', { protocol: 'chat-completions' }), 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', region: 'us-east-1', billingPlan: 'standard' }), 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', region: 'cn-beijing', billingPlan: 'workspace', workspaceId: '' }), '');
  assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', region: 'cn-beijing', billingPlan: 'workspace', workspaceId: 'ws-1' }), 'https://ws-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  for (const invalidWorkspaceId of ['bad/id', 'bad@id', 'bad.id', '-bad', 'bad-', 'x'.repeat(64)]) {
    assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', region: 'cn-beijing', billingPlan: 'workspace', workspaceId: invalidWorkspaceId }), '');
    assert.equal(schema.validQwenWorkspaceId(invalidWorkspaceId), false);
  }
  assert.equal(schema.validQwenWorkspaceId('workspace-01'), true);
  assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', region: 'ap-northeast-1', billingPlan: 'workspace', workspaceId: 'ws-1' }), 'https://ws-1.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', region: 'eu-central-1', billingPlan: 'workspace', workspaceId: 'ws-1' }), 'https://ws-1.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', region: 'ap-southeast-1', billingPlan: 'trial' }), 'https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(schema.defaultEndpointFor('qwen', { protocol: 'chat-completions', billingPlan: 'token-plan' }), 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.deepEqual(schema.qwenRegionsForBillingPlan('workspace'), ['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'eu-central-1', 'us-east-1']);
  assert.deepEqual(schema.qwenRegionsForBillingPlan('trial'), ['cn-beijing', 'ap-southeast-1']);

  const anthropic = schema.normalizeProfile({ provider: 'anthropic', workspaceId: 'unused' }, 0, 'chat');
  assert.equal(anthropic.workspaceId, '');

  for (const provider of schema.PROVIDER_ORDER) {
    const profile = schema.normalizeProfile({ id: provider, provider }, 0, 'chat');
    assert.equal(profile.capabilities.contextWindowTokens, null);
    assert.equal(profile.capabilities.maxOutputTokens, null);
    assert.equal(profile.capabilities.source, 'unknown');
  }
});
