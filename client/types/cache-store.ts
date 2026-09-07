import type { CacheEntryDto, CacheInventoryDto, CacheModelFacade } from './cache-model';
import type { Disposable, Dispose } from './lifecycle';

export type CacheStoreStatusDto =
  | 'idle'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'error';

// Legacy invalidation producers may publish any truthy detail value. Keep that
// open at the compatibility boundary while consumers narrow object DTOs.
export type CacheStoreInvalidationDto = unknown;

export interface CacheStoreLoadOptionsDto {
  readonly force?: boolean;
  readonly [key: string]: unknown;
}

export type CacheStoreClearScopeDto =
  | 'owner'
  | 'workspace'
  | 'shared';

export interface CacheStoreClearScopeRequestDto {
  readonly scope: CacheStoreClearScopeDto;
  readonly workspaceId?: string | null;
  readonly category?: string | null;
  readonly [key: string]: unknown;
}

export interface CacheStoreIdentityUserDto {
  readonly id?: unknown;
  readonly uid?: unknown;
  readonly [key: string]: unknown;
}

export interface CacheStoreRendererState {
  readonly serverSettings?: {
    readonly ip?: unknown;
    readonly [key: string]: unknown;
  } | null;
  readonly auth?: {
    readonly token?: unknown;
    readonly user?: CacheStoreIdentityUserDto | null;
    readonly [key: string]: unknown;
  } | null;
  readonly [key: string]: unknown;
}

export interface CacheStoreSnapshotDto {
  readonly status: CacheStoreStatusDto;
  readonly inventory: CacheInventoryDto | null;
  readonly error: unknown | null;
  readonly stale: boolean;
  readonly identity: string;
  readonly mutations: CacheStoreMutationMapDto;
  readonly invalidation: CacheStoreInvalidationDto;
}

export type CacheStoreActionDto =
  | 'getCacheInventory'
  | 'getCacheEntry'
  | 'deleteCacheEntry'
  | 'clearCacheScope';

export type CacheStoreMutationMapDto = Readonly<Record<string, true>>;

export type CacheStoreInventoryRequestDto = Readonly<Record<string, never>>;

export interface CacheStoreEntryRequestDto {
  readonly cacheId: string;
}

export interface CacheStoreDeleteRequestDto extends CacheStoreEntryRequestDto {
  readonly expectedRevision: string;
}

export interface CacheStoreClearRequestDto {
  readonly scope: CacheStoreClearScopeDto;
  readonly expectedRevision: string;
  readonly workspaceId?: string;
  readonly category?: string;
}

export interface CacheStoreRequestMap {
  readonly getCacheInventory: CacheStoreInventoryRequestDto;
  readonly getCacheEntry: CacheStoreEntryRequestDto;
  readonly deleteCacheEntry: CacheStoreDeleteRequestDto;
  readonly clearCacheScope: CacheStoreClearRequestDto;
}

export interface CacheStoreResponseEnvelopeDto {
  readonly success?: unknown;
  readonly data?: unknown;
  readonly Data?: unknown;
  readonly error?: unknown;
  readonly errorCode?: unknown;
  readonly error_code?: unknown;
  readonly cacheInventory?: unknown;
  readonly cacheEntry?: unknown;
  readonly [key: string]: unknown;
}

export interface CacheStoreInventoryTransportOptions {
  readonly quiet: true;
  readonly timeoutMs: 20000;
  readonly signal: unknown | null;
}

export interface CacheStoreEntryTransportOptions {
  readonly quiet: true;
  readonly timeoutMs: 20000;
  readonly signal?: never;
}

export interface CacheStoreMutationTransportOptions {
  readonly quiet: true;
  readonly timeoutMs: 30000;
  readonly signal?: never;
}

export type CacheStoreTransportOptions =
  | CacheStoreInventoryTransportOptions
  | CacheStoreEntryTransportOptions
  | CacheStoreMutationTransportOptions;

export interface CacheStoreTransportOptionsMap {
  readonly getCacheInventory: CacheStoreInventoryTransportOptions;
  readonly getCacheEntry: CacheStoreEntryTransportOptions;
  readonly deleteCacheEntry: CacheStoreMutationTransportOptions;
  readonly clearCacheScope: CacheStoreMutationTransportOptions;
}

export type CacheStoreSendToServer = <Action extends CacheStoreActionDto>(
  action: Action,
  payload: CacheStoreRequestMap[Action],
  options: CacheStoreTransportOptionsMap[Action]
) => unknown;

export type CacheStoreModel = Pick<
  CacheModelFacade,
  'normalizeEntry' | 'normalizeInventory'
>;

export interface CacheStoreAbortController {
  readonly signal: unknown;
  abort(): void;
}

export interface CacheStoreDependencies {
  readonly model: CacheStoreModel | null | undefined;
  readonly getState: () => CacheStoreRendererState | null | undefined;
  readonly sendToServer: CacheStoreSendToServer;
  readonly createAbortController: () => CacheStoreAbortController | null;
  readonly dispatchInvalidationEvent: (detail: CacheStoreInvalidationDto) => void;
  readonly reportListenerError: (error: unknown) => void;
}

export type CacheStoreListener = (
  snapshot: CacheStoreSnapshotDto,
  reason: string
) => void;

export interface CacheStoreOperations {
  subscribe(listener: CacheStoreListener): Dispose;
  getState(): CacheStoreSnapshotDto;
  load(options?: CacheStoreLoadOptionsDto | null): Promise<CacheInventoryDto | null>;
  getEntry(cacheId: string): Promise<CacheEntryDto | null>;
  deleteEntry(cacheId: string): Promise<unknown>;
  clearScope(scopeRequest: CacheStoreClearScopeRequestDto): Promise<unknown>;
  invalidate(detail?: CacheStoreInvalidationDto): void;
  setActive(value: boolean): void;
  reset(): void;
}

export interface CacheStoreFacade extends CacheStoreOperations {}

export interface CacheStoreService extends CacheStoreOperations, Disposable {
  readonly disposed: boolean;
}

export interface LegacyCacheStoreFactoryOptions {
  readonly global?: unknown;
  readonly BOBO?: unknown;
  readonly model?: CacheStoreModel | null;
  readonly [key: string]: unknown;
}

export interface CacheStoreFactoryFacade {
  createCacheStore(options?: LegacyCacheStoreFactoryOptions | null): CacheStoreFacade;
  extractData(response: unknown): Record<string, unknown>;
  extractCacheInventory(response: unknown): unknown | null;
  extractCacheEntry(response: unknown): unknown | null;
}
