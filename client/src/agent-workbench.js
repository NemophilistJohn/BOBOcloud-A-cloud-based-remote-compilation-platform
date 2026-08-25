import { marked } from 'marked';

// Host-rendered Agent workbench. Installed extensions publish bounded state and
// command ids; this module owns every DOM node and all interaction behavior.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var S = BOBO.state;
  var VIEW_ID = 'agent';
  var PAGE_ID = 'agent-workbench-view';
  var TAB_PREFIX = 'agent-workbench:';
  var PROVIDER_ID = 'agent-workbench';
  var initialized = false;
  var activity = null;
  var sidebar = null;
  var primaryRegistration = null;
  var tabRegistration = null;
  var agentSubscription = null;
  var languageSubscription = null;
  var selectedProviderId = '';
  var sessionQuery = '';
  var skillsOpenFor = '';
  var pendingUnderlyingView = null;
  var openProviders = new Set();
  var tabMetadata = new Map();
  var drafts = new Map();
  var preferences = new Map();
  var errors = new Map();
  var inflight = new Set();
  var approvalDetails = new Map();
  var approvalDecisions = new Map();
  var accessRequests = new Map();
  var documentClickHandler = null;

  function t(key, values) {
    var i18n = BOBO.i18n;
    return i18n && typeof i18n.t === 'function' ? i18n.t(key, values) : interpolate(key, values);
  }

  function interpolate(value, values) {
    return String(value || '').replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, key) {
      return values && values[key] != null ? String(values[key]) : match;
    });
  }

  function element(tagName, className, value) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function svg(path, viewBox) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', viewBox || '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('aria-hidden', 'true');
    var parts = Array.isArray(path) ? path : [path];
    parts.forEach(function(value) {
      var part = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      part.setAttribute('d', value);
      part.setAttribute('stroke', 'currentColor');
      part.setAttribute('stroke-width', '1.65');
      part.setAttribute('stroke-linecap', 'round');
      part.setAttribute('stroke-linejoin', 'round');
      node.appendChild(part);
    });
    return node;
  }

  function icon(kind) {
    if (kind === 'sparkles') return svg(['M12 2.75c.55 4.2 2.6 6.25 6.8 6.8-4.2.55-6.25 2.6-6.8 6.8-.55-4.2-2.6-6.25-6.8-6.8 4.2-.55 6.25-2.6 6.8-6.8Z', 'M18.5 15.5c.2 1.55.95 2.3 2.5 2.5-1.55.2-2.3.95-2.5 2.5-.2-1.55-.95-2.3-2.5-2.5 1.55-.2 2.3-.95 2.5-2.5Z']);
    if (kind === 'plus') return svg('M12 5v14M5 12h14');
    if (kind === 'search') return svg(['M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z', 'm15.5 15.5 4.5 4.5']);
    if (kind === 'chevron') return svg('m8 10 4 4 4-4');
    if (kind === 'trash') return svg(['M4.5 7h15', 'M9 7V4.5h6V7M7 7l.7 12h8.6L17 7M10 10.5v5M14 10.5v5']);
    if (kind === 'send') return svg(['m4 4 16 8-16 8 3-8-3-8Z', 'M7 12h13']);
    if (kind === 'stop') {
      var stop = svg('M7 7h10v10H7z');
      stop.firstChild.setAttribute('fill', 'currentColor');
      stop.firstChild.setAttribute('stroke', 'none');
      return stop;
    }
    if (kind === 'settings') return svg(['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', 'M19 13.5v-3l-2-.7-.6-1.4.9-1.9-2.1-2.1-1.9.9-1.4-.6L11.2 3h-3l-.7 2-1.4.6-1.9-.9-2.1 2.1.9 1.9-.6 1.4-2 .7v3l2 .7.6 1.4-.9 1.9 2.1 2.1 1.9-.9 1.4.6.7 2h3l.7-2 1.4-.6 1.9.9 2.1-2.1-.9-1.9.6-1.4 2-.7Z']);
    if (kind === 'skill') return svg(['M5 4.5h5.5A2.5 2.5 0 0 1 13 7v12H7.5A2.5 2.5 0 0 1 5 16.5v-12Z', 'M19 4.5h-3A3 3 0 0 0 13 7.5V19h3.5a2.5 2.5 0 0 0 2.5-2.5v-12Z']);
    if (kind === 'tool') return svg(['m14.5 5.5 4 4', 'M13 7l4-4 4 4-4 4M4 20l9.5-9.5 3 3L7 23H4v-3Z']);
    if (kind === 'check') return svg('m5 12 4 4 10-10');
    if (kind === 'close') return svg('m6 6 12 12M18 6 6 18');
    if (kind === 'clock') return svg(['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z', 'M12 8v4l3 2']);
    if (kind === 'copy') return svg(['M9 8.5V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2.5', 'M6 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z']);
    if (kind === 'compress') return svg(['M4 8h5V3', 'm4 8 5-5', 'M20 16h-5v5', 'm-4-4 5 5']);
    return svg('M12 5v14');
  }

  function iconButton(kind, label, className) {
    var button = element('button', className || 'agent-icon-button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(icon(kind));
    return button;
  }

  function agentApi() {
    return BOBO.platform && BOBO.platform.agents;
  }

  function records() {
    var api = agentApi();
    return api && typeof api.list === 'function' ? api.list() : [];
  }

  function recordById(id) {
    var api = agentApi();
    return api && typeof api.get === 'function' ? api.get(id) : null;
  }

  function safeProviderId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(id) ? id : '';
  }

  function tabKey(id) {
    return TAB_PREFIX + id;
  }

  function providerFromKey(key) {
    return typeof key === 'string' && key.indexOf(TAB_PREFIX) === 0 ? safeProviderId(key.slice(TAB_PREFIX.length)) : '';
  }

  function activeProviderId() {
    return providerFromKey(S.activeTabPath) || selectedProviderId;
  }

  function activeRecord() {
    return recordById(activeProviderId());
  }

  function phaseLabel(phase) {
    if (phase === 'loading') return t('Loading agent...');
    if (phase === 'unconfigured') return t('Agent setup required');
    if (phase === 'error') return t('Agent unavailable');
    if (phase === 'ready') return t('Ready');
    return t('Waiting for agent');
  }

  function statusLabel(status) {
    if (status === 'running') return t('Running');
    if (status === 'waiting-approval') return t('Waiting for approval');
    if (status === 'completed') return t('Completed');
    if (status === 'failed') return t('Failed');
    if (status === 'cancelled') return t('Cancelled');
    return t('Idle');
  }

  function timelineStatusLabel(status) {
    if (status === 'pending') return t('Pending');
    if (status === 'running') return t('Running');
    if (status === 'waiting') return t('Waiting');
    if (status === 'completed') return t('Completed');
    if (status === 'failed') return t('Failed');
    if (status === 'rejected') return t('Rejected');
    return t('Completed');
  }

  function modeLabel(mode) {
    return mode === 'goal' ? t('Goal') : t('Chat');
  }

  function effortLabel(effort) {
    if (effort === 'low') return t('Low');
    if (effort === 'high') return t('High');
    if (effort === 'xhigh') return t('Extra high');
    if (effort === 'max') return t('Maximum');
    return t('Medium');
  }

  function riskLabel(risk) {
    if (risk === 'execute') return t('Run command');
    if (risk === 'network') return t('Network access');
    if (risk === 'read') return t('Read workspace');
    return t('Write workspace');
  }

  function formatTime(value) {
    if (!value) return '';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      var today = new Date();
      if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit' });
      return date.toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric' });
    } catch (error) { return ''; }
  }

  function exceptionMessage(error) {
    var value = error && typeof error.message === 'string' ? error.message : String(error || '');
    return value.slice(0, 512) || t('Unknown error');
  }

  function normalizedAccessMode(value) {
    return value === 'auto' || value === 'full' ? value : 'ask';
  }

  function accessModeLabel(value) {
    if (value === 'auto') return t('Help me approve');
    if (value === 'full') return t('Unrestricted access');
    return t('Request approval');
  }

  function accessModeDescription(value) {
    if (value === 'auto') return t('The host automatically handles routine low- and medium-risk actions. Sensitive operations still ask.');
    if (value === 'full') return t('Allow file changes and local commands without asking again in this session.');
    return t('Ask before writing files or running local commands.');
  }

  function accessIdentity(record) {
    var session = record && record.state && record.state.activeSession;
    if (!record || !record.owner || !session || !session.id) return null;
    return { pluginId: record.owner, providerId: record.id, sessionId: session.id };
  }

  function accessKey(identity) {
    return identity ? identity.pluginId + '\u0000' + identity.providerId + '\u0000' + identity.sessionId : '';
  }

  function validateAccessResponse(value, identity) {
    if (!value || typeof value !== 'object' || value.pluginId !== identity.pluginId ||
      value.providerId !== identity.providerId || value.sessionId !== identity.sessionId) {
      throw new TypeError('Invalid Agent access response.');
    }
    if (value.accessMode !== 'ask' && value.accessMode !== 'auto' && value.accessMode !== 'full') {
      throw new TypeError('Invalid Agent access response.');
    }
    return value.accessMode;
  }

  function ensureAccessMode(record) {
    var identity = accessIdentity(record);
    var api = global.api;
    if (!identity || !api || typeof api.agentAccessGet !== 'function') return;
    var key = accessKey(identity);
    if (accessRequests.has(key)) return;
    var entry = { status: 'loading' };
    accessRequests.set(key, entry);
    Promise.resolve(api.agentAccessGet(identity)).then(function(value) {
      if (!initialized) return;
      var accessMode = validateAccessResponse(value, identity);
      var current = recordById(record.id);
      if (accessKey(accessIdentity(current)) !== key) return;
      entry.status = 'ready';
      entry.accessMode = accessMode;
      var preference = preferenceState(current);
      preference.accessMode = accessMode;
      preferences.set(current.id, preference);
      renderAll();
    }).catch(function(error) {
      entry.status = 'error';
      errors.set(record.id, t('Agent action failed: {message}', { message: exceptionMessage(error) }));
      renderAll();
    });
  }

  async function setAccessMode(record, nextMode) {
    var identity = accessIdentity(record);
    var api = global.api;
    var accessMode = normalizedAccessMode(nextMode);
    if (!identity || !api || typeof api.agentAccessSet !== 'function') return false;
    var confirmed = false;
    if (accessMode === 'full') {
      confirmed = typeof BOBO.confirm === 'function' && await BOBO.confirm({
            title: t('Enable unrestricted access?'),
            message: t('The agent will be allowed to write files and run local commands without asking again in this session. Only enable this for code and instructions you trust.'),
            confirmLabel: t('Enable unrestricted access'),
            cancelLabel: t('Cancel'),
            danger: true
          });
      if (!confirmed) { renderWorkspace(record); return false; }
    }
    var key = accessKey(identity);
    var entry = { status: 'saving', accessMode: accessMode };
    accessRequests.set(key, entry);
    errors.delete(record.id);
    renderAll();
    try {
      var value = await api.agentAccessSet(Object.assign({}, identity, { accessMode: accessMode, confirmed: confirmed }));
      var accepted = validateAccessResponse(value, identity);
      if (accepted !== accessMode) throw new TypeError('Agent access mode was not accepted.');
      var current = recordById(record.id);
      if (accessKey(accessIdentity(current)) !== key) return false;
      entry.status = 'ready';
      entry.accessMode = accepted;
      updatePreferences(current, { accessMode: accepted });
      return true;
    } catch (error) {
      entry.status = 'error';
      errors.set(record.id, t('Agent action failed: {message}', { message: exceptionMessage(error) }));
      renderAll();
      return false;
    }
  }

  async function clearAccessMode(record, identity) {
    if (!identity) return;
    accessRequests.delete(accessKey(identity));
    var api = global.api;
    if (!api || typeof api.agentAccessClear !== 'function') return;
    try {
      var value = await api.agentAccessClear(identity);
      if (validateAccessResponse(value, identity) !== 'ask') throw new TypeError('Agent access mode was not cleared.');
    } catch (error) {
      errors.set(record.id, t('Agent action failed: {message}', { message: exceptionMessage(error) }));
      renderAll();
    }
  }

  function accessEntry(record) {
    var identity = accessIdentity(record);
    return identity ? accessRequests.get(accessKey(identity)) || null : null;
  }

  function accessReady(record) {
    if (!record || !record.descriptor.capabilities.localTools || !record.state || !record.state.activeSession) return true;
    var api = global.api;
    var entry = accessEntry(record);
    return Boolean(api && typeof api.agentAccessGet === 'function' && entry && entry.status === 'ready');
  }

  function approvalKey(record, approvalId) {
    return String(record && record.owner || '') + '\u0000' + String(approvalId || '');
  }

  function canonicalText(value, maximum) {
    return typeof value === 'string' ? value.slice(0, maximum) : '';
  }

  function normalizeApprovalDetail(value, expectedId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid approval detail.');
    var id = canonicalText(value.approvalId, 180);
    var tool = canonicalText(value.tool, 96);
    if (id !== expectedId || (tool !== 'workspace_write' && tool !== 'process_run')) throw new TypeError('Invalid approval detail.');
    var raw = value.details;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid approval detail.');
    var details;
    if (tool === 'workspace_write') {
      var expectedSha256 = canonicalText(raw.expectedSha256, 64);
      if (expectedSha256 && !/^[a-f0-9]{64}$/i.test(expectedSha256)) expectedSha256 = '';
      details = {
        path: canonicalText(raw.path, 1000),
        bytes: Number.isSafeInteger(raw.bytes) && raw.bytes >= 0 ? raw.bytes : 0,
        expectedSha256: expectedSha256,
        contentPreview: canonicalText(raw.contentPreview, 64 * 1024),
        contentTruncated: raw.contentTruncated === true
      };
    } else {
      details = {
        command: canonicalText(raw.command, 1000),
        resolvedExecutable: canonicalText(raw.resolvedExecutable, 1000),
        args: Array.isArray(raw.args) ? raw.args.slice(0, 128).map(function(arg) { return canonicalText(arg, 4096); }) : [],
        cwd: canonicalText(raw.cwd, 1000),
        timeoutMs: Number.isSafeInteger(raw.timeoutMs) && raw.timeoutMs >= 0 ? raw.timeoutMs : 0
      };
    }
    return {
      approvalId: id,
      tool: tool,
      summary: canonicalText(value.summary, 1000),
      risk: tool === 'process_run' ? 'execute' : 'write',
      expiresAt: canonicalText(value.expiresAt, 64),
      details: details
    };
  }

  function activeApprovalMatches(recordId, key) {
    var current = recordById(recordId);
    var approval = current && current.state && current.state.activeSession && current.state.activeSession.approval;
    return Boolean(approval && approvalKey(current, approval.id) === key);
  }

  function ensureApprovalDetail(record, approval) {
    var key = approvalKey(record, approval && approval.id);
    if (!record || !record.owner || !approval || !approval.id || approvalDetails.has(key)) return approvalDetails.get(key) || null;
    var api = global.api;
    var describe = api && api.pluginsAgentApprovalDescribe;
    if (typeof describe !== 'function') {
      approvalDetails.set(key, { status: 'unavailable' });
      return approvalDetails.get(key);
    }
    var entry = { status: 'loading' };
    approvalDetails.set(key, entry);
    Promise.resolve(describe({ pluginId: record.owner, approvalId: approval.id })).then(function(value) {
      if (!initialized || !activeApprovalMatches(record.id, key)) return;
      entry.status = 'ready';
      entry.detail = normalizeApprovalDetail(value, approval.id);
      renderAll();
    }).catch(function() {
      if (!initialized || !activeApprovalMatches(record.id, key)) return;
      entry.status = 'unavailable';
      renderAll();
      global.setTimeout(function() {
        if (!initialized || !activeApprovalMatches(record.id, key) || approvalDetails.get(key) !== entry) return;
        approvalDetails.delete(key);
        var current = recordById(record.id);
        var currentApproval = current && current.state && current.state.activeSession && current.state.activeSession.approval;
        if (current && currentApproval) ensureApprovalDetail(current, currentApproval);
      }, 1500);
    });
    return entry;
  }

  function truncateUtf8(value, byteBudget) {
    var encoder = new TextEncoder();
    var bytes = encoder.encode(value);
    if (bytes.byteLength <= byteBudget) return { value: value, bytes: bytes.byteLength, truncated: false };
    var low = 0;
    var high = value.length;
    while (low < high) {
      var middle = Math.ceil((low + high) / 2);
      if (encoder.encode(value.slice(0, middle)).byteLength <= byteBudget) low = middle;
      else high = middle - 1;
    }
    var result = value.slice(0, low);
    return { value: result, bytes: encoder.encode(result).byteLength, truncated: true };
  }

  function normalizeApprovalResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid approval result.');
    var result = {};
    ['approved', 'rejected', 'truncated', 'timedOut', 'cancelled'].forEach(function(key) {
      if (typeof value[key] === 'boolean') result[key] = value[key];
    });
    if (value.tool === 'workspace_write' || value.tool === 'process_run') result.tool = value.tool;
    if (typeof value.path === 'string') result.path = value.path.slice(0, 1000);
    if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256)) result.sha256 = value.sha256;
    if (value.exitCode === null || Number.isSafeInteger(value.exitCode)) result.exitCode = value.exitCode;
    if (typeof value.signal === 'string') result.signal = value.signal.slice(0, 64);
    var remaining = 128 * 1024;
    ['stdout', 'stderr'].forEach(function(key) {
      if (typeof value[key] !== 'string') return;
      var bounded = truncateUtf8(value[key].slice(0, 2 * 1024 * 1024), remaining);
      result[key] = bounded.value;
      remaining -= bounded.bytes;
      if (bounded.truncated || value[key].length > 2 * 1024 * 1024) result.truncated = true;
    });
    return result;
  }

  async function decideApproval(record, approvalId, approved) {
    var key = approvalKey(record, approvalId);
    var cached = approvalDetails.get(key);
    if (approved && (!cached || cached.status !== 'ready')) return false;
    var api = global.api;
    if (!record || !record.owner || !api || typeof api.pluginsAgentApprovalDecide !== 'function') return false;
    if (approvalDecisions.has(key)) return false;
    var session = record.state && record.state.activeSession;
    var decision = {
      status: approved && cached.detail.tool === 'process_run' ? 'running' : 'deciding',
      approved: approved
    };
    approvalDecisions.set(key, decision);
    errors.delete(record.id);
    renderAll();
    try {
      var rawResult = await api.pluginsAgentApprovalDecide({ pluginId: record.owner, approvalId: approvalId, approved: approved });
      var canonicalResult = Object.assign({}, rawResult);
      if (!canonicalResult.tool && cached && cached.detail) canonicalResult.tool = cached.detail.tool;
      var approvalResult = normalizeApprovalResult(canonicalResult);
      decision.status = 'delivering';
      renderAll();
      return invoke(record, approved ? 'approve' : 'reject', {
        sessionId: session && session.id || '',
        approvalId: approvalId,
        approvalResult: approvalResult
      });
    } catch (error) {
      var cancelled = decision.status === 'cancelling';
      if (cancelled) {
        decision.status = 'delivering';
        await invoke(record, 'reject', {
          sessionId: session && session.id || '',
          approvalId: approvalId,
          approvalResult: normalizeApprovalResult({
            approved: false,
            rejected: true,
            cancelled: true,
            tool: cached && cached.detail && cached.detail.tool
          })
        });
      }
      if (!cancelled) errors.set(record.id, t('Agent action failed: {message}', { message: exceptionMessage(error) }));
      return false;
    } finally {
      if (approvalDecisions.get(key) === decision) approvalDecisions.delete(key);
      renderAll();
    }
  }

  async function cancelApproval(record, approvalId) {
    var key = approvalKey(record, approvalId);
    var decision = approvalDecisions.get(key);
    var api = global.api;
    if (!decision || decision.status !== 'running' || !record.owner || !api || typeof api.pluginsAgentApprovalCancel !== 'function') return false;
    decision.status = 'cancelling';
    renderAll();
    try {
      await api.pluginsAgentApprovalCancel({ pluginId: record.owner, approvalId: approvalId });
      return true;
    } catch (error) {
      decision.status = 'running';
      errors.set(record.id, t('Agent action failed: {message}', { message: exceptionMessage(error) }));
      renderAll();
      return false;
    }
  }

  function preferenceState(record) {
    var session = record && record.state && record.state.activeSession;
    var cached = preferences.get(record.id);
    var sessionId = session ? session.id : '';
    if (!cached || cached.sessionId !== sessionId) {
      var models = record.state && record.state.models || [];
      var enabledSkills = (record.state && record.state.skills || []).filter(function(skill) { return skill.enabled; }).map(function(skill) { return skill.id; });
      cached = {
        sessionId: sessionId,
        mode: session && session.mode || record.descriptor.capabilities.modes[0] || 'chat',
        reasoningEffort: session && session.reasoningEffort || record.descriptor.capabilities.reasoningEfforts[0] || 'medium',
        accessMode: 'ask',
        modelRef: session && session.modelRef || (models.find(function(model) { return model.configured; }) || models[0] || {}).ref || '',
        skillIds: enabledSkills
      };
      preferences.set(record.id, cached);
    }
    return cached;
  }

  function commandValues(record, overrides) {
    var current = preferenceState(record);
    return Object.assign({
      sessionId: current.sessionId,
      mode: current.mode,
      reasoningEffort: current.reasoningEffort,
      accessMode: normalizedAccessMode(current.accessMode),
      modelRef: current.modelRef,
      skillIds: current.skillIds.slice()
    }, overrides || {});
  }

  function busyKey(id, action) {
    return id + ':' + action;
  }

  function isBusy(id, action) {
    return inflight.has(busyKey(id, action));
  }

  async function invoke(record, action, values) {
    if (!record || !record.descriptor || !record.descriptor.commands) return false;
    var command = record.descriptor.commands[action];
    var commandApi = BOBO.platform && BOBO.platform.commands;
    var api = agentApi();
    if (!command || !commandApi || !api || typeof api.createCommandPayload !== 'function') return false;
    var key = busyKey(record.id, action);
    if (inflight.has(key)) return false;
    inflight.add(key);
    errors.delete(record.id);
    renderAll();
    try {
      var payload = api.createCommandPayload(record.id, action, values || {});
      var result = await commandApi.executeIsolated(command, payload);
      if (!result || result.ok !== true) throw (result && result.error) || new Error(t('Unknown error'));
      return true;
    } catch (error) {
      errors.set(record.id, t('Agent action failed: {message}', { message: exceptionMessage(error) }));
      return false;
    } finally {
      inflight.delete(key);
      renderAll();
    }
  }

  function refreshModels(providerId) {
    var available = providerId ? [recordById(providerId)].filter(Boolean) : records();
    return Promise.all(available.map(function(record) { return invoke(record, 'configure', {}); }));
  }

  function openConfiguration(recordOrId) {
    var record = typeof recordOrId === 'string' ? recordById(recordOrId) : recordOrId;
    var opened;
    try {
      opened = BOBO.aiSettingsCenter && typeof BOBO.aiSettingsCenter.open === 'function'
        ? BOBO.aiSettingsCenter.open('connections')
        : undefined;
    } catch (error) {
      opened = Promise.reject(error);
    }
    var refreshed = record ? refreshModels(record.id) : Promise.resolve([]);
    return Promise.all([Promise.resolve(opened).catch(function() { return undefined; }), refreshed]);
  }

  function captureUnderlyingView(filePath) {
    var split = document.getElementById('split-container');
    var diff = document.getElementById('diff-container');
    var image = document.getElementById('image-preview');
    return {
      filePath: filePath || '',
      mode: S.currentViewMode === 'split' || S.currentViewMode === 'diff' ? S.currentViewMode : 'single',
      splitActive: Boolean(split && split.classList.contains('active')),
      diffActive: Boolean(diff && diff.classList.contains('active')),
      imageActive: Boolean(image && !image.classList.contains('hidden')),
      diffOriginalPath: S.diffOriginalPath || '',
      diffModifiedPath: S.diffModifiedPath || ''
    };
  }

  function concealUnderlyingViews() {
    var split = document.getElementById('split-container');
    var diff = document.getElementById('diff-container');
    var image = document.getElementById('image-preview');
    if (split) split.classList.remove('active');
    if (diff) diff.classList.remove('active');
    if (image) image.classList.add('hidden');
    if (BOBO.documentViews) BOBO.documentViews.hideAll({ restoreEditor: false });
  }

  function restoreUnderlyingView(fileTab) {
    var snapshot = pendingUnderlyingView;
    if (!snapshot || !fileTab || snapshot.filePath !== fileTab.path) return;
    pendingUnderlyingView = null;
    if (snapshot.mode === 'split' && snapshot.splitActive && fileTab.model && BOBO.views && BOBO.views.openSplit) {
      BOBO.views.openSplit();
      return;
    }
    if (snapshot.mode === 'diff' && snapshot.diffActive && BOBO.views && BOBO.views.openDiff) {
      BOBO.views.openDiff(snapshot.diffOriginalPath, snapshot.diffModifiedPath);
    }
  }

  function page() {
    var root = document.getElementById(PAGE_ID);
    if (root) return root;
    var editor = document.getElementById('editor');
    if (!editor) return null;
    root = element('section', 'agent-workbench-view');
    root.id = PAGE_ID;
    root.hidden = true;
    root.setAttribute('role', 'tabpanel');
    root.setAttribute('data-i18n-skip', '');
    editor.appendChild(root);
    return root;
  }

  function activate(key) {
    var id = providerFromKey(key);
    var record = recordById(id);
    var root = page();
    if (!record || !root) return false;
    var metadata = tabMetadata.get(id) || { previousFilePath: '', previousView: null };
    var fileTab = S.tabs.find(function(candidate) { return candidate.path === S.activeTabPath; });
    var previousAgent = tabMetadata.get(providerFromKey(S.activeTabPath));
    if (fileTab) {
      metadata.previousFilePath = fileTab.path;
      metadata.previousView = captureUnderlyingView(fileTab.path);
      pendingUnderlyingView = null;
    } else if (previousAgent && previousAgent.previousView) {
      metadata.previousFilePath = previousAgent.previousFilePath;
      metadata.previousView = previousAgent.previousView;
    } else if (!metadata.previousFilePath && S.tabs.length) {
      metadata.previousFilePath = S.tabs[S.tabs.length - 1].path;
      metadata.previousView = captureUnderlyingView(metadata.previousFilePath);
    }
    tabMetadata.set(id, metadata);
    selectedProviderId = id;
    openProviders.add(id);
    concealUnderlyingViews();
    var container = document.getElementById('container');
    if (container) container.style.display = 'none';
    root.hidden = false;
    root.classList.add('active');
    S.currentViewMode = 'agent-workbench';
    S.activeTabPath = key;
    renderAll();
    if (BOBO.workspace) {
      BOBO.workspace.updateTabbar();
      BOBO.workspace.updateTitlebar();
      BOBO.workspace.updateEmptyState();
    }
    return true;
  }

  function deactivate(tabOverride) {
    if (S.currentViewMode !== 'agent-workbench') return;
    var id = tabOverride || providerFromKey(S.activeTabPath);
    var metadata = tabMetadata.get(id);
    if (metadata && metadata.previousView) pendingUnderlyingView = metadata.previousView;
    var root = document.getElementById(PAGE_ID);
    if (root) {
      root.hidden = true;
      root.classList.remove('active');
    }
    var container = document.getElementById('container');
    if (container) container.style.display = '';
    skillsOpenFor = '';
    S.currentViewMode = 'single';
  }

  function restoreAfterClose(id) {
    var metadata = tabMetadata.get(id);
    var candidate = metadata && metadata.previousFilePath && S.tabs.find(function(tab) { return tab.path === metadata.previousFilePath; });
    if (!candidate && S.tabs.length) candidate = S.tabs[S.tabs.length - 1];
    deactivate(id);
    if (candidate && BOBO.workspace) {
      BOBO.workspace.activateTab(candidate.path);
      return;
    }
    S.activeTabPath = null;
    if (BOBO.workspace) {
      BOBO.workspace.updateTabbar();
      BOBO.workspace.updateTitlebar();
      BOBO.workspace.updateEmptyState();
    }
  }

  function close(key) {
    var id = providerFromKey(key);
    if (!id || !openProviders.has(id)) return false;
    var active = S.activeTabPath === key;
    openProviders.delete(id);
    skillsOpenFor = skillsOpenFor === id ? '' : skillsOpenFor;
    if (active) restoreAfterClose(id);
    tabMetadata.delete(id);
    if (BOBO.workspace) BOBO.workspace.updateTabbar();
    return true;
  }

  function providerTabs() {
    return Array.from(openProviders).map(function(id) {
      var record = recordById(id);
      if (!record) return null;
      var session = record.state && record.state.activeSession;
      var name = session && session.title || record.descriptor.title;
      return { key: tabKey(id), name: name, title: t('Agent') + ': ' + name, category: t('Agent'), closeable: true, draggable: false };
    }).filter(Boolean);
  }

  function openProvider(id) {
    id = safeProviderId(id);
    if (!id || !recordById(id)) return false;
    selectedProviderId = id;
    openProviders.add(id);
    if (BOBO.workspace) return BOBO.workspace.activateTab(tabKey(id));
    return activate(tabKey(id));
  }

  function createChrome() {
    var primary = document.querySelector('#activitybar .activity-primary');
    var sidebarHost = document.getElementById('sidebar');
    if (activity || !primary || !sidebarHost || !BOBO.workbench) return;
    activity = element('button', 'activity-item agent-activity');
    activity.id = 'activity-agent';
    activity.type = 'button';
    activity.setAttribute('data-workbench-view', VIEW_ID);
    activity.setAttribute('data-i18n-skip', '');
    activity.setAttribute('aria-pressed', 'false');
    activity.appendChild(icon('sparkles'));
    var extensionActivity = document.getElementById('activity-extensions');
    primary.insertBefore(activity, extensionActivity || null);

    sidebar = element('section', 'sidebar-view agent-sidebar');
    sidebar.id = 'agent-sidebar';
    sidebar.setAttribute('data-sidebar-view', VIEW_ID);
    sidebar.setAttribute('data-i18n-skip', '');
    sidebarHost.appendChild(sidebar);
    primaryRegistration = BOBO.workbench.registerPrimaryView(VIEW_ID);

    activity.addEventListener('click', function() {
      BOBO.workbench.setPrimaryView(VIEW_ID);
      var available = records();
      var target = recordById(selectedProviderId) || available[0];
      if (target) openProvider(target.id);
    });
  }

  function destroyChrome() {
    if (!activity && !sidebar) return;
    if (primaryRegistration && primaryRegistration.dispose) primaryRegistration.dispose();
    primaryRegistration = null;
    if (activity) activity.remove();
    if (sidebar) sidebar.remove();
    activity = null;
    sidebar = null;
  }

  function applyChromeLabels() {
    if (!activity || !sidebar) return;
    activity.title = t('Agent');
    activity.setAttribute('aria-label', t('Agent'));
    sidebar.setAttribute('aria-label', t('Agent sessions'));
  }

  function sessionButton(record, session) {
    var button = element('button', 'agent-session-row');
    button.type = 'button';
    button.dataset.status = session.status;
    button.classList.toggle('selected', record.state && record.state.activeSessionId === session.id);
    button.setAttribute('aria-pressed', record.state && record.state.activeSessionId === session.id ? 'true' : 'false');

    var status = element('span', 'agent-session-dot');
    status.setAttribute('aria-hidden', 'true');
    var copy = element('span', 'agent-session-copy');
    copy.appendChild(element('strong', 'agent-session-title', session.title));
    var metadata = element('span', 'agent-session-meta');
    metadata.appendChild(element('span', '', modeLabel(session.mode)));
    var updated = formatTime(session.updatedAt);
    if (updated) metadata.appendChild(element('time', '', updated));
    copy.appendChild(metadata);
    var remove = iconButton('trash', t('Delete session'), 'agent-session-delete');
    remove.addEventListener('click', async function(event) {
      event.stopPropagation();
      var approved = typeof BOBO.confirm === 'function'
        ? await BOBO.confirm({ title: t('Delete session?'), message: t('This removes the local Agent conversation.'), confirmLabel: t('Delete'), cancelLabel: t('Cancel'), danger: true })
        : global.confirm(t('Delete session?'));
      if (approved) {
        var identity = accessIdentity(record);
        var deleted = await invoke(record, 'delete', { sessionId: session.id });
        if (deleted) await clearAccessMode(record, identity);
      }
    });
    button.append(status, copy, remove);
    button.addEventListener('click', function() {
      openProvider(record.id);
      invoke(record, 'select', { sessionId: session.id });
    });
    return button;
  }

  function renderSidebar() {
    if (!sidebar) return;
    var available = records();
    var record = recordById(selectedProviderId) || available[0] || null;
    if (record) selectedProviderId = record.id;
    sidebar.replaceChildren();

    var header = element('div', 'sidebar-header agent-sidebar-header');
    header.appendChild(element('span', '', record ? record.descriptor.title : t('Agent')));
    var headerActions = element('div', 'sidebar-header-actions');
    var create = iconButton('plus', t('New session'));
    create.disabled = !record || isBusy(record.id, 'create');
    create.addEventListener('click', function() {
      if (!record) return;
      openProvider(record.id);
      invoke(record, 'create', commandValues(record));
    });
    var hide = iconButton('chevron', t('Hide primary sidebar'), 'sidebar-hide');
    hide.addEventListener('click', function() { BOBO.workbench.setPrimaryVisible(false); });
    headerActions.append(create, hide);
    header.appendChild(headerActions);
    sidebar.appendChild(header);

    if (available.length > 1) {
      var providerRow = element('label', 'agent-provider-row');
      providerRow.appendChild(element('span', 'sr-only', t('Agent provider')));
      var providerSelect = element('select', 'agent-provider-select');
      providerSelect.setAttribute('aria-label', t('Agent provider'));
      available.forEach(function(candidate) {
        var option = element('option', '', candidate.descriptor.title);
        option.value = candidate.id;
        option.selected = candidate.id === record.id;
        providerSelect.appendChild(option);
      });
      providerSelect.addEventListener('change', function() {
        selectedProviderId = providerSelect.value;
        openProvider(selectedProviderId);
        renderAll();
      });
      providerRow.appendChild(providerSelect);
      sidebar.appendChild(providerRow);
    }

    var newSession = element('button', 'agent-new-session');
    newSession.type = 'button';
    newSession.append(icon('plus'), element('span', '', t('Start new session')));
    newSession.disabled = !record || isBusy(record.id, 'create');
    newSession.addEventListener('click', function() {
      if (!record) return;
      openProvider(record.id);
      invoke(record, 'create', commandValues(record));
    });
    sidebar.appendChild(newSession);

    var search = element('label', 'agent-session-search');
    search.appendChild(icon('search'));
    var input = element('input');
    input.type = 'search';
    input.value = sessionQuery;
    input.placeholder = t('Search sessions...');
    input.setAttribute('aria-label', t('Search sessions'));
    input.autocomplete = 'off';
    input.addEventListener('input', function() {
      sessionQuery = input.value;
      renderSidebar();
      var next = sidebar.querySelector('.agent-session-search input');
      if (next) { next.focus(); next.setSelectionRange(sessionQuery.length, sessionQuery.length); }
    });
    search.appendChild(input);
    sidebar.appendChild(search);

    var list = element('div', 'agent-session-list sidebar-scroll');
    var state = record && record.state;
    if (!state || state.phase === 'loading' || state.phase === 'idle') {
      list.appendChild(element('div', 'agent-sidebar-state', state && state.message || t('Waiting for agent')));
    } else {
      var query = sessionQuery.trim().toLocaleLowerCase();
      var sessions = state.sessions.filter(function(session) { return !query || session.title.toLocaleLowerCase().indexOf(query) >= 0; });
      if (sessions.length) {
        list.appendChild(element('div', 'agent-session-group-title', t('Sessions')));
        sessions.forEach(function(session) { list.appendChild(sessionButton(record, session)); });
      } else {
        list.appendChild(element('div', 'agent-sidebar-state', query ? t('No matching sessions') : t('No sessions yet')));
      }
    }
    sidebar.appendChild(list);
    applyChromeLabels();
  }

  function toolbarSelect(label, className) {
    var wrapper = element('label', 'agent-toolbar-field ' + className);
    wrapper.appendChild(element('span', 'sr-only', label));
    var select = element('select');
    select.setAttribute('aria-label', label);
    wrapper.appendChild(select);
    return { wrapper: wrapper, select: select };
  }

  function updatePreferences(record, next) {
    var current = preferenceState(record);
    Object.assign(current, next || {});
    preferences.set(record.id, current);
    if (current.sessionId) invoke(record, 'preferences', commandValues(record));
    else renderWorkspace(record);
  }

  function appendToolbar(parent, record) {
    var state = record.state || {};
    var session = state.activeSession;
    var current = preferenceState(record);
    ensureAccessMode(record);
    var toolbar = element('header', 'agent-toolbar');
    var identity = element('div', 'agent-toolbar-identity');
    var mark = element('span', 'agent-provider-mark');
    mark.appendChild(icon('sparkles'));
    var copy = element('span', 'agent-toolbar-copy');
    copy.appendChild(element('strong', '', session && session.title || record.descriptor.title));
    copy.appendChild(element('small', '', session ? statusLabel(session.status) : phaseLabel(state.phase)));
    identity.append(mark, copy);
    toolbar.appendChild(identity);

    var controls = element('div', 'agent-toolbar-controls');
    if (Array.isArray(state.models) && state.models.length) {
      var model = toolbarSelect(t('Model'), 'agent-model-field');
      state.models.forEach(function(choice) {
        var label = choice.name + (choice.provider ? ' - ' + choice.provider : '');
        var option = element('option', '', label);
        option.value = choice.ref;
        option.selected = choice.ref === current.modelRef;
        option.disabled = !choice.configured;
        model.select.appendChild(option);
      });
      model.select.addEventListener('change', function() { updatePreferences(record, { modelRef: model.select.value }); });
      controls.appendChild(model.wrapper);
    }

    var modes = record.descriptor.capabilities.modes || [];
    if (modes.length) {
      var modeGroup = element('div', 'agent-mode-control');
      modeGroup.setAttribute('role', 'group');
      modeGroup.setAttribute('aria-label', t('Agent mode'));
      modes.forEach(function(mode) {
        var button = element('button', '', modeLabel(mode));
        button.type = 'button';
        button.setAttribute('aria-pressed', mode === current.mode ? 'true' : 'false');
        button.addEventListener('click', function() { updatePreferences(record, { mode: mode }); });
        modeGroup.appendChild(button);
      });
      controls.appendChild(modeGroup);
    }

    var efforts = record.descriptor.capabilities.reasoningEfforts || [];
    if (efforts.length) {
      var effort = toolbarSelect(t('Thinking intensity'), 'agent-effort-field');
      efforts.forEach(function(value) {
        var option = element('option', '', effortLabel(value));
        option.value = value;
        option.selected = value === current.reasoningEffort;
        effort.select.appendChild(option);
      });
      effort.select.title = t('Thinking intensity');
      effort.select.addEventListener('change', function() { updatePreferences(record, { reasoningEffort: effort.select.value }); });
      controls.appendChild(effort.wrapper);
    }

    if (record.descriptor.capabilities.localTools && session) {
      var access = toolbarSelect(t('Local tool access'), 'agent-access-field');
      ['ask', 'auto', 'full'].forEach(function(value) {
        var option = element('option', '', accessModeLabel(value));
        option.value = value;
        option.selected = value === current.accessMode;
        option.title = accessModeDescription(value);
        access.select.appendChild(option);
      });
      var accessEntry = accessRequests.get(accessKey(accessIdentity(record)));
      access.wrapper.dataset.mode = normalizedAccessMode(current.accessMode);
      access.select.title = accessModeDescription(current.accessMode);
      access.select.disabled = Boolean(accessEntry && (accessEntry.status === 'loading' || accessEntry.status === 'saving'));
      access.select.addEventListener('change', function() { setAccessMode(record, access.select.value); });
      controls.appendChild(access.wrapper);
    }

    if (record.descriptor.capabilities.skills) {
      var skillWrap = element('div', 'agent-skill-wrap');
      var skillButton = iconButton('skill', t('Skills'), 'agent-skill-button');
      skillButton.appendChild(element('span', '', t('Skills') + (current.skillIds.length ? ' ' + current.skillIds.length : '')));
      skillButton.setAttribute('aria-expanded', skillsOpenFor === record.id ? 'true' : 'false');
      skillButton.addEventListener('click', function(event) {
        event.stopPropagation();
        skillsOpenFor = skillsOpenFor === record.id ? '' : record.id;
        renderWorkspace(record);
      });
      skillWrap.appendChild(skillButton);
      if (skillsOpenFor === record.id) skillWrap.appendChild(skillsMenu(record));
      controls.appendChild(skillWrap);
    }

    var configure = iconButton('settings', t('Configure agent'));
    configure.disabled = isBusy(record.id, 'configure');
    configure.addEventListener('click', function() { openConfiguration(record); });
    controls.appendChild(configure);
    if (session) {
      var remove = iconButton('trash', t('Delete session'));
      remove.addEventListener('click', async function() {
        var approved = typeof BOBO.confirm === 'function'
          ? await BOBO.confirm({ title: t('Delete session?'), message: t('This removes the local Agent conversation.'), confirmLabel: t('Delete'), cancelLabel: t('Cancel'), danger: true })
          : global.confirm(t('Delete session?'));
        if (approved) {
          var identity = accessIdentity(record);
          var deleted = await invoke(record, 'delete', { sessionId: session.id });
          if (deleted) await clearAccessMode(record, identity);
        }
      });
      controls.appendChild(remove);
    }
    toolbar.appendChild(controls);
    parent.appendChild(toolbar);
  }

  function skillsMenu(record) {
    var menu = element('div', 'agent-skills-menu');
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', t('Skills'));
    menu.addEventListener('click', function(event) { event.stopPropagation(); });
    menu.appendChild(element('div', 'agent-skills-menu-title', t('Skills available to this session')));
    var available = record.state && record.state.skills || [];
    if (!available.length) {
      menu.appendChild(element('div', 'agent-skills-empty', t('No skills found')));
      return menu;
    }
    var selected = preferenceState(record).skillIds;
    available.forEach(function(skill) {
      var row = element('label', 'agent-skill-option');
      var input = element('input');
      input.type = 'checkbox';
      input.checked = selected.indexOf(skill.id) >= 0;
      input.addEventListener('change', function() {
        var next = selected.slice();
        var index = next.indexOf(skill.id);
        if (input.checked && index < 0) next.push(skill.id);
        if (!input.checked && index >= 0) next.splice(index, 1);
        updatePreferences(record, { skillIds: next });
      });
      var copy = element('span', 'agent-skill-option-copy');
      copy.appendChild(element('strong', '', skill.name));
      if (skill.description) copy.appendChild(element('small', '', skill.description));
      row.append(input, copy);
      menu.appendChild(row);
    });
    return menu;
  }

  function goalNode(goal) {
    var section = element('section', 'agent-goal');
    var heading = element('div', 'agent-goal-heading');
    var title = element('div', 'agent-goal-title');
    title.append(icon('check'), element('strong', '', goal.title));
    var completed = goal.steps.filter(function(step) { return step.status === 'completed'; }).length;
    heading.append(title, element('span', 'agent-goal-progress', completed + ' / ' + goal.steps.length));
    section.appendChild(heading);
    var steps = element('ol', 'agent-goal-steps');
    goal.steps.forEach(function(step) {
      var row = element('li', 'agent-goal-step');
      row.dataset.status = step.status;
      var marker = element('span', 'agent-goal-step-marker');
      if (step.status === 'completed') marker.appendChild(icon('check'));
      row.append(marker, element('span', '', step.title));
      steps.appendChild(row);
    });
    section.appendChild(steps);
    return section;
  }

  function decodeMarkdownEntities(value) {
    var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return String(value || '').replace(/&(?:#(\d+)|#x([a-f0-9]+)|(amp|lt|gt|quot|apos));/gi, function(match, decimal, hexadecimal, name) {
      var code = decimal ? Number(decimal) : hexadecimal ? parseInt(hexadecimal, 16) : 0;
      if (code) {
        try { return String.fromCodePoint(code); } catch (_) { return match; }
      }
      return named[String(name || '').toLowerCase()] || match;
    });
  }

  function safeMarkdownLink(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (_) { return ''; }
  }

  function appendMarkdownInline(parent, tokens) {
    (Array.isArray(tokens) ? tokens : []).forEach(function(token) {
      if (!token || typeof token !== 'object') return;
      if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
        var emphasis = element(token.type === 'strong' ? 'strong' : token.type === 'em' ? 'em' : 'del');
        appendMarkdownInline(emphasis, token.tokens);
        parent.appendChild(emphasis);
        return;
      }
      if (token.type === 'codespan') {
        parent.appendChild(element('code', 'agent-markdown-inline-code', decodeMarkdownEntities(token.text)));
        return;
      }
      if (token.type === 'br') {
        parent.appendChild(document.createElement('br'));
        return;
      }
      if (token.type === 'link') {
        var href = safeMarkdownLink(token.href);
        if (!href) { appendMarkdownInline(parent, token.tokens); return; }
        var link = element('a', 'agent-markdown-link');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        if (typeof token.title === 'string') link.title = token.title.slice(0, 500);
        appendMarkdownInline(link, token.tokens);
        parent.appendChild(link);
        return;
      }
      if (token.type === 'image') {
        parent.appendChild(document.createTextNode(decodeMarkdownEntities(token.text || token.raw || '')));
        return;
      }
      if (Array.isArray(token.tokens) && token.tokens.length) {
        appendMarkdownInline(parent, token.tokens);
        return;
      }
      parent.appendChild(document.createTextNode(decodeMarkdownEntities(token.text || token.raw || '')));
    });
  }

  function copyMarkdownCode(button, code) {
    var clipboard = global.navigator && global.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    clipboard.writeText(code).then(function() {
      button.title = t('Copied');
      button.setAttribute('aria-label', t('Copied'));
      global.setTimeout(function() {
        if (!button.isConnected) return;
        button.title = t('Copy code');
        button.setAttribute('aria-label', t('Copy code'));
      }, 1600);
    }).catch(function() {});
  }

  function markdownCodeBlock(token) {
    var section = element('div', 'agent-markdown-code-block');
    var header = element('div', 'agent-markdown-code-header');
    var language = typeof token.lang === 'string' ? token.lang.trim().split(/\s+/)[0].slice(0, 40) : '';
    header.appendChild(element('span', '', language || t('Code')));
    var copy = iconButton('copy', t('Copy code'), 'agent-icon-button agent-markdown-copy');
    copy.addEventListener('click', function() { copyMarkdownCode(copy, String(token.text || '')); });
    header.appendChild(copy);
    var pre = element('pre', 'agent-markdown-pre');
    pre.appendChild(element('code', '', String(token.text || '')));
    section.append(header, pre);
    return section;
  }

  function appendMarkdownBlocks(parent, tokens, compact) {
    (Array.isArray(tokens) ? tokens : []).forEach(function(token) {
      if (!token || typeof token !== 'object' || token.type === 'space') return;
      if (token.type === 'heading') {
        var heading = element('h' + Math.min(Math.max(Number(token.depth) || 1, 1) + 2, 6));
        appendMarkdownInline(heading, token.tokens);
        parent.appendChild(heading);
        return;
      }
      if (token.type === 'paragraph' || token.type === 'text') {
        var paragraph = compact ? parent : element('p');
        appendMarkdownInline(paragraph, token.tokens || [{ type: 'text', text: token.text || token.raw || '' }]);
        if (!compact) parent.appendChild(paragraph);
        return;
      }
      if (token.type === 'code') {
        parent.appendChild(markdownCodeBlock(token));
        return;
      }
      if (token.type === 'blockquote') {
        var quote = element('blockquote');
        appendMarkdownBlocks(quote, token.tokens, false);
        parent.appendChild(quote);
        return;
      }
      if (token.type === 'list') {
        var list = element(token.ordered ? 'ol' : 'ul');
        if (token.ordered && Number.isSafeInteger(token.start) && token.start > 1) list.start = token.start;
        (Array.isArray(token.items) ? token.items : []).forEach(function(item) {
          var row = element('li');
          if (item.task) {
            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = item.checked === true;
            checkbox.disabled = true;
            checkbox.setAttribute('aria-hidden', 'true');
            row.appendChild(checkbox);
          }
          appendMarkdownBlocks(row, item.tokens, true);
          list.appendChild(row);
        });
        parent.appendChild(list);
        return;
      }
      if (token.type === 'table') {
        var wrap = element('div', 'agent-markdown-table-wrap');
        var table = element('table');
        var thead = element('thead');
        var headRow = element('tr');
        (Array.isArray(token.header) ? token.header : []).forEach(function(cell, index) {
          var th = element('th');
          var alignment = token.align && token.align[index];
          if (alignment === 'left' || alignment === 'center' || alignment === 'right') th.style.textAlign = alignment;
          appendMarkdownInline(th, cell.tokens);
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);
        var tbody = element('tbody');
        (Array.isArray(token.rows) ? token.rows : []).forEach(function(cells) {
          var row = element('tr');
          cells.forEach(function(cell, index) {
            var td = element('td');
            var alignment = token.align && token.align[index];
            if (alignment === 'left' || alignment === 'center' || alignment === 'right') td.style.textAlign = alignment;
            appendMarkdownInline(td, cell.tokens);
            row.appendChild(td);
          });
          tbody.appendChild(row);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        parent.appendChild(wrap);
        return;
      }
      if (token.type === 'hr') {
        parent.appendChild(document.createElement('hr'));
        return;
      }
      // Raw HTML and unsupported extensions are deliberately rendered as text.
      var fallback = compact ? parent : element('p', 'agent-markdown-raw');
      fallback.appendChild(document.createTextNode(String(token.raw || token.text || '')));
      if (!compact) parent.appendChild(fallback);
    });
  }

  function markdownNode(source) {
    var root = element('div', 'agent-message-content agent-markdown');
    try {
      appendMarkdownBlocks(root, marked.lexer(String(source || ''), { gfm: true, breaks: false }), false);
    } catch (_) {
      root.textContent = String(source || '');
    }
    return root;
  }

  function messageNode(item) {
    var message = item.value;
    var article = element('article', 'agent-message agent-message-' + message.role);
    var header = element('header', 'agent-message-header');
    header.appendChild(element('span', '', message.role === 'user' ? t('You') : message.role === 'assistant' ? t('Agent') : t('System')));
    var time = formatTime(message.createdAt);
    if (time) header.appendChild(element('time', '', time));
    article.appendChild(header);
    if (message.content) article.appendChild(message.role === 'assistant' ? markdownNode(message.content) : element('div', 'agent-message-content', message.content));
    if (message.reasoning) {
      var reasoning = element('details', 'agent-message-reasoning');
      reasoning.appendChild(element('summary', '', t('Thought process')));
      reasoning.appendChild(element('div', 'agent-reasoning-content', message.reasoning));
      article.appendChild(reasoning);
    }
    return article;
  }

  function timelineNode(item) {
    var value = item.value;
    var row = element('div', 'agent-timeline-row');
    row.dataset.kind = value.kind;
    row.dataset.status = value.status;
    var rail = element('span', 'agent-timeline-marker');
    rail.appendChild(icon(value.kind === 'tool' ? 'tool' : value.kind === 'skill' ? 'skill' : value.kind === 'compaction' ? 'compress' : value.kind === 'error' ? 'close' : value.status === 'completed' ? 'check' : 'clock'));
    var body = element('div', 'agent-timeline-body');
    if (value.kind === 'compaction') {
      var compacted = element('div', 'agent-timeline-title');
      compacted.append(element('strong', '', t('Context compacted')), element('span', '', timelineStatusLabel(value.status)));
      body.appendChild(compacted);
      if (value.detail) body.appendChild(element('div', 'agent-timeline-detail', value.detail));
    } else if (value.kind === 'thought' && value.detail) {
      var details = element('details', 'agent-timeline-details');
      details.appendChild(element('summary', '', value.title));
      details.appendChild(element('div', 'agent-timeline-detail', value.detail));
      body.appendChild(details);
    } else {
      var heading = element('div', 'agent-timeline-title');
      heading.append(element('strong', '', value.title), element('span', '', timelineStatusLabel(value.status)));
      body.appendChild(heading);
      if (value.detail) body.appendChild(element('div', 'agent-timeline-detail', value.detail));
    }
    row.append(rail, body);
    if (value.kind === 'error') row.setAttribute('role', 'alert');
    return row;
  }

  function feedItems(session) {
    var messages = session.messages.map(function(value, index) { return { type: 'message', value: value, index: index }; });
    var timeline = session.timeline.map(function(value, index) { return { type: 'timeline', value: value, index: index }; });
    var combined = messages.concat(timeline);
    var dated = combined.length && combined.every(function(item) { return Number.isFinite(new Date(item.value.createdAt).getTime()); });
    if (dated) {
      return combined.sort(function(left, right) {
        var delta = new Date(left.value.createdAt).getTime() - new Date(right.value.createdAt).getTime();
        return delta || (left.type === 'message' ? -1 : 1);
      });
    }
    var last = messages.length && messages[messages.length - 1].value.role === 'assistant' ? messages.pop() : null;
    return messages.concat(timeline, last ? [last] : []);
  }

  function approvalDetailRow(label, value, monospace) {
    var row = element('div', 'agent-approval-detail-row');
    row.append(element('dt', '', label), element('dd', monospace ? 'agent-approval-mono' : '', value));
    return row;
  }

  function approvalDetailsNode(detail) {
    var list = element('dl', 'agent-approval-details');
    if (detail.tool === 'workspace_write') {
      list.appendChild(approvalDetailRow(t('Path'), detail.details.path || t('Unknown'), true));
      list.appendChild(approvalDetailRow(t('Size'), t('{count} bytes', { count: detail.details.bytes }), false));
      if (detail.details.expectedSha256) list.appendChild(approvalDetailRow(t('Expected SHA-256'), detail.details.expectedSha256, true));
      if (detail.details.contentPreview) {
        var previewRow = element('div', 'agent-approval-detail-row agent-approval-preview-row');
        var label = element('dt', '', t('Content preview'));
        if (detail.details.contentTruncated) label.appendChild(element('span', 'agent-approval-truncated', t('Preview truncated')));
        previewRow.append(label, element('dd', '', ''));
        previewRow.lastChild.appendChild(element('pre', 'agent-approval-preview', detail.details.contentPreview));
        list.appendChild(previewRow);
      }
    } else {
      list.appendChild(approvalDetailRow(t('Command'), detail.details.command || t('Unknown'), true));
      if (detail.details.resolvedExecutable) list.appendChild(approvalDetailRow(t('Resolved executable'), detail.details.resolvedExecutable, true));
      if (detail.details.args.length) list.appendChild(approvalDetailRow(t('Arguments'), JSON.stringify(detail.details.args), true));
      if (detail.details.cwd) list.appendChild(approvalDetailRow(t('Working directory'), detail.details.cwd, true));
      if (detail.details.timeoutMs) list.appendChild(approvalDetailRow(t('Timeout'), t('{milliseconds} ms', { milliseconds: detail.details.timeoutMs }), false));
    }
    return list;
  }

  function approvalNode(record, approval) {
    var key = approvalKey(record, approval.id);
    var cached = ensureApprovalDetail(record, approval);
    var detail = cached && cached.status === 'ready' ? cached.detail : null;
    var decision = approvalDecisions.get(key);
    var running = Boolean(decision && (decision.status === 'running' || decision.status === 'cancelling'));
    var section = element('section', 'agent-approval');
    section.setAttribute('role', 'alert');
    var copy = element('div', 'agent-approval-copy');
    var heading = element('div', 'agent-approval-heading');
    var mark = element('span', 'agent-approval-mark');
    mark.appendChild(icon(detail && detail.tool === 'process_run' ? 'tool' : running ? 'clock' : 'check'));
    heading.append(mark, element('strong', '', running ? t('Running command...') : t('Approval required')));
    if (detail) heading.appendChild(element('span', 'agent-approval-risk', riskLabel(detail.risk)));
    copy.append(heading, element('p', '', detail ? detail.summary : t('Loading approval details')));
    if (detail) copy.appendChild(approvalDetailsNode(detail));
    var actions = element('div', 'agent-approval-actions');
    if (running && detail && detail.tool === 'process_run') {
      var cancel = element('button', 'agent-button-secondary', decision.status === 'cancelling' ? t('Cancelling...') : t('Cancel command'));
      cancel.type = 'button';
      cancel.disabled = decision.status === 'cancelling';
      cancel.addEventListener('click', function() { cancelApproval(record, approval.id); });
      actions.appendChild(cancel);
    } else {
      var reject = element('button', 'agent-button-secondary', t('Reject'));
      reject.type = 'button';
      reject.disabled = Boolean(decision);
      reject.addEventListener('click', function() { decideApproval(record, approval.id, false); });
      var approve = element('button', 'agent-button-primary', t('Approve'));
      approve.type = 'button';
      approve.disabled = !detail || Boolean(decision);
      approve.addEventListener('click', function() { decideApproval(record, approval.id, true); });
      actions.append(reject, approve);
    }
    section.append(copy, actions);
    return section;
  }

  function emptyState(record, kind) {
    var state = record.state || {};
    var empty = element('div', 'agent-empty-state');
    var mark = element('span', 'agent-empty-mark');
    mark.appendChild(icon(kind === 'error' ? 'close' : kind === 'setup' ? 'settings' : 'sparkles'));
    empty.appendChild(mark);
    if (kind === 'setup') {
      empty.append(element('strong', '', t('Configure a model to start')), element('p', '', state.message || t('Agent uses your local AI connections without exposing credentials to the plugin.')));
      var setup = element('button', 'agent-button-primary', t('Configure agent'));
      setup.type = 'button';
      setup.addEventListener('click', function() { openConfiguration(record); });
      empty.appendChild(setup);
    } else if (kind === 'error') {
      empty.append(element('strong', '', t('Agent unavailable')), element('p', '', state.message || errors.get(record.id) || t('The Agent provider could not start.')));
      var retry = element('button', 'agent-button-secondary', t('Open configuration'));
      retry.type = 'button';
      retry.addEventListener('click', function() { openConfiguration(record); });
      empty.appendChild(retry);
    } else if (kind === 'loading') {
      empty.classList.add('loading');
      empty.append(element('strong', '', t('Loading agent...')), element('p', '', state.message || t('Restoring local sessions and tools.')));
    } else {
      empty.append(element('strong', '', t('Start an Agent session')), element('p', '', t('Choose Chat for a focused answer or Goal for a multi-step task.')));
      var create = element('button', 'agent-button-primary', t('New session'));
      create.type = 'button';
      create.addEventListener('click', function() { invoke(record, 'create', commandValues(record)); });
      empty.appendChild(create);
    }
    return empty;
  }

  function composerNode(record, session) {
    var composer = element('form', 'agent-composer');
    var textarea = element('textarea', 'agent-composer-input');
    var accessBlocked = Boolean(session && !accessReady(record));
    var turnBlocked = Boolean(session && (session.status === 'running' || session.status === 'waiting-approval' || accessBlocked));
    textarea.rows = 1;
    textarea.placeholder = t('Ask the agent to change, explain, or run something...');
    textarea.setAttribute('aria-label', t('Message the agent'));
    textarea.value = drafts.get(record.id) || '';
    textarea.disabled = !session || !record.state || record.state.phase !== 'ready' || turnBlocked;
    function resize() {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(180, textarea.scrollHeight) + 'px';
    }
    textarea.addEventListener('input', function() { drafts.set(record.id, textarea.value); resize(); });
    textarea.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (session && !turnBlocked) composer.requestSubmit();
      }
    });
    composer.appendChild(textarea);
    var footer = element('div', 'agent-composer-footer');
    var context = element('span', 'agent-composer-context');
    if (accessBlocked) {
      var entry = accessEntry(record);
      context.append(icon('clock'), element('span', '', entry && entry.status === 'error' ? t('Local tool access unavailable') : t('Verifying local tool access...')));
    } else if (session && session.compacting) {
      context.append(icon('compress'), element('span', '', t('Compacting conversation context...')));
    } else if (session && session.compaction && session.compaction.count > 0) {
      context.append(icon('compress'), element('span', '', t('Context compacted {count} times', { count: session.compaction.count })));
    } else if (record.descriptor.capabilities.localTools) {
      context.append(icon('tool'), element('span', '', t('Local tools require approval for changes')));
    } else {
      context.appendChild(element('span', '', modeLabel(preferenceState(record).mode)));
    }
    footer.appendChild(context);
    if (session && session.status === 'running') {
      var cancel = iconButton('stop', t('Cancel run'), 'agent-send-button agent-cancel-button');
      cancel.disabled = isBusy(record.id, 'cancel');
      cancel.addEventListener('click', function() { invoke(record, 'cancel', { sessionId: session.id }); });
      footer.appendChild(cancel);
    } else {
      var send = iconButton('send', t('Send message'), 'agent-send-button');
      send.type = 'submit';
      send.disabled = !session || turnBlocked || !textarea.value.trim() || isBusy(record.id, 'send');
      textarea.addEventListener('input', function() { send.disabled = turnBlocked || !textarea.value.trim() || isBusy(record.id, 'send'); });
      footer.appendChild(send);
    }
    composer.appendChild(footer);
    composer.addEventListener('submit', async function(event) {
      event.preventDefault();
      var value = textarea.value.trim();
      if (!session || !value || turnBlocked) return;
      var sent = await invoke(record, 'send', commandValues(record, { sessionId: session.id, text: value }));
      if (sent) {
        drafts.set(record.id, '');
        var next = document.querySelector('#' + PAGE_ID + ' .agent-composer-input');
        if (next) { next.value = ''; next.style.height = 'auto'; }
      }
    });
    requestAnimationFrame(resize);
    return composer;
  }

  function renderWorkspace(record) {
    var root = page();
    if (!root || !record || S.activeTabPath !== tabKey(record.id)) return;
    var oldScroll = root.querySelector('.agent-scroll');
    var oldInput = root.querySelector('.agent-composer-input');
    var nearBottom = !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 72;
    var scrollTop = oldScroll ? oldScroll.scrollTop : 0;
    var restoreFocus = oldInput && document.activeElement === oldInput;
    var selectionStart = oldInput ? oldInput.selectionStart : 0;
    if (oldInput) drafts.set(record.id, oldInput.value);
    root.replaceChildren();

    var shell = element('div', 'agent-page');
    appendToolbar(shell, record);
    var scroll = element('div', 'agent-scroll');
    var content = element('main', 'agent-content');
    var state = record.state;
    var hostError = errors.get(record.id);
    if (hostError) {
      var error = element('div', 'agent-host-error', hostError);
      error.setAttribute('role', 'alert');
      content.appendChild(error);
    }
    if (!state || state.phase === 'loading' || state.phase === 'idle') {
      content.appendChild(emptyState(record, 'loading'));
    } else if (state.phase === 'unconfigured') {
      content.appendChild(emptyState(record, 'setup'));
    } else if (state.phase === 'error') {
      content.appendChild(emptyState(record, 'error'));
    } else if (!state.activeSession) {
      content.appendChild(emptyState(record, 'empty'));
    } else {
      var session = state.activeSession;
      if (state.message) content.appendChild(element('div', 'agent-state-message', state.message));
      if (session.goal) content.appendChild(goalNode(session.goal));
      var feed = element('div', 'agent-feed');
      feedItems(session).forEach(function(item) { feed.appendChild(item.type === 'message' ? messageNode(item) : timelineNode(item)); });
      if (!feed.childNodes.length) feed.appendChild(element('div', 'agent-feed-empty', t('Send a message to begin.')));
      content.appendChild(feed);
      if (session.approval) content.appendChild(approvalNode(record, session.approval));
    }
    scroll.appendChild(content);
    shell.append(scroll, composerNode(record, state && state.activeSession));
    root.appendChild(shell);

    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = scrollTop;
    if (restoreFocus) {
      var input = root.querySelector('.agent-composer-input');
      if (input) {
        input.focus();
        try { input.setSelectionRange(selectionStart, selectionStart); } catch (error) {}
      }
    }
  }

  function renderAll() {
    renderSidebar();
    var record = activeRecord();
    if (record) renderWorkspace(record);
    if (BOBO.workspace) {
      BOBO.workspace.updateTabbar();
      BOBO.workspace.updateTitlebar();
    }
    if (BOBO.workbench && BOBO.workbench.refreshControls) BOBO.workbench.refreshControls();
  }

  function sync() {
    var available = records();
    var known = new Set(available.map(function(record) { return record.id; }));
    var activeApprovalKeys = new Set();
    var activeAccessKeys = new Set();
    available.forEach(function(record) {
      var approval = record.state && record.state.activeSession && record.state.activeSession.approval;
      if (approval) activeApprovalKeys.add(approvalKey(record, approval.id));
      var identity = accessIdentity(record);
      if (identity) activeAccessKeys.add(accessKey(identity));
    });
    Array.from(approvalDetails.keys()).forEach(function(key) { if (!activeApprovalKeys.has(key)) approvalDetails.delete(key); });
    Array.from(approvalDecisions.keys()).forEach(function(key) { if (!activeApprovalKeys.has(key)) approvalDecisions.delete(key); });
    Array.from(accessRequests.keys()).forEach(function(key) { if (!activeAccessKeys.has(key)) accessRequests.delete(key); });
    var activeRemoved = '';
    var removed = [];
    Array.from(openProviders).forEach(function(id) {
      if (known.has(id)) return;
      openProviders.delete(id);
      removed.push(id);
      preferences.delete(id);
      drafts.delete(id);
      errors.delete(id);
      if (S.activeTabPath === tabKey(id)) activeRemoved = id;
    });
    if (activeRemoved) restoreAfterClose(activeRemoved);
    removed.forEach(function(id) { tabMetadata.delete(id); });
    if (!known.has(selectedProviderId)) selectedProviderId = available.length ? available[0].id : '';
    if (available.length) createChrome();
    else destroyChrome();
    applyChromeLabels();
    renderAll();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    var api = agentApi();
    if (!api || typeof api.onDidChange !== 'function') return;
    page();
    if (BOBO.workspace && BOBO.workspace.registerWorkbenchTabProvider) {
      tabRegistration = BOBO.workspace.registerWorkbenchTabProvider(PROVIDER_ID, {
        getTabs: providerTabs,
        activate: activate,
        close: close,
        deactivate: deactivate,
        afterFileActivation: restoreUnderlyingView
      });
    }
    agentSubscription = api.onDidChange(sync);
    if (BOBO.i18n && typeof BOBO.i18n.onChange === 'function') {
      var disposeLanguage = BOBO.i18n.onChange(function() { renderAll(); applyChromeLabels(); });
      if (typeof disposeLanguage === 'function') languageSubscription = { dispose: disposeLanguage };
    } else {
      global.addEventListener('bobo:language-changed', renderAll);
      languageSubscription = { dispose: function() { global.removeEventListener('bobo:language-changed', renderAll); } };
    }
    documentClickHandler = function(event) {
      if (!skillsOpenFor || event.target.closest('.agent-skill-wrap')) return;
      skillsOpenFor = '';
      var record = activeRecord();
      if (record) renderWorkspace(record);
    };
    document.addEventListener('click', documentClickHandler);
    sync();
  }

  function dispose() {
    try { if (agentSubscription && agentSubscription.dispose) agentSubscription.dispose(); } catch (error) {}
    try { if (languageSubscription && languageSubscription.dispose) languageSubscription.dispose(); } catch (error) {}
    try { if (tabRegistration && tabRegistration.dispose) tabRegistration.dispose(); } catch (error) {}
    if (documentClickHandler) document.removeEventListener('click', documentClickHandler);
    agentSubscription = null;
    languageSubscription = null;
    tabRegistration = null;
    documentClickHandler = null;
    approvalDetails.clear();
    approvalDecisions.clear();
    accessRequests.clear();
    destroyChrome();
    var root = document.getElementById(PAGE_ID);
    if (root) root.remove();
    initialized = false;
  }

  BOBO.agentWorkbench = Object.freeze({
    init: init,
    dispose: dispose,
    open: openProvider,
    openConfiguration: openConfiguration,
    refresh: sync,
    refreshModels: refreshModels
  });
  if (document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true') init();
  else global.addEventListener('bobo:ready', init, { once: true });
})(window);
