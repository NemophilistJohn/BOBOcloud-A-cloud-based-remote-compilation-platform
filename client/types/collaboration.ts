import type { ConfirmFacade } from './confirm-dialog';
import type { Disposable, Dispose } from './lifecycle';

/** Stable ids used by the private collaboration service registrations. */
export type CollaborationServiceId = 'workbench.collaboration';
export type CollaborationHostServiceId = 'host.collaboration';

/** Server error codes with first-class renderer copy and recovery actions. */
export type CollaborationErrorCodeDto =
  | 'push_conflict'
  | 'push_failed'
  | 'merge_conflict'
  | 'no_changes'
  | 'lock_held'
  | 'lock_stale'
  | 'lease_expired'
  | 'invalid_server_response'
  | 'transport_timeout'
  | 'transport_cancelled'
  | (string & {});

export type CollaborationSuggestedActionDto =
  | 'retry_commit'
  | 'resolve_conflicts'
  | 'edit_files'
  | 'wait_for_lock'
  | 'refresh_lock'
  | (string & {});

/**
 * Details attached to a structured collaboration operation failure.  The
 * server may add fields as its git diagnostics evolve, so the open index is
 * intentional at this trust boundary.
 */
export interface CollaborationErrorDetailsDto {
  readonly retryable?: boolean;
  readonly suggestedAction?: CollaborationSuggestedActionDto;
  readonly pendingCommit?: string;
  readonly conflictCount?: number;
  readonly lock?: CollaborationFileLockDto | null;
  readonly [key: string]: unknown;
}

export interface CollaborationOperationErrorDto {
  readonly code?: CollaborationErrorCodeDto;
  readonly message: string;
  readonly rawMessage?: string;
  readonly details?: CollaborationErrorDetailsDto;
  readonly status?: number;
}

/** The wire envelope returned by BOBO.sendToServer for an action. */
export interface CollaborationServerResponseEnvelopeDto<Data = unknown> {
  readonly success?: boolean;
  readonly data?: Data;
  readonly error?: string;
  readonly errorCode?: CollaborationErrorCodeDto;
  readonly details?: CollaborationErrorDetailsDto;
  readonly status?: number;
  readonly message?: string;
  readonly [key: string]: unknown;
}

/* ------------------------------------------------------------------------- *
 * Collaboration domain DTOs.  Names retain the snake_case wire fields used
 * by the existing server and renderer.  Optional aliases are accepted where
 * older clients/preload bridges emitted camelCase values.
 * ------------------------------------------------------------------------- */

