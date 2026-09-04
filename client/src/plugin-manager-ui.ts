// Extensions sidebar. Package parsing, storage and permission enforcement stay
// in the main process; this module receives only sanitized metadata.
import pluginSemver from '../shared/plugin-semver.js';
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
import type {
  PluginManagerDependencies,
  PluginManagerPluginViewDto,
  PluginManagerRefreshOptions,
  PluginManagerUIService,
  PluginManagerViewDto,
  PluginManagementHost,
  PluginMarketplaceEntryViewDto,
  PluginMarketplaceHost,
  PluginMarketplaceRefreshOptions,
  PluginMarketplaceVersionViewDto
} from '../types/plugin-management';

const compareSemver = pluginSemver.compareSemver;

export const PLUGIN_MANAGER_UI_SERVICE_ID = 'workbench.pluginManagerUI';

type UnknownRecord = Record<string, unknown>;
type PluginAction = 'enable' | 'disable';
type MarketplaceAction = 'install' | 'update' | 'refresh';

interface PluginManagerElements {
  activity: HTMLButtonElement | null;
  install: HTMLButtonElement | null;
  openFolder: HTMLButtonElement | null;
  refresh: HTMLButtonElement | null;
  search: HTMLInputElement | null;
  marketplaceTab: HTMLButtonElement | null;
  installedTab: HTMLButtonElement | null;
  marketplaceView: HTMLElement | null;
  marketplaceList: HTMLElement | null;
  installedView: HTMLElement | null;
  list: HTMLElement | null;
  status: HTMLElement | null;
}

interface PluginStateDescriptor {
  readonly text: string;
  readonly tone: string;
}

interface MarketplaceInstallState {
  readonly kind: 'unavailable' | 'installed' | 'incompatible' | 'update' | 'install';
  readonly label: string;
  readonly tone: string;
  readonly actionable: boolean;
}

interface ActiveViewOptions {
  readonly focus?: boolean;
}

