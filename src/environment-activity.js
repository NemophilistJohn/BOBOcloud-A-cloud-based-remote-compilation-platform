// src/environment-activity.js - Durable, scoped project-environment activity ledger.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state || {};
  var STORAGE_KEY = 'bobocloud.environment.activity.v1';
  var MAX_SCOPES = 80;
  var EVENT_NAME = 'bobo:environment-activity';
  var records = readRecords();
  var subscribers = [];

  function stringHash(value) {
    var text = String(value || '');
    var hash = 2166136261;
    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function readRecords() {
    try {
      var value = JSON.parse(global.localStorage && global.localStorage.getItem(STORAGE_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : Object.create(null);
    } catch (_) {
      return Object.create(null);
    }
  }

  function persist() {
    try {
      var keys = Object.keys(records).sort(function(left, right) {
        return Number(records[right] && records[right].updatedAt || 0) - Number(records[left] && records[left].updatedAt || 0);
      });
      keys.slice(MAX_SCOPES).forEach(function(key) { delete records[key]; });
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch (_) {}
  }

  function currentLanguage() {
    var tab = (S.tabs || []).find(function(item) { return item.path === S.activeTabPath; });
    if (tab && tab.language && tab.language !== 'image') return String(tab.language);
    var model = S.editor && typeof S.editor.getModel === 'function' ? S.editor.getModel() : null;
    return model && typeof model.getLanguageId === 'function' ? String(model.getLanguageId() || '') : '';
  }

  function identityPart() {
    var user = S.auth && S.auth.user;
    return user && (user.uid || user.id || user.userId || user.username) || (S.auth && S.auth.mode === 'single' ? 'single' : 'anonymous');
  }

  function scopeDescriptor(overrides) {
    overrides = overrides || {};
    var current = S.collaboration && S.collaboration.current;
    var workspaceRoot = Object.prototype.hasOwnProperty.call(overrides, 'workspaceRoot') ? overrides.workspaceRoot : S.workspaceRoot;
    var language = overrides.language || currentLanguage() || 'unknown';
    var runtime = Object.prototype.hasOwnProperty.call(overrides, 'runtime') ? overrides.runtime : (S.selectedRuntime || 'local');
    var workspace = current ? {
      kind: 'team',
      teamId: String(current.teamId || ''),
      projectId: String(current.projectId || ''),
      branch: String(current.branch || '')
    } : {
      kind: 'personal',
      folderKey: workspaceRoot && BOBO.projectKey ? BOBO.projectKey(workspaceRoot) : ''
    };
    return {
      server: stringHash(S.serverSettings && S.serverSettings.ip || 'local'),
      user: stringHash(identityPart()),
      workspace: workspace,
      runtime: String(runtime || 'local'),
      language: String(language || 'unknown')
    };
  }

  function scopeKey(overrides) {
    var descriptor = scopeDescriptor(overrides);
    var workspace = descriptor.workspace;
    var workspaceIdentity = workspace.kind === 'team'
      ? ['team', workspace.teamId, workspace.projectId, workspace.branch].join(':')
      : ['personal', workspace.folderKey].join(':');
    return 'e1-' + stringHash([
      descriptor.server, descriptor.user, workspaceIdentity, descriptor.runtime, descriptor.language
    ].join('|'));
  }

  function copyRecord(value) {
    if (!value) return {};
    return {
      lastIndexedAt: Number(value.lastIndexedAt || 0) || 0,
      lastInstalledAt: Number(value.lastInstalledAt || 0) || 0,
      lastCompiledAt: Number(value.lastCompiledAt || 0) || 0,
      lastRepairAt: Number(value.lastRepairAt || 0) || 0,
      lastRebuildAt: Number(value.lastRebuildAt || 0) || 0,
      lastAction: String(value.lastAction || ''),
      lastOutcome: String(value.lastOutcome || ''),
      updatedAt: Number(value.updatedAt || 0) || 0
    };
  }

  function read(overrides) {
    return copyRecord(records[scopeKey(overrides)]);
  }

  function emit(kind, record, detail) {
    var payload = {
      kind: kind,
      scopeKey: scopeKey(detail && detail.scope),
      record: copyRecord(record),
      detail: detail || {}
    };
    subscribers.slice().forEach(function(callback) {
      try { callback(payload); } catch (error) { console.error('environment activity subscriber:', error); }
    });
    try { global.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload })); } catch (_) {}
  }

  function record(kind, detail) {
    detail = detail || {};
    var timestamp = Number(detail.at || Date.now());
    if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = Date.now();
    var key = scopeKey(detail.scope);
    var value = copyRecord(records[key]);
    var fields = {
      index: 'lastIndexedAt',
      install: 'lastInstalledAt',
      compile: 'lastCompiledAt',
      repair: 'lastRepairAt',
      rebuild: 'lastRebuildAt'
    };
    var field = fields[kind];
    if (!field) return false;
    value[field] = Math.max(Number(value[field] || 0), timestamp);
    value.lastAction = kind;
    value.lastOutcome = detail.outcome === 'failed' ? 'failed' : 'completed';
    value.updatedAt = timestamp;
    records[key] = value;
    persist();
    emit(kind, value, detail);
    return true;
  }

  function contextChanged(reason) {
    emit('context', read(), { reason: String(reason || 'changed') });
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') return function() {};
    subscribers.push(callback);
    return function() {
      var index = subscribers.indexOf(callback);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  BOBO.environmentActivity = {
    read: read,
    record: record,
    contextChanged: contextChanged,
    subscribe: subscribe,
    getScope: scopeDescriptor,
    getScopeKey: scopeKey,
    _storageKey: STORAGE_KEY
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { stringHash: stringHash };
  }
})(typeof window !== 'undefined' ? window : globalThis);
