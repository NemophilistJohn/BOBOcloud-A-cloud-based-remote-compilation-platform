// src/package-center.js - Project-scoped third-party library catalog and change workflow.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state || {};
  var initialized = false;
  var activeView = 'overview';
  var activeMode = 'discover';
  var activePane = 'browser';
  var context = null;
  var results = [];
  var cursor = '';
  var selectedPackage = null;
  var pendingChanges = [];
  var currentPlan = null;
  var busyOperation = null;
  var recoveryPending = null;
  var pendingContext = null;
  var contextResetPending = false;
  var returnFocusPackage = '';
  var manifestSelectionTouched = false;
  var refreshSequence = 0;
  var searchTimer = null;
  var activityUnsubscribe = null;
  var PACKAGE_QUERY_TIMEOUT_MS = 15000;
  var PACKAGE_PLAN_TIMEOUT_MS = 30000;
  var PACKAGE_APPLY_GRACE_MS = 30000;
  var PACKAGE_APPLY_RESPONSE_GRACE_MS = 5000;
  // Fallback for servers predating operationTimeoutSeconds.
  var PACKAGE_APPLY_TIMEOUT_MS = 10 * 60 * 1000;
  var DEFINITIVE_PACKAGE_APPLY_ERRORS = new Set([
    'package_storage_quota_exceeded',
    'package_operation_timeout',
    'package_operation_cancelled',
    'package_install_failed',
    'package_executor_unavailable',
    'package_cache_publish_failed',
    'package_plan_binding_mismatch',
    'package_plan_runtime_changed',
    'package_plan_workspace_changed',
    'package_plan_invalid'
  ]);

  var ICON_INSTALL = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 13.5v2h11v-2" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_UPDATE = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.5 6.5V3.8m0 0h-2.7m2.7 0A6.2 6.2 0 1 0 16 14" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_REMOVE = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 6h11M8 6V4.2h4V6M6.2 6l.6 9h6.4l.6-9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_SEARCH = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.5" stroke="currentColor" stroke-width="1.45"/><path d="m12 12 4 4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>';

  function t(source, replacements) {
    if (BOBO.i18n && typeof BOBO.i18n.t === 'function') return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  var LOCAL_PACKAGE_ERROR_KEYS = {
    PACKAGE_CHANGE_INVALID: 'The library plan contains an invalid dependency file change.',
    PACKAGE_CHANGE_SET_INVALID: 'The library plan contains an invalid dependency file change.',
    PACKAGE_CHANGE_DIGEST_INVALID: 'The library plan contains an invalid dependency file change.',
    PACKAGE_CHANGE_OLD_DIGEST_MISMATCH: 'The project changed before dependency files were updated.',
    PACKAGE_BINDING_DIGEST_MISMATCH: 'The project changed before dependency files were updated.',
    PACKAGE_WORKSPACE_MISSING: 'Open a workspace before managing libraries.',
    PACKAGE_WORKSPACE_STALE: 'The project changed while library changes were starting.',
    PACKAGE_WORKSPACE_TRANSITION: 'Wait for the library operation to finish before changing projects.',
    PACKAGE_TRANSACTION_INVALID: 'The dependency file transaction is invalid.',
    PACKAGE_TRANSACTION_NOT_FOUND: 'The dependency file transaction is no longer available.',
    invalid_package_operation: 'The requested library change is invalid.',
    package_catalog_check_limit_exceeded: 'The requested library change is invalid.',
    package_runtime_required: 'Select a cloud runtime before managing libraries.',
    package_catalog_request_invalid: 'The requested library change is invalid.',
    package_source_invalid: 'The requested library change is invalid.',
    package_source_not_equivalent: 'The requested library change is invalid.',
    package_not_found: 'The library was not found in the selected catalog.',
    package_catalog_timeout: 'The library catalog request timed out.',
    package_catalog_unavailable: 'The selected library catalog is unavailable.',
    package_compatible_version_not_found: 'No compatible stable library version is available for this runtime.',
    package_version_not_found: 'The selected library version was not found.',
    package_version_yanked: 'The selected library version has been withdrawn.',
    package_version_incompatible: 'The selected library version is incompatible with this runtime.',
    package_version_compatibility_unknown: 'The selected library version could not be verified for this runtime.',
    package_plan_unavailable: 'The library plan is no longer available. Refresh and try again.',
    package_plan_in_use: 'The library plan is still being processed. Retry shortly.',
    package_plan_binding_mismatch: 'The project changed after the library plan was created.',
    package_plan_runtime_changed: 'The project changed after the library plan was created.',
    package_plan_workspace_changed: 'The project changed after the library plan was created.',
    package_manifest_set_changed: 'The project changed after the library plan was created.',
    package_manifest_change_invalid: 'No safe library change plan is available.',
    package_declaration_conflict: 'No safe library change plan is available.',
    package_plan_invalid: 'The server returned an invalid library plan.',
    package_plan_reconciliation_required: 'The library installation status is still uncertain.',
    package_service_unavailable: 'Library management is unavailable on this server.',
    package_executor_unavailable: 'Library management is unavailable on this server.',
    package_completion_persistence_unavailable: 'The dependency file transaction could not be finalized.',
    package_cache_unavailable: 'The project library cache is unavailable.',
    package_cache_prepare_failed: 'The project library cache is unavailable.',
    package_cache_publish_failed: 'The project library cache is unavailable.',
    package_storage_quota_exceeded: 'The project library cache quota is full.',
    package_operation_timeout: 'The library installation timed out.',
    package_operation_cancelled: 'The library installation was cancelled.',
    package_install_failed: 'Library update failed.',
    package_inventory_mismatch: 'The installed library inventory could not be verified.',
    package_debug_session_active: 'Stop the active debug session before managing libraries.',
    package_workspace_busy: 'The project is busy. Retry shortly.'
  };

  function packageErrorLocale() {
    return BOBO.i18n && typeof BOBO.i18n.getActive === 'function' ? String(BOBO.i18n.getActive() || 'en') : 'en';
  }

  function localizedPackageError(value, fallback) {
    var envelope = value && typeof value === 'object' ? value : null;
    var nestedError = envelope && envelope.error && typeof envelope.error === 'object' ? envelope.error : null;
    var code = String(envelope && (envelope.code || envelope.errorCode) || nestedError && (nestedError.code || nestedError.errorCode) || '').trim();
    var stableKey = LOCAL_PACKAGE_ERROR_KEYS[code];
    if (!stableKey && /^PACKAGE_(?:CHANGE|PLAN|BINDING|REINSTALL|PUBLISHED|EDITOR)_/.test(code)) stableKey = 'The server returned an invalid library plan.';
    if (!stableKey && /^PACKAGE_TRANSACTION_/.test(code)) stableKey = fallback || 'The dependency file transaction could not be finalized.';
    if (!stableKey && /^PACKAGE_/.test(code)) stableKey = fallback || 'Library update failed.';
    if (!stableKey && /^package_/.test(code)) stableKey = fallback || 'Library update failed.';
    if (stableKey) return t(stableKey);
    if (envelope && envelope.success === false && packageErrorLocale().toLowerCase().indexOf('en') !== 0) return t(fallback || 'Library update failed.');
    var messageValue = envelope && envelope.error != null && !envelope.message ? envelope.error : value;
    var message = messageValue && typeof messageValue === 'object' ? messageValue.message : messageValue;
    message = String(message || '').trim()
      .replace(/^Error invoking remote method '[^']+':\s*/, '')
      .replace(/^Error:\s*/, '');
    return message ? t(message) : t(fallback || 'Unknown error');
  }

  function notifyToast(kind, message) {
    if (!BOBO.toast) return;
    var handler = BOBO.toast[kind] || (kind === 'warning' ? BOBO.toast.info : null);
    if (typeof handler === 'function') handler(message);
  }

  function waitFor(milliseconds) {
    return new Promise(function(resolve) { setTimeout(resolve, milliseconds); });
  }

  function packageOperationTimeoutMs(operationTimeoutSeconds) {
    var seconds = Number(operationTimeoutSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return PACKAGE_APPLY_TIMEOUT_MS;
    return Math.ceil(seconds * 1000);
  }

  function packageApplyTimeoutMs(operationTimeoutSeconds) {
    return packageOperationTimeoutMs(operationTimeoutSeconds) + PACKAGE_APPLY_GRACE_MS;
  }

  async function applyServerPlan(payload, options) {
    options = options || {};
    var response = null;
    var uncertainTransport = false;
    var transportRetries = 0;
    var operationTimeoutMs = packageOperationTimeoutMs(options.operationTimeoutSeconds);
    var totalTimeoutMs = operationTimeoutMs + PACKAGE_APPLY_GRACE_MS;
    var now = typeof options.now === 'function' ? options.now : Date.now;
    var sleep = typeof options.wait === 'function' ? options.wait : waitFor;
    var retryDeadline = now() + totalTimeoutMs;
    var followUp = options.followUp === true;
    var operationMayBePublished = followUp || options.operationMayBePublished === true;
    for (var attempt = 0; ; attempt += 1) {
      if (typeof options.canSend === 'function' && options.canSend() !== true) {
        return {
          success: false,
          error: t('Reconnect to the original server and account to verify this library operation.'),
          errorCode: 'package_apply_context_changed',
          uncertain: operationMayBePublished
        };
      }
      var remainingMs = Math.max(0, retryDeadline - now());
      if (followUp && remainingMs <= 0) return Object.assign({}, response || {}, { success: false, uncertain: operationMayBePublished });
      var requestTimeoutMs = followUp
        ? Math.min(PACKAGE_PLAN_TIMEOUT_MS, remainingMs)
        : Math.min(operationTimeoutMs + PACKAGE_APPLY_RESPONSE_GRACE_MS, remainingMs);
      response = await BOBO.sendToServer('applyProjectPackageChanges', payload, {
        quiet: true,
        timeoutMs: requestTimeoutMs
      });
      if (response && response.success !== false) return response;
      var inFlight = response && response.errorCode === 'package_plan_in_use';
      var reconciling = response && response.errorCode === 'package_plan_reconciliation_required';
      var planUnavailable = response && response.errorCode === 'package_plan_unavailable';
      var transportFailure = !response || response.errorCode === 'transport_timeout' || (!response.status && !response.errorCode);
      var definitiveFailure = response && DEFINITIVE_PACKAGE_APPLY_ERRORS.has(String(response.errorCode || ''));
      var ambiguousFailure = response && !inFlight && !reconciling && !planUnavailable && !transportFailure && !definitiveFailure;
      if (inFlight || reconciling || transportFailure || ambiguousFailure) operationMayBePublished = true;
      if (transportFailure || ambiguousFailure) {
        uncertainTransport = true;
        transportRetries += 1;
      }
      if (planUnavailable && operationMayBePublished) {
        return Object.assign({}, response, { success: false, uncertain: true });
      }
      var retryableUncertainty = transportFailure || ambiguousFailure;
      if (!inFlight && !reconciling && !(uncertainTransport && retryableUncertainty && transportRetries <= 2)) {
        // A structured plan-bound server error is definitive even if an earlier
        // transport attempt timed out. Only an in-flight/reconciliation state or
        // an unresolved transport failure can leave publication uncertain.
        return retryableUncertainty
          ? Object.assign({}, response || {}, { success: false, uncertain: operationMayBePublished })
          : response;
      }
      followUp = true;
      if (now() >= retryDeadline) return Object.assign({}, response || {}, { success: false, uncertain: operationMayBePublished });
      var retryAfterMs = Number(response && response.retryAfterSeconds) * 1000;
      var delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : Math.min(2000, 200 * Math.pow(1.55, attempt));
      delayMs = Math.min(delayMs, Math.max(0, retryDeadline - now()));
      await sleep(delayMs);
    }
  }

  function byId(id) { return global.document && global.document.getElementById(id); }

  function localTransactionApi() {
    return BOBO.packageCenterLocalApi || global.api || {};
  }

  function pathName(value) {
    var parts = String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function packageKey(name, language) {
    var value = String(name || '').trim().toLowerCase();
    var activeLanguage = String(language || context && context.language && context.language.id || '').toLowerCase();
    if (!activeLanguage && /^python(?::|$)/i.test(String(S.selectedRuntime || ''))) activeLanguage = 'python';
    return activeLanguage === 'python' ? value.replace(/[-_.]+/g, '-') : value;
  }

  function extractData(response) {
    if (!response) throw new Error(t('The library service did not return a response.'));
    if (response.success === false) {
      throw new Error(localizedPackageError(response, 'The library request failed.'));
    }
    return response.data || response.context || response.plan || response;
  }

  function normalizeSource(source, index) {
    source = source || {};
    return {
      id: String(source.id || source.sourceId || ('source-' + index)),
      label: String(source.label || source.displayName || source.name || source.id || t('Official')),
      kind: String(source.kind || 'official'),
      healthy: source.healthy !== false && source.status !== 'unavailable',
      latencyMs: Number(source.latencyMs || source.latency_ms || 0) || 0,
      equivalenceGroup: String(source.equivalenceGroup || source.equivalence_group || '')
    };
  }

  function normalizeInstalledPackages(raw) {
    var packages = raw && raw.packages || {};
    var installed = Array.isArray(packages.installed) ? packages.installed : (Array.isArray(raw && raw.installed) ? raw.installed : []);
    var declared = Array.isArray(packages.declared) ? packages.declared : (Array.isArray(raw && raw.declared) ? raw.declared : []);
    var manifests = Array.isArray(raw && raw.manifests) ? raw.manifests : [];
    var rawLanguage = typeof (raw && raw.language) === 'string' ? raw.language : raw && raw.language && raw.language.id;
    var hasManifestMetadata = manifests.length > 0;
    var managedManifests = new Set(manifests.filter(function(item) {
      return item && item.kind !== 'source-imports' && item.path;
    }).map(function(item) { return String(item.path).replace(/\\/g, '/').toLowerCase(); }));
    var missingByName = Object.create(null);
    var unknownByName = Object.create(null);
    (Array.isArray(packages.missing) ? packages.missing : []).forEach(function(item) {
      if (item && item.name) missingByName[packageKey(item.name, rawLanguage)] = item;
    });
    (Array.isArray(packages.unknown) ? packages.unknown : []).forEach(function(item) {
      if (item && item.name) unknownByName[packageKey(item.name, rawLanguage)] = item;
    });
    var declaredByName = Object.create(null);
    declared.forEach(function(item) {
      if (!item || !item.name) return;
      var sources = String(item.source || '').split(/,\s*/).map(function(value) {
        return value.trim().replace(/\\/g, '/').toLowerCase();
      }).filter(Boolean);
      if (hasManifestMetadata && !sources.some(function(source) { return managedManifests.has(source); })) return;
      declaredByName[packageKey(item.name, rawLanguage)] = item;
    });
    function declaredVersion(item) {
      if (!item) return '';
      if (item.version) return String(item.version);
      var exact = String(item.constraint || '').match(/^\s*==\s*([^,;\s]+)\s*$/);
      return exact ? exact[1] : '';
    }
    var seen = Object.create(null);
    var result = installed.map(function(item) {
      item = item || {};
      var key = packageKey(item.name, rawLanguage);
      var declaration = declaredByName[key] || null;
      var inventoryState = missingByName[key] ? 'mismatch' : (unknownByName[key] ? 'unknown' : 'ready');
      seen[key] = true;
      return Object.assign({}, item, {
        name: String(item.name || item.module || ''),
        version: String(item.version || declaredVersion(declaration)),
        constraint: String(declaration && declaration.constraint || ''),
        direct: Boolean(declaration) || item.direct === true || item.relationship === 'direct',
        declaration: declaration,
        scope: String(item.scope || declaration && declaration.scope || 'runtime'),
        inventoryPresent: true,
        inventoryState: inventoryState
      });
    }).filter(function(item) { return Boolean(item.name); });
    Object.keys(declaredByName).forEach(function(key) {
      if (seen[key]) return;
      var declaration = declaredByName[key];
      result.push({
        name: String(declaration.name || ''),
        version: declaredVersion(declaration),
        constraint: String(declaration.constraint || ''),
        direct: true,
        declaration: declaration,
        scope: String(declaration.scope || 'runtime'),
        inventoryPresent: false,
        inventoryState: missingByName[key] ? 'missing' : 'unknown',
        trust: String(declaration.trust || '')
      });
    });
    return result;
  }

  function capabilityReasonLabel(reason) {
    reason = String(reason || '');
    if (['package-center-disabled', 'package-catalog-unavailable', 'project-lock-cache-required', 'environment-setup-unavailable'].includes(reason)) {
      return t('Library management is unavailable on this server.');
    }
    if (['team-workspace-unsupported', 'ecosystem-unsupported'].includes(reason)) {
      return t('Library management is unavailable for this project.');
    }
    if (reason === 'managed-runtime-required') return t('Select a cloud runtime before managing libraries.');
    return reason;
  }

  function normalizeContext(raw, environmentSnapshot) {
    raw = raw || {};
    environmentSnapshot = environmentSnapshot || {};
    var sources = (Array.isArray(raw.sources) ? raw.sources : []).map(normalizeSource);
    if (!sources.length && raw.source) sources.push(normalizeSource(raw.source, 0));
    var manifests = Array.isArray(raw.manifests) ? raw.manifests : (environmentSnapshot.manifests || []);
    var inventory = raw.inventory || {};
    var language = raw.language || environmentSnapshot.language || {};
    var runtime = raw.runtime || environmentSnapshot.runtime || {};
    var workspace = raw.workspace || environmentSnapshot.workspace || {};
    var planCapability = raw.canPlanChanges || raw.capabilities && raw.capabilities.canPlanChanges || {};
    var supported = raw.supported !== false && planCapability.supported !== false;
    if (!S.workspaceRoot || !S.selectedRuntime) supported = false;
    return {
      schema: String(raw.schema || 'package-center-context/v1'),
      revision: String(raw.revision || environmentSnapshot.revision || ''),
      supported: supported,
      reason: capabilityReasonLabel(raw.reason || planCapability.reason) || (!S.workspaceRoot ? t('Open a workspace before managing libraries.') : (!S.selectedRuntime ? t('Select a cloud runtime before managing libraries.') : '')),
      workspace: workspace,
      language: typeof language === 'string' ? { id: language } : language,
      runtime: typeof runtime === 'string' ? { id: runtime } : runtime,
      sources: sources,
      selectedSourceId: String(raw.selectedSourceId || raw.sourceId || (typeof raw.defaultSource === 'string' ? raw.defaultSource : raw.defaultSource && raw.defaultSource.id) || raw.source && (raw.source.id || raw.source.sourceId) || sources[0] && sources[0].id || ''),
      searchMode: String(raw.searchMode || 'exact'),
      manifests: manifests.filter(Boolean),
      defaultManifestPath: String(raw.defaultManifestPath || raw.manifestPath || ''),
      packages: raw.packages || {},
      installed: normalizeInstalledPackages(raw),
      missing: Array.isArray(raw.packages && raw.packages.missing) ? raw.packages.missing : (environmentSnapshot.packages && environmentSnapshot.packages.missing || []),
      inventory: inventory,
      inventoryExact: inventory.exact === true || inventory.trust === 'exact' || raw.inventoryExact === true,
      operationTimeoutSeconds: Number(raw.operationTimeoutSeconds) > 0 ? Number(raw.operationTimeoutSeconds) : 600,
      capabilities: raw.capabilities || {}
    };
  }

  function normalizeCompatibility(value) {
    value = String(value || '').toLowerCase().replace(/_/g, '-');
    if (value === 'compatible' || value === 'metadata-compatible' || value === 'ready' || value === 'supported') return 'compatible';
    if (value === 'build-required' || value === 'source-build' || value === 'build') return 'build-required';
    if (value === 'incompatible' || value === 'unsupported') return 'incompatible';
    return 'unknown';
  }

  function normalizePackageVersions(item, includePrerelease) {
    item = item || {};
    var rawVersions = item.raw && (item.raw.versions || item.raw.availableVersions) || [];
    var versions = rawVersions.map(function(version) { return typeof version === 'string' ? { version: version } : (version || {}); });
    if (item.version && !versions.some(function(version) { return String(version.version || '') === String(item.version); })) {
      versions.unshift({ version: item.version, compatibility: item.compatibility, reason: item.compatibilityReason });
    }
    return versions.map(function(version) {
      var value = String(version.version || '');
      var rawCompatibility = version.compatibility;
      var compatibility = normalizeCompatibility(rawCompatibility && (rawCompatibility.status || rawCompatibility));
      var reason = String(rawCompatibility && rawCompatibility.reason || version.reason || '');
      if (!rawCompatibility && value === String(item.version || '')) {
        compatibility = normalizeCompatibility(item.compatibility);
        reason = reason || String(item.compatibilityReason || '');
      }
      return Object.assign({}, version, { version: value, compatibility: compatibility, compatibilityReason: reason });
    }).filter(function(version) {
      if (!version.version) return false;
      var prereleaseVersion = version.prerelease === true || /(?:a|b|rc|dev|alpha|beta|pre|preview)\d*(?:[.+-]|$)/i.test(version.version);
      return includePrerelease || !prereleaseVersion;
    });
  }

  function isSelectablePackageVersion(version) {
    return Boolean(version && version.version) && version.yanked !== true && normalizeCompatibility(version.compatibility) !== 'incompatible';
  }

  function preferredPackageVersion(versions, itemVersion, previous) {
    versions = Array.isArray(versions) ? versions : [];
    var selectable = versions.filter(isSelectablePackageVersion);
    var compatibilityOrder = ['compatible', 'build-required', 'unknown'];
    for (var compatibility of compatibilityOrder) {
      var candidates = selectable.filter(function(version) { return normalizeCompatibility(version.compatibility) === compatibility; });
      for (var candidate of [previous, itemVersion]) {
        var match = candidates.find(function(version) { return String(version.version) === String(candidate || ''); });
        if (match) return match.version;
      }
      if (candidates.length) return candidates[0].version;
    }
    return '';
  }

  function resolvedRuntimeVersion(runtime) {
    runtime = runtime || {};
    var values = [
      runtime.interpreterVersion,
      runtime.resolvedVersion,
      runtime.languageVersion,
      runtime.actualVersion,
      runtime.patchVersion,
      runtime.version
    ].map(function(value) { return String(value || '').trim().replace(/^v/i, ''); }).filter(Boolean);
    return values.find(function(value) { return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value); }) || values[0] || '';
  }

  function runtimeDisplayLabel(runtime, language) {
    runtime = runtime || {};
    language = language || {};
    var version = resolvedRuntimeVersion(runtime);
    var languageId = String(language.id || runtime.language || '').trim().toLowerCase();
    var configuredVersion = String(runtime.version || '').trim();
    var runtimeName = String(runtime.displayName || '').trim();
    if (runtimeName && configuredVersion) {
      var escapedVersion = configuredVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      runtimeName = runtimeName.replace(new RegExp('\\s+' + escapedVersion + '$', 'i'), '').trim();
    }
    var knownNames = { python: 'Python', node: 'Node.js', javascript: 'Node.js', java: 'Java', go: 'Go', rust: 'Rust', c: 'C', cpp: 'C++' };
    var languageName = String(runtimeName || language.displayName || language.name || knownNames[languageId] || runtime.language || language.id || '').trim();
    if (!languageName) return String(runtime.displayName || runtime.id || '');
    if (!version) return String(runtime.displayName || languageName || runtime.id || '');
    return languageName + ' ' + version;
  }

  function normalizeResult(item) {
    item = item || {};
    var compatibility = item.compatibility || {};
    return {
      name: String(item.name || item.id || item.package || ''),
      summary: String(item.summary || item.description || ''),
      version: String(item.recommendedVersion || item.latestVersion || item.version || ''),
      installedVersion: String(item.installedVersion || ''),
      compatibility: normalizeCompatibility(typeof compatibility === 'string' ? compatibility : compatibility.status || item.compatibilityStatus),
      compatibilityReason: String(typeof compatibility === 'object' && compatibility.reason || item.compatibilityReason || ''),
      projectCached: item.projectCached === true,
      direct: item.direct === true,
      inventoryPresent: item.inventoryPresent !== false,
      inventoryState: String(item.inventoryState || ''),
      declaration: item.declaration || null,
      constraint: String(item.constraint || ''),
      scope: String(item.scope || item.raw && item.raw.scope || 'runtime'),
      raw: item
    };
  }

  function mergeInstalledState(item, installedPackages) {
    item = normalizeResult(item && item.raw ? item.raw : item);
    var installed = (installedPackages || []).find(function(candidate) {
      return packageKey(candidate && candidate.name) === packageKey(item.name);
    });
    if (!installed) return item;
    return Object.assign({}, item, {
      installedVersion: String(installed.version || ''),
      direct: installed.direct === true,
      projectCached: installed.inventoryPresent !== false && Boolean(installed.version) && String(installed.version) === String(item.version),
      inventoryPresent: installed.inventoryPresent !== false,
      inventoryState: String(installed.inventoryState || ''),
      declaration: installed.declaration || null,
      constraint: String(installed.constraint || ''),
      scope: installed.scope || 'runtime',
      raw: Object.assign({}, item.raw || {}, {
        scope: installed.scope || 'runtime',
        direct: installed.direct === true,
        installedVersion: String(installed.version || ''),
        inventoryPresent: installed.inventoryPresent !== false,
        inventoryState: String(installed.inventoryState || ''),
        declaration: installed.declaration || null,
        constraint: String(installed.constraint || '')
      })
    });
  }

  function normalizeResults(raw) {
    raw = raw || {};
    var items = Array.isArray(raw) ? raw : (raw.items || raw.results || raw.packages || []);
    return {
      items: (Array.isArray(items) ? items : []).map(normalizeResult).filter(function(item) { return Boolean(item.name); }),
      cursor: String(raw.nextCursor || raw.cursor || '')
    };
  }

  function upsertChange(changes, change) {
    var next = (Array.isArray(changes) ? changes : []).filter(function(item) { return packageKey(item.name) !== packageKey(change && change.name); });
    if (change && change.name) next.push(Object.assign({}, change));
    return next;
  }

  function removeChange(changes, name) {
    return (Array.isArray(changes) ? changes : []).filter(function(item) { return packageKey(item.name) !== packageKey(name); });
  }

  function currentRequestContext(extra) {
    var base = BOBO.environmentCenter && typeof BOBO.environmentCenter.getRequestContext === 'function'
      ? BOBO.environmentCenter.getRequestContext()
      : { folderName: pathName(S.workspaceRoot), folderKey: BOBO.projectKey ? BOBO.projectKey(S.workspaceRoot || '') : '', runtime: S.selectedRuntime || '' };
    var source = byId('package-source-select');
    var manifest = byId('package-manifest-select');
    return Object.assign({}, base, {
      revision: context && context.revision || '',
      sourceId: source && source.value || context && context.selectedSourceId || '',
      manifestPath: manifest && manifest.value || context && context.defaultManifestPath || ''
    }, extra || {});
  }

  function captureOperationContext() {
    return {
      workspaceRoot: String(S.workspaceRoot || ''),
      workspaceIdentity: S.workspaceIdentity == null ? null : S.workspaceIdentity,
      workspaceGeneration: Number(S.workspaceGeneration || 0),
      authEpoch: Number(S.runIdentityEpoch || 0),
      runtime: String(S.selectedRuntime || ''),
      serverId: stableServerIdentity(),
      userId: stableUserIdentity()
    };
  }

  function stableServerIdentity(state) {
    state = state || S;
    var settings = state.serverSettings || {};
    var fingerprints = Array.isArray(settings.certificateFingerprints)
      ? settings.certificateFingerprints.slice()
      : [settings.certificateFingerprint || ''];
    fingerprints = fingerprints.map(function(value) { return String(value || '').trim().toLowerCase(); })
      .filter(Boolean).sort();
    return JSON.stringify([
      settings.secureTransport === true ? 'https' : 'http',
      String(settings.ip || '').trim().toLowerCase(),
      Number(settings.httpPort) || 3100,
      String(settings.user || '').trim(),
      fingerprints
    ]);
  }

  function stableUserIdentity(state) {
    state = state || S;
    var auth = state.auth || {};
    var mode = String(auth.mode || 'unknown');
    if (mode === 'single') return 'single';
    var user = auth.user || {};
    var id = user.uid || user.id || user.userId || user.username || '';
    if (mode === 'multi') return id ? 'multi:' + String(id) : '';
    return id ? mode + ':' + String(id) : mode;
  }

  function stableIdentityState(value, state) {
    state = state || S;
    if (!value || value.serverId !== stableServerIdentity(state)) return 'different';
    var currentUserId = stableUserIdentity(state);
    if (!currentUserId) return 'unavailable';
    return value.userId === currentUserId ? 'same' : 'different';
  }

  function workspaceLocationMatches(value, state) {
    state = state || S;
    return Boolean(value) && String(state.workspaceRoot || '') === value.workspaceRoot &&
      state.workspaceIdentity === value.workspaceIdentity && Number(state.workspaceGeneration || 0) === value.workspaceGeneration;
  }

  function rebindOperationContext(value, options, state) {
    options = options || {};
    state = state || S;
    if (!workspaceLocationMatches(value, state) || stableIdentityState(value, state) !== 'same') return null;
    if (options.runtime === true && String(state.selectedRuntime || '') !== value.runtime) return null;
    return Object.assign({}, value, { authEpoch: Number(state.runIdentityEpoch || 0) });
  }

  function operationContextMatches(value) {
    return workspaceLocationMatches(value) && stableIdentityState(value) === 'same' &&
      Number(S.runIdentityEpoch || 0) === value.authEpoch && String(S.selectedRuntime || '') === value.runtime;
  }

  function workspaceContextMatches(value) {
    return workspaceLocationMatches(value) && stableIdentityState(value) === 'same' &&
      Number(S.runIdentityEpoch || 0) === value.authEpoch;
  }

  function setCenterState(state, label) {
    var element = byId('package-center-state');
    var copy = byId('package-center-state-label');
    if (element) element.dataset.state = state || '';
    if (copy) copy.textContent = label || '';
  }

  function setOperation(stage, label, options) {
    options = options || {};
    var view = byId('package-center-view');
    var status = byId('package-operation-status');
    var copy = byId('package-operation-label');
    var retry = byId('package-operation-retry');
    if (view) view.setAttribute('aria-busy', busyOperation ? 'true' : 'false');
    if (status) {
      status.hidden = !label;
      status.dataset.state = stage || '';
      status.title = label || '';
    }
    if (copy) {
      copy.textContent = label || '';
      copy.title = label || '';
    }
    if (retry) retry.hidden = !options.retry;
    renderDock();
  }

  function setPane(name) {
    activePane = name || 'browser';
    ['browser', 'detail'].forEach(function(value) {
      var element = byId('package-center-' + value);
      if (element) element.hidden = value !== activePane;
    });
  }

  function focusSoon(id) {
    setTimeout(function() { var element = byId(id); if (element && !element.hidden) element.focus(); }, 0);
  }

  function returnToBrowser() {
    setPane('browser');
    var packageName = returnFocusPackage;
    setTimeout(function() {
      var rows = global.document && global.document.querySelectorAll('.package-row');
      for (var index = 0; rows && index < rows.length; index += 1) {
        if (packageKey(rows[index].dataset.packageName) !== packageKey(packageName)) continue;
        var target = rows[index].querySelector('.package-row-main');
        if (target) target.focus();
        return;
      }
      var fallback = byId(activeMode === 'installed' ? 'package-mode-installed' : 'package-mode-discover');
      if (fallback) fallback.focus();
    }, 0);
  }

  function setActiveView(name, options) {
    activeView = name === 'packages' ? 'packages' : 'overview';
    var overview = byId('environment-overview-view');
    var packages = byId('package-center-view');
    var overviewTab = byId('environment-tab-overview');
    var packageTab = byId('environment-tab-packages');
    if (overview) overview.hidden = activeView !== 'overview';
    if (packages) packages.hidden = activeView !== 'packages';
    if (overviewTab) {
      overviewTab.setAttribute('aria-selected', activeView === 'overview' ? 'true' : 'false');
      overviewTab.tabIndex = activeView === 'overview' ? 0 : -1;
    }
    if (packageTab) {
      packageTab.setAttribute('aria-selected', activeView === 'packages' ? 'true' : 'false');
      packageTab.tabIndex = activeView === 'packages' ? 0 : -1;
    }
    if (activeView === 'packages') {
      if (options && options.query) {
        var input = byId('package-search-input');
        if (input) input.value = String(options.query);
      }
      refreshContext({ loading: !context, search: true });
    }
  }

  function setActiveMode(name) {
    activeMode = name === 'installed' ? 'installed' : 'discover';
    ['discover', 'installed'].forEach(function(value) {
      var button = byId('package-mode-' + value);
      if (button) {
        button.setAttribute('aria-selected', activeMode === value ? 'true' : 'false');
        button.tabIndex = activeMode === value ? 0 : -1;
      }
    });
    setPane('browser');
    renderBrowser();
    if (activeMode === 'discover') scheduleSearch(0);
  }

  function renderSources() {
    var select = byId('package-source-select');
    if (!select) return;
    var previous = select.value;
    select.textContent = '';
    (context && context.sources || []).forEach(function(source) {
      var option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.label;
      option.disabled = source.healthy === false;
      option.title = source.kind === 'mirror' ? t('Verified mirror') : t('Official catalog');
      select.appendChild(option);
    });
    var available = context && context.sources || [];
    var selected = previous && available.some(function(source) { return source.id === previous; }) ? previous : context && context.selectedSourceId;
    if (selected) select.value = selected;
    select.disabled = !context || !context.sources.length || Boolean(busyOperation) || Boolean(recoveryPending);
  }

  function editableManifests() {
    var manifests = context && context.manifests || [];
    return manifests.filter(function(item) {
      if (!item || item.writable === false || item.lockfile === true) return false;
      if (item.editable === true) return true;
      var language = String(context && context.language && context.language.id || '');
      if (language === 'python') return item.manager === 'pip' || /requirements(?:[-_.][^/]*)?\.txt$/i.test(String(item.path || ''));
      return item.manifest !== false;
    });
  }

  function renderManifests() {
    var select = byId('package-manifest-select');
    if (!select) return;
    var previous = select.value;
    var manifests = editableManifests();
    select.textContent = '';
    manifests.forEach(function(item) {
      var option = document.createElement('option');
      option.value = String(item.path || '');
      option.textContent = String(item.path || '');
      select.appendChild(option);
    });
    if (!manifests.length && String(context && context.language && context.language.id || '') === 'python') {
      var create = document.createElement('option');
      create.value = 'requirements.txt';
      create.textContent = t('Create requirements.txt');
      select.appendChild(create);
    }
    var optionExists = function(value) {
      return Boolean(value) && Array.prototype.some.call(select.options, function(option) { return option.value === value; });
    };
    var defaultPath = String(context && context.defaultManifestPath || '');
    var preferred = manifestSelectionTouched && optionExists(previous)
      ? previous
      : (optionExists(defaultPath) ? defaultPath : (manifests.length ? String(manifests[0].path || '') : 'requirements.txt'));
    if (preferred) select.value = preferred;
    select.disabled = select.options.length <= 1 || Boolean(busyOperation) || Boolean(recoveryPending);
    select.title = select.options.length ? t('Dependency file') : t('No editable dependency file');
  }

  function compatibilityLabel(value) {
    return {
      compatible: t('Compatible'),
      'build-required': t('Source build required'),
      incompatible: t('Incompatible'),
      unknown: t('Compatibility unknown')
    }[normalizeCompatibility(value)] || t('Compatibility unknown');
  }

  function iconButton(icon, title, className, replacements) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'package-icon-button package-row-action' + (className ? ' ' + className : '');
    button.innerHTML = icon;
    button.title = t(title, replacements);
    button.setAttribute('aria-label', t(title, replacements));
    return button;
  }

  function openDetails(item) {
    selectedPackage = normalizeResult(item && item.raw ? item.raw : item);
    returnFocusPackage = selectedPackage.name;
    setPane('detail');
    renderDetails(selectedPackage);
    loadDetails(selectedPackage.name);
    focusSoon('package-detail-back');
  }

  async function searchSuggestion(item) {
    var input = byId('package-search-input');
    if (!input || !item || !item.name) return;
    if (activeMode !== 'discover') setActiveMode('discover');
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    input.value = item.name;
    var found = await searchPackages();
    var match = found.find(function(candidate) { return packageKey(candidate.name) === packageKey(item.name); });
    if (match) openDetails(match);
  }

  function createPackageRow(item, installedMode, suggestionMode) {
    item = installedMode
      ? normalizeResult(Object.assign({}, item, {
        installedVersion: item.version,
        version: item.version,
        projectCached: item.inventoryPresent !== false
      }))
      : mergeInstalledState(item, context && context.installed || []);
    var row = document.createElement('div');
    row.className = 'package-row';
    row.setAttribute('role', 'listitem');
    row.dataset.packageName = item.name;

    var main = document.createElement('div');
    main.className = 'package-row-main';
    main.tabIndex = 0;
    main.setAttribute('role', 'button');
    main.setAttribute('aria-label', t('Open details for {name}', { name: item.name }));
    var name = document.createElement('span');
    name.className = 'package-row-name';
    var strong = document.createElement('strong');
    strong.textContent = item.name;
    var version = document.createElement('small');
    version.textContent = item.installedVersion || item.version || item.constraint || '';
    name.appendChild(strong);
    name.appendChild(version);
    var summary = document.createElement('span');
    summary.className = 'package-row-summary';
    summary.textContent = installedMode
      ? (item.inventoryPresent === false ? t('Declared dependency') : (item.direct ? t('Direct dependency') : t('Transitive dependency')))
      : (item.summary || t('No description available'));
    var meta = document.createElement('span');
    meta.className = 'package-row-meta';
    meta.dataset.compatibility = item.compatibility;
    meta.textContent = installedMode
      ? [item.scope || item.raw.scope || '', item.inventoryPresent === false
        ? (item.inventoryState === 'missing' ? t('Missing from project cache') : t('Inventory verification required'))
        : (item.inventoryState === 'mismatch' ? t('Declared version mismatch') : (item.projectCached ? t('Cached for this project') : ''))].filter(Boolean).join(' · ')
      : [compatibilityLabel(item.compatibility), item.projectCached ? t('Cached for this project') : ''].filter(Boolean).join(' · ');
    main.appendChild(name);
    main.appendChild(summary);
    main.appendChild(meta);
    var activate = suggestionMode ? function() { searchSuggestion(item); } : function() { openDetails(item); };
    main.addEventListener('click', activate);
    main.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    });
    row.appendChild(main);

    var actions = document.createElement('div');
    actions.className = 'package-row-actions';
    if (suggestionMode) {
      var search = iconButton(ICON_SEARCH, 'Search exact package name', 'package-search-suggestion');
      search.addEventListener('click', function(event) {
        event.stopPropagation();
        searchSuggestion(item);
      });
      actions.appendChild(search);
    } else if (installedMode) {
      if (item.direct && (item.inventoryPresent === false || item.inventoryState === 'mismatch')) {
        var repair = iconButton(ICON_UPDATE, 'Repair {name}', 'package-repair', { name: item.name });
        repair.disabled = !context || context.supported !== true || Boolean(busyOperation) || Boolean(recoveryPending);
        repair.addEventListener('click', function(event) {
          event.stopPropagation();
          runPackageAction(item, { operation: 'update', version: item.version });
        });
        actions.appendChild(repair);
      }
      var remove = iconButton(ICON_REMOVE, 'Remove {name}', 'package-remove', { name: item.name });
      var removalInventoryReady = context && (context.inventoryExact === true || item.inventoryState === 'missing');
      remove.disabled = !item.direct || !context || context.supported !== true || !removalInventoryReady || Boolean(busyOperation) || Boolean(recoveryPending);
      if (!item.direct) remove.title = t('Transitive dependencies are managed by their direct dependency.');
      else if (!removalInventoryReady) remove.title = t('Exact package inventory is required before removal.');
      remove.addEventListener('click', function(event) {
        event.stopPropagation();
        runPackageAction(item, { operation: 'remove' });
      });
      actions.appendChild(remove);
    } else {
      var sameInstalled = item.direct && item.inventoryPresent !== false && String(item.installedVersion || '') === String(item.version || '');
      var repairRequired = sameInstalled && item.inventoryState === 'missing';
      var actionTitle = repairRequired
        ? 'Repair {name}'
        : (item.installedVersion && !item.direct ? 'Pin {name} as a direct dependency' : (item.direct ? 'Update {name}' : 'Install {name}'));
      var actionIcon = repairRequired || item.direct ? ICON_UPDATE : ICON_INSTALL;
      var add = iconButton(actionIcon, sameInstalled && !repairRequired ? 'Already installed' : actionTitle, 'package-install', { name: item.name });
      add.dataset.operation = repairRequired ? 'repair' : (item.direct ? 'update' : 'install');
      add.disabled = !context || context.supported !== true || item.compatibility === 'incompatible' || (sameInstalled && !repairRequired) || Boolean(busyOperation) || Boolean(recoveryPending);
      add.addEventListener('click', function(event) {
        event.stopPropagation();
        runPackageAction(item, { operation: item.direct ? 'update' : 'add' });
      });
      actions.appendChild(add);
    }
    row.appendChild(actions);
    return row;
  }

  function renderSuggestions() {
    var section = byId('package-suggestions-section');
    var list = byId('package-suggestions-list');
    var count = byId('package-suggestions-count');
    var missing = context && context.missing || [];
    if (section) section.hidden = activeMode !== 'discover' || missing.length === 0 || Boolean((byId('package-search-input') || {}).value);
    if (count) count.textContent = String(missing.length);
    if (!list) return;
    list.textContent = '';
    missing.forEach(function(item) {
      var normalized = normalizeResult({ name: item.name, summary: item.reason || item.source || '', version: item.constraint || '', compatibility: 'unknown' });
      list.appendChild(createPackageRow(normalized, false, true));
    });
  }

  function renderBrowser() {
    var list = byId('package-results-list');
    var empty = byId('package-results-empty');
    var more = byId('package-load-more');
    var values = activeMode === 'installed' ? context && context.installed || [] : results;
    if (list) {
      list.textContent = '';
      values.forEach(function(item) { list.appendChild(createPackageRow(item, activeMode === 'installed')); });
    }
    if (empty) {
      var waitingForExactQuery = activeMode === 'discover' && context && context.searchMode === 'exact' && !String((byId('package-search-input') || {}).value || '').trim();
      empty.hidden = values.length > 0 || waitingForExactQuery;
      var strong = empty.querySelector('strong');
      var copy = empty.querySelector('span');
      if (strong) strong.textContent = activeMode === 'installed' ? t('No installed libraries') : t('No libraries found');
      if (copy) copy.textContent = activeMode === 'installed' ? t('This project has no verified installed libraries.') : t('Try another name, version, or download source.');
    }
    if (more) more.hidden = activeMode !== 'discover' || !cursor;
    renderSuggestions();
  }

  function renderContext() {
    var project = byId('package-context-project');
    var runtime = byId('package-context-runtime');
    if (project) project.textContent = context && context.workspace && (context.workspace.name || context.workspace.id) || pathName(S.workspaceRoot) || '--';
    if (runtime) {
      var runtimeLabel = context && runtimeDisplayLabel(context.runtime, context.language) || S.selectedRuntime || t('No runtime selected');
      runtime.textContent = runtimeLabel;
      runtime.title = context && context.supported === true
        ? t('Libraries automatically match {runtime}.', { runtime: runtimeLabel })
        : runtimeLabel;
    }
    var installedCount = byId('package-installed-count');
    if (installedCount) installedCount.textContent = String(context && context.installed.length || 0);
    renderSources();
    renderManifests();
    if (!context || context.supported !== true) setCenterState('warning', context && context.reason || t('Library management is unavailable for this project.'));
    else setCenterState('ready', t('Libraries are scoped to this project and dependency lock.'));
    renderBrowser();
    renderDock();
  }

  async function refreshContext(options) {
    options = options || {};
    if (activeView !== 'packages' && options.force !== true) return context;
    var sequence = ++refreshSequence;
    if (!S.workspaceRoot) {
      context = normalizeContext({}, null);
      renderContext();
      return context;
    }
    if (options.loading !== false) setCenterState('loading', t('Loading library environment...'));
    try {
      var environmentSnapshot = BOBO.environmentCenter && BOBO.environmentCenter.getSnapshot ? BOBO.environmentCenter.getSnapshot() : null;
      var response = await BOBO.sendToServer('getPackageCenterContext', currentRequestContext(), {
        quiet: true,
        timeoutMs: PACKAGE_QUERY_TIMEOUT_MS
      });
      if (sequence !== refreshSequence) return null;
      context = normalizeContext(extractData(response), environmentSnapshot);
      renderContext();
      if (options.search !== false && activeMode === 'discover') scheduleSearch(0);
      return context;
    } catch (error) {
      if (sequence !== refreshSequence) return null;
      context = normalizeContext({ supported: false, reason: localizedPackageError(error, 'Library management is unavailable on this server.') }, BOBO.environmentCenter && BOBO.environmentCenter.getSnapshot ? BOBO.environmentCenter.getSnapshot() : null);
      renderContext();
      setCenterState('error', context.reason);
      return context;
    }
  }

  async function searchPackages(options) {
    options = options || {};
    if (activeView !== 'packages' || activeMode !== 'discover' || !context || context.supported !== true || busyOperation) return [];
    var sequence = ++refreshSequence;
    var input = byId('package-search-input');
    var query = String(input && input.value || '').trim();
    if (byId('package-search-clear')) byId('package-search-clear').hidden = !query;
    if (context.searchMode === 'exact' && !query) {
      refreshSequence += 1;
      results = [];
      cursor = '';
      setCenterState('ready', t('Enter an exact package name to search.'));
      renderBrowser();
      return [];
    }
    setCenterState('loading', query ? t('Searching libraries...') : t('Loading compatible libraries...'));
    try {
      var response = await BOBO.sendToServer('searchPackageCatalog', currentRequestContext({ query: query, cursor: options.append ? cursor : '' }), {
        quiet: true,
        timeoutMs: PACKAGE_QUERY_TIMEOUT_MS
      });
      if (sequence !== refreshSequence) return [];
      var normalized = normalizeResults(extractData(response));
      results = options.append ? results.concat(normalized.items) : normalized.items;
      cursor = normalized.cursor;
      setCenterState('ready', results.length === 1
        ? t('1 library result')
        : t('{count} library results', { count: results.length }));
      renderBrowser();
      return results;
    } catch (error) {
      if (sequence !== refreshSequence) return [];
      if (!options.append) results = [];
      cursor = '';
      setCenterState('error', localizedPackageError(error, 'Library search failed.'));
      renderBrowser();
      return [];
    }
  }

  function scheduleSearch(delay) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function() { searchTimer = null; searchPackages(); }, Math.max(0, Number(delay == null ? 260 : delay)));
  }

  async function fetchPackageDetails(name, seed) {
    var response = await BOBO.sendToServer('getPackageCatalogItem', currentRequestContext({ packageName: name }), {
      quiet: true,
      timeoutMs: PACKAGE_QUERY_TIMEOUT_MS
    });
    return mergeInstalledState(normalizeResult(Object.assign({}, seed && seed.raw || seed || {}, extractData(response))), context && context.installed || []);
  }

  function automaticPackageVersion(item) {
    item = normalizeResult(item && item.raw ? item.raw : item);
    return preferredPackageVersion(normalizePackageVersions(item, false), item.version, '');
  }

  async function runPackageAction(item, options) {
    options = options || {};
    if (busyOperation || !item || !item.name || !context || context.supported !== true) return false;
    if (recoveryPending && !await retryRecovery()) return false;

    var operation = String(options.operation || (item.direct ? 'update' : 'add'));
    var operationContext = captureOperationContext();
    if (operation === 'remove' && BOBO.confirm) {
      var confirmed = await BOBO.confirm({
        title: t('Remove {name}?', { name: item.name }),
        message: t('This removes {name} from the project dependency file and rebuilds the project environment.', { name: item.name }),
        confirmLabel: t('Remove'),
        danger: true
      });
      if (!confirmed || !operationContextMatches(operationContext)) return false;
    }

    var resolvedItem = normalizeResult(item && item.raw ? item.raw : item);
    var version = String(options.version || '');
    if (operation !== 'remove' && !version) {
      busyOperation = { context: operationContext, stage: 'catalog' };
      var runtimeLabel = runtimeDisplayLabel(context.runtime, context.language) || S.selectedRuntime || t('No runtime selected');
      setOperation('loading', t('Finding the best version for {runtime}...', { runtime: runtimeLabel }));
      try {
        resolvedItem = await fetchPackageDetails(item.name, resolvedItem);
        if (!operationContextMatches(operationContext)) throw new Error(t('The project changed before a compatible library version was selected.'));
        version = automaticPackageVersion(resolvedItem);
        if (!version) throw new Error(t('No compatible stable version is available for {runtime}.', { runtime: runtimeLabel }));
      } catch (error) {
        setOperation('error', localizedPackageError(error, 'Library details could not be loaded.'));
        notifyToast('error', localizedPackageError(error, 'Library details could not be loaded.'));
        return false;
      } finally {
        busyOperation = null;
        var view = byId('package-center-view');
        if (view) view.setAttribute('aria-busy', 'false');
        renderDock();
      }
    }

    if (!operationContextMatches(operationContext)) {
      setOperation('error', t('The project changed before the library operation could start.'));
      return false;
    }
    setPendingChanges([{
      operation: operation,
      name: resolvedItem.name || item.name,
      version: operation === 'remove' ? String(item.installedVersion || item.version || '') : version,
      scope: String(options.scope || item.scope || item.raw && item.raw.scope || 'runtime'),
      features: []
    }]);
    var applied = await applyPending({ removalConfirmed: operation === 'remove' });
    if (!applied && !recoveryPending) setPendingChanges([]);
    if (applied && !recoveryPending) {
      setPane('browser');
    }
    return applied;
  }

  function renderDetails(item) {
    item = item || {};
    var installed = context && context.installed.find(function(candidate) { return packageKey(candidate.name) === packageKey(item.name); });
    if (byId('package-detail-name')) byId('package-detail-name').textContent = item.name || '--';
    if (byId('package-detail-summary')) byId('package-detail-summary').textContent = item.summary || t('Loading library details...');
    if (byId('package-detail-catalog')) {
      var source = context && context.sources.find(function(candidate) { return candidate.id === (byId('package-source-select') || {}).value; });
      var sourceLabel = source && source.label || t('Official catalog');
      var actualAuthority = String(item.raw && item.raw.catalogAuthority || '').trim();
      byId('package-detail-catalog').textContent = actualAuthority ? sourceLabel + ' · ' + actualAuthority : sourceLabel;
    }
    if (byId('package-detail-cache')) byId('package-detail-cache').textContent = installed && installed.inventoryPresent === false
      ? (installed.inventoryState === 'missing' ? t('Missing from project cache') : t('Inventory verification required'))
      : (installed && installed.inventoryState === 'mismatch' ? t('Declared version mismatch') : (item.projectCached ? t('Cached for this project') : t('Install required')));
    var includePrerelease = Boolean((byId('package-prerelease') || {}).checked);
    var versions = normalizePackageVersions(item, includePrerelease);
    var versionSelect = byId('package-version-select');
    if (versionSelect) {
      var detailPackageKey = packageKey(item.name);
      var previous = versionSelect.dataset.packageKey === detailPackageKey ? versionSelect.value : '';
      if (installed && installed.inventoryState === 'mismatch') previous = '';
      versionSelect.textContent = '';
      versions.forEach(function(version) {
        var option = document.createElement('option');
        option.value = version.version;
        option.textContent = version.version;
        option.disabled = !isSelectablePackageVersion(version);
        option.dataset.compatibility = version.compatibility;
        option.dataset.compatibilityReason = version.compatibilityReason;
        versionSelect.appendChild(option);
      });
      versionSelect.dataset.packageKey = detailPackageKey;
      var preferred = installed && installed.inventoryPresent === false && installed.version ? installed.version : item.version;
      versionSelect.value = preferredPackageVersion(versions, preferred, previous);
      versionSelect.disabled = !versionSelect.value || Boolean(busyOperation);
    }
    var scopeSelect = byId('package-scope-select');
    if (scopeSelect) {
      var scopes = item.raw && item.raw.scopes || ['runtime'];
      scopeSelect.textContent = '';
      scopes.forEach(function(scope) {
        var value = typeof scope === 'string' ? scope : scope.id;
        var option = document.createElement('option');
        option.value = value;
        option.textContent = value === 'dev' ? t('Development') : (value === 'runtime' ? t('Runtime') : String(scope.label || value));
        scopeSelect.appendChild(option);
      });
      scopeSelect.value = installed && installed.scope || 'runtime';
    }
    renderDetailSelectionState(item, installed);
  }

  function renderDetailSelectionState(item, installed) {
    item = item || {};
    var versionSelect = byId('package-version-select');
    var selectedOption = versionSelect && versionSelect.selectedIndex >= 0 ? versionSelect.options[versionSelect.selectedIndex] : null;
    var compatibility = selectedOption ? selectedOption.dataset.compatibility : item.compatibility;
    var reason = selectedOption && selectedOption.dataset.compatibilityReason || item.compatibilityReason || t('The selected version will be verified in the chosen runtime before publication.');
    if (byId('package-detail-compatibility')) byId('package-detail-compatibility').textContent = compatibilityLabel(compatibility);
    if (byId('package-detail-note')) byId('package-detail-note').textContent = reason;
    var action = byId('package-stage-change');
    if (action) {
      var selectedVersion = selectedOption && selectedOption.value || '';
      var sameInstalled = installed && installed.direct && String(installed.version || '') === String(selectedVersion) && String(installed.scope || 'runtime') === String((byId('package-scope-select') || {}).value || 'runtime');
      var repair = sameInstalled && installed.inventoryState === 'missing';
      var needsInventory = sameInstalled && installed.inventoryState === 'unknown';
      action.disabled = !context || context.supported !== true || !selectedOption || selectedOption.disabled || normalizeCompatibility(compatibility) === 'incompatible' || (sameInstalled && !repair) || Boolean(busyOperation) || Boolean(recoveryPending);
      action.innerHTML = (repair || installed && installed.direct ? ICON_UPDATE : ICON_INSTALL) + '<span></span>';
      var copy = action.querySelector('span');
      if (copy) copy.textContent = repair ? t('Repair installation') : (needsInventory ? t('Inventory verification required') : (sameInstalled ? t('Already installed') : (installed && installed.direct ? t('Update') : (installed ? t('Pin as direct dependency') : t('Install')))));
    }
  }

  async function loadDetails(name) {
    var sequence = ++refreshSequence;
    try {
      if (sequence !== refreshSequence || activePane !== 'detail' || !selectedPackage || packageKey(selectedPackage.name) !== packageKey(name)) return;
      selectedPackage = await fetchPackageDetails(name, selectedPackage);
      if (sequence !== refreshSequence || activePane !== 'detail' || !selectedPackage || packageKey(selectedPackage.name) !== packageKey(name)) return;
      renderDetails(selectedPackage);
    } catch (error) {
      if (sequence !== refreshSequence || activePane !== 'detail') return;
      if (byId('package-detail-note')) byId('package-detail-note').textContent = localizedPackageError(error, 'Library details could not be loaded.');
    }
  }

  function setPendingChanges(next) {
    pendingChanges = next;
    if (pendingChanges.length && !pendingContext) pendingContext = captureOperationContext();
    if (!pendingChanges.length) pendingContext = null;
    currentPlan = null;
    renderDock();
    renderBrowser();
  }

  function installSelectedPackage() {
    if (!selectedPackage || !context || context.supported !== true) return false;
    var installed = context.installed.find(function(item) { return packageKey(item.name) === packageKey(selectedPackage.name); });
    var versionSelect = byId('package-version-select');
    var selectedOption = versionSelect && versionSelect.selectedIndex >= 0 ? versionSelect.options[versionSelect.selectedIndex] : null;
    if (!selectedOption || selectedOption.disabled || normalizeCompatibility(selectedOption.dataset.compatibility) === 'incompatible') return false;
    var version = versionSelect.value;
    var scope = byId('package-scope-select') && byId('package-scope-select').value || 'runtime';
    if (installed && installed.direct && installed.inventoryPresent !== false && String(installed.version || '') === String(version || '') && String(installed.scope || 'runtime') === scope) {
      return false;
    }
    return runPackageAction(selectedPackage, {
      operation: installed && installed.direct ? 'update' : 'add',
      version: version,
      scope: scope
    });
  }

  function renderDock() {
    renderSources();
    renderManifests();
  }

  async function requestPlan(operationContext) {
    if (!pendingChanges.length) throw new Error(t('There are no pending library changes.'));
    if (!operationContextMatches(pendingContext)) throw new Error(t('Project context changed; discard these pending changes.'));
    if (!operationContextMatches(operationContext)) throw new Error(t('The project changed before the library plan could be created.'));
    var response = await BOBO.sendToServer('planProjectPackageChanges', currentRequestContext({ changes: pendingChanges.map(function(change) { return Object.assign({}, change); }) }), {
      quiet: true,
      timeoutMs: PACKAGE_PLAN_TIMEOUT_MS
    });
    var plan = extractData(response);
    if (!plan || plan.supported === false) throw new Error(plan && plan.reason || t('No safe library change plan is available.'));
    if (!plan.planId && !plan.id) throw new Error(t('The server returned an invalid library plan.'));
    var localChanges = Array.isArray(plan.localChanges) ? plan.localChanges : null;
    if (plan.reinstall === true) {
      var operations = Array.isArray(plan.changes) ? plan.changes : [];
      var bindings = Array.isArray(plan.manifestBindings) ? plan.manifestBindings : [];
      if (!localChanges || localChanges.length !== 0 || operations.length !== 1 || operations[0].operation !== 'update' || bindings.length !== 1) {
        throw new Error(t('The server returned an invalid library plan.'));
      }
    } else if (!localChanges || localChanges.length !== 1) {
      throw new Error(t('The server returned an invalid library plan.'));
    }
    currentPlan = plan;
    return plan;
  }

  function absoluteWorkspacePath(relative, workspaceRoot) {
    relative = String(relative || '');
    if (/^[a-zA-Z]:[\\/]/.test(relative) || relative.charAt(0) === '/') return relative;
    workspaceRoot = String(workspaceRoot || S.workspaceRoot || '');
    var separator = workspaceRoot.indexOf('\\') >= 0 ? '\\' : '/';
    return workspaceRoot.replace(/[\\/]+$/, '') + separator + relative.replace(/[\\/]/g, separator);
  }

  function editorPathKey(value) { return String(value || '').replace(/\\/g, '/').toLowerCase(); }

  function openEditorForPath(relativePath, workspaceRoot) {
    var target = editorPathKey(absoluteWorkspacePath(relativePath, workspaceRoot));
    var index = (S.tabs || []).findIndex(function(tab) { return editorPathKey(tab && tab.path) === target; });
    if (index < 0 || !S.tabs[index] || !S.tabs[index].model) return null;
    return { index: index, tab: S.tabs[index], model: S.tabs[index].model };
  }

  async function sha256Text(value) {
    if (!global.crypto || !global.crypto.subtle || typeof global.crypto.subtle.digest !== 'function' || typeof global.TextEncoder !== 'function') return '';
    var bytes = new global.TextEncoder().encode(String(value));
    var digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map.call(new Uint8Array(digest), function(byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }

  async function captureEditorSnapshots(workspaceRoot) {
    var rootKey = editorPathKey(String(workspaceRoot || '').replace(/[\\/]+$/, '') + '/');
    var snapshots = [];
    for (var index = 0; index < (S.tabs || []).length; index += 1) {
      var tab = S.tabs[index];
      if (!tab || !tab.model || !editorPathKey(tab.path).startsWith(rootKey)) continue;
      var content = String(tab.model.getValue());
      snapshots.push({
        pathKey: editorPathKey(tab.path),
        tab: tab,
        model: tab.model,
        version: typeof tab.model.getVersionId === 'function' ? tab.model.getVersionId() : null,
        sha256: await sha256Text(content)
      });
    }
    return snapshots;
  }

  function snapshotForPath(snapshots, relativePath, workspaceRoot) {
    var key = editorPathKey(absoluteWorkspacePath(relativePath, workspaceRoot));
    return (snapshots || []).find(function(snapshot) { return snapshot.pathKey === key; }) || null;
  }

  async function readEditorState(editor) {
    if (!editor || !editor.model) return null;
    var versionBefore = typeof editor.model.getVersionId === 'function' ? editor.model.getVersionId() : null;
    var content = String(editor.model.getValue());
    var digest = await sha256Text(content);
    var versionAfter = typeof editor.model.getVersionId === 'function' ? editor.model.getVersionId() : null;
    var contentAfter = String(editor.model.getValue());
    return {
      version: versionAfter,
      sha256: digest,
      stable: versionBefore === versionAfter && content === contentAfter
    };
  }

  async function editorMatchesSnapshot(editor, snapshot) {
    if (!editor || !snapshot || editor.tab !== snapshot.tab || editor.model !== snapshot.model) return false;
    var state = await readEditorState(editor);
    if (!state || !state.stable || (snapshot.version !== null && state.version !== snapshot.version)) return false;
    if (!snapshot.sha256) return true;
    return state.sha256 === snapshot.sha256;
  }

  async function updateOpenBuffers(localChanges, contentKey, workspaceRoot, expectedSnapshots) {
    var snapshots = [];
    for (var change of (localChanges || [])) {
      if (!change || typeof change[contentKey] !== 'string') continue;
      var editor = openEditorForPath(change.path, workspaceRoot);
      if (!editor) continue;
      var expected = snapshotForPath(expectedSnapshots, change.path, workspaceRoot);
      if (!await editorMatchesSnapshot(editor, expected)) continue;
      editor.model.setValue(change[contentKey]);
      editor.tab.dirty = false;
      if (BOBO.workspace && BOBO.workspace.updateTabDirtyFlag) BOBO.workspace.updateTabDirtyFlag(editor.index, false);
      var content = String(editor.model.getValue());
      snapshots.push({
        pathKey: editorPathKey(editor.tab.path),
        tab: editor.tab,
        model: editor.model,
        version: typeof editor.model.getVersionId === 'function' ? editor.model.getVersionId() : null,
        sha256: await sha256Text(content)
      });
    }
    if (BOBO.workspace && BOBO.workspace.updateTitlebar) BOBO.workspace.updateTitlebar();
    return snapshots;
  }

  async function collectEditorConflicts(publishedFiles, snapshots, workspaceRoot) {
    var conflicts = [];
    for (var file of (publishedFiles || [])) {
      var editor = openEditorForPath(file.path, workspaceRoot);
      if (!editor) continue;
      var expected = snapshotForPath(snapshots, file.path, workspaceRoot);
      if (expected && await editorMatchesSnapshot(editor, expected)) continue;
      var currentState = await readEditorState(editor);
      if (!expected && currentState && currentState.stable && currentState.sha256 === String(file.sha256 || '').toLowerCase()) continue;
      conflicts.push({
        path: file.path,
        expectedSha256: file.sha256,
        actualSha256: currentState && currentState.stable ? currentState.sha256 : '',
        expectedVersion: expected && expected.version,
        actualVersion: currentState && currentState.version
      });
    }
    return conflicts;
  }

  async function reloadRolledBackBuffers(localChanges, workspaceRoot, expectedSnapshots) {
    var restored = [];
    var api = localTransactionApi();
    if (typeof api.readFile !== 'function') return;
    for (var index = 0; index < (localChanges || []).length; index += 1) {
      var change = localChanges[index];
      try {
        var content = await api.readFile(absoluteWorkspacePath(change.path, workspaceRoot));
        restored.push(Object.assign({}, change, { restoredContent: content }));
      } catch (_) {}
    }
    await updateOpenBuffers(restored, 'restoredContent', workspaceRoot, expectedSnapshots);
  }

  function markWorkspaceUnsynced() {
    // A restored manifest has not been proven present on the currently bound
    // server. Force the next normal sync to upload it instead of trusting the
    // previous workspace version marker.
    S.lastSyncedVersion = -1;
  }

  function detachSyncRecovery(options) {
    options = options || {};
    if (!recoveryPending || recoveryPending.kind !== 'sync') return false;
    recoveryPending = null;
    markWorkspaceUnsynced();
    if (options.visible === true) {
      var message = t('Restored dependency files were kept locally because the server or account changed.');
      setOperation('warning', message);
      notifyToast('warning', message);
    }
    return true;
  }

  function completePublishedInPriorContext() {
    pendingChanges = [];
    pendingContext = null;
    currentPlan = null;
    recoveryPending = null;
    setPane('browser');
    resetForContextChange({ hard: true });
    var message = t('Libraries were updated for the previous project context; the current context was not refreshed.');
    setOperation('warning', message);
    notifyToast('warning', message);
  }

  async function rollbackTransaction(transaction, operationContext, localChanges, editorSnapshots) {
    var api = localTransactionApi();
    if (!transaction || typeof api.packageCenterRollbackLocalChanges !== 'function') return;
    var rolledBack = await api.packageCenterRollbackLocalChanges({
      transactionId: transaction.transactionId,
      workspaceRoot: operationContext.workspaceRoot,
      workspaceIdentity: operationContext.workspaceIdentity
    });
    if (!rolledBack || rolledBack.success === false) {
      throw new Error(localizedPackageError(rolledBack, 'Dependency file rollback failed.'));
    }
    await reloadRolledBackBuffers(localChanges, operationContext.workspaceRoot, editorSnapshots);
    var reboundContext = rebindOperationContext(operationContext);
    if (!reboundContext) {
      if (!workspaceLocationMatches(operationContext) || stableIdentityState(operationContext) === 'different') {
        markWorkspaceUnsynced();
        return { detached: true };
      }
      recoveryPending = { kind: 'sync', operationContext: operationContext, localChanges: localChanges.slice() };
      throw new Error(t('The restored dependency file could not be synchronized.'));
    }
    try {
      if (!workspaceContextMatches(reboundContext)) throw new Error(t('The restored dependency file cannot be synchronized because the project context changed.'));
      if (!BOBO.runner || typeof BOBO.runner.manualSyncWithServer !== 'function' || !await BOBO.runner.manualSyncWithServer()) {
        throw new Error(t('The restored dependency file could not be synchronized.'));
      }
    } catch (error) {
      recoveryPending = { kind: 'sync', operationContext: reboundContext, localChanges: localChanges.slice() };
      throw error;
    }
  }

  function validateServerApplyResult(response, planId) {
    var result = extractData(response);
    if (!result || result.applied !== true || String(result.planId || '') !== String(planId || '')) {
      throw new Error(t('The server could not verify the published library operation.'));
    }
    return result;
  }

  async function commitPublishedTransaction(transaction, operationContext, planId, editorConflicts) {
    var api = localTransactionApi();
    if (typeof api.packageCenterCommitLocalChanges !== 'function') {
      throw new Error(t('The dependency file transaction could not be finalized.'));
    }
    var committed = await api.packageCenterCommitLocalChanges({
      transactionId: transaction.transactionId,
      workspaceRoot: operationContext.workspaceRoot,
      workspaceIdentity: operationContext.workspaceIdentity,
      planId: planId,
      serverApplied: true,
      publishedFiles: transaction.publishedFiles || [],
      editorConflicts: editorConflicts || []
    });
    if (!committed || committed.success === false) {
      throw new Error(localizedPackageError(committed, 'The dependency file transaction could not be finalized.'));
    }
    return committed;
  }

  function beginManifestReconciliation(operationContext, conflicts) {
    pendingChanges = [];
    pendingContext = null;
    currentPlan = null;
    recoveryPending = { kind: 'reconcile', operationContext: operationContext, conflicts: conflicts || [] };
    markWorkspaceUnsynced();
    setPane('browser');
    var message = t('Newer dependency file edits were preserved. Synchronize them, then repair the project libraries again.');
    setOperation('warning', message, { retry: true });
    notifyToast('warning', message);
  }

  async function refreshConfiguredLanguageService() {
    if (!BOBO.lsp || typeof BOBO.lsp.dependenciesChanged !== 'function') return true;
    var mode = typeof BOBO.lsp.getMode === 'function'
      ? String(BOBO.lsp.getMode() || 'local')
      : String(S.lsp && S.lsp.settings && S.lsp.settings.mode || 'local');
    var refreshed = await Promise.resolve(BOBO.lsp.dependenciesChanged());
    if (mode !== 'local' && refreshed === false) {
      throw new Error(t('The analysis service could not verify the updated libraries.'));
    }
    return true;
  }

  async function refreshLanguageServices() {
    await refreshConfiguredLanguageService();
    if (BOBO.environmentCenter && BOBO.environmentCenter.scheduleRefresh) BOBO.environmentCenter.scheduleRefresh('package-change', 0);
    var refreshed = await refreshContext({ loading: false, search: false, force: true });
    if (!refreshed || refreshed.supported !== true) throw new Error(refreshed && refreshed.reason || t('The analysis service could not verify the updated libraries.'));
    return refreshed;
  }

  async function retryRecovery() {
    if (!recoveryPending || busyOperation) return !recoveryPending;
    var recovery = recoveryPending;
    busyOperation = { context: recovery.operationContext || captureOperationContext(), recovery: true };
    setOperation('loading', recovery.kind === 'sync' ? t('Synchronizing restored dependency files...') :
      (recovery.kind === 'refresh' ? t('Refreshing language service...') :
        (recovery.kind === 'apply' ? t('Verifying library installation...') :
          (recovery.kind === 'reconcile' ? t('Synchronizing preserved dependency file edits...') : t('Finalizing dependency files...')))));
    try {
      if (recovery.kind === 'sync') {
        var reboundSyncContext = rebindOperationContext(recovery.operationContext);
        if (!reboundSyncContext) {
          if (stableIdentityState(recovery.operationContext) === 'different' || !workspaceLocationMatches(recovery.operationContext)) {
            detachSyncRecovery({ visible: true });
            return true;
          }
          throw new Error(t('The restored dependency file could not be synchronized.'));
        }
        recovery.operationContext = reboundSyncContext;
        busyOperation.context = reboundSyncContext;
        if (!workspaceContextMatches(reboundSyncContext) || !BOBO.runner || typeof BOBO.runner.manualSyncWithServer !== 'function' || !await BOBO.runner.manualSyncWithServer()) {
          throw new Error(t('The restored dependency file could not be synchronized.'));
        }
        pendingChanges = [];
        pendingContext = null;
        currentPlan = null;
      } else if (recovery.kind === 'apply') {
        var reboundApplyContext = rebindOperationContext(recovery.operationContext, { runtime: true });
        if (!reboundApplyContext) throw new Error(t('Reconnect to the original server and account to verify this library operation.'));
        recovery.operationContext = reboundApplyContext;
        busyOperation.context = reboundApplyContext;
        var recoveredResponse = await applyServerPlan(recovery.applyPayload, {
          operationTimeoutSeconds: recovery.operationTimeoutSeconds,
          followUp: true,
          canSend: function() { return operationContextMatches(reboundApplyContext); }
        });
        if (!recoveredResponse || recoveredResponse.success === false) {
        var applyError = new Error(localizedPackageError(recoveredResponse, 'The library installation status is still uncertain.'));
          applyError.packageApplyUncertain = recoveredResponse && recoveredResponse.uncertain === true;
          if (!applyError.packageApplyUncertain) {
            await rollbackTransaction(recovery.transaction, recovery.operationContext, recovery.localChanges || [], recovery.editorSnapshots);
            recoveryPending = null;
          }
          throw applyError;
        }
        validateServerApplyResult(recoveredResponse, recovery.planId);
        var recoveredEditorConflicts = await collectEditorConflicts(recovery.transaction.publishedFiles, recovery.editorSnapshots, recovery.operationContext.workspaceRoot);
        var recoveredCommit;
        try {
          recoveredCommit = await commitPublishedTransaction(recovery.transaction, recovery.operationContext, recovery.planId, recoveredEditorConflicts);
        } catch (commitError) {
          recoveryPending = {
            kind: 'commit',
            transaction: recovery.transaction,
            operationContext: recovery.operationContext,
            planId: recovery.planId,
            editorSnapshots: recovery.editorSnapshots
          };
          setOperation('warning', t('Libraries updated; local finalization is pending.'), { retry: true });
          return true;
        }
        if (recoveredCommit.reconciliationRequired === true) {
          beginManifestReconciliation(recovery.operationContext, recoveredCommit.conflicts);
          return true;
        }
        recoveryPending = null;
        var reboundRecoveredContext = rebindOperationContext(recovery.operationContext, { runtime: true });
        if (!reboundRecoveredContext) {
          completePublishedInPriorContext();
          return true;
        }
        recovery.operationContext = reboundRecoveredContext;
        try {
          await refreshLanguageServices();
        } catch (_) {
          recoveryPending = { kind: 'refresh', operationContext: recovery.operationContext };
          setOperation('warning', t('Libraries updated, but the analysis service still needs a refresh.'), { retry: true });
          return true;
        }
      } else if (recovery.kind === 'commit') {
        var commitEditorConflicts = await collectEditorConflicts(recovery.transaction.publishedFiles, recovery.editorSnapshots, recovery.operationContext.workspaceRoot);
        var committedRecovery = await commitPublishedTransaction(recovery.transaction, recovery.operationContext, recovery.planId, commitEditorConflicts);
        if (committedRecovery.reconciliationRequired === true) {
          beginManifestReconciliation(recovery.operationContext, committedRecovery.conflicts);
          return true;
        }
        recoveryPending = null;
        var reboundCommitContext = rebindOperationContext(recovery.operationContext, { runtime: true });
        if (!reboundCommitContext) {
          completePublishedInPriorContext();
          return true;
        }
        recovery.operationContext = reboundCommitContext;
        try {
          await refreshLanguageServices();
        } catch (_) {
          recoveryPending = { kind: 'refresh', operationContext: recovery.operationContext };
          setOperation('warning', t('Libraries updated, but the analysis service still needs a refresh.'), { retry: true });
          return true;
        }
      } else if (recovery.kind === 'reconcile') {
        var reboundReconcileContext = rebindOperationContext(recovery.operationContext, { runtime: true });
        if (!reboundReconcileContext) throw new Error(t('Reconnect to the original server and account to reconcile dependency file edits.'));
        recovery.operationContext = reboundReconcileContext;
        busyOperation.context = reboundReconcileContext;
        if (!BOBO.workspace || typeof BOBO.workspace.saveAllTabs !== 'function' || !await BOBO.workspace.saveAllTabs()) {
          throw new Error(t('The preserved dependency file edits could not be saved.'));
        }
        if (!operationContextMatches(reboundReconcileContext) || !BOBO.runner || typeof BOBO.runner.manualSyncWithServer !== 'function' || !await BOBO.runner.manualSyncWithServer()) {
          throw new Error(t('The preserved dependency file edits could not be synchronized.'));
        }
        if (BOBO.environmentCenter && BOBO.environmentCenter.scheduleRefresh) BOBO.environmentCenter.scheduleRefresh('package-reconciliation', 0);
        await refreshContext({ loading: false, search: false, force: true });
        recoveryPending = null;
        setOperation('warning', t('Dependency file edits were synchronized. Review and repair the project libraries again.'));
        return true;
      } else {
        var reboundRefreshContext = rebindOperationContext(recovery.operationContext, { runtime: true });
        if (!reboundRefreshContext) {
          completePublishedInPriorContext();
          return true;
        }
        recovery.operationContext = reboundRefreshContext;
        await refreshLanguageServices();
      }
      if (pendingContext) {
        var reboundPendingContext = rebindOperationContext(pendingContext, { runtime: true });
        if (reboundPendingContext) pendingContext = reboundPendingContext;
      }
      recoveryPending = null;
      setOperation('ready', recovery.kind === 'refresh' ? t('Language service refreshed') : t('Dependency file recovery completed'));
      return true;
    } catch (error) {
      if (recovery.kind === 'refresh') {
        setOperation('warning', t('Libraries updated, but the analysis service still needs a refresh.'), { retry: true });
      } else {
        setOperation('error', localizedPackageError(error, 'Dependency file recovery is still pending.'), { retry: Boolean(recoveryPending) });
      }
      return false;
    } finally {
      busyOperation = null;
      var view = byId('package-center-view');
      if (view) view.setAttribute('aria-busy', 'false');
      renderDock();
      flushDeferredContextReset();
    }
  }

  async function applyPending(options) {
    options = options || {};
    if (busyOperation || !pendingChanges.length || !context || context.supported !== true) return false;
    if (recoveryPending && !await retryRecovery()) return false;
    var operationContext = captureOperationContext();
    var transaction = null;
    var localChanges = [];
    var editorSnapshots = [];
    var publishedEditorSnapshots = [];
    var serverApplied = false;
    var operationCommitted = false;
    var planId = '';
    var applyPayload = null;
    var plan = null;
    busyOperation = { context: operationContext };
    setOperation('loading', t('Saving open files...'));
    try {
      if (!BOBO.workspace || typeof BOBO.workspace.saveAllTabs !== 'function' || !await BOBO.workspace.saveAllTabs()) throw new Error(t('Open files could not be saved.'));
      if (!operationContextMatches(operationContext)) throw new Error(t('The project changed while library changes were starting.'));
      editorSnapshots = await captureEditorSnapshots(operationContext.workspaceRoot);

      setOperation('loading', t('Planning library changes...'));
      plan = await requestPlan(operationContext);
      localChanges = Array.isArray(plan.localChanges) ? plan.localChanges : [];
      planId = String(plan.planId || plan.id || '');
      if (!operationContextMatches(operationContext)) throw new Error(t('The project changed after the library plan was created.'));

      var includesRemoval = pendingChanges.some(function(change) { return change.operation === 'remove'; });
      if (includesRemoval && options.removalConfirmed !== true && BOBO.confirm) {
        var confirmed = await BOBO.confirm({
          title: t('Remove library?'),
          message: t('This updates the dependency file and rebuilds the project environment.'),
          confirmLabel: t('Remove'),
          danger: true
        });
        if (!confirmed) {
          setOperation('', '');
          return false;
        }
      }
      if (!operationContextMatches(operationContext)) throw new Error(t('The project changed before dependency files were updated.'));

      setOperation('loading', plan.reinstall === true ? t('Verifying dependency file...') : t('Updating dependency files...'));
      var api = localTransactionApi();
      if (typeof api.packageCenterApplyLocalChanges !== 'function') throw new Error(t('This client cannot apply dependency file changes.'));
      var transactionCandidate = await api.packageCenterApplyLocalChanges({
        workspaceRoot: operationContext.workspaceRoot,
        workspaceIdentity: operationContext.workspaceIdentity,
        planId: planId,
        revision: plan.revision || context.revision || '',
        language: context.language && context.language.id || '',
        reinstall: plan.reinstall === true,
        changes: Array.isArray(plan.changes) ? plan.changes : [],
        localChanges: localChanges,
        manifestBindings: Array.isArray(plan.manifestBindings) ? plan.manifestBindings : []
      });
      if (!transactionCandidate || transactionCandidate.success === false || !String(transactionCandidate.transactionId || '').trim()) {
        throw new Error(localizedPackageError(transactionCandidate, 'Dependency files could not be updated.'));
      }
      transaction = transactionCandidate;
      publishedEditorSnapshots = plan.reinstall === true
        ? editorSnapshots
        : await updateOpenBuffers(localChanges, 'newContent', operationContext.workspaceRoot, editorSnapshots);
      if (!operationContextMatches(operationContext)) throw new Error(t('The project changed after dependency files were updated.'));

      if (plan.reinstall !== true) {
        setOperation('loading', t('Synchronizing project...'));
        if (!BOBO.runner || typeof BOBO.runner.manualSyncWithServer !== 'function' || !await BOBO.runner.manualSyncWithServer()) throw new Error(t('The updated dependency files could not be synchronized.'));
        if (!operationContextMatches(operationContext)) throw new Error(t('The project changed while dependency files were synchronizing.'));
      }

      setOperation('loading', t('Resolving and installing libraries...'));
      applyPayload = currentRequestContext({
        packagePlanId: planId,
        revision: plan.revision || context.revision || ''
      });
      var applyResponse = await applyServerPlan(applyPayload, {
        operationTimeoutSeconds: context.operationTimeoutSeconds,
        canSend: function() { return operationContextMatches(operationContext); }
      });
      if (!applyResponse || applyResponse.success === false) {
        var applyFailure = new Error(localizedPackageError(applyResponse, 'Library update failed.'));
        applyFailure.packageApplyUncertain = Boolean(applyResponse && applyResponse.uncertain === true);
        throw applyFailure;
      }
      try {
        validateServerApplyResult(applyResponse, planId);
      } catch (verificationError) {
        verificationError.packageApplyUncertain = true;
        throw verificationError;
      }
      serverApplied = true;

      setOperation('loading', t('Finalizing dependency files...'));
      var editorConflicts = await collectEditorConflicts(transaction.publishedFiles, publishedEditorSnapshots, operationContext.workspaceRoot);
      var commitResult = await commitPublishedTransaction(transaction, operationContext, planId, editorConflicts);
      operationCommitted = true;
      if (commitResult.reconciliationRequired === true) {
        beginManifestReconciliation(operationContext, commitResult.conflicts);
        return true;
      }

      pendingChanges = [];
      pendingContext = null;
      currentPlan = null;
      // A run-identity epoch change can precede S.serverSettings being replaced
      // while the settings workflow is switching servers. Direct apply
      // responses therefore require the exact pre-request epoch. Recovery may
      // rebind later once a stable same-user identity is observable.
      var reboundPublishedContext = operationContextMatches(operationContext) ? operationContext : null;
      if (!reboundPublishedContext) {
        completePublishedInPriorContext();
        return true;
      }
      operationContext = reboundPublishedContext;
      if (BOBO.environmentActivity) BOBO.environmentActivity.record('install', { outcome: 'completed' });
      setOperation('loading', t('Refreshing language service...'));
      try {
        await refreshLanguageServices();
      } catch (refreshError) {
        recoveryPending = { kind: 'refresh', operationContext: operationContext };
        setPane('browser');
        setOperation('warning', t('Libraries updated, but the analysis service still needs a refresh.'), { retry: true });
        notifyToast('warning', t('Libraries updated, but the analysis service still needs a refresh.'));
        return true;
      }
      setPane('browser');
      setOperation('ready', t('Libraries updated'));
      notifyToast('success', t('Project libraries updated'));
      setTimeout(function() { if (!busyOperation) setOperation('', ''); }, 1800);
      return true;
    } catch (error) {
      if (operationCommitted) {
        pendingChanges = [];
        currentPlan = null;
        setPane('browser');
        setOperation('ready', t('Libraries updated'));
        notifyToast('success', t('Project libraries updated'));
        return true;
      }
      if (serverApplied && transaction) {
        pendingChanges = [];
        pendingContext = null;
        currentPlan = null;
        recoveryPending = {
          kind: 'commit',
          transaction: transaction,
          operationContext: operationContext,
          planId: planId || String(transaction.planId || ''),
          editorSnapshots: publishedEditorSnapshots
        };
        if (!recoveryPending.planId) recoveryPending.planId = transaction.planId || '';
        if (BOBO.environmentActivity) BOBO.environmentActivity.record('install', { outcome: 'completed' });
        setPane('browser');
        setOperation('warning', t('Libraries updated; local finalization is pending.'), { retry: true });
        notifyToast('warning', t('Libraries updated; local finalization is pending.'));
        return true;
      }
      if (error && error.packageApplyUncertain === true && transaction) {
        pendingChanges = [];
        pendingContext = null;
        currentPlan = null;
        recoveryPending = {
          kind: 'apply',
          transaction: transaction,
          operationContext: operationContext,
          planId: planId || String(transaction.planId || ''),
          applyPayload: applyPayload,
          operationTimeoutSeconds: context && context.operationTimeoutSeconds,
          localChanges: localChanges.slice(),
          editorSnapshots: publishedEditorSnapshots
        };
        setPane('browser');
        setOperation('warning', t('The library installation status is still uncertain.'), { retry: true });
        notifyToast('warning', t('The library installation status is still uncertain.'));
        return true;
      }
      if (!serverApplied && transaction) {
        setOperation('loading', t('Rolling back dependency files...'));
        try { await rollbackTransaction(transaction, operationContext, localChanges, publishedEditorSnapshots); }
        catch (rollbackError) {
          error = new Error(t('{message} Rollback also failed: {rollback}', {
            message: localizedPackageError(error, 'Library update failed.'),
            rollback: localizedPackageError(rollbackError, 'Unknown error')
          }));
        }
      }
      if (BOBO.environmentActivity) BOBO.environmentActivity.record('install', { outcome: 'failed' });
      setOperation('error', localizedPackageError(error, 'Library update failed.'), { retry: Boolean(recoveryPending) });
      notifyToast('error', localizedPackageError(error, 'Library update failed.'));
      return false;
    } finally {
      busyOperation = null;
      var view = byId('package-center-view');
      if (view) view.setAttribute('aria-busy', 'false');
      renderDock();
      flushDeferredContextReset();
    }
  }

  async function clearPending(options) {
    options = options || {};
    if (!pendingChanges.length) return true;
    var confirmed = options.confirm === false || !BOBO.confirm || await BOBO.confirm({
      title: t('Discard library changes?'),
      message: t('The pending dependency changes have not been applied to the project.'),
      confirmLabel: t('Discard changes'),
      danger: true
    });
    if (!confirmed) return false;
    setPendingChanges([]);
    setPane('browser');
    return true;
  }

  async function beforeWorkspaceLeave() {
    if (busyOperation) {
      notifyToast('error', t('Wait for the library operation to finish before changing projects.'));
      throw new Error('package-operation-active');
    }
    if (recoveryPending && recoveryPending.kind === 'sync' &&
        (!workspaceLocationMatches(recoveryPending.operationContext) || stableIdentityState(recoveryPending.operationContext) !== 'same')) {
      detachSyncRecovery();
    }
    if (recoveryPending && recoveryPending.kind !== 'refresh' && !await retryRecovery()) {
      notifyToast('error', t('Complete dependency file recovery before changing projects.'));
      throw new Error('package-recovery-pending');
    }
    if (pendingChanges.length && !await clearPending()) throw new Error('package-changes-pending');
  }

  function resetForContextChange(options) {
    options = options || {};
    if (busyOperation) {
      refreshSequence += 1;
      contextResetPending = { hard: contextResetPending && contextResetPending.hard || options.hard === true };
      return;
    }
    if (recoveryPending && recoveryPending.kind === 'sync' && stableIdentityState(recoveryPending.operationContext) === 'different') {
      detachSyncRecovery();
    }
    refreshSequence += 1;
    context = null;
    results = [];
    cursor = '';
    selectedPackage = null;
    currentPlan = null;
    if (options.hard === true) {
      pendingChanges = [];
      pendingContext = null;
      if (!recoveryPending || !['apply', 'commit', 'reconcile'].includes(recoveryPending.kind)) recoveryPending = null;
    }
    manifestSelectionTouched = false;
    setPane('browser');
    renderDock();
    if (activeView === 'packages') refreshContext({ loading: true, search: true });
  }

  function flushDeferredContextReset() {
    if (busyOperation || !contextResetPending) return;
    var deferredReset = contextResetPending;
    contextResetPending = false;
    resetForContextChange(deferredReset);
  }

  function bindTabKeyboard(ids) {
    ids.forEach(function(id, index) {
      var tab = byId(id);
      if (!tab) return;
      tab.addEventListener('keydown', function(event) {
        var target = index;
        if (event.key === 'ArrowRight') target = (index + 1) % ids.length;
        else if (event.key === 'ArrowLeft') target = (index + ids.length - 1) % ids.length;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = ids.length - 1;
        else return;
        event.preventDefault();
        var next = byId(ids[target]);
        if (next) { next.focus(); next.click(); }
      });
    });
  }

  function bind() {
    var overview = byId('environment-tab-overview');
    var packages = byId('environment-tab-packages');
    if (overview) overview.addEventListener('click', function() { setActiveView('overview'); });
    if (packages) packages.addEventListener('click', function() { setActiveView('packages'); });
    ['discover', 'installed'].forEach(function(mode) {
      var button = byId('package-mode-' + mode);
      if (button) button.addEventListener('click', function() { setActiveMode(mode); });
    });
    var input = byId('package-search-input');
    if (input) input.addEventListener('input', function() {
      if (byId('package-search-clear')) byId('package-search-clear').hidden = !input.value;
      scheduleSearch(280);
      renderSuggestions();
    });
    var clearSearch = byId('package-search-clear');
    if (clearSearch) clearSearch.addEventListener('click', function() { if (input) { input.value = ''; input.focus(); } scheduleSearch(0); renderSuggestions(); });
    var source = byId('package-source-select');
    if (source) source.addEventListener('change', function() {
      currentPlan = null;
      selectedPackage = null;
      setPane('browser');
      if (activeMode === 'discover') {
        results = [];
        cursor = '';
        renderBrowser();
        setCenterState('loading', t('Searching libraries...'));
        scheduleSearch(0);
      } else {
        renderBrowser();
      }
    });
    var manifest = byId('package-manifest-select');
    if (manifest) manifest.addEventListener('change', function() { manifestSelectionTouched = true; currentPlan = null; renderDock(); });
    var refresh = byId('package-refresh');
    if (refresh) refresh.addEventListener('click', function() { if (activeMode === 'discover') searchPackages(); else refreshContext({ loading: true, search: false, force: true }); });
    var more = byId('package-load-more');
    if (more) more.addEventListener('click', function() { searchPackages({ append: true }); });
    var detailBack = byId('package-detail-back');
    if (detailBack) detailBack.addEventListener('click', returnToBrowser);
    var prerelease = byId('package-prerelease');
    if (prerelease) prerelease.addEventListener('change', function() { if (selectedPackage) renderDetails(selectedPackage); });
    var packageVersion = byId('package-version-select');
    if (packageVersion) packageVersion.addEventListener('change', function() {
      if (!selectedPackage) return;
      var installed = context && context.installed.find(function(item) { return packageKey(item.name) === packageKey(selectedPackage.name); });
      renderDetailSelectionState(selectedPackage, installed);
    });
    var packageScope = byId('package-scope-select');
    if (packageScope) packageScope.addEventListener('change', function() {
      if (!selectedPackage) return;
      var installed = context && context.installed.find(function(item) { return packageKey(item.name) === packageKey(selectedPackage.name); });
      renderDetailSelectionState(selectedPackage, installed);
    });
    var stage = byId('package-stage-change');
    if (stage) stage.addEventListener('click', installSelectedPackage);
    var retry = byId('package-operation-retry');
    if (retry) retry.addEventListener('click', retryRecovery);
    bindTabKeyboard(['environment-tab-overview', 'environment-tab-packages']);
    bindTabKeyboard(['package-mode-discover', 'package-mode-installed']);
    global.addEventListener('bobo:workspace-changed', function() { resetForContextChange({ hard: true }); });
    global.addEventListener('bobo:language-changed', function() {
      if (activeView === 'packages') {
        renderContext();
        if (selectedPackage) renderDetails(selectedPackage);
      }
    });
    if (BOBO.environmentActivity && BOBO.environmentActivity.subscribe) {
      activityUnsubscribe = BOBO.environmentActivity.subscribe(function(event) {
        if (event && event.kind === 'context') resetForContextChange({ hard: false });
      });
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    bind();
    setActiveView('overview');
    renderDock();
  }

  BOBO.packageCenter = {
    init: init,
    open: function(options) {
      options = options || {};
      if (options.mode) setActiveMode(options.mode);
      setActiveView('packages', options);
    },
    refresh: refreshContext,
    search: searchPackages,
    apply: applyPending,
    clearPending: clearPending,
    retryRecovery: retryRecovery,
    beforeWorkspaceLeave: beforeWorkspaceLeave,
    getState: function() {
      return { activeView: activeView, activeMode: activeMode, activePane: activePane, context: context, results: results.slice(), pendingChanges: pendingChanges.slice(), plan: currentPlan, busy: Boolean(busyOperation), recovery: recoveryPending && recoveryPending.kind || '' };
    },
    dispose: function() { if (typeof activityUnsubscribe === 'function') activityUnsubscribe(); }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizeContext: normalizeContext,
      normalizeResults: normalizeResults,
      normalizeCompatibility: normalizeCompatibility,
      normalizePackageVersions: normalizePackageVersions,
      preferredPackageVersion: preferredPackageVersion,
      resolvedRuntimeVersion: resolvedRuntimeVersion,
      runtimeDisplayLabel: runtimeDisplayLabel,
      automaticPackageVersion: automaticPackageVersion,
      mergeInstalledState: mergeInstalledState,
      upsertChange: upsertChange,
      removeChange: removeChange,
      packageKey: packageKey,
      localizedPackageError: localizedPackageError,
      applyServerPlan: applyServerPlan,
      captureOperationContext: captureOperationContext,
      operationContextMatches: operationContextMatches,
      rebindOperationContext: rebindOperationContext,
      stableIdentityState: stableIdentityState,
      stableServerIdentity: stableServerIdentity,
      stableUserIdentity: stableUserIdentity,
      captureEditorSnapshots: captureEditorSnapshots,
      updateOpenBuffers: updateOpenBuffers,
      collectEditorConflicts: collectEditorConflicts,
      refreshConfiguredLanguageService: refreshConfiguredLanguageService,
      packageOperationTimeoutMs: packageOperationTimeoutMs,
      packageApplyTimeoutMs: packageApplyTimeoutMs,
      PACKAGE_QUERY_TIMEOUT_MS: PACKAGE_QUERY_TIMEOUT_MS,
      PACKAGE_PLAN_TIMEOUT_MS: PACKAGE_PLAN_TIMEOUT_MS,
      PACKAGE_APPLY_TIMEOUT_MS: PACKAGE_APPLY_TIMEOUT_MS,
      PACKAGE_APPLY_GRACE_MS: PACKAGE_APPLY_GRACE_MS,
      PACKAGE_APPLY_RESPONSE_GRACE_MS: PACKAGE_APPLY_RESPONSE_GRACE_MS
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
