import type { ConfirmOptions } from './confirm-dialog';
import type {
  EnvironmentActivityActionDto,
  EnvironmentActivityEventDto,
  EnvironmentActivityRecordDetailDto,
  EnvironmentActivityRecordDto
} from './environment-activity';
import type { Disposable, Dispose } from './lifecycle';

export type EnvironmentCenterActionDto = 'repair' | 'rebuild' | 'refresh' | 'clear';
export type ProjectEnvironmentActionDto = 'repair' | 'rebuild' | 'clearCache';
export type EnvironmentHealthDto = 'ready' | 'warning' | 'error' | 'busy' | 'unknown';
export type EnvironmentIssueStatusDto = 'missing' | 'warning';
export type EnvironmentViewStateDto = 'empty' | 'loading' | 'error' | 'ready';

export interface EnvironmentTreeNodeDto {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly type?: unknown;
  readonly isDirectory?: unknown;
  readonly children?: readonly EnvironmentTreeNodeDto[] | null;
  readonly items?: readonly EnvironmentTreeNodeDto[] | null;
}

export interface ProjectEnvironmentManifestDto {
  readonly path: string;
  readonly localPath?: string;
  readonly kind: string;
  readonly manager: string;
  readonly language: string;
  readonly lockfile: boolean;
  readonly parsed: boolean;
  readonly status: string;
}

export interface ProjectEnvironmentPackageDto {
  readonly name: string;
  readonly version?: string;
  readonly constraint?: string;
  readonly scope?: string;
  readonly source?: string;
  readonly trust?: string;
  readonly reason?: string;
}

export interface ProjectEnvironmentIssueDto extends ProjectEnvironmentPackageDto {
  readonly _status: EnvironmentIssueStatusDto;
}

export interface ProjectEnvironmentPackagesDto {
  readonly declared: readonly ProjectEnvironmentPackageDto[];
  readonly installed: readonly ProjectEnvironmentPackageDto[];
  readonly missing: readonly ProjectEnvironmentPackageDto[];
  readonly unknown: readonly ProjectEnvironmentPackageDto[];
}

export interface ProjectEnvironmentWorkspaceDto {
  readonly kind: 'personal' | 'team' | string;
  readonly id: string;
  readonly name: string;
  readonly key?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  readonly branch?: string;
}

export interface ProjectEnvironmentLanguageDto {
  readonly id: string;
  readonly source: string;
  readonly displayName?: string;
}

export interface ProjectEnvironmentRuntimeDto {
  readonly id: string;
  readonly language?: string;
  readonly version?: string;
  readonly resolvedVersion?: string;
  readonly resolvedVersionSource?: string;
  readonly resolvedVersionTrust?: string;
  readonly image?: string;
  readonly dockerImage?: string;
  readonly displayName?: string;
  readonly status: string;
}

export interface ProjectEnvironmentCheckDto {
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
}

export interface ProjectEnvironmentConsistencyDto {
  readonly status: string;
  readonly languageRuntime?: ProjectEnvironmentCheckDto;
  readonly dependencyRuntime?: ProjectEnvironmentCheckDto;
  readonly lspDependencies?: ProjectEnvironmentCheckDto;
  readonly detail?: string;
}

export interface ProjectEnvironmentActivityDto {
  readonly lastIndexedAt?: string | number;
  readonly lastInstalledAt?: string | number;
  readonly lastCompiledAt?: string | number;
  readonly lastRepairAt?: string | number;
  readonly lastRebuildAt?: string | number;
}

export interface ProjectEnvironmentCapabilityDto {
  readonly supported?: boolean;
  readonly requiresConfirmation?: boolean;
  readonly scope?: string;
  readonly reason?: string;
}

export interface ProjectEnvironmentActionsDto {
  readonly refreshIndex?: ProjectEnvironmentCapabilityDto;
  readonly clearCache?: ProjectEnvironmentCapabilityDto;
  readonly repair?: ProjectEnvironmentCapabilityDto;
  readonly rebuild?: ProjectEnvironmentCapabilityDto;
}

export interface ProjectEnvironmentDependencyCacheDto {
  readonly scope?: string;
  readonly cacheId?: string;
  readonly digest?: string;
  readonly generation?: string;
  readonly source?: string;
  readonly status?: string;
  readonly sizeBytes?: number;
  readonly lastUsedAt?: number;
  readonly inventoryStatus?: string;
  readonly inventoryDetail?: string;
  readonly inventoryCheckedAt?: number;
}

export interface ProjectEnvironmentSnapshotDto {
  readonly schema: 'project-environment/v1';
  readonly revision?: string;
  readonly source: 'local' | 'cloud';
  readonly checkedAt: string | number;
  readonly workspace: ProjectEnvironmentWorkspaceDto;
  readonly language: ProjectEnvironmentLanguageDto;
  readonly runtime: ProjectEnvironmentRuntimeDto;
  readonly manifests: readonly ProjectEnvironmentManifestDto[];
  readonly packages: ProjectEnvironmentPackagesDto;
  readonly dependencyCache: ProjectEnvironmentDependencyCacheDto;
  readonly consistency: ProjectEnvironmentConsistencyDto;
  readonly activity: ProjectEnvironmentActivityDto;
  readonly actions: ProjectEnvironmentActionsDto;
}

