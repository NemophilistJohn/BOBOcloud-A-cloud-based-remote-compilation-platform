// src/file-search.js - Ctrl+P file fuzzy finder
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  var overlay = null;
  var input = null;
  var list = null;
  var cachedFiles = [];   // [{path, name, dir}]
  var selectedIndex = 0;
  var filtered = [];
  var cachedTree = null;

  function t(source, params) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, params);
    return source;
  }

  // Flatten the file tree into a searchable list
  function flattenTree(tree) {
    var result = [];
    function walk(node) {
      if (!node) return;
      if (node.type === 'file') {
        var parts = (node.path || '').split(/[/\\]/);
        result.push({
          path: node.path,
          name: node.name || parts[parts.length - 1],
          dir: parts.slice(0, -1).join('/')
        });
      }
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
          walk(node.children[i]);
        }
      }
    }
    walk(tree);
    return result;
  }

  function refreshCache(force) {
    var tree = S.workspaceTree;
    if (!S.workspaceRoot || !tree) {
      cachedTree = null;
      cachedFiles = [];
      return;
    }
    if (!force && cachedTree === tree) return;
    cachedTree = tree;
    cachedFiles = flattenTree(tree);
  }

  // Fuzzy match: returns score (higher = better) or -1 for no match
  function fuzzyMatch(query, text) {
    query = query.toLowerCase();
    text = text.toLowerCase();
    if (!query) return 0;

    var score = 0;
    var qi = 0;
    var prevMatch = false;

    for (var ti = 0; ti < text.length && qi < query.length; ti++) {
      if (text[ti] === query[qi]) {
        // Bonus for consecutive matches
        score += prevMatch ? 3 : 1;
        // Bonus for matching at word boundary (after /, _, -, .)
        if (ti === 0 || '/_-.'.indexOf(text[ti - 1]) !== -1) {
          score += 5;
        }
        qi++;
        prevMatch = true;
      } else {
        prevMatch = false;
      }
    }

    return qi === query.length ? score : -1;
  }

  function filter() {
    var q = input.value.trim();
    refreshCache(false);

    if (!q) {
      // Show recently open tabs first, then all files
      filtered = [];
      if (S.tabs && S.tabs.length > 0) {
        for (var i = 0; i < S.tabs.length; i++) {
          var t = S.tabs[i];
          var parts = (t.path || '').split(/[/\\]/);
          filtered.push({
            path: t.path,
            name: t.name,
            dir: parts.slice(0, -1).join('/'),
            score: 1000 - i  // recent tabs get high score
          });
        }
      }
      // Add all files not in tabs
      for (var j = 0; j < cachedFiles.length; j++) {
        var f = cachedFiles[j];
        if (!S.tabs || !S.tabs.find(function(t) { return t.path === f.path; })) {
          filtered.push(f);
        }
      }
    } else {
      filtered = [];
      for (var i = 0; i < cachedFiles.length; i++) {
        var f = cachedFiles[i];
        // Match against filename (primary) and full path (secondary)
        var nameScore = fuzzyMatch(q, f.name);
        var pathScore = nameScore >= 0 ? nameScore : fuzzyMatch(q, f.path);
        var score = Math.max(nameScore, pathScore);
        if (score >= 0) {
          filtered.push({
            path: f.path,
            name: f.name,
            dir: f.dir,
            score: score
          });
        }
      }
      filtered.sort(function(a, b) { return b.score - a.score; });
    }

    selectedIndex = 0;
    render();
  }

  function render() {
    list.innerHTML = '';
    if (filtered.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'cmd-empty';
      empty.textContent = t('No matching files');
      list.appendChild(empty);
      return;
    }
    var max = Math.min(filtered.length, 50);
    for (var i = 0; i < max; i++) {
      (function(item, idx) {
        var el = document.createElement('div');
        el.className = 'cmd-item' + (idx === selectedIndex ? ' selected' : '');
        var label = document.createElement('span');
        label.className = 'cmd-label';
        label.textContent = item.name;
        el.appendChild(label);
        if (item.dir) {
          var hint = document.createElement('span');
          hint.className = 'cmd-hint';
          hint.textContent = item.dir;
          el.appendChild(hint);
        }
        el.addEventListener('click', function() {
          selectedIndex = idx;
          openSelected();
        });
        list.appendChild(el);
      })(filtered[i], i);
    }
  }

  function navigate(dir) {
    if (filtered.length === 0) return;
    selectedIndex += dir;
    if (selectedIndex < 0) selectedIndex = 0;
    if (selectedIndex >= Math.min(filtered.length, 50)) selectedIndex = Math.min(filtered.length, 50) - 1;
    render();
  }

  function openSelected() {
    if (filtered.length === 0 || selectedIndex >= filtered.length) return;
    var item = filtered[selectedIndex];
    hide();
    if (BOBO.workspace && BOBO.workspace.openFile) {
      BOBO.workspace.openFile(item.path, item.name);
    }
  }

  function ensureDOM() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'cmd-palette-overlay';

    var palette = document.createElement('div');
    palette.className = 'cmd-palette';

    var inputWrap = document.createElement('div');
    inputWrap.className = 'cmd-input-wrap';
    input = document.createElement('input');
    input.className = 'cmd-input';
    input.placeholder = t('Search files by name...');
    inputWrap.appendChild(input);

    list = document.createElement('div');
    list.className = 'cmd-list';

    palette.appendChild(inputWrap);
    palette.appendChild(list);
    overlay.appendChild(palette);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) hide();
    });
    input.addEventListener('input', function() { filter(); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); navigate(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigate(-1); }
      if (e.key === 'Enter') { e.preventDefault(); openSelected(); }
    });

    document.body.appendChild(overlay);
  }

  function show() {
    ensureDOM();
    input.value = '';
    filter();
    overlay.classList.add('open');
    setTimeout(function() { input.focus(); }, 50);
  }

  function hide() {
    if (overlay) overlay.classList.remove('open');
  }

  global.addEventListener('bobo:language-changed', function() {
    if (input) input.placeholder = t('Search files by name...');
    if (overlay && overlay.classList.contains('open')) filter();
  });

  BOBO.fileSearch = {
    show: show,
    hide: hide,
    refreshCache: refreshCache
  };
})(window);
