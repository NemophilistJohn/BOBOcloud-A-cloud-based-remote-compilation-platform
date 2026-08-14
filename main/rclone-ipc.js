const fs = require('fs');
const path = require('path');

function safeStat(candidate) {
  try {
    return fs.statSync(candidate);
  } catch (_) {
    return null;
  }
}

function registerRcloneIpc(options) {
  const ipcMain = options.ipcMain;
  const BrowserWindow = options.BrowserWindow;
  const dialog = options.dialog;
  const getWindow = options.getWindow;
  const rclone = options.rclone;

  ipcMain.handle('rclone:sync', async (event, payload) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const operationId = typeof payload.operationId === 'string' ? payload.operationId : '';
    return rclone.sync({
      rclonePath: payload.rclonePath,
      src: payload.src,
      remotePath: payload.remotePath,
      excludes: payload.excludes,
      onProgress(line) {
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('rclone:progress', { operationId, line });
        }
      }
    });
  });

  ipcMain.handle('rclone:pull', async (event, payload) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const operationId = typeof payload.operationId === 'string' ? payload.operationId : '';
    return rclone.pull({
      rclonePath: payload.rclonePath,
      dest: payload.dest,
      remotePath: payload.remotePath,
      excludes: payload.excludes,
      onProgress(line) {
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('rclone:progress', { operationId, line });
        }
      }
    });
  });

  ipcMain.handle('pick-local-mapping', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose local mapping directory',
      buttonLabel: 'Use this directory',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = path.resolve(result.filePaths[0]);
    const stat = safeStat(selected);
    if (!stat || !stat.isDirectory()) throw new Error('Selected mapping directory does not exist');
    const entries = fs.readdirSync(selected).filter((name) => name !== '.bobocloud-team.json');
    return { path: selected, empty: entries.length === 0 };
  });

  ipcMain.handle('local-path-info', async (_event, candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return { exists: false };
    const resolved = path.resolve(candidate);
    const stat = safeStat(resolved);
    if (!stat) return { exists: false, path: resolved };
    return {
      exists: true,
      directory: stat.isDirectory(),
      empty: stat.isDirectory() ? fs.readdirSync(resolved).filter((name) => name !== '.bobocloud-team.json').length === 0 : false,
      path: resolved
    };
  });

  ipcMain.handle('rclone:check-version', async (_event, rclonePath) => rclone.checkVersion(rclonePath));
  ipcMain.handle('rclone:find-path', async () => rclone.findInPath());
}

module.exports = { registerRcloneIpc };
