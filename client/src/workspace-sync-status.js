// Cloud synchronization decorations for the workspace tree.
// This module owns the sync lane only. Source-control decorations use a
// separate lane so Git status letters never compete with cloud state.

const STATUS_PRIORITY = Object.freeze({
  synced: 10,
  'local-only': 20,
  queued: 30,
  syncing: 40,
  error: 50,
  conflict: 60
});

const STATUS_LABELS = Object.freeze({
  'local-only': 'Local only - not uploaded yet',
  queued: 'Local change - waiting to sync',
  syncing: 'Syncing to cloud',
  synced: 'Synced with cloud',
  error: 'Cloud sync failed',
  conflict: 'Cloud sync conflict'
});

const MAX_RECENT_MUTATIONS = 2048;

function createWorkspaceSyncStatus(globalObject) {
  const global = globalObject;
  const listeners = new Set();
  const entries = new Map();
  const bufferDirty = new Set();
  const conflicts = new Set();
  const treeIndex = new Map();
  const aggregate = new Map();
  const recentMutations = new Map();
  let rootPath = '';
  let rootKey = '';
  let tree = null;
  let revision = 0;
  let syncSequence = 0;
  let baselineState = 'local-only';
  let hasSuccessfulSync = false;
  let activeSync = null;
  let workspaceOverride = null;
  let rootOperation = null;
  let aggregateDirty = true;
  let refreshFrame = null;
  let contributionDisposable = null;

  function t(source, params) {
    const BOBO = global.BOBO || {};
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, params);
    return String(source).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, key) {
      return params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
    });
  }

  function normalizePath(value) {
    let normalized = String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (normalized.length > 1 && /\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '');
    if (/^[a-zA-Z]:\//.test(normalized)) normalized = normalized.toLowerCase();
    return normalized;
  }

  function isInsideWorkspace(key) {
    return Boolean(rootKey && (key === rootKey || key.indexOf(rootKey + '/') === 0));
  }

  function resolveKey(pathValue) {
    const normalized = normalizePath(pathValue);
    // File-decoration providers receive workspace-relative resources. The
    // empty resource is the workspace root, not a missing path.
    if (!normalized) return rootKey || '';
    if (isInsideWorkspace(normalized)) return normalized;
    if (!rootKey) return normalized;
    return normalizePath(rootKey + '/' + normalized.replace(/^\/+/, ''));
  }

  function relativePath(pathValue) {
    const key = resolveKey(pathValue);
    if (!rootKey || key === rootKey) return '';
    return isInsideWorkspace(key) ? key.slice(rootKey.length + 1) : key;
  }

  function highestState(left, right) {
    return (STATUS_PRIORITY[right] || 0) > (STATUS_PRIORITY[left] || 0) ? right : left;
  }

  function markAggregateDirty() {
    aggregateDirty = true;
    scheduleRefresh();
  }

  function notifyChange() {
    listeners.forEach(function(listener) {
      try { listener(); } catch (error) { console.error('sync decoration listener:', error); }
    });
  }

  function scheduleRefresh() {
    if (refreshFrame != null || !global.requestAnimationFrame) {
      if (!global.requestAnimationFrame) {
        refreshVisible();
        notifyChange();
      }
      return;
    }
    refreshFrame = global.requestAnimationFrame(function() {
      refreshFrame = null;
      notifyChange();
    });
  }

  function rebuildTreeIndex(nextTree) {
    treeIndex.clear();
    tree = nextTree || null;
    if (!tree) return;
    const pending = [{ node: tree, parent: '' }];
    while (pending.length) {
      const current = pending.pop();
      const key = normalizePath(current.node.path);
      treeIndex.set(key, {
        node: current.node,
        parent: current.parent,
        children: (current.node.children || []).map(function(child) { return normalizePath(child.path); })
      });
      const children = current.node.children || [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: children[index], parent: key });
      }
    }
  }

  function nearestTreeAncestor(key) {
    let candidate = key;
    while (candidate && isInsideWorkspace(candidate)) {
      if (treeIndex.has(candidate)) return candidate;
      const slash = candidate.lastIndexOf('/');
      if (slash < 0) break;
      candidate = candidate.slice(0, slash);
    }
    return rootKey;
  }

  function entryState(key) {
    if (conflicts.has(key)) return 'conflict';
    // An unsaved Monaco model is newer than every on-disk snapshot. Keep it
    // queued even while rclone is uploading the older file from disk.
    if (bufferDirty.has(key)) return 'queued';
    const entry = entries.get(key);
    if (activeSync) {
      const capturedRevision = activeSync.captured.get(key);
      if (activeSync.full && (!entry || entry.revision <= activeSync.revision)) return 'syncing';
      if (capturedRevision != null && (!entry || entry.revision <= capturedRevision)) return 'syncing';
    }
    if (entry) return entry.state;
    if (workspaceOverride) return workspaceOverride.state;
    return baselineState;
  }

  function recomputeAggregate() {
    if (!aggregateDirty) return;
    aggregateDirty = false;
    aggregate.clear();
    if (!tree || !rootKey) return;

    const stack = [{ key: rootKey, visited: false }];
    while (stack.length) {
      const current = stack.pop();
      const indexed = treeIndex.get(current.key);
      if (!indexed) continue;
      if (!current.visited) {
        stack.push({ key: current.key, visited: true });
        for (let index = indexed.children.length - 1; index >= 0; index -= 1) {
          stack.push({ key: indexed.children[index], visited: false });
        }
        continue;
      }
      let state = entryState(current.key);
      let count = indexed.node.type === 'file' ? 1 : 0;
      indexed.children.forEach(function(childKey) {
        const child = aggregate.get(childKey);
        if (!child) return;
        state = highestState(state, child.state);
        count += child.count;
      });
      aggregate.set(current.key, { state: state, count: count || 1 });
    }

    // Deleted paths stay as tombstones until the next successful upload. Fold
    // them into their closest visible parent so deletion is not invisible.
    entries.forEach(function(entry, key) {
      if (!entry.deleted || treeIndex.has(key)) return;
      const parentKey = nearestTreeAncestor(key);
      let cursor = parentKey;
      while (cursor && treeIndex.has(cursor)) {
        const current = aggregate.get(cursor) || { state: baselineState, count: 0 };
        current.state = highestState(current.state, entryState(key));
        current.count += 1;
        aggregate.set(cursor, current);
        cursor = treeIndex.get(cursor).parent;
      }
    });

    if (rootOperation && aggregate.has(rootKey)) {
      const root = aggregate.get(rootKey);
      root.state = highestState(root.state, rootOperation.state);
    }
  }

  function detailsFor(pathValue, node) {
    const key = resolveKey(pathValue);
    recomputeAggregate();
    const indexed = treeIndex.get(key);
    const type = node && node.type || indexed && indexed.node.type || 'file';
    const summary = type === 'folder' ? aggregate.get(key) : null;
    const state = conflicts.has(key) ? 'conflict' : summary ? summary.state : entryState(key);
    const count = summary ? summary.count : 1;
    const statusLabel = t(STATUS_LABELS[state] || STATUS_LABELS['local-only']);
    const tooltip = type === 'folder'
      ? t('Folder cloud sync: {status} ({count} items)', { status: statusLabel, count: count })
      : t('Cloud sync: {status}', { status: statusLabel });
    const entry = entries.get(key);
    const error = state === 'error' && entry && entry.error || state === 'error' && workspaceOverride && workspaceOverride.error || '';
    return {
      status: state,
      badge: 'cloud',
      tooltip: error ? tooltip + ': ' + error : tooltip,
      ariaLabel: tooltip,
      count: count,
      lane: 'sync'
    };
  }

  function decorationMarkup() {
    const BOBO = global.BOBO || {};
    return BOBO.icons && BOBO.icons.cloud || '';
  }

  function decorateRow(row, node) {
    if (!row || !node || !node.path) return null;
    let rail = row.querySelector(':scope > .tree-sync-rail');
    if (!rail) {
      rail = global.document.createElement('span');
      rail.className = 'tree-decoration-rail tree-sync-rail';
      rail.setAttribute('data-decoration-kind', 'cloud-sync');
      rail.setAttribute('role', 'img');
      rail.innerHTML = '<span class="tree-sync-cloud" aria-hidden="true">' + decorationMarkup() + '</span><span class="tree-sync-state-mark" aria-hidden="true"></span>';
      row.appendChild(rail);
    }
    const detail = detailsFor(node.path, node);
    rail.setAttribute('data-sync-state', detail.status);
    rail.setAttribute('title', detail.tooltip);
    rail.setAttribute('aria-label', detail.ariaLabel);
    row.setAttribute('data-sync-state', detail.status);
    return rail;
  }

  function refreshVisible() {
    if (!global.document) return;
    const BOBO = global.BOBO || {};
    if (BOBO.workspace && typeof BOBO.workspace.refreshFileDecorations === 'function') {
      BOBO.workspace.refreshFileDecorations('sync');
      return;
    }
    recomputeAggregate();
    const rows = global.document.querySelectorAll('#file-tree .tree-row[data-path]');
    Array.prototype.forEach.call(rows, function(row) {
      decorateRow(row, {
        path: row.getAttribute('data-path'),
        type: row.getAttribute('data-type'),
        name: row.getAttribute('data-name')
      });
    });
  }

  function resetWorkspace(nextRoot, nextTree) {
    rootPath = String(nextRoot || '');
    rootKey = normalizePath(rootPath);
    revision = 0;
    baselineState = 'local-only';
    hasSuccessfulSync = false;
    activeSync = null;
    workspaceOverride = null;
    rootOperation = null;
    entries.clear();
    bufferDirty.clear();
    conflicts.clear();
    recentMutations.clear();
    rebuildTreeIndex(nextTree);
    markAggregateDirty();
  }

  function clearWorkspace() {
    resetWorkspace('', null);
  }

  function setTree(nextTree) {
    const previousKeys = new Set(treeIndex.keys());
    const wasInitialized = Boolean(rootKey && tree);
    rebuildTreeIndex(nextTree);
    if (wasInitialized) {
      treeIndex.forEach(function(_value, key) {
        if (!previousKeys.has(key)) markChanged(key);
      });
      previousKeys.forEach(function(key) {
        if (key !== rootKey && !treeIndex.has(key)) markDeleted(key);
      });
    }
    markAggregateDirty();
  }

  function setEntry(pathValue, state, options) {
    const key = resolveKey(pathValue);
    if (!isInsideWorkspace(key)) return false;
    const mutationId = options && typeof options.mutationId === 'string' ? options.mutationId : '';
    if (mutationId) {
      const mutationKey = key + '\0' + mutationId;
      if (recentMutations.has(mutationKey)) return false;
      recentMutations.set(mutationKey, true);
      while (recentMutations.size > MAX_RECENT_MUTATIONS) {
        recentMutations.delete(recentMutations.keys().next().value);
      }
    }
    revision += 1;
    entries.set(key, {
      state: state,
      revision: revision,
      deleted: Boolean(options && options.deleted),
      error: options && options.error ? String(options.error) : ''
    });
    if (rootOperation && rootOperation.state === 'error') rootOperation = null;
    markAggregateDirty();
    return true;
  }

  function markChanged(pathValue, options) {
    return setEntry(pathValue, 'queued', options);
  }

  function markDeleted(pathValue) {
    return setEntry(pathValue, 'queued', { deleted: true });
  }

  function markWorkspaceChanged() {
    revision += 1;
    workspaceOverride = { state: 'queued', revision: revision, error: '' };
    rootOperation = null;
    markAggregateDirty();
  }

  function setBufferDirty(pathValue, dirty) {
    const key = resolveKey(pathValue);
    if (!isInsideWorkspace(key)) return false;
    const changed = dirty ? !bufferDirty.has(key) : bufferDirty.has(key);
    if (dirty) bufferDirty.add(key);
    else bufferDirty.delete(key);
    if (changed) markAggregateDirty();
    return changed;
  }

  function handleFileEvent(event) {
    if (!event || !event.path) return false;
    if (event.event === 'file-deleted') return markDeleted(event.path);
    if (event.event === 'file-created' || event.event === 'file-changed') {
      return markChanged(event.path, { mutationId: event.mutationId });
    }
    return false;
  }

  function beginSync(options) {
    options = options || {};
    const captured = new Map();
    entries.forEach(function(entry, key) {
      if (entry.state !== 'synced') captured.set(key, entry.revision);
    });
    const context = {
      id: ++syncSequence,
      rootKey: rootKey,
      revision: revision,
      captured: captured,
      workspaceRevision: workspaceOverride && workspaceOverride.revision,
      full: !hasSuccessfulSync || Boolean(workspaceOverride),
      force: options.force === true
    };
    activeSync = context;
    rootOperation = { state: 'syncing', id: context.id };
    markAggregateDirty();
    return context;
  }

  function finishSync(context, result) {
    if (!context || !activeSync || context.id !== activeSync.id || context.rootKey !== rootKey) return false;
    result = result || {};
    activeSync = null;
    const success = result.success === true;
    const error = result.error && (result.error.message || result.error) ? String(result.error.message || result.error) : '';
    if (success) {
      hasSuccessfulSync = true;
      baselineState = 'synced';
      entries.forEach(function(entry, key) {
        if (entry.revision <= context.revision) entries.delete(key);
      });
      if (workspaceOverride && workspaceOverride.revision <= context.revision) workspaceOverride = null;
      rootOperation = null;
      // bufferDirty is an independent overlay, so unsaved Monaco models stay
      // queued without being mistaken for on-disk changes uploaded by rclone.
    } else if (context.full) {
      workspaceOverride = { state: 'error', revision: context.revision, error: error };
      entries.forEach(function(entry, key) {
        if (entry.revision <= context.revision) entries.delete(key);
      });
      rootOperation = { state: 'error', id: context.id };
    } else {
      context.captured.forEach(function(capturedRevision, key) {
        const current = entries.get(key);
        if (current && current.revision <= capturedRevision) {
          current.state = 'error';
          current.error = error;
        }
      });
      rootOperation = { state: 'error', id: context.id };
    }
    markAggregateDirty();
    return true;
  }

  function setConflicts(paths) {
    conflicts.clear();
    (Array.isArray(paths) ? paths : []).forEach(function(pathValue) {
      const key = resolveKey(pathValue && pathValue.path || pathValue);
      if (isInsideWorkspace(key)) conflicts.add(key);
    });
    markAggregateDirty();
  }

  function onDidChange(listener) {
    if (typeof listener !== 'function') return { dispose: function() {} };
    listeners.add(listener);
    return { dispose: function() { listeners.delete(listener); } };
  }

  const provider = Object.freeze({
    id: 'core.sync-status',
    namespace: 'bobocloud.sync',
    lane: 'sync',
    priority: 100,
    getDecoration: function(pathValue, node) { return rootKey ? detailsFor(pathValue, node) : null; },
    onDidChange: onDidChange
  });

  function registerContribution() {
    const contributions = global.BOBO && global.BOBO.platform && global.BOBO.platform.contributions;
    if (contributionDisposable || !contributions || typeof contributions.register !== 'function') return false;
    contributionDisposable = contributions.register('fileDecorations.sync', provider, {
      id: provider.id,
      owner: 'core.sync'
    });
    return true;
  }

  global.addEventListener('bobo:language-changed', function() {
    markAggregateDirty();
  });
  global.addEventListener('bobo:platform-ready', registerContribution);

  return Object.freeze({
    states: Object.freeze(Object.keys(STATUS_PRIORITY)),
    provider: provider,
    resetWorkspace: resetWorkspace,
    clearWorkspace: clearWorkspace,
    setTree: setTree,
    markChanged: markChanged,
    markDeleted: markDeleted,
    markWorkspaceChanged: markWorkspaceChanged,
    setBufferDirty: setBufferDirty,
    handleFileEvent: handleFileEvent,
    beginSync: beginSync,
    finishSync: finishSync,
    setConflicts: setConflicts,
    getDecoration: provider.getDecoration,
    decorateRow: decorateRow,
    refreshVisible: refreshVisible,
    registerContribution: registerContribution,
    toWorkspaceRelativePath: relativePath
  });
}

const workspaceSyncStatus = createWorkspaceSyncStatus(window);
window.BOBO = window.BOBO || {};
window.BOBO.workspaceSyncStatus = workspaceSyncStatus;
workspaceSyncStatus.registerContribution();

export { STATUS_LABELS, STATUS_PRIORITY, createWorkspaceSyncStatus, workspaceSyncStatus };
