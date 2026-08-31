const fs = require('fs');
const path = require('path');
const { readFileBounded, writeFileAtomic } = require('./atomic-file');
const { MAX_TEAM_MAPPING_BYTES, readTeamMapping: readTeamMappingFile } = require('./team-mapping');
const { createWorkspaceWriteQueue, createWorkspaceWriteTracker } = require('./workspace-write-tracker');
const { MAX_WORKSPACE_TEXT_FILE_BYTES } = require('./workspace-limits');
const { RCLONE_IGNORED_DIRECTORIES } = require('../rclone-policy');

const IGNORED_DIRECTORIES = new Set([
  ...RCLONE_IGNORED_DIRECTORIES, '.hg', '.svn'
]);
const MAX_CONCURRENT_TREE_READS = 16;
const MAX_WORKSPACE_BATCH_FILES = 32;
const MAX_WORKSPACE_BATCH_BYTES = 16 * 1024 * 1024;
const DEFAULT_SYNC_MEASUREMENT_LIMITS = Object.freeze({
  maxEntries: 50_000,
  maxDepth: 64,
  maxPathChars: 32_768,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
  timeoutMs: 15_000
});
const DEFAULT_TREE_SCAN_LIMITS = Object.freeze({
  maxNodes: 20_000,
  maxEntriesPerDirectory: 2_000,
  maxDepth: 64,
  maxPathChars: 32_768
});
const DEFAULT_WATCHER_LIMITS = Object.freeze({
  maxWatchers: 2_048,
  maxDepth: 64,
  maxEntriesPerDirectory: 2_000,
  maxScannedEntries: 20_000
});

