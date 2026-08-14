const { app, BrowserWindow, ipcMain, dialog, Menu, screen, shell } = require('electron');
const path = require('path');
const rclone = require('./rclone');
const { createSettingsStore } = require('./main/settings-store');
const { createWindowState } = require('./main/window-state');
const { createWorkspaceController } = require('./main/workspace');
const { createAiController } = require('./main/ai');
const { createLspController } = require('./main/lsp');
const { createAuthController } = require('./main/auth');
const { registerDiagnosticsIpc } = require('./main/diagnostics');
const { registerRcloneIpc } = require('./main/rclone-ipc');
const { createLanguagePackController } = require('./main/language-packs');
const { createMenuController } = require('./main/menu');
const { createTasksController } = require('./main/tasks');
const { createDapController } = require('./main/dap');

let window = null;
let menu = null;
const getWindow = () => window;
const settings = createSettingsStore({ app, rclone });
const lsp = createLspController({ ipcMain, getWindow, settings });
let dap = null;
const disposeRemoteEditorServices = () => {
  lsp.dispose();
  if (dap) void dap.dispose();
};
const languagePacks = createLanguagePackController({
  app,
  ipcMain,
  dialog,
  shell,
  getWindow,
  builtinRoot: path.join(__dirname, 'language-packs'),
  onDidChange: () => {
    if (menu) menu.rebuild();
  }
});
const workspace = createWorkspaceController({
  ipcMain,
  dialog,
  getWindow,
  settings,
  t: languagePacks.t,
  disposeLsp: disposeRemoteEditorServices
});
const auth = createAuthController({
  ipcMain,
  settings,
  disposeLsp: disposeRemoteEditorServices,
  onStateChanged: () => {
    if (menu) menu.rebuild();
  }
});
menu = createMenuController({
  Menu,
  dialog,
  getWindow,
  languagePacks,
  getAuthState: auth.getState,
  pickAndOpenWorkspace: workspace.pickAndOpenWorkspace
});
const ai = createAiController({ ipcMain, getWindow, settings });
const tasks = createTasksController({ ipcMain, getWorkspaceIdentity: workspace.getIdentity });
dap = createDapController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity, settings });
const windowState = createWindowState({ screen, filePath: settings.paths.windowState, getWindow });

workspace.registerIpc();
lsp.registerIpc();
auth.registerIpc();
ai.registerIpc();
tasks.registerIpc();
dap.registerIpc();
languagePacks.registerIpc();
registerDiagnosticsIpc({ ipcMain, settings });
registerRcloneIpc({ ipcMain, BrowserWindow, dialog, getWindow, rclone });

function createWindow() {
  const savedState = windowState.load();
  const browserWindowOptions = {
    width: savedState ? savedState.width : 1280,
    height: savedState ? savedState.height : 860,
    minWidth: 760,
    minHeight: 520,
    icon: path.join(__dirname, 'ico', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };
  if (savedState && savedState.x !== undefined && savedState.y !== undefined) {
    browserWindowOptions.x = savedState.x;
    browserWindowOptions.y = savedState.y;
  }

  window = new BrowserWindow(browserWindowOptions);
  if (savedState && savedState.isMaximized) window.maximize();
  window.loadFile(path.join(__dirname, 'index.html'));

  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(windowState.save, 300);
  };
  window.on('resize', saveSoon);
  window.on('move', saveSoon);
  window.on('maximize', saveSoon);
  window.on('unmaximize', saveSoon);

  let closeApproved = false;
  let closeDecisionPending = false;
  window.on('close', (event) => {
    windowState.save();
    if (closeApproved) return;
    event.preventDefault();
    if (closeDecisionPending) return;
    closeDecisionPending = true;
    workspace.requestRendererLeave('window-close', null).then((decision) => {
      closeDecisionPending = false;
      if (!decision.allowed || !window || window.isDestroyed()) return;
      closeApproved = true;
      window.close();
    });
  });
  window.on('closed', () => {
    clearTimeout(saveTimer);
    workspace.handleWindowClosed();
    lsp.dispose();
    void dap.dispose();
    ai.dispose();
    window = null;
  });
  window.webContents.on('render-process-gone', workspace.handleRendererGone);
  menu.rebuild();
}

app.whenReady().then(() => {
  languagePacks.initialize();
  lsp.initializeRetentionPolicy();
  createWindow();
});

app.on('window-all-closed', () => {
  workspace.clearWatchers();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  languagePacks.dispose();
  lsp.dispose();
  void dap.dispose();
  ai.dispose();
  workspace.clearWatchers();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
