// src/environment-center.js - Project environment diagnosis and action workflow.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state || {};
  var initialized = false;
  var snapshot = null;
  var refreshTimer = null;
  var refreshSequence = 0;
  var refreshPromise = null;
  var refreshQueued = false;
  var busyAction = '';
  var manifestPaths = Object.create(null);
  var localManifestCache = null;
  var localManifestWorkspace = '';
  var fileEventUnsubscribe = null;
  var markerEventDisposable = null;
  var lastWorkbenchActivity = '';

  var MANIFEST_RULES = [
    { pattern: /(^|\/)requirements(?:[-_.][^/]*)?\.txt$/i, kind: 'requirements', manager: 'pip', language: 'python' },
    { pattern: /(^|\/)pyproject\.toml$/i, kind: 'project', manager: 'python', language: 'python' },
    { pattern: /(^|\/)(Pipfile|Pipfile\.lock|poetry\.lock|pdm\.lock|setup\.py|setup\.cfg)$/i, kind: 'dependency', manager: 'python', language: 'python' },
    { pattern: /(^|\/)environment\.ya?ml$/i, kind: 'environment', manager: 'conda', language: 'python' },
    { pattern: /(^|\/)package\.json$/i, kind: 'manifest', manager: 'npm', language: 'node' },
    { pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i, kind: 'lockfile', manager: 'node', language: 'node' },
    { pattern: /(^|\/)go\.(mod|sum|work)$/i, kind: 'module', manager: 'go', language: 'go' },
    { pattern: /(^|\/)Cargo\.(toml|lock)$/i, kind: 'manifest', manager: 'cargo', language: 'rust' },
    { pattern: /(^|\/)pom\.xml$/i, kind: 'manifest', manager: 'maven', language: 'java' },
    { pattern: /(^|\/)(build|settings)\.gradle(?:\.kts)?$/i, kind: 'manifest', manager: 'gradle', language: 'java' },
    { pattern: /(^|\/)gradle\.(properties|lockfile)$/i, kind: 'config', manager: 'gradle', language: 'java' },
    { pattern: /(^|\/)(CMakeLists\.txt|compile_commands\.json|vcpkg\.json|conanfile\.(?:txt|py)|meson\.build|Makefile)$/i, kind: 'manifest', manager: 'native', language: 'native' }
  ];
  var IGNORED_SEGMENTS = { '.git': true, '.hg': true, '.svn': true, 'node_modules': true, '__pycache__': true, '.venv': true, 'venv': true, 'vendor': true, 'target': true, 'dist': true, 'build': true };

  function t(source, replacements) {
    if (BOBO.i18n && typeof BOBO.i18n.t === 'function') return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function byId(id) { return global.document && global.document.getElementById(id); }

  function canonicalLanguage(language) {
    var value = String(language || '').toLowerCase();
    if (value === 'javascript' || value === 'javascriptreact' || value === 'typescript' || value === 'typescriptreact') return 'node';
    if (value === 'c' || value === 'cpp' || value === 'objective-c') return 'native';
    if (value === 'plaintext' || value === 'text' || value === 'image') return '';
    return value;
  }

  function currentLanguage() {
    var tab = (S.tabs || []).find(function(item) { return item.path === S.activeTabPath; });
    if (tab && tab.language && tab.language !== 'image') return String(tab.language);
    var model = S.editor && typeof S.editor.getModel === 'function' ? S.editor.getModel() : null;
    return model && typeof model.getLanguageId === 'function' ? String(model.getLanguageId() || '') : '';
  }

  function runtimeDefinition(runtimeId) {
    return (S.availableRuntimes || []).find(function(runtime) { return runtime && runtime.runtimeId === runtimeId; }) || null;
  }

  function pathName(value) {
    var parts = String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function relativePath(root, fullPath) {
    var normalizedRoot = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var normalizedFull = String(fullPath || '').replace(/\\/g, '/');
    if (!normalizedRoot || normalizedFull.toLowerCase().indexOf((normalizedRoot + '/').toLowerCase()) !== 0) return normalizedFull.replace(/^\/+/, '');
    return normalizedFull.slice(normalizedRoot.length + 1);
  }

  function manifestRule(relative) {
    var normalized = String(relative || '').replace(/\\/g, '/');
    for (var index = 0; index < MANIFEST_RULES.length; index += 1) {
      if (MANIFEST_RULES[index].pattern.test(normalized)) return MANIFEST_RULES[index];
    }
    return null;
  }

  function isIgnored(relative) {
    return String(relative || '').replace(/\\/g, '/').split('/').some(function(segment) {
      return IGNORED_SEGMENTS[String(segment || '').toLowerCase()] === true;
    });
  }

  function recognizeManifests(tree, workspaceRoot, maxEntries) {
    var found = [];
    var seen = Object.create(null);
    var visited = 0;
    var limit = Math.max(100, Math.min(20000, Number(maxEntries || 6000)));

    function visit(nodes, depth) {
      if (!Array.isArray(nodes) || depth > 6 || visited >= limit) return;
      for (var index = 0; index < nodes.length && visited < limit; index += 1) {
        var node = nodes[index] || {};
        visited += 1;
        var fullPath = String(node.path || '');
        var relative = relativePath(workspaceRoot, fullPath || node.name || '');
        if (!relative || isIgnored(relative)) continue;
        var children = node.children || node.items;
        var isDirectory = node.type === 'directory' || node.isDirectory === true || Array.isArray(children);
        if (isDirectory) {
          visit(children, depth + 1);
          continue;
        }
        var rule = manifestRule(relative);
        if (!rule || seen[relative.toLowerCase()]) continue;
        seen[relative.toLowerCase()] = true;
        found.push({
          path: relative.replace(/\\/g, '/'),
          localPath: fullPath || '',
          kind: rule.kind,
          manager: rule.manager,
          language: rule.language,
          lockfile: rule.kind === 'lockfile' || /(?:\.lock|\.sum)$/i.test(relative),
          parsed: false,
          status: 'detected'
        });
      }
    }

    visit(Array.isArray(tree) ? tree : (tree && (tree.children || tree.items)) || [], 0);
    return found.sort(function(left, right) { return left.path.localeCompare(right.path); }).slice(0, 120);
  }

  function languageMatchesRuntime(language, runtime) {
    var expected = canonicalLanguage(language);
    if (!expected || !runtime) return null;
    var actual = canonicalLanguage(runtime.language || String(runtime.runtimeId || '').split(':')[0]);
    return expected === actual || (expected === 'native' && (actual === 'c' || actual === 'cpp'));
  }

  function normalizeHealth(value) {
    value = String(value || '').toLowerCase();
    if (['ready', 'healthy', 'aligned', 'ok', 'empty'].indexOf(value) >= 0) return 'ready';
    if (['warning', 'mixed', 'stale', 'degraded', 'unknown', 'unavailable'].indexOf(value) >= 0) return 'warning';
    if (['error', 'missing', 'mismatch', 'failed', 'invalid'].indexOf(value) >= 0) return 'error';
    if (['busy', 'loading', 'indexing', 'starting'].indexOf(value) >= 0) return 'busy';
    return 'unknown';
  }

  function localSnapshot(manifests) {
    var language = currentLanguage();
    var runtimeId = S.selectedRuntime || '';
    var runtime = runtimeDefinition(runtimeId);
    var lsp = BOBO.lsp && BOBO.lsp.getStatus ? BOBO.lsp.getStatus() : {};
    var dependency = lsp.dependency || {};
    var runtimeMatch = runtimeId ? languageMatchesRuntime(language, runtime || { runtimeId: runtimeId }) : null;
    var lspHealth = lsp.state === 'ready' ? 'ready' : (lsp.state === 'starting' || lsp.state === 'connecting' ? 'busy' : (lsp.state === 'local' ? 'warning' : 'error'));
    var dependencyHealth = normalizeHealth(dependency.status);
    if (!dependency.status && manifests.length === 0) dependencyHealth = 'ready';
    var overall = [lspHealth, runtimeMatch === false ? 'error' : (runtimeMatch === true ? 'ready' : 'warning'), dependencyHealth].indexOf('error') >= 0
      ? 'error'
      : ([lspHealth, runtimeMatch === true ? 'ready' : 'warning', dependencyHealth].indexOf('warning') >= 0 ? 'warning' : 'ready');
    var current = S.collaboration && S.collaboration.current;
    var projectName = current && (current.projectName || current.name) || pathName(S.workspaceRoot) || t('Current project');
    return {
      schema: 'project-environment/v1',
      source: 'local',
      checkedAt: new Date().toISOString(),
      workspace: {
        kind: current ? 'team' : 'personal',
        id: current ? String(current.projectId || '') : (BOBO.projectKey ? BOBO.projectKey(S.workspaceRoot || '') : ''),
        name: projectName,
        key: BOBO.projectKey ? BOBO.projectKey(S.workspaceRoot || '') : '',
        teamId: current && current.teamId || '',
        projectId: current && current.projectId || '',
        branch: current && current.branch || ''
      },
      language: { id: language || 'plaintext', source: 'editor' },
      runtime: {
        id: runtimeId || 'local',
        language: runtime && runtime.language || '',
        version: runtime && runtime.version || '',
        image: runtime && (runtime.dockerImage || runtime.image) || (runtimeId ? '' : t('Local runtime')),
        displayName: runtime && runtime.displayName || runtimeId || t('Local runtime'),
        status: runtimeMatch === false ? 'mismatch' : (runtimeMatch === true ? 'ready' : 'unknown')
      },
      manifests: manifests,
      packages: { declared: [], installed: [], missing: [], unknown: [] },
      dependencyCache: { scope: 'local', status: 'unavailable' },
      consistency: {
        status: overall,
        languageRuntime: { status: runtimeMatch === false ? 'mismatch' : (runtimeMatch === true ? 'ready' : 'unknown'), detail: runtimeMatch === false ? t('Selected runtime does not match the active language.') : (runtimeMatch === true ? t('Runtime matches the active language.') : t('Select a cloud runtime to verify compatibility.')) },
        dependencyRuntime: { status: dependencyHealth, detail: dependency.detail || (manifests.length ? t('Dependency files detected; package versions require cloud verification.') : t('No dependency files detected.')) },
        lspDependencies: { status: lspHealth, detail: lsp.state === 'ready' ? t('Language service is ready.') : (lsp.state === 'local' ? t('Local code intelligence is active.') : (lsp.error || t('Language service is not ready.'))) }
      },
      activity: {},
      actions: {
        refreshIndex: { supported: Boolean(BOBO.lsp && lsp.state === 'ready') },
        clearCache: { supported: Boolean(BOBO.lsp && S.workspaceRoot), scope: 'workspace' },
        repair: { supported: false, requiresConfirmation: true, reason: t('Cloud environment diagnostics are required before repair.') },
        rebuild: { supported: false, requiresConfirmation: true, reason: t('Cloud environment diagnostics are required before rebuild.') }
      }
    };
  }

  function requestContext() {
    var current = S.collaboration && S.collaboration.current;
    var language = currentLanguage();
    return {
      folderName: pathName(S.workspaceRoot),
      folderKey: BOBO.projectKey ? BOBO.projectKey(S.workspaceRoot || '') : '',
      runtime: S.selectedRuntime || '',
      language: language,
      teamId: current && current.teamId || '',
      projectId: current && current.projectId || '',
      branch: current && current.branch || '',
      setupCommands: Array.isArray(S.setupCommands) ? S.setupCommands.slice() : []
    };
  }

  function mergeActivity(value) {
    var result = Object.assign({}, value || {});
    var local = BOBO.environmentActivity && BOBO.environmentActivity.read ? BOBO.environmentActivity.read() : {};
    var keys = ['lastIndexedAt', 'lastInstalledAt', 'lastCompiledAt', 'lastRepairAt', 'lastRebuildAt'];
    keys.forEach(function(key) {
      var remoteTime = Date.parse(result[key] || '') || Number(result[key] || 0) || 0;
      var localTime = Number(local[key] || 0) || 0;
      var latest = Math.max(remoteTime, localTime);
      if (latest > 0) result[key] = new Date(latest).toISOString();
    });
    return result;
  }

  function mergeServerSnapshot(local, remote) {
    remote = remote && typeof remote === 'object' ? remote : {};
    var merged = Object.assign({}, local, remote);
    merged.workspace = Object.assign({}, local.workspace, remote.workspace || {});
    merged.language = Object.assign({}, local.language, remote.language || {});
    merged.runtime = Object.assign({}, local.runtime, remote.runtime || {});
    merged.packages = Object.assign({}, local.packages, remote.packages || {});
    merged.dependencyCache = Object.assign({}, local.dependencyCache, remote.dependencyCache || {});
    merged.consistency = Object.assign({}, local.consistency, remote.consistency || {});
    // The renderer owns the live transport state. A healthy dependency view on
    // the server must not hide a disconnected or local-only language service.
    merged.consistency.lspDependencies = local.consistency.lspDependencies;
    var localLsp = healthValue(local.consistency && local.consistency.lspDependencies).status;
    var remoteOverall = normalizeHealth(merged.consistency.status);
    if (localLsp === 'error') merged.consistency.status = 'error';
    else if (localLsp === 'busy' && remoteOverall !== 'error') merged.consistency.status = 'busy';
    else if (localLsp === 'warning' && remoteOverall === 'ready') merged.consistency.status = 'warning';
    merged.actions = Object.assign({}, local.actions, remote.actions || {});
    var liveLsp = BOBO.lsp && BOBO.lsp.getStatus ? BOBO.lsp.getStatus() : {};
    if (merged.actions.refreshIndex && liveLsp.state !== 'ready') {
      merged.actions.refreshIndex = Object.assign({}, merged.actions.refreshIndex, {
        supported: false,
        reason: t('Remote analysis is not ready')
      });
    }
    merged.manifests = Array.isArray(remote.manifests) && remote.manifests.length ? remote.manifests : local.manifests;
    merged.activity = mergeActivity(remote.activity);
    merged.source = remote.schema === 'project-environment/v1' ? 'cloud' : local.source;
    return merged;
  }

  function unresolvedPythonImport(problem) {
    if (!problem || ['error', 'warning'].indexOf(String(problem.severity || '').toLowerCase()) < 0) return '';
    var message = String(problem.message || '');
    var code = String(problem.code || '').toLowerCase();
    var match = message.match(/\bImport\s+["']([^"']+)["']\s+could not be resolved\b/i);
    if (!match && code !== 'reportmissingimports') return '';
    var imported = match ? String(match[1] || '').trim() : '';
    if (!imported || imported.charAt(0) === '.') return '';
    return imported.split('.')[0].trim();
  }

  function mergeLiveDependencyDiagnostics(value, problems) {
    if (!value || canonicalLanguage(value.language && value.language.id) !== 'python') return value;
    var names = [];
    var seen = Object.create(null);
    (Array.isArray(problems) ? problems : []).forEach(function(problem) {
      var name = unresolvedPythonImport(problem);
      var key = name.toLowerCase();
      if (!name || seen[key]) return;
      seen[key] = true;
      names.push(name);
    });
    if (!names.length) return value;

    var packages = Object.assign({}, value.packages || {});
    var missing = Array.isArray(packages.missing) ? packages.missing.slice() : [];
    var dependencyCache = value.dependencyCache || {};
    var dependencyRuntime = value.consistency && value.consistency.dependencyRuntime || {};
    var declared = Array.isArray(packages.declared) ? packages.declared : [];
    var installed = Array.isArray(packages.installed) ? packages.installed : [];
    var exactInstalled = installed.length > 0 && installed.every(function(item) { return item && item.trust === 'exact'; });
    var authoritative = declared.length > 0 && ['aligned', 'mismatch'].indexOf(String(dependencyRuntime.status || '').toLowerCase()) >= 0 &&
      (dependencyCache.inventoryStatus === 'ready' || exactInstalled);
    missing.forEach(function(item) {
      var name = String(item && item.name || '').toLowerCase();
      if (name) seen[name] = true;
    });
    if (!authoritative) {
      names.forEach(function(name) {
        if (missing.some(function(item) { return String(item && item.name || '').toLowerCase() === name.toLowerCase(); })) return;
        missing.push({
          name: name,
          constraint: '',
          source: 'language-service',
          reason: t('Import could not be resolved')
        });
      });
    }
    packages.missing = missing;

    var consistency = Object.assign({}, value.consistency || {});
    var diagnosticDetail = t('{count} unresolved dependency imports were reported by the language service.', { count: names.length });
    if (authoritative) {
      if (normalizeHealth(consistency.status) === 'ready') consistency.status = 'unknown';
    } else {
      consistency.status = 'mismatch';
      consistency.dependencyRuntime = {
        status: 'mismatch',
        detail: diagnosticDetail
      };
    }
    consistency.lspDependencies = {
      status: 'mixed',
      detail: diagnosticDetail
    };
    return Object.assign({}, value, { packages: packages, consistency: consistency });
  }

  async function readLocalManifests() {
    if (!S.workspaceRoot || !global.api || typeof global.api.readTree !== 'function') return [];
    if (localManifestCache && localManifestWorkspace === S.workspaceRoot) return localManifestCache.slice();
    try {
      var tree = await global.api.readTree(S.workspaceRoot);
      localManifestWorkspace = S.workspaceRoot;
      localManifestCache = recognizeManifests(tree, S.workspaceRoot);
      return localManifestCache.slice();
    } catch (_) {
      return [];
    }
  }

  function extractResponseData(response) {
    if (!response || response.success === false) return null;
    var value = response.data && typeof response.data === 'object' ? response.data : response;
    return value && value.schema === 'project-environment/v1' ? value : null;
  }

  async function fetchSnapshot() {
    var manifests = await readLocalManifests();
    var local = localSnapshot(manifests);
    local.activity = mergeActivity(local.activity);
    if (!BOBO.sendToServer || !S.serverSettings || !S.serverSettings.ip) return local;
    try {
      var response = await BOBO.sendToServer('getProjectEnvironment', requestContext(), { quiet: true });
      var remote = extractResponseData(response);
      return remote ? mergeServerSnapshot(local, remote) : local;
    } catch (_) {
      return local;
    }
  }

  function setVisibleState(name, message) {
    ['empty', 'loading', 'error', 'ready'].forEach(function(state) {
      var element = byId('environment-center-' + state);
      if (element) element.hidden = state !== name;
    });
    var error = byId('environment-center-error-message');
    if (error && message) error.textContent = message;
  }

  function healthValue(value) {
    if (value && typeof value === 'object') return { status: normalizeHealth(value.status), detail: String(value.detail || value.reason || '') };
    return { status: normalizeHealth(value), detail: '' };
  }

  function statusLabel(status) {
    var labels = { ready: t('Healthy'), warning: t('Needs attention'), error: t('Issue detected'), busy: t('In progress'), unknown: t('Not checked') };
    return labels[status] || labels.unknown;
  }

  function renderHealth(id, value, fallbackDetail) {
    var normalized = healthValue(value);
    var row = byId('environment-health-' + id);
    var state = byId('environment-health-' + id + '-state');
    var detail = byId('environment-health-' + id + '-detail');
    if (row) row.dataset.health = normalized.status;
    if (state) state.textContent = statusLabel(normalized.status);
    if (detail) detail.textContent = normalized.detail || fallbackDetail || '--';
  }

  function createListRow(primary, secondary, meta, status, localPath) {
    var row = document.createElement(localPath ? 'button' : 'div');
    row.className = 'environment-list-row';
    row.setAttribute('role', 'listitem');
    if (status) row.dataset.status = status;
    if (localPath) {
      row.type = 'button';
      row.classList.add('environment-list-link');
      row.addEventListener('click', function() {
        if (BOBO.workspace && BOBO.workspace.openFile) BOBO.workspace.openFile(localPath, pathName(localPath));
      });
    }
    var icon = document.createElement('span');
    icon.className = 'environment-list-icon';
    icon.textContent = status === 'missing' ? '!' : (status === 'warning' ? '?' : '#');
    icon.setAttribute('aria-hidden', 'true');
    var copy = document.createElement('span');
    copy.className = 'environment-list-copy';
    var strong = document.createElement('strong');
    strong.textContent = primary || '--';
    var small = document.createElement('small');
    small.textContent = secondary || '';
    copy.append(strong, small);
    var suffix = document.createElement('span');
    suffix.className = 'environment-list-meta';
    suffix.textContent = meta || '';
    row.append(icon, copy, suffix);
    return row;
  }

  function localPathForManifest(manifest) {
    if (manifest && manifest.localPath) return manifest.localPath;
    var relative = String(manifest && manifest.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relative || relative.split('/').some(function(part) { return part === '..'; })) return '';
    if (manifestPaths[relative.toLowerCase()]) return manifestPaths[relative.toLowerCase()];
    var separator = String(S.workspaceRoot || '').indexOf('\\') >= 0 ? '\\' : '/';
    return String(S.workspaceRoot || '').replace(/[\\/]+$/, '') + separator + relative.replace(/\//g, separator);
  }

  function renderList(listId, emptyId, countId, values, builder) {
    var list = byId(listId);
    var empty = byId(emptyId);
    var count = byId(countId);
    values = Array.isArray(values) ? values : [];
    if (list) {
      list.textContent = '';
      values.forEach(function(value) { list.appendChild(builder(value)); });
    }
    if (empty) empty.hidden = values.length > 0;
    if (count) count.textContent = String(values.length);
  }

  function formatTime(value) {
    var timestamp = typeof value === 'number' ? value : Date.parse(value || '');
    if (!Number.isFinite(timestamp) || timestamp <= 0) return t('No activity yet');
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(timestamp)); }
    catch (_) { return new Date(timestamp).toLocaleString(); }
  }

  function actionDescriptor(name) {
    var actions = snapshot && snapshot.actions || {};
    if (name === 'refresh') return actions.refreshIndex || {};
    if (name === 'clear') return actions.clearCache || {};
    return actions[name] || {};
  }

  function renderActions() {
    var defaultTitles = {
      repair: t('Repair detected environment issues'),
      rebuild: t('Rebuild environment'),
      refresh: t('Refresh index'),
      clear: t('Clear environment cache')
    };
    ['repair', 'rebuild', 'refresh', 'clear'].forEach(function(name) {
      var button = byId('environment-action-' + name);
      if (!button) return;
      var descriptor = actionDescriptor(name);
      var supported = descriptor.supported === true;
      button.disabled = Boolean(busyAction) || !supported;
      var reason = descriptor.reason ? t(descriptor.reason) : (!supported ? t('This action is not available for the current environment.') : '');
      button.title = reason || defaultTitles[name];
    });
    var center = byId('environment-center');
    var busy = byId('environment-center-busy');
    if (center) center.setAttribute('aria-busy', busyAction ? 'true' : 'false');
    if (busy) busy.hidden = !busyAction;
  }

  function render(value) {
    snapshot = value;
    if (!S.workspaceRoot) {
      setVisibleState('empty');
      return;
    }
    if (!value) {
      setVisibleState('loading');
      return;
    }
    var problems = BOBO.taskProblemMatcher && typeof BOBO.taskProblemMatcher.getAllProblems === 'function'
      ? BOBO.taskProblemMatcher.getAllProblems()
      : [];
    value = mergeLiveDependencyDiagnostics(value, problems);
    setVisibleState('ready');
    manifestPaths = Object.create(null);
    (value.manifests || []).forEach(function(item) {
      if (item && item.path && item.localPath) manifestPaths[String(item.path).toLowerCase()] = item.localPath;
    });

    var projectName = value.workspace && (value.workspace.name || value.workspace.id) || pathName(S.workspaceRoot);
    var language = value.language && (value.language.displayName || value.language.id) || currentLanguage() || '--';
    var runtime = value.runtime || {};
    var consistency = value.consistency || {};
    var overall = normalizeHealth(consistency.status || runtime.status);
    if (byId('environment-context-heading')) byId('environment-context-heading').textContent = projectName || t('Current project');
    if (byId('environment-context-language')) byId('environment-context-language').textContent = language;
    if (byId('environment-context-runtime')) byId('environment-context-runtime').textContent = runtime.displayName || runtime.id || '--';
    if (byId('environment-context-image')) byId('environment-context-image').textContent = runtime.image || t('Not reported');
    if (byId('environment-context-project')) byId('environment-context-project').textContent = value.workspace && value.workspace.kind === 'team'
      ? [value.workspace.name || value.workspace.projectId, value.workspace.branch].filter(Boolean).join(' / ')
      : projectName;
    var dependencyCache = value.dependencyCache || {};
    var scopeLabels = {
      'project-lock': t('Project and lock digest'),
      'legacy-user': t('Legacy user cache'),
      'local': t('Local runtime'),
      'none': t('Not available')
    };
    var cacheStatusLabels = {
      hit: t('Cached'),
      miss: t('Not materialized'),
      legacy: t('Legacy'),
      error: t('Issue detected'),
      unavailable: t('Not available')
    };
    if (byId('environment-context-dependency-scope')) byId('environment-context-dependency-scope').textContent = scopeLabels[dependencyCache.scope] || dependencyCache.scope || t('Not reported');
    if (byId('environment-context-cache-status')) byId('environment-context-cache-status').textContent = cacheStatusLabels[dependencyCache.status] || dependencyCache.status || t('Not reported');
    if (byId('environment-context-dependency-digest')) {
      var digest = dependencyCache.digest ? String(dependencyCache.digest).slice(0, 16) : '--';
      var source = dependencyCache.source ? t(String(dependencyCache.source)) : '';
      byId('environment-context-dependency-digest').textContent = [source, digest].filter(Boolean).join(' / ');
      byId('environment-context-dependency-digest').title = dependencyCache.digest || '';
    }
    var overallElement = byId('environment-overall-status');
    if (overallElement) { overallElement.dataset.status = overall; overallElement.textContent = statusLabel(overall); }

    renderHealth('lsp', consistency.lspDependencies, t('Language service status is not available.'));
    renderHealth('runtime', consistency.languageRuntime || runtime.status, t('Runtime compatibility is not available.'));
    renderHealth('dependencies', consistency.dependencyRuntime, t('Dependency state is not available.'));

    renderList('environment-manifest-list', 'environment-manifest-empty', 'environment-manifest-count', value.manifests, function(item) {
      return createListRow(item.path, [item.manager, item.kind].filter(Boolean).join(' / '), item.status === 'parsed' || item.parsed ? t('parsed') : t('detected'), '', localPathForManifest(item));
    });
    var installed = value.packages && value.packages.installed || [];
    renderList('environment-installed-list', 'environment-installed-empty', 'environment-installed-count', installed, function(item) {
      return createListRow(item.name, [item.source, item.scope].filter(Boolean).join(' / '), item.version || '--', '', '');
    });
    var missing = (value.packages && value.packages.missing || []).map(function(item) { return Object.assign({ _status: 'missing' }, item); });
    var unknown = (value.packages && value.packages.unknown || []).map(function(item) { return Object.assign({ _status: 'warning' }, item); });
    renderList('environment-missing-list', 'environment-missing-empty', 'environment-missing-count', missing.concat(unknown), function(item) {
      return createListRow(item.name, item.reason || item.source || '', item.constraint || (item._status === 'warning' ? t('verify') : t('missing')), item._status, '');
    });

    var activity = value.activity || {};
    if (byId('environment-activity-index-time')) byId('environment-activity-index-time').textContent = formatTime(activity.lastIndexedAt);
    if (byId('environment-activity-install-time')) byId('environment-activity-install-time').textContent = formatTime(activity.lastInstalledAt);
    if (byId('environment-activity-compile-time')) byId('environment-activity-compile-time').textContent = formatTime(activity.lastCompiledAt);
    renderActions();
  }

  async function refresh(options) {
    options = options || {};
    if (refreshPromise) {
      refreshQueued = true;
      await refreshPromise;
      if (options.force === true) return refresh(Object.assign({}, options, { force: false }));
      return snapshot;
    }
    refreshPromise = performRefresh(options);
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh('coalesced', 80);
      }
    }
  }

  async function performRefresh(options) {
    var sequence = ++refreshSequence;
    if (!S.workspaceRoot) {
      snapshot = null;
      setVisibleState('empty');
      return null;
    }
    if (options.loading !== false && !snapshot) setVisibleState('loading');
    try {
      var value = await fetchSnapshot();
      if (sequence !== refreshSequence) return null;
      render(value);
      return value;
    } catch (error) {
      if (sequence !== refreshSequence) return null;
      if (snapshot) render(snapshot);
      else setVisibleState('error', error && error.message ? error.message : t('Unknown error'));
      return null;
    }
  }

  function scheduleRefresh(reason, delay) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function() {
      refreshTimer = null;
      var state = BOBO.workbench && BOBO.workbench.getState ? BOBO.workbench.getState() : {};
      if (state.activity === 'environment' || reason === 'workspace') refresh({ loading: !snapshot });
    }, Math.max(0, Number(delay || 120)));
  }

  function busyLabel(name) {
    return { repair: t('Repairing environment...'), rebuild: t('Rebuilding environment...'), refresh: t('Refreshing analysis index...'), clear: t('Clearing environment cache...') }[name] || t('Preparing environment action...');
  }

  function setBusy(name) {
    busyAction = name || '';
    var label = byId('environment-center-busy-label');
    if (label && name) label.textContent = busyLabel(name);
    renderActions();
  }

  async function waitForReady(timeoutMs, previousSessionId) {
    var end = Date.now() + Number(timeoutMs || 20000);
    var observedTransition = false;
    while (Date.now() < end) {
      var lsp = BOBO.lsp && BOBO.lsp.getStatus ? BOBO.lsp.getStatus() : {};
      if (lsp.state !== 'ready') observedTransition = true;
      if (lsp.state === 'ready' && (observedTransition || !previousSessionId || String(lsp.sessionId || '') !== String(previousSessionId))) return true;
      await new Promise(function(resolve) { setTimeout(resolve, 180); });
    }
    return false;
  }

  async function refreshAnalysisIndex() {
    if (!BOBO.lsp || typeof BOBO.lsp.clearAnalysisCache !== 'function' || typeof BOBO.lsp.restartAnalysis !== 'function') throw new Error(t('Remote analysis is not ready'));
    var previous = BOBO.lsp.getStatus ? BOBO.lsp.getStatus() : {};
    await BOBO.lsp.clearAnalysisCache();
    await BOBO.lsp.restartAnalysis();
    if (!await waitForReady(20000, previous.sessionId)) throw new Error(t('Language service did not become ready in time.'));
    if (BOBO.environmentActivity) BOBO.environmentActivity.record('index', { outcome: 'completed' });
  }

  async function clearEnvironmentCaches() {
    var lsp = BOBO.lsp;
    if (!lsp) throw new Error(t('Remote analysis is not ready'));
    if (typeof lsp.clearClientCache === 'function') await lsp.clearClientCache('workspace');
    if (snapshot && snapshot.source === 'cloud' && BOBO.sendToServer) {
      var response = await BOBO.sendToServer('applyProjectEnvironmentAction', actionPayload('clearCache'), { quiet: true });
      if (!response || response.success === false) {
        throw new Error(response && (response.error || response.message) || t('Environment action failed.'));
      }
      return response.data || response;
    }
    var state = typeof lsp.getStatus === 'function' ? lsp.getStatus() : {};
    if (state.state === 'ready' && typeof lsp.clearAnalysisCache === 'function') return lsp.clearAnalysisCache();
    return null;
  }

  function actionPayload(name, extra) {
    return Object.assign({}, requestContext(), { environmentAction: name, revision: snapshot && snapshot.revision || '' }, extra || {});
  }

  function planSteps(plan) {
    var steps = plan && (plan.steps || plan.operations || plan.actions);
    if (!Array.isArray(steps)) return [];
    return steps.slice(0, 12).map(function(step) {
      if (typeof step === 'string') return step;
      return step && (step.label || step.description || step.kind || step.action) || '';
    }).filter(Boolean);
  }

  async function requestManagedAction(name) {
    var planResponse = await BOBO.sendToServer('planProjectEnvironmentRepair', actionPayload(name), { quiet: true });
    if (!planResponse || planResponse.success === false) throw new Error(planResponse && (planResponse.error || planResponse.message) || t('Environment action could not be planned.'));
    var plan = planResponse.data || planResponse.plan || planResponse;
    if (plan.supported !== true) throw new Error(plan.reason || t('No safe repair plan is available.'));
    var steps = planSteps(plan);
    if (steps.length === 0) throw new Error(plan.reason || t('No safe repair plan is available.'));
    var title = name === 'rebuild' ? t('Rebuild project environment?') : t('Repair project environment?');
    var message = name === 'rebuild'
      ? t('This recreates the selected runtime dependency environment and then verifies it again.')
      : t('The server will apply only the diagnosed dependency repairs and then verify the environment again.');
    if (steps.length) message += '\n\n' + steps.map(function(step) { return '• ' + step; }).join('\n');
    var confirmed = await BOBO.confirm({ title: title, message: message, confirmLabel: name === 'rebuild' ? t('Rebuild environment') : t('Repair issues'), danger: name === 'rebuild' });
    if (!confirmed) return false;
    var apply = await BOBO.sendToServer('applyProjectEnvironmentAction', actionPayload(name, { planId: plan.planId || plan.id || '' }), { quiet: true });
    if (!apply || apply.success === false) throw new Error(apply && (apply.error || apply.message) || t('Environment action failed.'));
    if (BOBO.environmentActivity) BOBO.environmentActivity.record(name, { outcome: 'completed' });
    if (BOBO.lsp && BOBO.lsp.dependenciesChanged) BOBO.lsp.dependenciesChanged();
    return true;
  }

  async function runAction(name) {
    if (busyAction || !snapshot) return;
    var descriptor = actionDescriptor(name);
    if (descriptor.supported !== true) {
      if (BOBO.toast) BOBO.toast.error(descriptor.reason || t('This action is not available for the current environment.'));
      return;
    }
    if (name === 'clear') {
      var clear = await BOBO.confirm({
        title: t('Clear environment cache?'),
        message: t('This clears the current workspace analysis and local completion caches. Installed dependencies are preserved.'),
        confirmLabel: t('Clear cache'),
        danger: true
      });
      if (!clear) return;
    }
    setBusy(name);
    try {
      if (name === 'refresh') await refreshAnalysisIndex();
      else if (name === 'clear') await clearEnvironmentCaches();
      else if (!await requestManagedAction(name)) return;
      if (BOBO.toast) BOBO.toast.success(name === 'clear' ? t('Environment cache cleared') : (name === 'refresh' ? t('Analysis index refreshed') : t('Environment action completed')));
      await refresh({ loading: false, force: true });
    } catch (error) {
      if (BOBO.environmentActivity && (name === 'repair' || name === 'rebuild')) BOBO.environmentActivity.record(name, { outcome: 'failed' });
      if (BOBO.toast) BOBO.toast.error(error && error.message ? error.message : t('Environment action failed.'));
      await refresh({ loading: false, force: true });
    } finally {
      setBusy('');
    }
  }

  function bind() {
    var retry = byId('environment-center-error-retry');
    if (retry) retry.addEventListener('click', function() { refresh({ loading: true }); });
    ['repair', 'rebuild', 'refresh', 'clear'].forEach(function(name) {
      var button = byId('environment-action-' + name);
      if (button) button.addEventListener('click', function() { runAction(name); });
    });
    global.addEventListener('bobo:workbench-changed', function(event) {
      var activity = event.detail && event.detail.activity || '';
      if (activity === 'environment' && lastWorkbenchActivity !== 'environment') scheduleRefresh('view', 0);
      lastWorkbenchActivity = activity;
    });
    global.addEventListener('bobo:workspace-changed', function() {
      snapshot = null;
      localManifestCache = null;
      localManifestWorkspace = '';
      scheduleRefresh('workspace', 0);
    });
    global.addEventListener('bobo:language-changed', function() {
      if (snapshot) render(snapshot);
    });
    if (global.monaco && global.monaco.editor && typeof global.monaco.editor.onDidChangeMarkers === 'function') {
      markerEventDisposable = global.monaco.editor.onDidChangeMarkers(function() {
        if (snapshot) render(snapshot);
      });
    }
    if (BOBO.environmentActivity && BOBO.environmentActivity.subscribe) {
      BOBO.environmentActivity.subscribe(function(event) {
        if (event && event.kind === 'context') snapshot = null;
        scheduleRefresh('activity', event && event.kind === 'context' ? 80 : 180);
      });
    }
    if (global.api && typeof global.api.onFileEvent === 'function') {
      fileEventUnsubscribe = global.api.onFileEvent(function(event) {
        var value = event && (event.path || event.filePath || event.name) || '';
        if (manifestRule(String(value).replace(/\\/g, '/'))) {
          localManifestCache = null;
          scheduleRefresh('manifest', 180);
        }
      });
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    lastWorkbenchActivity = BOBO.workbench && BOBO.workbench.getState ? BOBO.workbench.getState().activity : '';
    bind();
    if (S.workspaceRoot) scheduleRefresh('workspace', 0);
    else setVisibleState('empty');
  }

  BOBO.environmentCenter = {
    init: init,
    refresh: refresh,
    scheduleRefresh: scheduleRefresh,
    runAction: runAction,
    getSnapshot: function() { return snapshot; },
    dispose: function() {
      if (typeof fileEventUnsubscribe === 'function') fileEventUnsubscribe();
      if (markerEventDisposable && typeof markerEventDisposable.dispose === 'function') markerEventDisposable.dispose();
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      canonicalLanguage: canonicalLanguage,
      recognizeManifests: recognizeManifests,
      languageMatchesRuntime: languageMatchesRuntime,
      normalizeHealth: normalizeHealth,
      mergeServerSnapshot: mergeServerSnapshot,
      unresolvedPythonImport: unresolvedPythonImport,
      mergeLiveDependencyDiagnostics: mergeLiveDependencyDiagnostics
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
