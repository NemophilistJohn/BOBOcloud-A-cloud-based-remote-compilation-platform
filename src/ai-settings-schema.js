// Canonical AI settings schema and legacy migration shared by main and renderer.
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.BOBO = root.BOBO || {};
    root.BOBO.aiSettingsSchema = api;
  }
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';

  var SCHEMA_VERSION = 3;

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value, fallback) {
    return typeof value === 'string' ? value.trim() : (fallback || '');
  }

  function normalizeModelId(value) {
    // API identifiers are ASCII. Typography substitutions from rich text or
    // IMEs are visually indistinguishable but rejected by providers.
    return text(value).replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-');
  }

  function clampNumber(value, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function clampInteger(value, fallback, min, max) {
    return Math.round(clampNumber(value, fallback, min, max));
  }

  function cloneJsonObject(value) {
    if (!isObject(value)) return {};
    try {
      var cloned = JSON.parse(JSON.stringify(value));
      return isObject(cloned) ? cloned : {};
    } catch (_) {
      return {};
    }
  }

  function normalizeStop(value) {
    if (!Array.isArray(value)) return [];
    var result = [];
    for (var i = 0; i < value.length && result.length < 8; i++) {
      var item = text(value[i]);
      if (item && item.length <= 200 && result.indexOf(item) < 0) result.push(item);
    }
    return result;
  }

  function normalizeParameters(value, defaults, maxTokensMax) {
    value = isObject(value) ? value : {};
    return {
      maxTokens: clampInteger(value.maxTokens, defaults.maxTokens, 16, maxTokensMax),
      temperature: clampNumber(value.temperature, defaults.temperature, 0, 2),
      topP: clampNumber(value.topP, defaults.topP, 0, 1),
      stop: normalizeStop(value.stop)
    };
  }

  function normalizeChatContext(value) {
    value = isObject(value) ? value : {};
    return {
      maxInputChars: clampInteger(value.maxInputChars, 48000, 8000, 200000),
      currentFileChars: clampInteger(value.currentFileChars, 20000, 0, 100000),
      selectionChars: clampInteger(value.selectionChars, 6000, 0, 30000),
      projectChars: clampInteger(value.projectChars, 4000, 0, 30000),
      referencedFileChars: clampInteger(value.referencedFileChars, 5000, 0, 50000),
      maxReferencedFiles: clampInteger(value.maxReferencedFiles, 4, 0, 20),
      historyMessages: clampInteger(value.historyMessages, 12, 0, 50),
      historyMessageChars: clampInteger(value.historyMessageChars, 6000, 256, 30000)
    };
  }

  function normalizeInlineContext(value, legacy) {
    value = isObject(value) ? value : {};
    legacy = isObject(legacy) ? legacy : {};
    return {
      prefixChars: clampInteger(value.prefixChars, clampInteger(legacy.inlinePrefixChars, 6000, 500, 16000), 500, 16000),
      suffixChars: clampInteger(value.suffixChars, clampInteger(legacy.inlineSuffixChars, 2500, 0, 8000), 0, 8000)
    };
  }

  function legacyConnection(value, purpose) {
    value = isObject(value) ? value : {};
    var nested = isObject(value[purpose]) ? value[purpose] : {};
    var inline = purpose === 'inline';
    return {
      endpoint: text(nested.endpoint, inline ? text(value.inlineEndpoint, value.endpoint) : value.endpoint),
      modelId: text(nested.modelId, inline ? text(value.inlineModelId, value.modelId) : value.modelId),
      mode: inline && (nested.mode === 'fim' || value.inlineMode === 'fim') ? 'fim' : 'chat',
      options: cloneJsonObject(Object.keys(cloneJsonObject(nested.options)).length ? nested.options : value.options)
    };
  }

  function normalizeProfile(value, index, purpose) {
    value = isObject(value) ? value : {};
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    var connection = value.endpoint !== undefined || value.modelId !== undefined
      ? value
      : legacyConnection(value, purpose);
    var id = text(value.id) || (purpose + '-agent-' + (index + 1));
    return {
      id: id.slice(0, 120),
      name: (text(value.name) || id).slice(0, 160),
      provider: (text(value.provider) || 'openai-compatible').slice(0, 80),
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      endpoint: text(connection.endpoint),
      modelId: normalizeModelId(connection.modelId),
      mode: purpose === 'inline' && connection.mode === 'fim' ? 'fim' : 'chat',
      options: cloneJsonObject(connection.options)
    };
  }

  function shouldMigrateLegacyModel(model) {
    if (!isObject(model)) return false;
    if (model.isPreset === true && !text(model.apiKey)) return false;
    return Boolean(text(model.id) || text(model.name) || text(model.endpoint) || text(model.apiKey));
  }

  function uniqueProfiles(values, purpose) {
    var result = [];
    var seen = Object.create(null);
    (Array.isArray(values) ? values : []).forEach(function(value, index) {
      var profile = normalizeProfile(value, index, purpose);
      if (seen[profile.id]) return;
      seen[profile.id] = true;
      result.push(profile);
    });
    return result;
  }

  function hasLegacyConnection(value, purpose) {
    var connection = legacyConnection(value, purpose);
    return Boolean(connection.endpoint || connection.modelId);
  }

  function migrateProfiles(raw, purpose) {
    var canonicalKey = purpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    if (Array.isArray(raw[canonicalKey])) return uniqueProfiles(raw[canonicalKey], purpose);
    var source = Array.isArray(raw.profiles)
      ? raw.profiles
      : (Array.isArray(raw.models) ? raw.models.filter(shouldMigrateLegacyModel) : []);
    return uniqueProfiles(source.filter(function(profile) {
      return shouldMigrateLegacyModel(profile) && hasLegacyConnection(profile, purpose);
    }), purpose);
  }

  function selectedProfileId(candidate, profiles) {
    candidate = text(candidate);
    if (candidate && profiles.some(function(profile) { return profile.id === candidate; })) return candidate;
    return '';
  }

  function normalizeSettings(raw) {
    raw = isObject(raw) ? raw : {};
    var chatProfiles = migrateProfiles(raw, 'chat');
    var inlineProfiles = migrateProfiles(raw, 'inline');
    var rawChat = isObject(raw.chat) ? raw.chat : {};
    var rawInline = isObject(raw.inline) ? raw.inline : {};
    var chatParameters = Object.assign({
      maxTokens: raw.chatMaxTokens,
      temperature: raw.chatTemperature,
      topP: raw.chatTopP,
      stop: raw.chatStop
    }, isObject(rawChat.parameters) ? rawChat.parameters : {});
    var inlineParameters = Object.assign({
      maxTokens: raw.inlineMaxTokens,
      temperature: raw.inlineTemperature,
      topP: raw.inlineTopP,
      stop: raw.inlineStop
    }, isObject(rawInline.parameters) ? rawInline.parameters : {});
    var chatCandidate = raw.chatProfileId || raw.chatModel || raw.currentModel;
    var inlineCandidate = raw.inlineProfileId || raw.inlineModel || raw.currentModel;
    var normalizedInlineProfileId = selectedProfileId(inlineCandidate, inlineProfiles);

    return {
      schemaVersion: SCHEMA_VERSION,
      chatProfiles: chatProfiles,
      inlineProfiles: inlineProfiles,
      chatProfileId: selectedProfileId(chatCandidate, chatProfiles),
      inlineProfileId: normalizedInlineProfileId,
      globalInstructions: typeof raw.globalInstructions === 'string' ? raw.globalInstructions.slice(0, 12000) : '',
      chat: {
        instructions: typeof rawChat.instructions === 'string'
          ? rawChat.instructions.slice(0, 12000)
          : String(raw.chatSystemPrompt || '').slice(0, 12000),
        parameters: normalizeParameters(chatParameters, { maxTokens: 4096, temperature: 0.2, topP: 1 }, 32768),
        context: normalizeChatContext(rawChat.context)
      },
      inline: {
        enabled: Boolean(normalizedInlineProfileId) &&
          (typeof rawInline.enabled === 'boolean' ? rawInline.enabled : raw.inlineEnabled === true),
        instructions: typeof rawInline.instructions === 'string'
          ? rawInline.instructions.slice(0, 4000)
          : String(raw.inlineInstruction || '').slice(0, 4000),
        debounceMs: clampInteger(rawInline.debounceMs, clampInteger(raw.inlineDebounceMs, 450, 150, 2000), 150, 2000),
        parameters: normalizeParameters(inlineParameters, { maxTokens: 160, temperature: 0, topP: 1 }, 2048),
        context: normalizeInlineContext(rawInline.context, raw)
      },
      chatOpen: raw.chatOpen === true
    };
  }

  function settingsEqual(left, right) {
    return JSON.stringify(normalizeSettings(left)) === JSON.stringify(normalizeSettings(right));
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    normalizeProfile: normalizeProfile,
    normalizeModelId: normalizeModelId,
    normalizeSettings: normalizeSettings,
    normalizeParameters: normalizeParameters,
    normalizeStop: normalizeStop,
    settingsEqual: settingsEqual
  };
});