async function readDirectoryEntriesBounded(directoryPath, maximum, fileSystem = fs) {
  if (!Number.isInteger(maximum) || maximum < 1) return { entries: [], scanned: 0, truncated: true };
  const entries = [];
  let scanned = 0;
  let truncated = false;
  let handle;
  try {
    handle = await fileSystem.promises.opendir(directoryPath);
    for await (const entry of handle) {
      scanned += 1;
      if (entries.length >= maximum) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    return { entries, scanned, truncated };
  } finally {
    if (handle && typeof handle.close === 'function') {
      try { await handle.close(); } catch (_) {}
    }
  }
}

function createWorkspaceController(options) {
  const ipcMain = options.ipcMain;
  const dialog = options.dialog;
  const getWindow = options.getWindow;
  const t = options.t;
  const disposeLsp = options.disposeLsp || (() => {});
  const stopTerminal = options.stopTerminal || (() => {});
  const beforeWorkspaceChange = options.beforeWorkspaceChange || (() => {});
  const afterWorkspaceChange = options.afterWorkspaceChange || (() => {});
  const onWorkspaceChanged = options.onWorkspaceChanged || (() => {});
  const onWorkspaceFilesystemEvent = options.onWorkspaceFilesystemEvent || (() => {});
  const settings = options.settings;
  const assertSafeLocalRoot = options.assertSafeLocalRoot || ((candidate) => path.resolve(candidate));
  const localDirectoryAuthority = options.localDirectoryAuthority || null;
  const workspaceWrites = options.workspaceWriteTracker || createWorkspaceWriteTracker();
  const workspaceWriteQueue = options.workspaceWriteQueue || createWorkspaceWriteQueue();

  const watchers = new Map();
  const watcherDebounceTimers = new Map();
  const pendingTreeReads = [];
  const pendingLeaveRequests = new Map();
  const committedSwitches = new Map();
  let activeTreeReads = 0;
  let treeCache = null;
  let treeCacheIndex = new Map();
  let watcherMode = null;
  let treeRefreshSequence = 0;
  let openSequence = 0;
  let workspaceRoot = null;
  let workspaceIdentity = 0;
  let activeArtifactRunContext = null;
  let leaveRequestSequence = 0;
  const leaveRequestTimeoutMs = Number.isInteger(options.leaveRequestTimeoutMs) && options.leaveRequestTimeoutMs > 0
    ? options.leaveRequestTimeoutMs
    : 15_000;
  const maxArtifactBytes = 32 * 1024 * 1024;
  const allowDirectWorkspacePaths = options.allowDirectWorkspacePaths !== false;
  const syncMeasurementLimits = Object.assign({}, DEFAULT_SYNC_MEASUREMENT_LIMITS, options.syncMeasurementLimits || {});
  const treeScanLimits = Object.assign({}, DEFAULT_TREE_SCAN_LIMITS, options.treeScanLimits || {});
  const watcherLimits = Object.assign({}, DEFAULT_WATCHER_LIMITS, options.watcherLimits || {});

  function windowAvailable() {
    const window = getWindow();
    return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : null;
  }

  function send(channel, payload) {
    const window = windowAvailable();
    if (window) window.webContents.send(channel, payload);
  }

  function requestRendererLeave(reason, targetRoot) {
    const window = windowAvailable();
    if (!window || !workspaceRoot || window.webContents.isLoadingMainFrame()) {
      return Promise.resolve({ allowed: true, leaveToken: null });
    }
    const requestId = ++leaveRequestSequence;
    const leaveToken = 'workspace-leave-' + requestId;
    return new Promise((resolve) => {
      let timer;
      const complete = (allowed, timedOut) => {
        clearTimeout(timer);
        pendingLeaveRequests.delete(requestId);
        resolve({ allowed: allowed === true, leaveToken, timedOut: timedOut === true });
      };
      pendingLeaveRequests.set(requestId, { reason: reason || 'switch', complete });
      timer = setTimeout(() => complete(false, true), leaveRequestTimeoutMs);
      try {
        window.webContents.send('workspace-leave-request', {
          requestId,
          leaveToken,
          reason: reason || 'switch',
          targetRoot: targetRoot || null
        });
      } catch (_) {
        complete(reason === 'window-close', false);
      }
    });
  }

  function abortLeave(leaveToken) {
    if (leaveToken) send('workspace-leave-aborted', { leaveToken });
  }

  function settleLeaveRequests(rendererGone) {
    for (const pending of [...pendingLeaveRequests.values()]) {
      pending.complete(rendererGone && pending.reason === 'window-close');
    }
  }

  function safeStat(candidate) {
    try {
      return fs.statSync(candidate);
    } catch (_) {
      return null;
    }
  }

  function safeWorkspaceRoot(candidate) {
    try {
      return assertSafeLocalRoot(candidate);
    } catch (error) {
      if (error && error.code === 'PROTECTED_LOCAL_DIRECTORY') {
        throw new Error(t('This directory is reserved by BOBOCLOUD and cannot be opened as a workspace.'));
      }
      throw error;
    }
  }

  function clearWatchers() {
    treeRefreshSequence += 1;
    for (const [watchedPath, watcher] of [...watchers]) {
      try { watcher.close(); } catch (_) {}
      watchers.delete(watchedPath);
    }
    for (const [rootPath, timer] of [...watcherDebounceTimers]) {
      clearTimeout(timer);
      watcherDebounceTimers.delete(rootPath);
    }
    watcherMode = null;
    workspaceWrites.clear();
  }

  function pathIsOutside(root, target) {
    const relative = path.relative(root, target);
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  }

  function resolveWorkspacePathWithin(rootPath, candidate, options = {}) {
    if (!rootPath) throw new Error('No workspace is open');
    if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('Invalid workspace path');
    const root = path.resolve(rootPath);
    const target = path.resolve(candidate);
    if (pathIsOutside(root, target) || (!options.allowRoot && target === root)) {
      throw new Error('Path is outside the open workspace');
    }
    let targetStat = null;
    try { targetStat = fs.lstatSync(target); } catch (_) {}
    if (targetStat && targetStat.isSymbolicLink()) {
      throw new Error('Symbolic links cannot be modified from the workspace');
    }
    const realProbe = targetStat ? target : path.dirname(target);
    const rootReal = fs.realpathSync(root);
    const probeReal = fs.realpathSync(realProbe);
    if (pathIsOutside(rootReal, probeReal)) throw new Error('Path resolves outside the open workspace');
    return target;
  }

  function resolveWorkspacePath(candidate, options = {}) {
    return resolveWorkspacePathWithin(workspaceRoot, candidate, options);
  }

  function captureWorkspaceMutation(requireWorkspace = true) {
    if (requireWorkspace && !workspaceRoot) throw new Error('No workspace is open');
    return Object.freeze({
      rootPath: workspaceRoot ? path.resolve(workspaceRoot) : null,
      workspaceIdentity
    });
  }

  function assertWorkspaceMutationCurrent(context, message) {
    const currentRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
    if (!context || context.rootPath !== currentRoot || context.workspaceIdentity !== workspaceIdentity) {
      const error = new Error(message || t('The workspace changed while saving the file.'));
      error.code = 'WORKSPACE_CONTEXT_CHANGED';
      throw error;
    }
  }

  function localizeWorkspaceQueueError(error) {
    if (!error || error.code !== 'WORKSPACE_TRANSITION_IN_PROGRESS') throw error;
    const localized = new Error(t('The workspace changed while saving the file.'));
    localized.code = error.code;
    throw localized;
  }

  function runWorkspaceMutation(scopePath, operation) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Workspace mutation operation is required'));
    const context = captureWorkspaceMutation(true);
    return workspaceWriteQueue.run(scopePath, async () => {
      const assertCurrent = (message) => assertWorkspaceMutationCurrent(context, message);
      assertCurrent();
      const result = await operation(Object.freeze({
        rootPath: context.rootPath,
        workspaceIdentity: context.workspaceIdentity,
        resolvePath(candidate, options = {}) {
          assertCurrent();
          return resolveWorkspacePathWithin(context.rootPath, candidate, options);
        },
        assertCurrent
      }));
      assertCurrent();
      return result;
    }).catch(localizeWorkspaceQueueError);
  }

  function runWorkspaceEpochMutation(scopePath, operation) {
    const context = captureWorkspaceMutation(false);
    return workspaceWriteQueue.run(scopePath, async () => {
      const assertCurrent = (message) => assertWorkspaceMutationCurrent(context, message);
      assertCurrent();
      const result = await operation(Object.freeze({
        rootPath: context.rootPath,
        workspaceIdentity: context.workspaceIdentity,
        assertCurrent
      }));
      assertCurrent();
      return result;
    }).catch(localizeWorkspaceQueueError);
  }

  async function readWorkspaceText(context, candidate, maxBytes = MAX_WORKSPACE_TEXT_FILE_BYTES) {
    assertWorkspaceMutationCurrent(context);
    const filePath = resolveWorkspacePathWithin(context.rootPath, candidate);
    const content = await readFileBounded(filePath, { maxBytes, encoding: 'utf8' });
    assertWorkspaceMutationCurrent(context);
    return content;
  }

  function resolveWorkspaceFile(candidate) {
    const filePath = resolveWorkspacePath(candidate);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Path is not an ordinary workspace file');
    return { filePath, workspaceIdentity };
  }

  function validateEntryName(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim()) throw new Error('Enter a valid name');
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new Error('Names cannot contain path separators');
    }
    return name;
  }

  function ensureWorkspaceDirectories(rootPath, targetDirectory) {
    const root = path.resolve(rootPath);
    if (pathIsOutside(root, targetDirectory)) throw new Error('Path is outside the open workspace');
    const relative = path.relative(root, targetDirectory);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat = null;
      try { stat = fs.lstatSync(current); } catch (_) {}
      if (stat) {
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('Artifact path contains a non-directory or symbolic link');
        }
      } else {
        fs.mkdirSync(current);
      }
    }
  }

  function isIgnoredDirectory(name) {
    return IGNORED_DIRECTORIES.has(String(name || '').toLowerCase());
  }

  function isIgnoredPath(root, target) {
    if (!root || !target || pathIsOutside(path.resolve(root), path.resolve(target))) return true;
    return path.relative(root, target).split(path.sep).some(isIgnoredDirectory);
  }

  async function withTreeReadSlot(task) {
    if (activeTreeReads >= MAX_CONCURRENT_TREE_READS) {
      await new Promise((resolve) => pendingTreeReads.push(resolve));
    }
    activeTreeReads += 1;
    try {
      return await task();
    } finally {
      activeTreeReads -= 1;
      const next = pendingTreeReads.shift();
      if (next) next();
    }
  }

  function compareTreeEntries(left, right) {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
  }

  async function scanTreeDirectory(directoryPath, budget, depth = 0) {
    const state = budget || { nodes: 0, truncated: false };
    let batch;
    try {
      batch = await withTreeReadSlot(() => readDirectoryEntriesBounded(
        directoryPath,
        treeScanLimits.maxEntriesPerDirectory
      ));
    } catch (_) {
      return null;
    }
    let entries = batch.entries;
    entries.sort(compareTreeEntries);
    const children = [];
    let localTruncated = batch.truncated;
    if (localTruncated) {
      state.truncated = true;
    }
    for (const entry of entries) {
      if (state.nodes >= treeScanLimits.maxNodes) {
        localTruncated = true;
        state.truncated = true;
        break;
      }
      const fullPath = path.join(directoryPath, entry.name);
      if (fullPath.length > treeScanLimits.maxPathChars) {
        localTruncated = true;
        state.truncated = true;
        continue;
      }
      state.nodes += 1;
      if (entry.isDirectory()) {
        if (isIgnoredDirectory(entry.name)) {
          children.push({ name: entry.name, path: fullPath, type: 'folder', children: [] });
        } else if (depth >= treeScanLimits.maxDepth) {
          children.push({ name: entry.name, path: fullPath, type: 'folder', children: [], truncated: true });
          localTruncated = true;
          state.truncated = true;
        } else {
          const child = await scanTreeDirectory(fullPath, state, depth + 1);
          if (child) children.push(child);
        }
      } else if (entry.isFile()) {
        children.push({ name: entry.name, path: fullPath, type: 'file' });
      }
    }
    return {
      name: path.basename(directoryPath),
      path: directoryPath,
      type: 'folder',
      children,
      truncated: localTruncated || (depth === 0 && state.truncated)
    };
  }

  async function readTree(directoryPath, useCache = true) {
    if (useCache && treeCache && treeCache.path === directoryPath) return treeCache;
    let stat = null;
    try { stat = await withTreeReadSlot(() => fs.promises.stat(directoryPath)); } catch (_) {}
    if (!stat || !stat.isDirectory()) return null;
    return scanTreeDirectory(directoryPath);
  }

  function setTreeCache(tree) {
    treeCache = tree;
    treeCacheIndex = new Map();
    const pending = tree ? [tree] : [];
    while (pending.length) {
      const node = pending.pop();
      treeCacheIndex.set(node.path, node);
      if (node.children) pending.push(...node.children);
    }
  }

  function invalidateTreeCache() {
    treeCache = null;
    treeCacheIndex.clear();
  }

  function findTreeNode(targetPath) {
    return treeCacheIndex.get(targetPath) || null;
  }

  function sendIncrementalFileChange(rootPath, identity, changedPath, mutationId) {
    if (rootPath !== workspaceRoot || identity !== workspaceIdentity) return;
    const payload = {
      event: 'file-changed',
      path: changedPath,
      name: path.basename(changedPath),
      rootPath,
      workspaceIdentity: identity
    };
    if (mutationId) payload.mutationId = mutationId;
    send('file-event', payload);
  }

  function sendCurrentFileState(rootPath, identity, changedPath) {
    if (rootPath !== workspaceRoot || identity !== workspaceIdentity) return;
    let stat = null;
    try { stat = fs.lstatSync(changedPath); } catch (_) {}
    if (!stat) {
      send('file-event', { event: 'file-deleted', path: changedPath, rootPath, workspaceIdentity: identity });
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      sendIncrementalFileChange(rootPath, identity, changedPath);
    } else {
      scheduleTreeRefresh(rootPath, identity);
    }
  }

  function refreshTreeCacheSilently(rootPath, identity) {
    if (!rootPath || rootPath !== workspaceRoot || identity !== workspaceIdentity) return;
    // A visible structural refresh owns both the cache and renderer update.
    // Never make it stale with a cache-only read.
    if (watcherDebounceTimers.has(rootPath)) return;
    const refreshSequence = ++treeRefreshSequence;
    invalidateTreeCache();
    void readTree(rootPath, false).then((fullTree) => {
      if (rootPath !== workspaceRoot || identity !== workspaceIdentity || refreshSequence !== treeRefreshSequence || !fullTree) return;
      setTreeCache(fullTree);
    }).catch(() => {});
  }

  function scheduleTreeRefresh(rootPath, identity) {
    if (!rootPath || rootPath !== workspaceRoot || identity !== workspaceIdentity) return;
    const refreshSequence = ++treeRefreshSequence;
    if (watcherDebounceTimers.has(rootPath)) clearTimeout(watcherDebounceTimers.get(rootPath));
    watcherDebounceTimers.set(rootPath, setTimeout(async () => {
      watcherDebounceTimers.delete(rootPath);
      if (rootPath !== workspaceRoot || identity !== workspaceIdentity) return;
      if (watcherMode === 'fallback') {
        for (const [watchedPath, watcher] of [...watchers]) {
          if (watchedPath === rootPath) continue;
          const stat = safeStat(watchedPath);
          if (!stat || !stat.isDirectory()) {
            try { watcher.close(); } catch (_) {}
            watchers.delete(watchedPath);
          }
        }
      }
      invalidateTreeCache();
      const fullTree = await readTree(rootPath);
      if (rootPath !== workspaceRoot || identity !== workspaceIdentity || refreshSequence !== treeRefreshSequence || !fullTree) return;
      setTreeCache(fullTree);
      send('workspace-refresh', { rootPath, workspaceIdentity: identity, tree: fullTree });
    }, 300));
  }

  function attachWatcher(directory, root, recursive, identity) {
    if (watchers.has(directory)) return true;
    if (watchers.size >= watcherLimits.maxWatchers) return false;
    let watcher;
    try {
      watcher = fs.watch(directory, { recursive: Boolean(recursive) }, (eventType, filename) => {
        const changedPath = filename ? path.resolve(directory, String(filename)) : null;
        if (changedPath && isIgnoredPath(root, changedPath)) return;
        if (changedPath) {
          const writeEvent = workspaceWrites.classify(changedPath, identity);
          if (writeEvent) return;
        }
        onWorkspaceFilesystemEvent(root, identity, changedPath);
        if (changedPath) {
          const changedStat = safeStat(changedPath);
          const cachedNode = findTreeNode(changedPath);
          // Atomic-save editors commonly report an existing file replacement
          // as "rename". If the path is still the same cached file, this is a
          // content change rather than a structural tree mutation.
          if ((eventType === 'change' || eventType === 'rename') && changedStat && changedStat.isFile() && cachedNode && cachedNode.type === 'file') {
            sendIncrementalFileChange(root, identity, changedPath);
            return;
          }
        }
        if (!recursive && changedPath) {
          const changedStat = safeStat(changedPath);
          if (changedStat && changedStat.isDirectory()) void attachWatcherTree(changedPath, root, identity);
        }
        scheduleTreeRefresh(root, identity);
      });
    } catch (_) {
      return false;
    }
    watchers.set(directory, watcher);
    watcher.on('error', () => {
      if (watchers.get(directory) === watcher) watchers.delete(directory);
      try { watcher.close(); } catch (_) {}
    });
    watcher.on('close', () => {
      if (watchers.get(directory) === watcher) watchers.delete(directory);
    });
    return true;
  }

  async function attachWatcherTree(directory, root, identity, budget) {
    const state = budget || { scanned: 0, truncated: false };
    const relative = path.relative(root, directory);
    const depth = relative ? relative.split(path.sep).filter(Boolean).length : 0;
    if (root !== workspaceRoot || identity !== workspaceIdentity || isIgnoredPath(root, directory) ||
        depth > watcherLimits.maxDepth || watchers.size >= watcherLimits.maxWatchers) {
      state.truncated = true;
      return;
    }
    if (!attachWatcher(directory, root, false, identity)) {
      state.truncated = true;
      return;
    }
    const remaining = watcherLimits.maxScannedEntries - state.scanned;
    if (remaining <= 0) {
      state.truncated = true;
      return;
    }
    let batch;
    try {
      batch = await readDirectoryEntriesBounded(
        directory,
        Math.min(watcherLimits.maxEntriesPerDirectory, remaining)
      );
    } catch (_) {
      return;
    }
    state.scanned += Math.min(batch.scanned, remaining);
    state.truncated = state.truncated || batch.truncated || batch.scanned > remaining;
    for (const entry of batch.entries) {
      if (watchers.size >= watcherLimits.maxWatchers) {
        state.truncated = true;
        break;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !isIgnoredDirectory(entry.name)) {
        await attachWatcherTree(path.join(directory, entry.name), root, identity, state);
      }
    }
  }

  function watchFolderRecursive(root, identity) {
    if (attachWatcher(root, root, true, identity)) {
      watcherMode = 'recursive';
      return;
    }
    watcherMode = 'fallback';
    void attachWatcherTree(root, root, identity);
  }

  function readTeamMapping(folder) {
    return readTeamMappingFile(folder, {
      onInvalid: (error) => console.warn('Invalid team mapping marker:', error.message)
    });
  }

  async function transitionWorkspace(folderPath) {
    const folder = safeWorkspaceRoot(folderPath);
    const stat = safeStat(folder);
    if (!stat || !stat.isDirectory()) throw new Error('Workspace folder does not exist');
    const currentOpenSequence = ++openSequence;
    let tree = await scanTreeDirectory(folder);
    if (currentOpenSequence !== openSequence || !tree) return null;
    let leaveToken = null;
    if (workspaceRoot) {
      const decision = await requestRendererLeave('switch', folder);
      if (!decision.allowed || currentOpenSequence !== openSequence) {
        abortLeave(decision.leaveToken);
        return null;
      }
      leaveToken = decision.leaveToken;
    }
    return workspaceWriteQueue.transition('workspace-switch', async () => {
      let transitionStarted = false;
      let transitionOutcome = 'workspace-switch-aborted';
      const sourceRoot = workspaceRoot;
      const sourceTree = treeCache;
      try {
        if (currentOpenSequence !== openSequence) {
          abortLeave(leaveToken);
          return null;
        }
        if (workspaceRoot) {
          try {
            await Promise.resolve(beforeWorkspaceChange('workspace-switch'));
            transitionStarted = true;
          } catch (error) {
            abortLeave(leaveToken);
            throw error;
          }
          try {
            // The renderer has approved the transition. Terminals are scoped to
            // the old remote snapshot and must not survive into the new one.
            await Promise.resolve(stopTerminal('workspace-switch'));
            tree = await scanTreeDirectory(folder);
          } catch (error) {
            abortLeave(leaveToken);
            throw error;
          }
          if (currentOpenSequence !== openSequence || !tree) {
            abortLeave(leaveToken);
            return null;
          }
        }
        clearWatchers();
        workspaceRoot = folder;
        workspaceIdentity += 1;
        activeArtifactRunContext = null;
        const targetIdentity = workspaceIdentity;
        onWorkspaceChanged({ rootPath: folder, workspaceIdentity: targetIdentity });
        watchFolderRecursive(folder, targetIdentity);
        setTreeCache(tree);
        if (leaveToken) committedSwitches.set(leaveToken, { sourceRoot, sourceTree, targetRoot: folder, targetIdentity });
        scheduleTreeRefresh(folder, targetIdentity);
        transitionOutcome = 'workspace-switch-complete';
        if (settings && typeof settings.rememberRecentWorkspace === 'function') {
          try { settings.rememberRecentWorkspace(folder); } catch (_) {}
        }
        return { rootPath: folder, tree, workspaceIdentity, leaveToken, teamMapping: readTeamMapping(folder) };
      } finally {
        if (transitionStarted) await Promise.resolve(afterWorkspaceChange(transitionOutcome));
      }
    });
  }

  async function closeWorkspaceState(reason, options = {}) {
    return workspaceWriteQueue.transition(reason, async () => {
      await Promise.resolve(beforeWorkspaceChange(reason));
      try {
        await Promise.resolve(disposeLsp(reason));
        openSequence += 1;
        committedSwitches.clear();
        clearWatchers();
        workspaceRoot = null;
        workspaceIdentity += 1;
        activeArtifactRunContext = null;
        onWorkspaceChanged({ rootPath: null, workspaceIdentity });
        invalidateTreeCache();
        if (options.notifyRenderer === true) send('workspace-closed', {});
      } catch (error) {
        await Promise.resolve(afterWorkspaceChange(reason + '-aborted'));
        throw error;
      }
      if (options.deferCompletion === true) {
        let completed = false;
        return Object.freeze({
          complete: async (outcome) => {
            if (completed) return false;
            completed = true;
            await Promise.resolve(afterWorkspaceChange(outcome || reason + '-complete'));
            return true;
          }
        });
      }
      await Promise.resolve(afterWorkspaceChange(reason + '-complete'));
      return true;
    });
  }

  async function pickAndOpenWorkspace() {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const opened = await transitionWorkspace(result.filePaths[0]);
    if (opened) send('workspace-opened', opened);
    return opened && opened.tree;
  }

  async function calculateDirectorySize(directory, scanOptions = {}) {
    if (!directory) return { size: 0 };
    const rootDirectory = resolveWorkspacePath(directory, { allowRoot: true });
    let total = 0;
    let entries = 0;
    const signal = scanOptions.signal;
    const deadline = Date.now() + syncMeasurementLimits.timeoutMs;
    function assertBudget(currentPath, depth) {
      if (signal && signal.aborted) {
        const error = new Error('Workspace measurement was cancelled');
        error.code = 'WORKSPACE_SCAN_CANCELLED';
        throw error;
      }
      if (Date.now() > deadline) {
        const error = new Error('Workspace measurement timed out');
        error.code = 'WORKSPACE_SCAN_TIMEOUT';
        throw error;
      }
      if (depth > syncMeasurementLimits.maxDepth || currentPath.length > syncMeasurementLimits.maxPathChars ||
          entries > syncMeasurementLimits.maxEntries || total > syncMeasurementLimits.maxTotalBytes) {
        const error = new Error('Workspace exceeds the synchronization measurement limits');
        error.code = 'WORKSPACE_SCAN_LIMIT';
        throw error;
      }
    }
    async function walk(current, depth) {
      assertBudget(current, depth);
      let handle;
      try { handle = await fs.promises.opendir(current); }
      catch (cause) {
        const error = new Error('Workspace could not be measured completely');
        error.code = 'WORKSPACE_SCAN_FAILED';
        error.cause = cause;
        throw error;
      }
      for await (const entry of handle) {
        entries += 1;
        const fullPath = path.join(current, entry.name);
        assertBudget(fullPath, depth);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!RCLONE_IGNORED_DIRECTORIES.includes(entry.name.toLowerCase())) await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          let stat;
          try { stat = await fs.promises.lstat(fullPath); }
          catch (cause) {
            const error = new Error('Workspace changed while it was being measured');
            error.code = 'WORKSPACE_SCAN_FAILED';
            error.cause = cause;
            throw error;
          }
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          total += stat.size;
          assertBudget(fullPath, depth);
        }
      }
    }
    await walk(rootDirectory, 0);
    return { size: total, entries };
  }

  function registerIpc() {
    ipcMain.on('workspace-leave-response', (_event, response) => {
      const pending = response && pendingLeaveRequests.get(response.requestId);
      if (pending) pending.complete(response.allowed === true);
    });
    ipcMain.handle('workspace-leave-choice', async (_event, details) => {
      const dirtyCount = Math.max(1, Number(details && details.dirtyCount) || 1);
      const result = await dialog.showMessageBox(getWindow(), {
        type: 'warning',
        title: t('Unsaved Changes'),
        message: dirtyCount === 1 ? t('One file has unsaved changes.') : t('{count} files have unsaved changes.', { count: dirtyCount }),
        detail: t('Save changes before leaving this workspace?'),
        buttons: [t('Save All'), t('Discard'), t('Cancel')],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      return ['save', 'discard', 'cancel'][result.response] || 'cancel';
    });
    ipcMain.handle('workspace-identity', async () => ({ rootPath: workspaceRoot, workspaceIdentity }));
    ipcMain.handle('workspace-switch-applied', async (_event, details) => {
      if (details && details.leaveToken) committedSwitches.delete(details.leaveToken);
      return true;
    });
    ipcMain.handle('workspace-switch-reject', async (_event, details) => {
      const leaveToken = details && details.leaveToken;
      return workspaceWriteQueue.transition('workspace-switch-reject', async () => {
        const committed = leaveToken && committedSwitches.get(leaveToken);
        if (!committed) return { rolledBack: false, rootPath: workspaceRoot, workspaceIdentity };
        if (workspaceRoot !== committed.targetRoot || workspaceIdentity !== committed.targetIdentity) {
          committedSwitches.delete(leaveToken);
          return { rolledBack: false, rootPath: workspaceRoot, workspaceIdentity };
        }
        await Promise.resolve(beforeWorkspaceChange('workspace-switch-reject'));
        committedSwitches.delete(leaveToken);
        let transitionComplete = false;
        try {
          openSequence += 1;
          committedSwitches.clear();
          clearWatchers();
          workspaceRoot = committed.sourceRoot;
          workspaceIdentity += 1;
          activeArtifactRunContext = null;
          onWorkspaceChanged({ rootPath: workspaceRoot, workspaceIdentity });
          const restoredTree = committed.sourceTree || (workspaceRoot ? await scanTreeDirectory(workspaceRoot) : null);
          if (workspaceRoot) {
            setTreeCache(restoredTree);
            watchFolderRecursive(workspaceRoot, workspaceIdentity);
            scheduleTreeRefresh(workspaceRoot, workspaceIdentity);
          } else {
            invalidateTreeCache();
          }
          transitionComplete = true;
          return { rolledBack: true, rootPath: workspaceRoot, workspaceIdentity, tree: restoredTree };
        } finally {
          await Promise.resolve(afterWorkspaceChange(transitionComplete ? 'workspace-switch-reject-complete' : 'workspace-switch-reject-aborted'));
        }
      });
    });
    ipcMain.handle('artifact-run-context', async (_event, context) => {
      return runWorkspaceEpochMutation('artifact-run-context', async ({ assertCurrent }) => {
        if (!context || context.clear === true) {
          assertCurrent();
          if (!context || activeArtifactRunContext && context.runNonce === activeArtifactRunContext.runNonce) {
            activeArtifactRunContext = null;
          }
          return true;
        }
        if (typeof context.workspaceRoot !== 'string' || path.resolve(context.workspaceRoot) !== path.resolve(workspaceRoot || '') ||
            context.workspaceIdentity !== workspaceIdentity || !Number.isInteger(context.runNonce) || context.runNonce < 1) {
          throw new Error('Stale run workspace');
        }
        assertCurrent();
        activeArtifactRunContext = {
          workspaceRoot: path.resolve(context.workspaceRoot),
          workspaceIdentity: context.workspaceIdentity,
          runNonce: context.runNonce
        };
        return true;
      });
    });
    ipcMain.handle('pick-workspace', async (_event, directoryPath) => {
      let folder = directoryPath;
      if (folder === undefined) {
        const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return null;
        folder = result.filePaths[0];
      } else if (!allowDirectWorkspacePaths) {
        const candidate = safeWorkspaceRoot(folder);
        const canonical = fs.realpathSync(candidate);
        const current = workspaceRoot ? fs.realpathSync(workspaceRoot) : '';
        const recent = settings && typeof settings.readRecentWorkspaces === 'function'
          ? settings.readRecentWorkspaces()
          : [];
        const allowed = canonical === current || recent.some((value) => {
          try { return fs.realpathSync(value) === canonical; } catch (_) { return false; }
        });
        if (!allowed) throw new Error('Choose this workspace with the native directory picker first');
        folder = canonical;
      }
      return transitionWorkspace(folder);
    });
    ipcMain.handle('forget-recent-workspace', async (_event, directoryPath) => {
      return settings && typeof settings.forgetRecentWorkspace === 'function'
        ? settings.forgetRecentWorkspace(directoryPath)
        : false;
    });
    ipcMain.handle('write-team-mapping', async (event, payload) => {
      if (!payload || typeof payload.localPath !== 'string' || !payload.mapping) throw new Error('Invalid mapping metadata');
      return runWorkspaceEpochMutation(payload.localPath, async ({ assertCurrent }) => {
        const directory = localDirectoryAuthority
          ? localDirectoryAuthority.resolve(event.sender.id, payload.localGrant, payload.localPath)
          : safeWorkspaceRoot(payload.localPath);
        const stat = safeStat(directory);
        if (!stat || !stat.isDirectory()) throw new Error('Mapping directory does not exist');
        const mapping = payload.mapping;
        const allowed = {
          version: 1,
          teamId: String(mapping.teamId || ''),
          teamName: String(mapping.teamName || ''),
          projectId: String(mapping.projectId || ''),
          projectName: String(mapping.projectName || ''),
          branch: String(mapping.branch || ''),
          localPath: directory
        };
        if (!allowed.teamId || !allowed.projectId || !allowed.branch) throw new Error('Incomplete mapping metadata');
        assertCurrent();
        await writeFileAtomic(
          path.join(directory, '.bobocloud-team.json'),
          Buffer.from(JSON.stringify(allowed, null, 2) + '\n', 'utf8'),
          { maxBytes: MAX_TEAM_MAPPING_BYTES, beforeReplace: assertCurrent }
        );
        assertCurrent();
        if (settings && typeof settings.rememberRecentWorkspace === 'function') settings.rememberRecentWorkspace(directory);
        return true;
      });
    });
    ipcMain.handle('close-workspace', async () => {
      return closeWorkspaceState('workspace-close', { notifyRenderer: true });
    });
    ipcMain.handle('read-file', async (_event, filePath) => {
      const context = captureWorkspaceMutation(true);
      return readWorkspaceText(context, filePath);
    });
    ipcMain.handle('read-files', async (_event, filePaths) => {
      const result = {};
      if (!Array.isArray(filePaths)) return result;
      if (filePaths.length > MAX_WORKSPACE_BATCH_FILES) {
        const error = new Error('Too many workspace files were requested');
        error.code = 'WORKSPACE_READ_LIMIT';
        throw error;
      }
      const context = captureWorkspaceMutation(true);
      const seen = new Set();
      let remainingBytes = MAX_WORKSPACE_BATCH_BYTES;
      for (const filePath of filePaths) {
        if (typeof filePath !== 'string' || seen.has(filePath)) continue;
        seen.add(filePath);
        try {
          if (remainingBytes <= 0) {
            const error = new Error('Workspace file batch exceeds its read limit');
            error.code = 'WORKSPACE_READ_LIMIT';
            throw error;
          }
          const content = await readWorkspaceText(
            context,
            filePath,
            Math.min(MAX_WORKSPACE_TEXT_FILE_BYTES, remainingBytes)
          );
          const size = Buffer.byteLength(content, 'utf8');
          remainingBytes -= size;
          result[filePath] = content;
        } catch (error) {
          if (error && error.code === 'ENOENT') result[filePath] = null;
          else throw error;
        }
      }
      return result;
    });
    ipcMain.handle('save-file', async (_event, payload) => {
      if (!payload || typeof payload.content !== 'string' ||
          Buffer.byteLength(payload.content, 'utf8') > MAX_WORKSPACE_TEXT_FILE_BYTES) {
        const error = new Error('Workspace text file exceeds the editor write limit');
        error.code = 'DATA_TOO_LARGE';
        throw error;
      }
      return runWorkspaceMutation(payload.filePath, async (mutation) => {
        const targetPath = mutation.resolvePath(payload.filePath);
        const writeRoot = mutation.rootPath;
        const writeIdentity = mutation.workspaceIdentity;
        const existed = Boolean(safeStat(targetPath)?.isFile());
        let trackedWrite = null;
        let conflictNotified = false;
        try {
          try {
            trackedWrite = workspaceWrites.begin(targetPath, writeIdentity, payload.mutationId, payload.content, 'utf8');
          } catch (error) {
            if (error && (error.code === 'WORKSPACE_WRITE_LIMIT' || error.code === 'WORKSPACE_WRITE_IN_PROGRESS')) {
              throw new Error(t('Too many file saves are in progress. Wait for them to finish and try again.'));
            }
            throw error;
          }
          mutation.assertCurrent();
          await fs.promises.writeFile(targetPath, payload.content, 'utf-8');
          mutation.assertCurrent();
          const committed = await workspaceWrites.complete(trackedWrite);
          mutation.assertCurrent();
          if (!committed) {
            sendCurrentFileState(writeRoot, writeIdentity, targetPath);
            conflictNotified = true;
            throw new Error(t('The file changed on disk while it was being saved. Review the latest contents and save again.'));
          }
          mutation.assertCurrent();
          try { onWorkspaceFilesystemEvent(writeRoot, writeIdentity, targetPath); } catch (_) {}
          if (existed) {
            sendIncrementalFileChange(writeRoot, writeIdentity, targetPath, trackedWrite.id);
          } else {
            mutation.assertCurrent();
            refreshTreeCacheSilently(writeRoot, writeIdentity);
            send('file-event', {
              event: 'file-created',
              parentPath: path.dirname(targetPath),
              path: targetPath,
              name: path.basename(targetPath),
              nodeType: 'file',
              rootPath: writeRoot,
              workspaceIdentity: writeIdentity,
              mutationId: trackedWrite.id
            });
          }
          return true;
        } catch (error) {
          if (!conflictNotified && workspaceWrites.fail(trackedWrite)) {
            try {
              mutation.assertCurrent();
              sendCurrentFileState(writeRoot, writeIdentity, targetPath);
            } catch (_) {}
          }
          throw error;
        }
      });
    });
    ipcMain.handle('save-binary-file', async (_event, payload) => {
      const encoded = typeof payload.content === 'string' ? payload.content : '';
      if (Buffer.byteLength(encoded, 'ascii') > Math.ceil(maxArtifactBytes / 3) * 4 + 4) throw new Error('Binary file exceeds the workspace write limit');
      const data = Buffer.from(encoded, 'base64');
      if (data.length > maxArtifactBytes) throw new Error('Binary file exceeds the workspace write limit');
      return runWorkspaceMutation(payload.filePath, async (mutation) => {
        const target = mutation.resolvePath(payload.filePath);
        const existed = Boolean(safeStat(target)?.isFile());
        mutation.assertCurrent();
        await writeFileAtomic(target, data, { maxBytes: maxArtifactBytes, beforeReplace: mutation.assertCurrent });
        mutation.assertCurrent();
        invalidateTreeCache();
        send('file-event', {
          event: existed ? 'file-changed' : 'file-created',
          path: target, name: path.basename(target),
          parentPath: path.dirname(target), nodeType: 'file',
          rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity
        });
        return true;
      });
    });
    ipcMain.handle('save-artifact', async (_event, payload) => {
      if (!workspaceRoot) throw new Error('No workspace is open');
      const requestedRoot = payload.workspaceRoot;
      const requestedIdentity = payload.workspaceIdentity;
      if (typeof requestedRoot !== 'string' || path.resolve(requestedRoot) !== path.resolve(workspaceRoot) || requestedIdentity !== workspaceIdentity) {
        throw new Error('Stale artifact workspace');
      }
      if (!activeArtifactRunContext || payload.runNonce !== activeArtifactRunContext.runNonce ||
          requestedIdentity !== activeArtifactRunContext.workspaceIdentity ||
          path.resolve(requestedRoot) !== activeArtifactRunContext.workspaceRoot) {
        throw new Error('Stale artifact run');
      }
      if (typeof payload.relativePath !== 'string' || !payload.relativePath.trim() || path.isAbsolute(payload.relativePath)) {
        throw new Error('Invalid artifact path');
      }
      const encoded = payload.binary ? String(payload.content || '') : '';
      if (payload.binary && Buffer.byteLength(encoded, 'ascii') > Math.ceil(maxArtifactBytes / 3) * 4 + 4) throw new Error('Artifact exceeds the workspace write limit');
      const data = payload.binary ? Buffer.from(encoded, 'base64') : Buffer.from(String(payload.content || ''), 'utf8');
      if (data.length > maxArtifactBytes) throw new Error('Artifact exceeds the workspace write limit');
      const operationRunContext = activeArtifactRunContext;
      return runWorkspaceMutation(payload.relativePath, async (mutation) => {
        const assertCurrent = () => {
          mutation.assertCurrent('Stale artifact run');
          if (operationRunContext !== activeArtifactRunContext || payload.runNonce !== operationRunContext.runNonce) {
            throw new Error('Stale artifact run');
          }
        };
        assertCurrent();
        const rootReal = fs.realpathSync(mutation.rootPath);
        const lexicalTarget = path.resolve(mutation.rootPath, payload.relativePath);
        const lexicalRelative = path.relative(mutation.rootPath, lexicalTarget);
        if (!lexicalRelative || lexicalRelative.startsWith('..' + path.sep) || lexicalRelative === '..' || path.isAbsolute(lexicalRelative)) {
          throw new Error('Artifact path escapes the workspace');
        }
        ensureWorkspaceDirectories(mutation.rootPath, path.dirname(lexicalTarget));
        assertCurrent();
        const parentReal = fs.realpathSync(path.dirname(lexicalTarget));
        const parentRelative = path.relative(rootReal, parentReal);
        if (parentRelative.startsWith('..' + path.sep) || parentRelative === '..' || path.isAbsolute(parentRelative)) {
          throw new Error('Artifact parent resolves outside the workspace');
        }
        const target = path.join(parentReal, path.basename(lexicalTarget));
        let existing = null;
        try { existing = fs.lstatSync(target); } catch (_) {}
        if (existing && existing.isSymbolicLink()) throw new Error('Refusing to overwrite an artifact symlink');
        await writeFileAtomic(target, data, { maxBytes: maxArtifactBytes, beforeReplace: assertCurrent });
        assertCurrent();
        invalidateTreeCache();
        send('file-event', {
          event: existing ? 'file-changed' : 'file-created', path: target, name: path.basename(target),
          parentPath: path.dirname(target), nodeType: 'file',
          rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity
        });
        return { success: true, path: target };
      });
    });
    ipcMain.handle('read-tree', async (_event, directoryPath) => {
      if (!directoryPath) return null;
      return readTree(resolveWorkspacePath(directoryPath, { allowRoot: true }));
    });
    ipcMain.handle('refresh-workspace', async () => {
      if (!workspaceRoot) return null;
      const rootPath = workspaceRoot;
      const refreshSequence = ++treeRefreshSequence;
      invalidateTreeCache();
      const tree = await readTree(rootPath);
      if (workspaceRoot !== rootPath || refreshSequence !== treeRefreshSequence) return null;
      setTreeCache(tree);
      send('workspace-refresh', { rootPath, workspaceIdentity, tree });
      return tree;
    });
    ipcMain.handle('create-file', async (_event, payload) => {
      const name = validateEntryName(payload.name);
      return runWorkspaceMutation(payload.parentDir, async (mutation) => {
        const parentDirectory = mutation.resolvePath(payload.parentDir, { allowRoot: true });
        const fullPath = mutation.resolvePath(path.join(parentDirectory, name));
        mutation.assertCurrent();
        await fs.promises.writeFile(fullPath, '', { encoding: 'utf-8', flag: 'wx' });
        mutation.assertCurrent();
        invalidateTreeCache();
        send('file-event', {
          event: 'file-created', parentPath: parentDirectory, path: fullPath, name, nodeType: 'file',
          rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity
        });
        return { path: fullPath };
      });
    });
    ipcMain.handle('create-folder', async (_event, payload) => {
      const name = validateEntryName(payload.name);
      return runWorkspaceMutation(payload.parentDir, async (mutation) => {
        const parentDirectory = mutation.resolvePath(payload.parentDir, { allowRoot: true });
        const fullPath = mutation.resolvePath(path.join(parentDirectory, name));
        mutation.assertCurrent();
        await fs.promises.mkdir(fullPath);
        mutation.assertCurrent();
        invalidateTreeCache();
        send('file-event', {
          event: 'file-created', parentPath: parentDirectory, path: fullPath, name, nodeType: 'folder',
          rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity
        });
        return { path: fullPath };
      });
    });
    ipcMain.handle('rename-entry', async (_event, payload) => {
      const newName = validateEntryName(payload.newName);
      return runWorkspaceMutation(payload.oldPath, async (mutation) => {
        const oldPath = mutation.resolvePath(payload.oldPath);
        const directory = path.dirname(oldPath);
        const newPath = mutation.resolvePath(path.join(directory, newName));
        const samePath = process.platform === 'win32' ? oldPath.toLowerCase() === newPath.toLowerCase() : oldPath === newPath;
        if (!samePath && fs.existsSync(newPath)) throw new Error('An entry with that name already exists');
        mutation.assertCurrent(t('The entry is no longer visible.'));
        await fs.promises.rename(oldPath, newPath);
        mutation.assertCurrent(t('The entry is no longer visible.'));
        invalidateTreeCache();
        send('file-event', {
          event: 'file-deleted', path: oldPath,
          rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity
        });
        mutation.assertCurrent(t('The entry is no longer visible.'));
        send('file-event', {
          event: 'file-created', parentPath: directory, path: newPath, name: newName,
          nodeType: safeStat(newPath)?.isDirectory() ? 'folder' : 'file',
          rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity
        });
        return { path: newPath };
      });
    });
    ipcMain.handle('delete-entry', async (_event, payload) => {
      return runWorkspaceMutation(payload.entryPath, async (mutation) => {
        const entryPath = mutation.resolvePath(payload.entryPath);
        const stat = safeStat(entryPath);
        if (!stat) return false;
        mutation.assertCurrent(t('The entry is no longer visible.'));
        if (stat.isDirectory()) await fs.promises.rm(entryPath, { recursive: true, force: true });
        else await fs.promises.unlink(entryPath);
        mutation.assertCurrent(t('The entry is no longer visible.'));
        invalidateTreeCache();
        send('file-event', {
          event: 'file-deleted', path: entryPath,
          rootPath: mutation.rootPath, workspaceIdentity: mutation.workspaceIdentity
        });
        return true;
      });
    });
    ipcMain.handle('read-project-names', async () => settings.readProjectNames());
    ipcMain.handle('save-project-name', async (_event, payload) => settings.saveProjectName(payload.key, payload.name));
  }

  function handleWindowClosed() {
    settleLeaveRequests(false);
    pendingLeaveRequests.clear();
    committedSwitches.clear();
  }

  return {
    registerIpc,
    pickAndOpenWorkspace,
    requestRendererLeave,
    abortRendererLeave: abortLeave,
    prepareWindowClose: () => closeWorkspaceState('window-close', { deferCompletion: true }),
    handleRendererGone: () => settleLeaveRequests(true),
    handleWindowClosed,
    clearWatchers,
    calculateDirectorySize,
    runMutation: runWorkspaceMutation,
    resolveWorkspaceFile,
    notifyExternalFileChanges(files, context) {
      if (!workspaceRoot || !Array.isArray(files) || files.length === 0 || !context) return false;
      const rootPath = path.resolve(String(context.rootPath || ''));
      const identity = context.workspaceIdentity;
      if (rootPath !== path.resolve(workspaceRoot) || identity !== workspaceIdentity) return false;
      invalidateTreeCache();
      for (const item of files) {
        const target = item && typeof item.path === 'string' ? path.resolve(item.path) : '';
        if (!target || pathIsOutside(path.resolve(rootPath), target)) continue;
        send('file-event', {
          event: item.event === 'file-created' || item.event === 'file-deleted' ? item.event : 'file-changed',
          path: target,
          parentPath: path.dirname(target),
          name: path.basename(target),
          nodeType: 'file',
          rootPath,
          workspaceIdentity: identity
        });
      }
      scheduleTreeRefresh(rootPath, identity);
      return true;
    },
    getIdentity: () => ({ rootPath: workspaceRoot, workspaceIdentity })
  };
}

module.exports = {
  MAX_WORKSPACE_BATCH_BYTES,
  MAX_WORKSPACE_BATCH_FILES,
  MAX_WORKSPACE_TEXT_FILE_BYTES,
  createWorkspaceController,
  readDirectoryEntriesBounded
};
