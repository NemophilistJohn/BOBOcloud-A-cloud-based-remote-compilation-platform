const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  ipcRenderer.on(channel, callback);
  return () => ipcRenderer.removeListener(channel, callback);
}

function subscribePayload(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  return subscribe(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // Workspace
  pickWorkspace: (dirPath) => ipcRenderer.invoke('pick-workspace', dirPath),
  closeWorkspace: () => ipcRenderer.invoke('close-workspace'),
  readTree: (path) => ipcRenderer.invoke('read-tree', path),
  onWorkspaceOpened: (cb) => subscribePayload('workspace-opened', cb),
  onWorkspaceRefresh: (cb) => subscribePayload('workspace-refresh', cb),
  onWorkspaceLeaveRequest: (cb) => subscribePayload('workspace-leave-request', cb),
  onWorkspaceLeaveAborted: (cb) => subscribePayload('workspace-leave-aborted', cb),
  respondWorkspaceLeave: (requestId, allowed) => ipcRenderer.send('workspace-leave-response', { requestId, allowed }),
  chooseWorkspaceLeave: (details) => ipcRenderer.invoke('workspace-leave-choice', details),
  getWorkspaceIdentity: () => ipcRenderer.invoke('workspace-identity'),
  workspaceSwitchApplied: (details) => ipcRenderer.invoke('workspace-switch-applied', details),
  rejectWorkspaceSwitch: (details) => ipcRenderer.invoke('workspace-switch-reject', details),
  setArtifactRunContext: (context) => ipcRenderer.invoke('artifact-run-context', context),
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  tasksResolve: (label, context) => ipcRenderer.invoke('tasks:resolve', { label, context }),
  // Debug Adapter Protocol. Credentials and the WebSocket stay in main.
  dapConfigurations: () => ipcRenderer.invoke('dap:configurations'),
  dapResolve: (id, context) => ipcRenderer.invoke('dap:resolve', { id, context }),
  dapEnsureConfiguration: () => ipcRenderer.invoke('dap:ensure-configuration'),
  dapStart: (payload) => ipcRenderer.invoke('dap:start', payload),
  dapRequest: (command, args, timeoutMs) => ipcRenderer.invoke('dap:request', { command, arguments: args, timeoutMs }),
  dapRespond: (request, success, body, message) => ipcRenderer.invoke('dap:respond', { request, success, body, message }),
  dapStop: (reason) => ipcRenderer.invoke('dap:stop', reason),
  dapStatus: () => ipcRenderer.invoke('dap:status'),
  onDapMessage: (cb) => subscribePayload('dap:message', cb),
  onDapStatus: (cb) => subscribePayload('dap:status', cb),
  // Incremental file events (lightweight, no full tree rebuild)
  onFileEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    return subscribe('file-event', listener);
  },
  refreshWorkspace: () => ipcRenderer.invoke('refresh-workspace'),

  // Files
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (payload) => ipcRenderer.invoke('save-file', payload),
  saveBinaryFile: (payload) => ipcRenderer.invoke('save-binary-file', payload),
  saveArtifact: (payload) => ipcRenderer.invoke('save-artifact', payload),

  // FS operations
  createFile: (payload) => ipcRenderer.invoke('create-file', payload),
  createFolder: (payload) => ipcRenderer.invoke('create-folder', payload),
  renameEntry: (payload) => ipcRenderer.invoke('rename-entry', payload),
  deleteEntry: (payload) => ipcRenderer.invoke('delete-entry', payload),
  onOpenServerSettings: (cb) => subscribe('open-server-settings', cb),

  // Remote language service. Authentication stays in the main process.
  lspSettingsRead: () => ipcRenderer.invoke('lsp:settings-read'),
  lspSettingsWrite: (settings) => ipcRenderer.invoke('lsp:settings-write', settings),
  // Client analysis cache. Scope is a data-only workspace identity; the main
  // process derives server and user namespaces and owns all file access.
  lspClientCacheGet: (scope, key) => ipcRenderer.invoke('lsp:client-cache-get', scope, key),
  lspClientCachePut: (scope, key, value) => ipcRenderer.invoke('lsp:client-cache-put', scope, key, value),
  lspClientCacheStats: (scope) => ipcRenderer.invoke('lsp:client-cache-stats', scope),
  lspClientCacheClear: (request) => ipcRenderer.invoke('lsp:client-cache-clear', request),
  lspClientCachePrune: (force) => ipcRenderer.invoke('lsp:client-cache-prune', force === true),
  // Dependency API indexes are sanitized summaries, stored separately from
  // position-specific completion candidates. The main process validates their
  // scope against the authenticated server identity before any file access.
  lspClientCacheDependencyIndexGet: (scope, key) => ipcRenderer.invoke('lsp:client-cache-dependency-index-get', scope, key),
  lspClientCacheDependencyIndexPut: (scope, key, value) => ipcRenderer.invoke('lsp:client-cache-dependency-index-put', scope, key, value),
  lspClientCacheDependencyIndexClear: (request) => ipcRenderer.invoke('lsp:client-cache-dependency-index-clear', request),
  lspConfigure: (config) => ipcRenderer.invoke('lsp:configure', config),
  lspRequest: (payload) => ipcRenderer.invoke('lsp:request', payload),
  lspNotify: (payload) => ipcRenderer.invoke('lsp:notify', payload),
  lspCancel: (requestKey) => ipcRenderer.invoke('lsp:cancel', requestKey),
  lspControl: (payload) => ipcRenderer.invoke('lsp:control', payload),
  lspStatus: () => ipcRenderer.invoke('lsp:status'),
  onLspStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    return subscribe('lsp:status', listener);
  },
  onLspNotification: (cb) => {
    const listener = (_e, data) => cb(data);
    return subscribe('lsp:notification', listener);
  },
  onLspCache: (cb) => {
    const listener = (_e, data) => cb(data);
    return subscribe('lsp:cache', listener);
  },
  onLspDependencyIndex: (cb) => {
    const listener = (_e, data) => cb(data);
    return subscribe('lsp:dependency-index', listener);
  },

  // Server Projects management
  onOpenServerProjects: (cb) => subscribe('open-server-projects', cb),
  calculateDirSize: (dir) => ipcRenderer.invoke('calculate-dir-size', dir),
  readProjectNames: () => ipcRenderer.invoke('read-project-names'),
  saveProjectName: (key, name) => ipcRenderer.invoke('save-project-name', { key, name }),

  // Server settings
  readServerSettings: () => ipcRenderer.invoke('read-server-settings'),
  writeServerSettings: (settings) => ipcRenderer.invoke('write-server-settings', settings),

  // Rclone operations (Layer 3 → Layer 2 IPC bridge)
  rcloneSync: (payload) => ipcRenderer.invoke('rclone:sync', payload),
  rclonePull: (payload) => ipcRenderer.invoke('rclone:pull', payload),
  rcloneCheckVersion: (rclonePath) => ipcRenderer.invoke('rclone:check-version', rclonePath),
  rcloneFindPath: () => ipcRenderer.invoke('rclone:find-path'),
  onRcloneProgress: (operationId, cb) => {
    // Backward compatibility for callers that do not need operation scoping.
    if (typeof operationId === 'function') {
      cb = operationId;
      operationId = '';
    }
    const listener = (_event, progress) => {
      const payload = progress && typeof progress === 'object'
        ? progress
        : { operationId: '', line: progress };
      // Legacy main processes sent a bare line. Let the renderer accept that
      // only when it can prove a single operation owns the event.
      if (operationId && payload.operationId && payload.operationId !== operationId) return;
      cb(payload.line, payload);
    };
    return subscribe('rclone:progress', listener);
  },
  // Kept for older renderer code. New subscriptions should call their disposer.
  offRcloneProgress: (dispose) => {
    if (typeof dispose === 'function') dispose();
  },
  pickLocalMapping: () => ipcRenderer.invoke('pick-local-mapping'),
  localPathInfo: (path) => ipcRenderer.invoke('local-path-info', path),
	writeTeamMapping: (payload) => ipcRenderer.invoke('write-team-mapping', payload),

  onThemeOpenPicker: (cb) => subscribe('theme-open-picker', cb),
  onMenuSave: (cb) => subscribe('menu-save', cb),

  // Data-only UI language packs
  languagePacksStartup: () => ipcRenderer.invoke('language-packs:startup'),
  languagePacksList: () => ipcRenderer.invoke('language-packs:list'),
  languagePackLoad: (id) => ipcRenderer.invoke('language-packs:load', id),
  languagePackSetActive: (id) => ipcRenderer.invoke('language-packs:set-active', id),
  languagePackInstall: () => ipcRenderer.invoke('language-packs:install-directory'),
  languagePackRemove: (id) => ipcRenderer.invoke('language-packs:remove', id),
  languagePacksOpenFolder: () => ipcRenderer.invoke('language-packs:open-folder'),
  languagePacksRefresh: () => ipcRenderer.invoke('language-packs:refresh'),
  onLanguagePacksChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    return subscribe('language-packs:changed', listener);
  },

  // ──── AI Agent ────
  aiChatRequest: (payload) => ipcRenderer.invoke('ai-chat-request', payload),
  aiCancelStream: () => ipcRenderer.invoke('ai-cancel-stream'),
  aiInlineRequest: (payload) => ipcRenderer.invoke('ai-inline-request', payload),
  aiCancelInline: (requestId) => ipcRenderer.invoke('ai-inline-cancel', requestId),
  aiReadSettings: () => ipcRenderer.invoke('ai-read-settings'),
  aiWriteSettings: (settings) => ipcRenderer.invoke('ai-write-settings', settings),
  aiTestConnection: (payload) => ipcRenderer.invoke('ai-test-connection', payload),
  readFiles: (filePaths) => ipcRenderer.invoke('read-files', filePaths),
  loadChatHistory: (wsRoot) => ipcRenderer.invoke('chat-history-read', wsRoot),
  saveChatHistory: (wsRoot, data) => ipcRenderer.invoke('chat-history-write', { wsRoot, data }),
  onAiChunk: (cb) => subscribePayload('ai-chunk', cb),
  onAiStreamEnd: (cb) => subscribePayload('ai-stream-end', cb),
  onAiStreamError: (cb) => subscribePayload('ai-stream-error', cb),
  onOpenAiSettings: (cb) => subscribe('open-ai-settings', cb),
  onToggleAiChat: (cb) => subscribe('toggle-ai-chat', cb),

  // ──── Diagnostics (red/yellow highlighting) settings ────
  readDiagnosticsSettings: () => ipcRenderer.invoke('diagnostics-read'),
  writeDiagnosticsSettings: (settings) => ipcRenderer.invoke('diagnostics-write', settings),
  onOpenDiagnosticsSettings: (cb) => subscribe('open-diagnostics-settings', cb),

  // ──── Auth credentials (local timed token per server) ────
  authGet: (serverIp) => ipcRenderer.invoke('auth-get', serverIp),
  authSet: (serverIp, credential) => ipcRenderer.invoke('auth-set', { serverIp, credential }),
  authClear: (serverIp) => ipcRenderer.invoke('auth-clear', serverIp),
  // 推送认证状态到主进程（用于动态显示"管理"菜单）：{ loggedIn, role }
  authUpdateState: (state) => ipcRenderer.send('auth-state-update', state),
  onOpenAuthLogin: (cb) => subscribe('open-auth-login', cb),
  onAuthLogoutRequest: (cb) => subscribe('auth-logout-request', cb),
  // 顶部"管理"菜单点击事件：payload { tab: 'users'|'invites'|'audit' }
  onOpenAdminPanel: (cb) => subscribePayload('open-admin-panel', cb)
});
