// Cloud synchronization decorations for the workspace tree.
// This module owns the sync lane only. Source-control decorations use a
// separate lane so Git status letters never compete with cloud state.

import type { Disposable } from '../types/lifecycle';
import type {
  WorkspaceSyncBeginOptionsDto,
  WorkspaceSyncContextDto,
  WorkspaceSyncDecorationDto,
  WorkspaceSyncEntryOptionsDto,
  WorkspaceSyncFileEventDto,
  WorkspaceSyncFinishResultDto,
  WorkspaceSyncPathDto,
  WorkspaceSyncProvider,
  WorkspaceSyncStateDto,
  WorkspaceSyncStatusDependencies,
  WorkspaceSyncStatusFacade,
  WorkspaceSyncStatusService,
  WorkspaceSyncTreeNodeDto
} from '../types/workspace-sync-status';

export const STATUS_PRIORITY = Object.freeze({
  synced: 10,
  'local-only': 20,
  queued: 30,
  syncing: 40,
  error: 50,
  conflict: 60
} satisfies Readonly<Record<WorkspaceSyncStateDto, number>>);

export const STATUS_LABELS = Object.freeze({
  'local-only': 'Local only - not uploaded yet',
  queued: 'Local change - waiting to sync',
  syncing: 'Syncing to cloud',
  synced: 'Synced with cloud',
  error: 'Cloud sync failed',
  conflict: 'Cloud sync conflict'
} satisfies Readonly<Record<WorkspaceSyncStateDto, string>>);

export const WORKSPACE_SYNC_STATUS_SERVICE_ID = 'workbench.workspaceSyncStatus';

const MAX_RECENT_MUTATIONS = 2048;

interface SyncEntry {
  state: WorkspaceSyncStateDto;
  revision: number;
  deleted: boolean;
  error: string;
}

interface TreeIndexEntry {
  readonly node: WorkspaceSyncTreeNodeDto;
  readonly parent: string;
  readonly children: string[];
}

interface AggregateEntry {
  state: WorkspaceSyncStateDto;
  count: number;
}

interface WorkspaceOverride {
  state: WorkspaceSyncStateDto;
  revision: number;
  error: string;
}

interface RootOperation {
  state: 'syncing' | 'error';
  id: number;
}

interface ActiveSyncContext extends WorkspaceSyncContextDto {
  readonly captured: Map<string, number>;
}

interface SyncDetailsNode {
  readonly type?: unknown;
  readonly [key: string]: unknown;
}

function isPathDto(value: unknown): value is WorkspaceSyncPathDto {
  return value !== null && typeof value === 'object' && 'path' in value;
}

function isSyncDetailsNode(value: unknown): value is SyncDetailsNode {
  return value !== null && typeof value === 'object';
}

