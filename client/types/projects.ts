import type { CacheProjectNamesDto } from './cache-model';
import type { ConfirmOptions } from './confirm-dialog';
import type { Disposable, Dispose } from './lifecycle';

/** Untrusted project fields as received from the server action. */
export interface ProjectsProjectWireDto {
  readonly key?: unknown;
  readonly name?: unknown;
  readonly size_bytes?: unknown;
  readonly files?: unknown;
  readonly mod_time?: unknown;
  readonly [key: string]: unknown;
}

/** Normalized project data used by the renderer presentation. */
export interface ProjectsProjectDto {
  readonly key: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly files: number;
  readonly modTime: number;
}

export interface ProjectsStorageInfoWireDto {
  readonly total_used_bytes?: unknown;
  readonly quota_bytes?: unknown;
  readonly persist_bytes?: unknown;
  readonly projects_total_bytes?: unknown;
  readonly projects?: unknown;
  readonly [key: string]: unknown;
}

export interface ProjectsStorageInfoDto {
  readonly totalUsedBytes: number;
  readonly quotaBytes: number;
  readonly persistBytes: number;
  readonly projectsTotalBytes: number;
  readonly projects: readonly ProjectsProjectDto[];
}

export interface ProjectsListResponseWireDto {
  readonly success?: unknown;
  readonly error?: unknown;
  readonly storageInfo?: ProjectsStorageInfoWireDto | null;
  readonly [key: string]: unknown;
}

export interface ProjectsListResponseDto {
  readonly success: boolean;
  readonly error?: string;
  readonly storageInfo?: ProjectsStorageInfoDto | null;
}

export interface ProjectsDeleteResponseWireDto {
  readonly success?: unknown;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface ProjectsDeleteResponseDto {
  readonly success: boolean;
  readonly error?: string;
}

export interface ProjectsSaveProjectNameRequestDto {
  readonly key: string;
  readonly name: string;
}

export type ProjectsProjectNamesDto = CacheProjectNamesDto;

export interface ProjectsServerRequestMap {
  readonly listProjects: Record<string, never>;
  readonly deleteProject: Readonly<{ folderKey: string }>;
}

export interface ProjectsServerResponseMap {
  readonly listProjects: ProjectsListResponseWireDto;
  readonly deleteProject: ProjectsDeleteResponseWireDto;
}

export type ProjectsServerActionDto = keyof ProjectsServerRequestMap;

export type ProjectsSendToServer = <Action extends ProjectsServerActionDto>(
  action: Action,
  payload: ProjectsServerRequestMap[Action],
  options: { readonly quiet: true }
) => Promise<ProjectsServerResponseMap[Action]>;

export interface ProjectsAuthUserDto {
  readonly id?: unknown;
  readonly uid?: unknown;
}

export interface ProjectsRendererState {
  readonly auth?: {
    readonly token?: unknown;
    readonly user?: ProjectsAuthUserDto | null;
  } | null;
  readonly serverSettings?: {
    readonly ip?: unknown;
  } | null;
  readonly workspaceRoot?: unknown;
}

export interface ProjectsHost {
  onOpenServerProjects(listener: () => void): Disposable;
  readProjectNames(): Promise<ProjectsProjectNamesDto>;
  saveProjectName(key: string, name: string): Promise<boolean>;
}

export interface ProjectsI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
}

export type ProjectsConfirmPort = (options: ConfirmOptions) => Promise<boolean>;

export interface ProjectsCacheCenterPort {
  init(): void;
  load(options?: Readonly<{ force?: boolean }> | null): Promise<unknown>;
  render(): void;
  setVisible(value: boolean): void;
  setProjectNames(names?: ProjectsProjectNamesDto | null): void;
}

export interface ProjectsDependencies {
  readonly document: Document;
  readonly events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly state: ProjectsRendererState;
  readonly host: Readonly<ProjectsHost>;
  readonly sendToServer: ProjectsSendToServer;
  readonly getI18n: () => ProjectsI18nPort | null | undefined;
  readonly getConfirm: () => ProjectsConfirmPort | null | undefined;
  readonly getCacheCenter: () => ProjectsCacheCenterPort | null | undefined;
  readonly projectKey: (workspaceRoot: string) => string;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly alert?: (message: string) => unknown;
}

export interface ProjectsOpenOptionsDto {
  readonly tab?: 'projects' | 'cache';
}

export interface ProjectsFacade {
  init(): void;
  open(options?: ProjectsOpenOptionsDto): void;
  openWithQuotaError(errorMsg?: string | null): void;
  close(): void;
  loadProjects(): Promise<void>;
  switchTab(name: string): void;
}

export interface ProjectsService extends ProjectsFacade, Disposable {
  readonly disposed: boolean;
}

export type ProjectsDispose = Dispose;
