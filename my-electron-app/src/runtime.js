// src/runtime.js — Runtime selector dropdown
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  function loadSavedRuntime() {
    try {
      var saved = localStorage.getItem('bobocloud.runtime');
      if (saved) S.selectedRuntime = saved;
    } catch (e) {}
  }

  function saveRuntimePreference() {
    try {
      localStorage.setItem('bobocloud.runtime', S.selectedRuntime);
    } catch (e) {}
  }

  async function fetchRuntimes() {
    if (!S.serverSettings.ip) return;
    try {
      // 多人模式下 listRuntimes 需要登录态：走 sendToServer 以携带 Authorization 头，
      // 否则服务端返回 401，运行时列表为空，下拉框只剩 Local。
      var result = await BOBO.sendToServer('listRuntimes', {}, { quiet: true });
      if (result && result.success && result.runtimes) {
        S.availableRuntimes = result.runtimes;
        S.groupedRuntimes = {};
        for (var i = 0; i < result.runtimes.length; i++) {
          var rt = result.runtimes[i];
          if (!S.groupedRuntimes[rt.language]) S.groupedRuntimes[rt.language] = [];
          S.groupedRuntimes[rt.language].push(rt);
        }
        buildRuntimeMenu();
        updateRuntimeButtonLabel();
        if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('runtimes-loaded');
      }
    } catch (e) {}
  }

  function buildRuntimeMenu() {
    var menu = document.getElementById('runtime-menu');
    menu.innerHTML = '';

    // "Local" option
    var localRow = document.createElement('div');
    localRow.className = 'rt-cat';
    localRow.innerHTML = '<span>Local (no Docker)</span>';
    if (S.selectedRuntime === '') localRow.classList.add('active');
    localRow.onclick = function() { selectRuntime(''); };
    menu.appendChild(localRow);

    var sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #00000033;margin:4px 0';
    menu.appendChild(sep);

    var preferredOrder = ['python', 'java', 'c', 'cpp', 'go', 'rust', 'node'];
    var availableLanguages = Object.keys(S.groupedRuntimes);
    var langOrder = preferredOrder.filter(function(language) { return availableLanguages.indexOf(language) >= 0; });
    availableLanguages.sort().forEach(function(language) {
      if (langOrder.indexOf(language) < 0) langOrder.push(language);
    });
    var langNames = { python: 'Python', java: 'Java', c: 'C', cpp: 'C++', go: 'Go', rust: 'Rust', node: 'Node.js' };

    for (var li = 0; li < langOrder.length; li++) {
      var lang = langOrder[li];
      var versions = S.groupedRuntimes[lang];
      if (!versions || versions.length === 0) continue;

      var catRow = document.createElement('div');
      catRow.className = 'rt-cat';
      var languageName = langNames[lang] || (lang.charAt(0).toUpperCase() + lang.slice(1));
      catRow.innerHTML = '<span>' + languageName + '</span><span>&#9654;</span>';
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
        if (S.selectedRuntime === ver.runtimeId) verRow.classList.add('active');
        verRow.onclick = (function(runtimeId) {
          return function(e) {
            e.stopPropagation();
            selectRuntime(runtimeId);
          };
        })(ver.runtimeId);
        subMenu.appendChild(verRow);
      }

      menu.appendChild(catRow);
      menu.appendChild(subMenu);
    }
  }

  function selectRuntime(runtimeId) {
    S.selectedRuntime = runtimeId;
    saveRuntimePreference();
    updateRuntimeButtonLabel();
    closeRuntimeMenu();
    S.setupCommands = [];
    if (BOBO.lsp && BOBO.lsp.runtimeChanged) BOBO.lsp.runtimeChanged();
    if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('runtime');
    BOBO.updateRunOutput('[Runtime selected: ' + (runtimeId || 'Local') + ']');
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
    if (S.selectedRuntime === '') {
      label.textContent = 'Local';
    } else {
      var rt = S.availableRuntimes.find(function(r) { return r.runtimeId === S.selectedRuntime; });
      label.textContent = rt ? rt.displayName : S.selectedRuntime;
    }
  }

  function toggleRuntimeMenu() {
    var menu = document.getElementById('runtime-menu');
    if (menu.style.display === 'none') {
      menu.style.display = 'block';
      setTimeout(function() { document.addEventListener('click', closeRuntimeMenuOnClickOutside); }, 0);
    } else {
      closeRuntimeMenu();
    }
  }

  function closeRuntimeMenu() {
    document.getElementById('runtime-menu').style.display = 'none';
    document.removeEventListener('click', closeRuntimeMenuOnClickOutside);
  }

  function closeRuntimeMenuOnClickOutside(e) {
    var sel = document.getElementById('runtime-selector');
    if (!sel.contains(e.target)) closeRuntimeMenu();
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
    selectRuntime: selectRuntime
  };
})(window);
