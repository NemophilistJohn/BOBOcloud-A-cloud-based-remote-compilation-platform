import type {
  CacheCapabilitiesDto,
  CacheCategoryDto,
  CacheCategoryGroupDto,
  CacheEntryDto,
  CacheGroupInventoryOptionsDto,
  CacheHistoryStatesDto,
  CacheInventoryDto,
  CacheInventoryFiltersDto,
  CacheInventoryGroupsDto,
  CacheInventoryProtocolError,
  CacheProjectGroupDto,
  CacheProjectNamesDto,
  CacheRawObjectDto,
  CacheWorkspaceContextDto
} from '../types/cache-model';

export const SCHEMA_VERSION = 2 as const;

const CORE_CATEGORY_ORDER = [
  'dependencies',
  'incremental',
  'results',
  'toolchains'
] as const;

export const CATEGORY_ORDER: readonly CacheCategoryDto[] = Object.freeze(
  CORE_CATEGORY_ORDER.slice()
);

export const HISTORY_STATES: CacheHistoryStatesDto = Object.freeze({
  superseded: true,
  orphaned: true,
  retired: true
});

const CATEGORY_RANKS = new Map<CacheCategoryDto, number>(
  CORE_CATEGORY_ORDER.map(
    (category, index): readonly [CacheCategoryDto, number] => [category, index]
  )
);
const SERVICE_CATEGORY_PATTERN = /(^|[-_.])(lsp|dap|analysis|debug)([-_.]|$)/i;
const hasOwn = Object.prototype.hasOwnProperty;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

interface MutableCacheCategoryGroup {
  category: CacheCategoryDto;
  entries: CacheEntryDto[];
  primary: CacheEntryDto[];
  history: CacheEntryDto[];
  sizeBytes: number;
  files: number;
  busyCount: number;
  currentCount: number;
}

