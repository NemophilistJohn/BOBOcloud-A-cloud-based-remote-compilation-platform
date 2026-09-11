import type {
  FileDecorationProvider
} from './file-decoration';
import type { Disposable } from './lifecycle';

export type WorkspaceSyncStateDto =
  | 'synced'
  | 'local-only'
  | 'queued'
  | 'syncing'
  | 'error'
  | 'conflict';

export type WorkspaceSyncEventKindDto =
  | 'file-deleted'
  | 'file-created'
  | 'file-changed';

export interface WorkspaceSyncTreeNodeDto {
  readonly path: string;
  readonly type?: string;
  readonly name?: string;
  readonly children?: readonly WorkspaceSyncTreeNodeDto[];
  readonly [key: string]: unknown;
}

export interface WorkspaceSyncPathDto {
  readonly path?: string;
  readonly [key: string]: unknown;
}

export interface WorkspaceSyncEntryOptionsDto {
  readonly mutationId?: string;
  readonly deleted?: boolean;
  readonly error?: unknown;
}

export interface WorkspaceSyncFileEventDto {
  readonly event?: WorkspaceSyncEventKindDto;
  readonly path?: string;
  readonly mutationId?: string;
  readonly [key: string]: unknown;
}

export interface WorkspaceSyncBeginOptionsDto {
  readonly force?: boolean;
}

export interface WorkspaceSyncContextDto {
  readonly id: number;
  readonly rootKey: string;
  readonly revision: number;
  readonly captured: ReadonlyMap<string, number>;
  readonly workspaceRevision: number | null;
  readonly full: boolean;
  readonly force: boolean;
}

export interface WorkspaceSyncFinishErrorDto {
  readonly message?: unknown;
}

export interface WorkspaceSyncFinishResultDto {
  readonly success?: boolean;
  readonly error?: WorkspaceSyncFinishErrorDto | string | null;
  readonly [key: string]: unknown;
}

export interface WorkspaceSyncDecorationDto {
  readonly status: WorkspaceSyncStateDto;
  readonly badge: 'cloud';
  readonly tooltip: string;
  readonly ariaLabel: string;
  readonly count: number;
  readonly lane: 'sync';
  readonly [key: string]: unknown;
}

export interface WorkspaceSyncProvider extends FileDecorationProvider<'sync'> {
  readonly id: 'core.sync-status';
  readonly namespace: 'bobocloud.sync';
  readonly lane: 'sync';
  readonly priority: 100;
  readonly getDecoration: (
    resourcePath: string,
    node: unknown
  ) => WorkspaceSyncDecorationDto | null;
}

export interface WorkspaceSyncI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
}

export interface WorkspaceSyncWorkspacePort {
  refreshFileDecorations?(lane?: string): unknown;
}

export interface WorkspaceSyncEventPort {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface WorkspaceSyncStatusDependencies {
  readonly document: Document | null;
  readonly events: WorkspaceSyncEventPort;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly getI18n: () => WorkspaceSyncI18nPort | null | undefined;
  readonly getWorkspace: () => WorkspaceSyncWorkspacePort | null | undefined;
  readonly getCloudIcon: () => string;
  readonly registerContribution: (
    provider: WorkspaceSyncProvider
  ) => Disposable | null | undefined;
  readonly reportError: (phase: 'listener' | 'dispose', error: unknown) => void;
}

export interface WorkspaceSyncStatusFacade {
  readonly states: readonly WorkspaceSyncStateDto[];
  readonly provider: WorkspaceSyncProvider;
  resetWorkspace(nextRoot: string, nextTree?: WorkspaceSyncTreeNodeDto | null): void;
  clearWorkspace(): void;
  setTree(nextTree?: WorkspaceSyncTreeNodeDto | null): void;
  markChanged(pathValue: string, options?: WorkspaceSyncEntryOptionsDto): boolean;
  markDeleted(pathValue: string): boolean;
  markWorkspaceChanged(): void;
  setBufferDirty(pathValue: string, dirty: boolean): boolean;
  handleFileEvent(event?: WorkspaceSyncFileEventDto | null): boolean;
  beginSync(options?: WorkspaceSyncBeginOptionsDto | null): WorkspaceSyncContextDto;
  finishSync(
    context?: WorkspaceSyncContextDto | null,
    result?: WorkspaceSyncFinishResultDto | null
  ): boolean;
  setConflicts(paths?: readonly (string | WorkspaceSyncPathDto)[] | null): void;
  getDecoration(resourcePath: string, node: unknown): WorkspaceSyncDecorationDto | null;
  decorateRow(row: HTMLElement | null | undefined, node: WorkspaceSyncTreeNodeDto | null | undefined): HTMLElement | null;
  refreshVisible(): void;
  registerContribution(): boolean;
  toWorkspaceRelativePath(pathValue: string): string;
}

export interface WorkspaceSyncStatusService extends WorkspaceSyncStatusFacade, Disposable {
  readonly disposed: boolean;
}

export type WorkspaceSyncChangeListener = () => void;
