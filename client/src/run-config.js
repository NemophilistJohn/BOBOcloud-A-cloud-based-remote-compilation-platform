// src/run-config.js - Per-workspace run configuration and cross-build preset.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var STORAGE_KEY = 'bobocloud.runconfig.v2';
  var LEGACY_STORAGE_KEY = 'bobocloud.runconfig.v1';
  var COMPILED_LANGS = { c: true, cpp: true, java: true, go: true, rust: true };
  var TARGET_LANGS = { c: true, cpp: true, go: true, rust: true };
  var LANG_NAMES = { c: 'C', cpp: 'C++', java: 'Java', go: 'Go', rust: 'Rust', python: 'Python', node: 'Node.js' };
  var EXT_LANG = {
    '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.java': 'java', '.go': 'go', '.rs': 'rust',
    '.py': 'python', '.js': 'node', '.mjs': 'node', '.cjs': 'node'
  };
  var FALLBACK_TARGETS = [
    { id: 'linux-x86_64', os: 'linux', architecture: 'x86_64', environment: 'hosted', outputPath: '.bobocloud/output', runnable: true },
    { id: 'linux-arm64', os: 'linux', architecture: 'arm64', environment: 'hosted', outputPath: 'artifacts/app_linux_arm64', runnable: false },
    { id: 'windows-x86_64', os: 'windows', architecture: 'x86_64', environment: 'hosted', outputPath: 'artifacts/app_windows_x86_64.exe', runnable: false },
    { id: 'cortex-m4', os: 'none', architecture: 'armv7e-m', environment: 'bare-metal-rtos', outputPath: 'artifacts/app_cortex_m4.elf', runnable: false }
  ];
  var NATIVE_TARGETS = [FALLBACK_TARGETS[0]];
  var TARGET_META = {
    'linux-x86_64': { label: 'Linux x86_64', toolchain: 'gcc / g++ / rustc' },
    'linux-arm64': { label: 'Linux ARM64', toolchain: 'aarch64-linux-gnu / Rust target' },
    'windows-x86_64': { label: 'Windows x86_64', toolchain: 'MinGW-w64 / Rust GNU target' },
    'cortex-m4': { label: 'Cortex-M4', toolchain: 'arm-none-eabi / thumbv7em-none-eabihf' }
  };
  var TARGET_SYSTEMS = { linux: 'Linux', windows: 'Windows', 'bare-metal-rtos': 'Bare metal / RTOS' };
  var targetCache = Object.create(null);
  var currentLang = null;

  function tr(source, replacements) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }
  function $(id) { return document.getElementById(id); }

  function languageForFile(filePath) {
    var match = /\.([A-Za-z0-9]+)$/.exec(filePath || '');
    return match ? EXT_LANG['.' + match[1].toLowerCase()] || null : null;
  }
  function configKey(lang) { return (S.workspaceRoot || '_global') + '|' + lang; }
  function loadAll() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw) || {};
      return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}') || {};
    } catch (_) { return {}; }
  }
  function saveAll(all) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch (_) {} }
  function normalizeRaw(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return { compile: String(raw.compile || ''), run: String(raw.run || ''), target: String(raw.target || 'linux-x86_64') };
  }
  function getRaw(lang) { return normalizeRaw(loadAll()[configKey(lang)]); }
  function setRaw(lang, data) {
    var all = loadAll();
    all[configKey(lang)] = normalizeRaw(data);
    saveAll(all);
  }
  function splitArgs(str) {
    var out = [], cur = '', quote = null, escaped = false;
    str = str || '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (escaped) { cur += ch; escaped = false; continue; }
      if (ch === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  function getArgs(lang) {
    var raw = getRaw(lang);
    return {
      compileArgs: splitArgs(raw.compile),
      runArgs: splitArgs(raw.run),
      // Native Linux is the compatibility default. Omitting it preserves Local
      // execution. A cross target is sent only after this server has confirmed
      // that its corresponding toolchain image is installed.
      buildTarget: TARGET_LANGS[lang] && S.selectedRuntime && isTargetReadyForRun(lang, raw.target) ? raw.target : ''
    };
  }

  function activeLanguage() {
    var active = S.tabs && S.tabs.find(function(tab) { return tab.path === S.activeTabPath; });
    return active ? languageForFile(active.path) : null;
  }
  function isConfigurable(lang) { return Boolean(lang && COMPILED_LANGS[lang]); }
  function targetLabel(target) { return tr((TARGET_META[target.id] || {}).label || target.id); }
  function targetSystem(target) { return target.environment === 'bare-metal-rtos' ? 'bare-metal-rtos' : target.os; }
  function targetSystemLabel(id) { return tr(TARGET_SYSTEMS[id] || id); }
  function fallbackTargetsFor(lang) {
    return FALLBACK_TARGETS.filter(function(target) {
      return (lang !== 'rust' && lang !== 'go') || target.id !== 'cortex-m4';
    });
  }
  function targetCacheKey(lang) { return String(lang || '') + '|' + String(S.selectedRuntime || 'local'); }
  function targetsFor(lang) {
    var cache = targetCache[targetCacheKey(lang)];
    return cache && Array.isArray(cache.targets) && cache.targets.length ? cache.targets : fallbackTargetsFor(lang);
  }
  function isTargetReadyForRun(lang, targetID) {
    if (!targetID || targetID === 'linux-x86_64') return false;
    var cache = targetCache[targetCacheKey(lang)];
    return Boolean(cache && !cache.promise && Array.isArray(cache.targets) &&
      cache.targets.some(function(target) { return target.id === targetID; }));
  }
  function loadTargets(lang) {
    if (!TARGET_LANGS[lang] || !BOBO.sendToServer) return Promise.resolve(targetsFor(lang));
    var key = targetCacheKey(lang);
    var existing = targetCache[key];
    if (existing && existing.promise) return existing.promise;
    var promise = Promise.resolve(BOBO.sendToServer('listBuildTargets', { language: lang, runtime: S.selectedRuntime || '' }, { quiet: true }))
      .then(function(result) {
        var targets = result && Array.isArray(result.buildTargets) ? result.buildTargets : [];
        targetCache[key] = { targets: targets.length ? targets : NATIVE_TARGETS.slice(), error: targets.length ? '' : 'empty' };
        return targetCache[key].targets;
      })
      .catch(function() {
        targetCache[key] = { targets: NATIVE_TARGETS.slice(), error: 'unavailable' };
        return targetCache[key].targets;
      });
    targetCache[key] = { targets: existing && existing.targets || fallbackTargetsFor(lang), promise: promise };
    return promise;
  }
  function clearOptions(select) { while (select && select.firstChild) select.removeChild(select.firstChild); }
  function option(value, text) {
    var item = document.createElement('option');
    item.value = value;
    item.textContent = text;
    return item;
  }
  function selectedTarget(targets, raw) {
    return targets.find(function(item) { return item.id === raw.target; }) ||
      targets.find(function(item) { return item.id === 'linux-x86_64'; }) || targets[0] || null;
  }
  function renderTargetControls() {
    var field = $('rc-target-field');
    if (!field) return;
    if (!TARGET_LANGS[currentLang]) { field.hidden = true; return; }
    field.hidden = false;
    var raw = getRaw(currentLang);
    var targets = targetsFor(currentLang);
    var selected = selectedTarget(targets, raw);
    if (!selected) return;
    var systemSelect = $('rc-target-system');
    var archSelect = $('rc-target-arch');
    var system = targetSystem(selected);
    clearOptions(systemSelect);
    var seen = Object.create(null);
    targets.forEach(function(target) {
      var id = targetSystem(target);
      if (!seen[id]) { seen[id] = true; systemSelect.appendChild(option(id, targetSystemLabel(id))); }
    });
    systemSelect.value = system;
    clearOptions(archSelect);
    targets.filter(function(target) { return targetSystem(target) === system; }).forEach(function(target) {
      archSelect.appendChild(option(target.id, targetLabel(target)));
    });
    archSelect.value = selected.id;
    var meta = TARGET_META[selected.id] || {};
    $('rc-target-toolchain').textContent = targetToolchain(currentLang, selected, meta);
    $('rc-target-output').textContent = selected.outputPath || '.bobocloud/output';
    $('rc-target-mode').textContent = selected.runnable ? tr('Runs in cloud') : tr('Build only - returned as an artifact');
    $('rc-target-mode').className = 'rc-target-mode ' + (selected.runnable ? 'is-runnable' : 'is-artifact');
  }
  function targetToolchain(lang, target, meta) {
    if (lang !== 'go') return meta.toolchain || target.id;
    if (target.id === 'linux-x86_64') return 'go build';
    return 'GOOS=' + target.os + ' GOARCH=' + (target.architecture === 'x86_64' ? 'amd64' : target.architecture) + ' CGO_ENABLED=0 go build';
  }
  function updateSelectedTarget(id) {
    if (!currentLang) return;
    var raw = getRaw(currentLang);
    raw.target = id;
    setRaw(currentLang, raw);
    renderTargetControls();
  }
  function onSystemChange() {
    var chosenSystem = $('rc-target-system').value;
    var target = targetsFor(currentLang).find(function(item) { return targetSystem(item) === chosenSystem; });
    if (target) updateSelectedTarget(target.id);
  }
  function onTargetChange() { updateSelectedTarget($('rc-target-arch').value); }

  function positionPopover() {
    var pop = $('run-config-pop');
    var btn = $('run-config-btn');
    if (!pop || !btn) return;
    var rect = btn.getBoundingClientRect();
    var width = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(rect.right - width, global.innerWidth - width - 8)) + 'px';
    pop.style.top = (rect.bottom + 6) + 'px';
  }
  function openPopover() {
    var pop = $('run-config-pop');
    currentLang = activeLanguage();
    if (!isConfigurable(currentLang)) return;
    var raw = getRaw(currentLang);
    $('rc-lang').textContent = '- ' + (LANG_NAMES[currentLang] || currentLang);
    $('rc-compile-args').value = raw.compile;
    $('rc-run-args').value = raw.run;
    $('rc-hint').textContent = tr('Saved per workspace and language. Changes apply to the next run.');
    pop.style.display = 'block';
    renderTargetControls();
    positionPopover();
    loadTargets(currentLang).then(function() {
      if (pop.style.display === 'block' && currentLang === activeLanguage()) { renderTargetControls(); positionPopover(); }
    });
    setTimeout(function() { document.addEventListener('pointerdown', onPointerDown, true); }, 0);
  }
  function closePopover() {
    var pop = $('run-config-pop');
    if (pop) pop.style.display = 'none';
    document.removeEventListener('pointerdown', onPointerDown, true);
  }
  function onPointerDown(event) {
    var pop = $('run-config-pop');
    if (pop && !pop.contains(event.target) && !event.target.closest('#run-config-btn')) closePopover();
  }
  function onInput() {
    if (!currentLang) return;
    var raw = getRaw(currentLang);
    raw.compile = $('rc-compile-args').value;
    raw.run = $('rc-run-args').value;
    setRaw(currentLang, raw);
  }
  function refreshForActiveFile() {
    var btn = $('run-config-btn');
    if (!btn) return;
    var lang = activeLanguage();
    // A configuration draft belongs to one language. Keeping the popover
    // open while changing files would show the previous language's targets.
    if (currentLang && currentLang !== lang) closePopover();
    btn.hidden = !isConfigurable(lang);
    if (!isConfigurable(lang)) closePopover();
  }
  function init() {
    var btn = $('run-config-btn');
    if (!btn) return;
    btn.addEventListener('click', function(event) {
      event.stopPropagation();
      if ($('run-config-pop').style.display === 'block') closePopover(); else openPopover();
    });
    $('rc-compile-args').addEventListener('input', onInput);
    $('rc-run-args').addEventListener('input', onInput);
    $('rc-target-system').addEventListener('change', onSystemChange);
    $('rc-target-arch').addEventListener('change', onTargetChange);
    $('run-config-pop').addEventListener('keydown', function(event) {
      if (event.key === 'Escape') { event.preventDefault(); closePopover(); btn.focus(); }
      event.stopPropagation();
    });
    global.addEventListener('resize', function() { if ($('run-config-pop').style.display === 'block') positionPopover(); });
    if (BOBO.i18n && BOBO.i18n.onChange) {
      BOBO.i18n.onChange(function() { if ($('run-config-pop').style.display === 'block') renderTargetControls(); });
    }
    refreshForActiveFile();
  }

  BOBO.runConfig = {
    init: init,
    languageForFile: languageForFile,
    getArgs: getArgs,
    describeTarget: function(id) { return targetLabel({ id: id }); },
    refreshForActiveFile: refreshForActiveFile,
    close: closePopover,
    _splitArgs: splitArgs
  };
})(window);
