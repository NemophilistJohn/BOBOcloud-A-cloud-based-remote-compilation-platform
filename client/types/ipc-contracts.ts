/**
 * Compile-time inventory of the channels exposed by client/preload.js.
 *
 * Payloads remain unknown until their owning domain is migrated and can supply
 * a validated DTO. Channel names and argument arity are still locked here so a
 * bridge change cannot silently bypass the renderer contract gate.
 */

import type { Dispose } from './lifecycle';
import type { DiagnosticsSettingsDto, DiagnosticsSettingsWriteDto } from './diagnostics';
import type {
  ProjectTaskConfigurationDto,
  ProjectTaskResolveRequestDto,
  ProjectTaskResolveResultDto,
  ProjectTasksFileEvent,
  ProjectTasksWorkspaceOpenedEvent
} from './project-tasks';
import type {
  DocumentCloseResultDto,
  DocumentInfoDto,
  DocumentReadResultDto,
  DocumentViewLocalizationDto,
  LoadedDocumentViewDto
} from './document-view';
import type {
  LanguagePackDto,
  LanguagePackInstallResultDto,
  LanguagePackOpenFolderResultDto,
  LanguagePacksChangedDto,
  LanguagePacksListDto,
  LanguagePacksStartupDto
} from './i18n';

export type { Dispose } from './lifecycle';

export interface IpcInvokeContract<Args extends unknown[] = [], Result = unknown> {
  readonly args: Args;
  readonly result: Result;
}

export interface IpcEventContract<Args extends unknown[] = []> {
  readonly args: Args;
}

