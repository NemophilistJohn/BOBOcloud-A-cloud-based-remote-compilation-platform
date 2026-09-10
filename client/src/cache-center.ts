import type {
  CacheCenterConfirmPort,
  CacheCenterDependencies,
  CacheCenterFilterScopeDto,
  CacheCenterFiltersDto,
  CacheCenterService,
  CacheCenterStore
} from '../types/cache-center';
import type {
  CacheCategoryGroupDto,
  CacheEntryDto,
  CacheInventoryDto,
  CacheInventoryGroupsDto,
  CacheProjectGroupDto,
  CacheProjectNamesDto,
  CacheWorkspaceContextDto
} from '../types/cache-model';
import type {
  CacheStoreClearScopeRequestDto,
  CacheStoreLoadOptionsDto,
  CacheStoreSnapshotDto
} from '../types/cache-store';
import type { Dispose } from '../types/lifecycle';

export const CACHE_CENTER_SERVICE_ID = 'workbench.cacheCenter' as const;

const STATE_LABELS = new Map<string, string>([
  ['current', 'Current'],
  ['ready', 'Available'],
  ['superseded', 'Superseded'],
  ['orphaned', 'Orphaned'],
  ['retired', 'Retired']
]);

const CATEGORY_LABELS = new Map<string, string>([
  ['dependencies', 'Dependencies'],
  ['incremental', 'Incremental builds'],
  ['results', 'Build results'],
  ['toolchains', 'Toolchains']
]);

interface MutableFilters {
  scope: CacheCenterFilterScopeDto;
  category: string;
}

interface MutableDetailState {
  open: boolean;
  loading: boolean;
  entry: CacheEntryDto | null;
  error: string;
}

interface DetailRequestToken {
  readonly epoch: number;
  readonly sequence: number;
  readonly operation: OperationIntent;
}

interface OperationIntent {
  readonly epoch: number;
  readonly identity: string;
  readonly store: CacheCenterStore;
  readonly storeIdentity: string;
}

interface NormalTotals {
  entries: number;
  sizeBytes: number;
  current: number;
  history: number;
  busy: number;
}

interface ClosestTarget {
  closest(selector: string): Element | null;
}

function copyProjectNames(names?: CacheProjectNamesDto | null): CacheProjectNamesDto {
  const result = Object.create(null) as Record<string, string>;
  if (!names || typeof names !== 'object') return result;
  let keys: string[];
  try {
    keys = Object.keys(names);
  } catch (_) {
    return result;
  }
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(names, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) continue;
      result[key] = descriptor.value as string;
    } catch (_) {
      // Ignore properties that cannot be inspected without invoking user code.
    }
  }
  return result;
}

