// src/file-search.js - Persistent Quick Open search in the primary sidebar.
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  var HISTORY_PREFIX = 'bobocloud.quickFileHistory.v1:';
  var HISTORY_LIMIT = 12;
  var SUGGESTION_LIMIT = 8;
  var RESULT_LIMIT = 50;
  var IMPORTANT_FILES = [
    'readme.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', 'makefile'
  ];
  var input = null;
  var results = null;
  var status = null;
  var cachedFiles = [];
  var cachedTree = null;
  var cachedRoot = '';
  var selectedIndex = 0;
  var visibleItems = [];

  function t(source, params) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, params);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return params && params[key] !== undefined ? params[key] : match;
    });
  }

  function normalizedPath(value) {
    var normalized = String(value || '').replace(/\\/g, '/');
    return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  }

  function relativePath(filePath, rootPath) {
    var file = String(filePath || '').replace(/\\/g, '/');
    var root = String(rootPath || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedPath(file).indexOf(normalizedPath(root) + '/') === 0) {
      return file.slice(root.length + 1);
    }
    return file.split('/').pop() || file;
  }

  function flattenTree(tree) {
    var flattened = [];
    function walk(node) {
      if (!node) return;
      if (node !== tree && BOBO.workspaceSettings && BOBO.workspaceSettings.isPathExcluded &&
          BOBO.workspaceSettings.isPathExcluded(node.path)) return;
      if (node.type === 'file') {
        var relative = relativePath(node.path, tree.path);
        var parts = relative.split('/');
        var name = node.name || parts[parts.length - 1];
        var lowerName = String(name || '').toLowerCase();
        var importantIndex = IMPORTANT_FILES.indexOf(lowerName);
        var suggestionBase = importantIndex >= 0 ? 400 - importantIndex : 0;
        if (/^(?:main|index|app|application|program)\.[a-z0-9]+$/.test(lowerName)) suggestionBase += 260;
        suggestionBase += Math.max(0, 80 - (parts.length - 1) * 20);
        flattened.push({
          path: node.path,
          normalizedPath: normalizedPath(node.path),
          name: name,
          dir: parts.slice(0, -1).join('/'),
          relativePath: relative,
          searchName: lowerName,
          searchPath: relative.toLowerCase(),
          suggestionBase: suggestionBase
        });
      }
      (node.children || []).forEach(walk);
    }
    walk(tree);
    return flattened;
  }

  function rebuildCache(force) {
    var tree = S.workspaceTree;
    var root = S.workspaceRoot || '';
    if (!root || !tree) {
      var hadWorkspace = Boolean(cachedRoot);
      cachedTree = null;
      cachedRoot = '';
      cachedFiles = [];
      if (hadWorkspace && input) input.value = '';
      return;
    }
    if (!force && cachedTree === tree && cachedRoot === root) return;
    var rootChanged = cachedRoot && cachedRoot !== root;
    cachedTree = tree;
    cachedRoot = root;
    cachedFiles = flattenTree(tree);
    if (rootChanged && input) input.value = '';
  }

  function storageKey() {
    if (!S.workspaceRoot) return '';
    return HISTORY_PREFIX + encodeURIComponent(normalizedPath(S.workspaceRoot));
  }

  function currentFileMap() {
    var files = new Map();
    cachedFiles.forEach(function(file) { files.set(file.normalizedPath, file); });
    return files;
  }

  function readHistory() {
    var key = storageKey();
    if (!key) return [];
    var paths = [];
    try {
      var value = JSON.parse(global.localStorage.getItem(key) || '[]');
      if (Array.isArray(value)) paths = value;
    } catch (error) {}
    var files = currentFileMap();
    var seen = new Set();
    var history = [];
    paths.forEach(function(filePath) {
      var normalized = normalizedPath(filePath);
      var file = files.get(normalized);
      if (!file || seen.has(normalized)) return;
      seen.add(normalized);
      history.push(file);
    });
    return history.slice(0, HISTORY_LIMIT);
  }

  function writeHistory(items) {
    var key = storageKey();
    if (!key) return;
    try {
      global.localStorage.setItem(key, JSON.stringify(items.slice(0, HISTORY_LIMIT).map(function(item) { return item.path; })));
    } catch (error) {}
  }

  function recordHistory(item) {
    var target = item && item.normalizedPath || normalizedPath(item && item.path);
    if (!target) return;
    var next = [item].concat(readHistory().filter(function(entry) {
      return entry.normalizedPath !== target;
    }));
    writeHistory(next);
  }

  function clearHistory() {
    var key = storageKey();
    if (key) {
      try { global.localStorage.removeItem(key); } catch (error) {}
    }
    filter();
    if (input) input.focus();
  }

  function fuzzyMatch(query, text) {
    if (!query) return 0;
    var score = 0;
    var queryIndex = 0;
    var previousMatch = false;
    for (var textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex++) {
      if (text[textIndex] === query[queryIndex]) {
        score += previousMatch ? 3 : 1;
        if (textIndex === 0 || '/_-.'.indexOf(text[textIndex - 1]) !== -1) score += 5;
        queryIndex += 1;
        previousMatch = true;
      } else {
        previousMatch = false;
      }
    }
    return queryIndex === query.length ? score : -1;
  }

  function compareMatches(left, right) {
    return right.score - left.score || left.file.relativePath.localeCompare(right.file.relativePath);
  }

  function insertBoundedMatch(matches, match, limit) {
    if (matches.length === limit && compareMatches(match, matches[matches.length - 1]) >= 0) return;
    var low = 0;
    var high = matches.length;
    while (low < high) {
      var middle = (low + high) >>> 1;
      if (compareMatches(match, matches[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    matches.splice(low, 0, match);
    if (matches.length > limit) matches.pop();
  }

  function searchFiles(query) {
    var normalizedQuery = String(query || '').toLowerCase();
    var matches = [];
    cachedFiles.forEach(function(file) {
      var nameScore = fuzzyMatch(normalizedQuery, file.searchName);
      var pathScore = fuzzyMatch(normalizedQuery, file.searchPath);
      var score = Math.max(nameScore >= 0 ? nameScore + 4 : -1, pathScore);
      if (score >= 0) insertBoundedMatch(matches, { file: file, score: score }, RESULT_LIMIT);
    });
    return matches.map(function(match) { return match.file; });
  }

  function suggestionScore(file, tabRanks) {
    var score = file.suggestionBase;
    var tabIndex = tabRanks.has(file.normalizedPath) ? tabRanks.get(file.normalizedPath) : -1;
    if (tabIndex >= 0) score += 600 - tabIndex;
    return score;
  }

  function suggestedFiles(excluded) {
    var tabRanks = new Map();
    (S.tabs || []).forEach(function(tab, index) {
      var path = normalizedPath(tab && tab.path);
      if (path && !tabRanks.has(path)) tabRanks.set(path, index);
    });
    var suggestions = [];
    cachedFiles.forEach(function(file) {
      if (excluded.has(file.normalizedPath)) return;
      insertBoundedMatch(suggestions, { file: file, score: suggestionScore(file, tabRanks) }, SUGGESTION_LIMIT);
    });
    return suggestions.map(function(entry) { return entry.file; });
  }

  function createFileIcon(file) {
    var icon = document.createElement('span');
    icon.className = 'file-search-result-icon';
    var iconPath = BOBO.fileIcons && BOBO.fileIcons.getFileIcon && BOBO.fileIcons.getFileIcon(file.name);
    if (iconPath) {
      var image = document.createElement('img');
      image.src = iconPath;
      image.alt = '';
      icon.appendChild(image);
    } else if (BOBO.icons && BOBO.icons.file) {
      icon.innerHTML = BOBO.icons.file;
    }
    return icon;
  }

  function appendFile(section, file) {
    var itemIndex = visibleItems.length;
    visibleItems.push(file);
    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'quick-file-search-result-' + itemIndex;
    button.className = 'file-search-result' + (itemIndex === selectedIndex ? ' selected' : '');
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', itemIndex === selectedIndex ? 'true' : 'false');
    button.setAttribute('data-path', file.path);
    button.title = file.relativePath;
    button.appendChild(createFileIcon(file));

    var copy = document.createElement('span');
    copy.className = 'file-search-result-copy';
    var name = document.createElement('span');
    name.className = 'file-search-result-name';
    name.textContent = file.name;
    copy.appendChild(name);
    if (file.dir) {
      var directory = document.createElement('span');
      directory.className = 'file-search-result-dir';
      directory.textContent = file.dir;
      copy.appendChild(directory);
    }
    button.appendChild(copy);
    button.addEventListener('click', function() {
      selectedIndex = itemIndex;
      openSelected();
    });
    section.appendChild(button);
  }

  function appendSection(title, items, options) {
    if (!items.length) return;
    var section = document.createElement('section');
    section.className = 'file-search-section';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', t(title));
    section.setAttribute('data-search-section', options && options.kind || 'results');
    var heading = document.createElement('div');
    heading.className = 'file-search-section-heading';
    var label = document.createElement('strong');
    label.textContent = t(title);
    heading.appendChild(label);
    if (options && options.clearHistory) {
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'file-search-clear-history';
      clear.title = t('Clear search history');
      clear.setAttribute('aria-label', t('Clear search history'));
      if (BOBO.icons && BOBO.icons.trash) clear.innerHTML = BOBO.icons.trash;
      clear.addEventListener('click', clearHistory);
      heading.appendChild(clear);
    }
    section.appendChild(heading);
    items.forEach(function(file) { appendFile(section, file); });
    results.appendChild(section);
  }

  function renderEmpty(message, withOpenAction) {
    var empty = document.createElement('div');
    empty.className = 'file-search-empty';
    if (BOBO.icons && BOBO.icons.search) {
      var icon = document.createElement('span');
      icon.className = 'file-search-empty-icon';
      icon.innerHTML = BOBO.icons.search;
      empty.appendChild(icon);
    }
    var copy = document.createElement('span');
    copy.textContent = t(message);
    empty.appendChild(copy);
    if (withOpenAction) {
      var open = document.createElement('button');
      open.type = 'button';
      open.textContent = t('Open Folder');
      open.addEventListener('click', function() {
        if (BOBO.workspaceLaunch) BOBO.workspaceLaunch.requestOpen();
      });
      empty.appendChild(open);
    }
    results.appendChild(empty);
  }

  function syncSelection() {
    var buttons = results ? results.querySelectorAll('.file-search-result') : [];
    Array.prototype.forEach.call(buttons, function(button, index) {
      var selected = index === selectedIndex;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) {
        input.setAttribute('aria-activedescendant', button.id);
        button.scrollIntoView({ block: 'nearest' });
      }
    });
    if (!buttons.length) input.removeAttribute('aria-activedescendant');
  }

  function render() {
    if (!input || !results) return;
    results.innerHTML = '';
    visibleItems = [];
    var query = input.value.trim();
    if (!S.workspaceRoot || !S.workspaceTree) {
      renderEmpty('Open a folder to search files.', true);
      status.textContent = t('Open a folder to search files.');
      input.disabled = true;
      return;
    }
    input.disabled = false;
    if (query) {
      var matches = searchFiles(query);
      if (matches.length) appendSection('Search results', matches, { kind: 'results' });
      else renderEmpty('No matching files', false);
      status.textContent = matches.length ? t('Search results: {count}', { count: matches.length }) : t('No matching files');
    } else {
      var recent = readHistory();
      var recentPaths = new Set(recent.map(function(file) { return file.normalizedPath; }));
      var suggestions = suggestedFiles(recentPaths);
      appendSection('Recently opened', recent, { kind: 'recent', clearHistory: true });
      appendSection('Suggested files', suggestions, { kind: 'suggested' });
      if (!recent.length && !suggestions.length) renderEmpty('Start typing to search your workspace.', false);
      status.textContent = t('{count} files available', { count: cachedFiles.length });
    }
    if (visibleItems.length === 0) selectedIndex = 0;
    else selectedIndex = Math.max(0, Math.min(selectedIndex, visibleItems.length - 1));
    syncSelection();
  }

  function filter() {
    rebuildCache(false);
    selectedIndex = 0;
    render();
  }

  function navigate(direction) {
    if (!visibleItems.length) return;
    selectedIndex = (selectedIndex + direction + visibleItems.length) % visibleItems.length;
    syncSelection();
  }

  function openSelected() {
    var item = visibleItems[selectedIndex];
    if (!item) return;
    recordHistory(item);
    if (BOBO.workspace && BOBO.workspace.openFile) BOBO.workspace.openFile(item.path, item.name);
    if (!input.value.trim()) render();
  }

  function ensureDOM() {
    if (input) return;
    input = document.getElementById('quick-file-search-input');
    results = document.getElementById('quick-file-search-results');
    status = document.getElementById('quick-file-search-status');
    if (!input || !results || !status) return;
    input.addEventListener('input', filter);
    input.addEventListener('keydown', function(event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); navigate(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); navigate(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); openSelected(); }
      else if (event.key === 'Escape') {
        event.preventDefault();
        if (input.value) {
          input.value = '';
          filter();
        } else {
          hide();
        }
      }
    });
    filter();
  }

  function show() {
    ensureDOM();
    if (BOBO.workbench) BOBO.workbench.setPrimaryView('search');
    filter();
    setTimeout(function() { if (input && !input.disabled) input.focus(); }, 0);
  }

  function hide() {
    if (BOBO.workbench) BOBO.workbench.setPrimaryView('explorer');
  }

  function refreshCache(force) {
    rebuildCache(force === true);
    if (input) render();
  }

  global.addEventListener('bobo:language-changed', function() {
    if (input) render();
  });
  global.addEventListener('bobo:workspace-changed', function() {
    refreshCache(true);
  });

  BOBO.fileSearch = {
    show: show,
    hide: hide,
    refreshCache: refreshCache
  };
})(window);
