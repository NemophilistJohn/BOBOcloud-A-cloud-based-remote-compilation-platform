import type { Dispose, Invoke, Subscribe } from './ipc-contracts';
import type {
  DiagnosticsOpenListener,
  DiagnosticsSettingsDto,
  DiagnosticsSettingsWriteDto
} from './diagnostics';
import type {
  ProjectTaskEditorContext,
  ProjectTaskInputValues,
  ProjectTaskResolveResultDto
} from './project-tasks';
import type {
  DocumentCloseResultDto,
  DocumentInfoDto,
  DocumentReadResultDto,
  DocumentViewLocalizationDto,
  LoadedDocumentViewDto
} from './document-view';
import type { LanguagePacksChangedListener } from './i18n';
import type {
  PluginManagementChangedDto,
  PluginMarketplaceSnapshotDto,
  PluginOpenFolderResultDto,
  PluginStatusDto,
  PluginUninstallResultDto
} from './plugin-management';
import type { PluginPermissionDto } from './plugin-runtime';

export interface WorkspaceTextFileWrite {
  readonly content: string;
  readonly [key: string]: unknown;
}

export interface NativeHostPluginDocuments {
  open(pluginId: string, viewerId: string, filePath: string): Promise<DocumentInfoDto>;
  read(documentId: string, offset: number, length: number): Promise<DocumentReadResultDto>;
  close(documentId: string): Promise<DocumentCloseResultDto>;
}

export interface NativeHostPluginMarketplace {
  list(): Promise<PluginMarketplaceSnapshotDto>;
  refresh(): Promise<PluginMarketplaceSnapshotDto>;
  install(id: string): Promise<PluginStatusDto>;
}

export interface NativeHostPlugins {
  list(): Promise<readonly PluginStatusDto[]>;
  get(id: string): Promise<PluginStatusDto | null>;
  install(): Promise<PluginStatusDto | null>;
  enable(id: string): Promise<PluginStatusDto>;
  disable(id: string): Promise<PluginStatusDto>;
  uninstall(id: string): Promise<PluginUninstallResultDto>;
  grant(id: string, permission: PluginPermissionDto): Promise<PluginStatusDto>;
  revoke(id: string, permission: PluginPermissionDto): Promise<PluginStatusDto>;
  refresh(): Promise<readonly PluginStatusDto[]>;
  openFolder(): Promise<PluginOpenFolderResultDto>;
  runtimeDescriptors(): Promise<unknown>;
  loadEntry(id: string): Promise<unknown>;
  loadLocalization(id: string, locale: string): Promise<DocumentViewLocalizationDto>;
  loadDocumentView(pluginId: string, viewerId: string): Promise<LoadedDocumentViewDto>;
  readonly documents: NativeHostPluginDocuments;
  readonly marketplace: NativeHostPluginMarketplace;
  rpc(pluginId: string, method: string, args: unknown): Promise<unknown>;
  onAgentModelEvent: Subscribe<'plugins:agent-model-event'>;
  onChanged(listener: (payload: PluginManagementChangedDto) => void): Dispose;
}

export interface RcloneProgressPayload {
  readonly operationId?: string;
  readonly line?: unknown;
  readonly [key: string]: unknown;
}

export type RcloneProgressListener = (line: unknown, payload: RcloneProgressPayload) => void;

export interface RcloneNativeHost {
  rclonePrepareRemote(payload: unknown): Promise<unknown>;
  rcloneSync(payload: unknown): Promise<unknown>;
  rclonePull(payload: unknown): Promise<unknown>;
  rcloneCancel(operationId: string): Promise<unknown>;
  rcloneCancelAll(reason: unknown): Promise<unknown>;
  rcloneListBinaries(): Promise<unknown>;
  rcloneGetSelection(): Promise<unknown>;
  rcloneSelectBinary(payload: unknown): Promise<unknown>;
  rcloneCheckVersion(): Promise<unknown>;
  rcloneValidateConnection(): Promise<unknown>;
  onRcloneProgress(operationId: string, listener: RcloneProgressListener): Dispose;
}

/**
 * Trusted renderer view of the preload bridge.
 *
 * This interface mirrors the complete compatibility bridge. Feature modules
 * should depend on narrower domain services supplied by the renderer host
 * adapter rather than accepting NativeHost directly.
 */
