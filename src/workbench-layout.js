// src/workbench-layout.js - Single owner for the application shell and region geometry.
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var STORAGE_KEY = 'bobocloud.workbench.v1';

  var DEFAULTS = {
    activity: 'explorer',
    primaryVisible: true,
    sidebarWidth: 260,
    panelVisible: true,
    panelPosition: 'bottom',
    panelSize: 190,
    rightPanelSize: 360,
    density: 'comfortable',
    chatWidth: 350,
    panelMaximized: false,
    focusMode: false
  };

  var layout = null;
  var menu = null;
  var initialized = false;
  var resizeSession = null;
  var saveTimer = null;
  var contextObserver = null;

  function copyDefaults() {
    var value = {};
    Object.keys(DEFAULTS).forEach(function(key) { value[key] = DEFAULTS[key]; });
    return value;
  }

  function numberInRange(value, fallback, min, max) {
    value = Number(value);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  function sanitize(raw) {
    var value = copyDefaults();
    raw = raw && typeof raw === 'object' ? raw : {};
    value.activity = ['explorer', 'cloud', 'environment', 'team'].indexOf(raw.activity) >= 0 ? raw.activity : value.activity;
    value.primaryVisible = raw.primaryVisible !== false;
    value.sidebarWidth = numberInRange(raw.sidebarWidth, value.sidebarWidth, 180, 520);
    value.panelVisible = raw.panelVisible !== false;
    value.panelPosition = raw.panelPosition === 'right' ? 'right' : 'bottom';
    value.panelSize = numberInRange(raw.panelSize, value.panelSize, 96, 700);
    value.rightPanelSize = numberInRange(raw.rightPanelSize, value.rightPanelSize, 280, 760);
    value.density = raw.density === 'compact' ? 'compact' : 'comfortable';
    value.chatWidth = numberInRange(raw.chatWidth, value.chatWidth, 260, 640);
    return value;
  }

  function load() {
    try { return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }
    catch (error) { return copyDefaults(); }
  }

  var state = load();
  S.workbench = state;

  function persistentState() {
    return {
      activity: state.activity,
      primaryVisible: state.primaryVisible,
      sidebarWidth: state.sidebarWidth,
      panelVisible: state.panelVisible,
      panelPosition: state.panelPosition,
      panelSize: state.panelSize,
      rightPanelSize: state.rightPanelSize,
      density: state.density,
      chatWidth: state.chatWidth
    };
  }

  function persistSoon(immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    var save = function() {
      saveTimer = null;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persistentState())); } catch (error) {}
    };
    if (immediate) save();
    else saveTimer = setTimeout(save, 100);
  }

  function clampToViewport() {
    if (!layout) return;
    var rect = layout.getBoundingClientRect();
    state.sidebarWidth = numberInRange(state.sidebarWidth, DEFAULTS.sidebarWidth, 180, Math.max(180, Math.min(520, rect.width * 0.46)));
    state.panelSize = numberInRange(state.panelSize, DEFAULTS.panelSize, 96, Math.max(96, rect.height * 0.72));
    state.rightPanelSize = numberInRange(state.rightPanelSize, DEFAULTS.rightPanelSize, 280, Math.max(280, Math.min(760, rect.width * 0.58)));
    state.chatWidth = numberInRange(state.chatWidth, DEFAULTS.chatWidth, 260, Math.max(260, Math.min(640, rect.width * 0.55)));
  }

  function requestEditorLayout() {
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        try { if (S.editor && typeof S.editor.layout === 'function') S.editor.layout(); } catch (error) {}
        try { if (S.splitEditor && typeof S.splitEditor.layout === 'function') S.splitEditor.layout(); } catch (error) {}
        try { if (S.diffEditor && typeof S.diffEditor.layout === 'function') S.diffEditor.layout(); } catch (error) {}
      });
    });
  }

  function emitChange() {
    try { global.dispatchEvent(new CustomEvent('bobo:workbench-changed', { detail: getState() })); } catch (error) {}
  }

  function apply(options) {
    options = options || {};
    if (!layout) layout = document.getElementById('layout');
    if (!layout) return;
    clampToViewport();

    layout.classList.toggle('primary-sidebar-hidden', !state.primaryVisible);
    layout.classList.toggle('panel-hidden', !state.panelVisible);
    layout.classList.toggle('panel-maximized', state.panelVisible && state.panelMaximized);
    layout.classList.toggle('focus-mode', state.focusMode);
    layout.setAttribute('data-panel-position', state.panelPosition);
    layout.setAttribute('data-density', state.density);
    layout.style.setProperty('--sidebar-width', state.sidebarWidth + 'px');
    layout.style.setProperty('--workbench-panel-size', state.panelSize + 'px');
    layout.style.setProperty('--workbench-right-panel-size', state.rightPanelSize + 'px');
    layout.style.setProperty('--chat-width', state.chatWidth + 'px');

    refreshControls();
    refreshContext();
    if (options.persist !== false) persistSoon(Boolean(options.immediate));
    if (options.layoutEditor !== false) requestEditorLayout();
    emitChange();
  }

  function getState() {
    var value = persistentState();
    value.panelMaximized = state.panelMaximized;
    value.focusMode = state.focusMode;
    value.auxiliaryVisible = Boolean(S.ai && S.ai.chatOpen);
    return value;
  }

  function setPrimaryVisible(visible) {
    state.primaryVisible = Boolean(visible);
    if (state.primaryVisible) state.focusMode = false;
    apply();
  }

  function togglePrimary() { setPrimaryVisible(!state.primaryVisible); }

  function renderPrimaryView(view) {
    document.querySelectorAll('[data-sidebar-view]').forEach(function(section) {
      section.classList.toggle('active', section.getAttribute('data-sidebar-view') === view);
    });
  }

  function setPrimaryView(view) {
    if (['explorer', 'cloud', 'environment', 'team'].indexOf(view) < 0) return;
    state.activity = view;
    state.primaryVisible = true;
    state.focusMode = false;
    renderPrimaryView(view);
    apply();
  }

  function setPanelVisible(visible) {
    state.panelVisible = Boolean(visible);
    if (!state.panelVisible) state.panelMaximized = false;
    if (state.panelVisible) state.focusMode = false;
    apply();
  }

  function togglePanel() { setPanelVisible(!state.panelVisible); }

  function revealPanel() {
    if (!state.panelVisible || state.focusMode) {
      state.panelVisible = true;
      state.focusMode = false;
      apply();
    }
  }

  function ensureBottomPanelSize(minimumSize) {
    if (state.panelPosition !== 'bottom') {
      revealPanel();
      return;
    }
    var requested = Number(minimumSize);
    if (!Number.isFinite(requested)) requested = DEFAULTS.panelSize;
    state.panelSize = Math.max(state.panelSize, requested);
    state.panelVisible = true;
    state.focusMode = false;
    apply();
  }

  function setPanelPosition(position) {
    state.panelPosition = position === 'right' ? 'right' : 'bottom';
    state.panelMaximized = false;
    state.panelVisible = true;
    state.focusMode = false;
    apply();
  }

  function togglePanelPosition() {
    setPanelPosition(state.panelPosition === 'bottom' ? 'right' : 'bottom');
  }

  function togglePanelMaximized() {
    state.panelVisible = true;
    state.focusMode = false;
    state.panelMaximized = !state.panelMaximized;
    apply({ persist: false });
  }

  function setDensity(density) {
    state.density = density === 'compact' ? 'compact' : 'comfortable';
    apply();
  }

  function setFocusMode(enabled) {
    state.focusMode = Boolean(enabled);
    state.panelMaximized = false;
    apply({ persist: false });
  }

  function toggleFocusMode() { setFocusMode(!state.focusMode); }

  function setAuxiliaryVisible(visible, options) {
    options = options || {};
    visible = Boolean(visible);
    if (visible) state.focusMode = false;
    if (S.ai) S.ai.chatOpen = visible;
    if (layout) layout.classList.toggle('chat-open', visible);
    var activity = document.getElementById('activity-ai');
    if (activity) {
      activity.classList.toggle('active', visible);
      activity.setAttribute('aria-pressed', visible ? 'true' : 'false');
    }
    if (!options.skipContent && BOBO.aiChatPanel && BOBO.aiChatPanel.setVisible) BOBO.aiChatPanel.setVisible(visible);
    refreshControls();
    requestEditorLayout();
    emitChange();
  }

  function toggleAuxiliary() {
    var next = !(S.ai && S.ai.chatOpen);
    if (BOBO.aiAgentButton && BOBO.aiAgentButton.toggleChat) BOBO.aiAgentButton.toggleChat(next);
    else setAuxiliaryVisible(next);
  }

  function reset() {
    var fresh = copyDefaults();
    Object.keys(fresh).forEach(function(key) { state[key] = fresh[key]; });
    if (BOBO.aiAgentButton && BOBO.aiAgentButton.toggleChat) BOBO.aiAgentButton.toggleChat(false);
    else {
      if (S.ai) S.ai.chatOpen = false;
      if (layout) layout.classList.remove('chat-open');
    }
    setPrimaryView('explorer');
    apply({ immediate: true });
  }

  function refreshControls() {
    if (!layout) return;
    document.querySelectorAll('[data-workbench-view]').forEach(function(button) {
      var active = button.getAttribute('data-workbench-view') === state.activity;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    document.querySelectorAll('[data-layout-toggle="primarySidebar"]').forEach(function(button) { button.setAttribute('aria-checked', state.primaryVisible ? 'true' : 'false'); });
    document.querySelectorAll('[data-layout-toggle="bottomPanel"]').forEach(function(button) { button.setAttribute('aria-checked', state.panelVisible ? 'true' : 'false'); });
    document.querySelectorAll('[data-layout-toggle="auxiliaryBar"]').forEach(function(button) { button.setAttribute('aria-checked', S.ai && S.ai.chatOpen ? 'true' : 'false'); });
    document.querySelectorAll('[data-layout-action="focus"]').forEach(function(button) { button.setAttribute('aria-checked', state.focusMode ? 'true' : 'false'); });
    document.querySelectorAll('button[data-panel-position]').forEach(function(button) { button.setAttribute('aria-pressed', button.getAttribute('data-panel-position') === state.panelPosition ? 'true' : 'false'); });
    document.querySelectorAll('button[data-density]').forEach(function(button) { button.setAttribute('aria-pressed', button.getAttribute('data-density') === state.density ? 'true' : 'false'); });

    var positionButton = document.getElementById('panel-position-toggle');
    if (positionButton) positionButton.title = state.panelPosition === 'bottom' ? 'Move panel to the right' : 'Move panel to the bottom';
    var maximizeButton = document.getElementById('panel-maximize');
    if (maximizeButton) maximizeButton.title = state.panelMaximized ? 'Restore panel size' : 'Maximize panel';

    var sidebarSetting = document.getElementById('settings-layout-sidebar');
    var panelSetting = document.getElementById('settings-layout-panel');
    var aiSetting = document.getElementById('settings-layout-ai');
    var positionSetting = document.getElementById('settings-panel-position');
    var densitySetting = document.getElementById('settings-density');
    if (sidebarSetting) sidebarSetting.checked = state.primaryVisible;
    if (panelSetting) panelSetting.checked = state.panelVisible;
    if (aiSetting) aiSetting.checked = Boolean(S.ai && S.ai.chatOpen);
    if (positionSetting) positionSetting.value = state.panelPosition;
    if (densitySetting) densitySetting.value = state.density;

    updateSeparatorAria();
  }

  function pathName(value) {
    if (!value) return 'No folder opened';
    var parts = String(value).split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || value;
  }

  function refreshContext() {
    var workspaceName = document.getElementById('sidebar-workspace-name');
    if (workspaceName) {
      workspaceName.textContent = pathName(S.workspaceRoot);
      workspaceName.title = S.workspaceRoot || '';
    }

    var sync = document.getElementById('cloud-view-sync');
    if (sync) sync.disabled = !S.workspaceRoot;

    var current = S.collaboration && S.collaboration.current;
    var project = document.getElementById('team-sidebar-project');
    var branch = document.getElementById('team-sidebar-branch');
    var panel = document.getElementById('team-sidebar-panel');
    if (project) project.textContent = current ? (current.teamName + ' / ' + current.projectName) : 'Personal project';
    if (branch) branch.textContent = current ? current.branch : 'No team mapping';
    if (panel) panel.disabled = !current;
  }

  function updateSeparatorAria() {
    var sidebar = document.getElementById('sidebar-resizer');
    var panel = document.getElementById('output-resizer');
    var ai = document.getElementById('ai-chat-resizer');
    if (sidebar) sidebar.setAttribute('aria-valuenow', String(Math.round(state.sidebarWidth)));
    if (panel) {
      panel.setAttribute('aria-orientation', state.panelPosition === 'bottom' ? 'horizontal' : 'vertical');
      panel.setAttribute('aria-valuenow', String(Math.round(state.panelPosition === 'bottom' ? state.panelSize : state.rightPanelSize)));
    }
    if (ai) ai.setAttribute('aria-valuenow', String(Math.round(state.chatWidth)));
  }

  function beginResize(kind, event) {
    if (event.button !== 0) return;
    event.preventDefault();
    var target = event.currentTarget;
    resizeSession = {
      kind: kind,
      target: target,
      startX: event.clientX,
      startY: event.clientY,
      sidebarWidth: state.sidebarWidth,
      panelSize: state.panelSize,
      rightPanelSize: state.rightPanelSize,
      chatWidth: state.chatWidth
    };
    target.classList.add('resizing');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = kind === 'panel' && state.panelPosition === 'bottom' ? 'ns-resize' : 'ew-resize';
    layout.style.transition = 'none';
    try { target.setPointerCapture(event.pointerId); } catch (error) {}
  }

  function moveResize(event) {
    if (!resizeSession) return;
    var rect = layout.getBoundingClientRect();
    if (resizeSession.kind === 'sidebar') {
      state.sidebarWidth = numberInRange(resizeSession.sidebarWidth + event.clientX - resizeSession.startX, state.sidebarWidth, 180, Math.min(520, rect.width * 0.46));
    } else if (resizeSession.kind === 'panel' && state.panelPosition === 'bottom') {
      state.panelSize = numberInRange(resizeSession.panelSize + resizeSession.startY - event.clientY, state.panelSize, 96, rect.height * 0.72);
    } else if (resizeSession.kind === 'panel') {
      state.rightPanelSize = numberInRange(resizeSession.rightPanelSize + resizeSession.startX - event.clientX, state.rightPanelSize, 280, Math.min(760, rect.width * 0.58));
    } else if (resizeSession.kind === 'ai') {
      state.chatWidth = numberInRange(resizeSession.chatWidth + resizeSession.startX - event.clientX, state.chatWidth, 260, Math.min(640, rect.width * 0.55));
    }
    apply({ persist: false, layoutEditor: false });
  }

  function endResize() {
    if (!resizeSession) return;
    resizeSession.target.classList.remove('resizing');
    resizeSession = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (layout) layout.style.transition = '';
    persistSoon(true);
    requestEditorLayout();
  }

  function adjustFromKeyboard(kind, event) {
    var key = event.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(key) < 0) return;
    event.preventDefault();
    var step = event.shiftKey ? 40 : 12;
    if (kind === 'sidebar') {
      if (key === 'Home') state.sidebarWidth = 180;
      else if (key === 'End') state.sidebarWidth = 520;
      else state.sidebarWidth += key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0;
    } else if (kind === 'ai') {
      if (key === 'Home') state.chatWidth = 260;
      else if (key === 'End') state.chatWidth = 640;
      else state.chatWidth += key === 'ArrowLeft' ? step : key === 'ArrowRight' ? -step : 0;
    } else if (state.panelPosition === 'bottom') {
      if (key === 'Home') state.panelSize = 96;
      else if (key === 'End') state.panelSize = 700;
      else state.panelSize += key === 'ArrowUp' ? step : key === 'ArrowDown' ? -step : 0;
    } else {
      if (key === 'Home') state.rightPanelSize = 280;
      else if (key === 'End') state.rightPanelSize = 760;
      else state.rightPanelSize += key === 'ArrowLeft' ? step : key === 'ArrowRight' ? -step : 0;
    }
    apply({ immediate: true });
  }

  function bindResizer(id, kind) {
    var element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('pointerdown', function(event) { beginResize(kind, event); });
    element.addEventListener('pointermove', moveResize);
    element.addEventListener('pointerup', endResize);
    element.addEventListener('pointercancel', endResize);
    element.addEventListener('keydown', function(event) { adjustFromKeyboard(kind, event); });
  }

  function closeMenu() {
    if (!menu) return;
    menu.classList.remove('open');
    var button = document.getElementById('layout-menu-button');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function bindShell() {
    var commandCenter = document.getElementById('command-center');
    if (commandCenter) commandCenter.addEventListener('click', function() { if (BOBO.commands) BOBO.commands.show(); });

    document.querySelectorAll('[data-workbench-view]').forEach(function(button) {
      button.addEventListener('click', function() {
        var view = button.getAttribute('data-workbench-view');
        setPrimaryView(view);
        if (view === 'team') {
          requestAnimationFrame(function() {
            var sidebar = document.getElementById('sidebar');
            if (sidebar && getComputedStyle(sidebar).display === 'none' && BOBO.collaboration && BOBO.collaboration.openHub) {
              BOBO.collaboration.openHub();
            }
          });
        }
      });
    });
    document.querySelectorAll('.sidebar-hide').forEach(function(button) { button.addEventListener('click', function() { setPrimaryVisible(false); }); });

    var search = document.getElementById('activity-search');
    if (search) search.addEventListener('click', function() { if (BOBO.fileSearch) BOBO.fileSearch.show(); });
    var ai = document.getElementById('activity-ai');
    if (ai) ai.addEventListener('click', toggleAuxiliary);
    var settings = document.getElementById('activity-settings');
    if (settings) settings.addEventListener('click', function() { if (BOBO.settings) BOBO.settings.open('workbench'); });
    var cloudStorage = document.getElementById('cloud-open-storage');
    if (cloudStorage) cloudStorage.addEventListener('click', function() { if (BOBO.projects) BOBO.projects.open(); });
    var cloudSettings = document.getElementById('cloud-open-settings');
    if (cloudSettings) cloudSettings.addEventListener('click', function() { if (BOBO.settings) BOBO.settings.open('server'); });
    var cloudSync = document.getElementById('cloud-view-sync');
    if (cloudSync) cloudSync.addEventListener('click', function() { var button = document.getElementById('cloud-sync-btn'); if (button) button.click(); });
    var teamPanel = document.getElementById('team-sidebar-panel');
    if (teamPanel) teamPanel.addEventListener('click', function() { if (BOBO.switchToPanel) BOBO.switchToPanel('team'); });

    var menuButton = document.getElementById('layout-menu-button');
    menu = document.getElementById('layout-menu');
    if (menuButton && menu) {
      menuButton.addEventListener('click', function(event) {
        event.stopPropagation();
        var open = !menu.classList.contains('open');
        menu.classList.toggle('open', open);
        menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      menu.addEventListener('click', function(event) { event.stopPropagation(); });
      document.addEventListener('click', closeMenu);
      document.addEventListener('keydown', function(event) { if (event.key === 'Escape') closeMenu(); });
    }

    document.querySelectorAll('[data-layout-toggle]').forEach(function(button) {
      button.addEventListener('click', function() {
        var type = button.getAttribute('data-layout-toggle');
        if (type === 'primarySidebar') togglePrimary();
        if (type === 'bottomPanel') togglePanel();
        if (type === 'auxiliaryBar') toggleAuxiliary();
      });
    });
    document.querySelectorAll('button[data-panel-position]').forEach(function(button) { button.addEventListener('click', function() { setPanelPosition(button.getAttribute('data-panel-position')); }); });
    document.querySelectorAll('button[data-density]').forEach(function(button) { button.addEventListener('click', function() { setDensity(button.getAttribute('data-density')); }); });
    document.querySelectorAll('[data-layout-action="focus"]').forEach(function(button) { button.addEventListener('click', toggleFocusMode); });
    document.querySelectorAll('[data-layout-action="reset"]').forEach(function(button) { button.addEventListener('click', reset); });

    var positionToggle = document.getElementById('panel-position-toggle');
    var maximize = document.getElementById('panel-maximize');
    var closePanel = document.getElementById('panel-close');
    if (positionToggle) positionToggle.addEventListener('click', togglePanelPosition);
    if (maximize) maximize.addEventListener('click', togglePanelMaximized);
    if (closePanel) closePanel.addEventListener('click', function() { setPanelVisible(false); });

    var sidebarSetting = document.getElementById('settings-layout-sidebar');
    var panelSetting = document.getElementById('settings-layout-panel');
    var aiSetting = document.getElementById('settings-layout-ai');
    var positionSetting = document.getElementById('settings-panel-position');
    var densitySetting = document.getElementById('settings-density');
    var resetSetting = document.getElementById('settings-layout-reset');
    if (sidebarSetting) sidebarSetting.addEventListener('change', function() { setPrimaryVisible(sidebarSetting.checked); });
    if (panelSetting) panelSetting.addEventListener('change', function() { setPanelVisible(panelSetting.checked); });
    if (aiSetting) aiSetting.addEventListener('change', function() {
      if (BOBO.aiAgentButton && BOBO.aiAgentButton.toggleChat) BOBO.aiAgentButton.toggleChat(aiSetting.checked);
      else setAuxiliaryVisible(aiSetting.checked);
    });
    if (positionSetting) positionSetting.addEventListener('change', function() { setPanelPosition(positionSetting.value); });
    if (densitySetting) densitySetting.addEventListener('change', function() { setDensity(densitySetting.value); });
    if (resetSetting) resetSetting.addEventListener('click', reset);

    bindResizer('sidebar-resizer', 'sidebar');
    bindResizer('output-resizer', 'panel');
    bindResizer('ai-chat-resizer', 'ai');

    global.addEventListener('blur', endResize);
    global.addEventListener('resize', function() { apply({ persist: false }); });
    global.addEventListener('keydown', function(event) {
      var primary = event.ctrlKey || event.metaKey;
      if (primary && !event.shiftKey && (event.key === 'b' || event.key === 'B')) { event.preventDefault(); togglePrimary(); }
      if (primary && !event.shiftKey && (event.key === 'j' || event.key === 'J')) { event.preventDefault(); togglePanel(); }
      if (primary && event.shiftKey && event.key === 'F11') { event.preventDefault(); toggleFocusMode(); }
    });
  }

  function observeContext() {
    var workspace = document.getElementById('workspace-label');
    var teamBadge = document.getElementById('team-project-badge');
    if (!global.MutationObserver || (!workspace && !teamBadge)) return;
    contextObserver = new MutationObserver(refreshContext);
    if (workspace) contextObserver.observe(workspace, { childList: true, subtree: true });
    if (teamBadge) contextObserver.observe(teamBadge, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    layout = document.getElementById('layout');
    if (!layout) return;
    bindShell();
    observeContext();
    renderPrimaryView(state.activity);
    apply({ persist: false, layoutEditor: false });

    if (BOBO.commands) {
      BOBO.commands.register('view-toggle-primary-sidebar', 'Toggle Primary Sidebar', 'Ctrl+B', 'View', togglePrimary);
      BOBO.commands.register('view-toggle-panel', 'Toggle Workbench Panel', 'Ctrl+J', 'View', togglePanel);
      BOBO.commands.register('view-move-panel', 'Move Panel to Bottom or Right', '', 'View', togglePanelPosition);
      BOBO.commands.register('view-focus-mode', 'Toggle Focus Mode', 'Ctrl+Shift+F11', 'View', toggleFocusMode);
      BOBO.commands.register('view-reset-layout', 'Reset Workbench Layout', '', 'View', reset);
    }
  }

  BOBO.workbench = {
    init: init,
    getState: getState,
    apply: apply,
    refreshControls: refreshControls,
    refreshContext: refreshContext,
    setPrimaryView: setPrimaryView,
    setPrimaryVisible: setPrimaryVisible,
    togglePrimary: togglePrimary,
    setPanelVisible: setPanelVisible,
    togglePanel: togglePanel,
    revealPanel: revealPanel,
    ensureBottomPanelSize: ensureBottomPanelSize,
    setPanelPosition: setPanelPosition,
    togglePanelPosition: togglePanelPosition,
    togglePanelMaximized: togglePanelMaximized,
    setDensity: setDensity,
    setFocusMode: setFocusMode,
    setAuxiliaryVisible: setAuxiliaryVisible,
    toggleAuxiliary: toggleAuxiliary,
    reset: reset
  };
})(window);
