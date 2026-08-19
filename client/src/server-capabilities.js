// src/server-capabilities.js - Validates the public serverInfo capability descriptor.
//
// This is deliberately metadata-only. Existing actions retain their legacy
// behaviour when an older server does not advertise a descriptor; callers can
// use the normalized snapshot to opt into newly negotiated features safely.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var SUPPORTED_SCHEMA_VERSION = 1;
  var SUPPORTED_PROTOCOL_NAME = 'bobocloud';
  var SUPPORTED_PROTOCOL_VERSION = 1;
  var MAX_LIST_ITEMS = 64;
  var MAX_TEXT_LENGTH = 160;
  var REFRESH_TTL_MS = 5000;
  var subscribers = [];
  var refreshRecord = null;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength || MAX_TEXT_LENGTH) : '';
  }

  function boundedInteger(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function uniqueTextList(value) {
    if (!Array.isArray(value)) return [];
    var result = [];
    value.forEach(function(item) {
      var text = cleanText(item);
      if (text && result.indexOf(text) === -1 && result.length < MAX_LIST_ITEMS) result.push(text);
    });
    return result;
  }

  function normalizedPaths(value) {
    if (!Array.isArray(value)) return [];
    var result = [];
    value.forEach(function(item) {
      var path = cleanText(item);
      if (path && path.charAt(0) === '/' && path.indexOf('://') === -1 && result.indexOf(path) === -1 && result.length < MAX_LIST_ITEMS) {
        result.push(path);
      }
    });
    return result;
  }

  function normalizedTransportEndpoint(value, permittedSchemes) {
    value = isRecord(value) ? value : {};
    var scheme = cleanText(value.scheme, 12).toLowerCase();
    if (permittedSchemes.indexOf(scheme) === -1) scheme = '';
    return { scheme: scheme, paths: normalizedPaths(value.paths) };
  }

  function normalizedFeatureGroup(value, includeLanguages) {
    value = isRecord(value) ? value : {};
    var result = { enabled: value.enabled === true };
    if (includeLanguages) result.languages = uniqueTextList(value.languages);
    return result;
  }

  function normalizedLimitGroup(value) {
    value = isRecord(value) ? value : {};
    return {
      maxSessions: boundedInteger(value.maxSessions),
      maxPerUser: boundedInteger(value.maxPerUser)
    };
  }

  function legacySnapshot() {
    return {
      state: 'legacy',
      compatible: true,
      schemaVersion: 0,
      protocol: { name: '', version: 0 },
      release: { version: '' },
      transport: {
        http: { scheme: '', paths: [] },
        websocket: { scheme: '', paths: [] }
      },
      capabilities: null,
      limits: null,
      catalogRevisions: { lsp: 0, dap: '' },
      catalogFingerprints: { lsp: '', dap: '' },
      secureTransportRequired: false
    };
  }

  function incompatibleSnapshot(reason) {
    var snapshot = legacySnapshot();
    snapshot.state = 'incompatible';
    snapshot.compatible = false;
    snapshot.reason = reason;
    return snapshot;
  }

  function normalizeDescriptor(value) {
    if (!isRecord(value)) return incompatibleSnapshot('invalid_descriptor');
    if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return incompatibleSnapshot('unsupported_schema');

    var protocol = isRecord(value.protocol) ? value.protocol : {};
    if (protocol.name !== SUPPORTED_PROTOCOL_NAME || protocol.version !== SUPPORTED_PROTOCOL_VERSION) {
      return incompatibleSnapshot('unsupported_protocol');
    }

    var transport = isRecord(value.transport) ? value.transport : {};
    var capabilities = isRecord(value.capabilities) ? value.capabilities : {};
    var limits = isRecord(value.limits) ? value.limits : {};
    var revisions = isRecord(value.catalogRevisions) ? value.catalogRevisions : {};
    var fingerprints = isRecord(value.catalogFingerprints) ? value.catalogFingerprints : {};
    var release = isRecord(value.release) ? value.release : {};
    var normalizedTransport = {
      http: normalizedTransportEndpoint(transport.http, ['http', 'https']),
      websocket: normalizedTransportEndpoint(transport.websocket, ['ws', 'wss'])
    };

    return {
      state: 'compatible',
      compatible: true,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      protocol: { name: SUPPORTED_PROTOCOL_NAME, version: SUPPORTED_PROTOCOL_VERSION },
      release: { version: cleanText(release.version) },
      transport: normalizedTransport,
      capabilities: {
        run: capabilities.run === true,
        tasks: capabilities.tasks === true,
        terminal: capabilities.terminal === true,
        projectEnvironment: capabilities.projectEnvironment === true,
        collaboration: capabilities.collaboration === true,
        lsp: normalizedFeatureGroup(capabilities.lsp, true),
        dap: normalizedFeatureGroup(capabilities.dap, false)
      },
      limits: {
        runMaxConcurrent: boundedInteger(limits.runMaxConcurrent),
        terminalMaxSessionSeconds: boundedInteger(limits.terminalMaxSessionSeconds),
        lsp: normalizedLimitGroup(limits.lsp),
        dap: normalizedLimitGroup(limits.dap)
      },
      catalogRevisions: {
        lsp: boundedInteger(revisions.lsp),
        dap: cleanText(revisions.dap)
      },
      catalogFingerprints: {
        lsp: cleanText(fingerprints.lsp),
        dap: cleanText(fingerprints.dap)
      },
      secureTransportRequired: normalizedTransport.http.scheme === 'https' || normalizedTransport.websocket.scheme === 'wss'
    };
  }

  function inspectServerInfo(response) {
    var data = response && isRecord(response.data) ? response.data : null;
    if (!data || !hasOwn(data, 'serverCapabilities')) return legacySnapshot();
    return normalizeDescriptor(data.serverCapabilities);
  }

  function refreshIdentityKey() {
    var state = BOBO.state || {};
    var server = state.serverSettings || {};
    var auth = state.auth || {};
    var user = auth.user || {};
    var fingerprints = Array.isArray(server.certificateFingerprints)
      ? server.certificateFingerprints.map(String)
      : [String(server.certificateFingerprint || '')];
    return JSON.stringify({
      ip: String(server.ip || ''),
      httpPort: Number(server.httpPort || 0),
      wsPort: Number(server.wsPort || 0),
      secureTransport: server.secureTransport === true,
      fingerprints: fingerprints,
      authMode: String(auth.mode || ''),
      userId: String(user.id || user.uid || user.username || ''),
      authEpoch: Number(state.runIdentityEpoch || 0)
    });
  }

  function invalidateRefresh() {
    refreshRecord = null;
  }

  function publish(snapshot, reason) {
    var previous = BOBO.state ? BOBO.state.serverCapabilities : null;
    if (BOBO.state) BOBO.state.serverCapabilities = snapshot;
    var detail = { previous: previous || null, current: snapshot || null, reason: cleanText(reason, 64) };
    subscribers.slice().forEach(function(listener) {
      try { listener(detail); } catch (error) { console.error('server capability subscriber:', error); }
    });
    if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
      try { global.dispatchEvent(new global.CustomEvent('bobo:server-capabilities-changed', { detail: detail })); } catch (_) {}
    }
    return snapshot;
  }

  function applyServerInfo(response, reason) {
    invalidateRefresh();
    var snapshot = inspectServerInfo(response);
    return publish(snapshot, reason || 'server-info');
  }

  function clear(reason) {
    invalidateRefresh();
    publish(null, reason || 'clear');
  }

  function notify(reason) {
    return publish(BOBO.state ? BOBO.state.serverCapabilities : null, reason || 'state-change');
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return function() {};
    subscribers.push(listener);
    return function() {
      var index = subscribers.indexOf(listener);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  // Refreshing a capability descriptor is intentionally independent from the
  // authentication workflow. LSP reconnects need current catalog metadata,
  // but must not reopen login UI or let a late response cross an identity
  // boundary. Successful probes are briefly cached and concurrent probes for
  // the same identity share one promise.
  function refresh(options) {
    var settings = BOBO.state && BOBO.state.serverSettings;
    if (!BOBO.sendToServer || !settings || !settings.ip) {
      return Promise.resolve({ success: false, reason: 'server_unavailable' });
    }

    var key = refreshIdentityKey();
    var now = Date.now();
    if (refreshRecord && refreshRecord.key === key) {
      if (refreshRecord.promise) return refreshRecord.promise;
      if (refreshRecord.expiresAt > now && refreshRecord.result) {
        return Promise.resolve(Object.assign({}, refreshRecord.result, { cached: true, refreshed: false }));
      }
    }

    var reason = cleanText(options && options.reason, 64) || 'capability-refresh';
    var record = { key: key, expiresAt: 0, result: null, promise: null };
    var pending = Promise.resolve().then(function() {
      return BOBO.sendToServer('serverInfo', {}, { quiet: true });
    }).then(function(response) {
      if (refreshRecord !== record || refreshIdentityKey() !== key) {
        return { success: false, stale: true, reason: 'identity_changed' };
      }
      if (!response || response.success !== true) {
        return { success: false, reason: 'probe_failed' };
      }

      var snapshot = inspectServerInfo(response);
      if (requiresSecureTransport(snapshot, BOBO.state && BOBO.state.serverSettings)) {
        snapshot = incompatibleSnapshot('secure_transport_required');
      }
      publish(snapshot, reason);
      record.expiresAt = Date.now() + REFRESH_TTL_MS;
      record.result = { success: true, refreshed: true, cached: false, snapshot: snapshot };
      return record.result;
    }).catch(function(error) {
      return { success: false, reason: 'probe_failed', error: error };
    }).finally(function() {
      if (refreshRecord === record) record.promise = null;
    });
    record.promise = pending;
    refreshRecord = record;
    return pending;
  }

  function requiresSecureTransport(snapshot, settings) {
    return !!(snapshot && snapshot.secureTransportRequired && (!settings || settings.secureTransport !== true));
  }

  function supports(feature, snapshot) {
    snapshot = snapshot || (BOBO.state && BOBO.state.serverCapabilities);
    if (!snapshot) return false;
    if (snapshot.state === 'legacy') return true;
    if (snapshot.state !== 'compatible' || !snapshot.capabilities) return false;
    if (feature === 'lsp') return snapshot.capabilities.lsp.enabled;
    if (feature === 'dap') return snapshot.capabilities.dap.enabled;
    return snapshot.capabilities[feature] === true;
  }

  BOBO.serverCapabilities = {
    inspectServerInfo: inspectServerInfo,
    applyServerInfo: applyServerInfo,
    clear: clear,
    notify: notify,
    subscribe: subscribe,
    refresh: refresh,
    requiresSecureTransport: requiresSecureTransport,
    supports: supports,
    supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION
  };
})(window);
