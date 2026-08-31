const { app, BrowserWindow, ipcMain, dialog, Menu, screen, shell, safeStorage, session: electronSession } = require('electron');
const path = require('path');
const rclone = require('./rclone');
const { createSettingsStore } = require('./main/settings-store');
const { createWindowState } = require('./main/window-state');
const { createWorkspaceController } = require('./main/workspace');
const { createWorkspaceSettingsController } = require('./main/workspace-settings');
const { createAiController } = require('./main/ai');
const { createAgentPlatformBroker } = require('./main/agent-platform');
const { createLspController } = require('./main/lsp');
const { createAuthController } = require('./main/auth');
const { registerDiagnosticsIpc } = require('./main/diagnostics');
const { registerRcloneIpc } = require('./main/rclone-ipc');
const { createRcloneBinaryManager } = require('./main/rclone-binary-manager'), { createRcloneService } = require('./main/rclone-service'), { createLocalDirectoryAuthority } = require('./main/local-directory-authority');
const { createLanguagePackController } = require('./main/language-packs');
const { createMenuController } = require('./main/menu');
const { createTasksController } = require('./main/tasks');
const { createDapController } = require('./main/dap');
const { createTerminalController } = require('./main/terminal');
const { createSecureTransportGuard } = require('./main/secure-transport');
const { createNavigationSecurity } = require('./main/navigation-security');
const { createPluginController } = require('./main/plugins');
const { createMarketplaceController } = require('./main/marketplace');
const { createPackageCenterController } = require('./main/package-center');
const { createLifecycleCoordinator } = require('./main/lifecycle-coordinator');
const { attachWindowLifecycle } = require('./main/window-lifecycle');
let window = null, menu = null; const getWindow = () => window;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
const settings = createSettingsStore({ app, safeStorage }), rcloneBinaries = createRcloneBinaryManager({ app, rclone }), localDirectories = createLocalDirectoryAuthority({ assertSafeLocalRoot: rcloneBinaries.assertSafeLocalRoot });
const rcloneService = createRcloneService({ rclone, binaryManager: rcloneBinaries, settings,
  fetch: (...args) => electronSession.defaultSession.fetch(...args) });
const secureTransport = createSecureTransportGuard();
const lifecycle = createLifecycleCoordinator({
  onError: (name, error) => console.error(`[lifecycle] ${name} cleanup failed:`, error && error.message ? error.message : error)
});
const navigationSecurity = createNavigationSecurity({ shell, trustedRendererPath: path.join(__dirname, 'index.html') });
const lsp = createLspController({ ipcMain, getWindow, settings });
let dap = null, terminal = null, workspaceSettings = null, packageCenter = null, agentBroker = null;
const disposeRemoteEditorServices = async (reason) => {
  lsp.dispose();
  await Promise.allSettled([
    dap ? dap.dispose(reason) : Promise.resolve(),
    terminal ? terminal.dispose(reason) : Promise.resolve()
  ]);
};
const languagePacks = createLanguagePackController({ app, ipcMain, dialog, shell, getWindow,
  builtinRoot: path.join(__dirname, 'language-packs'), onDidChange: () => { if (menu) menu.rebuild(); } });
const workspace = createWorkspaceController({
  ipcMain,
  dialog,
  getWindow,
  settings,
  t: languagePacks.t,
  assertSafeLocalRoot: rcloneBinaries.assertSafeLocalRoot, localDirectoryAuthority: localDirectories,
  disposeLsp: disposeRemoteEditorServices,
  stopTerminal: (reason) => terminal ? terminal.stop(reason) : { state: 'idle' },
  beforeWorkspaceChange: async (reason) => {
    await rcloneService.cancelAll(reason || 'workspace-transition');
    return packageCenter ? packageCenter.beginWorkspaceTransition(reason) : [];
  },
  afterWorkspaceChange: () => packageCenter ? packageCenter.endWorkspaceTransition() : true,
  onWorkspaceChanged: () => { if (workspaceSettings) workspaceSettings.workspaceChanged(); if (agentBroker) agentBroker.workspaceChanged(); },
  onWorkspaceFilesystemEvent: (rootPath, workspaceIdentity, changedPath) => {
    if (workspaceSettings) workspaceSettings.notifyFilesystemEvent(rootPath, workspaceIdentity, changedPath);
  },
  allowDirectWorkspacePaths: !app.isPackaged
});
workspaceSettings = createWorkspaceSettingsController({
  ipcMain,
  getWindow,
  getWorkspaceIdentity: workspace.getIdentity
});
const ai = createAiController({ ipcMain, getWindow, settings });
agentBroker = createAgentPlatformBroker({ app, settings, getWorkspaceIdentity: workspace.getIdentity,
  runWorkspaceMutation: workspace.runMutation, notifyWorkspaceFiles: workspace.notifyExternalFileChanges,
  requestModel: ai.request, cancelModel: ai.cancel });