export interface NativeHost {
  pickWorkspace: Invoke<'pick-workspace'>;
  forgetRecentWorkspace: Invoke<'forget-recent-workspace'>;
  closeWorkspace: Invoke<'close-workspace'>;
  readTree: Invoke<'read-tree'>;
  onWorkspaceOpened: Subscribe<'workspace-opened'>;
  onWorkspaceRefresh: Subscribe<'workspace-refresh'>;
  onWorkspaceLeaveRequest: Subscribe<'workspace-leave-request'>;
  onWorkspaceLeaveAborted: Subscribe<'workspace-leave-aborted'>;
  respondWorkspaceLeave(requestId: unknown, allowed: boolean): void;
  chooseWorkspaceLeave: Invoke<'workspace-leave-choice'>;
  getWorkspaceIdentity: Invoke<'workspace-identity'>;
  readWorkspaceSettings: Invoke<'workspace-settings-read'>;
  onWorkspaceSettingsChanged: Subscribe<'workspace-settings-changed'>;
  workspaceSwitchApplied: Invoke<'workspace-switch-applied'>;
  rejectWorkspaceSwitch: Invoke<'workspace-switch-reject'>;
  setArtifactRunContext: Invoke<'artifact-run-context'>;
  tasksList: Invoke<'tasks:list'>;
  tasksResolve(
    label: string,
    context: ProjectTaskEditorContext,
    inputs?: ProjectTaskInputValues
  ): Promise<ProjectTaskResolveResultDto>;

  dapConfigurations: Invoke<'dap:configurations'>;
  dapResolve(id: string, context: unknown): Promise<unknown>;
  dapEnsureConfiguration: Invoke<'dap:ensure-configuration'>;
  dapStart: Invoke<'dap:start'>;
  dapRequest(command: string, args: unknown, timeoutMs?: number): Promise<unknown>;
  dapRespond(request: unknown, success: boolean, body: unknown, message?: string): Promise<unknown>;
  dapStop: Invoke<'dap:stop'>;
  dapStatus: Invoke<'dap:status'>;
  onDapMessage: Subscribe<'dap:message'>;
  onDapStatus: Subscribe<'dap:status'>;

  terminalStart: Invoke<'terminal:start'>;
  terminalWrite: Invoke<'terminal:write'>;
  terminalResize: Invoke<'terminal:resize'>;
  terminalPackageIntentDecision: Invoke<'terminal:package-intent-decision'>;
  terminalStop: Invoke<'terminal:stop'>;
  terminalStatus: Invoke<'terminal:status'>;
  onTerminalOutput: Subscribe<'terminal:output'>;
  onTerminalStatus: Subscribe<'terminal:status'>;
  onTerminalPackageIntent: Subscribe<'terminal:package-intent'>;
  onTerminalPackageIntentRejected: Subscribe<'terminal:package-intent-rejected'>;
  onFileEvent: Subscribe<'file-event'>;
  refreshWorkspace: Invoke<'refresh-workspace'>;

  readFile: Invoke<'read-file'>;
  saveFile(payload: WorkspaceTextFileWrite): Promise<unknown>;
  saveBinaryFile: Invoke<'save-binary-file'>;
  saveArtifact: Invoke<'save-artifact'>;

  packageCenterApplyLocalChanges: Invoke<'package-center:apply-local-changes'>;
  packageCenterRollbackLocalChanges: Invoke<'package-center:rollback-local-changes'>;
  packageCenterCommitLocalChanges: Invoke<'package-center:commit-local-changes'>;
  packageCenterListPendingRecoveries: Invoke<'package-center:list-pending-recoveries'>;
  packageCenterResolvePendingRecovery: Invoke<'package-center:resolve-pending-recovery'>;
  onPackageCenterLocalTransaction: Subscribe<'package-center:local-transaction'>;

  createFile: Invoke<'create-file'>;
  createFolder: Invoke<'create-folder'>;
  renameEntry: Invoke<'rename-entry'>;
  deleteEntry: Invoke<'delete-entry'>;
  onOpenServerSettings: Subscribe<'open-server-settings'>;

  lspSettingsRead: Invoke<'lsp:settings-read'>;
  lspSettingsWrite: Invoke<'lsp:settings-write'>;
  lspClientCacheGet: Invoke<'lsp:client-cache-get'>;
  lspClientCachePut: Invoke<'lsp:client-cache-put'>;
  lspClientCacheStats: Invoke<'lsp:client-cache-stats'>;
  lspClientCacheClear: Invoke<'lsp:client-cache-clear'>;
  lspClientCachePrune(force?: boolean): Promise<unknown>;
  lspClientCacheDependencyIndexGet: Invoke<'lsp:client-cache-dependency-index-get'>;
  lspClientCacheDependencyIndexPut: Invoke<'lsp:client-cache-dependency-index-put'>;
  lspClientCacheDependencyIndexClear: Invoke<'lsp:client-cache-dependency-index-clear'>;
  lspConfigure: Invoke<'lsp:configure'>;
  lspRequest: Invoke<'lsp:request'>;
  lspNotify: Invoke<'lsp:notify'>;
  lspCancel: Invoke<'lsp:cancel'>;
  lspControl: Invoke<'lsp:control'>;
  lspStatus: Invoke<'lsp:status'>;
  onLspStatus: Subscribe<'lsp:status'>;
  onLspNotification: Subscribe<'lsp:notification'>;
  onLspCache: Subscribe<'lsp:cache'>;
  onLspDependencyIndex: Subscribe<'lsp:dependency-index'>;