interface MutableCacheProjectGroup {
  key: string;
  workspaceId: string;
  name: string;
  current: boolean;
  categoriesByName?: Record<string, MutableCacheCategoryGroup>;
  categories: MutableCacheCategoryGroup[];
  entries: CacheEntryDto[];
  sizeBytes: number;
  files: number;
  busyCount: number;
  currentCount: number;
  historyCount: number;
  lastUsedAtMs: number;
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function timestamp(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRawObject(value: unknown): value is CacheRawObjectDto {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCapabilities(value: unknown): CacheCapabilitiesDto {
  if (!isRawObject(value)) return {};
  const copy: CacheCapabilitiesDto = {};
  for (const key of Reflect.ownKeys(value)) {
    if (!propertyIsEnumerable.call(value, key)) continue;
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: value[key],
      writable: true
    });
  }
  return copy;
}

export function normalizeEntry(raw: unknown): CacheEntryDto | null {
  if (!isRawObject(raw)) return null;
  const id = text(raw.id).trim();
  const category = text(raw.category).trim().toLowerCase();
  if (!id || !category) return null;

  const state = text(raw.state || 'ready').trim().toLowerCase();
  const activeReaders = Math.max(0, Math.floor(finiteNumber(raw.active_readers)));
  const writing = raw.writing === true;
  const base = {
    schema: Number(raw.schema || SCHEMA_VERSION),
    id,
    category,
    state,
    workspaceId: text(raw.workspace_id),
    workspaceName: text(raw.workspace_name),
    runtimeId: text(raw.runtime_id),
    runtimeFingerprint: text(raw.runtime_fingerprint),
    toolchainFingerprint: text(raw.toolchain_fingerprint),
    language: text(raw.language).toLowerCase(),
    dependencyDigest: text(raw.dependency_digest),
    contentDigest: text(raw.content_digest),
    sourcePolicyDigest: text(raw.source_policy_digest),
    buildTarget: text(raw.build_target),
    profile: text(raw.profile),
    generation: text(raw.generation),
    sizeBytes: finiteNumber(raw.size_bytes),
    files: Math.max(0, Math.floor(finiteNumber(raw.files))),
    createdAt: text(raw.created_at),
    createdAtMs: timestamp(raw.created_at),
    lastUsedAt: text(raw.last_used_at),
    lastUsedAtMs: timestamp(raw.last_used_at),
    activeReaders,
    writing,
    lifecycle: raw.lifecycle == null ? null : raw.lifecycle,
    capabilities: normalizeCapabilities(raw.capabilities),
    raw
  };

  return {
    ...base,
    current: state === 'current',
    history: hasOwn.call(HISTORY_STATES, state),
    busy: writing || activeReaders > 0,
    service: isServiceCategory(category)
  };
}

export function normalizeInventory(raw: unknown): CacheInventoryDto {
  if (!isRawObject(raw)) {
    throw protocolError('Cache inventory is missing.');
  }
  if (Number(raw.schema) !== SCHEMA_VERSION) {
    throw protocolError('Unsupported cache inventory schema.');
  }

  let invalidEntries = 0;
  const entries: CacheEntryDto[] = [];
  const rawEntries = Array.isArray(raw.entries)
    ? raw.entries as unknown[]
    : [];
  rawEntries.forEach((source) => {
    const entry = normalizeEntry(source);
    if (entry) entries.push(entry);
    else invalidEntries += 1;
  });

  return {
    schema: SCHEMA_VERSION,
    ownerKind: text(raw.owner_kind),
    ownerId: text(raw.owner_id),
    quotaBytes: finiteNumber(raw.quota_bytes),
    usedBytes: finiteNumber(raw.used_bytes),
    managedBytes: finiteNumber(raw.managed_bytes),
    managedFiles: Math.max(0, Math.floor(finiteNumber(raw.managed_files))),
    reclaimableBytes: finiteNumber(raw.reclaimable_bytes),
    reservedBytes: finiteNumber(raw.reserved_bytes),
    quotaFiles: Math.max(0, Math.floor(finiteNumber(raw.quota_files))),
    usedFiles: Math.max(0, Math.floor(finiteNumber(raw.used_files))),
    reservedFiles: Math.max(0, Math.floor(finiteNumber(raw.reserved_files))),
    scanTruncated: raw.scan_truncated === true,
    generatedAt: text(raw.generated_at),
    generatedAtMs: timestamp(raw.generated_at),
    revision: raw.revision == null ? '' : text(raw.revision),
    lifecycle: raw.lifecycle == null ? null : raw.lifecycle,
    capabilities: normalizeCapabilities(raw.capabilities),
    invalidEntries,
    entries,
    raw
  };
}

function protocolError(message: string): CacheInventoryProtocolError {
  const error = new Error(message) as CacheInventoryProtocolError;
  Object.defineProperty(error, 'code', {
    configurable: true,
    enumerable: true,
    value: 'cache_inventory_protocol_error',
    writable: true
  });
  return error;
}

export function isServiceCategory(category: unknown): boolean {
  return SERVICE_CATEGORY_PATTERN.test(text(category));
}

function categoryRank(category: CacheCategoryDto): number {
  const rank = CATEGORY_RANKS.get(category);
  return rank === undefined ? CORE_CATEGORY_ORDER.length : rank;
}

function entryActivityRank(entry: CacheEntryDto): number {
  if (entry.writing) return 4;
  if (entry.activeReaders > 0) return 3;
  if (entry.current) return 2;
  if (!entry.history) return 1;
  return 0;
}

export function compareEntries(a: CacheEntryDto, b: CacheEntryDto): number {
  const activity = entryActivityRank(b) - entryActivityRank(a);
  if (activity) return activity;
  const used = b.lastUsedAtMs - a.lastUsedAtMs;
  if (used) return used;
  const size = b.sizeBytes - a.sizeBytes;
  if (size) return size;
  return a.id.localeCompare(b.id);
}

function compareCategories(
  a: MutableCacheCategoryGroup,
  b: MutableCacheCategoryGroup
): number {
  const rank = categoryRank(a.category) - categoryRank(b.category);
  return rank || a.category.localeCompare(b.category);
}

function workspaceIdMatchesCandidates(
  workspaceId: string,
  candidates: readonly string[]
): boolean {
  for (const candidate of candidates) {
    if (
      workspaceId === candidate ||
      workspaceId.endsWith('\u0000' + candidate) ||
      workspaceId.endsWith(':' + candidate)
    ) return true;
  }
  return false;
}

export function workspaceMatches(
  entry: Pick<CacheEntryDto, 'workspaceId'> | null | undefined,
  context?: CacheWorkspaceContextDto | null
): boolean {
  const workspaceId = text(entry && entry.workspaceId);
  if (!workspaceId) return false;
  const normalizedContext = context || {};
  const candidates = [normalizedContext.workspaceId, normalizedContext.folderKey]
    .map(text)
    .filter(Boolean);
  return workspaceIdMatchesCandidates(workspaceId, candidates);
}

export function isCurrentEnvironmentEntry(
  entry: CacheEntryDto | null | undefined,
  context?: CacheWorkspaceContextDto | null
): boolean {
  if (!entry || entry.category !== 'dependencies' || !entry.current) return false;
  if (!workspaceMatches(entry, context)) return false;
  const runtimeId = text(context && context.runtimeId);
  return Boolean(runtimeId && entry.runtimeId === runtimeId);
}

function newCategory(category: CacheCategoryDto): MutableCacheCategoryGroup {
  return {
    category,
    entries: [],
    primary: [],
    history: [],
    sizeBytes: 0,
    files: 0,
    busyCount: 0,
    currentCount: 0
  };
}

function addToCategory(
  category: MutableCacheCategoryGroup,
  entry: CacheEntryDto
): void {
  category.entries.push(entry);
  category.sizeBytes += entry.sizeBytes;
  category.files += entry.files;
  if (entry.busy) category.busyCount += 1;
  if (entry.current) category.currentCount += 1;
  if (entry.history) category.history.push(entry);
  else category.primary.push(entry);
}

function finalizeCategories(
  categoryMap: Record<string, MutableCacheCategoryGroup>
): MutableCacheCategoryGroup[] {
  return Object.keys(categoryMap).map((categoryName) => {
    const category = categoryMap[categoryName]!;
    category.entries.sort(compareEntries);
    category.primary.sort(compareEntries);
    category.history.sort(compareEntries);
    return category;
  }).sort(compareCategories);
}

function projectKey(entry: CacheEntryDto): string {
  if (entry.workspaceId) return 'workspace:' + entry.workspaceId;
  return 'unattributed:' + (entry.workspaceName || entry.id);
}

function ownProjectName(
  projectNames: CacheProjectNamesDto,
  workspaceId: string
): string | undefined {
  if (!workspaceId || !hasOwn.call(projectNames, workspaceId)) return undefined;
  return projectNames[workspaceId];
}

function addProjectEntry(
  projectsByKey: Record<string, MutableCacheProjectGroup>,
  entry: CacheEntryDto,
  context: CacheWorkspaceContextDto,
  projectNames: CacheProjectNamesDto
): void {
  const key = projectKey(entry);
  let project = projectsByKey[key];
  if (!project) {
    const mappedName = ownProjectName(projectNames, entry.workspaceId);
    project = projectsByKey[key] = {
      key,
      workspaceId: entry.workspaceId,
      name: entry.workspaceName || mappedName || '',
      current: workspaceMatches(entry, context),
      categoriesByName: Object.create(null) as Record<string, MutableCacheCategoryGroup>,
      categories: [],
      entries: [],
      sizeBytes: 0,
      files: 0,
      busyCount: 0,
      currentCount: 0,
      historyCount: 0,
      lastUsedAtMs: 0
    };
  }
  if (!project.name && entry.workspaceName) project.name = entry.workspaceName;
  project.entries.push(entry);
  project.sizeBytes += entry.sizeBytes;
  project.files += entry.files;
  if (entry.busy) project.busyCount += 1;
  if (entry.current) project.currentCount += 1;
  if (entry.history) project.historyCount += 1;
  project.lastUsedAtMs = Math.max(project.lastUsedAtMs, entry.lastUsedAtMs);
  const categoriesByName = project.categoriesByName!;
  let category = categoriesByName[entry.category];
  if (!category) {
    category = categoriesByName[entry.category] = newCategory(entry.category);
  }
  addToCategory(category, entry);
}

function compareProjects(
  a: MutableCacheProjectGroup,
  b: MutableCacheProjectGroup
): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  if (Boolean(a.busyCount) !== Boolean(b.busyCount)) return a.busyCount ? -1 : 1;
  if (Boolean(a.currentCount) !== Boolean(b.currentCount)) return a.currentCount ? -1 : 1;
  if (b.lastUsedAtMs !== a.lastUsedAtMs) return b.lastUsedAtMs - a.lastUsedAtMs;
  if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return (a.name || a.workspaceId).localeCompare(b.name || b.workspaceId);
}

