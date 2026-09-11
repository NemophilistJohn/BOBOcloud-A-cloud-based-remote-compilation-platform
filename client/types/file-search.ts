import type { Disposable } from './lifecycle';

/** Untrusted workspace-tree shape consumed by Quick Open. */
export interface FileSearchTreeNodeDto {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly path?: unknown;
  readonly children?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface FileSearchTabDto {
  readonly path?: unknown;
  readonly [key: string]: unknown;
}

/** A normalized, immutable entry held by the Quick Open index. */
export interface FileSearchFileDto {
  readonly path: string;
  readonly normalizedPath: string;
  readonly name: string;
  readonly dir: string;
  readonly relativePath: string;
  readonly searchName: string;
  readonly searchPath: string;
  readonly suggestionBase: number;
}

export interface FileSearchStatePort {
  readonly workspaceRoot: string | null;
  readonly workspaceTree: unknown;
  readonly tabs: readonly FileSearchTabDto[];
}

export interface FileSearchI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
}

export interface FileSearchStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FileSearchEventTarget {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface FileSearchWorkspaceSettingsPort {
  isPathExcluded?(value: unknown): boolean;
}

export interface FileSearchFileIconsPort {
  getFileIcon?(fileName?: string | null): string | null;
}

export interface FileSearchIconsPort {
  readonly file?: string;
  readonly search?: string;
  readonly trash?: string;
}

export interface FileSearchWorkspaceLaunchPort {
  requestOpen?(): unknown;
}

export interface FileSearchWorkspacePort {
  openFile?(path: string, name?: string): unknown;
}

export interface FileSearchWorkbenchPort {
  setPrimaryView?(view: string): unknown;
}

export interface FileSearchDependencies {
  readonly document: Document;
  readonly eventTarget: FileSearchEventTarget;
  readonly state: FileSearchStatePort;
  readonly storage?: Readonly<FileSearchStoragePort> | null;
  readonly getI18n: () => FileSearchI18nPort | null | undefined;
  readonly getWorkspaceSettings: () => FileSearchWorkspaceSettingsPort | null | undefined;
  readonly getFileIcons: () => FileSearchFileIconsPort | null | undefined;
  readonly getIcons: () => FileSearchIconsPort | null | undefined;
  readonly getWorkspaceLaunch: () => FileSearchWorkspaceLaunchPort | null | undefined;
  readonly getWorkspace: () => FileSearchWorkspacePort | null | undefined;
  readonly getWorkbench: () => FileSearchWorkbenchPort | null | undefined;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}

export interface FileSearchFacade {
  show(): void;
  hide(): void;
  refreshCache(force?: boolean): void;
}

export interface FileSearchService extends FileSearchFacade, Disposable {
  readonly disposed: boolean;
}
