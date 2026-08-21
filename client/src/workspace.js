// src/workspace.js — File tree, tabs, file operations
// Optimized: event delegation, incremental updates, CSS-driven folder toggle, model cleanup
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // ──── Constants ────
  var CHILD_PAGE_SIZE = 200;

  function t(source, params) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, params);
    var value = source;
    Object.keys(params || {}).forEach(function(key) {
      value = value.replace(new RegExp('\\{' + key + '\\}', 'g'), String(params[key]));
    });
    return value;
  }

  // ──── Event Delegation Setup (once) ────
  var treeClickHandler = null;
  var treeContextHandler = null;
  var treeKeyHandler = null;
  var contextMenuCleanup = null;
  var contextMenuTrigger = null;
  var inlineEditorCleanup = null;
  var syncDirtyPaths = new Set();
  var fileDecorationSubscription = null;
  var FILE_DECORATION_LANES = ['sync', 'scm', 'diagnostic'];
  // Workbench pages such as extension details are deliberately kept outside
  // the file-tab model. Providers get the tab chrome lifecycle without ever
  // receiving a Monaco model or a workspace path.
  var workbenchTabProviders = new Map();

  function normalizeWorkbenchTab(tab, providerId) {
    if (!tab || typeof tab !== 'object') return null;
    var key = typeof tab.key === 'string' ? tab.key : '';
    if (!key || key.length > 240) return null;
    if (S.tabs.some(function(fileTab) { return fileTab.path === key; })) return null;
    return {
      key: key,
      name: String(tab.name || key).slice(0, 160),
      title: String(tab.title || tab.name || key).slice(0, 320),
      providerId: providerId,
      closeable: tab.closeable !== false,
      draggable: tab.draggable === true
    };
  }

  function workbenchTabsFromProviders() {
    var seen = new Set();
    var result = [];
    workbenchTabProviders.forEach(function(provider, providerId) {
      if (!provider || typeof provider.getTabs !== 'function') return;
      var supplied = [];
      try { supplied = provider.getTabs(); } catch (error) { return; }
      if (!Array.isArray(supplied)) return;
      supplied.forEach(function(rawTab) {
        var tab = normalizeWorkbenchTab(rawTab, providerId);
        if (!tab || seen.has(tab.key)) return;
        seen.add(tab.key);
        result.push(tab);
      });
    });
    return result;
  }

  function findWorkbenchTab(key) {
    if (typeof key !== 'string') return null;
    var tabs = workbenchTabsFromProviders();
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].key !== key) continue;
      return {
        tab: tabs[i],
        provider: workbenchTabProviders.get(tabs[i].providerId)
      };
    }
    return null;
  }

  function activateWorkbenchTab(key) {
    var match = findWorkbenchTab(key);
    if (!match || !match.provider || typeof match.provider.activate !== 'function') return false;
    try {
      match.provider.activate(key);
      return true;
    } catch (error) {
      return false;
    }
  }

  function closeWorkbenchTab(key) {
    var match = findWorkbenchTab(key);
    if (!match || !match.provider || typeof match.provider.close !== 'function') return null;
    try { return Promise.resolve(match.provider.close(key)); } catch (error) { return Promise.reject(error); }
  }

  function deactivateWorkbenchTabs() {
    workbenchTabProviders.forEach(function(provider) {
      if (!provider || typeof provider.deactivate !== 'function') return;
      try { provider.deactivate(); } catch (error) {}
    });
  }

  function notifyWorkbenchFileActivated(tab) {
    workbenchTabProviders.forEach(function(provider) {
      if (!provider || typeof provider.afterFileActivation !== 'function') return;
      try { provider.afterFileActivation(tab); } catch (error) {}
    });
  }

  function registerWorkbenchTabProvider(providerId, provider) {
    if (typeof providerId !== 'string' || !providerId || !provider || typeof provider.getTabs !== 'function') {
      throw new TypeError('A workbench tab provider needs an id and getTabs().');
    }
    workbenchTabProviders.set(providerId, provider);
    updateTabbar();
    return {
      dispose: function() {
        if (workbenchTabProviders.get(providerId) !== provider) return;
        workbenchTabProviders.delete(providerId);
        updateTabbar();
        updateEmptyState();
      }
    };
  }

  function trackTabSyncState(tab) {
    if (!tab || !tab.path) return;
    if (!tab.dirty) {
      syncDirtyPaths.delete(tab.path);
      if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.setBufferDirty(tab.path, false);
      return;
    }
    if (syncDirtyPaths.has(tab.path)) return;
    syncDirtyPaths.add(tab.path);
    if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.setBufferDirty(tab.path, true);
  }

  function treeNodeFromRow(row) {
    if (!row) return null;
    return {
      path: row.getAttribute('data-path'),
      type: row.getAttribute('data-type'),
      name: row.getAttribute('data-name')
    };
  }

  function workspaceRelativeResource(filePath) {
    var value = String(filePath || '').replace(/\\/g, '/');
    var root = String(S.workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[a-zA-Z]:\//.test(value)) value = value.toLowerCase();
    if (/^[a-zA-Z]:\//.test(root)) root = root.toLowerCase();
    if (root && value === root) return '';
    return root && value.indexOf(root + '/') === 0 ? value.slice(root.length + 1) : value;
  }

  function renderFileDecorationLane(row, node, lane) {
    var bridge = BOBO.platform && BOBO.platform.fileDecorations;
    if (!bridge || typeof bridge.get !== 'function') return;
    var detail = bridge.get(lane, workspaceRelativeResource(node.path), node);
    var selector = ':scope > .tree-' + lane + '-rail';
    var rail = row.querySelector(selector);
    if (!detail) {
      if (rail) rail.remove();
      if (lane === 'sync') row.removeAttribute('data-sync-state');
      return;
    }
    if (!rail) {
      rail = document.createElement('span');
      rail.className = 'tree-decoration-rail tree-' + lane + '-rail';
      rail.setAttribute('role', 'img');
      if (lane === 'sync') {
        rail.setAttribute('data-decoration-kind', 'cloud-sync');
        rail.innerHTML = '<span class="tree-sync-cloud" aria-hidden="true">' +
          (BOBO.icons && BOBO.icons.cloud || '') +
          '</span><span class="tree-sync-state-mark" aria-hidden="true"></span>';
      } else {
        var badge = document.createElement('span');
        badge.className = 'tree-decoration-badge';
        badge.setAttribute('aria-hidden', 'true');
        rail.appendChild(badge);
      }
      row.appendChild(rail);
    }
    rail.setAttribute('data-decoration-status', detail.status);
    rail.setAttribute('data-decoration-color', detail.color || '');
    rail.title = detail.tooltip || '';
    rail.setAttribute('aria-label', detail.ariaLabel || detail.tooltip || detail.status);
    if (lane === 'sync') {
      rail.setAttribute('data-sync-state', detail.status);
      row.setAttribute('data-sync-state', detail.status);
    } else {
      var badgeElement = rail.querySelector('.tree-decoration-badge');
      if (badgeElement) badgeElement.textContent = detail.badge;
    }
  }

  function decorateTreeRow(row, node, onlyLane) {
    var lanes = onlyLane ? [onlyLane] : FILE_DECORATION_LANES;
    lanes.forEach(function(lane) { renderFileDecorationLane(row, node, lane); });
  }

  function refreshFileDecorations(lane) {
    var rows = document.querySelectorAll('#file-tree .tree-row[data-path]');
    Array.prototype.forEach.call(rows, function(row) {
      decorateTreeRow(row, treeNodeFromRow(row), lane);
    });
  }

  function ensureFileDecorationSubscription() {
    if (fileDecorationSubscription) return;
    var bridge = BOBO.platform && BOBO.platform.fileDecorations;
    if (!bridge || typeof bridge.onDidChange !== 'function') return;
    fileDecorationSubscription = bridge.onDidChange(function(event) {
      refreshFileDecorations(event && event.lane);
    });
  }

  function ensureTreeDelegation() {
    if (treeClickHandler) return;
    ensureFileDecorationSubscription();
    var tree = document.getElementById('file-tree');

    treeClickHandler = function(e) {
      var loadMore = e.target.closest('.tree-load-more');
      if (loadMore) {
        e.preventDefault();
        renderNextChildPage(loadMore.closest('ul.tree-children'));
        return;
      }
      var row = e.target.closest('.tree-row');
      if (!row) return;
      var nodePath = row.getAttribute('data-path');
      var nodeType = row.getAttribute('data-type');
      if (!nodePath) return;

      if (nodeType === 'file') {
        var name = row.getAttribute('data-name');
        openFile(nodePath, name);
      } else if (nodeType === 'folder') {
        toggleFolder(row, nodePath);
      }
    };

    treeContextHandler = function(e) {
      var row = e.target.closest('.tree-row');
      if (!row) {
        e.preventDefault();
        closeContextMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, treeNodeFromRow(row), row);
    };

    tree.addEventListener('click', treeClickHandler);
    tree.addEventListener('contextmenu', treeContextHandler);

    treeKeyHandler = function(e) {
      var row = e.target.closest('.tree-row');
      if (!row) return;
      var visible = Array.prototype.filter.call(tree.querySelectorAll('.tree-row'), function(item) { return item.offsetParent !== null; });
      var index = visible.indexOf(row);
      var next = null;
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        e.stopPropagation();
        var rowRect = row.getBoundingClientRect();
        openContextMenu(rowRect.left + Math.min(28, rowRect.width / 2), rowRect.bottom, treeNodeFromRow(row), row);
        return;
      }
      if (e.key === 'ArrowDown') next = visible[Math.min(visible.length - 1, index + 1)];
      if (e.key === 'ArrowUp') next = visible[Math.max(0, index - 1)];
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        row.click();
        return;
      }
      if (e.key === 'ArrowRight' && row.getAttribute('data-type') === 'folder') {
        e.preventDefault();
        if (row.getAttribute('aria-expanded') !== 'true') row.click();
        else {
          var firstChild = row.parentElement.querySelector('ul.tree-children .tree-row');
          if (firstChild && firstChild.offsetParent !== null) next = firstChild;
        }
      }
      if (e.key === 'ArrowLeft' && row.getAttribute('data-type') === 'folder') {
        e.preventDefault();
        if (row.getAttribute('aria-expanded') === 'true') row.click();
        else {
          var parentList = row.parentElement.parentElement;
          var parentItem = parentList && parentList.closest('li');
          if (parentItem) next = parentItem.querySelector(':scope > .tree-row');
        }
      }
      if (next) {
        e.preventDefault();
        row.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      }
    };
    tree.addEventListener('keydown', treeKeyHandler);
  }

  // ──── Workspace ────
  function captureWorkspaceEditorStates() {
    return S.tabs.filter(function(tab) { return tab.model; }).map(function(tab) {
      return {
        path: tab.path,
        model: tab.model,
        version: typeof tab.model.getVersionId === 'function' ? tab.model.getVersionId() : null,
        dirty: !!tab.dirty
      };
    });
  }

  function setWorkspaceTransitionLocked(locked, leaveToken) {
    S.workspaceTransitionLocked = locked === true;
    S.workspaceTransitionToken = locked ? leaveToken || null : null;
    var collaborationReadOnly = BOBO.collaboration && BOBO.collaboration.isActiveFileReadOnly && BOBO.collaboration.isActiveFileReadOnly();
    if (S.editor && typeof S.editor.updateOptions === 'function') S.editor.updateOptions({ readOnly: locked === true || collaborationReadOnly === true });
    if (S.splitEditor && typeof S.splitEditor.updateOptions === 'function') S.splitEditor.updateOptions({ readOnly: true });
    if (S.splitEditor && S.splitEditor.rightEditor && typeof S.splitEditor.rightEditor.updateOptions === 'function') {
      S.splitEditor.rightEditor.updateOptions({ readOnly: locked === true || collaborationReadOnly === true });
    }
  }

  function workspaceEditorStatesMatch(states) {
    if (!Array.isArray(states) || states.length !== S.tabs.filter(function(tab) { return tab.model; }).length) return false;
    return states.every(function(state) {
      var tab = S.tabs.find(function(candidate) { return candidate.path === state.path && candidate.model === state.model; });
      if (!tab || !!tab.dirty !== state.dirty) return false;
      return state.version == null || typeof tab.model.getVersionId !== 'function' || tab.model.getVersionId() === state.version;
    });
  }

  function abortWorkspaceLeave(leaveToken) {
    if (leaveToken && S.workspaceLeaveApprovals) S.workspaceLeaveApprovals.delete(leaveToken);
    if (S.workspaceTransitionLocked && (leaveToken || null) !== (S.workspaceTransitionToken || null)) return false;
    S.workspaceTransitionEditorStates = null;
    setWorkspaceTransitionLocked(false);
    return true;
  }

  async function canLeaveWorkspace(options) {
    options = options || {};
    if (S.workspaceTransitionLocked) return false;
    var dirtyTabs = S.tabs.filter(function(tab) { return tab.dirty && tab.model; });
    if (dirtyTabs.length) {
      var choice = global.api && global.api.chooseWorkspaceLeave
        ? await global.api.chooseWorkspaceLeave({ dirtyCount: dirtyTabs.length, reason: options.reason || 'switch' })
        : 'cancel';
      if (choice === 'cancel') return false;
      setWorkspaceTransitionLocked(true, options.leaveToken || null);
      if (choice === 'save' && !(await saveAllTabs({ allowDuringTransition: true }))) {
        abortWorkspaceLeave(options.leaveToken);
        return false;
      }
    } else {
      setWorkspaceTransitionLocked(true, options.leaveToken || null);
    }
    var approval = {
      targetRoot: options.targetRoot || null,
      sourceRoot: S.workspaceRoot,
      sourceGeneration: S.workspaceGeneration || 0,
      editorStates: captureWorkspaceEditorStates()
    };
    S.workspaceTransitionEditorStates = approval.editorStates;
    try {
      if (BOBO.terminal && BOBO.terminal.beforeWorkspaceLeave) {
        await BOBO.terminal.beforeWorkspaceLeave();
      }
      if (BOBO.dap && BOBO.dap.beforeWorkspaceLeave) {
        await BOBO.dap.beforeWorkspaceLeave();
      }
      if (BOBO.runner && BOBO.runner.prepareWorkspaceLeave) {
        await BOBO.runner.prepareWorkspaceLeave();
      }
    } catch (error) {
      abortWorkspaceLeave(options.leaveToken);
      return false;
    }
    if (options.leaveToken) {
      S.workspaceLeaveApprovals.set(options.leaveToken, approval);
    }
    return true;
  }

  function consumeWorkspaceLeaveApproval(rootPath, leaveToken) {
    if (!leaveToken || !S.workspaceLeaveApprovals) return null;
    var approval = S.workspaceLeaveApprovals.get(leaveToken);
    if (!approval || approval.targetRoot !== rootPath) return null;
    S.workspaceLeaveApprovals.delete(leaveToken);
    return approval;
  }

  async function applyWorkspace(rootPath, tree, workspaceIdentity, leaveToken, options) {
    options = options || {};
    var identity = global.api && global.api.getWorkspaceIdentity
      ? await global.api.getWorkspaceIdentity()
      : { rootPath: rootPath, workspaceIdentity: workspaceIdentity };
    if (!identity || identity.rootPath !== rootPath ||
        (workspaceIdentity != null && identity.workspaceIdentity !== workspaceIdentity)) {
      if (leaveToken && global.api && global.api.rejectWorkspaceSwitch) {
        try { await global.api.rejectWorkspaceSwitch({ leaveToken: leaveToken }); } catch (e) {}
      }
      abortWorkspaceLeave(leaveToken);
      return false;
    }
    workspaceIdentity = identity.workspaceIdentity;

    var approval = consumeWorkspaceLeaveApproval(rootPath, leaveToken);
    if (approval && (approval.sourceRoot !== S.workspaceRoot || approval.sourceGeneration !== (S.workspaceGeneration || 0) ||
        !workspaceEditorStatesMatch(approval.editorStates))) {
      if (global.api && global.api.rejectWorkspaceSwitch) {
        var rollback = await global.api.rejectWorkspaceSwitch({ leaveToken: leaveToken });
        if (rollback && rollback.rolledBack && rollback.rootPath === S.workspaceRoot) {
          S.workspaceIdentity = rollback.workspaceIdentity;
          if (rollback.tree) {
            S.workspaceTree = rollback.tree;
            renderTree(rollback.tree);
          }
        }
      }
      abortWorkspaceLeave(leaveToken);
      return false;
    }
    if (S.workspaceRoot && !approval && !options.approved) {
      if (!(await canLeaveWorkspace({ reason: 'switch' }))) return false;
    }
    // Main also stops its terminal transport before accepting a switch. Keep
    // the renderer-side close here as well so xterm's transcript and session
    // state cannot outlive a direct or already-approved workspace change.
    if (BOBO.terminal && BOBO.terminal.beforeWorkspaceLeave) {
      await BOBO.terminal.beforeWorkspaceLeave();
    }
    // Close all tabs from the previous project before switching.
    // Dispose Monaco models (skip image tabs which have no model).
    for (var i = 0; i < S.tabs.length; i++) {
      var t = S.tabs[i];
      if (t.model && t.language !== 'image') {
        try { t.model.dispose(); } catch (e) { /* ignore */ }
      }
    }
    // A workbench page is not tied to the workspace and can stay open while
    // files are replaced. File tabs are still disposed below as before.
    var retainedWorkbenchTab = findWorkbenchTab(S.activeTabPath);
    S.tabs = [];
    S.activeTabPath = retainedWorkbenchTab ? retainedWorkbenchTab.tab.key : null;
    if (S.editor) S.editor.setModel(null);
    updateTabbar();
    var syncButton = document.getElementById('cloud-sync-btn');
    if (syncButton) syncButton.style.display = 'none';
    var workspaceLabel = document.getElementById('workspace-label');
    if (workspaceLabel) workspaceLabel.textContent = 'No folder opened';

    S.workspaceRoot = rootPath;
    S.workspaceTree = tree || null;
    S.workspaceIdentity = workspaceIdentity == null ? S.workspaceIdentity : workspaceIdentity;
    S.workspaceGeneration = (S.workspaceGeneration || 0) + 1;
    S.workspaceChangeVersion = 0;
    S.lastSyncedVersion = -1;
    if (BOBO.workspaceSettings && BOBO.workspaceSettings.refreshForWorkspace) {
      await BOBO.workspaceSettings.refreshForWorkspace(rootPath, S.workspaceIdentity);
    }
    syncDirtyPaths.clear();
    if (BOBO.runner && BOBO.runner.markWorkspaceChanged) BOBO.runner.markWorkspaceChanged();
    if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.resetWorkspace(rootPath, tree);
    document.getElementById('workspace-label').textContent = rootPath;
    var syncButton = document.getElementById('cloud-sync-btn');
    if (syncButton) syncButton.style.display = '';
    S.expandedPaths.clear();
    S.expandedPaths.add(rootPath);
    ensureTreeDelegation();
    renderTree(tree);
    if (BOBO.fileSearch) BOBO.fileSearch.refreshCache();
    updateEmptyState();
    updateTitlebar();
    if (BOBO.workbench) BOBO.workbench.refreshContext();
    if (BOBO.lsp && BOBO.lsp.workspaceChanged) BOBO.lsp.workspaceChanged();
    try { global.dispatchEvent(new CustomEvent('bobo:workspace-changed', { detail: { rootPath: rootPath } })); } catch (e) {}
    if (leaveToken && global.api && global.api.workspaceSwitchApplied) {
      try { await global.api.workspaceSwitchApplied({ leaveToken: leaveToken }); } catch (e) {}
    }
    abortWorkspaceLeave(leaveToken);
    if (BOBO.runner && BOBO.runner.syncWithServer) {
      var appliedRoot = rootPath;
      var appliedGeneration = S.workspaceGeneration;
      setTimeout(function() {
        if (S.workspaceRoot === appliedRoot && S.workspaceGeneration === appliedGeneration && !S.workspaceTransitionLocked) {
          BOBO.runner.syncWithServer();
        }
      }, 0);
    }
    return true;
  }

  // Close the current workspace: dispose tabs, clear tree, stop auto-sync,
  // and tell the main process to drop its file watchers + workspaceRoot.
  // Used on logout to prevent auto-sync pushing files to the server under
  // the wrong account after an account switch.
  async function closeWorkspace(options) {
    options = options || {};
    if (!options.approved && !(await canLeaveWorkspace({ reason: options.reason || 'close' }))) return false;
    if (BOBO.terminal && BOBO.terminal.beforeWorkspaceLeave) await BOBO.terminal.beforeWorkspaceLeave();
    if (options.approved && BOBO.dap && BOBO.dap.beforeWorkspaceLeave) await BOBO.dap.beforeWorkspaceLeave();
    closeContextMenu({ restoreFocus: false });
    cancelInlineEditor();
    if (BOBO.runConfig && BOBO.runConfig.close) BOBO.runConfig.close();
    // Dispose all Monaco models (skip image tabs which have no model)
    for (var i = 0; i < S.tabs.length; i++) {
      var t = S.tabs[i];
      if (t.model && t.language !== 'image') {
        try { t.model.dispose(); } catch (e) { /* ignore */ }
      }
    }
    var retainedWorkbenchTab = findWorkbenchTab(S.activeTabPath);
    S.tabs = [];
    S.activeTabPath = retainedWorkbenchTab ? retainedWorkbenchTab.tab.key : null;
    S.workspaceRoot = null;
    S.workspaceTree = null;
    S.workspaceIdentity = null;
    S.workspaceGeneration = (S.workspaceGeneration || 0) + 1;
    S.workspaceChangeVersion = 0;
    S.lastSyncedVersion = -1;
    if (BOBO.workspaceSettings && BOBO.workspaceSettings.clear) BOBO.workspaceSettings.clear();
    S.expandedPaths.clear();
    syncDirtyPaths.clear();
    if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.clearWorkspace();
    abortWorkspaceLeave(options.leaveToken);

    // Clear tree + tabbar DOM
    var tree = document.getElementById('file-tree');
    if (tree) tree.innerHTML = '';
    updateTabbar();

    // Clear editors
    if (S.editor) S.editor.setModel(null);
    if (S.splitEditor) S.splitEditor.setModel(null);
    if (S.currentDiagnostics) {
      S.currentDiagnostics = { errors: 0, warnings: 0, infos: 0 };
      if (BOBO.editorCore && BOBO.editorCore.updateDiagnosticsStatus) BOBO.editorCore.updateDiagnosticsStatus();
    }

    // Stop auto-sync so no stale files are pushed after logout
    if (S.autoSyncInterval) { clearInterval(S.autoSyncInterval); S.autoSyncInterval = null; }

    // Notify main process to drop watchers + workspaceRoot
    if (global.api && typeof global.api.closeWorkspace === 'function') {
      try { await global.api.closeWorkspace(); } catch (e) { /* ignore */ }
    }

    updateTitlebar();
    updateEmptyState();
    if (BOBO.workbench) BOBO.workbench.refreshContext();
    if (BOBO.lsp && BOBO.lsp.workspaceChanged) BOBO.lsp.workspaceChanged();
    try { global.dispatchEvent(new CustomEvent('bobo:workspace-changed', { detail: { rootPath: null } })); } catch (e) {}
    return true;
  }

  // ──── Render tree with lazy, paged children ────
  function renderTree(tree) {
    var container = document.getElementById('file-tree');
    closeContextMenu({ restoreFocus: false });
    cancelInlineEditor();
    container.innerHTML = '';
    S.workspaceTree = tree || null;
    if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.setTree(tree);
    if (!tree) {
      if (BOBO.fileSearch) BOBO.fileSearch.refreshCache(true);
      return;
    }
    var rootUl = document.createElement('ul');
    container.appendChild(rootUl);

    var rootLi = buildTreeItemDOM(tree, true);
    rootUl.appendChild(rootLi);
    if (BOBO.fileSearch) BOBO.fileSearch.refreshCache(true);
  }

  global.addEventListener('bobo:language-changed', function() {
    var buttons = document.querySelectorAll('#file-tree .tree-load-more');
    Array.prototype.forEach.call(buttons, function(button) {
      var container = button.closest('ul.tree-children');
      if (!container || !container._boboChildren) return;
      var rendered = Number(container.getAttribute('data-rendered-count') || 0);
      var count = Math.min(CHILD_PAGE_SIZE, container._boboChildren.length - rendered);
      button.textContent = t('Load {count} more items', { count: count });
    });
  });

  function renderNextChildPage(container) {
    if (!container || !container._boboChildren) return;
    var oldPlaceholder = container.querySelector(':scope > .tree-placeholder');
    if (oldPlaceholder) oldPlaceholder.remove();

    var children = container._boboChildren;
    var startIdx = Number(container.getAttribute('data-rendered-count') || 0);
    var endIdx = Math.min(startIdx + CHILD_PAGE_SIZE, children.length);
    var fragment = document.createDocumentFragment();
    for (var i = startIdx; i < endIdx; i++) {
      fragment.appendChild(buildTreeItemDOM(children[i], false));
    }
    container.appendChild(fragment);
    container.setAttribute('data-rendered-count', String(endIdx));

    if (endIdx < children.length) {
      var pageCount = Math.min(CHILD_PAGE_SIZE, children.length - endIdx);
      var placeholder = document.createElement('li');
      placeholder.className = 'tree-placeholder';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'tree-load-more';
      button.textContent = t('Load {count} more items', { count: pageCount });
      placeholder.appendChild(button);
      container.appendChild(placeholder);
    }
  }

  // ──── Build DOM for a single tree node (event delegation — no per-node closures) ────
  // isRootExpanded: if true, this node is the workspace root (always expanded)
  function buildTreeItemDOM(node, isRootExpanded) {
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'tree-row item ' + (node.type === 'folder' ? 'folder' : 'file');
    row.setAttribute('data-path', node.path);
    row.setAttribute('data-type', node.type);
    row.setAttribute('data-name', node.name);
    row.setAttribute('role', 'treeitem');
    row.tabIndex = isRootExpanded ? 0 : -1;

    var icon = document.createElement('span');
    icon.className = 'tree-icon';

    var name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;

    var isAlwaysCollapsed = node.type === 'folder' && S.ALWAYS_COLLAPSED.has(node.name);
    var isExpanded = node.type === 'folder'
      ? (S.expandedPaths.has(node.path) && !isAlwaysCollapsed)
      : false;

    if (node.type === 'folder') {
      row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      icon.textContent = isExpanded ? '▾' : '▸';
    } else {
      // File: use SVG icon from ico/ if available, otherwise fallback •
      var iconPath = BOBO.fileIcons && BOBO.fileIcons.getFileIcon(node.name);
      if (iconPath) {
        var img = document.createElement('img');
        img.src = iconPath;
        img.className = 'file-icon-img';
        icon.appendChild(img);
      } else {
        icon.textContent = '•';
      }
    }

    row.appendChild(icon);
    row.appendChild(name);
    decorateTreeRow(row, node);
    li.appendChild(row);

    if (node.type === 'folder') {
      var childrenUl = document.createElement('ul');
      childrenUl.className = 'tree-children';
      childrenUl.style.paddingLeft = '14px';
      childrenUl._boboChildren = BOBO.workspaceSettings && BOBO.workspaceSettings.filterTreeChildren
        ? BOBO.workspaceSettings.filterTreeChildren(node.children)
        : (node.children || []);
      childrenUl.setAttribute('data-rendered-count', '0');

      if (!isExpanded) {
        childrenUl.style.display = 'none';
      }
      li.appendChild(childrenUl);
      if (isRootExpanded || isExpanded) renderNextChildPage(childrenUl);
    }

    return li;
  }

  // ──── Toggle folder expand/collapse via CSS only (children already in DOM) ────
  function toggleFolder(row, nodePath) {
    var li = row.parentElement;
    var childrenUl = li.querySelector('ul.tree-children');
    var icon = row.querySelector('.tree-icon');
    if (!icon) return;

    var isExpanded = S.expandedPaths.has(nodePath);
    if (isExpanded) {
      S.expandedPaths.delete(nodePath);
      if (childrenUl) childrenUl.style.display = 'none';
      icon.textContent = '▸';
      row.setAttribute('aria-expanded', 'false');
    } else {
      S.expandedPaths.add(nodePath);
      if (childrenUl && Number(childrenUl.getAttribute('data-rendered-count') || 0) === 0) {
        renderNextChildPage(childrenUl);
      }
      if (childrenUl) childrenUl.style.display = '';
      icon.textContent = '▾';
      row.setAttribute('aria-expanded', 'true');
    }
  }

  // ──── Incremental file event handling ────
  function handleFileEvent(data) {
    if (!data || !data.event) return;
    if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.handleFileEvent(data);

    var container = document.getElementById('file-tree');
    var rootUl = container.querySelector('ul');
    if (!rootUl) return;

    if (data.event === 'file-created') {
      insertTreeModelNode(data.parentPath, {
        name: data.name, path: data.path, type: data.nodeType || 'file', children: data.nodeType === 'folder' ? [] : undefined
      });
      renderTree(S.workspaceTree);
      return;
    } else if (data.event === 'file-deleted') {
      removeTreeModelNode(data.path);
      renderTree(S.workspaceTree);
      return;
    } else if (data.event === 'file-changed') {
      // Content-only changes do not affect the tree or Ctrl+P index.
      return;
    }
  }

  function findTreeModelNode(node, targetPath) {
    if (!node) return null;
    if (node.path === targetPath) return node;
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) {
      var match = findTreeModelNode(children[i], targetPath);
      if (match) return match;
    }
    return null;
  }

  function insertTreeModelNode(parentPath, node) {
    var parent = findTreeModelNode(S.workspaceTree, parentPath);
    if (!parent) return;
    parent.children = parent.children || [];
    if (parent.children.some(function(child) { return child.path === node.path; })) return;
    parent.children.push(node);
    parent.children.sort(function(left, right) {
      if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
    });
  }

  function removeTreeModelNode(targetPath) {
    function walk(parent) {
      var children = parent && parent.children;
      if (!children) return false;
      var index = children.findIndex(function(child) { return child.path === targetPath; });
      if (index >= 0) {
        children.splice(index, 1);
        return true;
      }
      return children.some(walk);
    }
    walk(S.workspaceTree);
  }

  function updateTreeModelNode(targetPath, data) {
    var node = findTreeModelNode(S.workspaceTree, targetPath);
    if (!node) return;
    if (data.name) node.name = data.name;
    if (data.path) node.path = data.path;
  }

  function findTreeNodeByPath(ul, targetPath) {
    var rows = ul.querySelectorAll('.tree-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-path') === targetPath) {
        return rows[i].parentElement;
      }
    }
    return null;
  }

  function insertTreeNode(rootUl, parentPath, node) {
    var parentLi = findTreeNodeByPath(rootUl, parentPath);
    if (!parentLi) {
      if (window.api && window.api.refreshWorkspace) {
        window.api.refreshWorkspace();
      }
      return;
    }

    var childrenUl = parentLi.querySelector('ul.tree-children');
    if (!childrenUl) {
      childrenUl = document.createElement('ul');
      childrenUl.className = 'tree-children';
      childrenUl.style.paddingLeft = '14px';
      parentLi.appendChild(childrenUl);
    }

    if (findTreeNodeByPath(childrenUl, node.path)) return; // no duplicates

    childrenUl.appendChild(buildTreeItemDOM(node, false));

    // If parent was collapsed, expand it to show the new item
    var parentRow = parentLi.querySelector('.tree-row');
    if (parentRow && childrenUl.style.display === 'none') {
      var parentPathAttr = parentRow.getAttribute('data-path');
      if (parentPathAttr) {
        S.expandedPaths.add(parentPathAttr);
        childrenUl.style.display = '';
        var icon = parentRow.querySelector('.tree-icon');
        if (icon) icon.textContent = '▾';
      }
    }
  }

  function removeTreeNode(rootUl, targetPath) {
    var li = findTreeNodeByPath(rootUl, targetPath);
    if (li && li.parentNode) {
      li.parentNode.removeChild(li);
    }
  }

  function updateTreeNode(rootUl, targetPath, data) {
    var li = findTreeNodeByPath(rootUl, targetPath);
    if (!li) return;
    var row = li.querySelector('.tree-row');
    if (!row) return;
    if (data.name) {
      row.setAttribute('data-name', data.name);
      var nameEl = row.querySelector('.tree-name');
      if (nameEl) nameEl.textContent = data.name;
    }
    if (data.path && data.path !== targetPath) {
      row.setAttribute('data-path', data.path);
    }
  }

  // ──── Context Menu ────
  function openContextMenu(x, y, node, triggerRow) {
    if (!node || !node.path) return;
    closeContextMenu({ restoreFocus: false });
    cancelInlineEditor();
    if (BOBO.aiAgentButton && BOBO.aiAgentButton.closeMenu) BOBO.aiAgentButton.closeMenu();

    var menu = document.createElement('div');
    menu.className = 'context-menu tree-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('File actions for {name}', { name: node.name || '' }));
    menu.setAttribute('data-target-path', node.path);
    menu.style.visibility = 'hidden';

    function addAction(action, labelKey, iconKey, handler, danger) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'action' + (danger ? ' danger' : '');
      button.setAttribute('role', 'menuitem');
      button.setAttribute('data-action', action);

      var icon = document.createElement('span');
      icon.className = 'context-menu-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = BOBO.icons && BOBO.icons[iconKey] || '';

      var label = document.createElement('span');
      label.className = 'context-menu-label';
      label.textContent = t(labelKey);

      button.appendChild(icon);
      button.appendChild(label);
      button.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        closeContextMenu({ restoreFocus: false });
        handler();
      });
      menu.appendChild(button);
    }

    if (node.type === 'folder') {
      addAction('new-file', 'New File', 'file', function() { promptCreate(node.path, 'file'); });
      addAction('new-folder', 'New Folder', 'folder', function() { promptCreate(node.path, 'folder'); });
    }
    var isWorkspaceRoot = node.path === S.workspaceRoot;
    if (!isWorkspaceRoot) {
      addAction('rename', 'Rename', 'fileText', function() { promptRename(node.path); });
      addAction('delete', 'Delete', 'trash', function() { promptDelete(node.path, node.type); }, true);
    }

    if (node.type === 'file' && S.activeTabPath && node.path !== S.activeTabPath) {
      addAction('compare-active', 'Compare with Active', 'copy', function() {
        if (BOBO.views && BOBO.views.openDiff) BOBO.views.openDiff(S.activeTabPath, node.path);
      });
    }

    document.body.appendChild(menu);
    S.contextMenuEl = menu;
    contextMenuTrigger = triggerRow || null;
    var treeScrollContainer = contextMenuTrigger && contextMenuTrigger.closest('.sidebar-scroll');
    if (contextMenuTrigger) {
      contextMenuTrigger.classList.add('context-menu-open');
      contextMenuTrigger.setAttribute('aria-haspopup', 'menu');
    }

    var margin = 8;
    var rect = menu.getBoundingClientRect();
    var viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    var viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    var left = Math.max(margin, Math.min(Number(x) || margin, viewportWidth - rect.width - margin));
    var top = Math.max(margin, Math.min(Number(y) || margin, viewportHeight - rect.height - margin));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.visibility = '';

    function closeWithoutFocus() { closeContextMenu({ restoreFocus: false }); }
    function onPointerDown(event) {
      if (!menu.contains(event.target)) closeWithoutFocus();
    }
    function onContextMenu(event) {
      if (!menu.contains(event.target)) closeWithoutFocus();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeContextMenu({ restoreFocus: true });
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('keydown', onKeyDown, true);
    var scrollListenerFrame = requestAnimationFrame(function() {
      scrollListenerFrame = null;
      if (treeScrollContainer && menu.isConnected) treeScrollContainer.addEventListener('scroll', closeWithoutFocus, { passive: true });
    });
    window.addEventListener('resize', closeWithoutFocus);
    window.addEventListener('blur', closeWithoutFocus);
    contextMenuCleanup = function() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('keydown', onKeyDown, true);
      if (scrollListenerFrame != null) cancelAnimationFrame(scrollListenerFrame);
      if (treeScrollContainer) treeScrollContainer.removeEventListener('scroll', closeWithoutFocus);
      window.removeEventListener('resize', closeWithoutFocus);
      window.removeEventListener('blur', closeWithoutFocus);
    };

    menu.addEventListener('keydown', function(event) {
      if (event.key === 'Tab') {
        closeContextMenu({ restoreFocus: true });
        return;
      }
      var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
      var current = items.indexOf(document.activeElement);
      var target = null;
      if (event.key === 'ArrowDown') target = items[(current + 1 + items.length) % items.length];
      if (event.key === 'ArrowUp') target = items[(current - 1 + items.length) % items.length];
      if (event.key === 'Home') target = items[0];
      if (event.key === 'End') target = items[items.length - 1];
      if (target) {
        event.preventDefault();
        target.focus();
      }
    });

    var firstItem = menu.querySelector('[role="menuitem"]');
    if (firstItem) firstItem.focus({ preventScroll: true });
  }

  function closeContextMenu(options) {
    options = options || {};
    var trigger = contextMenuTrigger;
    if (contextMenuCleanup) contextMenuCleanup();
    contextMenuCleanup = null;
    contextMenuTrigger = null;
    if (trigger) {
      trigger.classList.remove('context-menu-open');
      trigger.removeAttribute('aria-haspopup');
    }
    if (S.contextMenuEl && S.contextMenuEl.parentNode) S.contextMenuEl.parentNode.removeChild(S.contextMenuEl);
    S.contextMenuEl = null;
    if (options.restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  // ──── File operations ────
  function localizedFileOperationMessage(error) {
    var message = error && error.message ? error.message : String(error || 'Unknown error');
    message = message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
    if (message === 'Enter a valid name') return t('A name is required.');
    if (message === 'Names cannot contain path separators') return t('Names cannot contain path separators.');
    if (message === 'An entry with that name already exists' || /\bEEXIST\b/.test(message)) return t('An entry with that name already exists.');
    if (message === 'The entry no longer exists' || /\bENOENT\b/.test(message)) return t('The entry no longer exists.');
    if (/\b(?:EPERM|EACCES)\b/.test(message)) return t('The operation was not permitted.');
    return message === 'Unknown error' ? t('Unknown error') : message;
  }

  function showFileOperationError(action, error) {
    var message = localizedFileOperationMessage(error);
    if (BOBO.toast) BOBO.toast.error(t('{action} failed: {message}', { action: t(action), message: message }));
    return message;
  }

  function isPathAtOrBelow(candidate, parent) {
    return candidate === parent || candidate.indexOf(parent + '/') === 0 || candidate.indexOf(parent + '\\') === 0;
  }

  function cancelInlineEditor() {
    var cleanup = inlineEditorCleanup;
    inlineEditorCleanup = null;
    if (cleanup) cleanup();
  }

  function validateInlineName(value) {
    if (!value || !value.trim()) return t('A name is required.');
    if (value !== value.trim()) return t('Names cannot start or end with whitespace.');
    if (value === '.' || value === '..' || value.indexOf('/') >= 0 || value.indexOf('\\') >= 0 || value.indexOf('\0') >= 0) {
      return t('Names cannot contain path separators.');
    }
    return '';
  }

  function createInlineControl(options) {
    var control = document.createElement('span');
    control.className = 'tree-inline-control';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-input tree-inline-input';
    input.value = options.value || '';
    input.placeholder = t(options.placeholder);
    input.setAttribute('aria-label', t(options.label));
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    var error = document.createElement('span');
    error.className = 'tree-inline-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    control.appendChild(input);
    control.appendChild(error);

    function setError(message) {
      error.textContent = message || '';
      error.hidden = !message;
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      control.classList.toggle('invalid', Boolean(message));
    }
    input.addEventListener('input', function() { setError(''); });
    ['click', 'dblclick', 'contextmenu'].forEach(function(type) {
      input.addEventListener(type, function(event) { event.stopPropagation(); });
    });
    return { control: control, input: input, error: error, setError: setError };
  }

  function focusInlineInput(input, selectFileStem) {
    requestAnimationFrame(function() {
      if (!input || !input.isConnected) return;
      input.focus({ preventScroll: true });
      if (!input.value) return;
      var end = input.value.length;
      if (selectFileStem) {
        var dot = input.value.lastIndexOf('.');
        if (dot > 0) end = dot;
      }
      input.setSelectionRange(0, end);
    });
  }

  function keepInlineEditorVisible(element) {
    requestAnimationFrame(function() {
      if (element && element.isConnected) element.scrollIntoView({ block: 'nearest' });
    });
  }

  function promptCreate(parentDir, type) {
    if (S.workspaceTransitionLocked) return;
    cancelInlineEditor();
    var tree = document.getElementById('file-tree');
    var rootUl = tree.querySelector('ul');
    var parentLi = rootUl ? findTreeNodeByPath(rootUl, parentDir) : null;
    if (!parentLi) {
      if (BOBO.toast) BOBO.toast.error(t('The target folder is no longer visible.'));
      return;
    }

    var parentRow = parentLi.querySelector(':scope > .tree-row');
    var childrenUl = parentLi.querySelector(':scope > ul.tree-children');
    if (!childrenUl) {
      childrenUl = document.createElement('ul');
      childrenUl.className = 'tree-children';
      childrenUl.style.paddingLeft = '14px';
      childrenUl._boboChildren = [];
      childrenUl.setAttribute('data-rendered-count', '0');
      parentLi.appendChild(childrenUl);
    }
    if (parentRow) {
      S.expandedPaths.add(parentDir);
      parentRow.setAttribute('aria-expanded', 'true');
      var parentIcon = parentRow.querySelector('.tree-icon');
      if (parentIcon) parentIcon.textContent = '▾';
    }
    if (Number(childrenUl.getAttribute('data-rendered-count') || 0) === 0) renderNextChildPage(childrenUl);
    childrenUl.style.display = '';

    var item = document.createElement('li');
    item.className = 'tree-inline-editor tree-inline-create';
    var row = document.createElement('div');
    row.className = 'tree-row item ' + type + ' tree-inline-row';
    var icon = document.createElement('span');
    icon.className = 'tree-icon tree-inline-icon';
    icon.innerHTML = BOBO.icons && BOBO.icons[type === 'file' ? 'file' : 'folder'] || '';
    var editor = createInlineControl({
      value: '',
      label: type === 'file' ? 'File name' : 'Folder name',
      placeholder: type === 'file' ? 'Enter a file name' : 'Enter a folder name'
    });
    row.appendChild(icon);
    row.appendChild(editor.control);
    item.appendChild(row);
    childrenUl.insertBefore(item, childrenUl.firstChild);

    var cleaned = false;
    var submitting = false;
    function onOutsidePointerDown(event) {
      if (!submitting && !editor.control.contains(event.target)) cleanup();
    }
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      if (inlineEditorCleanup === cleanup) inlineEditorCleanup = null;
      if (item.parentNode) item.parentNode.removeChild(item);
      if (parentRow && parentRow.isConnected) parentRow.focus({ preventScroll: true });
    }
    inlineEditorCleanup = cleanup;
    document.addEventListener('pointerdown', onOutsidePointerDown, true);

    async function submit() {
      if (submitting) return;
      var name = editor.input.value;
      var validationError = validateInlineName(name);
      if (validationError) {
        editor.setError(validationError);
        editor.input.focus();
        return;
      }
      submitting = true;
      editor.input.disabled = true;
      editor.control.classList.add('submitting');
      try {
        var result;
        if (type === 'file') {
          result = await window.api.createFile({ parentDir: parentDir, name: name });
          cleanup();
          if (result && result.path) await openFile(result.path, name);
        } else {
          await window.api.createFolder({ parentDir: parentDir, name: name });
          cleanup();
        }
      } catch (error) {
        submitting = false;
        editor.input.disabled = false;
        editor.control.classList.remove('submitting');
        editor.setError(showFileOperationError(type === 'file' ? 'Create file' : 'Create folder', error));
        editor.input.focus();
        editor.input.select();
      }
    }

    editor.input.addEventListener('keydown', function(event) {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape' && !submitting) { event.preventDefault(); cleanup(); }
    });
    focusInlineInput(editor.input, false);
    keepInlineEditorVisible(item);
  }

  function promptRename(oldPath) {
    if (S.workspaceTransitionLocked) return;
    cancelInlineEditor();
    var base = oldPath.split(/[/\\]/).pop();
    var container = document.getElementById('file-tree');
    var rootUl = container.querySelector('ul');
    var item = rootUl ? findTreeNodeByPath(rootUl, oldPath) : null;
    var row = item && item.querySelector(':scope > .tree-row');
    var nameElement = row && row.querySelector(':scope > .tree-name');
    if (!row || !nameElement) {
      if (BOBO.toast) BOBO.toast.error(t('The entry is no longer visible.'));
      return;
    }

    var editor = createInlineControl({
      value: base,
      label: 'New name',
      placeholder: 'Enter a new name'
    });
    row.replaceChild(editor.control, nameElement);
    row.classList.add('tree-row-editing');

    var cleaned = false;
    var submitting = false;
    function onOutsidePointerDown(event) {
      if (!submitting && !editor.control.contains(event.target)) cleanup();
    }
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      if (inlineEditorCleanup === cleanup) inlineEditorCleanup = null;
      if (editor.control.parentNode === row) row.replaceChild(nameElement, editor.control);
      row.classList.remove('tree-row-editing');
      if (row.isConnected) row.focus({ preventScroll: true });
    }
    inlineEditorCleanup = cleanup;
    document.addEventListener('pointerdown', onOutsidePointerDown, true);

    async function submit() {
      if (submitting) return;
      var newName = editor.input.value;
      var validationError = validateInlineName(newName);
      if (validationError) {
        editor.setError(validationError);
        editor.input.focus();
        return;
      }
      if (newName === base) {
        cleanup();
        return;
      }
      submitting = true;
      editor.input.disabled = true;
      editor.control.classList.add('submitting');
      try {
        var result = await window.api.renameEntry({ oldPath: oldPath, newName: newName });
        if (result && result.path) {
          if (BOBO.dap && BOBO.dap.renameBreakpoints) BOBO.dap.renameBreakpoints(oldPath, result.path);
          for (var i = 0; i < S.tabs.length; i++) {
            if (isPathAtOrBelow(S.tabs[i].path, oldPath)) {
              var suffix = S.tabs[i].path.slice(oldPath.length);
              S.tabs[i].path = result.path + suffix;
              if (!suffix) S.tabs[i].name = newName;
            }
          }
          if (S.activeTabPath && isPathAtOrBelow(S.activeTabPath, oldPath)) {
            S.activeTabPath = result.path + S.activeTabPath.slice(oldPath.length);
          }
          updateTabbar();
          updateTitlebar();
        }
        cleanup();
      } catch (error) {
        submitting = false;
        editor.input.disabled = false;
        editor.control.classList.remove('submitting');
        editor.setError(showFileOperationError('Rename', error));
        editor.input.focus();
        editor.input.select();
      }
    }

    editor.input.addEventListener('keydown', function(event) {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape' && !submitting) { event.preventDefault(); cleanup(); }
    });
    focusInlineInput(editor.input, row.getAttribute('data-type') === 'file');
    keepInlineEditorVisible(row);
  }

  async function promptDelete(entryPath, type) {
    if (S.workspaceTransitionLocked) return;
    var affectedTabs = S.tabs.filter(function(tab) { return isPathAtOrBelow(tab.path, entryPath); });
    var dirtyCount = affectedTabs.filter(function(tab) { return tab.dirty; }).length;
    var warning = dirtyCount > 0
      ? '\n' + (dirtyCount === 1
        ? t('1 open file has unsaved changes that will be lost.')
        : t('{count} open files have unsaved changes that will be lost.', { count: dirtyCount }))
      : '';
    var ok = await BOBO.confirm({
      title: t(type === 'folder' ? 'Delete folder' : 'Delete file'),
      message: entryPath + warning + '\n' + t('This cannot be undone.'),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      danger: true
    });
    if (!ok) return;

    try {
      var deleted = await window.api.deleteEntry({ entryPath: entryPath });
      if (!deleted) throw new Error('The entry no longer exists');
      if (BOBO.dap && BOBO.dap.removeBreakpoints) BOBO.dap.removeBreakpoints(entryPath);
      for (var i = 0; i < affectedTabs.length; i++) {
        await closeTab(affectedTabs[i].path, { force: true });
      }
    } catch (error) {
      showFileOperationError('Delete', error);
      return;
    }
    // Sync deletion to server (silent -- user didn't ask for verbose output)
    if (BOBO.runner && BOBO.runner.syncWithServer) {
      BOBO.runner.syncWithServer();
    }
  }

  // ──── Tabs ────
  async function openFile(filePath, name) {
    if (S.workspaceTransitionLocked) return false;
    if (BOBO.isImageFile(name)) {
      if (BOBO.views && BOBO.views.showImagePreview) {
        BOBO.views.showImagePreview(filePath, name);
      }

      var existingImg = S.tabs.find(function(t) { return t.path === filePath; });
      if (existingImg) {
        activateTab(existingImg.path);
        return;
      }

      var tab = { path: filePath, name: name, model: null, language: 'image', dirty: false };
      S.tabs.push(tab);
      activateTab(filePath);
      addTabToBar(tab, S.tabs.length - 1);
      updateTitlebar();
      return;
    }

    var existing = S.tabs.find(function(t) { return t.path === filePath; });
    if (existing) {
      activateTab(existing.path);
      return;
    }

    var content = await window.api.readFile(filePath);
    var detectedLanguage = BOBO.detectLanguage(name, content);
    var language = BOBO.workspaceSettings && BOBO.workspaceSettings.languageForFile
      ? BOBO.workspaceSettings.languageForFile(name, detectedLanguage)
      : detectedLanguage;
    var uri = monaco.Uri.file(filePath);

    var model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(content, language, uri);
    } else {
      model.setValue(content);
      monaco.editor.setModelLanguage(model, language);
    }

    var tab = { path: filePath, name: name, model: model, language: language, dirty: false };
    if (BOBO.taskProblemMatcher && BOBO.taskProblemMatcher.applyModel) BOBO.taskProblemMatcher.applyModel(model);
    S.tabs.push(tab);
    activateTab(filePath);
    addTabToBar(tab, S.tabs.length - 1);
    updateTitlebar();
	if (BOBO.collaboration && BOBO.collaboration.onFileOpened) BOBO.collaboration.onFileOpened(filePath);
  }

  function activateTab(filePath) {
    if (activateWorkbenchTab(filePath)) return;
    var tab = S.tabs.find(function(t) { return t.path === filePath; });
    if (!tab) return;
    deactivateWorkbenchTabs();
    S.activeTabPath = filePath;
    // Docker mode follows the active source language, while an explicit Local
    // choice remains untouched inside the runtime selector.
    if (BOBO.runtime && BOBO.runtime.autoSelectForLanguage) BOBO.runtime.autoSelectForLanguage(tab.language);
    if (BOBO.runConfig && BOBO.runConfig.refreshForActiveFile) BOBO.runConfig.refreshForActiveFile();

    if (tab.language === 'image') {
      if (BOBO.views && BOBO.views.showImagePreview) {
        BOBO.views.showImagePreview(tab.path, tab.name);
      }
    } else {
      if (BOBO.views) BOBO.views.closeImagePreview();

      if (S.currentViewMode === 'split' && S.splitEditor) {
        S.splitEditor.setModel(tab.model);
        var rightModel = S.splitEditor.rightEditor.getModel();
        rightModel.setValue(tab.model.getValue());
        monaco.editor.setModelLanguage(rightModel, tab.model.getLanguageId());
      } else if (S.currentViewMode === 'diff') {
        if (BOBO.views && BOBO.views.closeDiff) BOBO.views.closeDiff();
        S.editor.setModel(tab.model);
      } else {
        S.editor.setModel(tab.model);
      }
    }

    notifyWorkbenchFileActivated(tab);
    refreshTabBarActive();
    updateTitlebar();
    updateEmptyState();
    BOBO.editorCore.updateStatusBar(tab.model, tab.language !== 'image' ? S.editor.getPosition() : null);
    if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('language');
    if (BOBO.collaboration && BOBO.collaboration.onFileActivated) BOBO.collaboration.onFileActivated(filePath);
  }

  async function closeTab(filePath, options) {
    var workbenchClose = closeWorkbenchTab(filePath);
    if (workbenchClose) return workbenchClose;
    if (S.workspaceTransitionLocked) return false;
    options = options || {};
    var idx = -1;
    for (var i = 0; i < S.tabs.length; i++) {
      if (S.tabs[i].path === filePath) { idx = i; break; }
    }
    if (idx === -1) return true;

    var tab = S.tabs[idx];
    if (tab.dirty && !options.force) {
      var ok = await BOBO.confirm({
        title: 'Close unsaved file?',
        message: tab.path + '\nUnsaved changes will be lost.',
        confirmLabel: 'Close',
        danger: true
      });
      if (!ok) return false;
    }

    // Dispose Monaco model to prevent memory leak (skip for images)
    if (tab.model && tab.language !== 'image') {
      try { tab.model.dispose(); } catch(e) { /* ignore */ }
    }

	S.tabs.splice(idx, 1);
	syncDirtyPaths.delete(filePath);
	if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.setBufferDirty(filePath, false);
	if (BOBO.collaboration && BOBO.collaboration.onFileClosed) BOBO.collaboration.onFileClosed(filePath);
    removeTabFromBar(idx);

    if (S.activeTabPath === filePath) {
      var next = S.tabs[idx] || S.tabs[idx - 1];
      S.activeTabPath = next ? next.path : null;
      if (next) {
        if (S.currentViewMode === 'split' && S.splitEditor) {
          S.splitEditor.setModel(next.model);
        } else if (S.currentViewMode === 'diff') {
          if (BOBO.views && BOBO.views.closeDiff) BOBO.views.closeDiff();
        }
        S.editor.setModel(next ? next.model : null);
      } else {
        S.editor.setModel(null);
        S.currentDiagnostics = { errors: 0, warnings: 0, infos: 0 };
        BOBO.editorCore.updateDiagnosticsStatus();
      }
    }

    refreshTabBarActive();
    updateTitlebar();
    updateEmptyState();
    if (BOBO.collaboration && BOBO.collaboration.onFileActivated) BOBO.collaboration.onFileActivated(S.activeTabPath);
    return true;
  }

  async function saveActiveTab() {
    if (S.workspaceTransitionLocked) return false;
    var tab = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    if (!tab || !tab.model) return false;
    try {
      var content = tab.model.getValue();
      await window.api.saveFile({ filePath: tab.path, content: content });
      if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.markChanged(tab.path);
      tab.dirty = false;
      updateTabDirtyFlag(S.tabs.indexOf(tab), false);
      updateTitlebar();
      if (BOBO.toast) BOBO.toast.success('Saved ' + tab.name);
      // In 'checkOn: save' mode, run diagnostics now (in 'type' mode they are already live).
      if (BOBO.editorCore && BOBO.editorCore.checkActiveOnSave) BOBO.editorCore.checkActiveOnSave();
      if (BOBO.lsp && BOBO.lsp.documentSaved) BOBO.lsp.documentSaved(tab.model);
      return true;
    } catch (error) {
      showFileOperationError('Save', error);
      return false;
    }
  }

  async function saveAllTabs(options) {
    options = options || {};
    if (S.workspaceTransitionLocked && !options.allowDuringTransition) return false;
    var dirtyTabs = S.tabs.filter(function(tab) { return tab.dirty && tab.model; });
    try {
      for (var i = 0; i < dirtyTabs.length; i++) {
        var tab = dirtyTabs[i];
        await window.api.saveFile({ filePath: tab.path, content: tab.model.getValue() });
        if (BOBO.workspaceSyncStatus) BOBO.workspaceSyncStatus.markChanged(tab.path);
        tab.dirty = false;
        if (BOBO.lsp && BOBO.lsp.documentSaved) BOBO.lsp.documentSaved(tab.model);
        updateTabDirtyFlag(S.tabs.indexOf(tab), false);
      }
      if (dirtyTabs.length) updateTitlebar();
      return true;
    } catch (error) {
      showFileOperationError('Save', error);
      return false;
    }
  }

  // ──── Tab Bar Incremental Operations ────
  // ──── Tab Drag-and-Drop ────
  function setupTabDrag(el, draggable) {
    el.setAttribute('draggable', draggable ? 'true' : 'false');

    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateTab(el.getAttribute('data-tab-path'));
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var tabs = Array.prototype.slice.call(document.querySelectorAll('#tabbar .tab'));
      var index = tabs.indexOf(el);
      if (index < 0 || tabs.length < 2) return;
      e.preventDefault();
      var next = tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      activateTab(next.getAttribute('data-tab-path'));
    });

    // Workbench-owned pages participate in keyboard tab navigation but do
    // not alter the file-tab order. They have no Monaco model to reorder.
    if (!draggable) return;

    el.addEventListener('dragstart', function(e) {
      var idx = el.getAttribute('data-tab-index');
      e.dataTransfer.setData('text/plain', idx);
      e.dataTransfer.effectAllowed = 'move';
      el.style.opacity = '0.5';
    });

    el.addEventListener('dragend', function(e) {
      el.style.opacity = '';
      var bar = document.getElementById('tabbar');
      var allTabs = bar.querySelectorAll('.tab');
      for (var i = 0; i < allTabs.length; i++) {
        allTabs[i].classList.remove('drag-over');
      }
    });

    el.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });

    el.addEventListener('dragleave', function(e) {
      el.classList.remove('drag-over');
    });

    el.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
      el.style.opacity = '';

      var fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      var toIdx = parseInt(el.getAttribute('data-tab-index'), 10);
      if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx ||
          fromIdx < 0 || toIdx < 0 || fromIdx >= S.tabs.length || toIdx >= S.tabs.length) return;

      // Reorder tabs array
      var moved = S.tabs.splice(fromIdx, 1)[0];
      S.tabs.splice(toIdx, 0, moved);

      // Full rebuild to sync DOM with new order
      updateTabbar();
      updateTitlebar();
    });
  }

  function createTabElement(tab, index, providerId) {
    var barTab = document.createElement('div');
    var key = providerId ? tab.key : tab.path;
    var active = key === S.activeTabPath;
    barTab.className = 'tab' + (active ? ' active' : '') + (providerId ? ' workbench-tab' : '');
    barTab.setAttribute('data-tab-path', key);
    if (providerId) barTab.setAttribute('data-tab-provider', providerId);
    else barTab.setAttribute('data-tab-index', index);
    barTab.setAttribute('role', 'tab');
    barTab.setAttribute('aria-selected', active ? 'true' : 'false');
    barTab.tabIndex = active ? 0 : -1;

    var title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = providerId ? tab.name : (tab.dirty ? tab.name + ' *' : tab.name);
    title.title = providerId ? tab.title : tab.name;
    barTab.appendChild(title);

    if (!providerId || tab.closeable !== false) {
      var close = document.createElement('button');
      close.className = 'close';
      close.type = 'button';
      close.title = 'Close ' + tab.name;
      close.setAttribute('aria-label', 'Close ' + tab.name);
      // The workbench tab provider can refresh tabs during early startup,
      // before the optional icon registry is available.
      close.innerHTML = BOBO.icons && BOBO.icons.close ? BOBO.icons.close : '';
      close.onclick = (function(tabKey) {
        return function(e) {
          e.stopPropagation();
          closeTab(tabKey);
        };
      })(key);
      barTab.appendChild(close);
    }

    barTab.onclick = (function(tabKey) { return function() { activateTab(tabKey); }; })(key);
    setupTabDrag(barTab, providerId ? tab.draggable === true : true);
    return barTab;
  }

  function addTabToBar(tab, index) {
    updateTabbar();
  }

  function removeTabFromBar(index) {
    updateTabbar();
  }

  function updateTabDirtyFlag(index, dirty) {
    var tab = S.tabs[index];
    if (tab) {
      trackTabSyncState(tab);
      updateTabbar();
    }
  }

  function refreshTabBarActive() {
    var bar = document.getElementById('tabbar');
    var tabs = bar.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var path = tabs[i].getAttribute('data-tab-path');
      if (path === S.activeTabPath) {
        tabs[i].classList.add('active');
        tabs[i].setAttribute('aria-selected', 'true');
        tabs[i].tabIndex = 0;
      } else {
        tabs[i].classList.remove('active');
        tabs[i].setAttribute('aria-selected', 'false');
        tabs[i].tabIndex = -1;
      }
    }
  }

  function reindexTabBar() {
    var bar = document.getElementById('tabbar');
    var tabs = bar.querySelectorAll('.tab:not([data-tab-provider])');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('data-tab-index', i);
    }
    refreshTabBarActive();
  }

  function updateTabbar() {
    // Full rebuild keeps file tabs and isolated workbench pages in one
    // keyboard-accessible tab strip. Only file tabs are draggable.
    var bar = document.getElementById('tabbar');
    if (!bar) return;
    bar.innerHTML = '';
    for (var i = 0; i < S.tabs.length; i++) {
      var t = S.tabs[i];
      trackTabSyncState(t);
      bar.appendChild(createTabElement(t, i, null));
    }
    workbenchTabsFromProviders().forEach(function(tab) {
      bar.appendChild(createTabElement(tab, -1, tab.providerId));
    });
  }

  function updateTitlebar() {
    var label = document.getElementById('workspace-label');
    var workbenchTab = findWorkbenchTab(S.activeTabPath);
    if (workbenchTab) {
      label.textContent = t('Extensions') + ' / ' + workbenchTab.tab.name;
      label.title = workbenchTab.tab.title;
      return;
    }
    var root = S.workspaceRoot || '';
    var rootParts = root.split(/[/\\]/).filter(Boolean);
    var base = root ? (rootParts[rootParts.length - 1] || root) : 'No folder opened';
    var active = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    var relative = active && root && active.path.indexOf(root) === 0
      ? active.path.slice(root.length).replace(/^[/\\]+/, '')
      : (active ? active.path : '');
    label.textContent = active ? base + ' / ' + relative + (active.dirty ? ' *' : '') : base;
    label.title = active ? active.path : root;
  }

  function updateEmptyState() {
    var editor = document.getElementById('editor');
    var el = document.getElementById('empty-state');
    if (!el || !editor) return;
    if (S.tabs.length === 0 && !findWorkbenchTab(S.activeTabPath)) {
      el.classList.remove('hidden');
      editor.classList.add('empty');
      var title = el.querySelector('.empty-state-title');
      var subtitle = el.querySelector('.empty-state-subtitle');
      var openButton = document.getElementById('empty-state-open');
      if (S.workspaceRoot) {
        if (title) title.textContent = 'Choose a file to start editing';
        if (subtitle) subtitle.textContent = 'Your workspace is ready in the Explorer';
        if (openButton) openButton.style.display = 'none';
      } else {
        if (title) title.textContent = 'Open a folder to start';
        if (subtitle) subtitle.textContent = 'Browse your project files and start coding';
        if (openButton) openButton.style.display = '';
      }
    } else {
      el.classList.add('hidden');
      editor.classList.remove('empty');
    }
  }

  // ──── Global Keys (bound ONCE at init) ────
  function setupGlobalKeys() {
    window.addEventListener('keydown', async function(e) {
      var primaryModifier = e.ctrlKey || e.metaKey;
      // Command palette works everywhere (even in inputs)
      if (primaryModifier && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        if (BOBO.commands) BOBO.commands.show();
        return;
      }

      // Ctrl+P - File fuzzy search
      if (primaryModifier && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        if (BOBO.fileSearch) BOBO.fileSearch.show();
        return;
      }

      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Ctrl+W - Close tab
      if (primaryModifier && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        if (S.activeTabPath) closeTab(S.activeTabPath);
        return;
      }
      // Ctrl+, - Settings
      if (primaryModifier && e.key === ',') {
        e.preventDefault();
        if (BOBO.settings) BOBO.settings.open('local');
        return;
      }

      // Escape to close diff or split view
      if (e.key === 'Escape') {
        if (S.currentViewMode === 'diff') {
          e.preventDefault();
          if (BOBO.views && BOBO.views.closeDiff) BOBO.views.closeDiff();
          return;
        }
        if (S.currentViewMode === 'split') {
          e.preventDefault();
          if (BOBO.views && BOBO.views.closeSplit) BOBO.views.closeSplit();
          return;
        }
      }

      if (e.key === 'F5' && primaryModifier) {
        e.preventDefault();
        if (BOBO.projectTasks) BOBO.projectTasks.runSelected();
        else if (BOBO.runner) BOBO.runner.runActive();
        return;
      }

      if (e.key === 'F5') {
        e.preventDefault();
        if (BOBO.dap) {
          if (BOBO.dap.isPaused()) BOBO.dap.execute('continue');
          else if (!BOBO.dap.isActive()) BOBO.dap.start();
        }
        return;
      }

      var active = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
      if (!active) return;
      if (e.key === 'F2') {
        e.preventDefault();
        promptRename(active.path);
      }
      if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        promptDelete(active.path, 'file');
      }
    });
  }

  // ──── Sidebar resizer ────
  // Compatibility entry point. BOBO.workbench owns all shell resizing.
  function setupSidebarResizer() {
    if (BOBO.workbench) BOBO.workbench.init();
  }

  BOBO.workspace = {
    setupSidebarResizer: setupSidebarResizer,
    setupGlobalKeys: setupGlobalKeys,

    applyWorkspace: applyWorkspace,
    closeWorkspace: closeWorkspace,
    canLeaveWorkspace: canLeaveWorkspace,
    abortWorkspaceLeave: abortWorkspaceLeave,
    renderTree: renderTree,
    refreshFileDecorations: refreshFileDecorations,
    handleFileEvent: handleFileEvent,

    openFile: openFile,
    activateTab: activateTab,
    closeTab: closeTab,
    saveActiveTab: saveActiveTab,
    saveAllTabs: saveAllTabs,
    updateTabbar: updateTabbar,
    updateTitlebar: updateTitlebar,

    addTabToBar: addTabToBar,
    removeTabFromBar: removeTabFromBar,
    updateTabDirtyFlag: updateTabDirtyFlag,
    updateEmptyState: updateEmptyState,

    // Internal workbench pages are registered by trusted renderer modules.
    // Downloaded extensions never receive this bridge; their public API is
    // constrained by renderer/core/plugin-extension-host.js.
    registerWorkbenchTabProvider: registerWorkbenchTabProvider,
    getWorkbenchTab: function(key) {
      var match = findWorkbenchTab(key);
      return match ? Object.assign({}, match.tab) : null;
    }
  };
})(window);
