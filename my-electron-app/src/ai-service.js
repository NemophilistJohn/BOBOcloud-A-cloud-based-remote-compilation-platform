// AI agent persistence, verified connection health, and isolated chat/inline coordination.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var S = BOBO.state;
  var schema = BOBO.aiSettingsSchema;
  var chatListeners = { chunk: null, end: null, error: null };
  var activeChatNonce = 0;
  var activeChatRequestId = '';
  var inlineNonce = 0;
  var activeInlineRequestId = '';
  var INLINE_CACHE_LIMIT = 80;
  var inlineCache = new Map();
  var compatibilitySnapshot = null;
  var committedSettings = null;
  var settingsWriteQueue = Promise.resolve();
  var connectionTestNonce = { chat: Object.create(null), inline: Object.create(null) };

  function resultError(code, detail) {
    return { success: false, code: code, detail: String(detail || '') };
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeEndpoint(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function requireSchema() {
    if (!schema || typeof schema.normalizeSettings !== 'function') throw new Error('ai-settings-schema.js must load before ai-service.js');
    return schema;
  }

  function settingsFromState() {
    return requireSchema().normalizeSettings({
      schemaVersion: S.ai.schemaVersion,
      chatProfiles: S.ai.chatProfiles,
      inlineProfiles: S.ai.inlineProfiles,
      chatProfileId: S.ai.chatProfileId,
      inlineProfileId: S.ai.inlineProfileId,
      globalInstructions: S.ai.globalInstructions,
      chat: S.ai.chat,
      inline: S.ai.inline,
      chatOpen: S.ai.chatOpen
    });
  }

  function profileToLegacy(profile, purpose) {
    if (!profile) return null;
    var result = {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      apiKey: profile.apiKey,
      endpoint: profile.endpoint,
      modelId: profile.modelId,
      options: clone(profile.options || {}),
      isPreset: false
    };
    if (purpose === 'inline') {
      result.inlineEndpoint = profile.endpoint;
      result.inlineModelId = profile.modelId;
      result.inlineMode = profile.mode;
    }
    return result;
  }

  function writeCompatibilityAliases() {
    var chat = S.ai.chat;
    var inline = S.ai.inline;
    S.ai.profiles = (S.ai.chatProfiles || []).map(function(profile) {
      var legacy = profileToLegacy(profile, 'chat');
      var inlineMatch = (S.ai.inlineProfiles || []).find(function(item) { return item.id === profile.id; });
      if (inlineMatch) {
        legacy.inlineEndpoint = inlineMatch.endpoint;
        legacy.inlineModelId = inlineMatch.modelId;
        legacy.inlineMode = inlineMatch.mode;
      }
      return legacy;
    });
    S.ai.models = S.ai.profiles.slice();
    S.ai.chatModel = S.ai.chatProfileId || '';
    S.ai.inlineModel = S.ai.inlineProfileId || '';
    S.ai.currentModel = S.ai.chatProfileId || '';
    S.ai.inlineEnabled = inline.enabled === true;
    S.ai.inlineDebounceMs = inline.debounceMs;
    S.ai.chatSystemPrompt = chat.instructions;
    S.ai.inlineInstruction = inline.instructions;
    S.ai.inlinePrefixChars = inline.context.prefixChars;
    S.ai.inlineSuffixChars = inline.context.suffixChars;
    S.ai.inlineMaxTokens = inline.parameters.maxTokens;
    compatibilitySnapshot = {
      chatModel: S.ai.chatModel,
      inlineModel: S.ai.inlineModel,
      inlineEnabled: S.ai.inlineEnabled,
      inlineDebounceMs: S.ai.inlineDebounceMs,
      chatSystemPrompt: S.ai.chatSystemPrompt,
      inlineInstruction: S.ai.inlineInstruction,
      inlinePrefixChars: S.ai.inlinePrefixChars,
      inlineSuffixChars: S.ai.inlineSuffixChars,
      inlineMaxTokens: S.ai.inlineMaxTokens
    };
  }

  function ensureHealthState() {
    if (!S.ai.connectionHealth || typeof S.ai.connectionHealth !== 'object') S.ai.connectionHealth = {};
    if (!S.ai.connectionHealth.chat) S.ai.connectionHealth.chat = {};
    if (!S.ai.connectionHealth.inline) S.ai.connectionHealth.inline = {};
    return S.ai.connectionHealth;
  }

  function applySettings(value, options) {
    var normalized = requireSchema().normalizeSettings(value);
    S.ai.schemaVersion = normalized.schemaVersion;
    S.ai.chatProfiles = normalized.chatProfiles;
    S.ai.inlineProfiles = normalized.inlineProfiles;
    S.ai.chatProfileId = normalized.chatProfileId;
    S.ai.inlineProfileId = normalized.inlineProfileId;
    S.ai.globalInstructions = normalized.globalInstructions;
    S.ai.chat = normalized.chat;
    S.ai.inline = normalized.inline;
    S.ai.chatOpen = normalized.chatOpen;
    ensureHealthState();
    writeCompatibilityAliases();
    if (!options || options.trackCommitted !== false) committedSettings = clone(normalized);
    return normalized;
  }

  function reconcileCompatibilityAliases() {
    if (!compatibilitySnapshot) return;
    if (S.ai.chatModel !== compatibilitySnapshot.chatModel) S.ai.chatProfileId = S.ai.chatModel || '';
    if (S.ai.inlineModel !== compatibilitySnapshot.inlineModel) S.ai.inlineProfileId = S.ai.inlineModel || '';
    if (S.ai.inlineEnabled !== compatibilitySnapshot.inlineEnabled) S.ai.inline.enabled = S.ai.inlineEnabled === true;
    if (S.ai.inlineDebounceMs !== compatibilitySnapshot.inlineDebounceMs) S.ai.inline.debounceMs = S.ai.inlineDebounceMs;
    if (S.ai.chatSystemPrompt !== compatibilitySnapshot.chatSystemPrompt) S.ai.chat.instructions = String(S.ai.chatSystemPrompt || '');
    if (S.ai.inlineInstruction !== compatibilitySnapshot.inlineInstruction) S.ai.inline.instructions = String(S.ai.inlineInstruction || '');
    if (S.ai.inlinePrefixChars !== compatibilitySnapshot.inlinePrefixChars) S.ai.inline.context.prefixChars = S.ai.inlinePrefixChars;
    if (S.ai.inlineSuffixChars !== compatibilitySnapshot.inlineSuffixChars) S.ai.inline.context.suffixChars = S.ai.inlineSuffixChars;
    if (S.ai.inlineMaxTokens !== compatibilitySnapshot.inlineMaxTokens) S.ai.inline.parameters.maxTokens = S.ai.inlineMaxTokens;
  }

  function deepMerge(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return target;
    Object.keys(patch).forEach(function(key) {
      var value = patch[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) deepMerge(target[key], value);
      else target[key] = clone(value);
    });
    return target;
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    var result = {};
    Object.keys(value).sort().forEach(function(key) { result[key] = stableValue(value[key]); });
    return result;
  }

  function fingerprint(profile, purpose) {
    if (!profile) return '';
    var source = JSON.stringify({
      purpose: purpose,
      id: profile.id,
      provider: profile.provider,
      endpoint: normalizeEndpoint(profile.endpoint),
      modelId: String(profile.modelId || '').trim(),
      apiKey: String(profile.apiKey || ''),
      mode: purpose === 'inline' ? profile.mode : 'chat',
      options: stableValue(profile.options || {})
    });
    var hash = 2166136261;
    for (var i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function activeConnectionSignatures(settings) {
    settings = settings || {};
    var chatProfiles = Array.isArray(settings.chatProfiles) ? settings.chatProfiles : [];
    var inlineProfiles = Array.isArray(settings.inlineProfiles) ? settings.inlineProfiles : [];
    var chat = chatProfiles.find(function(profile) { return profile.id === settings.chatProfileId; }) || null;
    var inlineEnabled = Boolean(settings.inline && settings.inline.enabled);
    var inline = inlineEnabled
      ? inlineProfiles.find(function(profile) { return profile.id === settings.inlineProfileId; }) || null
      : null;
    return {
      chat: chat ? fingerprint(chat, 'chat') : '',
      inline: inlineEnabled ? (inline ? fingerprint(inline, 'inline') : 'missing') : 'disabled'
    };
  }

  function activeConnectionsChanged(before, after) {
    var previous = activeConnectionSignatures(before);
    var next = activeConnectionSignatures(after);
    return previous.chat !== next.chat || previous.inline !== next.inline;
  }

  function profilesFor(purpose) {
    return purpose === 'inline' ? (S.ai.inlineProfiles || []) : (S.ai.chatProfiles || []);
  }

  function getProfileById(id, purpose) {
    if (purpose) return profilesFor(purpose).find(function(profile) { return profile.id === id; }) || null;
    return getProfileById(id, 'chat') || getProfileById(id, 'inline');
  }

  function getProfileFor(purpose) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    var id = purpose === 'inline' ? S.ai.inlineProfileId : S.ai.chatProfileId;
    return getProfileById(id, purpose);
  }

  function normalizeCandidate(candidate, purpose) {
    if (!candidate) return null;
    return requireSchema().normalizeProfile(candidate, 0, purpose);
  }

  function connectionForProfile(profile, purpose) {
    profile = normalizeCandidate(profile, purpose);
    if (!profile) return null;
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      apiKey: profile.apiKey,
      endpoint: normalizeEndpoint(profile.endpoint),
      modelId: String(profile.modelId || '').trim(),
      mode: purpose === 'inline' && profile.mode === 'fim' ? 'fim' : 'chat',
      options: clone(profile.options || {})
    };
  }

  function getConnectionFor(purpose) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    return connectionForProfile(getProfileFor(purpose), purpose);
  }

  function structuralStatus(candidate, purpose) {
    var connection = connectionForProfile(candidate, purpose);
    if (!connection) return { state: 'missing', code: 'ai.error.noModel' };
    if (!connection.endpoint) return { state: 'invalid', code: 'ai.error.endpointRequired' };
    if (!connection.modelId) return { state: 'invalid', code: 'ai.error.modelRequired' };
    if (!connection.apiKey) return { state: 'needs-key', code: 'ai.error.keyRequired' };
    return { state: 'complete', code: 'ai.status.untested' };
  }

  function modelStatus(candidate, purpose) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    var structural = structuralStatus(candidate, purpose);
    if (structural.state !== 'complete') return structural;
    var profile = normalizeCandidate(candidate, purpose);
    var health = ensureHealthState()[purpose][profile.id];
    if (!health || health.fingerprint !== fingerprint(profile, purpose)) return { state: 'untested', code: 'ai.status.untested' };
    return clone(health);
  }

  function updateStatus(status) {
    if (!S.ai) return;
    S.ai.status = status;
    if (BOBO.aiAgentButton && BOBO.aiAgentButton.updateLEDs) BOBO.aiAgentButton.updateLEDs(status);
  }

  function updateOverallStatus() {
    if (S.ai.chatStreaming) { updateStatus('thinking'); return; }
    var statuses = [];
    var chatProfile = getProfileFor('chat');
    var inlineProfile = S.ai.inline && S.ai.inline.enabled ? getProfileFor('inline') : null;
    if (chatProfile) statuses.push(modelStatus(chatProfile, 'chat'));
    if (S.ai.inline && S.ai.inline.enabled) statuses.push(modelStatus(inlineProfile, 'inline'));
    if (!statuses.length) { updateStatus('unconfigured'); return; }
    if (statuses.some(function(status) { return status.state === 'error'; })) updateStatus('error');
    else if (statuses.some(function(status) { return status.state === 'testing'; })) updateStatus('testing');
    else if (statuses.every(function(status) { return status.state === 'ready'; })) updateStatus('idle');
    else updateStatus('unconfigured');
  }

  function invalidateHealth() {
    S.ai.connectionHealth = { chat: {}, inline: {} };
    updateOverallStatus();
  }

  function settingsFailure(code, detail) {
    return { failed: true, result: resultError(code, detail) };
  }

  function mergeChangedSettings(target, base, desired) {
    if (JSON.stringify(base) === JSON.stringify(desired)) return clone(target);
    var objects = [target, base, desired].every(function(value) {
      return value && typeof value === 'object' && !Array.isArray(value);
    });
    if (!objects) return clone(desired);
    var result = clone(target);
    Object.keys(desired).forEach(function(key) {
      result[key] = mergeChangedSettings(target[key], base[key], desired[key]);
    });
    return result;
  }

  function persistCanonical(change, options) {
    options = options || {};
    var transform = typeof change === 'function' ? change : function() { return change; };
    var operation = settingsWriteQueue.then(async function() {
      try {
        var before = requireSchema().normalizeSettings(settingsFromState());
        var outcome = transform(clone(before));
        if (outcome && outcome.failed === true) return outcome.result;
        var normalized = requireSchema().normalizeSettings(outcome);
        var written = await global.api.aiWriteSettings(normalized);
        if (written === false) return resultError('ai.error.settingsWrite');
        applySettings(normalized);
        if (options.retest && activeConnectionsChanged(before, normalized)) {
          invalidateHealth();
          await testActiveConnections();
        }
        return { success: true, settings: clone(normalized) };
      } catch (error) {
        return resultError('ai.error.settingsWrite', error && error.message);
      }
    });
    settingsWriteQueue = operation.then(function() {}, function() {});
    return operation;
  }

  async function loadSettings() {
    try {
      var settings = await global.api.aiReadSettings();
      var normalized = applySettings(settings || {});
      invalidateHealth();
      await testActiveConnections();
      return clone(normalized);
    } catch (error) {
      updateStatus('error');
      return resultError('ai.error.settingsRead', error && error.message);
    }
  }

  function saveSettings() {
    var base = clone(committedSettings || settingsFromState());
    var current = settingsFromState();
    reconcileCompatibilityAliases();
    var candidate = settingsFromState();
    applySettings(current, { trackCommitted: false });
    return persistCanonical(function(latest) {
      return mergeChangedSettings(latest, base, candidate);
    }, { retest: false });
  }

  function updateSettings(patch) {
    patch = clone(patch || {});
    clearInlineCache();
    return persistCanonical(function(next) {
      return deepMerge(next, patch);
    }, { retest: true });
  }

  function getSettings() { return clone(settingsFromState()); }

  async function addProfile(value, purpose) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    var key = purpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    value = clone(value || {});
    return persistCanonical(function(next) {
      var profile = requireSchema().normalizeProfile(value, next[key].length, purpose);
      if (next[key].some(function(entry) { return entry.id === profile.id; })) return settingsFailure('ai.error.profileExists');
      next[key].push(profile);
      return next;
    }, { retest: true });
  }

  async function updateProfile(id, patch, purpose) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    var key = purpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    patch = clone(patch || {});
    clearInlineCache();
    return persistCanonical(function(next) {
      var index = next[key].findIndex(function(profile) { return profile.id === id; });
      if (index < 0) return settingsFailure('ai.error.noModel');
      var merged = deepMerge(clone(next[key][index]), patch);
      merged.id = id;
      next[key][index] = requireSchema().normalizeProfile(merged, index, purpose);
      return next;
    }, { retest: true });
  }

  async function removeProfile(id, purpose) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    var key = purpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    clearInlineCache();
    return persistCanonical(function(next) {
      next[key] = next[key].filter(function(profile) { return profile.id !== id; });
      if (purpose === 'chat' && next.chatProfileId === id) next.chatProfileId = '';
      if (purpose === 'inline' && next.inlineProfileId === id) next.inlineProfileId = '';
      return next;
    }, { retest: true });
  }

  async function setProfileFor(purpose, id) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    return persistCanonical(function(next) {
      var key = purpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
      if (id && !next[key].some(function(profile) { return profile.id === id; })) return settingsFailure('ai.error.noModel');
      if (purpose === 'inline') {
        next.inlineProfileId = id || '';
        next.inline.enabled = Boolean(id);
      } else next.chatProfileId = id || '';
      return next;
    }, { retest: true });
  }

  function promptBuilder() {
    if (!BOBO.aiPrompts || typeof BOBO.aiPrompts.buildChatMessages !== 'function') throw new Error('ai-prompts.js must load before ai-service.js');
    return BOBO.aiPrompts;
  }

  function buildMessages(userMessage, context) {
    return promptBuilder().buildChatMessages({ settings: settingsFromState(), context: context || {}, history: S.ai.chatMessages || [], userMessage: String(userMessage || '') }).messages;
  }

  function buildChatPayload(profile, userMessage, context, requestId, stream) {
    var settings = settingsFromState();
    var built = promptBuilder().buildChatMessages({ settings: settings, context: context || {}, history: S.ai.chatMessages || [], userMessage: String(userMessage || '') });
    var parameters = settings.chat.parameters;
    return {
      requestId: requestId || ('chat-' + (++activeChatNonce)),
      messages: built.messages,
      contextMetadata: built.metadata,
      modelConfig: connectionForProfile(profile, 'chat'),
      maxTokens: parameters.maxTokens,
      temperature: parameters.temperature,
      topP: parameters.topP,
      stop: parameters.stop,
      stream: stream !== false
    };
  }

  async function sendChat(message, context) {
    var profile = getProfileFor('chat');
    var status = modelStatus(profile, 'chat');
    if (status.state !== 'ready') {
      updateOverallStatus();
      if (chatListeners.error) chatListeners.error({ code: status.code });
      return resultError(status.code);
    }
    var payload = buildChatPayload(profile, message, context, '', true);
    var nonce = activeChatNonce;
    activeChatRequestId = payload.requestId;
    updateStatus('thinking');
    S.ai.chatStreaming = true;
    try {
      var response = await global.api.aiChatRequest(payload);
      if (nonce !== activeChatNonce) return resultError('ai.error.cancelled');
      if (!response || response.error || response.success === false) {
        var code = response && response.code ? response.code : 'ai.error.requestFailed';
        var ownsRequest = activeChatRequestId === payload.requestId;
        if (ownsRequest) activeChatRequestId = '';
        updateStatus('error');
        S.ai.chatStreaming = false;
        if (ownsRequest && chatListeners.error) chatListeners.error({ code: code, detail: response && response.error });
        return resultError(code, response && response.error);
      }
      return { success: true };
    } catch (error) {
      if (nonce !== activeChatNonce) return resultError('ai.error.cancelled');
      var ownsRequest = activeChatRequestId === payload.requestId;
      if (ownsRequest) activeChatRequestId = '';
      updateStatus('error');
      S.ai.chatStreaming = false;
      if (ownsRequest && chatListeners.error) chatListeners.error({ code: 'ai.error.requestFailed', detail: error && error.message });
      return resultError('ai.error.requestFailed', error && error.message);
    }
  }

  function cancelStream() {
    activeChatNonce += 1;
    activeChatRequestId = '';
    S.ai.chatStreaming = false;
    updateOverallStatus();
    return global.api.aiCancelStream();
  }

  function buildInlineRequest(candidate, context, requestId) {
    context = context || {};
    var settings = settingsFromState();
    var profile = normalizeCandidate(candidate || getProfileFor('inline'), 'inline');
    var connection = connectionForProfile(profile, 'inline');
    var policy = settings.inline.context;
    var parameters = settings.inline.parameters;
    var before = String(context.codeBefore || '').slice(-policy.prefixChars);
    var after = String(context.codeAfter || '').slice(0, policy.suffixChars);
    var base = {
      requestId: requestId,
      mode: connection.mode,
      modelConfig: connection,
      stream: false,
      maxTokens: parameters.maxTokens,
      temperature: parameters.temperature,
      topP: parameters.topP,
      stop: parameters.stop
    };
    if (connection.mode === 'fim') {
      base.prompt = before;
      base.suffix = after;
      return base;
    }
    base.messages = [{ role: 'user', content: promptBuilder().buildInlineChatMessage(settings, { codeBefore: before, codeAfter: after, language: context.language, fileName: context.fileName }) }];
    return base;
  }

  function extractInlineText(response) {
    var data = response && response.data ? response.data : response;
    if (!data) return '';
    if (data.choices && data.choices[0]) {
      if (typeof data.choices[0].text === 'string') return data.choices[0].text;
      if (data.choices[0].message && typeof data.choices[0].message.content === 'string') return data.choices[0].message.content;
    }
    if (data.content && data.content[0] && typeof data.content[0].text === 'string') return data.content[0].text;
    return '';
  }

  function extractChatText(response) {
    var data = response && response.data ? response.data : response;
    if (!data || typeof data !== 'object') return '';
    if (data.choices && data.choices[0]) {
      if (data.choices[0].message && typeof data.choices[0].message.content === 'string') return data.choices[0].message.content;
      if (typeof data.choices[0].text === 'string') return data.choices[0].text;
    }
    if (Array.isArray(data.content)) {
      for (var i = 0; i < data.content.length; i++) {
        if (data.content[i] && typeof data.content[i].text === 'string' && data.content[i].text.trim()) return data.content[i].text;
      }
    }
    return '';
  }

  function hasProviderResponseShape(response, purpose) {
    var data = response && response.data ? response.data : response;
    if (!data || typeof data !== 'object' || response && response.success === false || response && response.error) return false;
    if (Array.isArray(data.choices) && data.choices.length) {
      var choice = data.choices[0] || {};
      if (purpose === 'inline') {
        return Object.prototype.hasOwnProperty.call(choice, 'text') ||
          Boolean(choice.message && Object.prototype.hasOwnProperty.call(choice.message, 'content'));
      }
      return Boolean(choice.message && Object.prototype.hasOwnProperty.call(choice.message, 'content')) ||
        Object.prototype.hasOwnProperty.call(choice, 'text');
    }
    return Array.isArray(data.content);
  }

  function inlineCacheKey(profile, context) {
    var settings = settingsFromState();
    var connection = connectionForProfile(profile, 'inline');
    return [connection.id, connection.modelId, connection.endpoint, connection.mode, JSON.stringify(connection.options), JSON.stringify(settings.inline), settings.globalInstructions, context.language, context.fileName, context.codeBefore, context.codeAfter].join('\u0000');
  }

  function rememberInline(key, value) {
    if (inlineCache.has(key)) inlineCache.delete(key);
    inlineCache.set(key, value);
    while (inlineCache.size > INLINE_CACHE_LIMIT) inlineCache.delete(inlineCache.keys().next().value);
  }

  async function getInlineCompletion(context) {
    var settings = settingsFromState();
    if (!settings.inline.enabled || !settings.inlineProfileId) return resultError('ai.error.inlineDisabled');
    var profile = getProfileFor('inline');
    var status = modelStatus(profile, 'inline');
    if (status.state !== 'ready') return resultError(status.code);
    var key = inlineCacheKey(profile, context);
    if (inlineCache.has(key)) return { success: true, text: inlineCache.get(key), cached: true };
    var previousRequestId = activeInlineRequestId;
    var requestId = 'inline-' + (++inlineNonce);
    activeInlineRequestId = requestId;
    if (previousRequestId && global.api.aiCancelInline) {
      try { var cancellation = global.api.aiCancelInline(previousRequestId); if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(function() {}); } catch (_) {}
    }
    S.ai.inlineStatus = 'requesting';
    try {
      var response = await global.api.aiInlineRequest(buildInlineRequest(profile, context, requestId));
      if (requestId !== 'inline-' + inlineNonce) return resultError('ai.error.cancelled');
      activeInlineRequestId = '';
      var text = extractInlineText(response).trim();
      S.ai.inlineStatus = 'idle';
      if (!response || response.success === false || !text) return resultError(response && response.code || 'ai.error.noSuggestion');
      var maxChars = Math.min(16000, Math.max(256, settings.inline.parameters.maxTokens * 8));
      text = text.replace(/^```[^\n]*\n?|```$/g, '').slice(0, maxChars);
      rememberInline(key, text);
      return { success: true, text: text, cached: false };
    } catch (error) {
      if (requestId !== 'inline-' + inlineNonce) return resultError('ai.error.cancelled');
      activeInlineRequestId = '';
      S.ai.inlineStatus = 'degraded';
      return resultError('ai.error.requestFailed', error && error.message);
    }
  }

  function cancelInline() {
    inlineNonce += 1;
    S.ai.inlineStatus = 'idle';
    var requestId = activeInlineRequestId;
    activeInlineRequestId = '';
    if (requestId && global.api.aiCancelInline) {
      try { var cancellation = global.api.aiCancelInline(requestId); if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(function() {}); } catch (_) {}
    }
  }

  function clearInlineCache() { inlineCache.clear(); }

  async function testProfileConnection(candidate, purpose) {
    purpose = purpose === 'inline' ? 'inline' : 'chat';
    var profile = normalizeCandidate(candidate, purpose);
    var structural = structuralStatus(profile, purpose);
    if (structural.state !== 'complete') return resultError(structural.code);
    var currentFingerprint = fingerprint(profile, purpose);
    var currentProfile = getProfileById(profile.id, purpose);
    var publishesHealth = Boolean(currentProfile && fingerprint(currentProfile, purpose) === currentFingerprint);
    var testKey = profile.id + '\u0000' + currentFingerprint;
    var testNonce = (connectionTestNonce[purpose][testKey] || 0) + 1;
    connectionTestNonce[purpose][testKey] = testNonce;
    if (publishesHealth) {
      ensureHealthState()[purpose][profile.id] = { state: 'testing', code: 'ai.status.testing', fingerprint: currentFingerprint, testNonce: testNonce };
      updateOverallStatus();
    }

    function isLatestTest() {
      return connectionTestNonce[purpose][testKey] === testNonce;
    }

    function canPublish() {
      if (!publishesHealth || !isLatestTest()) return false;
      var latestProfile = getProfileById(profile.id, purpose);
      var health = ensureHealthState()[purpose][profile.id];
      return Boolean(latestProfile && fingerprint(latestProfile, purpose) === currentFingerprint &&
        health && health.fingerprint === currentFingerprint && health.testNonce === testNonce);
    }

    function publish(record) {
      if (!canPublish()) return false;
      ensureHealthState()[purpose][profile.id] = record;
      updateOverallStatus();
      return true;
    }

    try {
      // Connection probes must be valid without an open workspace. They use a
      // deterministic, self-contained sample instead of editor/chat context.
      var payload = purpose === 'inline'
        ? {
            requestId: 'test-inline-' + Date.now(),
            mode: profile.mode === 'fim' ? 'fim' : 'chat',
            modelConfig: connectionForProfile(profile, 'inline'),
            stream: false,
            maxTokens: 8,
            temperature: 0,
            topP: 1,
            stop: [],
            prompt: 'function connectionProbe() {\n  return ',
            suffix: ';\n}',
            messages: profile.mode === 'fim' ? undefined : [{ role: 'user', content: 'Complete this JavaScript expression: const connectionProbe = ' }]
          }
        : buildChatPayload(profile, 'Reply with the single word OK.', {}, 'test-chat-' + Date.now(), false);
      var response = await global.api.aiTestConnection(payload);
      // Some completion providers return an empty candidate for a tiny probe.
      // A valid protocol response still proves endpoint/auth/model connectivity.
      var success = hasProviderResponseShape(response, purpose);
      var record = success
        ? { state: 'ready', code: 'ai.status.connected', fingerprint: currentFingerprint, checkedAt: Date.now() }
        : { state: 'error', code: response && response.code || 'ai.error.connectionFailed', detail: response && response.error || '', fingerprint: currentFingerprint, checkedAt: Date.now() };
      if (!isLatestTest()) return resultError('ai.error.cancelled');
      if (publishesHealth && !publish(record)) return resultError('ai.error.cancelled');
      return success ? { success: true, health: clone(record) } : resultError(record.code, record.detail);
    } catch (error) {
      var failed = { state: 'error', code: 'ai.error.connectionFailed', detail: error && error.message || '', fingerprint: currentFingerprint, checkedAt: Date.now() };
      if (!isLatestTest()) return resultError('ai.error.cancelled');
      if (publishesHealth && !publish(failed)) return resultError('ai.error.cancelled');
      return resultError(failed.code, failed.detail);
    }
  }

  async function testActiveConnections() {
    var tasks = [];
    var chatProfile = getProfileFor('chat');
    var inlineProfile = S.ai.inline && S.ai.inline.enabled ? getProfileFor('inline') : null;
    if (chatProfile) tasks.push(testProfileConnection(chatProfile, 'chat'));
    if (inlineProfile) tasks.push(testProfileConnection(inlineProfile, 'inline'));
    if (!tasks.length) updateOverallStatus();
    await Promise.all(tasks);
    return { chat: modelStatus(chatProfile, 'chat'), inline: inlineProfile ? modelStatus(inlineProfile, 'inline') : { state: 'disabled', code: 'ai.control.status.disabled' } };
  }

  function setupStreamListeners() {
    if (global.api.onAiChunk) global.api.onAiChunk(function(data) {
      if (!activeChatRequestId || !data || data.requestId !== activeChatRequestId) return;
      if (chatListeners.chunk) chatListeners.chunk(data);
    });
    if (global.api.onAiStreamEnd) global.api.onAiStreamEnd(function(data) {
      if (!activeChatRequestId || !data || data.requestId !== activeChatRequestId) return;
      activeChatRequestId = '';
      S.ai.chatStreaming = false;
      updateOverallStatus();
      if (chatListeners.end) chatListeners.end(data);
    });
    if (global.api.onAiStreamError) global.api.onAiStreamError(function(data) {
      if (!activeChatRequestId || !data || data.requestId !== activeChatRequestId) return;
      activeChatRequestId = '';
      S.ai.chatStreaming = false;
      updateStatus('error');
      if (chatListeners.error) chatListeners.error(data && data.code ? data : { code: 'ai.error.requestFailed', detail: data && data.message });
    });
  }

  async function init() {
    requireSchema();
    promptBuilder();
    setupStreamListeners();
    return loadSettings();
  }

  function legacyToProfile(model, purpose) { return requireSchema().normalizeProfile(model || {}, 0, purpose || 'chat'); }
  function addModel(modelOrName, provider, endpoint, modelId, apiKey) {
    var value = typeof modelOrName === 'object' ? modelOrName : { id: 'chat-agent-' + Date.now(), name: modelOrName, provider: provider, endpoint: endpoint, modelId: modelId, apiKey: apiKey };
    return addProfile(legacyToProfile(value, 'chat'), 'chat');
  }
  function updateModel(id, updates) { return updateProfile(id, updates, 'chat'); }
  function removeModel(id) { return removeProfile(id, 'chat'); }
  function setModelFor(purpose, id) { return setProfileFor(purpose, id); }
  function setCurrentModel(id) { return setProfileFor('chat', id); }

  BOBO.aiService = {
    init: init,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    getSettings: getSettings,
    updateSettings: updateSettings,
    applySettings: applySettings,
    sendChat: sendChat,
    cancelStream: cancelStream,
    getInlineCompletion: getInlineCompletion,
    cancelInline: cancelInline,
    clearInlineCache: clearInlineCache,
    updateStatus: updateStatus,
    onStreamChunk: function(callback) { chatListeners.chunk = callback; },
    onStreamEnd: function(callback) { chatListeners.end = callback; },
    onStreamError: function(callback) { chatListeners.error = callback; },
    getProfiles: function(purpose) { return clone(profilesFor(purpose)); },
    getProfileFor: getProfileFor,
    getProfileById: getProfileById,
    getConnectionFor: getConnectionFor,
    addProfile: addProfile,
    updateProfile: updateProfile,
    removeProfile: removeProfile,
    setProfileFor: setProfileFor,
    testProfileConnection: testProfileConnection,
    testActiveConnections: testActiveConnections,
    getConnectionHealth: function(purpose, id) { return clone(ensureHealthState()[purpose === 'inline' ? 'inline' : 'chat'][id] || null); },
    getModelFor: function(purpose) { return profileToLegacy(getProfileFor(purpose), purpose); },
    getModelById: function(id, purpose) { return profileToLegacy(getProfileById(id, purpose), purpose); },
    getCurrentModelConfig: function() { return profileToLegacy(getProfileFor('chat'), 'chat'); },
    getCurrentModelName: function() { var profile = getProfileFor('chat'); return profile ? profile.name : ''; },
    getModelStatus: modelStatus,
    addModel: addModel,
    updateModel: updateModel,
    removeModel: removeModel,
    setCurrentModel: setCurrentModel,
    setModelFor: setModelFor,
    testModelConnection: testProfileConnection,
    buildChatPayload: buildChatPayload,
    buildInlineRequest: buildInlineRequest,
    buildMessages: buildMessages,
    extractInlineText: extractInlineText,
    extractChatText: extractChatText,
    sanitizeModel: function(model) { return profileToLegacy(legacyToProfile(model, 'chat'), 'chat'); },
    fingerprint: fingerprint
  };
})(window);