export type ProjectEnvironmentWireManifestDto = Omit<
  ProjectEnvironmentManifestDto,
  'localPath'
>;

export type ProjectEnvironmentWireDto = Omit<
  ProjectEnvironmentSnapshotDto,
  'source' | 'checkedAt' | 'manifests'
> & {
  readonly checkedAt: number;
  readonly manifests: readonly ProjectEnvironmentWireManifestDto[];
};

export interface ProjectEnvironmentRepairStepDto {
  readonly id?: string;
  readonly kind?: string;
  readonly manager?: string;
  readonly manifestPath?: string;
  readonly label?: string;
  readonly description?: string;
  readonly action?: string;
}

export interface ProjectEnvironmentRepairPlanDto {
  readonly schema?: 'project-environment-repair-plan/v1';
  readonly revision?: string;
  readonly action?: string;
  readonly supported?: boolean;
  readonly requiresConfirmation?: boolean;
  readonly reason?: string;
  readonly planId?: string;
  readonly id?: string;
  readonly steps?: readonly (ProjectEnvironmentRepairStepDto | string)[];
  readonly operations?: readonly (ProjectEnvironmentRepairStepDto | string)[];
  readonly actions?: readonly (ProjectEnvironmentRepairStepDto | string)[];
}

export interface ProjectEnvironmentActionResultDto {
  readonly schema?: 'project-environment-action/v1';
  readonly action?: string;
  readonly applied?: boolean;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
  readonly environment?: ProjectEnvironmentWireDto;
}

export interface ProjectEnvironmentRequestContextDto {
  readonly folderName: string;
  readonly folderKey: string;
  readonly runtime: string;
  readonly language: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly branch: string;
  readonly setupCommands: readonly string[];
}

export interface ProjectEnvironmentActionRequestDto extends ProjectEnvironmentRequestContextDto {
  readonly environmentAction: ProjectEnvironmentActionDto;
  readonly revision: string;
  readonly planId?: string;
}

export interface EnvironmentServerEnvelopeDto<Data = unknown> {
  readonly success?: boolean;
  readonly data?: Data;
  readonly plan?: Data;
  readonly error?: unknown;
  readonly message?: unknown;
  readonly [key: string]: unknown;
}

export interface EnvironmentCenterServerRequestMap {
  readonly getProjectEnvironment: ProjectEnvironmentRequestContextDto;
  readonly planProjectEnvironmentRepair: ProjectEnvironmentActionRequestDto;
  readonly applyProjectEnvironmentAction: ProjectEnvironmentActionRequestDto;
}

export interface EnvironmentCenterServerResponseMap {
  readonly getProjectEnvironment: EnvironmentServerEnvelopeDto<ProjectEnvironmentWireDto>;
  readonly planProjectEnvironmentRepair: EnvironmentServerEnvelopeDto<ProjectEnvironmentRepairPlanDto>;
  readonly applyProjectEnvironmentAction: EnvironmentServerEnvelopeDto<ProjectEnvironmentActionResultDto>;
}

export type EnvironmentCenterServerActionDto = keyof EnvironmentCenterServerRequestMap;

export interface EnvironmentCenterTabDto {
  readonly path?: unknown;
  readonly language?: unknown;
}

export interface EnvironmentCenterEditorModelPort {
  getLanguageId?(): unknown;
}

export interface EnvironmentCenterEditorPort {
  getModel?(): EnvironmentCenterEditorModelPort | null;
}

export interface EnvironmentCenterRuntimeDefinitionDto {
  readonly runtimeId?: unknown;
  readonly language?: unknown;
  readonly version?: unknown;
  readonly dockerImage?: unknown;
  readonly image?: unknown;
  readonly displayName?: unknown;
}

export interface EnvironmentCenterRendererState {
  readonly tabs?: readonly EnvironmentCenterTabDto[] | null;
  readonly activeTabPath?: unknown;
  readonly editor?: EnvironmentCenterEditorPort | null;
  readonly availableRuntimes?: readonly EnvironmentCenterRuntimeDefinitionDto[] | null;
  readonly selectedRuntime?: unknown;
  readonly workspaceRoot?: string | null;
  readonly workspaceIdentity?: unknown;
  readonly setupCommands?: readonly string[] | null;
  readonly serverSettings?: { readonly ip?: unknown } | null;
  readonly auth?: {
    readonly token?: unknown;
    readonly user?: {
      readonly id?: unknown;
      readonly uid?: unknown;
      readonly userId?: unknown;
    } | null;
  } | null;
  readonly collaboration?: {
    readonly current?: {
      readonly name?: unknown;
      readonly projectName?: unknown;
      readonly teamId?: unknown;
      readonly projectId?: unknown;
      readonly branch?: unknown;
    } | null;
  } | null;
  readonly [key: string]: unknown;
}