  onOpenServerProjects: Subscribe<'open-server-projects'>;
  readProjectNames: Invoke<'read-project-names'>;
  saveProjectName(key: string, name: string): Promise<unknown>;
  readServerSettings: Invoke<'read-server-settings'>;
  writeServerSettings: Invoke<'write-server-settings'>;
  commitServerSettings(): Promise<unknown>;
  rollbackServerSettings(): Promise<unknown>;

  rclonePrepareRemote: Invoke<'rclone:prepare-remote'>;
  rcloneSync: Invoke<'rclone:sync'>;
  rclonePull: Invoke<'rclone:pull'>;
  rcloneCancel(operationId: string): Promise<unknown>;
  rcloneCancelAll(reason: unknown): Promise<unknown>;
  rcloneListBinaries: Invoke<'rclone:list-binaries'>;
  rcloneGetSelection: Invoke<'rclone:get-selection'>;
  rcloneSelectBinary: Invoke<'rclone:select-binary'>;
  rcloneCheckVersion: Invoke<'rclone:check-version'>;
  rcloneValidateConnection: Invoke<'rclone:validate-connection'>;
  onRcloneProgress(listener: RcloneProgressListener): Dispose;
  onRcloneProgress(operationId: string, listener: RcloneProgressListener): Dispose;
  offRcloneProgress(dispose?: Dispose): void;
  pickLocalMapping: Invoke<'pick-local-mapping'>;
  localPathInfo(path: string, grantId?: string): Promise<unknown>;
  writeTeamMapping: Invoke<'write-team-mapping'>;

  onThemeOpenPicker: Subscribe<'theme-open-picker'>;
  onMenuSave: Subscribe<'menu-save'>;
  languagePacksStartup: Invoke<'language-packs:startup'>;
  languagePacksList: Invoke<'language-packs:list'>;
  languagePackLoad: Invoke<'language-packs:load'>;
  languagePackSetActive: Invoke<'language-packs:set-active'>;
  languagePackInstall: Invoke<'language-packs:install-directory'>;
  languagePackRemove: Invoke<'language-packs:remove'>;
  languagePacksOpenFolder: Invoke<'language-packs:open-folder'>;
  languagePacksRefresh: Invoke<'language-packs:refresh'>;
  onLanguagePacksChanged(listener: LanguagePacksChangedListener): Dispose;

  readonly plugins: NativeHostPlugins;
  onOpenPluginManager: Subscribe<'open-plugin-manager'>;
  pluginsAgentApprovalDescribe: Invoke<'plugins:agent-approval-describe'>;
  pluginsAgentApprovalDecide: Invoke<'plugins:agent-approval-decide'>;
  pluginsAgentApprovalCancel: Invoke<'plugins:agent-approval-cancel'>;
  agentAccessGet: Invoke<'plugins:agent-access-get'>;
  agentAccessSet: Invoke<'plugins:agent-access-set'>;
  agentAccessClear: Invoke<'plugins:agent-access-clear'>;

  aiChatRequest: Invoke<'ai-chat-request'>;
  aiCancelStream: Invoke<'ai-cancel-stream'>;
  aiInlineRequest: Invoke<'ai-inline-request'>;
  aiCancelInline: Invoke<'ai-inline-cancel'>;
  aiReadSettings: Invoke<'ai-read-settings'>;
  aiWriteSettings: Invoke<'ai-write-settings'>;
  aiTestConnection: Invoke<'ai-test-connection'>;
  readFiles(filePaths: readonly string[]): Promise<unknown>;
  loadChatHistory(workspaceRoot: unknown): Promise<unknown>;
  saveChatHistory(workspaceRoot: unknown, data: unknown): Promise<unknown>;
  onAiChunk: Subscribe<'ai-chunk'>;
  onAiStreamEnd: Subscribe<'ai-stream-end'>;
  onAiStreamError: Subscribe<'ai-stream-error'>;
  onOpenAiSettings: Subscribe<'open-ai-settings'>;
  onToggleAiChat: Subscribe<'toggle-ai-chat'>;

  readDiagnosticsSettings(): Promise<DiagnosticsSettingsDto>;
  writeDiagnosticsSettings(settings: DiagnosticsSettingsWriteDto): Promise<boolean>;
  onOpenDiagnosticsSettings(listener: DiagnosticsOpenListener): Dispose;

  authGet: Invoke<'auth-get'>;
  authSet(credential: unknown): Promise<unknown>;
  authClear: Invoke<'auth-clear'>;
  authUpdateState(state: unknown): void;
  onOpenAuthLogin: Subscribe<'open-auth-login'>;
  onAuthLogoutRequest: Subscribe<'auth-logout-request'>;
  onOpenAdminPanel: Subscribe<'open-admin-panel'>;
}
