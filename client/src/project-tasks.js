(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var initialized = false;
  var configuration = { tasks: [], warnings: [] };
  var selected = { type: 'file', label: '' };
  var disposers = [];
  var refreshGeneration = 0;

  function tr(source, replacements) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function featureDecision(type) {
    var feature = type === 'task' ? 'tasks' : 'run';
    if (BOBO.cloudFeaturePolicy && typeof BOBO.cloudFeaturePolicy.evaluate === 'function') {
      return BOBO.cloudFeaturePolicy.evaluate(feature);
    }
    return { available: false, state: 'unknown', reason: 'policy_unavailable' };
  }

  function unavailableText(type) {
    return type === 'task'
      ? tr('Cloud tasks are unavailable on this server.')
      : tr('Cloud run is unavailable on this server.');
  }

  function selectionStorageKey() {
    return 'bobocloud.runTarget.' + String(S.workspaceRoot || '_global');
  }

  function loadSelection() {
    try {
      var value = JSON.parse(localStorage.getItem(selectionStorageKey()) || 'null');
      selected = value && (value.type === 'file' || value.type === 'task') ? value : { type: 'file', label: '' };
    } catch (_) {
      selected = { type: 'file', label: '' };
    }
    if (selected.type === 'task' && !configuration.tasks.some(function(task) { return task.label === selected.label; })) {
      selected = { type: 'file', label: '' };
    }
  }

  function saveSelection() {
    try { localStorage.setItem(selectionStorageKey(), JSON.stringify(selected)); } catch (_) {}
  }

  function warningPath(item, property) {
    var filePath = String(item && item[property || 'path'] || '');
    var root = String(S.workspaceRoot || '');
    if (root && filePath.toLowerCase().startsWith(root.toLowerCase())) {
      return filePath.slice(root.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
    }
    return filePath || (item && item.source === 'bobocloud' ? '.bobocloud/tasks.json' : '.vscode/tasks.json');
  }

  function warningText(item) {
    item = item || {};
    var values = {
      path: warningPath(item),
      sourcePath: warningPath(item, 'sourcePath'),
      overriddenSourcePath: warningPath(item, 'overriddenSourcePath'),
      line: item.line || 0,
      column: item.column || 0,
      reason: item.reason || item.code || '',
      version: item.version || '',
      index: Number(item.taskIndex || 0) + 1,
      task: item.task || '',
      type: item.taskType || '',
      order: item.dependsOrder || '',
      field: item.field || ''
    };
    var keys = {
      TASKS_JSON_PARSE_ERROR: 'Task file could not be parsed at {path}:{line}:{column} ({reason}).',
      TASKS_INVALID_ROOT: 'Task file must contain a JSON object: {path}',
      TASKS_VERSION_UNSUPPORTED: 'Task file {path} uses version {version}; only 2.0.0 can run.',
      TASKS_INPUTS_UNSUPPORTED: 'Task inputs are preserved but interactive input variables cannot run: {path}',
      TASKS_ARRAY_MISSING: 'Task file must define a tasks array: {path}',
      TASK_LABEL_MISSING: 'Task #{index} has no label in {path}.',
      TASK_TYPE_UNSUPPORTED: 'Task "{task}" uses unsupported type "{type}". Only shell and process can run.',
      TASK_BACKGROUND_UNSUPPORTED: 'Task "{task}" is a background task, which is not supported yet.',
      TASK_DEPENDS_ORDER_UNSUPPORTED: 'Task "{task}" uses unsupported dependency order "{order}".',
      TASK_VARIABLE_UNSUPPORTED: 'Task "{task}" uses an input, command, or configuration variable that is not available.',
      TASK_COMMAND_MISSING: 'Task "{task}" has neither a command nor a dependency.',
      TASK_FIELD_PRESERVED: 'Task "{task}" keeps {field}, but the cloud output runner does not apply it.',
      TASK_PLATFORM_CLOUD_LINUX: 'Task "{task}" keeps Windows and macOS overrides, but cloud execution uses the Linux override.',
      TASK_LABEL_CONFLICT: 'Task "{task}" from {sourcePath} overrides the task from {overriddenSourcePath}.',
      TASKS_LOAD_FAILED: 'Task configuration could not be loaded.'
    };
    return keys[item.code] ? tr(keys[item.code], values) : String(item.message || item.code || tr('Unknown task configuration warning'));
  }

  function updatePrimaryButton() {
    var button = document.getElementById('run-code');
    if (!button) return;
    var target = selected.type === 'task' ? selected.label : tr('Current File');
    var targetFeature = featureDecision(selected.type);
    if (BOBO.i18n && BOBO.i18n.bindAttribute) {
      BOBO.i18n.bindAttribute(button, 'title', 'Run {target}', { target: target });
      BOBO.i18n.bindAttribute(button, 'aria-label', 'Run {target}', { target: target });
    } else {
      button.title = tr('Run {target}', { target: target });
      button.setAttribute('aria-label', button.title);
    }
    button.dataset.runTargetType = selected.type;
    button.dataset.runTargetLabel = selected.label || '';
    if (!targetFeature.available) {
      button.title = unavailableText(selected.type);
      button.setAttribute('aria-label', button.title);
    }
    var configButton = document.getElementById('run-config-btn');
    if (configButton) {
      var configTitle = selected.type === 'task'
        ? tr('Run configuration is only available for Current File')
        : tr('Run configuration');
      configButton.title = configTitle;
      configButton.setAttribute('aria-label', configTitle);
    }
    if (BOBO.runner && typeof BOBO.runner.refreshControls === 'function') BOBO.runner.refreshControls();
  }

  function closeMenu(options) {
    var menu = document.getElementById('run-target-menu');
    var button = document.getElementById('run-target-btn');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('contextmenu', onOutsidePointer, true);
    document.removeEventListener('scroll', closeMenu, true);
    global.removeEventListener('resize', closeMenu);
    global.removeEventListener('blur', closeMenu);
    if (options && options.restoreFocus && button) button.focus();
  }

  function onOutsidePointer(event) {
    var menu = document.getElementById('run-target-menu');
    var button = document.getElementById('run-target-btn');
    if (menu && !menu.contains(event.target) && button && !button.contains(event.target)) closeMenu();
  }

  function createMenuItem(task) {
    var isFile = !task;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-target-item';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(isFile ? selected.type === 'file' : selected.type === 'task' && selected.label === task.label));
    var itemType = isFile ? 'file' : 'task';
    var itemFeature = featureDecision(itemType);
    button.disabled = !itemFeature.available || Boolean(task && !task.executable);
    if (!itemFeature.available) button.title = unavailableText(itemType);
    else if (task && task.warnings && task.warnings.length) button.title = task.warnings.map(warningText).join('\n');

    var check = document.createElement('span');
    check.className = 'run-target-check';
    check.textContent = button.getAttribute('aria-checked') === 'true' ? '\u2713' : '';
    var label = document.createElement('span');
    label.className = 'run-target-label';
    if (isFile) {
      if (BOBO.i18n && BOBO.i18n.bindText) BOBO.i18n.bindText(label, 'Current File');
      else label.textContent = tr('Current File');
    } else {
      label.textContent = task.label;
    }
    var source = document.createElement('span');
    source.className = 'run-target-source';
    source.textContent = isFile ? 'F5' : (task.source === 'bobocloud' ? 'BOBO' : 'VS Code');
    button.append(check, label, source);
    button.addEventListener('click', function() {
      selected = isFile ? { type: 'file', label: '' } : { type: 'task', label: task.label };
      saveSelection();
      updatePrimaryButton();
      closeMenu({ restoreFocus: true });
    });
    return button;
  }

  function appendSection(menu, title, tasks) {
    if (tasks.length === 0) return;
    var heading = document.createElement('div');
    heading.className = 'run-target-section';
    if (BOBO.i18n && BOBO.i18n.bindText) BOBO.i18n.bindText(heading, title);
    else heading.textContent = tr(title);
    menu.appendChild(heading);
    tasks.forEach(function(task) { menu.appendChild(createMenuItem(task)); });
  }

  function renderMenu() {
    var menu = document.getElementById('run-target-menu');
    if (!menu) return;
    menu.replaceChildren();
    appendSection(menu, 'Single File', [null]);
    var visibleTasks = configuration.tasks.filter(function(task) { return !task.hide; });
    var sections = [
      ['build', 'Build Tasks'],
      ['test', 'Test Tasks'],
      ['run', 'Run Tasks'],
      ['custom', 'Custom Tasks']
    ];
    sections.forEach(function(section) {
      appendSection(menu, section[1], visibleTasks.filter(function(task) { return task.kind === section[0]; }));
    });
    if (visibleTasks.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'run-target-empty';
      if (BOBO.i18n && BOBO.i18n.bindText) BOBO.i18n.bindText(empty, 'No project tasks found');
      else empty.textContent = tr('No project tasks found');
      menu.appendChild(empty);
    }
    if (configuration.warnings.length > 0) {
      var warning = document.createElement('div');
      warning.className = 'run-target-warning';
      if (BOBO.i18n && BOBO.i18n.bindText) {
        BOBO.i18n.bindText(warning, '{count} task configuration warning(s)', { count: configuration.warnings.length });
      } else {
        warning.textContent = tr('{count} task configuration warning(s)', { count: configuration.warnings.length });
      }
      warning.title = configuration.warnings.map(warningText).join('\n');
      menu.appendChild(warning);
    }
  }

  function positionMenu() {
    var menu = document.getElementById('run-target-menu');
    var button = document.getElementById('run-target-btn');
    if (!menu || !button) return;
    menu.hidden = false;
    var rect = button.getBoundingClientRect();
    var width = menu.offsetWidth;
    var height = menu.offsetHeight;
    var left = Math.max(8, Math.min(rect.right - width, global.innerWidth - width - 8));
    var top = rect.bottom + 6;
    if (top + height > global.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function openMenu() {
    renderMenu();
    positionMenu();
    var button = document.getElementById('run-target-btn');
    if (button) button.setAttribute('aria-expanded', 'true');
    var first = document.querySelector('#run-target-menu .run-target-item:not(:disabled)');
    if (first) first.focus();
    setTimeout(function() {
      document.addEventListener('pointerdown', onOutsidePointer, true);
      document.addEventListener('contextmenu', onOutsidePointer, true);
      document.addEventListener('scroll', closeMenu, true);
      global.addEventListener('resize', closeMenu);
      global.addEventListener('blur', closeMenu);
    }, 0);
  }

  async function refresh() {
    var generation = ++refreshGeneration;
    var workspaceRoot = S.workspaceRoot || '';
    if (!workspaceRoot) {
      configuration = { tasks: [], warnings: [] };
      selected = { type: 'file', label: '' };
      updatePrimaryButton();
      closeMenu();
      return configuration;
    }
    var nextConfiguration;
    try {
      nextConfiguration = await global.api.tasksList();
    } catch (error) {
      nextConfiguration = { tasks: [], warnings: [{ code: 'TASKS_LOAD_FAILED', message: error.message }] };
    }
    if (generation !== refreshGeneration || workspaceRoot !== (S.workspaceRoot || '')) return configuration;
    configuration = nextConfiguration;
    loadSelection();
    updatePrimaryButton();
    var menu = document.getElementById('run-target-menu');
    if (menu && !menu.hidden) renderMenu();
    return configuration;
  }

  function editorContext() {
    var context = { activeFile: S.activeTabPath || '', selectedText: '', lineNumber: '', columnNumber: '' };
    if (!S.editor) return context;
    var selection = S.editor.getSelection && S.editor.getSelection();
    if (!selection) return context;
    context.lineNumber = selection.startLineNumber;
    context.columnNumber = selection.startColumn;
    var model = S.editor.getModel && S.editor.getModel();
    if (model && model.getValueInRange) context.selectedText = model.getValueInRange(selection);
    return context;
  }

  async function runSelected() {
    var targetFeature = featureDecision(selected.type);
    if (!targetFeature.available) {
      BOBO.updateRunOutput(unavailableText(selected.type));
      return false;
    }
    if (selected.type !== 'task') return BOBO.runner.runActive();
    if (!S.selectedRuntime) {
      BOBO.updateRunOutput(tr('Project tasks require a Docker runtime. Select a cloud runtime before running {task}.', { task: selected.label }));
      var runtimeButton = document.getElementById('runtime-btn');
      if (runtimeButton) runtimeButton.focus();
      return false;
    }
    try {
      return BOBO.runner.runProjectTask({ label: selected.label, context: editorContext() });
    } catch (error) {
      BOBO.updateRunOutput(tr('Task configuration could not be loaded: {message}', { message: error.message }));
      return false;
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    var button = document.getElementById('run-target-btn');
    if (button) {
      button.addEventListener('click', function(event) {
        event.stopPropagation();
        var menu = document.getElementById('run-target-menu');
        if (menu.hidden) openMenu();
        else closeMenu({ restoreFocus: true });
      });
      button.addEventListener('keydown', function(event) {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        openMenu();
        var first = document.querySelector('#run-target-menu .run-target-item:not(:disabled)');
        if (first) first.focus();
      });
    }
    var menu = document.getElementById('run-target-menu');
    if (menu) menu.addEventListener('keydown', function(event) {
      var items = Array.from(menu.querySelectorAll('.run-target-item:not(:disabled)'));
      var index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closeMenu({ restoreFocus: true }); return; }
      if (event.key === 'Tab') { closeMenu(); return; }
      if (event.key === 'Home' && items.length) { event.preventDefault(); items[0].focus(); return; }
      if (event.key === 'End' && items.length) { event.preventDefault(); items[items.length - 1].focus(); return; }
      if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); items[(index + 1 + items.length) % items.length].focus(); }
      if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
    });
    var onWorkspaceChanged = function(event) {
      refreshGeneration += 1;
      configuration = { tasks: [], warnings: [] };
      selected = { type: 'file', label: '' };
      closeMenu();
      updatePrimaryButton();
      var rootPath = event && event.detail && event.detail.rootPath;
      if (rootPath || S.workspaceRoot) setTimeout(refresh, 0);
    };
    global.addEventListener('bobo:workspace-changed', onWorkspaceChanged);
    disposers.push(function() { global.removeEventListener('bobo:workspace-changed', onWorkspaceChanged); });
    var onServerCapabilities = function() {
      closeMenu();
      updatePrimaryButton();
    };
    global.addEventListener('bobo:server-capabilities-changed', onServerCapabilities);
    disposers.push(function() { global.removeEventListener('bobo:server-capabilities-changed', onServerCapabilities); });
    disposers.push(global.api.onWorkspaceOpened(function() { setTimeout(refresh, 50); }));
    disposers.push(global.api.onFileEvent(function(event) {
      var filePath = String(event && event.path || '').replace(/\\/g, '/').toLowerCase();
      if (filePath.endsWith('/.vscode/tasks.json') || filePath.endsWith('/.bobocloud/tasks.json')) refresh();
    }));
    if (BOBO.i18n && BOBO.i18n.onChange) {
      disposers.push(BOBO.i18n.onChange(function() {
        updatePrimaryButton();
        var activeMenu = document.getElementById('run-target-menu');
        if (activeMenu && !activeMenu.hidden) renderMenu();
      }));
    }
    refresh();
  }

  BOBO.projectTasks = {
    init: init,
    refresh: refresh,
    runSelected: runSelected,
    getSelected: function() { return Object.assign({}, selected); },
    getConfiguration: function() { return configuration; },
    dispose: function() {
      closeMenu();
      refreshGeneration += 1;
      disposers.splice(0).forEach(function(dispose) { if (typeof dispose === 'function') dispose(); });
      initialized = false;
    }
  };
})(window);