export interface IpcInvokeContracts {
  'pick-workspace': IpcInvokeContract<[dirPath?: string]>;
  'forget-recent-workspace': IpcInvokeContract<[dirPath: string]>;
  'close-workspace': IpcInvokeContract;
  'read-tree': IpcInvokeContract<[path: string]>;
  'workspace-leave-choice': IpcInvokeContract<[details: unknown]>;
  'workspace-identity': IpcInvokeContract;
  'workspace-settings-read': IpcInvokeContract<[identity: unknown]>;
  'workspace-switch-applied': IpcInvokeContract<[details: unknown]>;
  'workspace-switch-reject': IpcInvokeContract<[details: unknown]>;
  'artifact-run-context': IpcInvokeContract<[context: unknown]>;
  'tasks:list': IpcInvokeContract<[], ProjectTaskConfigurationDto>;
  'tasks:resolve': IpcInvokeContract<[request: ProjectTaskResolveRequestDto], ProjectTaskResolveResultDto>;
  'dap:configurations': IpcInvokeContract;
  'dap:resolve': IpcInvokeContract<[request: unknown]>;
  'dap:ensure-configuration': IpcInvokeContract;
  'dap:start': IpcInvokeContract<[payload: unknown]>;
  'dap:request': IpcInvokeContract<[payload: unknown]>;
  'dap:respond': IpcInvokeContract<[payload: unknown]>;
  'dap:stop': IpcInvokeContract<[reason: unknown]>;
  'dap:status': IpcInvokeContract;
  'terminal:start': IpcInvokeContract<[payload: unknown]>;
  'terminal:write': IpcInvokeContract<[data: unknown]>;
  'terminal:resize': IpcInvokeContract<[payload: unknown]>;
  'terminal:package-intent-decision': IpcInvokeContract<[payload: unknown]>;
  'terminal:stop': IpcInvokeContract<[reason: unknown]>;
  'terminal:status': IpcInvokeContract;
  'refresh-workspace': IpcInvokeContract;
  'read-file': IpcInvokeContract<[filePath: string]>;
  'save-file': IpcInvokeContract<[payload: unknown]>;
  'save-binary-file': IpcInvokeContract<[payload: unknown]>;
  'save-artifact': IpcInvokeContract<[payload: unknown]>;
  'package-center:apply-local-changes': IpcInvokeContract<[payload: unknown]>;
  'package-center:rollback-local-changes': IpcInvokeContract<[payload: unknown]>;
  'package-center:commit-local-changes': IpcInvokeContract<[payload: unknown]>;
  'package-center:list-pending-recoveries': IpcInvokeContract<[payload: unknown]>;
  'package-center:resolve-pending-recovery': IpcInvokeContract<[payload: unknown]>;
  'create-file': IpcInvokeContract<[payload: unknown]>;
  'create-folder': IpcInvokeContract<[payload: unknown]>;
  'rename-entry': IpcInvokeContract<[payload: unknown]>;
  'delete-entry': IpcInvokeContract<[payload: unknown]>;
  'lsp:settings-read': IpcInvokeContract;
  'lsp:settings-write': IpcInvokeContract<[settings: unknown]>;
  'lsp:client-cache-get': IpcInvokeContract<[scope: unknown, key: unknown]>;
  'lsp:client-cache-put': IpcInvokeContract<[scope: unknown, key: unknown, value: unknown]>;
  'lsp:client-cache-stats': IpcInvokeContract<[scope: unknown]>;
  'lsp:client-cache-clear': IpcInvokeContract<[request: unknown]>;
  'lsp:client-cache-prune': IpcInvokeContract<[force: boolean]>;
  'lsp:client-cache-dependency-index-get': IpcInvokeContract<[scope: unknown, key: unknown]>;
  'lsp:client-cache-dependency-index-put': IpcInvokeContract<[scope: unknown, key: unknown, value: unknown]>;
  'lsp:client-cache-dependency-index-clear': IpcInvokeContract<[request: unknown]>;
  'lsp:configure': IpcInvokeContract<[config: unknown]>;
  'lsp:request': IpcInvokeContract<[payload: unknown]>;
  'lsp:notify': IpcInvokeContract<[payload: unknown]>;
  'lsp:cancel': IpcInvokeContract<[requestKey: unknown]>;
  'lsp:control': IpcInvokeContract<[payload: unknown]>;
  'lsp:status': IpcInvokeContract;
  'read-project-names': IpcInvokeContract;
  'save-project-name': IpcInvokeContract<[request: unknown]>;
  'read-server-settings': IpcInvokeContract;
  'write-server-settings': IpcInvokeContract<[settings: unknown]>;
  'rclone:prepare-remote': IpcInvokeContract<[payload: unknown]>;
  'rclone:sync': IpcInvokeContract<[payload: unknown]>;
  'rclone:pull': IpcInvokeContract<[payload: unknown]>;
  'rclone:cancel': IpcInvokeContract<[request: unknown]>;
  'rclone:cancel-all': IpcInvokeContract<[request: unknown]>;
  'rclone:list-binaries': IpcInvokeContract;
  'rclone:get-selection': IpcInvokeContract;
  'rclone:select-binary': IpcInvokeContract<[payload: unknown]>;
  'rclone:check-version': IpcInvokeContract;
  'rclone:validate-connection': IpcInvokeContract;
  'pick-local-mapping': IpcInvokeContract;
  'local-path-info': IpcInvokeContract<[request: unknown]>;
  'write-team-mapping': IpcInvokeContract<[payload: unknown]>;
  'language-packs:startup': IpcInvokeContract<[], LanguagePacksStartupDto>;
  'language-packs:list': IpcInvokeContract<[], LanguagePacksListDto>;
  'language-packs:load': IpcInvokeContract<[id: string], LanguagePackDto>;
  'language-packs:set-active': IpcInvokeContract<[id: string], LanguagePacksStartupDto>;
  'language-packs:install-directory': IpcInvokeContract<[], LanguagePackInstallResultDto>;
  'language-packs:remove': IpcInvokeContract<[id: string], LanguagePacksStartupDto>;
  'language-packs:open-folder': IpcInvokeContract<[], LanguagePackOpenFolderResultDto>;
  'language-packs:refresh': IpcInvokeContract<[], LanguagePacksStartupDto>;
  'plugins:list': IpcInvokeContract;
  'plugins:get': IpcInvokeContract<[id: string]>;
  'plugins:install': IpcInvokeContract;
  'plugins:enable': IpcInvokeContract<[id: string]>;
  'plugins:disable': IpcInvokeContract<[id: string]>;
  'plugins:uninstall': IpcInvokeContract<[id: string]>;
  'plugins:grant': IpcInvokeContract<[request: unknown]>;
  'plugins:revoke': IpcInvokeContract<[request: unknown]>;
  'plugins:refresh': IpcInvokeContract;
  'plugins:open-folder': IpcInvokeContract;
  'plugins:runtime-descriptors': IpcInvokeContract;
  'plugins:load-entry': IpcInvokeContract<[id: string]>;
  'plugins:load-localization': IpcInvokeContract<[
    request: { readonly id: string; readonly locale: string }
  ], DocumentViewLocalizationDto>;
  'plugins:load-document-view': IpcInvokeContract<[
    request: { readonly pluginId: string; readonly viewerId: string }
  ], LoadedDocumentViewDto>;
  'plugins:document-open': IpcInvokeContract<[
    request: { readonly pluginId: string; readonly viewerId: string; readonly filePath: string }
  ], DocumentInfoDto>;
  'plugins:document-read': IpcInvokeContract<[
    request: { readonly documentId: string; readonly offset: number; readonly length: number }
  ], DocumentReadResultDto>;
  'plugins:document-close': IpcInvokeContract<[
    request: { readonly documentId: string }
  ], DocumentCloseResultDto>;
  'plugins:marketplace-list': IpcInvokeContract;
  'plugins:marketplace-refresh': IpcInvokeContract;
  'plugins:marketplace-install': IpcInvokeContract<[request: unknown]>;
  'plugins:rpc': IpcInvokeContract<[request: unknown]>;
  'plugins:agent-approval-describe': IpcInvokeContract<[payload: unknown]>;
  'plugins:agent-approval-decide': IpcInvokeContract<[payload: unknown]>;
  'plugins:agent-approval-cancel': IpcInvokeContract<[payload: unknown]>;
  'plugins:agent-access-get': IpcInvokeContract<[payload: unknown]>;
  'plugins:agent-access-set': IpcInvokeContract<[payload: unknown]>;
  'plugins:agent-access-clear': IpcInvokeContract<[payload: unknown]>;
  'ai-chat-request': IpcInvokeContract<[payload: unknown]>;
  'ai-cancel-stream': IpcInvokeContract;
  'ai-inline-request': IpcInvokeContract<[payload: unknown]>;
  'ai-inline-cancel': IpcInvokeContract<[requestId: unknown]>;
  'ai-read-settings': IpcInvokeContract;
  'ai-write-settings': IpcInvokeContract<[settings: unknown]>;
  'ai-test-connection': IpcInvokeContract<[payload: unknown]>;
  'read-files': IpcInvokeContract<[filePaths: unknown]>;
  'chat-history-read': IpcInvokeContract<[workspaceRoot: unknown]>;
  'chat-history-write': IpcInvokeContract<[request: unknown]>;
  'diagnostics-read': IpcInvokeContract<[], DiagnosticsSettingsDto>;
  'diagnostics-write': IpcInvokeContract<[settings: DiagnosticsSettingsWriteDto], boolean>;
  'auth-get': IpcInvokeContract;
  'auth-set': IpcInvokeContract<[request: unknown]>;
  'auth-clear': IpcInvokeContract;
}

