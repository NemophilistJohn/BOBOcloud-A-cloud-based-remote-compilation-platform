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
      secureTransportRequired: normalizedTransport.http.scheme === 'https' || normalizedTransport.websocket.scheme === 'wss'
    };
  }

  function inspectServerInfo(response) {
    var data = response && isRecord(response.data) ? response.data : null;
    if (!data || !hasOwn(data, 'serverCapabilities')) return legacySnapshot();
    return normalizeDescriptor(data.serverCapabilities);
  }

  function applyServerInfo(response) {
    var snapshot = inspectServerInfo(response);
    if (BOBO.state) BOBO.state.serverCapabilities = snapshot;
    return snapshot;
  }

  function requiresSecureTransport(snapshot, settings) {
    return !!(snapshot && snapshot.secureTransportRequired && (!settings || settings.secureTransport !== true));
  }

  function supports(feature, snapshot) {
    snapshot = snapshot || (BOBO.state && BOBO.state.serverCapabilities) || legacySnapshot();
    if (snapshot.state === 'legacy') return true;
    if (snapshot.state !== 'compatible' || !snapshot.capabilities) return false;
    if (feature === 'lsp') return snapshot.capabilities.lsp.enabled;
    if (feature === 'dap') return snapshot.capabilities.dap.enabled;
    return snapshot.capabilities[feature] === true;
  }

  BOBO.serverCapabilities = {
    inspectServerInfo: inspectServerInfo,
    applyServerInfo: applyServerInfo,
    requiresSecureTransport: requiresSecureTransport,
    supports: supports,
    supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION
  };
})(window);
