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

  assert.equal(migrated.schemaVersion, 3);
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
