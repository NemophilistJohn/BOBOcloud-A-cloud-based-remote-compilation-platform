// src/workspace-launch.js - Capture workspace-open requests before the editor is ready.
(function(global) {
  var BOBO = global.BOBO = global.BOBO || {};
  var consumer = null;
  var pending = [];
  var draining = null;
  var requestPromise = null;
  var initialized = false;
  var busy = false;
  var RECENT_STORAGE_KEY = 'bobocloud.recentProjects.v1';
  var RECENT_LIMIT = 5;

  function cleanPath(value) {
    var path = typeof value === 'string' ? value.trim().slice(0, 4096) : '';
    while (path.length > 1 && /[/\\]$/.test(path) && !/^[A-Za-z]:[/\\]$/.test(path)) path = path.slice(0, -1);
    return path;
  }

  function pathKey(value) {
    var path = cleanPath(value);
    if (/^[A-Za-z]:[/\\]/.test(path) || /^\\\\/.test(path)) return path.replace(/\//g, '\\').toLowerCase();
    return path.replace(/\\/g, '/');
  }

  function projectName(value) {
    var path = cleanPath(value);
    var parts = path.split(/[/\\]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
  }

  function displayPath(value) {
    var path = cleanPath(value);
    var limit = 44;
    if (path.length <= limit) return path;
    var separator = path.indexOf('\\') >= 0 ? '\\' : '/';
    var parts = path.split(/[/\\]/).filter(Boolean);
    var tail = [];
    for (var index = parts.length - 1; index >= 0; index -= 1) {
      var candidate = [parts[index]].concat(tail).join(separator);
      if (tail.length && candidate.length + 3 + separator.length > limit) break;
      tail.unshift(parts[index]);
    }
    var compact = tail.join(separator);
    if (compact.length + 3 + separator.length > limit) compact = compact.slice(-(limit - 3 - separator.length));
    return '...' + separator + compact;
  }

  function readRecentProjects() {
    try {
      var parsed = JSON.parse(global.localStorage && global.localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      var seen = Object.create(null);
      return parsed.map(cleanPath).filter(function(path) {
        var key = pathKey(path);
        if (!key || seen[key]) return false;
        seen[key] = true;
        return true;
      }).slice(0, RECENT_LIMIT);
    } catch (error) {
      return [];
    }
  }

  function writeRecentProjects(projects) {
    var next = projects.slice(0, RECENT_LIMIT);
    try {
      if (global.localStorage) global.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    } catch (error) {}
    return next;
  }

  function translate(key, replacements) {
    return BOBO.i18n && typeof BOBO.i18n.t === 'function' ? BOBO.i18n.t(key, replacements) : key;
  }

  function refreshRecentProjectTranslations() {
    if (typeof document.querySelectorAll !== 'function') return;
    Array.prototype.forEach.call(document.querySelectorAll('.recent-project-remove'), function(button) {
      var name = button.getAttribute('data-project-name') || '';
      var label = translate('Remove {name} from recent projects', { name: name });
      button.title = label;
      button.setAttribute('aria-label', label);
    });
  }

  function renderRecentProjects() {
    var section = document.getElementById('recent-projects');
    var list = document.getElementById('recent-project-list');
    if (!section || !list || typeof document.createElement !== 'function') return;
    var projects = readRecentProjects();
    section.hidden = projects.length === 0;
    list.replaceChildren();
    projects.forEach(function(path) {
      var name = projectName(path);
      var row = document.createElement('div');
      row.className = 'recent-project-row';
      row.setAttribute('role', 'listitem');

      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'recent-project-open';
      open.title = path;
      open.setAttribute('aria-label', name + ' - ' + path);
      open.disabled = busy;
      open.addEventListener('click', function() { requestOpen(path); });

      var nameNode = document.createElement('span');
      nameNode.className = 'recent-project-name';
      nameNode.textContent = name;
      var pathNode = document.createElement('span');
      pathNode.className = 'recent-project-path';
      pathNode.textContent = displayPath(path);
      open.append(nameNode, pathNode);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'recent-project-remove';
      remove.setAttribute('data-project-name', name);
      remove.disabled = busy;
      var removeLabel = translate('Remove {name} from recent projects', { name: name });
      remove.title = removeLabel;
      remove.setAttribute('aria-label', removeLabel);
      remove.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      remove.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        removeRecentProject(path);
      });

      row.append(open, remove);
      list.appendChild(row);
    });
  }

  function rememberRecentProject(value) {
    var path = cleanPath(value);
    if (!path) return readRecentProjects();
    var key = pathKey(path);
    var projects = readRecentProjects().filter(function(candidate) { return pathKey(candidate) !== key; });
    projects.unshift(path);
    writeRecentProjects(projects);
    renderRecentProjects();
    return projects;
  }

  function removeRecentProject(value) {
    var key = pathKey(value);
    var projects = readRecentProjects().filter(function(candidate) { return pathKey(candidate) !== key; });
    writeRecentProjects(projects);
    renderRecentProjects();
    return projects;
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    // Keep first-frame controls and dynamically rendered recent rows in sync.
    var isBusy = busy;
    var dynamicButtons = typeof document.querySelectorAll === 'function'
      ? Array.prototype.slice.call(document.querySelectorAll('.recent-project-open, .recent-project-remove'))
      : [];
    ['open-folder', 'empty-state-open'].forEach(function(id) {
      var button = document.getElementById(id);
      if (!button) return;
      dynamicButtons.push(button);
    });
    dynamicButtons.forEach(function(button) {
      button.disabled = isBusy;
      button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    });
  }

  function report(error) {
    console.error('workspace launch:', error);
  }

  function updateBusy() {
    setBusy(Boolean(requestPromise || draining || pending.length));
  }

  function drain() {
    if (draining) return draining;
    if (typeof consumer !== 'function' || pending.length === 0) return Promise.resolve();
    draining = Promise.resolve().then(async function() {
      while (typeof consumer === 'function' && pending.length > 0) {
        var opened = pending.shift();
        var applied = await consumer(opened);
        if (applied !== false && opened && opened.rootPath) rememberRecentProject(opened.rootPath);
      }
    }).catch(report).finally(function() {
      draining = null;
      updateBusy();
      if (typeof consumer === 'function' && pending.length > 0) drain();
    });
    updateBusy();
    return draining;
  }

  function accept(opened) {
    if (!opened) return Promise.resolve(false);
    pending.push(opened);
    updateBusy();
    return drain().then(function() { return true; });
  }

  function requestOpen(directoryPath) {
    if (requestPromise) return requestPromise;
    if (draining || pending.length) return drain().then(function() { return true; });
    if (!global.api || typeof global.api.pickWorkspace !== 'function') return Promise.resolve(false);
    setBusy(true);
    requestPromise = global.api.pickWorkspace(directoryPath)
      .then(accept)
      .catch(function(error) {
        report(error);
        return false;
      })
      .finally(function() {
        requestPromise = null;
        updateBusy();
      });
    return requestPromise;
  }

  function setConsumer(nextConsumer) {
    consumer = typeof nextConsumer === 'function' ? nextConsumer : null;
    updateBusy();
    return drain();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    ['open-folder', 'empty-state-open'].forEach(function(id) {
      var button = document.getElementById(id);
      if (!button) return;
      button.addEventListener('click', function() { requestOpen(); });
    });
    if (global.api && typeof global.api.onWorkspaceOpened === 'function') {
      global.api.onWorkspaceOpened(function(opened) { accept(opened); });
    }
    if (BOBO.i18n && typeof BOBO.i18n.onChange === 'function') BOBO.i18n.onChange(refreshRecentProjectTranslations);
    renderRecentProjects();
  }

  BOBO.workspaceLaunch = {
    init: init,
    requestOpen: requestOpen,
    setConsumer: setConsumer,
    whenIdle: function() { return drain(); }
  };

  init();
})(window);