const plugins = createPluginController({ app, ipcMain, dialog, shell, getWindow, t: languagePacks.t,
  getWorkspaceIdentity: workspace.getIdentity,
  resolveWorkspaceFile: workspace.resolveWorkspaceFile,
  agentBroker,
  onDidChange: () => { if (menu) menu.rebuild(); }
});
const marketplace = createMarketplaceController({ app, ipcMain, getWindow, pluginManager: plugins, hostVersion: app.getVersion() });
packageCenter = createPackageCenterController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity,
  onFilesChanged: (files, context) => workspace.notifyExternalFileChanges(files, context), userDataPath: app.getPath('userData') });
const auth = createAuthController({ ipcMain, settings, disposeLsp: disposeRemoteEditorServices,
  onStateChanged: () => { if (menu) menu.rebuild(); },
  onServerSettingsWritten: async (value) => {
    secureTransport.update(value);
    await rcloneService.reconfigure(value, 'server-settings-changed');
  },
  onCredentialChanged: () => rcloneService.cancelAll('credential-changed')
});
menu = createMenuController({ Menu, dialog, getWindow, languagePacks, getAuthState: auth.getState,
  pickAndOpenWorkspace: workspace.pickAndOpenWorkspace });
const tasks = createTasksController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity });
dap = createDapController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity,
  runWorkspaceMutation: workspace.runMutation, settings });
terminal = createTerminalController({ ipcMain, getWindow, getWorkspaceIdentity: workspace.getIdentity, settings });
lifecycle.register('remote-editor-services', disposeRemoteEditorServices);
lifecycle.register('ai', async () => { ai.dispose(); });
lifecycle.register('agent-platform', async () => { agentBroker.dispose(); });
lifecycle.register('rclone', (reason) => rcloneService.cancelAll(reason));
lifecycle.register('server-settings-transaction', async () => { auth.discardServerSettingsRollback(); });
const windowState = createWindowState({ screen, filePath: settings.paths.windowState, getWindow });
for (const controller of [workspace, workspaceSettings, lsp, auth, ai, tasks, dap, terminal,
  languagePacks, plugins, marketplace, packageCenter]) controller.registerIpc();
registerDiagnosticsIpc({ ipcMain, settings });
registerRcloneIpc({ ipcMain, BrowserWindow, dialog, getWindow, service: rcloneService, t: languagePacks.t,
  getWorkspaceIdentity: workspace.getIdentity, localDirectoryAuthority: localDirectories,
  measureDirectory: workspace.calculateDirectorySize });
function createWindow() {
  const savedState = windowState.load();
  const browserWindowOptions = { width: savedState ? savedState.width : 1280, height: savedState ? savedState.height : 860,
    minWidth: 760, minHeight: 520, icon: path.join(__dirname, 'ico', 'app-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false } };
  if (savedState && savedState.x !== undefined && savedState.y !== undefined) {
    browserWindowOptions.x = savedState.x;
    browserWindowOptions.y = savedState.y;
  }
  window = new BrowserWindow(browserWindowOptions);
  navigationSecurity.protectWindow(window);
  if (savedState && savedState.isMaximized) window.maximize();
  window.loadFile(path.join(__dirname, 'index.html'));
  attachWindowLifecycle({
    window, dialog, languagePacks, lifecycle, localDirectories, packageCenter,
    rcloneService, windowState, workspace,
    onClosed: (closed) => { if (window === closed) window = null; }
  });
  menu.rebuild();
}
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  languagePacks.initialize();
  try {
    await plugins.initialize();
  } catch (error) {
    // A damaged user plugin must not prevent the core workbench from opening.
    console.error('[plugins] startup scan failed:', error && error.message ? error.message : error);
  }
  navigationSecurity.protectSession(electronSession.defaultSession);
  electronSession.defaultSession.setCertificateVerifyProc((request, callback) => callback(secureTransport.verify(request)));
  settings.readServerSettings().then((value) => { secureTransport.update(value); rcloneService.configureInBackground(value); }).catch(() => {});
  lsp.initializeRetentionPolicy();
  createWindow();
});
app.on('window-all-closed', () => {
  workspace.clearWatchers();
  if (process.platform !== 'darwin') app.quit();
});
let quitApproved = false;
app.on('before-quit', (event) => {
  if (quitApproved) return;
  event.preventDefault();
  void lifecycle.run('app-quit').finally(() => {
    quitApproved = true;
    app.quit();
  });
});
app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
app.on('will-quit', () => {
  languagePacks.dispose();
  workspace.clearWatchers();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