export function createWorkspaceSyncStatus(
  dependencies: WorkspaceSyncStatusDependencies
): WorkspaceSyncStatusService {
  const listeners = new Set<() => void>();
  const entries = new Map<string, SyncEntry>();
  const bufferDirty = new Set<string>();
  const conflicts = new Set<string>();
  const treeIndex = new Map<string, TreeIndexEntry>();
  const aggregate = new Map<string, AggregateEntry>();
  const recentMutations = new Map<string, true>();
  let rootPath = '';
  let rootKey = '';
  let tree: WorkspaceSyncTreeNodeDto | null = null;
  let revision = 0;
  let syncSequence = 0;
  let baselineState: WorkspaceSyncStateDto = 'local-only';
  let hasSuccessfulSync = false;
  let activeSync: ActiveSyncContext | null = null;
  let workspaceOverride: WorkspaceOverride | null = null;
  let rootOperation: RootOperation | null = null;
  let aggregateDirty = true;
  let refreshFrame: number | null = null;
  let contributionDisposable: Disposable | null = null;
  let disposed = false;

  function reportError(phase: 'listener' | 'dispose', error: unknown): void {
    try {
      dependencies.reportError(phase, error);
    } catch (_) {
      // An error observer must not interrupt listener isolation or disposal.
    }
  }

  function t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, params);
    return String(source).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => (
      params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    ));
  }

  function normalizePath(value: unknown): string {
    let normalized = String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (normalized.length > 1 && /\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '');
    if (/^[a-zA-Z]:\//.test(normalized)) normalized = normalized.toLowerCase();
    return normalized;
  }

  function isInsideWorkspace(key: string): boolean {
    return Boolean(rootKey && (key === rootKey || key.indexOf(rootKey + '/') === 0));
  }

  function resolveKey(pathValue: unknown): string {
    const normalized = normalizePath(pathValue);
    // File-decoration providers receive workspace-relative resources. The
    // empty resource is the workspace root, not a missing path.
    if (!normalized) return rootKey || '';
    if (isInsideWorkspace(normalized)) return normalized;
    if (!rootKey) return normalized;
    return normalizePath(rootKey + '/' + normalized.replace(/^\/+/, ''));
  }

  function relativePath(pathValue: unknown): string {
    const key = resolveKey(pathValue);
    if (!rootKey || key === rootKey) return '';
    return isInsideWorkspace(key) ? key.slice(rootKey.length + 1) : key;
  }

  function highestState(
    left: WorkspaceSyncStateDto,
    right: WorkspaceSyncStateDto
  ): WorkspaceSyncStateDto {
    return STATUS_PRIORITY[right] > STATUS_PRIORITY[left] ? right : left;
  }

  function markAggregateDirty(): void {
    if (disposed) return;
    aggregateDirty = true;
    scheduleRefresh();
  }

  function notifyChange(): void {
    if (disposed) return;
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        reportError('listener', error);
      }
    });
  }

  function scheduleRefresh(): void {
    if (disposed) return;
    if (refreshFrame !== null || typeof dependencies.requestFrame !== 'function') {
      if (typeof dependencies.requestFrame !== 'function') {
        refreshVisible();
        notifyChange();
      }
      return;
    }
    refreshFrame = dependencies.requestFrame(() => {
      refreshFrame = null;
      if (disposed) return;
      notifyChange();
    });
  }

  function rebuildTreeIndex(nextTree: WorkspaceSyncTreeNodeDto | null | undefined): void {
    treeIndex.clear();
    tree = nextTree || null;
    if (!tree) return;
    const pending: Array<{ node: WorkspaceSyncTreeNodeDto; parent: string }> = [
      { node: tree, parent: '' }
    ];
    while (pending.length) {
      const current = pending.pop() as { node: WorkspaceSyncTreeNodeDto; parent: string };
      const key = normalizePath(current.node.path);
      const children: readonly WorkspaceSyncTreeNodeDto[] = current.node.children || [];
      treeIndex.set(key, {
        node: current.node,
        parent: current.parent,
        children: children.map((child) => normalizePath(child.path))
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) pending.push({ node: child, parent: key });
      }
    }
  }

  function nearestTreeAncestor(key: string): string {
    let candidate = key;
    while (candidate && isInsideWorkspace(candidate)) {
      if (treeIndex.has(candidate)) return candidate;
      const slash = candidate.lastIndexOf('/');
      if (slash < 0) break;
      candidate = candidate.slice(0, slash);
    }
    return rootKey;
  }

  function entryState(key: string): WorkspaceSyncStateDto {
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

  function recomputeAggregate(): void {
    if (!aggregateDirty) return;
    aggregateDirty = false;
    aggregate.clear();
    if (!tree || !rootKey) return;

    const stack: Array<{ key: string; visited: boolean }> = [
      { key: rootKey, visited: false }
    ];
    while (stack.length) {
      const current = stack.pop() as { key: string; visited: boolean };
      const indexed = treeIndex.get(current.key);
      if (!indexed) continue;
      if (!current.visited) {
        stack.push({ key: current.key, visited: true });
        for (let index = indexed.children.length - 1; index >= 0; index -= 1) {
          const childKey = indexed.children[index];
          if (childKey !== undefined) stack.push({ key: childKey, visited: false });
        }
        continue;
      }
      let state = entryState(current.key);
      let count = indexed.node.type === 'file' ? 1 : 0;
      indexed.children.forEach((childKey) => {
        const child = aggregate.get(childKey);
        if (!child) return;
        state = highestState(state, child.state);
        count += child.count;
      });
      aggregate.set(current.key, { state, count: count || 1 });
    }

    // Deleted paths stay as tombstones until the next successful upload. Fold
    // them into their closest visible parent so deletion is not invisible.
    entries.forEach((entry, key) => {
      if (!entry.deleted || treeIndex.has(key)) return;
      const parentKey = nearestTreeAncestor(key);
      let cursor = parentKey;
      while (cursor && treeIndex.has(cursor)) {
        const current = aggregate.get(cursor) || { state: baselineState, count: 0 };
        current.state = highestState(current.state, entryState(key));
        current.count += 1;
        aggregate.set(cursor, current);
        cursor = treeIndex.get(cursor)?.parent || '';
      }
    });

    if (rootOperation && aggregate.has(rootKey)) {
      const root = aggregate.get(rootKey) as AggregateEntry;
      root.state = highestState(root.state, rootOperation.state);
    }
  }

  function detailsFor(pathValue: unknown, node?: SyncDetailsNode | null): WorkspaceSyncDecorationDto {
    const key = resolveKey(pathValue);
    recomputeAggregate();
    const indexed = treeIndex.get(key);
    const type = node?.type || indexed?.node.type || 'file';
    const summary = type === 'folder' ? aggregate.get(key) : null;
    const state = conflicts.has(key) ? 'conflict' : summary ? summary.state : entryState(key);
    const count = summary ? summary.count : 1;
    const statusLabel = t(STATUS_LABELS[state] || STATUS_LABELS['local-only']);
    const tooltip = type === 'folder'
      ? t('Folder cloud sync: {status} ({count} items)', { status: statusLabel, count })
      : t('Cloud sync: {status}', { status: statusLabel });
    const entry = entries.get(key);
    const error = state === 'error' && entry?.error ||
      state === 'error' && workspaceOverride?.error || '';
    return {
      status: state,
      badge: 'cloud',
      tooltip: error ? tooltip + ': ' + error : tooltip,
      ariaLabel: tooltip,
      count,
      lane: 'sync'
    };
  }

  function decorationMarkup(): string {
    return dependencies.getCloudIcon();
  }

  function decorateRow(
    row: HTMLElement | null | undefined,
    node: WorkspaceSyncTreeNodeDto | null | undefined
  ): HTMLElement | null {
    if (!row || !node || !node.path) return null;
    let rail = row.querySelector(':scope > .tree-sync-rail') as HTMLElement | null;
    if (!rail) {
      const documentRef = dependencies.document;
      if (!documentRef) return null;
      rail = documentRef.createElement('span');
      rail.className = 'tree-decoration-rail tree-sync-rail';
      rail.setAttribute('data-decoration-kind', 'cloud-sync');
      rail.setAttribute('role', 'img');
      rail.innerHTML = '<span class="tree-sync-cloud" aria-hidden="true">' +
        decorationMarkup() + '</span><span class="tree-sync-state-mark" aria-hidden="true"></span>';
      row.appendChild(rail);
    }
    const detail = detailsFor(node.path, node);
    rail.setAttribute('data-sync-state', detail.status);
    rail.setAttribute('title', detail.tooltip);
    rail.setAttribute('aria-label', detail.ariaLabel);
    row.setAttribute('data-sync-state', detail.status);
    return rail;
  }

  function refreshVisible(): void {
    const documentRef = dependencies.document;
    if (!documentRef) return;
    const workspace = dependencies.getWorkspace();
    if (workspace && typeof workspace.refreshFileDecorations === 'function') {
      workspace.refreshFileDecorations('sync');
      return;
    }
    recomputeAggregate();
    const rows = documentRef.querySelectorAll('#file-tree .tree-row[data-path]');
    rows.forEach((row) => {
      decorateRow(row as HTMLElement, {
        path: row.getAttribute('data-path') || '',
        type: row.getAttribute('data-type') || undefined,
        name: row.getAttribute('data-name') || undefined
      });
    });
  }

  function resetWorkspace(nextRoot: unknown, nextTree?: WorkspaceSyncTreeNodeDto | null): void {
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

  function clearWorkspace(): void {
    resetWorkspace('', null);
  }

  function setTree(nextTree?: WorkspaceSyncTreeNodeDto | null): void {
    const previousKeys = new Set(treeIndex.keys());
    const wasInitialized = Boolean(rootKey && tree);
    rebuildTreeIndex(nextTree);
    if (wasInitialized) {
      treeIndex.forEach((_value, key) => {
        if (!previousKeys.has(key)) markChanged(key);
      });
      previousKeys.forEach((key) => {
        if (key !== rootKey && !treeIndex.has(key)) markDeleted(key);
      });
    }
    markAggregateDirty();
  }

  function setEntry(
    pathValue: unknown,
    state: WorkspaceSyncStateDto,
    options?: WorkspaceSyncEntryOptionsDto | null
  ): boolean {
    const key = resolveKey(pathValue);
    if (!isInsideWorkspace(key)) return false;
    const mutationId = typeof options?.mutationId === 'string' ? options.mutationId : '';
    if (mutationId) {
      const mutationKey = key + '\0' + mutationId;
      if (recentMutations.has(mutationKey)) return false;
      recentMutations.set(mutationKey, true);
      while (recentMutations.size > MAX_RECENT_MUTATIONS) {
        const oldest = recentMutations.keys().next();
        if (oldest.done) break;
        recentMutations.delete(oldest.value);
      }
    }
    revision += 1;
    entries.set(key, {
      state,
      revision,
      deleted: Boolean(options?.deleted),
      error: options?.error ? String(options.error) : ''
    });
    if (rootOperation?.state === 'error') rootOperation = null;
    markAggregateDirty();
    return true;
  }

  function markChanged(pathValue: unknown, options?: WorkspaceSyncEntryOptionsDto | null): boolean {
    return setEntry(pathValue, 'queued', options);
  }

  function markDeleted(pathValue: unknown): boolean {
    return setEntry(pathValue, 'queued', { deleted: true });
  }

  function markWorkspaceChanged(): void {
    revision += 1;
    workspaceOverride = { state: 'queued', revision, error: '' };
    rootOperation = null;
    markAggregateDirty();
  }

  function setBufferDirty(pathValue: unknown, dirty: boolean): boolean {
    const key = resolveKey(pathValue);
    if (!isInsideWorkspace(key)) return false;
    const changed = dirty ? !bufferDirty.has(key) : bufferDirty.has(key);
    if (dirty) bufferDirty.add(key);
    else bufferDirty.delete(key);
    if (changed) markAggregateDirty();
    return changed;
  }

  function handleFileEvent(event?: WorkspaceSyncFileEventDto | null): boolean {
    if (!event || !event.path) return false;
    if (event.event === 'file-deleted') return markDeleted(event.path);
    if (event.event === 'file-created' || event.event === 'file-changed') {
      return markChanged(event.path, {
        mutationId: typeof event.mutationId === 'string' ? event.mutationId : undefined
      });
    }
    return false;
  }

  function beginSync(options?: WorkspaceSyncBeginOptionsDto | null): WorkspaceSyncContextDto {
    const captured = new Map<string, number>();
    entries.forEach((entry, key) => {
      if (entry.state !== 'synced') captured.set(key, entry.revision);
    });
    const context: ActiveSyncContext = {
      id: ++syncSequence,
      rootKey,
      revision,
      captured,
      workspaceRevision: workspaceOverride ? workspaceOverride.revision : null,
      full: !hasSuccessfulSync || Boolean(workspaceOverride),
      force: options?.force === true
    };
    activeSync = context;
    rootOperation = { state: 'syncing', id: context.id };
    markAggregateDirty();
    return context;
  }

  function finishSync(
    context?: WorkspaceSyncContextDto | null,
    result?: WorkspaceSyncFinishResultDto | null
  ): boolean {
    if (!context || !activeSync || context.id !== activeSync.id || context.rootKey !== rootKey) return false;
    const resolvedResult = result || {};
    activeSync = null;
    const success = resolvedResult.success === true;
    const rawError = resolvedResult.error;
    let errorValue: unknown = rawError;
    if (rawError && (typeof rawError === 'object' || typeof rawError === 'function')) {
      errorValue = Reflect.get(rawError, 'message') || rawError;
    }
    const error = rawError && errorValue ? String(errorValue) : '';
    if (success) {
      hasSuccessfulSync = true;
      baselineState = 'synced';
      entries.forEach((entry, key) => {
        if (entry.revision <= context.revision) entries.delete(key);
      });
      if (workspaceOverride && workspaceOverride.revision <= context.revision) workspaceOverride = null;
      rootOperation = null;
      // bufferDirty is an independent overlay, so unsaved Monaco models stay
      // queued without being mistaken for on-disk changes uploaded by rclone.
    } else if (context.full) {
      workspaceOverride = { state: 'error', revision: context.revision, error };
      entries.forEach((entry, key) => {
        if (entry.revision <= context.revision) entries.delete(key);
      });
      rootOperation = { state: 'error', id: context.id };
    } else {
      context.captured.forEach((capturedRevision, key) => {
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

  function setConflicts(paths?: readonly (string | WorkspaceSyncPathDto)[] | null): void {
    conflicts.clear();
    (Array.isArray(paths) ? paths : []).forEach((pathValue) => {
      const candidate = isPathDto(pathValue) && pathValue.path ? pathValue.path : pathValue;
      const key = resolveKey(candidate);
      if (isInsideWorkspace(key)) conflicts.add(key);
    });
    markAggregateDirty();
  }

  function onDidChange(listener: () => void): Disposable {
    if (typeof listener !== 'function') return { dispose: () => {} };
    if (disposed) return { dispose: () => {} };
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  }

  function getDecoration(
    pathValue: string,
    node: unknown
  ): WorkspaceSyncDecorationDto | null {
    return rootKey ? detailsFor(pathValue, isSyncDetailsNode(node) ? node : null) : null;
  }

  const provider: WorkspaceSyncProvider = Object.freeze({
    id: 'core.sync-status',
    namespace: 'bobocloud.sync',
    lane: 'sync',
    priority: 100,
    getDecoration,
    onDidChange
  });

  function registerContribution(): boolean {
    if (disposed || contributionDisposable) return false;
    const disposable = dependencies.registerContribution(provider);
    contributionDisposable = disposable || null;
    return contributionDisposable !== null;
  }

  const languageChangeListener = (): void => {
    markAggregateDirty();
  };
  const platformReadyListener = (): void => {
    registerContribution();
  };
  dependencies.events.addEventListener('bobo:language-changed', languageChangeListener);
  dependencies.events.addEventListener('bobo:platform-ready', platformReadyListener);

  const service: WorkspaceSyncStatusService = Object.freeze({
    get disposed(): boolean { return disposed; },
    states: Object.freeze(Object.keys(STATUS_PRIORITY) as WorkspaceSyncStateDto[]),
    provider,
    resetWorkspace,
    clearWorkspace,
    setTree,
    markChanged,
    markDeleted,
    markWorkspaceChanged,
    setBufferDirty,
    handleFileEvent,
    beginSync,
    finishSync,
    setConflicts,
    getDecoration,
    decorateRow,
    refreshVisible,
    registerContribution,
    toWorkspaceRelativePath: relativePath,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (refreshFrame !== null) {
        if (dependencies.cancelFrame) {
          try {
            dependencies.cancelFrame(refreshFrame);
          } catch (error) {
            reportError('dispose', error);
          }
        }
        refreshFrame = null;
      }
      dependencies.events.removeEventListener('bobo:language-changed', languageChangeListener);
      dependencies.events.removeEventListener('bobo:platform-ready', platformReadyListener);
      if (contributionDisposable) {
        try {
          contributionDisposable.dispose();
        } catch (error) {
          reportError('dispose', error);
        }
        contributionDisposable = null;
      }
      listeners.clear();
      entries.clear();
      bufferDirty.clear();
      conflicts.clear();
      treeIndex.clear();
      aggregate.clear();
      recentMutations.clear();
      tree = null;
      activeSync = null;
    }
  });

  return service;
}

export { createWorkspaceSyncStatus as createWorkspaceSyncStatusService };
