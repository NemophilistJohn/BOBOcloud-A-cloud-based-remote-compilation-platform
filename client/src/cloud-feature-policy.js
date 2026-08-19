// src/cloud-feature-policy.js - Runtime policy for negotiated cloud features.
//
// A missing descriptor on a completed serverInfo response is represented by a
// legacy snapshot and remains allowed. A missing snapshot means negotiation has
// not completed and therefore fails closed until auth publishes a result.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var KNOWN_FEATURES = ['run', 'tasks', 'terminal', 'projectEnvironment', 'collaboration', 'lsp', 'dap'];

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function currentSnapshot(options) {
    if (options && hasOwn(options, 'snapshot')) return options.snapshot;
    return BOBO.state ? BOBO.state.serverCapabilities : null;
  }

  function canonicalLanguage(value) {
    var language = String(value || '').trim().toLowerCase();
    if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'js', 'ts', 'node'].indexOf(language) >= 0) return 'node';
    if (language === 'c++') return 'cpp';
    if (language === 'py') return 'python';
    return language;
  }

  function decision(feature, available, state, reason, language) {
    var result = {
      feature: feature,
      available: available === true,
      state: state || 'unknown',
      reason: reason || ''
    };
    if (language) result.language = language;
    return result;
  }

  function evaluate(feature, options) {
    var name = String(feature || '');
    var snapshot = currentSnapshot(options);
    var language = canonicalLanguage(options && options.language);

    if (KNOWN_FEATURES.indexOf(name) < 0) return decision(name, false, 'unknown', 'unknown_feature', language);
    if (!snapshot) return decision(name, false, 'unknown', 'not_negotiated', language);
    if (snapshot.state === 'legacy') return decision(name, true, 'legacy', '', language);
    if (snapshot.state !== 'compatible' || snapshot.compatible !== true || !snapshot.capabilities) {
      return decision(name, false, snapshot.state || 'incompatible', snapshot.reason || 'incompatible_server', language);
    }

    var capability = snapshot.capabilities[name];
    var enabled = name === 'lsp' || name === 'dap'
      ? !!(capability && capability.enabled === true)
      : capability === true;
    if (!enabled) return decision(name, false, 'compatible', 'feature_disabled', language);

    if (name === 'lsp' && language) {
      var languages = capability && Array.isArray(capability.languages) ? capability.languages : [];
      var supported = languages.some(function(item) { return canonicalLanguage(item) === language; });
      if (!supported) return decision(name, false, 'compatible', 'unsupported_language', language);
    }
    return decision(name, true, 'compatible', '', language);
  }

  function allows(feature, options) {
    return evaluate(feature, options).available;
  }

  function languages(snapshot) {
    snapshot = snapshot === undefined ? currentSnapshot() : snapshot;
    if (!snapshot || snapshot.state !== 'compatible' || !snapshot.capabilities || !snapshot.capabilities.lsp) return [];
    return (snapshot.capabilities.lsp.languages || []).map(function(language) {
      return String(language || '').trim().toLowerCase();
    }).filter(function(language, index, values) {
      return !!language && values.indexOf(language) === index;
    });
  }

  BOBO.cloudFeaturePolicy = {
    evaluate: evaluate,
    allows: allows,
    canonicalLanguage: canonicalLanguage,
    languages: languages
  };
})(window);
