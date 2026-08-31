'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeRemotePath } = require('./rclone-remote-authority');
const { readTeamMapping } = require('./team-mapping');

function readMappingMarker(directory) {
  return readTeamMapping(directory, { requireLocalPath: true });
}

async function directoryIsEmptyExceptMarker(directory) {
  const handle = await fs.promises.opendir(directory);
  try {
    for (;;) {
      const entry = await handle.read();
      if (!entry) return true;
      if (entry.name !== '.bobocloud-team.json') return false;
    }
  } finally {
    await handle.close().catch((error) => {
      if (!error || error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
}

function operationId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('A valid rclone operation id is required');
  }
  return value;
}

function workspaceProjectKey(workspaceRoot) {
  const normalized = String(workspaceRoot || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  }
  return 'p' + Math.abs(hash).toString(36);
}

function mainOwnedPreparationRequest(kind, request, localPath) {
  const supplied = request && typeof request === 'object' ? request : {};
  const mapping = readMappingMarker(localPath);
  if (kind === 'workspace') {
    return {
      folderName: mapping && mapping.projectName ? String(mapping.projectName) : path.basename(localPath),
      folderKey: mapping ? '' : workspaceProjectKey(localPath),
      teamId: mapping ? mapping.teamId : undefined,
      projectId: mapping ? mapping.projectId : undefined,
      branch: mapping ? mapping.branch : undefined
    };
  }
  if (mapping) {
    return {
      teamId: mapping.teamId,
      projectId: mapping.projectId,
      branch: mapping.branch,
      reset: supplied.reset === true,
      pull: supplied.pull === true
    };
  }
  return supplied;
}

function registerRcloneIpc(options) {
  const ipcMain = options.ipcMain;
  const BrowserWindow = options.BrowserWindow;
  const dialog = options.dialog;
  const getWindow = options.getWindow;
  const getWorkspaceIdentity = options.getWorkspaceIdentity || (() => ({ rootPath: null, workspaceIdentity: 0 }));
  const localDirectoryAuthority = options.localDirectoryAuthority;
  const service = options.service;
  const measureDirectory = options.measureDirectory;
  if (typeof measureDirectory !== 'function') throw new TypeError('rclone IPC requires a main-owned directory measurement');
  const boundSenders = new WeakSet();
  const t = options.t || ((value, replacements) => String(value).replace(/\{([^}]+)\}/g, (match, key) => (
    replacements && replacements[key] !== undefined ? replacements[key] : match
  )));

  function bindSender(sender) {
    if (!sender || boundSenders.has(sender) || typeof sender.once !== 'function') return;
    boundSenders.add(sender);
    sender.once('destroyed', () => {
      localDirectoryAuthority.revokeSender(sender.id);
      void service.cancelSender(sender.id, 'renderer-destroyed');
    });
  }

  function trustedWindow(event) {
    const owner = getWindow();
    if (!owner || owner.isDestroyed() || !event || event.sender !== owner.webContents) {
      throw new Error('Untrusted rclone IPC sender');
    }
    if (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame) {
      throw new Error('rclone IPC is only available to the main frame');
    }
    bindSender(event.sender);
    return owner;
  }

  function operationPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid rclone operation payload');
    }
    for (const forbidden of ['rclonePath', 'src', 'dest', 'remotePath', 'excludes']) {
      if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
        throw new Error('Renderer-selected rclone paths and exclusion policy are not accepted');
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

  function localScope(event, payload, kind) {
    const scope = payload.localScope;
    if (!scope || typeof scope !== 'object') throw new Error('A local synchronization scope is required');
    if (scope.type === 'workspace') {
      const current = getWorkspaceIdentity();
      if (!current.rootPath || scope.workspaceIdentity !== current.workspaceIdentity ||
          path.resolve(scope.rootPath || '') !== path.resolve(current.rootPath)) {
        throw new Error('The workspace synchronization scope is stale');
      }
      const localPath = translatedSafeDirectory(current.rootPath);
      const expectedIdentity = current.workspaceIdentity;
      return {
        localPath,
        bindingKey: JSON.stringify(['workspace', event.sender.id, expectedIdentity, localPath]),
        isCurrent() {
          const latest = getWorkspaceIdentity();
          return latest.workspaceIdentity === expectedIdentity && latest.rootPath &&
            path.resolve(latest.rootPath) === path.resolve(localPath);
        }
      };
    }
    if (kind === 'pull' && scope.type === 'mapping') {
      const grantId = String(scope.grantId || '');
      const localPath = localDirectoryAuthority.resolve(event.sender.id, grantId);
      return {
        localPath,
        bindingKey: JSON.stringify(['mapping', event.sender.id, grantId, localPath]),
        isCurrent() {
          try {
            return localDirectoryAuthority.resolve(event.sender.id, grantId, localPath) === localPath;
          } catch (_) {
            return false;
          }
        }
      };
    }
    throw new Error('The local synchronization scope is invalid');
  }

  ipcMain.handle('rclone:prepare-remote', async (event, rawPayload) => {
    trustedWindow(event);
    const payload = operationPayload(rawPayload);
    const kind = payload.kind === 'workspace' ? 'workspace' : payload.kind === 'team-pull' ? 'team-pull' : '';
    if (!kind) throw new Error('Invalid remote preparation kind');
    const id = operationId(payload.operationId);
    const local = localScope(event, payload, kind === 'team-pull' ? 'pull' : 'sync');
    const request = mainOwnedPreparationRequest(kind, payload.request, local.localPath);
    return service.prepareRemote({
      senderId: event.sender.id,
      operationId: id,
      kind,
      request,
      measure: kind === 'workspace'
        ? (signal) => measureDirectory(local.localPath, { signal })
        : null,
      bindingKey: local.bindingKey,
      isCurrent: local.isCurrent
    });
  });

  function operationHandler(kind) {
    return async (event, rawPayload) => {
      trustedWindow(event);
      const payload = operationPayload(rawPayload);
      const id = operationId(payload.operationId);
      const remoteGrantId = String(payload.remoteGrantId || '');
      if (!remoteGrantId || remoteGrantId.length > 200) throw new Error('A remote synchronization grant is required');
      const local = localScope(event, payload, kind);
      const targetWindow = BrowserWindow.fromWebContents(event.sender);
      return service[kind]({
        senderId: event.sender.id,
        operationId: id,
        remoteGrantId,
        localPath: local.localPath,
        bindingKey: local.bindingKey,
        isCurrent: local.isCurrent,
        onProgress(line) {
          if (local.isCurrent() && targetWindow && !targetWindow.isDestroyed() &&
              targetWindow.webContents && !targetWindow.webContents.isDestroyed?.()) {
            targetWindow.webContents.send('rclone:progress', { operationId: id, line });
          }
        }
      });
    };
  }

  ipcMain.handle('rclone:sync', operationHandler('sync'));
  ipcMain.handle('rclone:pull', operationHandler('pull'));

  ipcMain.handle('rclone:cancel', async (event, payload) => {
    trustedWindow(event);
    return service.cancelOperation(event.sender.id, operationId(payload && payload.operationId), 'renderer-cancel');
  });

  ipcMain.handle('rclone:cancel-all', async (event, payload) => {
    trustedWindow(event);
    const reason = String(payload && payload.reason || 'renderer-context-changed').slice(0, 80);
    return service.cancelSender(event.sender.id, reason);
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
    return {
      path: granted.path,
      grantId: granted.grantId,
      empty: await directoryIsEmptyExceptMarker(granted.path)
    };
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
    return {
      exists: true,
      directory: true,
      empty: await directoryIsEmptyExceptMarker(resolved),
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

  ipcMain.handle('rclone:validate-connection', async (event) => {
    trustedWindow(event);
    return service.validateConnection(event.sender.id);
  });

  return {
    cancelAll: (reason) => service.cancelAll(reason),
    cancelSender: (senderId, reason) => service.cancelSender(senderId, reason)
  };
}

module.exports = { directoryIsEmptyExceptMarker, normalizeRemotePath, registerRcloneIpc, workspaceProjectKey };
