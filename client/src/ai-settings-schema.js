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

  var SCHEMA_VERSION = 4;
  var MAX_MODEL_REQUEST_OUTPUT_TOKENS = 262144;
  var CAPABILITY_SOURCES = ['unknown', 'provider-api', 'official-catalog', 'user-override'];
  var REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  var PROVIDER_ORDER = ['openai', 'anthropic', 'deepseek', 'glm', 'kimi', 'qwen', 'openai-compatible'];
  var QWEN_REGIONS = ['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'eu-central-1', 'us-east-1'];
  var QWEN_BILLING_PLANS = ['standard', 'workspace', 'trial', 'token-plan', 'coding-plan'];
  var PROVIDER_CATALOG = {
    openai: {
      labelKey: 'ai.control.provider.openai',
      protocols: ['chat-completions'],
      defaultProtocol: 'chat-completions',
      authTypes: ['bearer'],
      defaultAuthType: 'bearer',
      organization: true,
      project: true
    },
    anthropic: {
      labelKey: 'ai.control.provider.anthropic',
      protocols: ['messages'],
      defaultProtocol: 'messages',
      authTypes: ['api-key', 'bearer'],
      defaultAuthType: 'api-key',
      apiVersion: '2023-06-01'
    },
    deepseek: {
      labelKey: 'ai.control.provider.deepseek',
      protocols: ['chat-completions'],
      defaultProtocol: 'chat-completions',
      authTypes: ['bearer'],
      defaultAuthType: 'bearer'
    },
    glm: {
      labelKey: 'ai.control.provider.glm',
      protocols: ['chat-completions'],
      defaultProtocol: 'chat-completions',
      authTypes: ['api-key', 'jwt'],
      defaultAuthType: 'api-key'
    },
    kimi: {
      labelKey: 'ai.control.provider.kimi',
      protocols: ['chat-completions'],
      defaultProtocol: 'chat-completions',
      authTypes: ['bearer'],
      defaultAuthType: 'bearer'
    },
    qwen: {
      labelKey: 'ai.control.provider.qwen',
      protocols: ['chat-completions'],
      defaultProtocol: 'chat-completions',
      authTypes: ['bearer'],
      defaultAuthType: 'bearer',
      region: true,
      workspace: true,
      billingPlan: true
    },
    'openai-compatible': {
      labelKey: 'ai.control.provider.compatible',
      protocols: ['chat-completions', 'completions'],
      defaultProtocol: 'chat-completions',
      authTypes: ['bearer'],
      defaultAuthType: 'bearer'
    }
  };

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

  function normalizeProviderId(value) {
    var provider = text(value).toLowerCase();
    if (provider === 'claude') return 'anthropic';
    if (provider === 'chatgpt') return 'openai';
    if (provider === 'zhipu' || provider === 'bigmodel' || provider === 'zhipu-glm') return 'glm';
    if (provider === 'moonshot') return 'kimi';
    if (provider === 'dashscope' || provider === 'aliyun' || provider === 'alibaba') return 'qwen';
    return PROVIDER_CATALOG[provider] ? provider : 'openai-compatible';
  }

  function providerDefinition(provider) {
    return PROVIDER_CATALOG[normalizeProviderId(provider)];
  }

  function inferProtocol(provider, endpoint, purpose, mode) {
    var definition = providerDefinition(provider);
    var pathname = text(endpoint).toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (definition.protocols.indexOf('responses') >= 0 && /(^|\/)responses$/.test(pathname)) return 'responses';
    if (definition.protocols.indexOf('messages') >= 0 && /(^|\/)messages$/.test(pathname)) return 'messages';
    if (purpose === 'inline' && mode === 'fim' && definition.protocols.indexOf('completions') >= 0 && /(^|\/)completions$/.test(pathname)) return 'completions';
    return definition.defaultProtocol;
  }

  function normalizeProtocol(value, provider, endpoint, purpose, mode) {
    var definition = providerDefinition(provider);
    var protocol = text(value).toLowerCase();
    if (protocol === 'chat' || protocol === 'openai') protocol = 'chat-completions';
    if (protocol === 'anthropic') protocol = 'messages';
    if (protocol === 'fim') protocol = 'completions';
    return definition.protocols.indexOf(protocol) >= 0
      ? protocol
      : inferProtocol(provider, endpoint, purpose, mode);
  }

  function nullableInteger(value, min, max) {
    if (value === undefined || value === null || value === '') return null;
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(min, Math.min(max, Math.round(parsed)));
  }

  function nullableBoolean(value) {
    return value === true || value === 'true' ? true : (value === false || value === 'false' ? false : null);
  }

  function normalizeReasoningEfforts(value) {
    var source = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
    var result = [];
    source.forEach(function(item) {
      var effort = text(item).toLowerCase();
      if (REASONING_EFFORTS.indexOf(effort) >= 0 && result.indexOf(effort) < 0) result.push(effort);
    });
    return result;
  }

  function normalizeEffortMap(value) {
    value = isObject(value) ? value : {};
    var result = {};
    Object.keys(value).slice(0, 16).forEach(function(key) {
      var requested = text(key).toLowerCase();
      var effective = text(value[key]).toLowerCase();
      if (REASONING_EFFORTS.indexOf(requested) >= 0 && REASONING_EFFORTS.indexOf(effective) >= 0) result[requested] = effective;
    });
    return result;
  }

  function normalizeCapabilities(value) {
    value = isObject(value) ? value : {};
    var source = text(value.source).toLowerCase();
    return {
      contextWindowTokens: nullableInteger(value.contextWindowTokens, 1, 100000000),
      maxOutputTokens: nullableInteger(value.maxOutputTokens, 1, 100000000),
      tools: nullableBoolean(value.tools),
      streaming: nullableBoolean(value.streaming),
      parallelToolCalls: nullableBoolean(value.parallelToolCalls),
      reasoningEfforts: normalizeReasoningEfforts(value.reasoningEfforts),
      effectiveEffortMap: normalizeEffortMap(value.effectiveEffortMap),
      source: CAPABILITY_SOURCES.indexOf(source) >= 0 ? source : 'unknown'
    };
  }

  function qwenRegionsForBillingPlan(value) {
    if (value === 'workspace') return QWEN_REGIONS.slice();
    if (value === 'trial') return ['cn-beijing', 'ap-southeast-1'];
    if (value === 'standard') return ['cn-beijing', 'ap-southeast-1', 'us-east-1'];
    return [];
  }

  function validQwenWorkspaceId(value) {
    var workspaceId = text(value);
    return workspaceId.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspaceId);
  }

  function defaultEndpointFor(provider, values) {
    provider = normalizeProviderId(provider);
    values = isObject(values) ? values : {};
    var definition = providerDefinition(provider);
    var protocol = normalizeProtocol(values.protocol, provider, '', 'chat', 'chat');
    var suffix = protocol === 'responses' ? 'responses' : protocol === 'messages' ? 'messages' : protocol === 'completions' ? 'completions' : 'chat/completions';
    if (provider === 'openai') return 'https://api.openai.com/v1/' + suffix;
    if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
    if (provider === 'deepseek') return 'https://api.deepseek.com/' + suffix;
    if (provider === 'glm') return 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    if (provider === 'kimi') return 'https://api.moonshot.cn/v1/' + suffix;
    if (provider !== 'qwen') return '';

    var billingPlan = QWEN_BILLING_PLANS.indexOf(values.billingPlan) >= 0 ? values.billingPlan : 'standard';
    if (billingPlan === 'coding-plan') return 'https://coding.dashscope.aliyuncs.com/v1/' + suffix;
    if (billingPlan === 'token-plan') return 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/' + suffix;
    var allowedRegions = qwenRegionsForBillingPlan(billingPlan);
    var region = allowedRegions.indexOf(values.region) >= 0 ? values.region : (allowedRegions[0] || '');
    if (billingPlan === 'workspace') {
      var workspaceId = text(values.workspaceId);
      return validQwenWorkspaceId(workspaceId) ? 'https://' + workspaceId + '.' + region + '.maas.aliyuncs.com/compatible-mode/v1/' + suffix : '';
    }
    if (billingPlan === 'trial') return 'https://trial.' + region + '.maas.aliyuncs.com/compatible-mode/v1/' + suffix;
    var sharedHosts = {
      'cn-beijing': 'dashscope.aliyuncs.com',
      'ap-southeast-1': 'dashscope-intl.aliyuncs.com',
      'us-east-1': 'dashscope-us.aliyuncs.com'
    };
    return 'https://' + sharedHosts[region] + '/compatible-mode/v1/' + suffix;
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
    var provider = normalizeProviderId(value.provider);
    var definition = providerDefinition(provider);
    var mode = purpose === 'inline' && connection.mode === 'fim' ? 'fim' : 'chat';
    var protocol = normalizeProtocol(value.protocol, provider, connection.endpoint, purpose, mode);
    var authType = text(value.authType).toLowerCase();
    if (definition.authTypes.indexOf(authType) < 0) authType = definition.defaultAuthType;
    var billingPlan = definition.billingPlan && QWEN_BILLING_PLANS.indexOf(value.billingPlan) >= 0 ? value.billingPlan : (definition.billingPlan ? 'standard' : '');
    var allowedRegions = definition.region ? qwenRegionsForBillingPlan(billingPlan) : [];
    var region = definition.region && allowedRegions.indexOf(value.region) >= 0 ? value.region : (allowedRegions[0] || '');
    return {
      id: id.slice(0, 120),
      name: (text(value.name) || id).slice(0, 160),
      provider: provider,
      protocol: protocol,
      authType: authType,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      endpoint: text(connection.endpoint),
      modelId: normalizeModelId(connection.modelId),
      mode: mode,
      apiVersion: definition.apiVersion ? text(value.apiVersion, definition.apiVersion).slice(0, 80) : '',
      organizationId: definition.organization ? text(value.organizationId || value.organization).slice(0, 160) : '',
      projectId: definition.project ? text(value.projectId || value.project).slice(0, 160) : '',
      workspaceId: definition.workspace ? text(value.workspaceId || value.workspace).slice(0, 160) : '',
      region: region,
      billingPlan: billingPlan,
      capabilities: normalizeCapabilities(value.capabilities || value.capabilitySnapshot || value.capabilitiesOverride),
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
        parameters: normalizeParameters(chatParameters, { maxTokens: 4096, temperature: 0.2, topP: 1 }, MAX_MODEL_REQUEST_OUTPUT_TOKENS),
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
    MAX_MODEL_REQUEST_OUTPUT_TOKENS: MAX_MODEL_REQUEST_OUTPUT_TOKENS,
    PROVIDER_ORDER: PROVIDER_ORDER.slice(),
    PROVIDER_CATALOG: PROVIDER_CATALOG,
    CAPABILITY_SOURCES: CAPABILITY_SOURCES.slice(),
    REASONING_EFFORTS: REASONING_EFFORTS.slice(),
    QWEN_REGIONS: QWEN_REGIONS.slice(),
    QWEN_BILLING_PLANS: QWEN_BILLING_PLANS.slice(),
    normalizeProviderId: normalizeProviderId,
    normalizeProtocol: normalizeProtocol,
    normalizeCapabilities: normalizeCapabilities,
    qwenRegionsForBillingPlan: qwenRegionsForBillingPlan,
    validQwenWorkspaceId: validQwenWorkspaceId,
    defaultEndpointFor: defaultEndpointFor,
    normalizeProfile: normalizeProfile,
    normalizeModelId: normalizeModelId,
    normalizeSettings: normalizeSettings,
    normalizeParameters: normalizeParameters,
    normalizeStop: normalizeStop,
    settingsEqual: settingsEqual
  };
});