export interface IpcSendContracts {
  'workspace-leave-response': IpcEventContract<[response: unknown]>;
  'auth-state-update': IpcEventContract<[state: unknown]>;
}

export interface IpcEventContracts {
  'workspace-opened': IpcEventContract<[payload: ProjectTasksWorkspaceOpenedEvent]>;
  'workspace-refresh': IpcEventContract<[payload: unknown]>;
  'workspace-leave-request': IpcEventContract<[payload: unknown]>;
  'workspace-leave-aborted': IpcEventContract<[payload: unknown]>;
  'workspace-settings-changed': IpcEventContract<[payload: unknown]>;
  'dap:message': IpcEventContract<[payload: unknown]>;
  'dap:status': IpcEventContract<[payload: unknown]>;
  'terminal:output': IpcEventContract<[payload: unknown]>;
  'terminal:status': IpcEventContract<[payload: unknown]>;
  'terminal:package-intent': IpcEventContract<[payload: unknown]>;
  'terminal:package-intent-rejected': IpcEventContract<[payload: unknown]>;
  'file-event': IpcEventContract<[payload: ProjectTasksFileEvent]>;
  'package-center:local-transaction': IpcEventContract<[payload: unknown]>;
  'open-server-settings': IpcEventContract;
  'lsp:status': IpcEventContract<[payload: unknown]>;
  'lsp:notification': IpcEventContract<[payload: unknown]>;
  'lsp:cache': IpcEventContract<[payload: unknown]>;
  'lsp:dependency-index': IpcEventContract<[payload: unknown]>;
  'open-server-projects': IpcEventContract;
  'rclone:progress': IpcEventContract<[payload: unknown]>;
  'theme-open-picker': IpcEventContract;
  'menu-save': IpcEventContract;
  'language-packs:changed': IpcEventContract<[payload: LanguagePacksChangedDto]>;
  'plugins:agent-model-event': IpcEventContract<[payload: unknown]>;
  'plugins:changed': IpcEventContract<[payload: unknown]>;
  'open-plugin-manager': IpcEventContract;
  'ai-chunk': IpcEventContract<[payload: unknown]>;
  'ai-stream-end': IpcEventContract<[payload: unknown]>;
  'ai-stream-error': IpcEventContract<[payload: unknown]>;
  'open-ai-settings': IpcEventContract;
  'toggle-ai-chat': IpcEventContract;
  'open-diagnostics-settings': IpcEventContract;
  'open-auth-login': IpcEventContract;
  'auth-logout-request': IpcEventContract;
  'open-admin-panel': IpcEventContract<[payload: unknown]>;
}

export type IpcInvokeChannel = keyof IpcInvokeContracts;
export type IpcSendChannel = keyof IpcSendContracts;
export type IpcEventChannel = keyof IpcEventContracts;

export type IpcInvokeArgs<Channel extends IpcInvokeChannel> = IpcInvokeContracts[Channel]['args'];
export type IpcInvokeResult<Channel extends IpcInvokeChannel> = IpcInvokeContracts[Channel]['result'];
export type IpcSendArgs<Channel extends IpcSendChannel> = IpcSendContracts[Channel]['args'];
export type IpcEventArgs<Channel extends IpcEventChannel> = IpcEventContracts[Channel]['args'];

export type Invoke<Channel extends IpcInvokeChannel> = (
  ...args: IpcInvokeArgs<Channel>
) => Promise<IpcInvokeResult<Channel>>;

export type Send<Channel extends IpcSendChannel> = (
  ...args: IpcSendArgs<Channel>
) => void;

export type Subscribe<Channel extends IpcEventChannel> = (
  listener: (...args: IpcEventArgs<Channel>) => void
) => Dispose;
