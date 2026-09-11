import type { Disposable, Dispose } from './lifecycle';

/**
 * The bounded tree payload returned when a workspace becomes active.  The
 * launch service only needs the immutable transition result; it does not own
 * tree mutation or workspace lifecycle policy.
 */
export interface WorkspaceLaunchTreeNodeDto {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'folder';
  readonly children?: readonly WorkspaceLaunchTreeNodeDto[];
  readonly truncated?: boolean;
}

export interface WorkspaceLaunchTeamMappingDto {
  readonly version: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly branch: string;
  readonly localPath: string;
}

export interface WorkspaceLaunchOpenedWorkspaceDto {
  readonly rootPath: string;
  readonly tree: WorkspaceLaunchTreeNodeDto;
  readonly workspaceIdentity: number;
  readonly leaveToken: string | null;
  readonly teamMapping: WorkspaceLaunchTeamMappingDto | null;
}

export type WorkspaceLaunchOpenedListener = (
  opened: WorkspaceLaunchOpenedWorkspaceDto
) => void;

/** Narrow host capability used by the launch screen and its startup queue. */
export interface WorkspaceLaunchHost {
  pick(directoryPath?: string): Promise<WorkspaceLaunchOpenedWorkspaceDto | null>;
  forgetRecent(directoryPath: string): Promise<boolean>;
  onDidOpen(listener: WorkspaceLaunchOpenedListener): Disposable;
}

export interface WorkspaceLaunchStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceLaunchI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
  onChange(listener: () => void): Dispose;
}

export type WorkspaceLaunchConsumer = (
  opened: WorkspaceLaunchOpenedWorkspaceDto
) => Promise<unknown> | unknown;

export interface WorkspaceLaunchDependencies {
  readonly document: Document;
  readonly host: Readonly<WorkspaceLaunchHost>;
  readonly storage?: Readonly<WorkspaceLaunchStoragePort> | null;
  readonly getI18n: () => WorkspaceLaunchI18nPort | null | undefined;
  readonly reportError: (error: unknown) => void;
}

export interface WorkspaceLaunchFacade {
  init(): void;
  requestOpen(directoryPath?: string): Promise<boolean>;
  setConsumer(consumer: WorkspaceLaunchConsumer | null | undefined): Promise<void>;
  whenIdle(): Promise<void>;
}

export interface WorkspaceLaunchService extends WorkspaceLaunchFacade, Disposable {
  readonly disposed: boolean;
}
