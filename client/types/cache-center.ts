import type {
  CacheCategoryDto,
  CacheInventoryDto,
  CacheModelFacade,
  CacheProjectNamesDto
} from './cache-model';
import type {
  CacheStoreLoadOptionsDto,
  CacheStoreOperations
} from './cache-store';
import type { ConfirmOptions } from './confirm-dialog';
import type { Disposable } from './lifecycle';

export type CacheCenterFilterScopeDto = 'all' | 'current' | 'shared' | 'services';

export interface CacheCenterFiltersDto {
  readonly scope: CacheCenterFilterScopeDto;
  readonly category: CacheCategoryDto | 'all';
}

export interface CacheCenterRendererState {
  readonly auth?: {
    readonly token?: unknown;
    readonly user?: {
      readonly id?: unknown;
      readonly uid?: unknown;
    } | null;
  } | null;
  readonly serverSettings?: {
    readonly ip?: unknown;
  } | null;
  readonly workspaceRoot?: unknown;
  readonly workspaceIdentity?: unknown;
  readonly selectedRuntime?: unknown;
  readonly [key: string]: unknown;
}

export type CacheCenterModel = Pick<
  CacheModelFacade,
  | 'CATEGORY_ORDER'
  | 'groupInventory'
  | 'isCurrentEnvironmentEntry'
  | 'isServiceCategory'
>;

export type CacheCenterStore = Pick<
  CacheStoreOperations,
  | 'subscribe'
  | 'getState'
  | 'load'
  | 'getEntry'
  | 'deleteEntry'
  | 'clearScope'
  | 'setActive'
>;

export interface CacheCenterI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
  getActive?(): string;
}

export interface CacheCenterIconPort {
  readonly [name: string]: string | null | undefined;
}

export interface CacheCenterToastPort {
  success?(message: string): unknown;
  error?(message: string): unknown;
}

export type CacheCenterConfirmPort = (
  options: ConfirmOptions
) => Promise<boolean>;

export interface CacheCenterProjectsPort {
  close?: () => unknown;
}

export interface CacheCenterWorkbenchPort {
  setPrimaryView?: (view: 'environment') => unknown;
}

export interface CacheCenterPackageOpenOptionsDto {
  readonly mode: 'installed';
}

export interface CacheCenterPackageCenterPort {
  open?: (options: CacheCenterPackageOpenOptionsDto) => unknown;
}

export interface CacheCenterDependencies {
  readonly document: Document;
  readonly languageEvents: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly state: CacheCenterRendererState;
  readonly model: CacheCenterModel;
  readonly getStore: () => CacheCenterStore;
  readonly projectKey: (workspaceRoot: string) => string;
  readonly getI18n: () => CacheCenterI18nPort | null | undefined;
  readonly getIcons: () => CacheCenterIconPort | null | undefined;
  readonly getToast: () => CacheCenterToastPort | null | undefined;
  readonly getConfirm: () => CacheCenterConfirmPort | null | undefined;
  readonly getProjects: () => CacheCenterProjectsPort | null | undefined;
  readonly getWorkbench: () => CacheCenterWorkbenchPort | null | undefined;
  readonly getPackageCenter: () => CacheCenterPackageCenterPort | null | undefined;
  readonly alert?: (message: string) => unknown;
}

export interface CacheCenterFacade {
  init(): void;
  load(options?: CacheStoreLoadOptionsDto | null): Promise<CacheInventoryDto | null>;
  render(): void;
  setVisible(value: boolean): void;
  setProjectNames(names?: CacheProjectNamesDto | null): void;
  dispose(): void;
  getFilters(): CacheCenterFiltersDto;
}

export interface CacheCenterService extends CacheCenterFacade, Disposable {
  readonly disposed: boolean;
}
