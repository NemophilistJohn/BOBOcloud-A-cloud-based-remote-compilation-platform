const path = require('path');
const { LanguagePackManager } = require('../language-pack-manager');

function createLanguagePackController(options) {
  const app = options.app;
  const ipcMain = options.ipcMain;
  const dialog = options.dialog;
  const shell = options.shell;
  const getWindow = options.getWindow;
  const onDidChange = options.onDidChange || (() => {});
  const builtinRoot = options.builtinRoot;
  let manager = null;

  function ensureManager() {
    if (!manager) throw new Error('Language packs are not initialized');
    return manager;
  }

  function t(sourceEnglish, replacements) {
    return manager ? manager.t(sourceEnglish, replacements) : sourceEnglish;
  }

  function initialize() {
    if (manager) return manager;
    manager = new LanguagePackManager({
      builtinRoot: path.resolve(builtinRoot),
      userDataPath: app.getPath('userData'),
      isPackaged: app.isPackaged,
      onDidChange(payload) {
        const window = getWindow();
        if (window && !window.isDestroyed()) window.webContents.send('language-packs:changed', payload);
        onDidChange(payload);
      }
    });
    manager.startup();
    return manager;
  }

  async function installFromDialog() {
    const languagePacks = ensureManager();
    const dialogOptions = {
      title: t('Select Language Pack Folder'),
      buttonLabel: t('Install'),
      properties: ['openDirectory']
    };
    const owner = getWindow();
    const result = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || !result.filePaths[0]) return null;
    return languagePacks.installDirectory(result.filePaths[0]);
  }

  async function openFolder() {
    const folderPath = ensureManager().openFolderPath();
    const error = await shell.openPath(folderPath);
    if (error) throw new Error(error);
    return { success: true, path: folderPath };
  }

  function registerIpc() {
    ipcMain.handle('language-packs:startup', async () => ensureManager().startup());
    ipcMain.handle('language-packs:list', async () => ensureManager().list());
    ipcMain.handle('language-packs:load', async (_event, id) => ensureManager().load(id));
    ipcMain.handle('language-packs:set-active', async (_event, id) => ensureManager().setActive(id));
    ipcMain.handle('language-packs:install-directory', async () => installFromDialog());
    ipcMain.handle('language-packs:remove', async (_event, id) => ensureManager().remove(id));
    ipcMain.handle('language-packs:open-folder', async () => openFolder());
    ipcMain.handle('language-packs:refresh', async () => ensureManager().refresh('manual'));
  }

  return {
    initialize,
    registerIpc,
    t,
    list: () => manager ? manager.list() : { packs: [] },
    getActiveId: () => manager ? manager.activeId : '',
    setActive: (id) => ensureManager().setActive(id),
    installFromDialog,
    openFolder,
    dispose: () => {
      if (manager) manager.dispose();
      manager = null;
    }
  };
}

module.exports = { createLanguagePackController };