function includeEntry(
  entry: CacheEntryDto,
  filters: CacheInventoryFiltersDto,
  context: CacheWorkspaceContextDto
): boolean {
  if (
    filters.category &&
    filters.category !== 'all' &&
    entry.category !== filters.category
  ) return false;
  if (filters.scope === 'current' && !workspaceMatches(entry, context)) return false;
  if (
    filters.scope === 'projects' &&
    ((!entry.workspaceId && !entry.workspaceName) || entry.service)
  ) return false;
  if (
    filters.scope === 'shared' &&
    (entry.workspaceId || entry.workspaceName || entry.service)
  ) return false;
  if (filters.scope === 'services' && !entry.service) return false;
  return true;
}

export function groupInventory(
  inventory: CacheInventoryDto | null | undefined,
  options?: CacheGroupInventoryOptionsDto | null
): CacheInventoryGroupsDto {
  const normalizedOptions = options || {};
  const filters = normalizedOptions.filters || {};
  const context = normalizedOptions.context || {};
  const projectNames = normalizedOptions.projectNames || {};
  const projectsByKey = Object.create(null) as Record<string, MutableCacheProjectGroup>;
  const sharedByCategory = Object.create(null) as Record<string, MutableCacheCategoryGroup>;
  const servicesByCategory = Object.create(null) as Record<string, MutableCacheCategoryGroup>;
  const totals = {
    entries: 0,
    current: 0,
    available: 0,
    history: 0,
    busy: 0,
    writing: 0,
    sizeBytes: 0,
    files: 0
  };

  const entries: readonly CacheEntryDto[] = inventory && Array.isArray(inventory.entries)
    ? inventory.entries
    : [];
  entries.forEach((entry) => {
    if (!includeEntry(entry, filters, context)) return;
    totals.entries += 1;
    totals.sizeBytes += entry.sizeBytes;
    totals.files += entry.files;
    if (entry.current) totals.current += 1;
    else if (entry.history) totals.history += 1;
    else totals.available += 1;
    if (entry.busy) totals.busy += 1;
    if (entry.writing) totals.writing += 1;

    if (entry.service) {
      let category = servicesByCategory[entry.category];
      if (!category) {
        category = servicesByCategory[entry.category] = newCategory(entry.category);
      }
      addToCategory(category, entry);
    } else if (entry.workspaceId || entry.workspaceName) {
      addProjectEntry(projectsByKey, entry, context, projectNames);
    } else {
      let category = sharedByCategory[entry.category];
      if (!category) {
        category = sharedByCategory[entry.category] = newCategory(entry.category);
      }
      addToCategory(category, entry);
    }
  });

  const projects = Object.keys(projectsByKey).map((key) => {
    const project = projectsByKey[key]!;
    project.categories = finalizeCategories(project.categoriesByName!);
    delete project.categoriesByName;
    project.entries.sort(compareEntries);
    return project;
  }).sort(compareProjects);

  return {
    projects: projects as CacheProjectGroupDto[],
    shared: finalizeCategories(sharedByCategory) as CacheCategoryGroupDto[],
    services: finalizeCategories(servicesByCategory) as CacheCategoryGroupDto[],
    totals
  };
}