export interface CollaborationTeamDto {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly admin_user_id: string;
  readonly avatar?: string;
  readonly cache_quota_mb: number;
  readonly cache_retention_days: number;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationTeamViewDto extends CollaborationTeamDto {
  readonly is_admin: boolean;
  readonly member_count: number;
  readonly project_count: number;
}

export interface CollaborationMemberViewDto {
  readonly user_id: string;
  readonly uid: string;
  readonly username: string;
  readonly name: string;
  readonly avatar?: string;
  readonly is_admin: boolean;
  readonly joined_at?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationInviteDto {
  readonly code: string;
  readonly team_id: string;
  readonly created_by: string;
  readonly created_at?: string;
  readonly expires_at: string;
  readonly max_uses: number;
  readonly used_count: number;
  readonly revoked: boolean;
  readonly [key: string]: unknown;
}

export interface CollaborationProjectDto {
  readonly id: string;
  readonly team_id: string;
  readonly name: string;
  readonly description?: string;
  readonly default_branch: string;
  readonly created_by?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  /** Convenience fields returned by some older list endpoints. */
  readonly team_name?: string;
  readonly branch?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationTeamDetailDto {
  readonly team: CollaborationTeamDto;
  readonly members: readonly CollaborationMemberViewDto[];
  readonly projects: readonly CollaborationProjectDto[];
}

export interface CollaborationFileLockDto {
  readonly team_id: string;
  readonly project_id: string;
  readonly branch: string;
  readonly path: string;
  readonly user_id?: string;
  readonly user_uid?: string;
  readonly user_name?: string;
  readonly lease_id?: string;
  readonly expires_at?: string;
  /** Compatibility aliases accepted from older preload/server versions. */
  readonly teamId?: string;
  readonly projectId?: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly leaseId?: string;
  readonly expiresAt?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationBranchDto {
  readonly name: string;
  readonly commit?: string;
  readonly subject?: string;
  readonly author?: string;
  readonly committed_at?: string;
  readonly is_default?: boolean;
  readonly [key: string]: unknown;
}

export interface CollaborationCommitDto {
  readonly id: string;
  readonly parents: readonly string[];
  readonly refs?: string;
  readonly author?: string;
  readonly author_uid?: string;
  readonly message: string;
  readonly created_at?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationWorktreeDto {
  readonly team_id: string;
  readonly project_id: string;
  readonly project_name?: string;
  readonly branch: string;
  readonly remote_path?: string;
  readonly dirty: boolean;
  readonly conflicts?: readonly string[];
  readonly head?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationDiffDto {
  readonly from: string;
  readonly to: string;
  readonly stats: string;
  readonly patch: string;
  readonly truncated: boolean;
  readonly [key: string]: unknown;
}

export interface CollaborationConflictFileDto {
  readonly path: string;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  readonly [key: string]: unknown;
}

export interface CollaborationCacheNamespaceDto {
  readonly project_id?: string;
  readonly branch: string;
  readonly runtime: string;
  readonly language: string;
  readonly size_bytes: number;
  readonly last_used?: string;
  readonly active: boolean;
  readonly key: string;
  readonly [key: string]: unknown;
}

export interface CollaborationCacheInfoDto {
  readonly team_id?: string;
  readonly quota_bytes: number;
  readonly total_bytes: number;
  readonly shared_bytes: number;
  readonly target_bytes: number;
  readonly dependency_bytes?: number;
  readonly scratch_bytes?: number;
  readonly namespaces: readonly CollaborationCacheNamespaceDto[];
  readonly dependencies?: readonly CollaborationCacheNamespaceDto[];
  readonly [key: string]: unknown;
}

export interface CollaborationTeamMappingDto {
  readonly version: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly branch: string;
  readonly localPath: string;
}

/** Active renderer context; unlike the persisted marker, `version` is not
 * required because the legacy in-memory object predates the marker schema. */
export interface CollaborationCurrentProjectDto
  extends Omit<CollaborationTeamMappingDto, 'version'> {
  readonly version?: number;
}

export interface CollaborationStateDto {
  teams: CollaborationTeamViewDto[];
  current: CollaborationCurrentProjectDto | null;
  locks: CollaborationFileLockDto[];
  modalOpen: boolean;
  readonly [key: string]: unknown;
}

export interface CollaborationUserDto {
  readonly id?: string;
  readonly uid?: string;
  readonly username?: string;
  readonly name?: string;
  readonly avatar?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationAuthStateDto {
  token?: string;
  user: CollaborationUserDto | null;
  readonly [key: string]: unknown;
}

export interface CollaborationTabDto {
  readonly path?: string | null;
  readonly name?: string;
  readonly model?: CollaborationTextModelPort | null;
  readonly dirty?: boolean;
  readonly language?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationRendererState {
  workspaceRoot: string | null;
  workspaceTransitionLocked: boolean;
  activeTabPath: string | null;
  activePanel: string;
  tabs: CollaborationTabDto[];
  serverSettings: { readonly ip?: string; readonly [key: string]: unknown };
  auth: CollaborationAuthStateDto;
  collaboration: CollaborationStateDto;
  editor?: CollaborationEditorPort | null;
  splitEditor?: CollaborationSplitEditorPort | null;
  readonly [key: string]: unknown;
}

/* ------------------------------------------------------------------------- *
 * Server action DTOs.  Keep this map aligned with the collaboration switch in
 * server/internal/handler/collab_handlers.go; adding an action is a contract
 * change rather than an untyped string scattered through the UI.
 * ------------------------------------------------------------------------- */

export interface CollaborationServerRequestMap {
  readonly createTeam: Readonly<{ name: string; description: string; cacheQuotaMB: number }>;
  readonly listTeams: Record<string, never>;
  readonly getTeam: Readonly<{ teamId: string }>;
  readonly updateTeam: Readonly<{
    teamId: string;
    name: string;
    description: string;
    cacheQuotaMB: number;
    cacheRetentionDays: number;
  }>;
  readonly deleteTeam: Readonly<{ teamId: string }>;
  readonly createTeamInvite: Readonly<{ teamId: string; maxUses: number; expiresInHours: number }>;
  readonly listTeamInvites: Readonly<{ teamId: string }>;
  readonly revokeTeamInvite: Readonly<{ teamId: string; inviteCode: string }>;
  readonly deleteTeamInvite: Readonly<{ teamId: string; inviteCode: string }>;
  readonly joinTeam: Readonly<{ inviteCode: string }>;
  readonly leaveTeam: Readonly<{ teamId: string }>;
  readonly removeTeamMember: Readonly<{ teamId: string; userId: string }>;
  readonly createTeamProject: Readonly<{ teamId: string; name: string; description: string }>;
  readonly listTeamProjects: Readonly<{ teamId: string }>;
  readonly deleteTeamProject: Readonly<{ teamId: string; projectId: string }>;
  readonly prepareTeamProject: Readonly<{
    teamId: string;
    projectId: string;
    branch: string;
    pull?: boolean;
    reset?: boolean;
  }>;
  readonly listTeamBranches: Readonly<{ teamId: string; projectId: string }>;
  readonly createTeamBranch: Readonly<{
    teamId: string;
    projectId: string;
    branch: string;
    sourceBranch: string;
  }>;
  readonly teamProjectHistory: Readonly<{ teamId: string; projectId: string; limit: number }>;
  readonly commitTeamChanges: Readonly<{
    teamId: string;
    projectId: string;
    branch: string;
    commitMessage: string;
  }>;
  readonly compareTeamBranches: Readonly<{
    teamId: string;
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
  }>;
  readonly mergeTeamBranch: Readonly<{
    teamId: string;
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
  }>;
  readonly listTeamConflicts: Readonly<{ teamId: string; projectId: string; branch: string }>;
  readonly resolveTeamConflict: Readonly<{
    teamId: string;
    projectId: string;
    branch: string;
    filePath: string;
    content: string;
  }>;
  readonly completeTeamMerge: Readonly<{
    teamId: string;
    projectId: string;
    branch: string;
    commitMessage: string;
  }>;
  readonly acquireTeamFileLock: Readonly<{
    teamId: string;
    projectId: string;
    branch: string;
    filePath: string;
    lockLeaseId?: string;
    ttlMinutes: number;
  }>;
  readonly releaseTeamFileLock: Readonly<{
    teamId: string;
    projectId: string;
    branch: string;
    filePath: string;
    lockLeaseId?: string;
  }>;
  readonly listTeamFileLocks: Readonly<{ teamId: string; projectId: string }>;
  readonly getTeamCacheInfo: Readonly<{ teamId: string }>;
  readonly clearTeamCache: Readonly<{
    teamId: string;
    cacheScope: CollaborationCacheScopeDto;
    namespaceKey?: string;
    projectId?: string;
  }>;
  /** Used by the profile fallback when account-profile is not installed. */
  readonly updateProfile: Readonly<{ name: string; avatar: string }>;
}

export type CollaborationCacheScopeDto = 'namespace' | 'shared' | 'all' | (string & {});

export interface CollaborationDeleteResultDto {
  readonly deleted: boolean;
}

export interface CollaborationInviteActionResultDto {
  readonly revoked?: boolean;
  readonly deleted?: boolean;
}

export interface CollaborationMembershipActionResultDto {
  readonly left?: boolean;
  readonly removed?: boolean;
}

export interface CollaborationBranchActionResultDto {
  readonly branch: string;
}

export interface CollaborationConflictActionResultDto {
  readonly resolved: string;
}

export interface CollaborationReleaseLockResultDto {
  readonly released: boolean;
}

export interface CollaborationProfileResponseDataDto {
  readonly user?: CollaborationUserDto | null;
  readonly [key: string]: unknown;
}

export interface CollaborationServerResponseMap {
  readonly createTeam: CollaborationServerResponseEnvelopeDto<CollaborationTeamDto>;
  readonly listTeams: CollaborationServerResponseEnvelopeDto<readonly CollaborationTeamViewDto[]>;
  readonly getTeam: CollaborationServerResponseEnvelopeDto<CollaborationTeamDetailDto>;
  readonly updateTeam: CollaborationServerResponseEnvelopeDto<CollaborationTeamDto>;
  readonly deleteTeam: CollaborationServerResponseEnvelopeDto<CollaborationDeleteResultDto>;
  readonly createTeamInvite: CollaborationServerResponseEnvelopeDto<CollaborationInviteDto>;
  readonly listTeamInvites: CollaborationServerResponseEnvelopeDto<readonly CollaborationInviteDto[]>;
  readonly revokeTeamInvite: CollaborationServerResponseEnvelopeDto<CollaborationInviteActionResultDto>;
  readonly deleteTeamInvite: CollaborationServerResponseEnvelopeDto<CollaborationInviteActionResultDto>;
  readonly joinTeam: CollaborationServerResponseEnvelopeDto<CollaborationTeamDto>;
  readonly leaveTeam: CollaborationServerResponseEnvelopeDto<CollaborationMembershipActionResultDto>;
  readonly removeTeamMember: CollaborationServerResponseEnvelopeDto<CollaborationMembershipActionResultDto>;
  readonly createTeamProject: CollaborationServerResponseEnvelopeDto<CollaborationProjectDto>;
  readonly listTeamProjects: CollaborationServerResponseEnvelopeDto<readonly CollaborationProjectDto[]>;
  readonly deleteTeamProject: CollaborationServerResponseEnvelopeDto<CollaborationDeleteResultDto>;
  readonly prepareTeamProject: CollaborationServerResponseEnvelopeDto<CollaborationWorktreeDto>;
  readonly listTeamBranches: CollaborationServerResponseEnvelopeDto<readonly CollaborationBranchDto[]>;
  readonly createTeamBranch: CollaborationServerResponseEnvelopeDto<CollaborationBranchActionResultDto>;
  readonly teamProjectHistory: CollaborationServerResponseEnvelopeDto<readonly CollaborationCommitDto[]>;
  readonly commitTeamChanges: CollaborationServerResponseEnvelopeDto<CollaborationCommitDto>;
  readonly compareTeamBranches: CollaborationServerResponseEnvelopeDto<CollaborationDiffDto>;
  readonly mergeTeamBranch: CollaborationServerResponseEnvelopeDto<CollaborationWorktreeDto>;
  readonly listTeamConflicts: CollaborationServerResponseEnvelopeDto<readonly CollaborationConflictFileDto[]>;
  readonly resolveTeamConflict: CollaborationServerResponseEnvelopeDto<CollaborationConflictActionResultDto>;
  readonly completeTeamMerge: CollaborationServerResponseEnvelopeDto<CollaborationCommitDto>;
  readonly acquireTeamFileLock: CollaborationServerResponseEnvelopeDto<CollaborationFileLockDto>;
  readonly releaseTeamFileLock: CollaborationServerResponseEnvelopeDto<CollaborationReleaseLockResultDto>;
  readonly listTeamFileLocks: CollaborationServerResponseEnvelopeDto<readonly CollaborationFileLockDto[]>;
  readonly getTeamCacheInfo: CollaborationServerResponseEnvelopeDto<CollaborationCacheInfoDto | null>;
  readonly clearTeamCache: CollaborationServerResponseEnvelopeDto<CollaborationCacheInfoDto | null>;
  readonly updateProfile: CollaborationServerResponseEnvelopeDto<CollaborationProfileResponseDataDto>;
}

export type CollaborationServerActionDto = keyof CollaborationServerRequestMap;

export type CollaborationServerResponseData<Action extends CollaborationServerActionDto> =
  CollaborationServerResponseMap[Action] extends CollaborationServerResponseEnvelopeDto<infer Data>
    ? Data
    : never;

export type CollaborationSendToServer = <Action extends CollaborationServerActionDto>(
  action: Action,
  payload: CollaborationServerRequestMap[Action],
  options: Readonly<{ quiet: true }>
) => Promise<CollaborationServerResponseMap[Action]>;

/** A decoded action helper used inside the migrated collaboration service. */
export interface CollaborationApiPort {
  request<Action extends CollaborationServerActionDto>(
    action: Action,
    payload: CollaborationServerRequestMap[Action]
  ): Promise<CollaborationServerResponseData<Action>>;
}

/* ------------------------------------------------------------------------- *
 * Native host boundary. These are the six operations formerly read from the
 * preload bridge by the collaboration module. They stay private to the renderer host
 * adapter and are deliberately not part of the plugin service map.
 * ------------------------------------------------------------------------- */

export interface CollaborationTreeNodeDto {
  readonly name?: string;
  readonly path?: string;
  readonly type?: string;
  readonly children?: readonly CollaborationTreeNodeDto[] | null;
  readonly [key: string]: unknown;
}

export interface CollaborationWorkspaceIdentityDto {
  readonly rootPath: string | null;
  readonly workspaceIdentity: number;
}

export interface CollaborationLocalPathInfoDto {
  readonly exists: boolean;
  readonly directory?: boolean;
  readonly empty?: boolean;
  readonly path?: string;
  readonly grantId?: string | null;
  readonly [key: string]: unknown;
}

export interface CollaborationLocalMappingSelectionDto {
  readonly path: string;
  readonly grantId: string;
  readonly empty: boolean;
}

export interface CollaborationOpenedWorkspaceDto {
  readonly rootPath: string;
  readonly tree: CollaborationTreeNodeDto;
  readonly workspaceIdentity: number;
  readonly leaveToken: string | null;
  readonly teamMapping?: CollaborationTeamMappingDto | null;
}

export interface CollaborationWriteTeamMappingRequestDto {
  readonly localPath: string;
  readonly localGrant: string;
  readonly mapping: CollaborationTeamMappingDto;
}

export interface CollaborationHostPort {
  refreshWorkspace(): Promise<CollaborationTreeNodeDto | null>;
  getWorkspaceIdentity(): Promise<CollaborationWorkspaceIdentityDto>;
  localPathInfo(path: string, grantId?: string): Promise<CollaborationLocalPathInfoDto>;
  pickLocalMapping(): Promise<CollaborationLocalMappingSelectionDto | null>;
  pickWorkspace(localPath: string): Promise<CollaborationOpenedWorkspaceDto | null>;
  writeTeamMapping(request: CollaborationWriteTeamMappingRequestDto): Promise<unknown>;
}

/* ------------------------------------------------------------------------- *
 * Renderer collaborator ports.  They keep DOM, workspace lifecycle, rclone,
 * and legacy BOBO compatibility out of the TypeScript service implementation.
 * ------------------------------------------------------------------------- */

export interface CollaborationTextModelPort {
  dispose?(): void;
  getVersionId?(): number;
}

export interface CollaborationEditorPort {
  updateOptions(options: Readonly<{ readOnly: boolean }>): void;
}

export interface CollaborationSplitEditorPort extends CollaborationEditorPort {
  readonly rightEditor?: CollaborationEditorPort | null;
}

export interface CollaborationI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
  bindText<ElementType extends Element>(
    element: ElementType | null | undefined,
    source: unknown,
    params?: Readonly<Record<string, unknown>> | null,
    options?: Readonly<{ prefix?: string; suffix?: string }>
  ): ElementType | null | undefined;
  bindAttribute<ElementType extends Element>(
    element: ElementType | null | undefined,
    attribute: string,
    source: unknown,
    params?: Readonly<Record<string, unknown>> | null
  ): ElementType | null | undefined;
  unbind?<ElementType extends Element>(
    element: ElementType | null | undefined,
    attribute?: string
  ): ElementType | null | undefined;
  onChange?(listener: () => void): Dispose | Disposable | void;
}

export type CollaborationConfirmPort = ConfirmFacade;

export interface CollaborationToastPort {
  info?(message: string): void;
  success?(message: string): void;
  error?(message: string): void;
  warning?(message: string): void;
}

export interface CollaborationAuthPort {
  openAuthModal?(notice?: string): unknown;
  renderChip?(): unknown;
}

export interface CollaborationAccountProfilePort {
  openProfile?(tab?: string): unknown;
}

export interface CollaborationWorkspaceLeaveOptionsDto {
  readonly reason?: string;
  readonly targetRoot?: string;
  readonly leaveToken?: string;
  readonly approved?: boolean;
}

export interface CollaborationWorkspacePort {
  canLeaveWorkspace?(options?: CollaborationWorkspaceLeaveOptionsDto): Promise<boolean>;
  closeWorkspace?(options?: CollaborationWorkspaceLeaveOptionsDto): Promise<boolean>;
  abortWorkspaceLeave?(leaveToken?: string): boolean;
  applyWorkspace?(
    rootPath: string,
    tree: CollaborationTreeNodeDto | null,
    workspaceIdentity: number,
    leaveToken?: string | null,
    options?: Readonly<{ approved?: boolean }>
  ): Promise<boolean>;
}

export interface CollaborationRclonePrepareRequestDto {
  readonly teamId: string;
  readonly projectId: string;
  readonly branch: string;
  readonly reset?: boolean;
}

export interface CollaborationRclonePrepareOptionsDto {
  readonly dest: string;
  readonly localGrant?: string;
}

export interface CollaborationRclonePrepareResultDto {
  readonly success: boolean;
  readonly remoteGrantId?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface CollaborationRclonePullOptionsDto {
  readonly dest: string;
  readonly localGrant?: string;
  readonly remoteGrantId?: string;
  readonly onProgress?: (line: unknown) => void;
}

export interface CollaborationRclonePullResultDto {
  readonly success: boolean;
  readonly error?: string | { readonly message?: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

export interface CollaborationRclonePort {
  prepareTeamPull(
    request: CollaborationRclonePrepareRequestDto,
    options?: CollaborationRclonePrepareOptionsDto
  ): Promise<CollaborationRclonePrepareResultDto>;
  pull(options: CollaborationRclonePullOptionsDto): Promise<CollaborationRclonePullResultDto>;
}

export interface CollaborationRunnerPort {
  uploadWorkspace(): Promise<boolean>;
  prepareWorkspaceLeave?(): Promise<unknown> | unknown;
}

export interface CollaborationWorkbenchPort {
  refreshContext?(): unknown;
}

export interface CollaborationEnvironmentActivityPort {
  contextChanged?(reason: string): unknown;
}

export interface CollaborationPanelPort {
  (panel: string): unknown;
}

export interface CollaborationClipboardPort {
  writeText(value: string): Promise<void>;
}

export interface CollaborationStoragePort {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CollaborationImagePort {
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

export interface CollaborationLogger {
  error(message?: unknown, ...values: unknown[]): void;
  warn?(message?: unknown, ...values: unknown[]): void;
}

export interface CollaborationDependencies {
  readonly document: Document;
  readonly eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly state: CollaborationRendererState;
  readonly host: CollaborationHostPort;
  readonly sendToServer: CollaborationSendToServer;
  readonly getI18n: () => CollaborationI18nPort | null | undefined;
  readonly getToast: () => CollaborationToastPort | null | undefined;
  readonly getAuth: () => CollaborationAuthPort | null | undefined;
  readonly getAccountProfile: () => CollaborationAccountProfilePort | null | undefined;
  readonly getWorkspace: () => CollaborationWorkspacePort | null | undefined;
  readonly getRclone: () => CollaborationRclonePort | null | undefined;
  readonly getRunner: () => CollaborationRunnerPort | null | undefined;
  readonly getWorkbench: () => CollaborationWorkbenchPort | null | undefined;
  readonly getEnvironmentActivity: () => CollaborationEnvironmentActivityPort | null | undefined;
  readonly getSwitchToPanel: () => CollaborationPanelPort | null | undefined;
  readonly getConfirm?: () => CollaborationConfirmPort | null | undefined;
  readonly storage?: CollaborationStoragePort | null;
  readonly clipboard?: CollaborationClipboardPort | null;
  readonly createImage?: () => CollaborationImagePort;
  readonly createObjectURL?: (file: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly setInterval: (callback: () => void, delayMs: number) => number;
  readonly clearInterval: (timer: number) => void;
  readonly logger?: CollaborationLogger;
}

/** Historical writable BOBO.collaboration compatibility projection. */
export interface CollaborationFacade {
  init(): void;
  openHub(): Promise<void>;
  openProfile(): void;
  clearCurrent(): void;
  restoreMapping(mapping: CollaborationTeamMappingDto | null, localPath?: string): void;
  updateTeamChrome(): void;
  refreshWorkbench(): Promise<void>;
  uploadCurrent(): Promise<boolean>;
  onFileOpened(
    filePath: string,
    options?: Readonly<{ silent?: boolean }>
  ): Promise<CollaborationFileLockDto | null | undefined>;
  onFileClosed(filePath: string): Promise<void>;
  onFileActivated(filePath: string): void;
  isActiveFileReadOnly(): boolean;
  releaseForLogout(): Promise<void>;
}

export interface CollaborationService extends CollaborationFacade, Disposable {
  readonly disposed: boolean;
}
