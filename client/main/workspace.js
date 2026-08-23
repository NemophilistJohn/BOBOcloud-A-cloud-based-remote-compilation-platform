const fs = require('fs');
const path = require('path');

const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.bobocloud'
]);
const MAX_CONCURRENT_TREE_READS = 16;

function createWorkspaceController(options) {
  const ipcMain = options.ipcMain;
  const dialog = options.dialog;
  const getWindow = options.getWindow;
  const t = options.t;
  const disposeLsp = options.disposeLsp || (() => {});
  const stopTerminal = options.stopTerminal || (() => {});
  const onWorkspaceChanged = options.onWorkspaceChanged || (() => {});
  const onWorkspaceFilesystemEvent = options.onWorkspaceFilesystemEvent || (() => {});
  const settings = options.settings;

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
      const complete = (allowed) => {
        pendingLeaveRequests.delete(requestId);
        resolve({ allowed: allowed === true, leaveToken: allowed === true ? leaveToken : null });
      };
      pendingLeaveRequests.set(requestId, { reason: reason || 'switch', complete });
      window.webContents.send('workspace-leave-request', {
        requestId,
        leaveToken,
        reason: reason || 'switch',
        targetRoot: targetRoot || null
      });
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
  }

  function pathIsOutside(root, target) {
    const relative = path.relative(root, target);
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  }

  function resolveWorkspacePath(candidate, options = {}) {
    if (!workspaceRoot) throw new Error('No workspace is open');
    if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('Invalid workspace path');
    const root = path.resolve(workspaceRoot);
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

  function ensureWorkspaceDirectories(targetDirectory) {
    const root = path.resolve(workspaceRoot);
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

  async function scanTreeDirectory(directoryPath) {
    let entries;
    try {
      entries = await withTreeReadSlot(() => fs.promises.readdir(directoryPath, { withFileTypes: true }));
    } catch (_) {
      return null;
    }
    entries.sort(compareTreeEntries);
    const children = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDirectory(entry.name)) return { name: entry.name, path: fullPath, type: 'folder', children: [] };
        return scanTreeDirectory(fullPath);
      }
      if (entry.isFile()) return { name: entry.name, path: fullPath, type: 'file' };
      return null;
    }));
    return {
      name: path.basename(directoryPath),
      path: directoryPath,
      type: 'folder',
      children: children.filter(Boolean)
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

  function sendIncrementalFileChange(rootPath, identity, changedPath) {
    if (rootPath !== workspaceRoot || identity !== workspaceIdentity) return;
    send('file-event', {
      event: 'file-changed',
      path: changedPath,
      name: path.basename(changedPath),
      rootPath,
      workspaceIdentity: identity
    });
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
    let watcher;
    try {
      watcher = fs.watch(directory, { recursive: Boolean(recursive) }, (eventType, filename) => {
        const changedPath = filename ? path.resolve(directory, String(filename)) : null;
        onWorkspaceFilesystemEvent(root, identity, changedPath);
        if (changedPath && isIgnoredPath(root, changedPath)) return;
        if (eventType === 'change' && changedPath) {
          const changedStat = safeStat(changedPath);
          const cachedNode = findTreeNode(changedPath);
          if (changedStat && changedStat.isFile() && cachedNode && cachedNode.type === 'file') {
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

  async function attachWatcherTree(directory, root, identity) {
    if (root !== workspaceRoot || identity !== workspaceIdentity || isIgnoredPath(root, directory)) return;
    attachWatcher(directory, root, false, identity);
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (_) { return; }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !isIgnoredDirectory(entry.name))
      .map((entry) => attachWatcherTree(path.join(directory, entry.name), root, identity)));
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
    try {
      const marker = path.join(folder, '.bobocloud-team.json');
      if (!fs.existsSync(marker)) return null;
      const data = JSON.parse(fs.readFileSync(marker, 'utf-8'));
      if (!data || !data.teamId || !data.projectId || !data.branch) return null;
      return data;
    } catch (error) {
      console.warn('Invalid team mapping marker:', error.message);
      return null;
    }
  }

  async function transitionWorkspace(folderPath) {
    const folder = path.resolve(folderPath);
    const stat = safeStat(folder);
    if (!stat || !stat.isDirectory()) throw new Error('Workspace folder does not exist');
    const currentOpenSequence = ++openSequence;
    let tree = await scanTreeDirectory(folder);
    if (currentOpenSequence !== openSequence || !tree) return null;
    let leaveToken = null;
    const sourceRoot = workspaceRoot;
    const sourceTree = treeCache;
    if (workspaceRoot) {
      const decision = await requestRendererLeave('switch', folder);
      if (!decision.allowed || currentOpenSequence !== openSequence) {
        abortLeave(decision.leaveToken);
        return null;
      }
      leaveToken = decision.leaveToken;
      // The renderer has approved the transition. Terminals are scoped to the
      // old remote workspace snapshot and must never survive into the new one.
      await Promise.resolve(stopTerminal('workspace-switch'));
      tree = await scanTreeDirectory(folder);
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
    return { rootPath: folder, tree, workspaceIdentity, leaveToken, teamMapping: readTeamMapping(folder) };
  }

  async function pickAndOpenWorkspace() {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const opened = await transitionWorkspace(result.filePaths[0]);
    if (opened) send('workspace-opened', opened);
    return opened && opened.tree;
  }

  async function calculateDirectorySize(directory) {
    if (!directory) return { size: 0 };
    const rootDirectory = resolveWorkspacePath(directory, { allowRoot: true });
    let total = 0;
    const ignored = new Set(['.git', '.bobocloud', 'target', 'node_modules', '__pycache__']);
    async function walk(current) {
      let handle;
      try { handle = await fs.promises.opendir(current); } catch (_) { return; }
      for await (const entry of handle) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name)) await walk(fullPath);
        } else if (entry.isFile()) {
          try { total += (await fs.promises.stat(fullPath)).size; } catch (_) {}
        }
      }
    }
    await walk(rootDirectory);
    return { size: total };
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
      const committed = leaveToken && committedSwitches.get(leaveToken);
      if (!committed) return { rolledBack: false, rootPath: workspaceRoot, workspaceIdentity };
      committedSwitches.delete(leaveToken);
      if (workspaceRoot !== committed.targetRoot || workspaceIdentity !== committed.targetIdentity) {
        return { rolledBack: false, rootPath: workspaceRoot, workspaceIdentity };
      }
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
      return { rolledBack: true, rootPath: workspaceRoot, workspaceIdentity, tree: restoredTree };
    });
    ipcMain.handle('artifact-run-context', async (_event, context) => {
      if (!context || context.clear === true) {
        if (!context || activeArtifactRunContext && context.runNonce === activeArtifactRunContext.runNonce) {
          activeArtifactRunContext = null;
        }
        return true;
      }
      if (typeof context.workspaceRoot !== 'string' || path.resolve(context.workspaceRoot) !== path.resolve(workspaceRoot || '') ||
          context.workspaceIdentity !== workspaceIdentity || !Number.isInteger(context.runNonce) || context.runNonce < 1) {
        throw new Error('Stale run workspace');
      }
      activeArtifactRunContext = {
        workspaceRoot: path.resolve(context.workspaceRoot),
        workspaceIdentity: context.workspaceIdentity,
        runNonce: context.runNonce
      };
      return true;
    });
    ipcMain.handle('pick-workspace', async (_event, directoryPath) => {
      let folder = directoryPath;
      if (folder === undefined) {
        const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return null;
        folder = result.filePaths[0];
      }
      return transitionWorkspace(folder);
    });
    ipcMain.handle('write-team-mapping', async (_event, payload) => {
      if (!payload || typeof payload.localPath !== 'string' || !payload.mapping) throw new Error('Invalid mapping metadata');
      const directory = path.resolve(payload.localPath);
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
        remotePath: String(mapping.remotePath || ''),
        localPath: directory
      };
      if (!allowed.teamId || !allowed.projectId || !allowed.branch) throw new Error('Incomplete mapping metadata');
      await fs.promises.writeFile(path.join(directory, '.bobocloud-team.json'), JSON.stringify(allowed, null, 2), 'utf-8');
      return true;
    });
    ipcMain.handle('close-workspace', async () => {
      disposeLsp();
      openSequence += 1;
      committedSwitches.clear();
      clearWatchers();
      workspaceRoot = null;
      workspaceIdentity += 1;
      activeArtifactRunContext = null;
      onWorkspaceChanged({ rootPath: null, workspaceIdentity });
      invalidateTreeCache();
      send('workspace-closed', {});
      return true;
    });
    ipcMain.handle('read-file', async (_event, filePath) => {
      return fs.promises.readFile(resolveWorkspacePath(filePath), 'utf-8');
    });
    ipcMain.handle('read-files', async (_event, filePaths) => {
      const result = {};
      if (!Array.isArray(filePaths)) return result;
      for (const filePath of filePaths) {
        try {
          const resolved = resolveWorkspacePath(filePath);
          const stat = await fs.promises.stat(resolved);
          result[filePath] = stat.isFile() ? await fs.promises.readFile(resolved, 'utf-8') : null;
        } catch (_) {
          result[filePath] = null;
        }
      }
      return result;
    });
    ipcMain.handle('save-file', async (_event, payload) => {
      await fs.promises.writeFile(resolveWorkspacePath(payload.filePath), payload.content, 'utf-8');
      return true;
    });
    ipcMain.handle('save-binary-file', async (_event, payload) => {
      await fs.promises.writeFile(resolveWorkspacePath(payload.filePath), Buffer.from(payload.content, 'base64'));
      return true;
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
      const rootReal = fs.realpathSync(workspaceRoot);
      const lexicalTarget = path.resolve(workspaceRoot, payload.relativePath);
      const lexicalRelative = path.relative(workspaceRoot, lexicalTarget);
      if (!lexicalRelative || lexicalRelative.startsWith('..' + path.sep) || lexicalRelative === '..' || path.isAbsolute(lexicalRelative)) {
        throw new Error('Artifact path escapes the workspace');
      }
      ensureWorkspaceDirectories(path.dirname(lexicalTarget));
      const parentReal = fs.realpathSync(path.dirname(lexicalTarget));
      const parentRelative = path.relative(rootReal, parentReal);
      if (parentRelative.startsWith('..' + path.sep) || parentRelative === '..' || path.isAbsolute(parentRelative)) {
        throw new Error('Artifact parent resolves outside the workspace');
      }
      const target = path.join(parentReal, path.basename(lexicalTarget));
      let existing = null;
      try { existing = fs.lstatSync(target); } catch (_) {}
      if (existing && existing.isSymbolicLink()) throw new Error('Refusing to overwrite an artifact symlink');
      const data = payload.binary ? Buffer.from(payload.content || '', 'base64') : String(payload.content || '');
      await fs.promises.writeFile(target, data, payload.binary ? undefined : 'utf-8');
      invalidateTreeCache();
      send('file-event', {
        event: 'file-changed', path: target, name: path.basename(target), rootPath: workspaceRoot, workspaceIdentity
      });
      return { success: true, path: target };
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
      const parentDirectory = resolveWorkspacePath(payload.parentDir, { allowRoot: true });
      const name = validateEntryName(payload.name);
      const fullPath = resolveWorkspacePath(path.join(parentDirectory, name));
      await fs.promises.writeFile(fullPath, '', { encoding: 'utf-8', flag: 'wx' });
      invalidateTreeCache();
      send('file-event', {
        event: 'file-created', parentPath: parentDirectory, path: fullPath, name, nodeType: 'file',
        rootPath: workspaceRoot, workspaceIdentity
      });
      return { path: fullPath };
    });
    ipcMain.handle('create-folder', async (_event, payload) => {
      const parentDirectory = resolveWorkspacePath(payload.parentDir, { allowRoot: true });
      const name = validateEntryName(payload.name);
      const fullPath = resolveWorkspacePath(path.join(parentDirectory, name));
      await fs.promises.mkdir(fullPath);
      invalidateTreeCache();
      send('file-event', {
        event: 'file-created', parentPath: parentDirectory, path: fullPath, name, nodeType: 'folder',
        rootPath: workspaceRoot, workspaceIdentity
      });
      return { path: fullPath };
    });
    ipcMain.handle('rename-entry', async (_event, payload) => {
      const oldPath = resolveWorkspacePath(payload.oldPath);
      const newName = validateEntryName(payload.newName);
      const directory = path.dirname(oldPath);
      const newPath = resolveWorkspacePath(path.join(directory, newName));
      const samePath = process.platform === 'win32' ? oldPath.toLowerCase() === newPath.toLowerCase() : oldPath === newPath;
      if (!samePath && fs.existsSync(newPath)) throw new Error('An entry with that name already exists');
      await fs.promises.rename(oldPath, newPath);
      invalidateTreeCache();
      send('file-event', { event: 'file-deleted', path: oldPath, rootPath: workspaceRoot, workspaceIdentity });
      send('file-event', {
        event: 'file-created', parentPath: directory, path: newPath, name: newName,
        nodeType: safeStat(newPath)?.isDirectory() ? 'folder' : 'file', rootPath: workspaceRoot, workspaceIdentity
      });
      return { path: newPath };
    });
    ipcMain.handle('delete-entry', async (_event, payload) => {
      const entryPath = resolveWorkspacePath(payload.entryPath);
      const stat = safeStat(entryPath);
      if (!stat) return false;
      if (stat.isDirectory()) await fs.promises.rm(entryPath, { recursive: true, force: true });
      else await fs.promises.unlink(entryPath);
      invalidateTreeCache();
      send('file-event', { event: 'file-deleted', path: entryPath, rootPath: workspaceRoot, workspaceIdentity });
      return true;
    });
    ipcMain.handle('calculate-dir-size', async (_event, directory) => calculateDirectorySize(directory));
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
    handleRendererGone: () => settleLeaveRequests(true),
    handleWindowClosed,
    clearWatchers,
    resolveWorkspaceFile,
    getIdentity: () => ({ rootPath: workspaceRoot, workspaceIdentity })
  };
}

module.exports = { createWorkspaceController };
