import type { Disposable, Dispose } from './lifecycle';

export type EnvironmentActivityActionDto =
  | 'index'
  | 'install'
  | 'compile'
  | 'repair'
  | 'rebuild';

export type EnvironmentActivityEventKindDto = EnvironmentActivityActionDto | 'context';
export type EnvironmentActivityOutcomeDto = 'completed' | 'failed';
export type EnvironmentActivityScopeKeyDto = `e1-${string}`;

export interface EnvironmentActivityTabDto {
  readonly path?: unknown;
  readonly language?: unknown;
}

export interface EnvironmentActivityEditorModel {
  getLanguageId?(): unknown;
}

export interface EnvironmentActivityEditor {
  getModel?(): EnvironmentActivityEditorModel | null;
}

export interface EnvironmentActivityUserDto {
  readonly uid?: unknown;
  readonly id?: unknown;
  readonly userId?: unknown;
  readonly username?: unknown;
}

export interface EnvironmentActivityRendererState {
  readonly tabs?: readonly EnvironmentActivityTabDto[] | null;
  readonly activeTabPath?: unknown;
  readonly editor?: EnvironmentActivityEditor | null;
  readonly auth?: {
    readonly user?: EnvironmentActivityUserDto | null;
    readonly mode?: unknown;
  } | null;
  readonly collaboration?: {
    readonly current?: {
      readonly teamId?: unknown;
      readonly projectId?: unknown;
      readonly branch?: unknown;
    } | null;
  } | null;
  readonly workspaceRoot?: string | null;
  readonly selectedRuntime?: unknown;
  readonly serverSettings?: {
    readonly ip?: unknown;
  } | null;
  readonly [key: string]: unknown;
}

export interface EnvironmentActivityScopeOverridesDto {
  readonly workspaceRoot?: string | null;
  readonly language?: unknown;
  readonly runtime?: unknown;
  readonly [key: string]: unknown;
}

export interface EnvironmentActivityPersonalWorkspaceDto {
  readonly kind: 'personal';
  readonly folderKey: string;
}

export interface EnvironmentActivityTeamWorkspaceDto {
  readonly kind: 'team';
  readonly teamId: string;
  readonly projectId: string;
  readonly branch: string;
}

export type EnvironmentActivityWorkspaceDto =
  | EnvironmentActivityPersonalWorkspaceDto
  | EnvironmentActivityTeamWorkspaceDto;

export interface EnvironmentActivityScopeDto {
  readonly server: string;
  readonly user: string;
  readonly workspace: EnvironmentActivityWorkspaceDto;
  readonly runtime: string;
  readonly language: string;
}

export interface EnvironmentActivityRecordDto {
  readonly lastIndexedAt?: number;
  readonly lastInstalledAt?: number;
  readonly lastCompiledAt?: number;
  readonly lastRepairAt?: number;
  readonly lastRebuildAt?: number;
  readonly lastAction?: string;
  readonly lastOutcome?: string;
  readonly updatedAt?: number;
}

export interface EnvironmentActivityRecordDetailDto {
  readonly at?: number;
  readonly outcome?: EnvironmentActivityOutcomeDto;
  readonly scope?: EnvironmentActivityScopeOverridesDto | null;
  readonly [key: string]: unknown;
}

export interface EnvironmentActivityEventDetailDto extends EnvironmentActivityRecordDetailDto {
  readonly reason?: string;
}

export interface EnvironmentActivityEventDto {
  readonly kind: EnvironmentActivityEventKindDto;
  readonly scopeKey: EnvironmentActivityScopeKeyDto;
  readonly record: EnvironmentActivityRecordDto;
  readonly detail: EnvironmentActivityEventDetailDto;
}

export type EnvironmentActivityListener = (event: EnvironmentActivityEventDto) => void;

export interface EnvironmentActivityOperations {
  read(overrides?: EnvironmentActivityScopeOverridesDto | null): EnvironmentActivityRecordDto;
  record(
    kind: EnvironmentActivityActionDto,
    detail?: EnvironmentActivityRecordDetailDto | null
  ): boolean;
  contextChanged(reason?: unknown): void;
  subscribe(callback: EnvironmentActivityListener): Dispose;
  getScope(overrides?: EnvironmentActivityScopeOverridesDto | null): EnvironmentActivityScopeDto;
  getScopeKey(
    overrides?: EnvironmentActivityScopeOverridesDto | null
  ): EnvironmentActivityScopeKeyDto;
}

export interface EnvironmentActivityFacade extends EnvironmentActivityOperations {
  _storageKey: string;
}

export interface EnvironmentActivityService extends EnvironmentActivityOperations, Disposable {
  readonly disposed: boolean;
}

export interface EnvironmentActivityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EnvironmentActivityDependencies {
  readonly state: EnvironmentActivityRendererState;
  readonly storage: EnvironmentActivityStorage | null;
  readonly projectKey: (workspaceRoot: string) => string;
  readonly now: () => number;
  readonly dispatchEvent: (event: EnvironmentActivityEventDto) => void;
  readonly reportSubscriberError: (error: unknown) => void;
}
