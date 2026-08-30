'use strict';

const fs = require('fs');
const path = require('path');

function normalizeRemotePath(candidate) {
  if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.length > 4096 ||
      /[\0-\x1f\\:]/.test(candidate)) {
    throw new Error('Invalid remote workspace path');
  }
  const segments = candidate.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Invalid remote workspace path');
  }
  return '/' + segments.join('/');
}

function readMappingMarker(directory) {
  const markerPath = path.join(directory, '.bobocloud-team.json');
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const mapping = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (!mapping || path.resolve(mapping.localPath || '') !== path.resolve(directory) ||
        !mapping.teamId || !mapping.projectId || !mapping.branch || !mapping.remotePath) return null;
    normalizeRemotePath(mapping.remotePath);
    return mapping;
  } catch (_) {
    return null;
  }
}

function registerRcloneIpc(options) {
  const ipcMain = options.ipcMain;
  const BrowserWindow = options.BrowserWindow;
  const dialog = options.dialog;
  const getWindow = options.getWindow;
  const getWorkspaceIdentity = options.getWorkspaceIdentity || (() => ({ rootPath: null, workspaceIdentity: 0 }));
  const localDirectoryAuthority = options.localDirectoryAuthority;
  const service = options.service;
  const t = options.t || ((value, replacements) => String(value).replace(/\{([^}]+)\}/g, (match, key) => (
    replacements && replacements[key] !== undefined ? replacements[key] : match
  )));

  function trustedWindow(event) {
    const owner = getWindow();
    if (!owner || owner.isDestroyed() || !event || event.sender !== owner.webContents) {
      throw new Error('Untrusted rclone IPC sender');
    }
    if (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame) {
      throw new Error('rclone IPC is only available to the main frame');
    }
    return owner;
  }

  function operationPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid rclone operation payload');
    }
    for (const forbidden of ['rclonePath', 'src', 'dest']) {
      if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
        throw new Error('Renderer-selected rclone executable and local paths are no longer accepted');
      }
    }
    return payload;
  }

  function translatedSafeDirectory(candidate) {
    try {
      return localDirectoryAuthority.inspectDirectory(candidate);
    } catch (error) {
      if (error && error.code === 'PROTECTED_LOCAL_DIRECTORY') {
        throw new Error(t('This directory is reserved by BOBOCLOUD and cannot be used for synchronization.'));
      }
      throw error;
    }
  }

  function operationLocalRoot(event, payload, kind) {
    const scope = payload.localScope;
    if (!scope || typeof scope !== 'object') throw new Error('A local synchronization scope is required');
    if (scope.type === 'workspace') {
      const current = getWorkspaceIdentity();
      if (!current.rootPath || scope.workspaceIdentity !== current.workspaceIdentity ||
          path.resolve(scope.rootPath || '') !== path.resolve(current.rootPath)) {
        throw new Error('The workspace synchronization scope is stale');
      }
      return translatedSafeDirectory(current.rootPath);
    }
    if (kind === 'pull' && scope.type === 'mapping') {
      return localDirectoryAuthority.resolve(event.sender.id, scope.grantId);
    }
    throw new Error('The local synchronization scope is invalid');
  }

  ipcMain.handle('rclone:sync', async (event, rawPayload) => {
    trustedWindow(event);
    const payload = operationPayload(rawPayload);
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const operationId = typeof payload.operationId === 'string' ? payload.operationId : '';
    return service.sync({
      src: operationLocalRoot(event, payload, 'sync'),
      remotePath: normalizeRemotePath(payload.remotePath),
      excludes: payload.excludes,
      onProgress(line) {
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('rclone:progress', { operationId, line });
        }
      }
    });
  });

  ipcMain.handle('rclone:pull', async (event, rawPayload) => {
    trustedWindow(event);
    const payload = operationPayload(rawPayload);
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const operationId = typeof payload.operationId === 'string' ? payload.operationId : '';
    return service.pull({
      dest: operationLocalRoot(event, payload, 'pull'),
      remotePath: normalizeRemotePath(payload.remotePath),
      excludes: payload.excludes,
      onProgress(line) {
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('rclone:progress', { operationId, line });
        }
      }
    });
  });

  ipcMain.handle('pick-local-mapping', async (event) => {
    const owner = trustedWindow(event);
    const result = await dialog.showOpenDialog(owner, {
      title: t('Choose local mapping directory'),
      buttonLabel: t('Use this directory'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    let granted;
    try {
      granted = localDirectoryAuthority.grant(event.sender.id, result.filePaths[0], 'native-picker');
    } catch (error) {
      if (error && error.code === 'PROTECTED_LOCAL_DIRECTORY') {
        throw new Error(t('This directory is reserved by BOBOCLOUD and cannot be used for synchronization.'));
      }
      throw error;
    }
    const entries = fs.readdirSync(granted.path).filter((name) => name !== '.bobocloud-team.json');
    return { path: granted.path, grantId: granted.grantId, empty: entries.length === 0 };
  });

  ipcMain.handle('local-path-info', async (event, request) => {
    trustedWindow(event);
    const candidate = typeof request === 'string' ? request : request && request.path;
    const existingGrant = request && typeof request === 'object' ? request.grantId : '';
    if (typeof candidate !== 'string' || !candidate.trim()) return { exists: false };
    let resolved;
    try {
      resolved = translatedSafeDirectory(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, path: path.resolve(candidate) };
      throw error;
    }
    let grant;
    if (existingGrant) {
      localDirectoryAuthority.resolve(event.sender.id, existingGrant, resolved);
      grant = { grantId: existingGrant, path: resolved };
    } else {
      const current = getWorkspaceIdentity();
      if (current.rootPath && path.resolve(current.rootPath) === path.resolve(resolved)) {
        grant = localDirectoryAuthority.grant(event.sender.id, resolved, 'active-workspace');
      } else if (readMappingMarker(resolved)) {
        grant = localDirectoryAuthority.grant(event.sender.id, resolved, 'team-mapping');
      }
    }
    const entries = fs.readdirSync(resolved).filter((name) => name !== '.bobocloud-team.json');
    return {
      exists: true,
      directory: true,
      empty: entries.length === 0,
      path: resolved,
      grantId: grant ? grant.grantId : null
    };
  });

  ipcMain.handle('rclone:list-binaries', async (event) => {
    trustedWindow(event);
    return service.listBinaries(event.sender.id);
  });

  ipcMain.handle('rclone:get-selection', async (event) => {
    trustedWindow(event);
    return service.getSelection();
  });

  ipcMain.handle('rclone:select-binary', async (event, payload) => {
    const owner = trustedWindow(event);
    return service.selectBinary(event.sender.id, payload, async (candidate) => {
      const result = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: t('Confirm external rclone?'),
        message: t('External rclone is outside BOBOCLOUD\'s trust boundary.'),
        detail: t('It can access synchronized workspace files and the local rclone configuration. Only continue if you trust this exact executable:\n{path}', {
          path: candidate.path
        }),
        buttons: [t('Cancel'), t('Use external rclone')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      return result.response === 1;
    });
  });

  ipcMain.handle('rclone:check-version', async (event) => {
    trustedWindow(event);
    return service.checkVersion();
  });
}

module.exports = { normalizeRemotePath, registerRcloneIpc };
