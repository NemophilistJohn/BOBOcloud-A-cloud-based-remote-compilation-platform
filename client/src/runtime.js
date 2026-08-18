// src/runtime.js — Runtime selector dropdown and language-aware Docker preferences.
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  var RUNTIME_STORAGE_KEY = 'bobocloud.runtime';
  var LANGUAGE_PREFERENCE_STORAGE_KEY = 'bobocloud.runtime.language-preferences.v1';
  var AUTO_USED_LANGUAGE_STORAGE_KEY = 'bobocloud.runtime.auto-used-languages.v1';
  var LANGUAGE_ALIASES = { javascript: 'node', typescript: 'node', nodejs: 'node' };
  var LANGUAGE_NAMES = {
    python: 'Python', java: 'Java', c: 'C', cpp: 'C++', go: 'Go', rust: 'Rust', node: 'Node.js'
  };
  var legacyRuntimeId = normalizeRuntimeId(S.selectedRuntime);

  function tr(source, replacements) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function normalizeRuntimeId(value) {
    var runtimeId = typeof value === 'string' ? value.trim() : '';
    return runtimeId === 'local' ? '' : runtimeId;
  }

  function canonicalLanguage(value) {
    var language = String(value || '').trim().toLowerCase();
    return LANGUAGE_ALIASES[language] || language;
  }

  function languageDisplayName(language) {
    language = canonicalLanguage(language);
    return LANGUAGE_NAMES[language] || (BOBO.langDisplayName && BOBO.langDisplayName(language)) || language;
  }

  function runtimeIdOf(runtime) {
    return normalizeRuntimeId(runtime && (runtime.runtimeId || runtime.id));
  }

  function runtimeLanguage(runtime) {
    return canonicalLanguage(runtime && runtime.language);
  }

  function runtimeForId(runtimeId) {
    runtimeId = normalizeRuntimeId(runtimeId);
    return (S.availableRuntimes || []).find(function(runtime) {
      return runtimeIdOf(runtime) === runtimeId;
    }) || null;
  }

  function loadSavedRuntime() {
    try {
      var saved = localStorage.getItem(RUNTIME_STORAGE_KEY);
      // An empty value is an intentional Local choice and must survive restart.
      if (saved !== null) S.selectedRuntime = normalizeRuntimeId(saved);
      // Releases before language-aware preferences only kept this single
      // runtime. It is migrated once for its matching language below.
      if (Object.keys(loadLanguagePreferences()).length === 0) legacyRuntimeId = normalizeRuntimeId(S.selectedRuntime);
    } catch (e) {}
  }

  function saveRuntimePreference() {
    try {
      localStorage.setItem(RUNTIME_STORAGE_KEY, normalizeRuntimeId(S.selectedRuntime));
    } catch (e) {}
  }

  function loadLanguagePreferences() {
    try {
      var raw = localStorage.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      var result = {};
      Object.keys(parsed).forEach(function(key) {
        var language = canonicalLanguage(key);
        var runtimeId = normalizeRuntimeId(parsed[key]);
        if (language && runtimeId) result[language] = runtimeId;
      });
      return result;
    } catch (e) {
      return {};
    }
  }

  function saveLanguagePreferences(preferences) {
    try {
      localStorage.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, JSON.stringify(preferences));
    } catch (e) {}
  }

  function rememberLanguageRuntime(language, runtimeId) {
    language = canonicalLanguage(language);
    runtimeId = normalizeRuntimeId(runtimeId);
    if (!language || !runtimeId) return;
    var preferences = loadLanguagePreferences();
    if (preferences[language] === runtimeId) return;
    preferences[language] = runtimeId;
    saveLanguagePreferences(preferences);
  }

  function loadAutoUsedLanguages() {
    try {
      var raw = localStorage.getItem(AUTO_USED_LANGUAGE_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      var result = {};
      Object.keys(parsed).forEach(function(key) {
        var language = canonicalLanguage(key);
        if (language && parsed[key] === true) result[language] = true;
      });
      return result;
    } catch (e) {
      return {};
    }
  }

  function markAutoUsedLanguage(language) {
    language = canonicalLanguage(language);
    if (!language) return false;
    var used = loadAutoUsedLanguages();
    if (used[language]) return false;
    used[language] = true;
    try { localStorage.setItem(AUTO_USED_LANGUAGE_STORAGE_KEY, JSON.stringify(used)); } catch (e) {}
    return true;
  }

  function versionParts(value) {
    return String(value || '').match(/[0-9]+|[A-Za-z]+/g) || [];
  }

  function compareRuntimeVersions(left, right) {
    var a = versionParts(left && left.version || runtimeIdOf(left));
    var b = versionParts(right && right.version || runtimeIdOf(right));
    var count = Math.max(a.length, b.length);
    for (var index = 0; index < count; index++) {
      var aPart = a[index] || '';
      var bPart = b[index] || '';
      if (aPart === bPart) continue;
      var aNumber = /^\d+$/.test(aPart);
      var bNumber = /^\d+$/.test(bPart);
      if (aNumber && bNumber) return Number(aPart) - Number(bPart);
      if (aNumber !== bNumber) return aNumber ? 1 : -1;
      return aPart < bPart ? -1 : 1;
    }
    var aId = runtimeIdOf(left);
    var bId = runtimeIdOf(right);
    return aId === bId ? 0 : (aId < bId ? -1 : 1);
  }

  function runtimesForLanguage(language) {
    language = canonicalLanguage(language);
    return (S.availableRuntimes || []).filter(function(runtime) {
      return runtimeLanguage(runtime) === language && runtimeIdOf(runtime);
    });
  }

  function latestRuntimeForLanguage(language) {
    var candidates = runtimesForLanguage(language);
    if (!candidates.length) return null;
    return candidates.reduce(function(latest, candidate) {
      return !latest || compareRuntimeVersions(candidate, latest) > 0 ? candidate : latest;
    }, null);
  }

  function runtimeDisplayName(runtime) {
    return runtime && (runtime.displayName || runtime.version || runtimeIdOf(runtime)) || '';
  }

  function buildRuntimeMenu() {
    var menu = document.getElementById('runtime-menu');
    if (!menu) return;
    menu.innerHTML = '';

    // "Local" is a user-controlled mode, never an implicit fallback.
    var localRow = document.createElement('div');
    localRow.className = 'rt-cat';
    localRow.textContent = tr('Local (no Docker)');
    if (!normalizeRuntimeId(S.selectedRuntime)) localRow.classList.add('active');
    localRow.onclick = function() { selectRuntime(''); };
    menu.appendChild(localRow);

    var sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #00000033;margin:4px 0';
    menu.appendChild(sep);

    var preferredOrder = ['python', 'java', 'c', 'cpp', 'go', 'rust', 'node'];
    var availableLanguages = Object.keys(S.groupedRuntimes || {});
    var langOrder = preferredOrder.filter(function(language) { return availableLanguages.indexOf(language) >= 0; });
    availableLanguages.sort().forEach(function(language) {
      if (langOrder.indexOf(language) < 0) langOrder.push(language);
    });

    for (var li = 0; li < langOrder.length; li++) {
      var lang = langOrder[li];
      var versions = S.groupedRuntimes[lang];
      if (!versions || versions.length === 0) continue;

      var catRow = document.createElement('div');
      catRow.className = 'rt-cat';
      catRow.innerHTML = '<span></span><span>&#9654;</span>';
      catRow.firstChild.textContent = languageDisplayName(lang);
      catRow.onclick = (function(catRow) {
        return function(e) {
          e.stopPropagation();
          var wasExpanded = catRow.classList.contains('expanded');
          menu.querySelectorAll('.rt-cat.expanded').forEach(function(el) { el.classList.remove('expanded'); });
          if (!wasExpanded) catRow.classList.add('expanded');
        };
      })(catRow);

      var subMenu = document.createElement('div');
      subMenu.className = 'sub-menu';

      for (var vi = 0; vi < versions.length; vi++) {
        var ver = versions[vi];
        var verRow = document.createElement('div');
        verRow.className = 'rt-ver';
        verRow.textContent = ver.version;
        if (normalizeRuntimeId(S.selectedRuntime) === runtimeIdOf(ver)) verRow.classList.add('active');
        verRow.onclick = (function(runtimeId) {
          return function(e) {
            e.stopPropagation();
            selectRuntime(runtimeId);
          };
        })(runtimeIdOf(ver));
        subMenu.appendChild(verRow);
      }

      menu.appendChild(catRow);
      menu.appendChild(subMenu);
    }
  }

  function updateRuntimeButtonLabel() {
    var btn = document.getElementById('runtime-btn');
    if (!btn) return;
    var label = btn.querySelector('.runtime-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'runtime-label';
      btn.textContent = '';
      btn.appendChild(label);
    }
    var selectedRuntime = normalizeRuntimeId(S.selectedRuntime);
    if (!selectedRuntime) {
      label.textContent = tr('Local');
    } else {
      var runtime = runtimeForId(selectedRuntime);
      label.textContent = runtime ? runtimeDisplayName(runtime) : selectedRuntime;
    }
  }

  function closeRuntimeMenu() {
    var menu = document.getElementById('runtime-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closeRuntimeMenuOnClickOutside);
  }

  function applyRuntimeSelection(runtimeId, options) {
    options = options || {};
    runtimeId = normalizeRuntimeId(runtimeId);
    var previousRuntime = normalizeRuntimeId(S.selectedRuntime);
    var runtime = runtimeForId(runtimeId);
    S.selectedRuntime = runtimeId;
    saveRuntimePreference();
    if (runtime && options.rememberLanguage !== false) rememberLanguageRuntime(runtimeLanguage(runtime), runtimeId);
    updateRuntimeButtonLabel();
    buildRuntimeMenu();
    closeRuntimeMenu();

    if (previousRuntime !== runtimeId) {
      S.setupCommands = [];
      if (BOBO.lsp && BOBO.lsp.runtimeChanged) BOBO.lsp.runtimeChanged();
      if (BOBO.runConfig && BOBO.runConfig.refreshForActiveFile) BOBO.runConfig.refreshForActiveFile();
      if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('runtime');
    }
    if (options.log !== false && BOBO.updateRunOutput) {
      BOBO.updateRunOutput('[Runtime selected: ' + (runtimeId || 'Local') + ']');
    }
    return previousRuntime !== runtimeId;
  }

  function selectRuntime(runtimeId) {
    // Direct selector interactions are explicit user choices. They refresh the
    // remembered version for that language, while Local remains a global mode.
    legacyRuntimeId = '';
    return applyRuntimeSelection(runtimeId, { rememberLanguage: true, log: true });
  }

  function autoSelectForLanguage(language) {
    // Local is an explicit choice. File activation must never turn it back
    // into a Docker runtime.
    if (!normalizeRuntimeId(S.selectedRuntime)) return { changed: false, reason: 'local' };

    language = canonicalLanguage(language);
    if (!language) return { changed: false, reason: 'unsupported-language' };

    var candidates = runtimesForLanguage(language);
    if (!candidates.length) return { changed: false, reason: 'no-runtime' };

    var preferences = loadLanguagePreferences();
    var preferredId = normalizeRuntimeId(preferences[language]);
    var selected = preferredId && candidates.find(function(runtime) { return runtimeIdOf(runtime) === preferredId; });

    // Existing releases only saved one global runtime. Preserve it as the
    // first known preference for its own language when upgrading. New
    // automatic defaults deliberately do not become a version pin.
    if (!selected && !preferredId && legacyRuntimeId) {
      var current = runtimeForId(legacyRuntimeId);
      if (current && runtimeLanguage(current) === language) selected = current;
      if (selected) {
        rememberLanguageRuntime(language, runtimeIdOf(selected));
        legacyRuntimeId = '';
      }
    }

    var usedLatest = false;
    if (!selected) {
      selected = latestRuntimeForLanguage(language);
      usedLatest = true;
    }
    if (!selected) return { changed: false, reason: 'no-runtime' };

    var selectedId = runtimeIdOf(selected);
    var changed = applyRuntimeSelection(selectedId, { rememberLanguage: false, log: false });
    if (usedLatest && markAutoUsedLanguage(language) && BOBO.toast && BOBO.toast.info) {
      BOBO.toast.info(tr('Using the latest {language} runtime for this file: {runtime}', {
        language: languageDisplayName(language),
        runtime: runtimeDisplayName(selected)
      }));
    }
    return { changed: changed, runtimeId: selectedId, usedLatest: usedLatest };
  }

  function autoSelectForActiveFile() {
    var active = S.tabs && S.tabs.find(function(tab) { return tab.path === S.activeTabPath; });
    return active ? autoSelectForLanguage(active.language) : { changed: false, reason: 'no-active-file' };
  }

  async function fetchRuntimes() {
    if (!S.serverSettings.ip) return;
    try {
      // Multiple-user mode needs the authenticated request path; otherwise the
      // server returns 401 and the selector incorrectly falls back to Local.
      var result = await BOBO.sendToServer('listRuntimes', {}, { quiet: true });
      if (result && result.success && Array.isArray(result.runtimes)) {
        S.availableRuntimes = result.runtimes;
        S.groupedRuntimes = {};
        for (var i = 0; i < result.runtimes.length; i++) {
          var runtime = result.runtimes[i];
          var language = runtimeLanguage(runtime);
          if (!language || !runtimeIdOf(runtime)) continue;
          if (!S.groupedRuntimes[language]) S.groupedRuntimes[language] = [];
          S.groupedRuntimes[language].push(runtime);
        }
        buildRuntimeMenu();
        updateRuntimeButtonLabel();
        // File activation can precede the asynchronous runtime list request.
        // Reconcile the active file now that a real catalog is available.
        autoSelectForActiveFile();
        if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('runtimes-loaded');
      }
    } catch (e) {}
  }

  function toggleRuntimeMenu() {
    var menu = document.getElementById('runtime-menu');
    if (!menu) return;
    if (menu.style.display === 'none') {
      menu.style.display = 'block';
      setTimeout(function() { document.addEventListener('click', closeRuntimeMenuOnClickOutside); }, 0);
    } else {
      closeRuntimeMenu();
    }
  }

  function closeRuntimeMenuOnClickOutside(e) {
    var selector = document.getElementById('runtime-selector');
    if (!selector || !selector.contains(e.target)) closeRuntimeMenu();
  }

  function initRuntime() {
    loadSavedRuntime();
    var btn = document.getElementById('runtime-btn');
    if (btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleRuntimeMenu();
      });
    }
    updateRuntimeButtonLabel();
    buildRuntimeMenu();
  }

  BOBO.runtime = {
    init: initRuntime,
    fetchRuntimes: fetchRuntimes,
    selectRuntime: selectRuntime,
    autoSelectForLanguage: autoSelectForLanguage,
    autoSelectForActiveFile: autoSelectForActiveFile,
    _helpers: {
      canonicalLanguage: canonicalLanguage,
      compareRuntimeVersions: compareRuntimeVersions,
      latestRuntimeForLanguage: latestRuntimeForLanguage
    }
  };
})(window);