export interface EnvironmentCenterLspStatusDto {
  readonly state?: string;
  readonly sessionId?: unknown;
  readonly error?: unknown;
  readonly dependency?: {
    readonly status?: unknown;
    readonly detail?: unknown;
  } | null;
}

export interface EnvironmentCenterLspPort {
  getStatus?(): EnvironmentCenterLspStatusDto;
  clearAnalysisCache?(): Promise<unknown>;
  restartAnalysis?(): Promise<unknown>;
  clearClientCache?(scope: 'workspace'): Promise<unknown>;
  dependenciesChanged?(): unknown;
}

export interface EnvironmentCenterActivityPort {
  read?(): EnvironmentActivityRecordDto;
  record?(
    kind: EnvironmentActivityActionDto,
    detail?: EnvironmentActivityRecordDetailDto | null
  ): boolean;
  subscribe?(listener: (event: EnvironmentActivityEventDto) => void): Dispose;
}

export interface EnvironmentCenterProblemDto {
  readonly severity?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

export interface EnvironmentCenterProblemMatcherPort {
  getAllProblems?(): readonly EnvironmentCenterProblemDto[];
}

export interface EnvironmentCenterI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
  getActive?(): unknown;
}

export interface EnvironmentCenterToastPort {
  success?(message: string): unknown;
  error?(message: string): unknown;
}

export type EnvironmentCenterConfirmPort = (options: ConfirmOptions) => Promise<boolean>;

export interface EnvironmentCenterWorkspacePort {
  openFile?(localPath: string, displayName: string): unknown;
}

export interface EnvironmentCenterPackageCenterPort {
  open?(options: { readonly query: string; readonly mode: 'installed' | 'discover' }): unknown;
}

export interface EnvironmentCenterWorkbenchPort {
  getState?(): { readonly activity?: unknown };
}

export interface EnvironmentCenterNativeHostPort {
  readTree(workspaceRoot: string): Promise<unknown>;
  onFileEvent?(listener: (event: unknown) => void): Dispose;
}

export interface EnvironmentCenterMarkerPort {
  onDidChangeMarkers?(listener: () => void): Disposable | null | undefined;
}

export interface EnvironmentCenterLocalizationPort {
  readonly getActive?: () => unknown;
  readonly t?: (source: string, replacements?: Readonly<Record<string, unknown>>) => string;
}

export interface EnvironmentCenterMergePorts {
  readonly localization?: EnvironmentCenterLocalizationPort | null;
  readonly lspStatus?: EnvironmentCenterLspStatusDto | null;
  readonly localActivity?: EnvironmentActivityRecordDto | null;
}

export interface EnvironmentCenterDependencies {
  readonly document: Document;
  readonly events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly state: EnvironmentCenterRendererState;
  readonly getNativeHost: () => EnvironmentCenterNativeHostPort | null | undefined;
  readonly getI18n: () => EnvironmentCenterI18nPort | null | undefined;
  readonly getLsp: () => EnvironmentCenterLspPort | null | undefined;
  readonly getEnvironmentActivity: () => EnvironmentCenterActivityPort | null | undefined;
  readonly getTaskProblemMatcher: () => EnvironmentCenterProblemMatcherPort | null | undefined;
  readonly getWorkspace: () => EnvironmentCenterWorkspacePort | null | undefined;
  readonly getPackageCenter: () => EnvironmentCenterPackageCenterPort | null | undefined;
  readonly getWorkbench: () => EnvironmentCenterWorkbenchPort | null | undefined;
  readonly getToast: () => EnvironmentCenterToastPort | null | undefined;
  readonly getConfirm: () => EnvironmentCenterConfirmPort | null | undefined;
  readonly projectKey: (workspaceRoot: string) => string;
  readonly getMarkerPort: () => EnvironmentCenterMarkerPort | null | undefined;
  readonly sendToServer: <Action extends EnvironmentCenterServerActionDto>(
    action: Action,
    payload: EnvironmentCenterServerRequestMap[Action],
    options: { readonly quiet: true }
  ) => Promise<EnvironmentCenterServerResponseMap[Action]>;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly now: () => number;
}

export interface EnvironmentCenterRefreshOptionsDto {
  readonly force?: boolean;
  readonly loading?: boolean;
}

export interface EnvironmentCenterFacade {
  init(): void;
  refresh(options?: EnvironmentCenterRefreshOptionsDto | null): Promise<ProjectEnvironmentSnapshotDto | null>;
  scheduleRefresh(reason?: string, delay?: number): void;
  runAction(name: EnvironmentCenterActionDto): Promise<void>;
  getSnapshot(): ProjectEnvironmentSnapshotDto | null;
  getRequestContext(): ProjectEnvironmentRequestContextDto;
  dispose(): void;
}

export interface EnvironmentCenterService extends EnvironmentCenterFacade, Disposable {
  readonly disposed: boolean;
}
