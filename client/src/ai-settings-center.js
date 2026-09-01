// Independent AI control center with draft-based settings editing.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var S = BOBO.state;
  var modal = null;
  var content = null;
  var statusEl = null;
  var saveStatusEl = null;
  var activeTab = 'overview';
  var draft = null;
  var dirty = false;
  var saving = false;
  var autoSaveTimer = null;
  var activeSavePromise = null;
  var draftRevision = 0;
  var saveGeneration = 0;
  var profileTestGeneration = Object.create(null);
  var previousFocus = null;
  var editingProfileId = '';
  var editingPurpose = 'chat';
  var profileEditorDraft = null;
  var profileEditorRaw = null;
  var profileEditorProviderDrafts = Object.create(null);
  var profileEditorAdvancedOpen = false;
  var profileEditorRenderGeneration = 0;
  var unsubscribeLocale = null;

  function t(key, params) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(key, params) : String(key);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalize(value) {
    return BOBO.aiSettingsSchema && BOBO.aiSettingsSchema.normalizeSettings
      ? BOBO.aiSettingsSchema.normalizeSettings(value)
      : clone(value || {});
  }

  function settingsSnapshot() {
    if (BOBO.aiService && BOBO.aiService.getSettings) return BOBO.aiService.getSettings();
    return normalize(S.ai || {});
  }

  function profilesFor(purpose) {
    return purpose === 'inline' ? (draft.inlineProfiles || []) : (draft.chatProfiles || []);
  }

  function profileById(id, purpose) {
    return profilesFor(purpose).find(function(profile) { return profile.id === id; }) || null;
  }

  function connectionState(profile, purpose) {
    if (!profile) return { state: 'error', key: 'ai.error.noModel' };
    if (!String(profile.endpoint || '').trim()) return { state: 'error', key: 'ai.error.endpointRequired' };
    if (!String(profile.modelId || '').trim()) return { state: 'error', key: 'ai.error.modelRequired' };
    if (!String(profile.apiKey || '').trim()) return { state: 'warning', key: 'ai.error.keyRequired' };
    var status = BOBO.aiService && BOBO.aiService.getModelStatus
      ? BOBO.aiService.getModelStatus(profile, purpose)
      : { state: 'untested', code: 'ai.status.untested' };
    return { state: status.state === 'ready' ? 'ready' : status.state === 'error' ? 'error' : 'warning', key: status.code || 'ai.status.untested' };
  }

  function overallState() {
    var chatEnabled = Boolean(draft.chatProfileId);
    var inlineEnabled = Boolean(draft.inline.enabled && draft.inlineProfileId);
    var chat = chatEnabled ? connectionState(profileById(draft.chatProfileId, 'chat'), 'chat') : { state: 'disabled' };
    var inline = inlineEnabled ? connectionState(profileById(draft.inlineProfileId, 'inline'), 'inline') : { state: 'disabled' };
    if (!chatEnabled && !inlineEnabled) return { state: 'unconfigured', key: 'ai.control.status.none' };
    if ((!chatEnabled || chat.state === 'ready') && (!inlineEnabled || inline.state === 'ready')) return { state: 'ready', key: 'ai.control.status.ready' };
    if (chat.state === 'ready' || inline.state === 'ready') return { state: 'partial', key: 'ai.control.status.partial' };
    return { state: 'unconfigured', key: 'ai.control.status.unconfigured' };
  }

  function setSaveStatus(key, state, params) {
    if (!saveStatusEl) return;
    saveStatusEl.textContent = key ? t(key, params) : '';
    saveStatusEl.dataset.state = state || '';
  }

  function markDirty() {
    draftRevision++;
    dirty = true;
    setSaveStatus('ai.control.autosavePending', '');
    scheduleAutoSave();
  }

  function scheduleAutoSave(delay) {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    // The nested profile editor is committed explicitly so partially-entered
    // endpoints and keys never leak into the active runtime configuration.
    if (!dirty || profileEditorDraft || !draft) return;
    autoSaveTimer = setTimeout(function() {
      autoSaveTimer = null;
      save();
    }, delay == null ? 650 : delay);
  }

  function element(tag, className, textKey, params) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textKey) node.textContent = t(textKey, params);
    return node;
  }

  function pageHeader(titleKey, descriptionKey) {
    var header = element('div', 'ai-control-page-header');
    header.append(element('h2', '', titleKey), element('p', '', descriptionKey));
    return header;
  }

  function section(titleKey, descriptionKey) {
    var root = element('div', 'ai-control-section');
    var heading = element('div', 'ai-control-section-heading');
    var copy = element('div');
    copy.append(element('h3', '', titleKey));
    if (descriptionKey) copy.append(element('p', '', descriptionKey));
    heading.append(copy);
    root.append(heading);
    return { root: root, heading: heading };
  }

  function button(labelKey, className, handler) {
    var node = element('button', className || 'ss-btn ss-btn-ghost', labelKey);
    node.type = 'button';
    if (handler) node.addEventListener('click', handler);
    return node;
  }

  function field(labelKey, value, options) {
    options = options || {};
    var root = element('div', 'ai-control-field' + (options.full ? ' full' : ''));
    var label = element('label');
    var caption = element('span', 'ai-control-field-label', labelKey);
    var input;
    if (options.select) {
      input = element('select', 'ai-control-select');
      options.select.forEach(function(item) {
        var option = element('option');
        option.value = item.value;
        option.textContent = item.rawLabel || t(item.labelKey);
        input.append(option);
      });
      input.value = String(value == null ? '' : value);
    } else if (options.multiline) {
      input = element('textarea', 'ai-control-textarea');
      input.value = value == null ? '' : String(value);
      input.rows = options.rows || 4;
    } else {
      input = element('input', 'ai-control-input');
      input.type = options.type || 'text';
      input.value = value == null ? '' : String(value);
      if (options.min !== undefined) input.min = String(options.min);
      if (options.max !== undefined) input.max = String(options.max);
      if (options.step !== undefined) input.step = String(options.step);
      if (options.autocomplete) input.autocomplete = options.autocomplete;
    }
    input.dataset.i18nSkip = '';
    if (options.id) input.id = options.id;
    if (options.placeholderKey) input.placeholder = t(options.placeholderKey);
    if (options.disabled) input.disabled = true;
    label.append(caption, input);
    if (options.helpKey) label.append(element('span', 'ai-control-field-help', options.helpKey));
    root.append(label);
    return { root: root, input: input };
  }

  function numberField(labelKey, value, min, max, step, onChange, helpKey) {
    var result = field(labelKey, value, { type: 'number', min: min, max: max, step: step, helpKey: helpKey });
    result.input.addEventListener('input', function() {
      var parsed = Number(result.input.value);
      parsed = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
      result.input.value = String(parsed);
      onChange(parsed);
      markDirty();
    });
    return result;
  }

  function selectField(labelKey, selectedId, onChange, includeNone, purpose) {
    var items = [];
    if (includeNone) items.push({ value: '', labelKey: 'ai.control.value.none' });
    profilesFor(purpose || 'chat').forEach(function(profile) { items.push({ value: profile.id, rawLabel: profile.name }); });
    var result = field(labelKey, selectedId, { select: items, full: true });
    result.input.addEventListener('change', function() { onChange(result.input.value); markDirty(); updateHeaderStatus(); });
    return result;
  }

  function toggleRow(titleKey, descriptionKey, checked, onChange) {
    var row = element('div', 'ai-control-toggle-row');
    var copy = element('div', 'ai-control-row-copy');
    copy.append(element('strong', '', titleKey), element('span', '', descriptionKey));
    var label = element('label', 'ai-control-switch');
    var input = element('input');
    input.type = 'checkbox';
    input.checked = checked;
    var track = element('span', 'ai-control-switch-track');
    label.append(input, track);
    input.addEventListener('change', function() { onChange(input.checked); markDirty(); updateHeaderStatus(); });
    row.append(copy, label);
    return row;
  }

  function summaryRow(titleKey, descriptionKey, state) {
    var row = element('div', 'ai-control-summary-row');
    var copy = element('div', 'ai-control-row-copy');
    copy.append(element('strong', '', titleKey), element('span', '', descriptionKey));
    var status = element('span', 'ai-control-row-state', state.key);
    status.dataset.state = state.state;
    row.append(copy, status);
    return row;
  }

  function actionForTab(tab, labelKey) {
    return button(labelKey, 'ss-btn ss-btn-ghost', function() { switchTab(tab); });
  }

  function renderOverview(pane) {
    pane.append(pageHeader('ai.control.overview.title', 'ai.control.overview.description'));
    var readiness = section('ai.control.overview.readiness', 'ai.control.overview.readinessDescription');
    var chatState = draft.chatProfileId
      ? connectionState(profileById(draft.chatProfileId, 'chat'), 'chat')
      : { state: 'warning', key: 'ai.control.status.disabled' };
    var inlineState = draft.inline.enabled && draft.inlineProfileId
      ? connectionState(profileById(draft.inlineProfileId, 'inline'), 'inline')
      : { state: 'warning', key: 'ai.control.status.disabled' };
    readiness.root.append(
      summaryRow('ai.control.chat.title', 'ai.control.chat.summary', chatState),
      summaryRow('ai.control.inline.title', 'ai.control.inline.summary', inlineState),
      summaryRow('ai.control.connections.title', 'ai.control.connections.count', {
        state: draft.chatProfiles.length || draft.inlineProfiles.length ? 'ready' : 'warning',
        key: draft.chatProfiles.length || draft.inlineProfiles.length ? 'ai.control.status.available' : 'ai.control.status.none'
      })
    );
    pane.append(readiness.root);

    var routes = section('ai.control.overview.configure', 'ai.control.overview.configureDescription');
    var actions = element('div', 'ai-control-button-row');
    actions.append(
      actionForTab('connections', 'ai.control.connections.manage'),
      actionForTab('chat', 'ai.control.chat.configure'),
      actionForTab('inline', 'ai.control.inline.configure'),
      actionForTab('instructions', 'ai.control.instructions.configure')
    );
    routes.root.append(actions);
    pane.append(routes.root);

    var boundary = section('ai.control.overview.boundary', 'ai.control.overview.boundaryDescription');
    var callout = element('div', 'ai-control-callout');
    callout.append(element('span', '', 'ai.control.overview.boundaryNote'));
    boundary.root.append(callout);
    pane.append(boundary.root);
  }

  async function testProfile(profile, purpose, target, trigger) {
    var testKey = purpose + ':' + profile.id;
    var generation = (profileTestGeneration[testKey] || 0) + 1;
    profileTestGeneration[testKey] = generation;
    if (trigger) trigger.disabled = true;
    target.dataset.state = 'warning';
    target.textContent = t('ai.status.testing');
    var service = BOBO.aiService;
    var tester = service && (service.testProfileConnection || service.testModelConnection);
    if (!tester) {
      target.dataset.state = 'error';
      target.textContent = t('ai.error.connectionFailed');
      if (trigger) trigger.disabled = false;
      return;
    }
    try {
      var result = await tester.call(service, profile, purpose);
      if (profileTestGeneration[testKey] !== generation || !target.isConnected) return;
      target.dataset.state = result && result.success ? 'ready' : 'error';
      var card = target.closest('.ai-control-profile');
      if (card) card.dataset.health = result && result.success ? 'ready' : 'error';
      target.textContent = result && result.success ? t('ai.status.connected') : t(result && result.code || 'ai.error.connectionFailed');
      updateHeaderStatus();
    } catch (_) {
      if (profileTestGeneration[testKey] !== generation || !target.isConnected) return;
      target.dataset.state = 'error';
      target.textContent = t('ai.error.connectionFailed');
      var failedCard = target.closest('.ai-control-profile');
      if (failedCard) failedCard.dataset.health = 'error';
      updateHeaderStatus();
    } finally {
      if (trigger && profileTestGeneration[testKey] === generation && trigger.isConnected) trigger.disabled = false;
    }
  }

  function parseOptions(value) {
    var text = String(value || '').trim();
    if (!text) return {};
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('options');
    return parsed;
  }

  function schemaApi() {
    return BOBO.aiSettingsSchema || {};
  }

  function providerDefinition(provider) {
    var schema = schemaApi();
    var id = schema.normalizeProviderId ? schema.normalizeProviderId(provider) : String(provider || 'openai-compatible');
    return {
      id: id,
      definition: schema.PROVIDER_CATALOG && schema.PROVIDER_CATALOG[id] || {
        labelKey: 'ai.control.provider.compatible',
        protocols: ['chat-completions'],
        defaultProtocol: 'chat-completions',
        authTypes: ['bearer'],
        defaultAuthType: 'bearer'
      }
    };
  }

  function providerSelectItems() {
    var schema = schemaApi();
    var order = Array.isArray(schema.PROVIDER_ORDER) ? schema.PROVIDER_ORDER : ['openai', 'anthropic', 'deepseek', 'glm', 'kimi', 'qwen', 'openai-compatible'];
    return order.map(function(provider) {
      var resolved = providerDefinition(provider);
      return { value: resolved.id, labelKey: resolved.definition.labelKey };
    });
  }

  function protocolSelectItems(definition) {
    return definition.protocols.map(function(protocol) {
      return { value: protocol, labelKey: 'ai.control.protocol.' + protocol };
    });
  }

  function authSelectItems(definition) {
    return definition.authTypes.map(function(authType) {
      return { value: authType, labelKey: 'ai.control.auth.' + authType };
    });
  }

  function rawOrProfile(raw, profile, key, fallback) {
    if (raw[key] !== undefined) return raw[key];
    if (profile[key] !== undefined && profile[key] !== null) return profile[key];
    return fallback === undefined ? '' : fallback;
  }

  function parseCapabilityInteger(value, maximum) {
    var candidate = String(value == null ? '' : value).trim();
    if (!candidate) return null;
    var parsed = Number(candidate);
    var upperBound = Number.isInteger(maximum) ? maximum : 100000000;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > upperBound) throw new Error('capabilities');
    return parsed;
  }

  function parseCapabilityBoolean(value) {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return null;
  }

  function parseReasoningEfforts(value) {
    var schema = schemaApi();
    var allowed = Array.isArray(schema.REASONING_EFFORTS) ? schema.REASONING_EFFORTS : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    var result = [];
    String(value || '').split(',').forEach(function(item) {
      var effort = item.trim().toLowerCase();
      if (!effort || result.indexOf(effort) >= 0) return;
      if (allowed.indexOf(effort) < 0) throw new Error('efforts');
      result.push(effort);
    });
    return result;
  }

  function collectProfileValues(form) {
    var values = Object.assign({}, profileEditorRaw || {});
    Array.prototype.forEach.call(form.querySelectorAll('[data-profile-field]'), function(input) {
      values[input.dataset.profileField] = input.value;
    });
    return values;
  }

  function validEndpoint(value) {
    if (!String(value || '').trim()) return true;
    try {
      var url = new URL(String(value).trim());
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) { return false; }
  }

  function collectProfileForm(form) {
    var values = collectProfileValues(form);
    var provider = providerDefinition(values.provider);
    var capabilities = {
      contextWindowTokens: parseCapabilityInteger(values.capabilityContextWindowTokens),
      maxOutputTokens: parseCapabilityInteger(values.capabilityMaxOutputTokens),
      tools: parseCapabilityBoolean(values.capabilityTools),
      streaming: parseCapabilityBoolean(values.capabilityStreaming),
      parallelToolCalls: parseCapabilityBoolean(values.capabilityParallelToolCalls),
      reasoningEfforts: parseReasoningEfforts(values.capabilityReasoningEfforts),
      effectiveEffortMap: parseOptions(values.capabilityEffectiveEffortMap),
      source: values.capabilitySource || 'unknown'
    };
    if (capabilities.source === 'unknown' && (
      capabilities.contextWindowTokens !== null || capabilities.maxOutputTokens !== null ||
      capabilities.tools !== null || capabilities.streaming !== null || capabilities.parallelToolCalls !== null ||
      capabilities.reasoningEfforts.length || Object.keys(capabilities.effectiveEffortMap).length
    )) capabilities.source = 'user-override';
    var profile = {
      id: editingProfileId || ('profile-' + Date.now()),
      name: values.name.trim(),
      provider: provider.id,
      protocol: provider.definition.protocols.indexOf(values.protocol) >= 0 ? values.protocol : provider.definition.defaultProtocol,
      authType: provider.definition.authTypes.indexOf(values.authType) >= 0 ? values.authType : provider.definition.defaultAuthType,
      apiKey: values.apiKey,
      endpoint: values.endpoint.trim(),
      modelId: values.modelId.trim(),
      mode: editingPurpose === 'inline' && values.mode === 'fim' ? 'fim' : 'chat',
      apiVersion: provider.definition.apiVersion ? String(values.apiVersion || provider.definition.apiVersion).trim() : '',
      organizationId: provider.definition.organization ? String(values.organizationId || '').trim() : '',
      projectId: provider.definition.project ? String(values.projectId || '').trim() : '',
      workspaceId: provider.definition.workspace ? String(values.workspaceId || '').trim() : '',
      region: provider.definition.region ? values.region : '',
      billingPlan: provider.definition.billingPlan ? values.billingPlan : '',
      capabilities: capabilities,
      options: parseOptions(values.options)
    };
    if (!profile.name) throw new Error('name');
    if (profile.provider === 'qwen' && profile.billingPlan === 'workspace' &&
        (!schemaApi().validQwenWorkspaceId || !schemaApi().validQwenWorkspaceId(profile.workspaceId))) throw new Error('workspace');
    if (!profile.endpoint || !profile.modelId) throw new Error('pair');
    if (!validEndpoint(profile.endpoint)) throw new Error('endpoint');
    return profile;
  }

  function captureProfileForm(form, changedInput) {
    if (!form || !form.isConnected || !modal || form !== modal.querySelector('.ai-profile-editor form')) return;
    var values = profileEditorRaw ? Object.assign({}, profileEditorRaw) : collectProfileValues(form);
    var changedField = changedInput && changedInput.dataset.profileField;
    if (changedField) values[changedField] = changedInput.value;
    profileEditorRaw = values;
    if (changedField === 'endpoint') profileEditorRaw.endpointTouched = true;
    markDirty();
  }

  function profileErrorKey(error) {
    var code = error && error.message;
    if (code === 'name') return 'ai.control.profile.errorName';
    if (code === 'empty') return 'ai.control.profile.errorEmpty';
    if (code === 'pair') return 'ai.control.profile.errorPair';
    if (code === 'endpoint') return 'ai.control.profile.errorEndpoint';
    if (code === 'workspace') return 'ai.control.profile.errorWorkspace';
    if (code === 'options') return 'ai.control.profile.errorOptions';
    if (code === 'capabilities') return 'ai.control.profile.errorCapabilities';
    if (code === 'efforts') return 'ai.control.profile.errorEfforts';
    return 'ai.control.profile.errorInvalid';
  }

  function profileField(form, labelKey, value, name, options) {
    var result = field(labelKey, value, options || {});
    result.input.dataset.profileField = name;
    form.append(result.root);
    return result.input;
  }

  function commitProfileForm(form) {
    var next = collectProfileForm(form);
    var list = profilesFor(editingPurpose);
    var index = list.findIndex(function(item) { return item.id === editingProfileId; });
    if (index >= 0) list[index] = next;
    else list.push(next);
    editingProfileId = '';
    profileEditorDraft = null;
    profileEditorRaw = null;
    profileEditorProviderDrafts = Object.create(null);
    profileEditorAdvancedOpen = false;
    markDirty();
    updateHeaderStatus();
    return next;
  }

  function triStateItems() {
    return [
      { value: '', labelKey: 'ai.control.capability.unknown' },
      { value: 'true', labelKey: 'ai.control.capability.supported' },
      { value: 'false', labelKey: 'ai.control.capability.unsupported' }
    ];
  }

  function capabilityFieldValue(raw, capabilities, key) {
    var rawKey = 'capability' + key.charAt(0).toUpperCase() + key.slice(1);
    if (raw[rawKey] !== undefined) return raw[rawKey];
    var value = capabilities[key];
    return value === undefined || value === null ? '' : value;
  }

  function currentProfileShape(profile, raw) {
    var provider = providerDefinition(rawOrProfile(raw, profile, 'provider', 'openai-compatible'));
    var protocol = rawOrProfile(raw, profile, 'protocol', provider.definition.defaultProtocol);
    if (provider.definition.protocols.indexOf(protocol) < 0) protocol = provider.definition.defaultProtocol;
    var authType = rawOrProfile(raw, profile, 'authType', provider.definition.defaultAuthType);
    if (provider.definition.authTypes.indexOf(authType) < 0) authType = provider.definition.defaultAuthType;
    return {
      provider: provider,
      protocol: protocol,
      authType: authType,
      region: rawOrProfile(raw, profile, 'region', provider.definition.region ? 'cn-beijing' : ''),
      billingPlan: rawOrProfile(raw, profile, 'billingPlan', provider.definition.billingPlan ? 'standard' : ''),
      workspaceId: rawOrProfile(raw, profile, 'workspaceId', '')
    };
  }

  function endpointForShape(shape) {
    var schema = schemaApi();
    return schema.defaultEndpointFor ? schema.defaultEndpointFor(shape.provider.id, {
      protocol: shape.protocol,
      region: shape.region,
      billingPlan: shape.billingPlan,
      workspaceId: shape.workspaceId
    }) : '';
  }

  function qwenRegionsForBillingPlan(billingPlan) {
    var schema = schemaApi();
    if (schema.qwenRegionsForBillingPlan) return schema.qwenRegionsForBillingPlan(billingPlan);
    if (billingPlan === 'workspace') return ['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'eu-central-1', 'us-east-1'];
    if (billingPlan === 'trial') return ['cn-beijing', 'ap-southeast-1'];
    if (billingPlan === 'standard') return ['cn-beijing', 'ap-southeast-1', 'us-east-1'];
    return [];
  }

  function qwenRegionSelectItems(billingPlan) {
    return qwenRegionsForBillingPlan(billingPlan).map(function(region) {
      var keys = {
        'cn-beijing': 'cnBeijing',
        'ap-southeast-1': 'apSoutheast1',
        'ap-northeast-1': 'apNortheast1',
        'eu-central-1': 'euCentral1',
        'us-east-1': 'usEast1'
      };
      return { value: region, labelKey: 'ai.control.region.' + keys[region] };
    });
  }

  function emptyRawForProvider(provider, common) {
    var definition = provider.definition;
    var raw = {
      name: common.name || '',
      provider: provider.id,
      protocol: definition.defaultProtocol,
      authType: definition.defaultAuthType,
      apiKey: '',
      endpoint: '',
      modelId: '',
      mode: common.mode || (editingPurpose === 'inline' ? 'fim' : 'chat'),
      apiVersion: definition.apiVersion || '',
      organizationId: '',
      projectId: '',
      workspaceId: '',
      region: definition.region ? 'cn-beijing' : '',
      billingPlan: definition.billingPlan ? 'standard' : '',
      capabilityContextWindowTokens: '',
      capabilityMaxOutputTokens: '',
      capabilityTools: '',
      capabilityStreaming: '',
      capabilityParallelToolCalls: '',
      capabilityReasoningEfforts: '',
      capabilityEffectiveEffortMap: '{}',
      capabilitySource: 'unknown',
      options: '{}'
    };
    raw.endpoint = endpointForShape({
      provider: provider,
      protocol: raw.protocol,
      authType: raw.authType,
      region: raw.region,
      billingPlan: raw.billingPlan,
      workspaceId: raw.workspaceId
    });
    return raw;
  }

  function updateDynamicProfileShape(form, previousShape) {
    var endpointInput = form.querySelector('[data-profile-field="endpoint"]');
    var previousDefault = endpointForShape(previousShape);
    var endpointValue = endpointInput ? endpointInput.value.trim() : '';
    var managedEndpoint = !endpointValue || endpointValue === previousDefault;
    var captured = collectProfileValues(form);
    var nextProvider = providerDefinition(captured.provider);
    var providerChanged = nextProvider.id !== previousShape.provider.id;
    if (providerChanged) {
      captured.provider = previousShape.provider.id;
      captured.protocol = previousShape.protocol;
      captured.authType = previousShape.authType;
      profileEditorProviderDrafts[previousShape.provider.id] = Object.assign({}, captured);
      var restored = profileEditorProviderDrafts[nextProvider.id];
      profileEditorRaw = restored
        ? Object.assign({}, restored, { name: captured.name || '', mode: captured.mode || restored.mode, provider: nextProvider.id })
        : emptyRawForProvider(nextProvider, { name: captured.name, mode: captured.mode });
      markDirty();
      renderActivePane();
      return;
    }

    profileEditorRaw = captured;
    profileEditorRaw.provider = nextProvider.id;
    if (nextProvider.definition.protocols.indexOf(profileEditorRaw.protocol) < 0) profileEditorRaw.protocol = nextProvider.definition.defaultProtocol;
    if (nextProvider.definition.authTypes.indexOf(profileEditorRaw.authType) < 0) profileEditorRaw.authType = nextProvider.definition.defaultAuthType;
    if (nextProvider.definition.apiVersion && !String(profileEditorRaw.apiVersion || '').trim()) profileEditorRaw.apiVersion = nextProvider.definition.apiVersion;
    if (nextProvider.definition.billingPlan && ['standard', 'workspace', 'trial', 'token-plan', 'coding-plan'].indexOf(profileEditorRaw.billingPlan) < 0) profileEditorRaw.billingPlan = 'standard';
    if (nextProvider.definition.region) {
      var allowedRegions = qwenRegionsForBillingPlan(profileEditorRaw.billingPlan);
      if (allowedRegions.indexOf(profileEditorRaw.region) < 0) profileEditorRaw.region = allowedRegions[0] || '';
    }
    if (managedEndpoint) profileEditorRaw.endpoint = endpointForShape(currentProfileShape(profileEditorDraft, profileEditorRaw));
    markDirty();
    renderActivePane();
  }

  function updateManagedEndpoint(form, previousShape) {
    var endpointInput = form.querySelector('[data-profile-field="endpoint"]');
    if (!endpointInput || !profileEditorRaw || profileEditorRaw.endpointTouched === true) return;
    var endpointValue = endpointInput.value.trim();
    var previousDefault = endpointForShape(previousShape);
    if (endpointValue && endpointValue !== previousDefault) return;
    var nextDefault = endpointForShape(currentProfileShape(profileEditorDraft, profileEditorRaw));
    endpointInput.value = nextDefault;
    profileEditorRaw.endpoint = nextDefault;
  }

  function renderProfileEditor(parent) {
    var renderGeneration = ++profileEditorRenderGeneration;
    var editor = element('div', 'ai-profile-editor' + (profileEditorDraft ? ' open' : ''));
    if (!profileEditorDraft) { parent.append(editor); return; }
    var shouldFocusName = !profileEditorRaw;
    var profile = profileEditorDraft;
    var raw = profileEditorRaw || {};
    var shape = currentProfileShape(profile, raw);
    var definition = shape.provider.definition;
    var capabilities = profile.capabilities || {};
    var head = element('div', 'ai-profile-editor-header');
    head.append(element('h3', '', editingPurpose === 'inline'
      ? (editingProfileId ? 'ai.control.profile.editInlineTitle' : 'ai.control.profile.addInlineTitle')
      : (editingProfileId ? 'ai.control.profile.editChatTitle' : 'ai.control.profile.addChatTitle')));
    head.append(button('ai.control.profile.closeEditor', 'ss-btn ss-btn-ghost', function() {
      editingProfileId = '';
      profileEditorDraft = null;
      profileEditorRaw = null;
      profileEditorProviderDrafts = Object.create(null);
      profileEditorAdvancedOpen = false;
      renderActivePane();
    }));
    editor.append(head);
    var form = element('form', 'ai-control-field-grid');
    var name = profileField(form, 'ai.control.profile.name', raw.name !== undefined ? raw.name : profile.name, 'name', { full: true, placeholderKey: 'ai.control.profile.namePlaceholder' });
    var provider = profileField(form, 'ai.control.profile.provider', shape.provider.id, 'provider', { select: providerSelectItems() });
    provider.dataset.profileDynamic = 'shape';
    var protocol = profileField(form, 'ai.control.profile.protocol', shape.protocol, 'protocol', { select: protocolSelectItems(definition) });
    protocol.dataset.profileDynamic = 'shape';
    var authType = profileField(form, 'ai.control.profile.authType', shape.authType, 'authType', { select: authSelectItems(definition), helpKey: 'ai.control.profile.authTypeHelp' });
    authType.dataset.profileDynamic = 'shape';
    var key = profileField(form, 'ai.control.profile.apiKey', rawOrProfile(raw, profile, 'apiKey', ''), 'apiKey', { type: 'password', autocomplete: 'off', helpKey: 'ai.control.profile.apiKeyHelp' });
    name.maxLength = 160;
    provider.maxLength = 80;
    key.maxLength = 12000;

    if (definition.billingPlan) {
      var billingPlan = profileField(form, 'ai.control.profile.billingPlan', shape.billingPlan, 'billingPlan', { select: [
        { value: 'standard', labelKey: 'ai.control.billing.standard' },
        { value: 'workspace', labelKey: 'ai.control.billing.workspace' },
        { value: 'trial', labelKey: 'ai.control.billing.trial' },
        { value: 'token-plan', labelKey: 'ai.control.billing.tokenPlan' },
        { value: 'coding-plan', labelKey: 'ai.control.billing.codingPlan' }
      ], helpKey: 'ai.control.profile.billingPlanHelp' });
      billingPlan.dataset.profileDynamic = 'shape';
    }
    var regionItems = definition.region ? qwenRegionSelectItems(shape.billingPlan) : [];
    if (regionItems.length) {
      var region = profileField(form, 'ai.control.profile.region', shape.region, 'region', { select: regionItems, helpKey: 'ai.control.profile.regionHelp' });
      region.dataset.profileDynamic = 'shape';
    }
    if (definition.apiVersion) profileField(form, 'ai.control.profile.apiVersion', rawOrProfile(raw, profile, 'apiVersion', definition.apiVersion), 'apiVersion', { helpKey: 'ai.control.profile.apiVersionHelp' });
    if (definition.organization) profileField(form, 'ai.control.profile.organizationId', rawOrProfile(raw, profile, 'organizationId', ''), 'organizationId', { helpKey: 'ai.control.profile.organizationIdHelp' });
    if (definition.project) profileField(form, 'ai.control.profile.projectId', rawOrProfile(raw, profile, 'projectId', ''), 'projectId', { helpKey: 'ai.control.profile.projectIdHelp' });
    if (definition.workspace && shape.billingPlan === 'workspace') {
      var workspace = profileField(form, 'ai.control.profile.workspaceId', shape.workspaceId, 'workspaceId', { helpKey: 'ai.control.profile.qwenWorkspaceHelp' });
      workspace.dataset.profileDynamic = 'endpoint';
    }

    var endpointDefault = endpointForShape(shape);
    var endpointValue = rawOrProfile(raw, profile, 'endpoint', endpointDefault);
    if (!String(endpointValue || '').trim() && endpointDefault && raw.endpointTouched !== true) endpointValue = endpointDefault;
    profileField(form, 'ai.control.profile.endpoint', endpointValue, 'endpoint', { full: true, placeholderKey: 'ai.control.profile.endpointPlaceholder', helpKey: 'ai.control.profile.endpointHelp' });
    profileField(form, 'ai.control.profile.modelId', rawOrProfile(raw, profile, 'modelId', ''), 'modelId', { placeholderKey: 'ai.control.profile.modelPlaceholder', helpKey: 'ai.control.profile.modelHelp' });
    if (editingPurpose === 'inline') profileField(form, 'ai.control.profile.apiMode', raw.mode !== undefined ? raw.mode : profile.mode, 'mode', { select: [
      { value: 'chat', labelKey: 'ai.inlineMode.chat' },
      { value: 'fim', labelKey: 'ai.inlineMode.fim' }
    ] });

    var advanced = element('details', 'ai-control-section full');
    advanced.open = profileEditorAdvancedOpen;
    advanced.append(element('summary', '', 'ai.control.profile.advanced'));
    var advancedGrid = element('div', 'ai-control-field-grid');
    profileField(advancedGrid, 'ai.control.capability.contextWindowTokens', capabilityFieldValue(raw, capabilities, 'contextWindowTokens'), 'capabilityContextWindowTokens', { type: 'number', min: 1, max: 100000000, step: 1, helpKey: 'ai.control.capability.contextWindowHelp' });
    profileField(advancedGrid, 'ai.control.capability.maxOutputTokens', capabilityFieldValue(raw, capabilities, 'maxOutputTokens'), 'capabilityMaxOutputTokens', { type: 'number', min: 1, max: 100000000, step: 1, helpKey: 'ai.control.capability.maxOutputHelp' });
    profileField(advancedGrid, 'ai.control.capability.tools', capabilityFieldValue(raw, capabilities, 'tools'), 'capabilityTools', { select: triStateItems() });
    profileField(advancedGrid, 'ai.control.capability.streaming', capabilityFieldValue(raw, capabilities, 'streaming'), 'capabilityStreaming', { select: triStateItems() });
    profileField(advancedGrid, 'ai.control.capability.parallelToolCalls', capabilityFieldValue(raw, capabilities, 'parallelToolCalls'), 'capabilityParallelToolCalls', { select: triStateItems() });
    profileField(advancedGrid, 'ai.control.capability.reasoningEfforts', raw.capabilityReasoningEfforts !== undefined ? raw.capabilityReasoningEfforts : (capabilities.reasoningEfforts || []).join(', '), 'capabilityReasoningEfforts', { placeholderKey: 'ai.control.capability.reasoningPlaceholder', helpKey: 'ai.control.capability.reasoningHelp' });
    profileField(advancedGrid, 'ai.control.capability.source', raw.capabilitySource !== undefined ? raw.capabilitySource : (capabilities.source || 'unknown'), 'capabilitySource', { select: [
      { value: 'unknown', labelKey: 'ai.control.capability.sourceUnknown' },
      { value: 'provider-api', labelKey: 'ai.control.capability.sourceProviderApi' },
      { value: 'official-catalog', labelKey: 'ai.control.capability.sourceOfficialCatalog' },
      { value: 'user-override', labelKey: 'ai.control.capability.sourceUserOverride' }
    ], helpKey: 'ai.control.capability.sourceHelp' });
    profileField(advancedGrid, 'ai.control.capability.effectiveEffortMap', raw.capabilityEffectiveEffortMap !== undefined ? raw.capabilityEffectiveEffortMap : JSON.stringify(capabilities.effectiveEffortMap || {}, null, 2), 'capabilityEffectiveEffortMap', { full: true, multiline: true, rows: 3, helpKey: 'ai.control.capability.effectiveEffortMapHelp' });
    profileField(advancedGrid, 'ai.control.profile.options', raw.options !== undefined ? raw.options : JSON.stringify(profile.options || {}, null, 2), 'options', { full: true, multiline: true, rows: 3, helpKey: 'ai.control.profile.optionsHelp' });
    advanced.append(advancedGrid);
    advanced.addEventListener('toggle', function() { profileEditorAdvancedOpen = advanced.open; });
    form.append(advanced);
    var error = element('div', 'ai-control-field-error');
    error.setAttribute('role', 'status');
    var actions = element('div', 'ai-control-button-row full');
    actions.append(button('ai.control.profile.saveDraft', 'ss-btn ss-btn-primary', function() {
      try {
        commitProfileForm(form);
        renderActivePane();
      } catch (validationError) {
        error.textContent = t(profileErrorKey(validationError));
      }
    }));
    form.append(error, actions);
    form.addEventListener('input', function(event) {
      if (renderGeneration !== profileEditorRenderGeneration) return;
      if (event.target && event.target.dataset.profileDynamic === 'shape' && event.target.tagName === 'SELECT') return;
      captureProfileForm(form, event.target);
      if (event.target && event.target.dataset.profileDynamic === 'endpoint') updateManagedEndpoint(form, shape);
    });
    form.addEventListener('change', function(event) {
      if (renderGeneration !== profileEditorRenderGeneration) return;
      if (event.target && event.target.dataset.profileDynamic === 'shape') updateDynamicProfileShape(form, shape);
      else {
        captureProfileForm(form, event.target);
        if (event.target && event.target.dataset.profileDynamic === 'endpoint') updateManagedEndpoint(form, shape);
      }
    });
    editor.append(form);
    parent.append(editor);
    if (shouldFocusName) setTimeout(function() { name.focus(); }, 0);
  }

  function startProfileEditor(profile, purpose) {
    editingPurpose = purpose === 'inline' ? 'inline' : 'chat';
    editingProfileId = profile ? profile.id : '';
    profileEditorDraft = clone(profile || {
      id: '', name: '', provider: 'openai-compatible', apiKey: '',
      protocol: 'chat-completions', authType: 'bearer', endpoint: '', modelId: '',
      mode: editingPurpose === 'inline' ? 'fim' : 'chat', apiVersion: '', organizationId: '',
      projectId: '', workspaceId: '', region: '', billingPlan: '',
      capabilities: schemaApi().normalizeCapabilities ? schemaApi().normalizeCapabilities({}) : {}, options: {}
    });
    profileEditorRaw = null;
    profileEditorProviderDrafts = Object.create(null);
    profileEditorAdvancedOpen = false;
    renderActivePane();
  }

  async function removeProfile(profile, purpose) {
    var accepted = BOBO.confirm ? await BOBO.confirm({
      title: t('ai.control.profile.deleteTitle'),
      message: t('ai.control.profile.deleteMessage {name}', { name: profile.name }),
      confirmLabel: t('ai.control.profile.delete'),
      cancelLabel: t('ai.control.cancel'),
      danger: true
    }) : false;
    if (!accepted) return;
    var key = purpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    draft[key] = draft[key].filter(function(item) { return item.id !== profile.id; });
    if (purpose === 'chat' && draft.chatProfileId === profile.id) draft.chatProfileId = '';
    if (purpose === 'inline' && draft.inlineProfileId === profile.id) { draft.inlineProfileId = ''; draft.inline.enabled = false; }
    markDirty();
    renderActivePane();
    updateHeaderStatus();
  }

  function renderConnections(pane) {
    pane.append(pageHeader('ai.control.connections.title', 'ai.control.connections.description'));
    renderProfileEditor(pane);
    ['chat', 'inline'].forEach(function(purpose) {
      var block = section(purpose === 'chat' ? 'ai.control.connections.chatAgents' : 'ai.control.connections.inlineAgents', purpose === 'chat' ? 'ai.control.connections.chatAgentsDescription' : 'ai.control.connections.inlineAgentsDescription');
      block.heading.append(button(purpose === 'chat' ? 'ai.control.connections.addChat' : 'ai.control.connections.addInline', 'ss-btn ss-btn-primary', function() { startProfileEditor(null, purpose); }));
      var list = element('div', 'ai-control-profile-list');
      var profiles = profilesFor(purpose);
      if (!profiles.length) list.append(element('div', 'ai-control-empty', purpose === 'chat' ? 'ai.control.connections.emptyChat' : 'ai.control.connections.emptyInline'));
      profiles.forEach(function(profile) {
        var selected = purpose === 'chat' ? draft.chatProfileId === profile.id : draft.inline.enabled && draft.inlineProfileId === profile.id;
        var card = element('article', 'ai-control-profile' + (selected ? ' active' : ''));
        card.dataset.purpose = purpose;
        card.dataset.profileId = profile.id;
        var name = element('div', 'ai-control-profile-name');
        name.append(element('strong'), element('span', 'ai-control-profile-provider'));
        name.firstChild.textContent = profile.name;
        var cardProvider = providerDefinition(profile.provider);
        name.lastChild.textContent = t(cardProvider.definition.labelKey);
        var detail = element('div', 'ai-control-profile-detail');
        detail.textContent = t(purpose === 'chat' ? 'ai.control.profile.chatDetail {model} {endpoint}' : 'ai.control.profile.inlineDetail {model} {endpoint}', { model: profile.modelId, endpoint: profile.endpoint });
        var liveStatus = element('span', 'ai-control-row-state');
        liveStatus.setAttribute('role', 'status');
        var currentState = connectionState(profile, purpose);
        card.dataset.health = currentState.state;
        liveStatus.dataset.state = currentState.state;
        liveStatus.textContent = t(currentState.key);
        var actions = element('div', 'ai-control-profile-actions');
        var enable = button(selected ? 'ai.control.profile.pause' : 'ai.control.profile.play', 'ss-btn ss-btn-icon ai-profile-toggle', function() {
          if (purpose === 'chat') draft.chatProfileId = selected ? '' : profile.id;
          else { draft.inlineProfileId = selected ? '' : profile.id; draft.inline.enabled = !selected; }
          markDirty(); updateHeaderStatus(); renderActivePane();
        });
        enable.innerHTML = selected
          ? '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zm5 0h3v10H9z" fill="currentColor"/></svg>'
          : (BOBO.icons && BOBO.icons.play || '&#9654;');
        enable.title = t(selected ? 'ai.control.profile.pause' : 'ai.control.profile.play');
        enable.setAttribute('aria-label', enable.title);
        enable.setAttribute('aria-pressed', selected ? 'true' : 'false');
        var testButton = button('ai.control.profile.test', 'ss-btn ss-btn-ghost');
        testButton.addEventListener('click', function() { testProfile(profile, purpose, liveStatus, testButton); });
        actions.append(
          enable,
          testButton,
          button('ai.control.profile.edit', 'ss-btn ss-btn-ghost', function() { startProfileEditor(profile, purpose); }),
          button('ai.control.profile.delete', 'ss-btn ss-btn-danger', function() { removeProfile(profile, purpose); })
        );
        card.append(name, detail, actions, liveStatus);
        list.append(card);
      });
      block.root.append(list);
      pane.append(block.root);
    });
  }

  function stopValues(value) {
    return Array.isArray(value) ? value.join('\n') : '';
  }

  function readStops(value) {
    return String(value || '').split(/\r?\n/).map(function(item) { return item.trim(); }).filter(Boolean).slice(0, 8);
  }

  function renderChat(pane) {
    pane.append(pageHeader('ai.control.chat.title', 'ai.control.chat.description'));
    var model = section('ai.control.chat.modelSection', 'ai.control.chat.modelSectionDescription');
    var modelGrid = element('div', 'ai-control-field-grid');
    modelGrid.append(selectField('ai.control.chat.profile', draft.chatProfileId, function(value) { draft.chatProfileId = value; }, true, 'chat').root);
    modelGrid.append(
      numberField('ai.control.parameter.temperature', draft.chat.parameters.temperature, 0, 2, 0.05, function(value) { draft.chat.parameters.temperature = value; }).root,
      numberField('ai.control.parameter.maxTokens', draft.chat.parameters.maxTokens, 16, schemaApi().MAX_MODEL_REQUEST_OUTPUT_TOKENS || 262144, 16, function(value) { draft.chat.parameters.maxTokens = value; }).root,
      numberField('ai.control.parameter.topP', draft.chat.parameters.topP, 0, 1, 0.05, function(value) { draft.chat.parameters.topP = value; }).root
    );
    var stops = field('ai.control.parameter.stop', stopValues(draft.chat.parameters.stop), { multiline: true, rows: 3, helpKey: 'ai.control.parameter.stopHelp' });
    stops.root.classList.add('full');
    stops.input.addEventListener('change', function() { draft.chat.parameters.stop = readStops(stops.input.value); markDirty(); });
    modelGrid.append(stops.root);
    model.root.append(modelGrid);
    pane.append(model.root);

    var context = section('ai.control.chat.contextSection', 'ai.control.chat.contextDescription');
    var contextGrid = element('div', 'ai-control-field-grid');
    [
      ['ai.control.context.totalBudget', 'maxInputChars', 8000, 200000, 1000],
      ['ai.control.context.currentFile', 'currentFileChars', 0, 100000, 1000],
      ['ai.control.context.selection', 'selectionChars', 0, 30000, 500],
      ['ai.control.context.project', 'projectChars', 0, 30000, 500],
      ['ai.control.context.referencedFile', 'referencedFileChars', 0, 50000, 500],
      ['ai.control.context.maxReferencedFiles', 'maxReferencedFiles', 0, 20, 1],
      ['ai.control.context.historyMessages', 'historyMessages', 0, 50, 1],
      ['ai.control.context.historyMessageChars', 'historyMessageChars', 256, 30000, 256]
    ].forEach(function(config) {
      contextGrid.append(numberField(config[0], draft.chat.context[config[1]], config[2], config[3], config[4], function(value) { draft.chat.context[config[1]] = value; }).root);
    });
    context.root.append(contextGrid);
    pane.append(context.root);
  }

  function renderInline(pane) {
    pane.append(pageHeader('ai.control.inline.title', 'ai.control.inline.description'));
    var behavior = section('ai.control.inline.behaviorSection', 'ai.control.inline.behaviorDescription');
    behavior.root.append(toggleRow('ai.control.inline.enable', 'ai.control.inline.enableDescription', draft.inline.enabled, function(value) { draft.inline.enabled = value; if (!value) draft.inlineProfileId = ''; }));
    pane.append(behavior.root);
    var model = section('ai.control.inline.modelSection', 'ai.control.inline.modelSectionDescription');
    var grid = element('div', 'ai-control-field-grid');
    grid.append(selectField('ai.control.inline.profile', draft.inlineProfileId, function(value) { draft.inlineProfileId = value; draft.inline.enabled = Boolean(value); }, true, 'inline').root);
    grid.append(
      numberField('ai.control.inline.debounce', draft.inline.debounceMs, 150, 2000, 50, function(value) { draft.inline.debounceMs = value; }).root,
      numberField('ai.control.parameter.maxTokens', draft.inline.parameters.maxTokens, 16, 2048, 16, function(value) { draft.inline.parameters.maxTokens = value; }).root,
      numberField('ai.control.parameter.temperature', draft.inline.parameters.temperature, 0, 2, 0.05, function(value) { draft.inline.parameters.temperature = value; }).root,
      numberField('ai.control.parameter.topP', draft.inline.parameters.topP, 0, 1, 0.05, function(value) { draft.inline.parameters.topP = value; }).root,
      numberField('ai.control.context.prefix', draft.inline.context.prefixChars, 500, 16000, 500, function(value) { draft.inline.context.prefixChars = value; }).root,
      numberField('ai.control.context.suffix', draft.inline.context.suffixChars, 0, 8000, 250, function(value) { draft.inline.context.suffixChars = value; }).root
    );
    var stops = field('ai.control.parameter.stop', stopValues(draft.inline.parameters.stop), { multiline: true, rows: 3, helpKey: 'ai.control.parameter.stopHelp' });
    stops.root.classList.add('full');
    stops.input.addEventListener('change', function() { draft.inline.parameters.stop = readStops(stops.input.value); markDirty(); });
    grid.append(stops.root);
    model.root.append(grid);
    pane.append(model.root);
  }

  function renderInstructions(pane) {
    pane.append(pageHeader('ai.control.instructions.title', 'ai.control.instructions.description'));
    var builtIn = section('ai.control.instructions.builtIn', 'ai.control.instructions.builtInDescription');
    var callout = element('div', 'ai-control-callout');
    callout.append(element('span', '', 'ai.control.instructions.builtInNote'));
    builtIn.root.append(callout);
    pane.append(builtIn.root);
    var custom = section('ai.control.instructions.custom', 'ai.control.instructions.customDescription');
    var grid = element('div', 'ai-control-field-grid');
    var globalField = field('ai.control.instructions.global', draft.globalInstructions, { full: true, multiline: true, rows: 5, helpKey: 'ai.control.instructions.globalHelp' });
    var chatField = field('ai.control.instructions.chat', draft.chat.instructions, { full: true, multiline: true, rows: 5, helpKey: 'ai.control.instructions.chatHelp' });
    var inlineField = field('ai.control.instructions.inline', draft.inline.instructions, { full: true, multiline: true, rows: 4, helpKey: 'ai.control.instructions.inlineHelp' });
    [
      [globalField, function(value) { draft.globalInstructions = value.slice(0, 12000); }],
      [chatField, function(value) { draft.chat.instructions = value.slice(0, 12000); }],
      [inlineField, function(value) { draft.inline.instructions = value.slice(0, 4000); }]
    ].forEach(function(entry) {
      entry[0].input.addEventListener('input', function() { entry[1](entry[0].input.value); markDirty(); });
    });
    grid.append(globalField.root, chatField.root, inlineField.root);
    custom.root.append(grid);
    pane.append(custom.root);
  }

  function renderActivePane() {
    if (!content || !draft) return;
    var pane = content.querySelector('[data-ai-pane="' + activeTab + '"]');
    if (!pane) return;
    // Removing a focused input can synchronously emit change. Invalidate the
    // old editor before detaching it so that event cannot alter the next draft.
    profileEditorRenderGeneration++;
    pane.innerHTML = '';
    if (activeTab === 'overview') renderOverview(pane);
    else if (activeTab === 'connections') renderConnections(pane);
    else if (activeTab === 'chat') renderChat(pane);
    else if (activeTab === 'inline') renderInline(pane);
    else if (activeTab === 'instructions') renderInstructions(pane);
  }

  function switchTab(tab) {
    if (!modal || !modal.querySelector('[data-ai-tab="' + tab + '"]')) return;
    if (tab === activeTab) {
      renderActivePane();
      return;
    }
    activeTab = tab;
    Array.prototype.forEach.call(modal.querySelectorAll('[data-ai-tab]'), function(item) {
      var selected = item.dataset.aiTab === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      item.tabIndex = selected ? 0 : -1;
    });
    Array.prototype.forEach.call(modal.querySelectorAll('[data-ai-pane]'), function(pane) {
      var selected = pane.dataset.aiPane === tab;
      pane.hidden = !selected;
      pane.classList.toggle('active', selected);
    });
    content.scrollTop = 0;
    renderActivePane();
  }

  function updateHeaderStatus() {
    if (!statusEl || !draft) return;
    var current = overallState();
    statusEl.dataset.state = current.state;
    statusEl.textContent = t(current.key);
  }

  function applySettingsToState(settings) {
    settings = normalize(settings);
    Object.keys(settings).forEach(function(key) { S.ai[key] = clone(settings[key]); });
    S.ai.models = S.ai.chatProfiles.map(function(profile) {
      return {
        id: profile.id, name: profile.name, provider: profile.provider, apiKey: profile.apiKey,
        endpoint: profile.endpoint, modelId: profile.modelId, options: profile.options
      };
    });
    S.ai.profiles = S.ai.models;
    S.ai.chatModel = S.ai.chatProfileId;
    S.ai.currentModel = S.ai.chatProfileId;
    S.ai.inlineModel = S.ai.inlineProfileId;
    S.ai.inlineEnabled = S.ai.inline.enabled;
    S.ai.inlineDebounceMs = S.ai.inline.debounceMs;
    S.ai.chatSystemPrompt = S.ai.chat.instructions;
    S.ai.inlineInstruction = S.ai.inline.instructions;
    S.ai.inlinePrefixChars = S.ai.inline.context.prefixChars;
    S.ai.inlineSuffixChars = S.ai.inline.context.suffixChars;
    S.ai.inlineMaxTokens = S.ai.inline.parameters.maxTokens;
  }

  async function performSave() {
    if (profileEditorDraft) {
      var profileForm = modal.querySelector('.ai-profile-editor form');
      if (profileForm) {
        try {
          commitProfileForm(profileForm);
          renderActivePane();
        } catch (validationError) {
          setSaveStatus(profileErrorKey(validationError), 'error');
          return { success: false, code: profileErrorKey(validationError) };
        }
      }
    }
    var normalized = normalize(draft);
    var savedRevision = draftRevision;
    var generation = ++saveGeneration;
    var result;
    var succeeded = false;
    saving = true;
    setSaveStatus('ai.control.saving', '');
    var saveButton = document.getElementById('ai-control-save');
    var closeButton = document.getElementById('ai-control-close');
    var cancelButton = document.getElementById('ai-control-cancel');
    if (saveButton) saveButton.disabled = true;
    if (closeButton) closeButton.disabled = true;
    if (cancelButton) cancelButton.disabled = true;
    if (modal) modal.setAttribute('aria-busy', 'true');
    try {
      if (BOBO.aiService && BOBO.aiService.updateSettings) result = await BOBO.aiService.updateSettings(normalized);
      else {
        applySettingsToState(normalized);
        result = BOBO.aiService && BOBO.aiService.saveSettings ? await BOBO.aiService.saveSettings() : { success: true };
      }
      if (generation !== saveGeneration) return;
      if (result && result.success === false) throw Object.assign(new Error(result.detail || result.code), { code: result.code });
      applySettingsToState(normalized);
      if (BOBO.aiService && BOBO.aiService.clearInlineCache) BOBO.aiService.clearInlineCache();
      if (BOBO.aiAgentButton && BOBO.aiAgentButton.updateLEDs) BOBO.aiAgentButton.updateLEDs(S.ai.status);
      if (BOBO.agentWorkbench && BOBO.agentWorkbench.refreshModels) BOBO.agentWorkbench.refreshModels();
      if (draftRevision === savedRevision) {
        draft = clone(normalized);
        dirty = false;
        setSaveStatus('ai.control.saved', 'ready');
      } else {
        dirty = true;
        setSaveStatus('ai.control.unsaved', '');
      }
      updateHeaderStatus();
      succeeded = true;
    } catch (error) {
      if (generation !== saveGeneration) return;
      setSaveStatus(error && error.code || 'ai.error.settingsWrite', 'error');
      return { success: false, code: error && error.code || 'ai.error.settingsWrite' };
    } finally {
      if (generation === saveGeneration) {
        saving = false;
        if (saveButton) saveButton.disabled = false;
        if (closeButton) closeButton.disabled = false;
        if (cancelButton) cancelButton.disabled = false;
        if (modal) modal.removeAttribute('aria-busy');
        if (succeeded && dirty && !profileEditorDraft) scheduleAutoSave(250);
      }
    }
  }

  function save() {
    if (saving && activeSavePromise) return activeSavePromise;
    activeSavePromise = performSave().finally(function() { activeSavePromise = null; });
    return activeSavePromise;
  }

  function close() {
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    draft = null;
    dirty = false;
    saving = false;
    draftRevision = 0;
    saveGeneration++;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    activeSavePromise = null;
    editingProfileId = '';
    profileEditorDraft = null;
    profileEditorRaw = null;
    profileEditorProviderDrafts = Object.create(null);
    profileEditorAdvancedOpen = false;
    setSaveStatus('', '');
    var saveButton = document.getElementById('ai-control-save');
    if (saveButton) saveButton.disabled = false;
    var closeButton = document.getElementById('ai-control-close');
    var cancelButton = document.getElementById('ai-control-cancel');
    if (closeButton) closeButton.disabled = false;
    if (cancelButton) cancelButton.disabled = false;
    modal.removeAttribute('aria-busy');
    if (previousFocus && previousFocus.focus) previousFocus.focus();
    previousFocus = null;
  }

  async function requestClose() {
    if (profileEditorDraft) {
      var discard = BOBO.confirm ? await BOBO.confirm({
        title: t('ai.control.discardTitle'),
        message: t('ai.control.discardMessage'),
        confirmLabel: t('ai.control.discard'),
        cancelLabel: t('ai.control.keepEditing'),
        danger: true
      }) : false;
      if (!discard) return;
      editingProfileId = '';
      profileEditorDraft = null;
      profileEditorRaw = null;
      profileEditorProviderDrafts = Object.create(null);
      profileEditorAdvancedOpen = false;
    }
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    if (dirty) await save();
    if (saving && activeSavePromise) await activeSavePromise;
    if (!dirty) close();
  }

  function open(tab) {
    ensureDOM();
    if (!modal) return;
    if (modal.classList.contains('open') && draft) {
      switchTab(tab || activeTab);
      var currentTab = modal.querySelector('[data-ai-tab].active');
      if (currentTab) setTimeout(function() { currentTab.focus(); }, 0);
      return;
    }
    previousFocus = document.activeElement;
    draft = normalize(settingsSnapshot());
    dirty = false;
    saving = false;
    draftRevision = 0;
    saveGeneration++;
    editingProfileId = '';
    profileEditorDraft = null;
    profileEditorRaw = null;
    profileEditorProviderDrafts = Object.create(null);
    profileEditorAdvancedOpen = false;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setSaveStatus('ai.control.autosaveReady', '');
    switchTab(tab || 'overview');
    updateHeaderStatus();
    var selected = modal.querySelector('[data-ai-tab].active');
    if (selected) setTimeout(function() { selected.focus(); }, 0);
  }

  function ensureDOM() {
    if (modal) return;
    modal = document.getElementById('ai-settings-modal');
    if (!modal) return;
    content = document.getElementById('ai-control-content');
    statusEl = document.getElementById('ai-control-status');
    saveStatusEl = document.getElementById('ai-control-save-status');
    modal.querySelectorAll('[data-ai-tab]').forEach(function(tab) {
      tab.addEventListener('click', function() { switchTab(tab.dataset.aiTab); });
      tab.addEventListener('keydown', function(event) {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        var tabs = Array.prototype.slice.call(modal.querySelectorAll('[data-ai-tab]'));
        var direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
        var next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length];
        switchTab(next.dataset.aiTab);
        next.focus();
      });
    });
    document.getElementById('ai-control-close').addEventListener('click', requestClose);
    document.getElementById('ai-control-cancel').addEventListener('click', requestClose);
    document.getElementById('ai-control-save').addEventListener('click', save);
    modal.addEventListener('click', function(event) { if (event.target === modal) requestClose(); });
    modal.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') { event.preventDefault(); requestClose(); }
      if (event.key === 'Tab') {
        var focusable = Array.prototype.filter.call(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'), function(node) {
          return node.offsetParent !== null;
        });
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    var iconNames = {
      overview: 'cloud', connections: 'key', chat: 'mail', inline: 'fileText',
      instructions: 'fileText'
    };
    Array.prototype.forEach.call(modal.querySelectorAll('[data-ai-tab]'), function(tab) {
      var slot = tab.querySelector('.ai-control-tab-icon');
      var name = iconNames[tab.dataset.aiTab];
      if (slot && BOBO.icons && BOBO.icons[name]) slot.innerHTML = BOBO.icons[name];
    });
    if (BOBO.i18n && BOBO.i18n.onChange) {
      unsubscribeLocale = BOBO.i18n.onChange(function() {
        if (!modal.classList.contains('open') || !draft) return;
        renderActivePane();
        updateHeaderStatus();
        if (dirty) setSaveStatus('ai.control.unsaved', '');
      });
    }
  }

  BOBO.aiSettingsCenter = {
    init: ensureDOM,
    open: open,
    close: requestClose,
    save: save,
    switchTab: switchTab,
    isDirty: function() { return dirty; },
    getDraft: function() { return draft ? clone(draft) : null; }
  };
})(window);