export function createCacheCenterService(
  dependencies: CacheCenterDependencies
): CacheCenterService {
  const documentRef = dependencies.document;
  const state = dependencies.state;
  const model = dependencies.model;
  let initialized = false;
  let initializing = false;
  let disposed = false;
  let visible = false;
  let unsubscribe: Dispose | null = null;
  let boundRoot: HTMLElement | null = null;
  let activeStore: CacheCenterStore | null = null;
  let renderedRoot: HTMLElement | null = null;
  let renderedMarkup: string | null = null;
  let projectNames: CacheProjectNamesDto = copyProjectNames();
  const filters: MutableFilters = { scope: 'all', category: 'all' };
  const expandedProjects = Object.create(null) as Record<string, boolean>;
  const expandedHistory = Object.create(null) as Record<string, boolean>;
  let details = Object.create(null) as Record<string, MutableDetailState>;
  const detailRequests = new Map<string, DetailRequestToken>();
  let detailEpoch = 0;
  let detailSequence = 0;
  let lifecycleEpoch = 0;

  function currentStore(): CacheCenterStore {
    return dependencies.getStore();
  }

  function contextIdentity(): string {
    const auth = state.auth || {};
    const server = state.serverSettings || {};
    const user = auth.user || {};
    return [
      server.ip || '',
      auth.token || '',
      user.id || user.uid || '',
      state.workspaceIdentity || '',
      state.workspaceRoot || '',
      state.selectedRuntime || ''
    ].join('\n');
  }

  function captureOperationIntent(): OperationIntent {
    const store = currentStore();
    return {
      epoch: lifecycleEpoch,
      identity: contextIdentity(),
      store,
      storeIdentity: store.getState().identity
    };
  }

  function operationIntentCurrent(intent: OperationIntent): boolean {
    if (disposed || intent.epoch !== lifecycleEpoch) return false;
    try {
      return currentStore() === intent.store &&
        contextIdentity() === intent.identity &&
        intent.store.getState().identity === intent.storeIdentity;
    } catch (_) {
      return false;
    }
  }

  function inventoryRevisionCurrent(intent: OperationIntent, revision: string): boolean {
    if (!operationIntentCurrent(intent)) return false;
    try {
      return (intent.store.getState().inventory?.revision || '') === revision;
    } catch (_) {
      return false;
    }
  }

  function byId(id: string): HTMLElement | null {
    return documentRef.getElementById(id);
  }

  function t(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, (match, key: string) => (
      replacements && replacements[key] !== undefined ? replacements[key] as string : match
    ));
  }

  function esc(value: unknown): string {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(bytes: unknown): string {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return Math.round(value) + ' B';
    if (value < 1048576) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MB';
    return (value / 1073741824).toFixed(2) + ' GB';
  }

  function locale(): string {
    const i18n = dependencies.getI18n();
    const active = i18n && i18n.getActive ? i18n.getActive() : 'en';
    return active === 'ja' ? 'ja-JP' : active === 'zh-CN' ? 'zh-CN' : 'en-US';
  }

  function formatDate(value: CacheEntryDto | number): string {
    const timestamp = typeof value === 'object' && value
      ? (value.lastUsedAtMs != null ? value.lastUsedAtMs : 0)
      : Number(value) || 0;
    if (!timestamp) return t('Never used');
    try {
      return new Intl.DateTimeFormat(locale(), {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (_) {
      return new Date(timestamp).toLocaleString();
    }
  }

  function icon(name: string): string {
    const icons = dependencies.getIcons();
    return icons && icons[name] || '';
  }

  function iconButton(
    action: string,
    iconName: string,
    label: string,
    attributes?: string,
    disabled?: boolean
  ): string {
    return '<button type="button" class="cache-v2-icon-btn" data-cache-action="' + esc(action) + '" ' + (attributes || '') +
      ' aria-label="' + esc(label) + '" title="' + esc(label) + '" data-tooltip="' + esc(label) + '"' +
      (disabled ? ' disabled' : '') + '>' + icon(iconName) + '</button>';
  }

  function stateLabel(entry: CacheEntryDto): string {
    return t(STATE_LABELS.get(entry.state) || 'Available');
  }

  function categoryLabel(category: string): string {
    if (model.isServiceCategory(category)) return category;
    return t(CATEGORY_LABELS.get(category) || 'Other cache');
  }

  function categoryIcon(category: string): string {
    if (category === 'dependencies' || category === 'toolchains') return 'package';
    if (category === 'results') return 'fileText';
    if (category === 'incremental') return 'history';
    return 'file';
  }

  function currentContext(): CacheWorkspaceContextDto {
    const root = String(state.workspaceRoot || '');
    const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return {
      workspaceId: state.workspaceIdentity == null ? '' : String(state.workspaceIdentity),
      folderKey: root ? dependencies.projectKey(root) : '',
      workspaceName: parts.length ? parts[parts.length - 1] : '',
      runtimeId: String(state.selectedRuntime || '')
    };
  }

  function cacheRoot(): HTMLElement | null {
    return byId('cache-tree');
  }

  function isMutating(storeState: CacheStoreSnapshotDto, prefix?: string): boolean {
    return Object.keys(storeState.mutations || {}).some((key) => !prefix || key.indexOf(prefix) === 0);
  }

  function safeErrorMessage(error: unknown, fallback: string): string {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      try {
        const message = (error as { readonly message?: unknown }).message;
        if (message) return String(message);
      } catch (_) {
        // Fall through to the localized fallback.
      }
    }
    return fallback;
  }

  function notify(kind: 'success' | 'error', message: string): void {
    try {
      const toast = dependencies.getToast();
      const handler = toast && toast[kind];
      if (typeof handler === 'function') {
        handler.call(toast, message);
        return;
      }
    } catch (_) {
      // A presentation failure must not change the outcome of a cache mutation.
    }
    if (kind === 'error' && typeof dependencies.alert === 'function') {
      try { dependencies.alert(message); } catch (_) {}
    }
  }

  function canDelete(inventory: CacheInventoryDto, entry: CacheEntryDto): boolean {
    if (entry.writing) return false;
    if (inventory.capabilities && inventory.capabilities.delete === false) return false;
    return !entry.capabilities || entry.capabilities.delete !== false;
  }

  function detailValue(value: unknown): string {
    return value ? '<code>' + esc(value) + '</code>' : '<span>' + esc(t('Not available')) + '</span>';
  }

  function renderEntryDetails(entry: CacheEntryDto): string {
    const rows: Array<readonly [string, unknown]> = [
      [t('Created'), entry.createdAtMs ? formatDate(entry.createdAtMs) : t('Not available')],
      [t('Runtime fingerprint'), entry.runtimeFingerprint],
      [t('Toolchain fingerprint'), entry.toolchainFingerprint],
      [t('Dependency digest'), entry.dependencyDigest],
      [t('Content digest'), entry.contentDigest],
      [t('Build target'), entry.buildTarget],
      [t('Profile'), entry.profile],
      [t('Generation'), entry.generation]
    ];
    const visibleRows = rows.filter((row) => Boolean(row[1]));
    if (!visibleRows.length) return '<div class="cache-v2-detail-empty">' + esc(t('No additional cache details.')) + '</div>';
    return '<dl class="cache-v2-details-grid">' + visibleRows.map((row) => (
      '<div><dt>' + esc(row[0]) + '</dt><dd>' + detailValue(row[1]) + '</dd></div>'
    )).join('') + '</dl>';
  }

  function entryTitle(entry: CacheEntryDto): string {
    if (entry.category === 'dependencies') return entry.runtimeId || entry.language || t('Dependency set');
    if (entry.category === 'incremental') return entry.buildTarget || entry.runtimeId || t('Incremental build');
    if (entry.category === 'results') return entry.buildTarget || entry.runtimeId || t('Build result');
    if (entry.category === 'toolchains') return entry.runtimeId || entry.language || t('Toolchain');
    return entry.runtimeId || entry.buildTarget || t('Cache entry');
  }

  function entryDigest(entry: CacheEntryDto): string {
    const digest = entry.dependencyDigest || entry.contentDigest || entry.toolchainFingerprint || entry.runtimeFingerprint;
    return digest ? digest.slice(0, 12) : '';
  }

  function renderEntry(
    entry: CacheEntryDto,
    inventory: CacheInventoryDto,
    storeState: CacheStoreSnapshotDto,
    context: CacheWorkspaceContextDto,
    serviceOnly: boolean
  ): string {
    const detailState = details[entry.id];
    const detailEntry = detailState && detailState.entry || entry;
    const detailOpen = Boolean(detailState && detailState.open);
    const detailPanelId = 'cache-v2-detail-' + entry.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    const deleting = Boolean(storeState.mutations['delete:' + entry.id]);
    const deleteAllowed = !serviceOnly && canDelete(inventory, entry);
    const deleteLabel = entry.writing ? t('Cache is being updated') : t('Delete cache entry');
    const manage = !serviceOnly && model.isCurrentEnvironmentEntry(entry, context);
    const meta: string[] = [];
    if (entry.language) meta.push('<span>' + esc(entry.language) + '</span>');
    if (entry.runtimeId && entryTitle(entry) !== entry.runtimeId) meta.push('<span>' + esc(entry.runtimeId) + '</span>');
    if (entryDigest(entry)) meta.push('<code>' + esc(entryDigest(entry)) + '</code>');
    if (entry.profile) meta.push('<span>' + esc(entry.profile) + '</span>');

    let status = '<span class="cache-v2-state state-' + esc(entry.state) + '">' + esc(stateLabel(entry)) + '</span>';
    if (entry.writing) status += '<span class="cache-v2-activity writing">' + esc(t('Updating')) + '</span>';
    else if (entry.activeReaders > 0) status += '<span class="cache-v2-activity">' + esc(t('{count} readers', { count: entry.activeReaders })) + '</span>';

    let actions = iconButton('details', detailOpen ? 'eyeOff' : 'eye', detailOpen ? t('Hide cache details') : t('Show cache details'),
      'data-cache-id="' + esc(entry.id) + '" aria-expanded="' + (detailOpen ? 'true' : 'false') + '" aria-controls="' + esc(detailPanelId) + '"',
      Boolean(detailState && detailState.loading));
    if (manage) actions += iconButton('packages', 'package', t('Manage libraries'), 'data-cache-id="' + esc(entry.id) + '"');
    if (!serviceOnly) actions += iconButton('delete', 'trash', deleteLabel,
      'data-cache-id="' + esc(entry.id) + '"', deleting || !deleteAllowed);

    let detailHtml = '';
    if (detailOpen) {
      if (detailState && detailState.loading) detailHtml = '<div class="cache-v2-entry-detail" id="' + esc(detailPanelId) + '">' + esc(t('Loading...')) + '</div>';
      else if (detailState && detailState.error) detailHtml = '<div class="cache-v2-entry-detail error" id="' + esc(detailPanelId) + '">' + esc(detailState.error) + '</div>';
      else detailHtml = '<div class="cache-v2-entry-detail" id="' + esc(detailPanelId) + '">' + renderEntryDetails(detailEntry) + '</div>';
    }

    return '<div class="cache-v2-entry' + (entry.current ? ' is-current' : '') + (entry.busy ? ' is-busy' : '') + '" data-cache-entry="' + esc(entry.id) + '">' +
      '<div class="cache-v2-entry-main">' +
        '<span class="cache-v2-entry-identity"><strong>' + esc(entryTitle(entry)) + '</strong><small>' + (meta.join('') || esc(t('No cache metadata'))) + '</small></span>' +
        '<span class="cache-v2-entry-status">' + status + '</span>' +
        '<span class="cache-v2-entry-used"><small>' + esc(t('Last used')) + '</small><span>' + esc(formatDate(entry)) + '</span></span>' +
        '<span class="cache-v2-entry-size"><strong>' + fmt(entry.sizeBytes) + '</strong><small>' + esc(t('{count} files', { count: entry.files })) + '</small></span>' +
        '<span class="cache-v2-entry-actions">' + actions + '</span>' +
      '</div>' + detailHtml + '</div>';
  }

  function renderCategory(
    category: CacheCategoryGroupDto,
    inventory: CacheInventoryDto,
    storeState: CacheStoreSnapshotDto,
    context: CacheWorkspaceContextDto,
    prefix: string,
    serviceOnly: boolean
  ): string {
    const historyId = prefix + '-history-' + category.category.replace(/[^a-zA-Z0-9_-]/g, '-');
    const historyOpen = Boolean(expandedHistory[historyId]);
    const primary = category.primary.map((entry) => renderEntry(entry, inventory, storeState, context, serviceOnly)).join('');
    let history = '';
    if (category.history.length) {
      history = '<button type="button" class="cache-v2-history-toggle" data-cache-action="history" data-history-id="' + esc(historyId) +
        '" aria-expanded="' + (historyOpen ? 'true' : 'false') + '" aria-controls="' + esc(historyId) + '">' +
        '<span class="cache-v2-chevron">' + icon('chevronRight') + '</span>' +
        '<span>' + esc(t('History ({count})', { count: category.history.length })) + '</span></button>' +
        '<div class="cache-v2-history' + (historyOpen ? ' open' : '') + '" id="' + esc(historyId) + '">' +
          category.history.map((entry) => renderEntry(entry, inventory, storeState, context, serviceOnly)).join('') + '</div>';
    }
    return '<section class="cache-v2-category" data-cache-category="' + esc(category.category) + '">' +
      '<header class="cache-v2-category-head"><span>' + icon(categoryIcon(category.category)) + '</span><strong>' + esc(categoryLabel(category.category)) +
      '</strong><small>' + esc(t('{count} entries', { count: category.entries.length })) + ' / ' + fmt(category.sizeBytes) + '</small></header>' +
      '<div class="cache-v2-category-body">' + primary + history + '</div></section>';
  }

  function projectDisplayName(project: CacheProjectGroupDto, context: CacheWorkspaceContextDto): string {
    if (project.name) return project.name;
    if (project.current && context.workspaceName) return String(context.workspaceName);
    return t('Unattributed project cache');
  }

  function renderProject(
    project: CacheProjectGroupDto,
    index: number,
    inventory: CacheInventoryDto,
    storeState: CacheStoreSnapshotDto,
    context: CacheWorkspaceContextDto
  ): string {
    const expanded = Object.prototype.hasOwnProperty.call(expandedProjects, project.key)
      ? expandedProjects[project.key]
      : (project.current || index === 0);
    const panelId = 'cache-v2-project-' + index;
    const clearDisabled = project.busyCount > 0 || isMutating(storeState) || inventory.capabilities.clear === false;
    const clearLabel = project.busyCount ? t('Cache is in use') : t('Clear project cache');
    return '<section class="cache-v2-project' + (project.current ? ' is-current' : '') + '" data-cache-project="' + esc(project.key) + '">' +
      '<div class="cache-v2-project-head">' +
        '<button type="button" class="cache-v2-project-toggle" data-cache-action="project" data-project-key="' + esc(project.key) + '" aria-expanded="' +
          (expanded ? 'true' : 'false') + '" aria-controls="' + panelId + '">' +
          '<span class="cache-v2-chevron">' + icon('chevronRight') + '</span><span class="cache-v2-project-icon">' + icon('folder') + '</span>' +
          '<span class="cache-v2-project-name"><strong>' + esc(projectDisplayName(project, context)) + '</strong><small>' +
            esc(t('{count} cache entries', { count: project.entries.length })) + '</small></span>' +
          (project.current ? '<span class="cache-v2-current-project">' + esc(t('Current project')) + '</span>' : '') +
          '<span class="cache-v2-project-size">' + fmt(project.sizeBytes) + '</span>' +
        '</button>' +
        iconButton('clear-project', 'trash', clearLabel, 'data-workspace-id="' + esc(project.workspaceId) + '" data-project-name="' + esc(projectDisplayName(project, context)) + '"', clearDisabled || !project.workspaceId) +
      '</div>' +
      '<div class="cache-v2-project-body' + (expanded ? ' open' : '') + '" id="' + panelId + '">' +
        project.categories.map((category) => renderCategory(category, inventory, storeState, context, 'project-' + index, false)).join('') +
      '</div></section>';
  }

  function renderShared(
    categories: readonly CacheCategoryGroupDto[],
    inventory: CacheInventoryDto,
    storeState: CacheStoreSnapshotDto,
    context: CacheWorkspaceContextDto
  ): string {
    if (!categories.length) return '';
    return '<section class="cache-v2-section cache-v2-shared"><header class="cache-v2-section-head"><span>' + icon('cloud') + '</span><strong>' +
      esc(t('Shared cache')) + '</strong><small>' + esc(t('{count} types', { count: categories.length })) + '</small></header>' +
      categories.map((category, index) => renderCategory(category, inventory, storeState, context, 'shared-' + index, false)).join('') + '</section>';
  }

  function renderServices(
    categories: readonly CacheCategoryGroupDto[],
    inventory: CacheInventoryDto,
    storeState: CacheStoreSnapshotDto,
    context: CacheWorkspaceContextDto
  ): string {
    if (!categories.length) return '';
    return '<section class="cache-v2-section cache-v2-services"><header class="cache-v2-section-head"><span>' + icon('shield') + '</span><span><strong>' +
      esc(t('Service caches')) + '</strong><small>' + esc(t('Language and debug services are isolated from ordinary caches.')) + '</small></span></header>' +
      categories.map((category, index) => renderCategory(category, inventory, storeState, context, 'service-' + index, true)).join('') + '</section>';
  }

  function categoryOptions(inventory: CacheInventoryDto): string[] {
    const names = Object.create(null) as Record<string, true>;
    model.CATEGORY_ORDER.forEach((category) => { names[category] = true; });
    inventory.entries.forEach((entry) => { if (!entry.service) names[entry.category] = true; });
    return Object.keys(names).sort((a, b) => {
      const order = model.CATEGORY_ORDER;
      let ai = order.indexOf(a);
      let bi = order.indexOf(b);
      ai = ai < 0 ? order.length : ai;
      bi = bi < 0 ? order.length : bi;
      return ai - bi || a.localeCompare(b);
    });
  }

  function normalTotals(grouped: CacheInventoryGroupsDto): NormalTotals {
    const categories = grouped.projects
      .reduce<CacheCategoryGroupDto[]>((all, project) => all.concat(project.categories), [])
      .concat(grouped.shared);
    return categories.reduce<NormalTotals>((total, category) => {
      total.entries += category.entries.length;
      total.sizeBytes += category.sizeBytes;
      total.current += category.currentCount;
      total.history += category.history.length;
      total.busy += category.busyCount;
      return total;
    }, { entries: 0, sizeBytes: 0, current: 0, history: 0, busy: 0 });
  }

  function renderReady(storeState: CacheStoreSnapshotDto): string {
    const inventory = storeState.inventory!;
    const context = currentContext();
    const grouped = model.groupInventory(inventory, { filters, context, projectNames });
    const totals = normalTotals(grouped);
    const quota = inventory.quotaBytes;
    const accountUsed = inventory.usedBytes;
    const managed = inventory.raw && inventory.raw.managed_bytes != null ? inventory.managedBytes : totals.sizeBytes;
    const percent = quota > 0 ? Math.min(100, Math.round(accountUsed / quota * 100)) : 0;
    const categories = categoryOptions(inventory);
    const scopeOptions: Array<readonly [CacheCenterFilterScopeDto, string]> = [
      ['all', t('All cache')], ['current', t('Current project')], ['shared', t('Shared cache')]
    ];
    if (inventory.entries.some((entry) => entry.service)) scopeOptions.push(['services', t('Service caches')]);
    const clearDisabled = filters.scope === 'services' || totals.entries === 0 || totals.busy > 0 || isMutating(storeState) || inventory.capabilities.clear === false;
    const clearLabel = filters.scope === 'services' ? t('Service caches are managed separately') : totals.busy > 0 ? t('Cache is in use') : t('Clear selected cache');
    let warning = '';
    if (inventory.scanTruncated) warning += '<div class="cache-v2-notice warning">' + esc(t('The cache scan was truncated. Totals may be incomplete.')) + '</div>';
    if (inventory.invalidEntries) warning += '<div class="cache-v2-notice warning">' + esc(t('{count} invalid cache entries were omitted.', { count: inventory.invalidEntries })) + '</div>';

    let html = '<div class="cache-v2-shell">' +
      '<div class="cache-v2-overview">' +
        '<div class="cache-v2-usage"><span><small>' + esc(t('Cache storage')) + '</small><strong>' + fmt(managed) + '</strong></span>' +
          '<div class="cache-v2-meter" role="progressbar" aria-label="' + esc(t('Account storage quota')) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><span style="width:' + percent + '%"></span></div>' +
          '<small>' + esc(quota ? t('Account storage {used} / {quota}', { used: fmt(accountUsed), quota: fmt(quota) }) : t('Account storage {used}', { used: fmt(accountUsed) })) +
          (inventory.reservedBytes ? ' · ' + esc(t('{size} reserved', { size: fmt(inventory.reservedBytes) })) : '') +
          (inventory.reclaimableBytes ? ' · ' + esc(t('{size} reclaimable', { size: fmt(inventory.reclaimableBytes) })) : '') + '</small></div>' +
        '<div class="cache-v2-metrics"><span><strong>' + totals.entries + '</strong><small>' + esc(t('Entries')) + '</small></span>' +
          '<span><strong>' + totals.current + '</strong><small>' + esc(t('Current')) + '</small></span>' +
          '<span><strong>' + totals.history + '</strong><small>' + esc(t('History')) + '</small></span>' +
          '<span class="' + (totals.busy ? 'active' : '') + '"><strong>' + totals.busy + '</strong><small>' + esc(t('In use')) + '</small></span></div>' +
      '</div>' +
      '<div class="cache-v2-toolbar">' +
        '<label><span class="cache-v2-sr-only">' + esc(t('Cache scope')) + '</span><select id="cache-v2-scope" aria-label="' + esc(t('Cache scope')) + '">' +
          scopeOptions.map((option) => '<option value="' + option[0] + '"' + (filters.scope === option[0] ? ' selected' : '') + '>' + esc(option[1]) + '</option>').join('') + '</select></label>' +
        '<label><span class="cache-v2-sr-only">' + esc(t('Cache type')) + '</span><select id="cache-v2-category" aria-label="' + esc(t('Cache type')) + '">' +
          '<option value="all">' + esc(t('All cache types')) + '</option>' + categories.map((category) => (
            '<option value="' + esc(category) + '"' + (filters.category === category ? ' selected' : '') + '>' + esc(categoryLabel(category)) + '</option>'
          )).join('') + '</select></label>' +
        '<span class="cache-v2-toolbar-spacer"></span>' +
        iconButton('refresh', 'history', t('Refresh cache inventory'), '', storeState.status === 'refreshing' || isMutating(storeState)) +
        iconButton('clear', 'trash', clearLabel, '', clearDisabled) +
      '</div>' + warning +
      '<div class="cache-v2-content">';

    if (grouped.projects.length) {
      html += '<section class="cache-v2-section"><header class="cache-v2-section-head"><span>' + icon('folderOpen') + '</span><strong>' + esc(t('Project caches')) +
        '</strong><small>' + esc(t('{count} projects', { count: grouped.projects.length })) + '</small></header>' +
        grouped.projects.map((project, index) => renderProject(project, index, inventory, storeState, context)).join('') + '</section>';
    }
    html += renderShared(grouped.shared, inventory, storeState, context);
    html += renderServices(grouped.services, inventory, storeState, context);
    if (!grouped.projects.length && !grouped.shared.length && !grouped.services.length) {
      html += '<div class="cache-v2-empty"><span>' + icon('package') + '</span><strong>' + esc(t('No matching cache entries.')) + '</strong><small>' +
        esc(t('Run or build this project to populate its cache.')) + '</small></div>';
    }
    return html + '</div></div>';
  }

  function render(): void {
    const root = cacheRoot();
    if (!root) return;
    const storeState = currentStore().getState();
    let markup: string;
    if ((storeState.status === 'loading' || storeState.status === 'idle') && !storeState.inventory) {
      markup = '<div class="cache-v2-status"><span class="cache-v2-spinner" aria-hidden="true"></span><strong>' + esc(t('Loading cache inventory...')) + '</strong></div>';
    } else if (storeState.status === 'error' && !storeState.inventory) {
      markup = '<div class="cache-v2-status error"><strong>' + esc(t('Cache inventory is unavailable.')) + '</strong><small>' + esc(safeErrorMessage(storeState.error, t('Failed to load'))) + '</small>' +
        iconButton('refresh', 'history', t('Try again'), '', false) + '</div>';
    } else if (!storeState.inventory) {
      markup = '<div class="cache-v2-status"><strong>' + esc(t('No cache inventory.')) + '</strong></div>';
    } else {
      markup = renderReady(storeState);
    }
    if (renderedRoot === root && renderedMarkup === markup && root.innerHTML === markup) return;
    root.innerHTML = markup;
    renderedRoot = root;
    renderedMarkup = markup;
  }

  function detailRequestCurrent(cacheId: string, token: DetailRequestToken): boolean {
    const current = details[cacheId];
    return token.epoch === detailEpoch &&
      detailRequests.get(cacheId) === token &&
      operationIntentCurrent(token.operation) &&
      Boolean(current && current.open);
  }

  function invalidateDetailRequest(cacheId: string): void {
    detailRequests.delete(cacheId);
  }

  function invalidateAllDetailRequests(): void {
    detailEpoch += 1;
    detailRequests.clear();
  }

  async function showDetails(cacheId: string): Promise<void> {
    const current = details[cacheId];
    if (current && current.open) {
      invalidateDetailRequest(cacheId);
      current.open = false;
      current.loading = false;
      render();
      return;
    }
    const operation = captureOperationIntent();
    const token: DetailRequestToken = {
      epoch: detailEpoch,
      sequence: ++detailSequence,
      operation
    };
    detailRequests.set(cacheId, token);
    details[cacheId] = { open: true, loading: true, entry: current && current.entry || null, error: '' };
    render();
    try {
      const entry = await operation.store.getEntry(cacheId);
      if (!detailRequestCurrent(cacheId, token)) return;
      details[cacheId] = { open: true, loading: false, entry, error: '' };
    } catch (error) {
      if (!detailRequestCurrent(cacheId, token)) return;
      details[cacheId] = {
        open: true,
        loading: false,
        entry: null,
        error: safeErrorMessage(error, t('Failed to load'))
      };
    }
    if (detailRequests.get(cacheId) === token) detailRequests.delete(cacheId);
    render();
  }

  function getConfirmOrThrow(fallback: string): CacheCenterConfirmPort {
    const confirm = dependencies.getConfirm();
    if (typeof confirm !== 'function') throw new Error(fallback);
    return confirm;
  }

  async function deleteEntry(cacheId: string): Promise<void> {
    const operation = captureOperationIntent();
    const inventory = operation.store.getState().inventory;
    const entry = inventory && inventory.entries.find((candidate) => candidate.id === cacheId);
    if (!entry || !inventory || !canDelete(inventory, entry)) return;
    const revision = inventory.revision || '';
    let message = t('Delete "{name}" from this cache?', { name: entryTitle(entry) }) + '\n' +
      t('The complete cache entry and its registration will be removed. This cannot be undone.');
    if (entry.activeReaders > 0) message += '\n' + t('{count} active readers may need to restart.', { count: entry.activeReaders });
    try {
      const confirmed = await getConfirmOrThrow(t('Failed to delete cache entry.'))({
        title: t('Delete cache entry'),
        message,
        confirmLabel: t('Delete'),
        danger: true
      });
      if (!confirmed || !inventoryRevisionCurrent(operation, revision)) return;
      await operation.store.deleteEntry(cacheId);
      if (!operationIntentCurrent(operation)) return;
      invalidateDetailRequest(cacheId);
      delete details[cacheId];
      notify('success', t('Cache entry deleted.'));
    } catch (error) {
      if (operationIntentCurrent(operation)) {
        notify('error', safeErrorMessage(error, t('Failed to delete cache entry.')));
      }
    }
  }

  function filteredClearRequest(
    store: CacheCenterStore,
    workspaceId: string
  ): CacheStoreClearScopeRequestDto | null {
    let request: CacheStoreClearScopeRequestDto;
    if (workspaceId) request = { scope: 'workspace', workspaceId };
    else if (filters.scope === 'shared') request = { scope: 'shared' };
    else if (filters.scope === 'current') {
      const grouped = model.groupInventory(store.getState().inventory, { context: currentContext() });
      const currentProject = grouped.projects.find((project) => project.current && project.workspaceId);
      if (!currentProject) return null;
      request = { scope: 'workspace', workspaceId: currentProject.workspaceId };
    } else request = { scope: 'owner' };
    if (filters.category !== 'all') request = { ...request, category: filters.category };
    return request;
  }

  async function clearCache(workspaceId: string, projectName: string): Promise<void> {
    const operation = captureOperationIntent();
    const request = filteredClearRequest(operation.store, workspaceId);
    if (!request) return;
    const revision = operation.store.getState().inventory?.revision || '';
    let target = projectName || (request.scope === 'shared' ? t('Shared cache') : request.scope === 'workspace' ? t('Current project') : t('All cache'));
    if (request.category) target += ' / ' + categoryLabel(request.category);
    try {
      const confirm = getConfirmOrThrow(t('Failed to clear cache.'));
      const first = await confirm({
        title: t('Clear selected cache'),
        message: t('Clear {target}?', { target }) + '\n' + t('Active cache operations must finish before removal.'),
        confirmLabel: t('Continue'),
        danger: true
      });
      if (!first || !inventoryRevisionCurrent(operation, revision)) return;
      const second = await confirm({
        title: t('Confirm permanent cache removal'),
        message: t('This removes cache files and their inventory records together. This cannot be undone.'),
        confirmLabel: t('Clear cache'),
        danger: true
      });
      if (!second || !inventoryRevisionCurrent(operation, revision)) return;
      await operation.store.clearScope(request);
      if (!operationIntentCurrent(operation)) return;
      invalidateAllDetailRequests();
      details = Object.create(null) as Record<string, MutableDetailState>;
      notify('success', t('Selected cache cleared.'));
    } catch (error) {
      if (operationIntentCurrent(operation)) {
        notify('error', safeErrorMessage(error, t('Failed to clear cache.')));
      }
    }
  }

  function managePackages(): void {
    const projects = dependencies.getProjects();
    if (projects && typeof projects.close === 'function') projects.close();
    const workbench = dependencies.getWorkbench();
    if (workbench && typeof workbench.setPrimaryView === 'function') workbench.setPrimaryView('environment');
    const packageCenter = dependencies.getPackageCenter();
    if (packageCenter && typeof packageCenter.open === 'function') packageCenter.open({ mode: 'installed' });
  }

  const onClick: EventListener = (event) => {
    if (disposed || !initialized) return;
    const target = event.target as (EventTarget & Partial<ClosestTarget>) | null;
    const button = target && typeof target.closest === 'function'
      ? target.closest('[data-cache-action]') as HTMLButtonElement | null
      : null;
    if (!button || button.disabled) return;
    const action = button.dataset.cacheAction;
    if (action === 'refresh') {
      const operation = captureOperationIntent();
      void operation.store.load({ force: true }).catch((error) => {
        if (operationIntentCurrent(operation)) {
          notify('error', safeErrorMessage(error, t('Failed to load')));
        }
      });
    } else if (action === 'project') {
      const key = button.dataset.projectKey as string;
      expandedProjects[key] = button.getAttribute('aria-expanded') !== 'true';
      render();
    } else if (action === 'history') {
      const id = button.dataset.historyId as string;
      expandedHistory[id] = button.getAttribute('aria-expanded') !== 'true';
      render();
    } else if (action === 'details') void showDetails(button.dataset.cacheId as string);
    else if (action === 'delete') void deleteEntry(button.dataset.cacheId as string);
    else if (action === 'clear') void clearCache('', '');
    else if (action === 'clear-project') void clearCache(button.dataset.workspaceId as string, button.dataset.projectName as string);
    else if (action === 'packages') managePackages();
  };

  const onChange: EventListener = (event) => {
    if (disposed || !initialized) return;
    const target = event.target as HTMLSelectElement | null;
    if (!target) return;
    if (target.id === 'cache-v2-scope') filters.scope = target.value as CacheCenterFilterScopeDto;
    else if (target.id === 'cache-v2-category') filters.category = target.value;
    else return;
    render();
  };

  const onLanguageChanged: EventListener = () => {
    if (!disposed && initialized) render();
  };

  function init(): void {
    if (initialized || initializing) return;
    const root = cacheRoot();
    if (!root) return;

    const initEpoch = lifecycleEpoch;
    const initStore = currentStore();
    let clickAttached = false;
    let changeAttached = false;
    let languageAttached = false;
    let nextUnsubscribe: Dispose | null = null;
    let committed = false;
    let subscriptionReady = false;
    let notificationPending = false;
    const rollback = (): void => {
      if (languageAttached) {
        try { dependencies.languageEvents.removeEventListener('bobo:language-changed', onLanguageChanged); } catch (_) {}
        languageAttached = false;
      }
      if (typeof nextUnsubscribe === 'function') {
        try { nextUnsubscribe(); } catch (_) {}
        nextUnsubscribe = null;
      }
      if (changeAttached) {
        try { root.removeEventListener('change', onChange); } catch (_) {}
        changeAttached = false;
      }
      if (clickAttached) {
        try { root.removeEventListener('click', onClick); } catch (_) {}
        clickAttached = false;
      }
      renderedRoot = null;
      renderedMarkup = null;
    };

    initializing = true;
    try {
      root.addEventListener('click', onClick);
      clickAttached = true;
      root.addEventListener('change', onChange);
      changeAttached = true;
      nextUnsubscribe = initStore.subscribe(() => {
        if (initEpoch !== lifecycleEpoch) return;
        if (!subscriptionReady) {
          notificationPending = true;
          return;
        }
        render();
      });
      if (initEpoch !== lifecycleEpoch || currentStore() !== initStore) {
        rollback();
        return;
      }
      dependencies.languageEvents.addEventListener('bobo:language-changed', onLanguageChanged);
      languageAttached = true;
      if (initEpoch !== lifecycleEpoch || currentStore() !== initStore) {
        rollback();
        return;
      }
      subscriptionReady = true;
      if (notificationPending) render();
      if (initEpoch !== lifecycleEpoch || currentStore() !== initStore) {
        rollback();
        return;
      }

      boundRoot = root;
      unsubscribe = nextUnsubscribe;
      initialized = true;
      disposed = false;
      committed = true;
    } catch (error) {
      rollback();
      throw error;
    } finally {
      initializing = false;
      if (!committed && (clickAttached || changeAttached || languageAttached || nextUnsubscribe)) rollback();
    }
  }

  function setVisible(value: boolean): void {
    const nextVisible = Boolean(value);
    if (!initialized) init();
    if (!initialized) {
      visible = false;
      if (!nextVisible) {
        try { currentStore().setActive(false); } catch (_) {}
      }
      return;
    }
    const store = currentStore();
    store.setActive(nextVisible);
    if (activeStore && activeStore !== store) {
      try { activeStore.setActive(false); } catch (_) {}
    }
    activeStore = nextVisible ? store : null;
    visible = nextVisible;
  }

  function load(options?: CacheStoreLoadOptionsDto | null): Promise<CacheInventoryDto | null> {
    if (!initialized) init();
    return currentStore().load(options || {});
  }

  function setProjectNames(names?: CacheProjectNamesDto | null): void {
    projectNames = copyProjectNames(names);
    if (visible) render();
  }

  function dispose(): void {
    if (disposed && !initialized && !initializing && !visible) return;
    lifecycleEpoch += 1;
    disposed = true;
    visible = false;
    invalidateAllDetailRequests();
    details = Object.create(null) as Record<string, MutableDetailState>;
    renderedRoot = null;
    renderedMarkup = null;

    const root = boundRoot;
    const releaseStore = unsubscribe;
    const storeToDeactivate = activeStore;
    boundRoot = null;
    unsubscribe = null;
    activeStore = null;
    initialized = false;

    if (root) {
      try { root.removeEventListener('click', onClick); } catch (_) {}
      try { root.removeEventListener('change', onChange); } catch (_) {}
    }
    try { dependencies.languageEvents.removeEventListener('bobo:language-changed', onLanguageChanged); } catch (_) {}
    if (typeof releaseStore === 'function') {
      try { releaseStore(); } catch (_) {}
    }
    if (storeToDeactivate) {
      try { storeToDeactivate.setActive(false); } catch (_) {}
    }
    try {
      const store = currentStore();
      if (store !== storeToDeactivate) store.setActive(false);
    } catch (_) {}
  }

  function getFilters(): CacheCenterFiltersDto {
    return { scope: filters.scope, category: filters.category };
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    init,
    load,
    render,
    setVisible,
    setProjectNames,
    dispose,
    getFilters
  });
}