interface MarketplaceRenderOptions {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

export function createPluginManagerUI(
  dependencies: PluginManagerDependencies
): PluginManagerUIService {
  const rendererDocument = dependencies.document;
  const rendererWindow = dependencies.window;
  const host = dependencies.host;
  const lifecycle = new DisposableStore();
  const elements: PluginManagerElements = {
    activity: null,
    install: null,
    openFolder: null,
    refresh: null,
    search: null,
    marketplaceTab: null,
    installedTab: null,
    marketplaceView: null,
    marketplaceList: null,
    installedView: null,
    list: null,
    status: null
  };
  const installedPluginsById = new Map<string, PluginManagerPluginViewDto>();
  let initialized = false;
  let bound = false;
  let subscribed = false;
  let commandRegistered = false;
  let busy = false;
  let refreshSequence = 0;
  let marketplaceRefreshSequence = 0;
  let activeView: PluginManagerViewDto = 'marketplace';
  let lastPlugins: PluginManagerPluginViewDto[] = [];
  let lastMarketplace: PluginMarketplaceEntryViewDto[] = [];
  let marketplaceSnapshot: unknown = null;
  let marketplaceError: unknown = null;

  function byId<ElementType extends HTMLElement>(id: string): ElementType | null {
    return rendererDocument.getElementById(id) as ElementType | null;
  }

  function interpolate(
    value: unknown,
    params?: Readonly<Record<string, string | number>>
  ): string {
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match: string, key: string) {
      return params && params[key] != null ? String(params[key]) : match;
    });
  }

  function t(key: string, params?: Readonly<Record<string, string | number>>): string {
    try {
      const i18n = dependencies.getI18n();
      return i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : interpolate(key, params);
    } catch (_error) {
      return interpolate(key, params);
    }
  }

  function pluginsApi(): Readonly<PluginManagementHost> | null {
    return host;
  }

  function apiAvailable(): boolean {
    const api = pluginsApi();
    return Boolean(api && typeof api.list === 'function');
  }

  function normalizeArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const record = asRecord(value);
    if (Array.isArray(record.plugins)) return record.plugins;
    if (Array.isArray(record.items)) return record.items;
    const result = asRecord(record.result);
    if (Array.isArray(result.plugins)) return result.plugins;
    return [];
  }

  function normalizePlugin(value: unknown, index: number): PluginManagerPluginViewDto {
    const record = asRecord(value);
    const manifest = asRecord(record.manifest);
    const id = String(record.id || manifest.id || 'plugin-' + index);
    const status = String(record.status || record.state || '');
    const integrity = asRecord(record.integrity);
    const enabled = record.enabled !== false && record.disabled !== true && status !== 'disabled' && status !== 'invalid' && status !== 'incompatible';
    let error = record.error || record.lastError || record.activationError || '';
    if (!error && status === 'incompatible') error = t('Plugin is incompatible with this BOBOCloud version.');
    if (!error && status === 'invalid') error = t('Plugin integrity check failed. Reinstall the package.');
    if (!error && integrity.valid === false && integrity.reason) error = String(integrity.reason);
    const builtIn = record.builtIn === true || record.builtin === true || record.source === 'builtin' || record.source === 'built-in';

    return {
      id,
      displayName: String(record.displayName || record.name || manifest.displayName || manifest.name || id),
      version: String(record.version || manifest.version || '0.0.0'),
      description: String(record.description || manifest.description || ''),
      enabled,
      error: String(error || ''),
      builtIn,
      removable: record.removable !== false && record.canUninstall !== false && !builtIn,
      state: status
    };
  }

  function normalizePlugins(value: unknown): PluginManagerPluginViewDto[] {
    const seen = new Set<string>();
    const plugins: PluginManagerPluginViewDto[] = [];
    normalizeArray(value).forEach(function(record, index) {
      const plugin = normalizePlugin(record, index);
      if (seen.has(plugin.id)) return;
      seen.add(plugin.id);
      plugins.push(plugin);
    });
    return plugins.sort(function(left, right) {
      return left.displayName.localeCompare(right.displayName);
    });
  }

  function marketplaceApi(): Readonly<PluginMarketplaceHost> | null {
    const api = pluginsApi();
    return api?.marketplace || null;
  }

  function marketplaceAvailable(): boolean {
    const marketplace = marketplaceApi();
    return Boolean(marketplace && typeof marketplace.list === 'function');
  }

  function boundedText(value: unknown, fallback = '', maximum = 1200): string {
    let text = value == null ? '' : String(value);
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    if (!text) text = fallback;
    return text.slice(0, maximum);
  }

  function activeLocale(): string {
    try {
      const i18n = dependencies.getI18n();
      return i18n && typeof i18n.getActive === 'function' ? String(i18n.getActive() || 'en') : 'en';
    } catch (_error) {
      return 'en';
    }
  }

  function localizedText(value: unknown, fallback = ''): string {
    if (typeof value === 'string' || typeof value === 'number') return boundedText(value, fallback);
    const record = asRecord(value);
    if (!Object.keys(record).length) return fallback;
    const locale = activeLocale();
    const primary = locale.split('-')[0] || '';
    const candidates = [locale, primary, 'en', 'zh-CN', 'ja'];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const candidateValue = record[candidate];
      if (typeof candidateValue === 'string' && candidateValue) return boundedText(candidateValue, fallback);
    }
    const firstKey = Object.keys(record).find(function(key) {
      return typeof record[key] === 'string' && Boolean(record[key]);
    });
    return firstKey ? boundedText(record[firstKey], fallback) : fallback;
  }

  function sourceText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return boundedText(value, '', 240);
    const record = asRecord(value);
    const repository = boundedText(record.repository || record.name || record.id, '', 180);
    const ref = boundedText(record.ref || record.revision || record.tag, '', 80);
    if (repository && ref) return repository + ' @ ' + ref;
    return repository || ref;
  }

  function normalizeMarketplaceVersion(value: unknown, index: number): PluginMarketplaceVersionViewDto {
    const record = asRecord(value);
    return {
      version: boundedText(record.version, '0.0.0', 80),
      publishedAt: boundedText(record.publishedAt, '', 80),
      engines: asRecord(record.engines),
      permissions: Array.isArray(record.permissions) ? record.permissions.map(function(permission) { return boundedText(permission, '', 160); }).filter(Boolean).slice(0, 30) : [],
      locales: Array.isArray(record.locales) ? record.locales.map(function(locale) { return boundedText(locale, '', 40); }).filter(Boolean).slice(0, 12) : [],
      size: Number.isFinite(Number(record.size)) ? Math.max(0, Number(record.size)) : null,
      installed: record.installed === true,
      installedVersion: boundedText(record.installedVersion, '', 80),
      installedStatus: boundedText(record.installedStatus, '', 80),
      compatible: record.compatible !== false,
      source: sourceText(record.source),
      index
    };
  }

  function normalizeMarketplace(snapshot: unknown): PluginMarketplaceEntryViewDto[] {
    const snapshotRecord = asRecord(snapshot);
    const packages = Array.isArray(snapshotRecord.packages) ? snapshotRecord.packages : [];
    const seen = new Set<string>();
    const normalized: PluginMarketplaceEntryViewDto[] = [];
    packages.forEach(function(value, index) {
      const record = asRecord(value);
      const rawVersions = Array.isArray(record.versions) ? record.versions : [];
      const versions = rawVersions.map(normalizeMarketplaceVersion).filter(function(version) {
        return version.version !== '0.0.0' || rawVersions.length === 1;
      });
      const latestRaw = record.latest !== null && typeof record.latest === 'object'
        ? asRecord(record.latest).version
        : record.latest;
      const latest = boundedText(latestRaw || record.latestVersion, '', 80);
      const selected = versions.find(function(version) { return version.version === latest; }) || versions.find(function(version) { return version.compatible; }) || versions[0] || null;
      const id = boundedText(record.id, 'marketplace-package-' + index, 180);
      const displayName = localizedText(record.displayName || record.name || record.localizedName, id);
      const description = localizedText(record.description || record.summary || record.localizedDescription, '');
      const categories = Array.isArray(record.categories) ? record.categories.map(function(category) { return localizedText(category, ''); }).filter(Boolean).slice(0, 8) : [];
      const publisher = boundedText(record.publisher || record.owner || id.split('.')[0], '', 120);
      const entry: PluginMarketplaceEntryViewDto = {
        id,
        displayName,
        description,
        publisher,
        categories,
        source: sourceText(record.source || record.registrySource),
        versions,
        selected,
        latest: latest || (selected && selected.version) || '',
        installed: record.installed === true,
        installedVersion: boundedText(record.installedVersion, '', 80),
        installedStatus: boundedText(record.installedStatus, '', 80),
        updateAvailable: record.updateAvailable === true
      };
      if (!entry.id || seen.has(entry.id)) return;
      seen.add(entry.id);
      normalized.push(entry);
    });
    normalized.sort(function(left, right) { return left.displayName.localeCompare(right.displayName); });
    return normalized;
  }

  function marketplaceSource(snapshot: unknown): 'cache' | 'network' {
    const record = asRecord(snapshot);
    const value = String(record.provenance || record.catalogState || record.cacheState || record.registryState || record.source || '').toLocaleLowerCase();
    if (record.offline === true || record.cached === true || record.stale === true || value === 'verified-cache' || value === 'cache' || value === 'offline' || value === 'stale') return 'cache';
    return 'network';
  }

  function cacheElements(): void {
    elements.activity = byId<HTMLButtonElement>('activity-extensions');
    elements.install = byId<HTMLButtonElement>('extensions-install');
    elements.openFolder = byId<HTMLButtonElement>('extensions-open-folder');
    elements.refresh = byId<HTMLButtonElement>('extensions-refresh');
    elements.search = byId<HTMLInputElement>('extensions-search-input');
    elements.marketplaceTab = byId<HTMLButtonElement>('extensions-marketplace-tab');
    elements.installedTab = byId<HTMLButtonElement>('extensions-installed-tab');
    elements.marketplaceView = byId<HTMLElement>('extensions-marketplace-view');
    elements.marketplaceList = byId<HTMLElement>('extensions-marketplace-list');
    elements.installedView = byId<HTMLElement>('extensions-installed-view');
    elements.list = byId<HTMLElement>('extensions-installed-list');
    elements.status = byId<HTMLElement>('extensions-status');
  }

  function appendText(parent: Node, tagName: string, className: string, value: string): HTMLElement {
    const element = rendererDocument.createElement(tagName);
    element.className = className || '';
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function actionIcon(action: PluginAction): string {
    if (action === 'enable') {
      return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.45v11.1c0 .5.55.8.97.54l8.3-5.55a.65.65 0 0 0 0-1.08l-8.3-5.55A.65.65 0 0 0 4 2.45Z"/></svg>';
    }
    if (action === 'disable') {
      return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.75c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Zm6 0c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Z"/></svg>';
    }
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2 0-.6 9H4.6L4 4m2.3 2.5v4m3.4-4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function createActionButton(action: PluginAction, label: string, pluginId: string): HTMLButtonElement {
    const button = rendererDocument.createElement('button');
    button.type = 'button';
    button.className = 'extensions-item-action';
    button.dataset.pluginAction = action;
    button.dataset.pluginId = pluginId;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = busy;
    button.innerHTML = actionIcon(action);
    return button;
  }

  function stateLabel(plugin: PluginManagerPluginViewDto): PluginStateDescriptor {
    if (plugin.state === 'incompatible') return { text: t('Incompatible'), tone: 'error' };
    if (plugin.state === 'invalid') return { text: t('Integrity check failed'), tone: 'error' };
    if (plugin.error) return { text: t('Plugin error'), tone: 'error' };
    if (!plugin.enabled) return { text: t('Disabled'), tone: 'disabled' };
    return { text: t('Enabled'), tone: 'enabled' };
  }

  function setStatus(message: string, tone?: string): void {
    if (lifecycle.disposed) return;
    if (!elements.status) return;
    elements.status.textContent = message || '';
    elements.status.dataset.tone = tone || 'neutral';
  }

  function setBusy(nextBusy: boolean): void {
    busy = Boolean(nextBusy);
    if (lifecycle.disposed) return;
    [elements.install, elements.openFolder, elements.refresh].forEach(function(control) {
      if (control) control.disabled = busy || !apiAvailable();
    });
    if (elements.list) {
      elements.list.setAttribute('aria-busy', busy ? 'true' : 'false');
      elements.list.querySelectorAll<HTMLButtonElement>('[data-plugin-action]').forEach(function(control) {
        control.disabled = busy;
      });
    }
    if (elements.marketplaceList) {
      elements.marketplaceList.setAttribute('aria-busy', busy ? 'true' : 'false');
      elements.marketplaceList.querySelectorAll<HTMLButtonElement>('[data-marketplace-action]').forEach(function(control) {
        const action = control.dataset.marketplaceAction;
        control.disabled = busy || !marketplaceAvailable() || (action !== 'install' && action !== 'update' && action !== 'refresh');
      });
    }
  }

  function currentQuery(): string {
    return String(elements.search && elements.search.value || '').trim().toLocaleLowerCase();
  }

  function matchingPlugins(): PluginManagerPluginViewDto[] {
    const query = currentQuery();
    if (!query) return lastPlugins.slice();
    return lastPlugins.filter(function(plugin) {
      return [plugin.displayName, plugin.id, plugin.description, plugin.version].join('\n').toLocaleLowerCase().indexOf(query) >= 0;
    });
  }

  function matchingMarketplace(): PluginMarketplaceEntryViewDto[] {
    const query = currentQuery();
    if (!query) return lastMarketplace.slice();
    return lastMarketplace.filter(function(entry) {
      const selected = entry.selected;
      return [
        entry.displayName,
        entry.id,
        entry.description,
        entry.publisher,
        entry.categories.join('\n'),
        entry.latest,
        selected?.permissions.join('\n'),
        selected?.source
      ].join('\n').toLocaleLowerCase().indexOf(query) >= 0;
    });
  }

  function openPluginDetails(pluginId?: string): void {
    if (!pluginId) return;
    const pluginDetails = dependencies.getPluginDetails();
    if (pluginDetails && typeof pluginDetails.open === 'function') {
      Promise.resolve(pluginDetails.open(pluginId)).catch(function() {});
      return;
    }
    const event = rendererDocument.createEvent('CustomEvent');
    event.initCustomEvent('bobo:open-plugin-details', false, false, { id: String(pluginId) });
    rendererWindow.dispatchEvent(event);
  }

  function renderPlugin(plugin: PluginManagerPluginViewDto): HTMLElement {
    const item = rendererDocument.createElement('article');
    item.className = 'extensions-installed-item';
    item.dataset.pluginId = plugin.id;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.setAttribute('aria-label', t('Open details for {name}', { name: plugin.displayName }));

    const marker = appendText(item, 'span', 'extensions-item-marker', plugin.displayName.slice(0, 1).toUpperCase() || '+');
    marker.setAttribute('aria-hidden', 'true');

    const copy = rendererDocument.createElement('div');
    copy.className = 'extensions-item-copy';
    appendText(copy, 'strong', 'extensions-item-name', plugin.displayName);
    appendText(copy, 'span', 'extensions-item-description', plugin.description || t('No description provided.'));
    const metadata = rendererDocument.createElement('div');
    metadata.className = 'extensions-item-metadata';
    appendText(metadata, 'code', 'extensions-item-id', plugin.id);
    appendText(metadata, 'span', 'extensions-item-version', 'v' + plugin.version);
    if (plugin.builtIn) appendText(metadata, 'span', 'extensions-item-source', t('Built in'));
    copy.appendChild(metadata);
    item.appendChild(copy);

    const trailing = rendererDocument.createElement('div');
    trailing.className = 'extensions-item-trailing';
    const state = stateLabel(plugin);
    const badge = appendText(trailing, 'span', 'extensions-item-state', state.text);
    badge.dataset.state = state.tone;
    const canToggle = plugin.state !== 'invalid' && plugin.state !== 'incompatible';
    if (canToggle) trailing.appendChild(createActionButton(plugin.enabled ? 'disable' : 'enable', plugin.enabled ? t('Disable plugin') : t('Enable plugin'), plugin.id));
    item.appendChild(trailing);

    if (plugin.error) {
      const error = appendText(item, 'span', 'extensions-item-error', plugin.error);
      error.setAttribute('role', 'alert');
    }
    return item;
  }

  function renderUnavailable(): void {
    if (!elements.list) return;
    elements.list.replaceChildren();
    const empty = rendererDocument.createElement('div');
    empty.className = 'extensions-empty extensions-empty-error';
    empty.setAttribute('role', 'note');
    appendText(empty, 'strong', 'extensions-empty-title', t('Plugin management unavailable'));
    appendText(empty, 'span', 'extensions-empty-detail', t('This build does not expose the plugin host. Update BOBOCloud to install plugins.'));
    elements.list.appendChild(empty);
    setBusy(false);
    setStatus(t('Plugin host is unavailable.'), 'error');
  }

  function renderList(plugins: readonly PluginManagerPluginViewDto[]): void {
    if (plugins !== lastPlugins) {
      lastPlugins = plugins.slice();
      installedPluginsById.clear();
      lastPlugins.forEach((plugin) => installedPluginsById.set(plugin.id, plugin));
    }
    if (!elements.list) return;
    const matches = matchingPlugins();
    elements.list.replaceChildren();
    if (!matches.length) {
      const empty = rendererDocument.createElement('div');
      empty.className = 'extensions-empty';
      empty.setAttribute('role', 'note');
      appendText(empty, 'strong', 'extensions-empty-title', plugins.length ? t('No installed extensions match your search') : t('No plugins installed'));
      appendText(empty, 'span', 'extensions-empty-detail', plugins.length ? t('Clear the search or browse the Marketplace when a catalog is configured.') : t('Install a .boboplugin package to add an extension to this workbench.'));
      elements.list.appendChild(empty);
    } else {
      const fragment = rendererDocument.createDocumentFragment();
      matches.forEach(function(plugin) { fragment.appendChild(renderPlugin(plugin)); });
      elements.list.appendChild(fragment);
    }
    setBusy(busy);
  }

  function marketplaceInstallState(entry: PluginMarketplaceEntryViewDto): MarketplaceInstallState {
    const selected = entry.selected;
    if (!selected) return { kind: 'unavailable', label: t('Unavailable'), tone: 'error', actionable: false };
    const installedPlugin = findPlugin(entry.id);
    const installedVersion = entry.installedVersion || selected.installedVersion || (installedPlugin && installedPlugin.version) || '';
    const isInstalled = Boolean(entry.installed || selected.installed || installedPlugin || installedVersion);
    const versionComparison = compareSemver(installedVersion, selected.version);
    if (isInstalled && versionComparison !== null && versionComparison >= 0) {
      return { kind: 'installed', label: t('Installed'), tone: 'enabled', actionable: false };
    }
    if (!selected.compatible) return { kind: 'incompatible', label: t('Incompatible'), tone: 'error', actionable: false };
    if (isInstalled || entry.updateAvailable) return { kind: 'update', label: t('Update'), tone: 'update', actionable: true };
    return { kind: 'install', label: t('Install'), tone: 'neutral', actionable: true };
  }

  function formatSize(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function engineSummary(engines: Readonly<Record<string, unknown>>): string {
    if (!engines || typeof engines !== 'object') return '';
    return Object.keys(engines).sort().slice(0, 8).map(function(key) {
      return boundedText(key, '', 80) + ': ' + boundedText(engines[key], '', 120);
    }).filter(Boolean).join(', ');
  }

  function createMarketplaceAction(
    entry: PluginMarketplaceEntryViewDto,
    state: MarketplaceInstallState
  ): HTMLButtonElement {
    const button = rendererDocument.createElement('button');
    button.type = 'button';
    button.className = 'extensions-marketplace-action';
    button.dataset.marketplaceAction = state.kind;
    button.dataset.packageId = entry.id;
    button.dataset.packageVersion = entry.selected && entry.selected.version || '';
    button.textContent = state.label;
    button.disabled = busy || !state.actionable || !marketplaceAvailable();
    button.setAttribute('aria-label', state.actionable
      ? t('{action} {name}', { action: state.label, name: entry.displayName })
      : t('{name} is {state}', { name: entry.displayName, state: state.label }));
    return button;
  }

  function appendMarketplaceDetail(definition: HTMLElement, label: string, value: string): void {
    if (!value) return;
    const row = rendererDocument.createElement('div');
    row.className = 'extensions-marketplace-detail-row';
    appendText(row, 'dt', 'extensions-marketplace-detail-label', label);
    appendText(row, 'dd', 'extensions-marketplace-detail-value', value);
    definition.appendChild(row);
  }

  function renderMarketplaceCard(entry: PluginMarketplaceEntryViewDto): HTMLElement {
    const selected = entry.selected;
    const state = marketplaceInstallState(entry);
    const card = rendererDocument.createElement('article');
    card.className = 'extensions-marketplace-item';
    card.dataset.packageId = entry.id;
    card.setAttribute('role', 'listitem');

    const marker = appendText(card, 'span', 'extensions-marketplace-marker', entry.displayName.slice(0, 1).toUpperCase() || '+');
    marker.setAttribute('aria-hidden', 'true');

    const copy = rendererDocument.createElement('div');
    copy.className = 'extensions-marketplace-copy';
    appendText(copy, 'strong', 'extensions-marketplace-name', entry.displayName);
    appendText(copy, 'span', 'extensions-marketplace-description', entry.description || t('No description provided.'));
    const metadata = rendererDocument.createElement('div');
    metadata.className = 'extensions-marketplace-metadata';
    appendText(metadata, 'span', 'extensions-marketplace-publisher', t('by {publisher}', { publisher: entry.publisher || t('Unknown publisher') }));
    appendText(metadata, 'code', 'extensions-marketplace-id', entry.id);
    if (selected?.version) appendText(metadata, 'span', 'extensions-marketplace-version', 'v' + selected.version);
    copy.appendChild(metadata);
    if (entry.categories.length) {
      const categories = rendererDocument.createElement('div');
      categories.className = 'extensions-marketplace-categories';
      entry.categories.forEach(function(category) { appendText(categories, 'span', 'extensions-marketplace-category', category); });
      copy.appendChild(categories);
    }
    card.appendChild(copy);

    const trailing = rendererDocument.createElement('div');
    trailing.className = 'extensions-marketplace-trailing';
    const badge = appendText(trailing, 'span', 'extensions-marketplace-state', state.label);
    badge.dataset.state = state.tone;
    trailing.appendChild(createMarketplaceAction(entry, state));
    card.appendChild(trailing);

    const details = rendererDocument.createElement('details');
    details.className = 'extensions-marketplace-details';
    appendText(details, 'summary', 'extensions-marketplace-details-summary', t('Extension information'));
    const definition = rendererDocument.createElement('dl');
    definition.className = 'extensions-marketplace-detail-list';
    appendMarketplaceDetail(definition, t('Identifier'), entry.id);
    appendMarketplaceDetail(definition, t('Publisher'), entry.publisher);
    appendMarketplaceDetail(definition, t('Version'), selected?.version || entry.latest);
    appendMarketplaceDetail(definition, t('Engine'), engineSummary(selected?.engines || {}));
    appendMarketplaceDetail(definition, t('Permissions'), selected?.permissions.join(', ') || '');
    appendMarketplaceDetail(definition, t('Languages'), selected?.locales.join(', ') || '');
    appendMarketplaceDetail(definition, t('Package size'), formatSize(selected?.size ?? null));
    appendMarketplaceDetail(definition, t('Published'), selected?.publishedAt || '');
    appendMarketplaceDetail(definition, t('Marketplace source'), selected?.source || entry.source);
    details.appendChild(definition);
    card.appendChild(details);
    return card;
  }

  function renderMarketplaceMessage(
    kind: 'loading' | 'empty' | 'error',
    title: string,
    detail: string,
    retry: boolean
  ): HTMLElement {
    const message = rendererDocument.createElement('div');
    message.className = 'extensions-empty extensions-marketplace-empty' + (kind === 'error' ? ' extensions-empty-error' : '');
    message.setAttribute('role', kind === 'error' ? 'alert' : 'note');
    appendText(message, 'strong', 'extensions-empty-title', title);
    if (detail) appendText(message, 'span', 'extensions-empty-detail', detail);
    if (retry) {
      const button = rendererDocument.createElement('button');
      button.type = 'button';
      button.className = 'extensions-primary-action';
      button.dataset.marketplaceAction = 'refresh';
      button.textContent = t('Retry Marketplace');
      message.appendChild(button);
    }
    return message;
  }

  function renderMarketplace(
    entries?: readonly PluginMarketplaceEntryViewDto[],
    _options: MarketplaceRenderOptions = {}
  ): void {
    if (Array.isArray(entries)) lastMarketplace = entries.slice();
    if (!elements.marketplaceList) return;
    const list = elements.marketplaceList;
    const matches = matchingMarketplace();
    list.replaceChildren();

    if (marketplaceSnapshot && marketplaceSource(marketplaceSnapshot) === 'cache') {
      const cacheNotice = rendererDocument.createElement('div');
      cacheNotice.className = 'extensions-marketplace-notice';
      cacheNotice.dataset.state = 'cache';
      cacheNotice.setAttribute('role', 'status');
      appendText(cacheNotice, 'span', 'extensions-marketplace-notice-label', t('Using verified cached Marketplace catalog'));
      list.appendChild(cacheNotice);
    }
    if (marketplaceError && lastMarketplace.length) {
      const staleNotice = rendererDocument.createElement('div');
      staleNotice.className = 'extensions-marketplace-notice';
      staleNotice.dataset.state = 'error';
      staleNotice.setAttribute('role', 'status');
      appendText(staleNotice, 'span', 'extensions-marketplace-notice-label', t('Could not refresh Marketplace. Showing the last verified catalog.'));
      list.appendChild(staleNotice);
    }

    if (!matches.length) {
      const hasSearch = Boolean(currentQuery());
      list.appendChild(renderMarketplaceMessage('empty',
        hasSearch ? t('No Marketplace extensions match your search') : t('No extensions are available from this Marketplace.'),
        hasSearch ? t('Clear the search or refresh the Marketplace catalog.') : t('Refresh Marketplace to check for newly published extensions.'),
        !hasSearch && Boolean(marketplaceError)));
    } else {
      const fragment = rendererDocument.createDocumentFragment();
      matches.forEach(function(entry) { fragment.appendChild(renderMarketplaceCard(entry)); });
      list.appendChild(fragment);
    }
    list.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function renderMarketplaceUnavailable(): void {
    if (!elements.marketplaceList) return;
    elements.marketplaceList.replaceChildren(renderMarketplaceMessage('error',
      t('Marketplace unavailable'),
      t('This build does not expose the Marketplace service. Update BOBOCloud to browse verified extensions.'),
      false));
    elements.marketplaceList.setAttribute('aria-busy', 'false');
  }

  function setActiveView(view?: string, options: ActiveViewOptions = {}): void {
    activeView = view === 'installed' ? 'installed' : 'marketplace';
    const installed = activeView === 'installed';
    if (elements.marketplaceTab) {
      elements.marketplaceTab.classList.toggle('active', !installed);
      elements.marketplaceTab.setAttribute('aria-selected', installed ? 'false' : 'true');
      elements.marketplaceTab.tabIndex = installed ? -1 : 0;
    }
    if (elements.installedTab) {
      elements.installedTab.classList.toggle('active', installed);
      elements.installedTab.setAttribute('aria-selected', installed ? 'true' : 'false');
      elements.installedTab.tabIndex = installed ? 0 : -1;
    }
    if (elements.marketplaceView) {
      elements.marketplaceView.classList.toggle('active', !installed);
      elements.marketplaceView.hidden = installed;
    }
    if (elements.installedView) {
      elements.installedView.classList.toggle('active', installed);
      elements.installedView.hidden = !installed;
    }
    if (installed) renderList(lastPlugins);
    else if (marketplaceAvailable()) renderMarketplace(lastMarketplace);
    else renderMarketplaceUnavailable();
    if (options.focus && elements.search) elements.search.focus();
  }

  function resultWasCancelled(result: unknown): boolean {
    const record = asRecord(result);
    return result == null || result === false || record.canceled === true || record.cancelled === true;
  }

  function errorMessage(error: unknown): string {
    const record = asRecord(error);
    const code = typeof record.code === 'string' ? record.code : '';
    if (code === 'plugins.manifest.api' || code === 'plugins.manifest.host') return t('Plugin is incompatible with this BOBOCloud version.');
    if (/^plugins\.(?:integrity|manifest\.integrity)/.test(code)) return t('Plugin integrity check failed. Reinstall the package.');
    if (/^plugins\.(?:package\.size|package\.fileSize|zip\.size)/.test(code)) return t('Plugin package exceeds the supported size limit.');
    if (/^plugins\.(?:notFound)/.test(code)) return t('Plugin is no longer installed.');
    if (/^plugins\.(?:entry|rpc\.plugin)/.test(code)) return t('Plugin source is not available.');
    if (/^plugins\.(?:package|zip|manifest|install\.source|install\.type|id\.path)/.test(code)) return t('Plugin package is invalid or unsafe.');
    return record.message ? String(record.message) : t('Unknown error');
  }

  function marketplaceErrorMessage(error: unknown): string {
    const record = asRecord(error);
    const code = typeof record.code === 'string' ? record.code : '';
    if (/^plugins\.marketplace\.(?:network|timeout)$/.test(code)) return t('Could not reach the Marketplace. Check your network and retry.');
    if (/^plugins\.marketplace\.(?:body|registry)$/.test(code)) return t('The Marketplace catalog could not be verified. Try again later.');
    if (/^plugins\.marketplace\.integrity$/.test(code)) return t('The Marketplace package failed integrity verification.');
    if (/^plugins\.marketplace\.artifact$/.test(code)) return t('The Marketplace package could not be downloaded or verified.');
    if (/^plugins\.marketplace\.notFound$/.test(code)) return t('This Marketplace extension is no longer available.');
    if (/^plugins\.marketplace\.version$/.test(code)) return t('This Marketplace version is no longer available.');
    if (/^plugins\.marketplace\.incompatible$/.test(code)) return t('Plugin is incompatible with this BOBOCloud version.');
    return t('Marketplace request failed. Please retry.');
  }

  async function refresh(
    options: PluginManagerRefreshOptions = {}
  ): Promise<readonly PluginManagerPluginViewDto[]> {
    if (lifecycle.disposed) return lastPlugins.slice();
    cacheElements();
    const api = pluginsApi();
    if (!api || typeof api.list !== 'function') {
      renderUnavailable();
      return [];
    }
    const sequence = ++refreshSequence;
    if (!options.quiet) setStatus(t('Loading plugins...'), 'neutral');
    try {
      const result = await Promise.resolve(api.list());
      if (sequence !== refreshSequence) return lastPlugins.slice();
      renderList(normalizePlugins(result));
      if (!options.preserveStatus) setStatus(t('{count} plugins available', { count: lastPlugins.length }), 'neutral');
      return lastPlugins.slice();
    } catch (error) {
      if (sequence !== refreshSequence) return lastPlugins.slice();
      renderList([]);
      setStatus(t('Could not load plugins: {message}', { message: errorMessage(error) }), 'error');
      return [];
    }
  }

  async function refreshMarketplace(
    options: PluginMarketplaceRefreshOptions = {}
  ): Promise<readonly PluginMarketplaceEntryViewDto[]> {
    if (lifecycle.disposed) return lastMarketplace.slice();
    cacheElements();
    const api = marketplaceApi();
    if (!api || typeof api.list !== 'function') {
      renderMarketplaceUnavailable();
      return [];
    }
    const sequence = ++marketplaceRefreshSequence;
    if (!options.quiet) setStatus(t('Loading Marketplace...'), 'neutral');
    if (!lastMarketplace.length && elements.marketplaceList) {
      elements.marketplaceList.replaceChildren(renderMarketplaceMessage('loading', t('Loading Marketplace...'), t('Fetching verified extension metadata...'), false));
      elements.marketplaceList.setAttribute('aria-busy', 'true');
    }
    try {
      const snapshot = await Promise.resolve(options.force && typeof api.refresh === 'function'
        ? api.refresh()
        : api.list());
      if (sequence !== marketplaceRefreshSequence) return lastMarketplace.slice();
      marketplaceSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
      marketplaceError = null;
      const entries = normalizeMarketplace(marketplaceSnapshot);
      renderMarketplace(entries);
      if (!options.preserveStatus) {
        const source = marketplaceSource(marketplaceSnapshot);
        setStatus(source === 'cache'
          ? t('Marketplace is using a verified cached catalog.')
          : t('{count} extensions available in Marketplace', { count: entries.length }), source === 'cache' ? 'warning' : 'neutral');
      }
      return lastMarketplace.slice();
    } catch (error) {
      if (sequence !== marketplaceRefreshSequence) return lastMarketplace.slice();
      marketplaceError = error;
      if (lastMarketplace.length) {
        renderMarketplace(lastMarketplace);
      } else if (elements.marketplaceList) {
        elements.marketplaceList.replaceChildren(renderMarketplaceMessage('error', t('Could not load Marketplace'), marketplaceErrorMessage(error), true));
        elements.marketplaceList.setAttribute('aria-busy', 'false');
      }
      setStatus(t('Could not load Marketplace: {message}', { message: marketplaceErrorMessage(error) }), 'error');
      return lastMarketplace.slice();
    }
  }

  async function installMarketplace(entry: PluginMarketplaceEntryViewDto): Promise<void> {
    if (lifecycle.disposed) return;
    const api = marketplaceApi();
    const state = marketplaceInstallState(entry);
    if (!api || typeof api.install !== 'function' || !state.actionable || !entry.selected) return;
    setBusy(true);
    setStatus(state.kind === 'update' ? t('Updating Marketplace extension...') : t('Installing Marketplace extension...'), 'neutral');
    try {
      await Promise.resolve(api.install(entry.id));
      if (lifecycle.disposed) return;
      await Promise.all([
        refresh({ quiet: true, preserveStatus: true }),
        refreshMarketplace({ quiet: true, preserveStatus: true })
      ]);
      setStatus(state.kind === 'update' ? t('Marketplace extension updated') : t('Marketplace extension installed'), 'success');
    } catch (error) {
      setStatus(t('Could not install Marketplace extension: {message}', { message: marketplaceErrorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function install(): Promise<void> {
    if (lifecycle.disposed) return;
    const api = pluginsApi();
    if (!api || typeof api.install !== 'function') return renderUnavailable();
    setBusy(true);
    setStatus(t('Selecting .boboplugin package...'), 'neutral');
    try {
      const result = await Promise.resolve(api.install());
      if (lifecycle.disposed) return;
      if (resultWasCancelled(result)) {
        setStatus(t('Plugin installation cancelled'), 'neutral');
        return;
      }
      setActiveView('installed');
      await refresh({ quiet: true, preserveStatus: true });
      setStatus(t('Plugin installed'), 'success');
    } catch (error) {
      setStatus(t('Could not install plugin: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openFolder(): Promise<void> {
    if (lifecycle.disposed) return;
    const api = pluginsApi();
    if (!api || typeof api.openFolder !== 'function') return renderUnavailable();
    setBusy(true);
    try {
      await Promise.resolve(api.openFolder());
      if (lifecycle.disposed) return;
      setStatus(t('Extensions folder opened'), 'success');
    } catch (error) {
      setStatus(t('Could not open extensions folder: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refreshAction(): Promise<void> {
    if (lifecycle.disposed) return;
    const api = pluginsApi();
    if (!api || typeof api.refresh !== 'function') {
      await Promise.all([refresh(), refreshMarketplace({ force: true })]);
      return;
    }
    setBusy(true);
    setStatus(t('Refreshing extensions...'), 'neutral');
    try {
      await Promise.resolve(api.refresh());
      if (lifecycle.disposed) return;
      await Promise.all([
        refresh({ quiet: true, preserveStatus: true }),
        refreshMarketplace({ force: true, quiet: true, preserveStatus: true })
      ]);
      setStatus(t('Extensions refreshed'), 'success');
    } catch (error) {
      setStatus(t('Could not load plugins: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  function findPlugin(id?: string): PluginManagerPluginViewDto | null {
    return id ? installedPluginsById.get(id) || null : null;
  }

  async function toggle(plugin: PluginManagerPluginViewDto, action?: string): Promise<void> {
    if (lifecycle.disposed) return;
    const api = pluginsApi();
    if (!api) return renderUnavailable();
    const method: PluginAction = action === 'enable' ? 'enable' : 'disable';
    setBusy(true);
    try {
      await Promise.resolve(method === 'enable' ? api.enable(plugin.id) : api.disable(plugin.id));
      if (lifecycle.disposed) return;
      await refresh({ quiet: true, preserveStatus: true });
      setStatus(action === 'enable' ? t('Plugin enabled') : t('Plugin disabled'), 'success');
    } catch (error) {
      setStatus(t('Could not update plugin: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  function schedule(callback: () => void, delayMs: number): void {
    if (lifecycle.disposed) return;
    let timerDisposable!: Disposable;
    const timer = dependencies.setTimer(() => {
      lifecycle.delete(timerDisposable);
      if (!lifecycle.disposed) callback();
    }, delayMs);
    timerDisposable = toDisposable(() => dependencies.clearTimer(timer));
    lifecycle.add(timerDisposable);
  }

  function reveal(view?: PluginManagerViewDto): void {
    if (lifecycle.disposed) return;
    cacheElements();
    const workbench = dependencies.getWorkbench();
    if (workbench && typeof workbench.setPrimaryView === 'function') workbench.setPrimaryView('extensions');
    setActiveView(view === 'marketplace' ? 'marketplace' : 'installed');
    schedule(function() {
      void refresh({ quiet: true });
      void refreshMarketplace({ quiet: true });
    }, 0);
  }

  function listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions
  ): void {
    target.addEventListener(type, listener, options);
    lifecycle.add(toDisposable(() => target.removeEventListener(type, listener, options)));
  }

  function eventElement(event: Event): Element | null {
    const target = event.target as Partial<Element> | null;
    return target && typeof target.closest === 'function' ? target as Element : null;
  }

  function bindEvents(): void {
    if (bound || lifecycle.disposed) return;
    bound = true;
    if (elements.activity) listen(elements.activity, 'click', function() {
      setActiveView(activeView);
      void refresh({ quiet: true });
      void refreshMarketplace({ quiet: true });
    });
    if (elements.install) listen(elements.install, 'click', () => { void install(); });
    if (elements.openFolder) listen(elements.openFolder, 'click', () => { void openFolder(); });
    if (elements.refresh) listen(elements.refresh, 'click', () => { void refreshAction(); });
    [elements.marketplaceTab, elements.installedTab].forEach(function(tab) {
      if (!tab) return;
      listen(tab, 'click', function() { setActiveView(tab.dataset.extensionView, { focus: false }); });
      listen(tab, 'keydown', function(event) {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'ArrowLeft' && keyboardEvent.key !== 'ArrowRight') return;
        keyboardEvent.preventDefault();
        setActiveView(keyboardEvent.key === 'ArrowLeft' ? 'marketplace' : 'installed', { focus: false });
        (keyboardEvent.key === 'ArrowLeft' ? elements.marketplaceTab : elements.installedTab)?.focus();
      });
    });
    if (elements.search) listen(elements.search, 'input', function() {
      if (activeView === 'installed') renderList(lastPlugins);
      else renderMarketplace(lastMarketplace);
    });
    const installedList = elements.list;
    if (installedList) {
      listen(installedList, 'click', function(event) {
        const target = eventElement(event);
        const actionButton = target?.closest<HTMLElement>('[data-plugin-action]') || null;
        if (actionButton && installedList.contains(actionButton)) {
          event.stopPropagation();
          const plugin = findPlugin(actionButton.dataset.pluginId);
          if (plugin) void toggle(plugin, actionButton.dataset.pluginAction);
          return;
        }
        const item = target?.closest<HTMLElement>('.extensions-installed-item[data-plugin-id]') || null;
        if (item && installedList.contains(item)) openPluginDetails(item.dataset.pluginId);
      });
      listen(installedList, 'keydown', function(event) {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
        const target = eventElement(event);
        const item = target?.closest<HTMLElement>('.extensions-installed-item[data-plugin-id]') || null;
        if (!item || target?.closest('[data-plugin-action]')) return;
        keyboardEvent.preventDefault();
        openPluginDetails(item.dataset.pluginId);
      });
    }
    const marketplaceList = elements.marketplaceList;
    if (marketplaceList) {
      listen(marketplaceList, 'click', function(event) {
        const target = eventElement(event);
        const button = target?.closest<HTMLElement>('[data-marketplace-action]') || null;
        if (!button || !marketplaceList.contains(button)) return;
        const action = button.dataset.marketplaceAction as MarketplaceAction | undefined;
        if (action === 'refresh') {
          void refreshMarketplace({ force: true });
          return;
        }
        if (action !== 'install' && action !== 'update') return;
        const entry = lastMarketplace.find(function(candidate) { return candidate.id === button.dataset.packageId; });
        if (entry) void installMarketplace(entry);
      });
    }
  }

  function subscribe(): void {
    if (subscribed || lifecycle.disposed) return;
    const api = pluginsApi();
    if (!api || typeof api.onDidChange !== 'function') return;
    subscribed = true;
    lifecycle.add(api.onDidChange(function(payload) {
      const record = asRecord(payload);
      if (Array.isArray(record.plugins) || Array.isArray(record.items)) {
        renderList(normalizePlugins(payload));
        renderMarketplace(lastMarketplace);
        void refreshMarketplace({ quiet: true, preserveStatus: true });
        setStatus(t('Plugins refreshed'), 'neutral');
      } else {
        void refresh({ quiet: true });
        void refreshMarketplace({ quiet: true, preserveStatus: true });
      }
    }));
  }

  function registerCommands(): void {
    const commands = dependencies.getCommands();
    if (commandRegistered || lifecycle.disposed || !commands || typeof commands.register !== 'function') return;
    const registration = commands.register('plugins.manage', t('Plugins: Manage Installed Plugins'), '', t('Extensions'), function() { reveal('installed'); });
    if (registration) lifecycle.add(registration);
    else if (typeof commands.unregister === 'function') {
      lifecycle.add(toDisposable(() => { commands.unregister?.('plugins.manage'); }));
    }
    commandRegistered = true;
  }

  function init(): Promise<unknown> {
    if (lifecycle.disposed) {
      return Promise.resolve([lastPlugins.slice(), lastMarketplace.slice()]);
    }
    cacheElements();
    if (!initialized && !lifecycle.disposed) {
      initialized = true;
      bindEvents();
      subscribe();
      if (rendererDocument.documentElement?.getAttribute('data-bobo-ready') !== 'true') {
        listen(rendererWindow, 'bobo:ready', () => registerCommands(), { once: true });
      }
      const api = pluginsApi();
      if (api && typeof api.onOpenManager === 'function') {
        lifecycle.add(api.onOpenManager(function() { reveal('installed'); }));
      }
      listen(rendererWindow, 'bobo:language-changed', function() {
        if (apiAvailable()) renderList(lastPlugins);
        else renderUnavailable();
        if (marketplaceAvailable()) renderMarketplace(marketplaceSnapshot ? normalizeMarketplace(marketplaceSnapshot) : lastMarketplace);
        else renderMarketplaceUnavailable();
      });
    }
    if (rendererDocument.documentElement?.getAttribute('data-bobo-ready') === 'true') registerCommands();
    return Promise.all([refresh({ quiet: true }), refreshMarketplace({ quiet: true })]);
  }

  function dispose(): void {
    if (lifecycle.disposed) return;
    refreshSequence += 1;
    marketplaceRefreshSequence += 1;
    lifecycle.dispose();
    installedPluginsById.clear();
    lastPlugins = [];
    lastMarketplace = [];
    marketplaceSnapshot = null;
    marketplaceError = null;
  }

  return Object.freeze({
    get disposed() { return lifecycle.disposed; },
    init,
    open: reveal,
    refresh,
    refreshMarketplace,
    getPlugins: () => lastPlugins.slice(),
    getMarketplace: () => lastMarketplace.slice(),
    dispose
  });
}
