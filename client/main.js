const { app, BrowserWindow, ipcMain, dialog, Menu, screen, shell, session: electronSession } = require('electron');
const path = require('path');
const rclone = require('./rclone');
const { createSettingsStore } = require('./main/settings-store');
const { createWindowState } = require('./main/window-state');
const { createWorkspaceController } = require('./main/workspace');
const { createWorkspaceSettingsController } = require('./main/workspace-settings');
const { createAiController } = require('./main/ai');
const { createLspController } = require('./main/lsp');
const { createAuthController } = require('./main/auth');
const { registerDiagnosticsIpc } = require('./main/diagnostics');
const { registerRcloneIpc } = require('./main/rclone-ipc');
const { createLanguagePackController } = require('./main/language-packs');
const { createMenuController } = require('./main/menu');
const { createTasksController } = require('./main/tasks');
const { createDapController } = require('./main/dap');
const { createTerminalController } = require('./main/terminal');
const { createSecureTransportGuard } = require('./main/secure-transport');
const { createNavigationSecurity } = require('./main/navigation-security');
const { createPluginController } = require('./main/plugins');
const { createMarketplaceController } = require('./main/marketplace');

let window = null;
let menu = null;
const getWindow = () => window;
const settings = createSettingsStore({ app, rclone });
const secureTransport = createSecureTransportGuard();
const navigationSecurity = createNavigationSecurity({ shell, trustedRendererPath: path.join(__dirname, 'index.html') });
const lsp = createLspController({ ipcMain, getWindow, settings });
let dap = null;
let terminal = null;
let workspaceSettings = null;
const disposeRemoteEditorServices = () => {
  lsp.dispose();
  if (dap) void dap.dispose();
  if (terminal) void terminal.dispose();
};
const languagePacks = createLanguagePackController({ app, ipcMain, dialog, shell, getWindow,
  builtinRoot: path.join(__dirname, 'language-packs'), onDidChange: () => { if (menu) menu.rebuild(); } });
const workspace = createWorkspaceController({
  ipcMain,
  dialog,
  getWindow,
  settings,
  t: languagePacks.t,
  disposeLsp: disposeRemoteEditorServices,
  stopTerminal: (reason) => terminal ? terminal.stop(reason) : { state: 'idle' },
  onWorkspaceChanged: () => { if (workspaceSettings) workspaceSettings.workspaceChanged(); },
  onWorkspaceFilesystemEvent: (rootPath, workspaceIdentity, changedPath) => {
    if (workspaceSettings) workspaceSettings.notifyFilesystemEvent(rootPath, workspaceIdentity, changedPath);
  }
});
workspaceSettings = createWorkspaceSettingsController({
  ipcMain,
  getWindow,
  getWorkspaceIdentity: workspace.getIdentity
});
const plugins = createPluginController({ app, ipcMain, dialog, shell, getWindow, t: languagePacks.t,
  getWorkspaceIdentity: workspace.getIdentity,
  resolveWorkspaceFile: workspace.resolveWorkspaceFile,
  onDidChange: () => { if (menu) menu.rebuild(); }
});
const marketplace = createMarketplaceController({ app, ipcMain, getWindow, pluginManager: plugins, hostVersion: app.getVersion() });
const auth = createAuthController({ ipcMain, settings, disposeLsp: disposeRemoteEditorServices,
  onStateChanged: () => { if (menu) menu.rebuild(); }, onServerSettingsWritten: secureTransport.update });
menu = createMenuController({ Menu, dialog, getWindow, languagePacks, getAuthState: auth.getState,
  pickAndOpenWorkspace: workspace.pickAndOpenWorkspace });
const ai = createAiController({ ipcMain, getWindow, settings });
const tasks = createTasksController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity });
dap = createDapController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity, settings });
terminal = createTerminalController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity, settings });
const windowState = createWindowState({ screen, filePath: settings.paths.windowState, getWindow });

workspace.registerIpc();
workspaceSettings.registerIpc();
lsp.registerIpc();
auth.registerIpc();
ai.registerIpc();
tasks.registerIpc();
dap.registerIpc();
terminal.registerIpc();
languagePacks.registerIpc();
plugins.registerIpc();
marketplace.registerIpc();
registerDiagnosticsIpc({ ipcMain, settings });
registerRcloneIpc({ ipcMain, BrowserWindow, dialog, getWindow, rclone });

function createWindow() {
  const savedState = windowState.load();
  const browserWindowOptions = { width: savedState ? savedState.width : 1280, height: savedState ? savedState.height : 860,
    minWidth: 760, minHeight: 520, icon: path.join(__dirname, 'ico', 'app-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: false } };
  if (savedState && savedState.x !== undefined && savedState.y !== undefined) {
    browserWindowOptions.x = savedState.x;
    browserWindowOptions.y = savedState.y;
  }

  window = new BrowserWindow(browserWindowOptions);
  navigationSecurity.protectWindow(window);
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
    void terminal.dispose();
    ai.dispose();
    window = null;
  });
  window.webContents.on('render-process-gone', () => {
    workspace.handleRendererGone();
    if (terminal) void terminal.dispose();
  });
  menu.rebuild();
}

app.whenReady().then(async () => {
  languagePacks.initialize();
  try {
    await plugins.initialize();
  } catch (error) {
    // A damaged user plugin must not prevent the core workbench from opening.
    console.error('[plugins] startup scan failed:', error && error.message ? error.message : error);
  }
  navigationSecurity.protectSession(electronSession.defaultSession);
  electronSession.defaultSession.setCertificateVerifyProc((request, callback) => callback(secureTransport.verify(request)));
  settings.readServerSettings().then(secureTransport.update).catch(() => {});
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
  void terminal.dispose();
  ai.dispose();
  workspace.clearWatchers();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
