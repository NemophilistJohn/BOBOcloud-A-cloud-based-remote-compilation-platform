export type CacheCategoryDto = string;
export type CacheStateDto = string;
export type CacheHistoryStateDto = 'superseded' | 'orphaned' | 'retired';
export type CacheRawObjectDto = Readonly<Record<PropertyKey, unknown>>;
export type CacheCapabilitiesDto = Readonly<Record<PropertyKey, unknown>>;

export interface CacheEntryWireDto {
  readonly schema?: unknown;
  readonly id?: unknown;
  readonly category?: unknown;
  readonly state?: unknown;
  readonly workspace_id?: unknown;
  readonly workspace_name?: unknown;
  readonly runtime_id?: unknown;
  readonly runtime_fingerprint?: unknown;
  readonly toolchain_fingerprint?: unknown;
  readonly language?: unknown;
  readonly dependency_digest?: unknown;
  readonly content_digest?: unknown;
  readonly source_policy_digest?: unknown;
  readonly build_target?: unknown;
  readonly profile?: unknown;
  readonly generation?: unknown;
  readonly size_bytes?: unknown;
  readonly files?: unknown;
  readonly created_at?: unknown;
  readonly last_used_at?: unknown;
  readonly active_readers?: unknown;
  readonly writing?: unknown;
  readonly lifecycle?: unknown;
  readonly capabilities?: unknown;
  readonly [key: string]: unknown;
  readonly [key: symbol]: unknown;
}

export interface CacheInventoryWireDto {
  readonly schema?: unknown;
  readonly owner_kind?: unknown;
  readonly owner_id?: unknown;
  readonly quota_bytes?: unknown;
  readonly used_bytes?: unknown;
  readonly managed_bytes?: unknown;
  readonly managed_files?: unknown;
  readonly reclaimable_bytes?: unknown;
  readonly reserved_bytes?: unknown;
  readonly quota_files?: unknown;
  readonly used_files?: unknown;
  readonly reserved_files?: unknown;
  readonly scan_truncated?: unknown;
  readonly generated_at?: unknown;
  readonly revision?: unknown;
  readonly lifecycle?: unknown;
  readonly capabilities?: unknown;
  readonly entries?: unknown;
  readonly [key: string]: unknown;
  readonly [key: symbol]: unknown;
}

export interface CacheHistoryStatesDto {
  readonly superseded: true;
  readonly orphaned: true;
  readonly retired: true;
}

export interface CacheEntryDto {
  readonly schema: number;
  readonly id: string;
  readonly category: CacheCategoryDto;
  readonly state: CacheStateDto;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly runtimeId: string;
  readonly runtimeFingerprint: string;
  readonly toolchainFingerprint: string;
  readonly language: string;
  readonly dependencyDigest: string;
  readonly contentDigest: string;
  readonly sourcePolicyDigest: string;
  readonly buildTarget: string;
  readonly profile: string;
  readonly generation: string;
  readonly sizeBytes: number;
  readonly files: number;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly lastUsedAt: string;
  readonly lastUsedAtMs: number;
  readonly activeReaders: number;
  readonly writing: boolean;
  readonly lifecycle: unknown | null;
  readonly capabilities: CacheCapabilitiesDto;
  readonly raw: CacheRawObjectDto;
  readonly current: boolean;
  readonly history: boolean;
  readonly busy: boolean;
  readonly service: boolean;
}

export interface CacheInventoryDto {
  readonly schema: 2;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly quotaBytes: number;
  readonly usedBytes: number;
  readonly managedBytes: number;
  readonly managedFiles: number;
  readonly reclaimableBytes: number;
  readonly reservedBytes: number;
  readonly quotaFiles: number;
  readonly usedFiles: number;
  readonly reservedFiles: number;
  readonly scanTruncated: boolean;
  readonly generatedAt: string;
  readonly generatedAtMs: number;
  readonly revision: string;
  readonly lifecycle: unknown | null;
  readonly capabilities: CacheCapabilitiesDto;
  readonly invalidEntries: number;
  readonly entries: readonly CacheEntryDto[];
  readonly raw: CacheRawObjectDto;
}

export type CacheInventoryFilterScopeDto =
  | 'all'
  | 'current'
  | 'projects'
  | 'shared'
  | 'services'
  | (string & {});

export interface CacheInventoryFiltersDto {
  readonly category?: CacheCategoryDto | null;
  readonly scope?: CacheInventoryFilterScopeDto | null;
}

export interface CacheWorkspaceContextDto {
  readonly workspaceId?: unknown;
  readonly folderKey?: unknown;
  readonly workspaceName?: unknown;
  readonly runtimeId?: unknown;
}

export type CacheProjectNamesDto = Readonly<Record<string, string>>;

export interface CacheGroupInventoryOptionsDto {
  readonly filters?: CacheInventoryFiltersDto | null;
  readonly context?: CacheWorkspaceContextDto | null;
  readonly projectNames?: CacheProjectNamesDto | null;
}

export interface CacheCategoryGroupDto {
  readonly category: CacheCategoryDto;
  readonly entries: readonly CacheEntryDto[];
  readonly primary: readonly CacheEntryDto[];
  readonly history: readonly CacheEntryDto[];
  readonly sizeBytes: number;
  readonly files: number;
  readonly busyCount: number;
  readonly currentCount: number;
}

export interface CacheProjectGroupDto {
  readonly key: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly current: boolean;
  readonly categories: readonly CacheCategoryGroupDto[];
  readonly entries: readonly CacheEntryDto[];
  readonly sizeBytes: number;
  readonly files: number;
  readonly busyCount: number;
  readonly currentCount: number;
  readonly historyCount: number;
  readonly lastUsedAtMs: number;
}

export interface CacheInventoryTotalsDto {
  readonly entries: number;
  readonly current: number;
  readonly available: number;
  readonly history: number;
  readonly busy: number;
  readonly writing: number;
  readonly sizeBytes: number;
  readonly files: number;
}

export interface CacheInventoryGroupsDto {
  readonly projects: readonly CacheProjectGroupDto[];
  readonly shared: readonly CacheCategoryGroupDto[];
  readonly services: readonly CacheCategoryGroupDto[];
  readonly totals: CacheInventoryTotalsDto;
}

export interface CacheInventoryProtocolError extends Error {
  readonly code: 'cache_inventory_protocol_error';
}

export interface CacheModelFacade {
  SCHEMA_VERSION: 2;
  CATEGORY_ORDER: CacheCategoryDto[];
  HISTORY_STATES: CacheHistoryStatesDto;
  normalizeEntry(raw: unknown): CacheEntryDto | null;
  normalizeInventory(raw: unknown): CacheInventoryDto;
  groupInventory(
    inventory: CacheInventoryDto | null | undefined,
    options?: CacheGroupInventoryOptionsDto | null
  ): CacheInventoryGroupsDto;
  compareEntries(a: CacheEntryDto, b: CacheEntryDto): number;
  workspaceMatches(
    entry: Pick<CacheEntryDto, 'workspaceId'> | null | undefined,
    context?: CacheWorkspaceContextDto | null
  ): boolean;
  isCurrentEnvironmentEntry(
    entry: CacheEntryDto | null | undefined,
    context?: CacheWorkspaceContextDto | null
  ): boolean;
  isServiceCategory(category: unknown): boolean;
}
