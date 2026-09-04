// Extension details are workbench pages, not editor models. The page receives
// only the sanitized status descriptor exposed by the private host service.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  PluginDetailsDependencies,
  PluginDetailsDto,
  PluginDetailsService,
  PluginDetailsStateFileTab,
  PluginDetailsTab,
  PluginDetailsTabProvider,
  PluginDetailsViewSnapshot,
  PluginDetailsWorkbenchTabDto,
  PluginManagementChangedDto
} from '../types/plugin-management';
import type { PluginPermissionDto } from '../types/plugin-runtime';

const PAGE_ID = 'plugin-details-view';
const TAB_PREFIX = 'plugin-details:';

type UnknownRecord = Record<string, unknown>;
type PluginDetailsMutationAction = 'enable' | 'disable' | 'grant' | 'revoke';
type PluginDetailsHeaderAction = 'enable' | 'disable' | 'refresh' | 'uninstall';

interface NormalizedPluginDetailsDto extends PluginDetailsDto {
  readonly key: string;
}

interface PluginDetailsRenderOptions {
  readonly resetScroll?: boolean;
}

interface PluginDetailsRefreshOptions extends PluginDetailsRenderOptions {
  readonly activate?: boolean;
}

interface PluginDetailsStatusDescriptor {
  readonly text: string;
  readonly tone: 'enabled' | 'disabled' | 'error';
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstTruthy(...values: readonly unknown[]): unknown {
  for (const value of values) {
    if (value) return value;
  }
  return '';
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => (
    typeof item === 'string' && item.length > 0 && item.length <= 240
  ));
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function safeId(value: unknown): string {
  const id = String(value || '');
  return /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(id) ? id : '';
}

function tabKey(id: string): string {
  return TAB_PREFIX + encodeURIComponent(id);
}

function idFromTabKey(key: unknown): string {
  if (typeof key !== 'string' || key.indexOf(TAB_PREFIX) !== 0) return '';
  try {
    return safeId(decodeURIComponent(key.slice(TAB_PREFIX.length)));
  } catch (_) {
    return '';
  }
}

function arrayFromRecord(record: UnknownRecord, fields: readonly string[]): string[] {
  for (const field of fields) {
    if (Array.isArray(record[field])) return strings(record[field]);
  }
  return [];
}

function normalizeDetail(value: unknown): NormalizedPluginDetailsDto | null {
  const record = isPlainObject(value) ? value : {};
  const manifest = isPlainObject(record.manifest) ? record.manifest : {};
  const id = safeId(firstTruthy(record.id, manifest.id));
  if (!id) return null;

  const requestedStrings = dedupe(
    arrayFromRecord(record, ['requestedPermissions', 'permissions'])
      .concat(arrayFromRecord(manifest, ['permissions']))
  );
  const grantedStrings = dedupe(
    arrayFromRecord(record, ['grantedPermissions', 'grants'])
  ).filter((permission) => requestedStrings.includes(permission));
  const integrity = isPlainObject(record.integrity) ? record.integrity : {};
  const engines = isPlainObject(manifest.engines) ? manifest.engines : {};
  const contributes = isPlainObject(manifest.contributes) ? manifest.contributes : {};
  const status = String(firstTruthy(
    record.status,
    record.enabled === true ? 'enabled' : 'disabled'
  )).slice(0, 80);

  return {
    id,
    key: tabKey(id),
    name: String(firstTruthy(
      record.displayName,
      manifest.displayName,
      manifest.name,
      id
    )).slice(0, 160),
    description: String(firstTruthy(record.description, manifest.description)).slice(0, 4000),
    version: String(firstTruthy(record.version, manifest.version)).slice(0, 80),
    enabled: record.enabled === true && status !== 'invalid' && status !== 'incompatible',
    status,
    requestedPermissions: requestedStrings,
    grantedPermissions: grantedStrings,
    integrity: {
      valid: integrity.valid === true,
      reason: String(integrity.reason || '').slice(0, 180)
    },
    activationEvents: dedupe(strings(manifest.activationEvents)),
    contributionPoints: Object.keys(contributes)
      .filter((key) => /^[a-zA-Z0-9._-]{1,120}$/.test(key))
      .sort(),
    engines: {
      bobocloud: String(engines.bobocloud || '').slice(0, 120),
      pluginApi: String(engines.pluginApi || '').slice(0, 120)
    },
    installedAt: String(record.installedAt || '').slice(0, 120)
  };
}

export function createPluginDetailsService(
  dependencies: PluginDetailsDependencies
): PluginDetailsService {
  const document = dependencies.document;
  const globalWindow = dependencies.window;
  const state = dependencies.state;
  const host = dependencies.host;
  const disposables = new DisposableStore();
  const refreshTokens = new Map<string, number>();
  let initialized = false;
  let disposed = false;
  let busy = false;
  let pendingUnderlyingView: PluginDetailsViewSnapshot | null = null;
  let boundView: HTMLElement | null = null;

  function interpolate(
    value: unknown,
    params?: Readonly<Record<string, string | number>>
  ): string {
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => (
      params && params[key] != null ? String(params[key]) : match
    ));
  }

  function t(
    key: string,
    params?: Readonly<Record<string, string | number>>
  ): string {
    try {
      return dependencies.getI18n()?.t(key, params) ?? interpolate(key, params);
    } catch (_) {
      return interpolate(key, params);
    }
  }

  function tabs(): PluginDetailsTab[] {
    if (!Array.isArray(state.pluginDetailTabs)) state.pluginDetailTabs = [];
    return state.pluginDetailTabs;
  }

  function findTabById(id: string): PluginDetailsTab | null {
    return tabs().find((tab) => tab.id === id) || null;
  }

  function findTabByKey(key: unknown): PluginDetailsTab | null {
    const id = idFromTabKey(key);
    return id ? findTabById(id) : null;
  }

  function activeTab(): PluginDetailsTab | null {
    return findTabByKey(state.activeTabPath);
  }

  function bindView(root: HTMLElement): void {
    if (boundView === root) return;
    if (boundView) boundView.removeEventListener('click', onViewClick);
    boundView = root;
    boundView.addEventListener('click', onViewClick);
  }

  disposables.add(toDisposable(() => {
    if (boundView) boundView.removeEventListener('click', onViewClick);
    boundView = null;
  }));

  function view(): HTMLElement | null {
    if (disposed) return null;
    let root = document.getElementById(PAGE_ID);
    if (!root) {
      const editor = document.getElementById('editor');
      if (!editor) return null;
      root = document.createElement('section');
      root.id = PAGE_ID;
      root.className = 'plugin-details-view';
      root.hidden = true;
      root.setAttribute('role', 'tabpanel');
      root.setAttribute('aria-label', t('Plugin details'));
      editor.appendChild(root);
    }
    bindView(root);
    return root;
  }

  function append<TagName extends keyof HTMLElementTagNameMap>(
    parent: Node,
    tagName: TagName,
    className: string,
    value?: unknown
  ): HTMLElementTagNameMap[TagName] {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    parent.appendChild(element);
    return element;
  }

  function icon(kind: 'play' | 'pause' | 'refresh' | 'uninstall'): string {
    if (kind === 'play') {
      return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.45v11.1c0 .5.55.8.97.54l8.3-5.55a.65.65 0 0 0 0-1.08l-8.3-5.55A.65.65 0 0 0 4 2.45Z"/></svg>';
    }
    if (kind === 'pause') {
      return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.75c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Zm6 0c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Z"/></svg>';
    }
    if (kind === 'refresh') {
      return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.3 6.5A5.5 5.5 0 1 0 13.1 10M13.3 2.7v3.8H9.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2 0-.6 9H4.6L4 4m2.3 2.5v4m3.4-4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function actionButton(
    action: PluginDetailsHeaderAction,
    label: string,
    id: string,
    disabled: boolean
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'plugin-details-icon-button';
    button.dataset.pluginDetailsAction = action;
    button.dataset.pluginId = id;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled === true;
    button.innerHTML = icon(
      action === 'enable' ? 'play' : action === 'disable' ? 'pause' : action
    );
    return button;
  }

  function statusDescriptor(detail: PluginDetailsDto): PluginDetailsStatusDescriptor {
    if (detail.status === 'incompatible') return { text: t('Incompatible'), tone: 'error' };
    if (detail.status === 'invalid' || !detail.integrity.valid) {
      return { text: t('Integrity check failed'), tone: 'error' };
    }
    return detail.enabled
      ? { text: t('Enabled'), tone: 'enabled' }
      : { text: t('Disabled'), tone: 'disabled' };
  }

  function formatInstalledAt(value: string): string {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    try {
      return date.toLocaleString(document.documentElement.lang || undefined);
    } catch (_) {
      return date.toISOString();
    }
  }

  function fact(
    parent: HTMLElement,
    label: string,
    value: string,
    tone?: string
  ): void {
    const row = document.createElement('div');
    row.className = 'plugin-details-fact';
    append(row, 'dt', 'plugin-details-fact-label', label);
    const result = append(row, 'dd', 'plugin-details-fact-value', value);
    if (tone) result.dataset.tone = tone;
    parent.appendChild(row);
  }

  function section(page: HTMLElement, title: string): HTMLElement {
    const container = document.createElement('section');
    container.className = 'plugin-details-section';
    append(container, 'h2', 'plugin-details-section-title', title);
    page.appendChild(container);
    return container;
  }

  function renderPermissions(page: HTMLElement, detail: PluginDetailsDto): void {
    const content = section(page, t('Requested permissions'));
    if (!detail.requestedPermissions.length) {
      append(content, 'p', 'plugin-details-empty', t('No additional permissions requested'));
      return;
    }
    const list = document.createElement('div');
    list.className = 'plugin-details-permissions';
    detail.requestedPermissions.forEach((permission) => {
      const granted = detail.grantedPermissions.includes(permission);
      const row = document.createElement('div');
      row.className = 'plugin-details-permission';
      const copy = document.createElement('div');
      copy.className = 'plugin-details-permission-copy';
      append(copy, 'code', 'plugin-details-permission-id', permission);
      append(
        copy,
        'span',
        'plugin-details-permission-state',
        granted ? t('Granted permissions') : t('Requested permissions')
      ).dataset.granted = granted ? 'true' : 'false';
      row.appendChild(copy);
      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'ss-btn ss-btn-ghost plugin-details-permission-action';
      control.dataset.pluginDetailsAction = granted ? 'revoke' : 'grant';
      control.dataset.pluginId = detail.id;
      control.dataset.permission = permission;
      control.disabled = busy;
      control.textContent = granted ? t('Revoke') : t('Grant');
      row.appendChild(control);
      list.appendChild(row);
    });
    content.appendChild(list);
  }

  function renderSimpleList(
    page: HTMLElement,
    title: string,
    values: readonly string[],
    emptyText: string,
    className: string
  ): void {
    const content = section(page, title);
    if (!values.length) {
      append(content, 'p', 'plugin-details-empty', emptyText);
      return;
    }
    const list = document.createElement('ul');
    list.className = className || 'plugin-details-list';
    values.forEach((value) => append(list, 'li', '', value));
    content.appendChild(list);
  }

  function renderPage(
    tab: PluginDetailsTab | null | undefined,
    options: PluginDetailsRenderOptions = {}
  ): void {
    const root = view();
    if (!root || !tab || !tab.detail) return;
    const scrollTop = options.resetScroll ? 0 : root.scrollTop;
    const detail = tab.detail;
    const stateDescriptor = statusDescriptor(detail);
    root.setAttribute('aria-label', t('Plugin details') + ': ' + detail.name);
    root.replaceChildren();

    const page = document.createElement('div');
    page.className = 'plugin-details-page';
    page.dataset.pluginId = detail.id;
    root.appendChild(page);

    const header = document.createElement('header');
    header.className = 'plugin-details-hero';
    const identity = document.createElement('div');
    identity.className = 'plugin-details-identity';
    const mark = append(
      identity,
      'span',
      'plugin-details-mark',
      detail.name.slice(0, 1).toUpperCase() || '+'
    );
    mark.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('div');
    copy.className = 'plugin-details-copy';
    append(copy, 'span', 'plugin-details-kicker', t('Extension'));
    append(copy, 'h1', 'plugin-details-title', detail.name);
    const metadata = document.createElement('div');
    metadata.className = 'plugin-details-metadata';
    append(metadata, 'code', 'plugin-details-id', detail.id);
    if (detail.version) append(metadata, 'span', 'plugin-details-version', 'v' + detail.version);
    const badge = append(metadata, 'span', 'plugin-details-status', stateDescriptor.text);
    badge.dataset.tone = stateDescriptor.tone;
    copy.appendChild(metadata);
    identity.appendChild(copy);
    header.appendChild(identity);

    const actions = document.createElement('div');
    actions.className = 'plugin-details-actions';
    actions.appendChild(actionButton('refresh', t('Refresh details'), detail.id, busy));
    if (detail.status !== 'invalid' && detail.status !== 'incompatible') {
      actions.appendChild(actionButton(
        detail.enabled ? 'disable' : 'enable',
        detail.enabled ? t('Disable plugin') : t('Enable plugin'),
        detail.id,
        busy
      ));
    }
    actions.appendChild(actionButton('uninstall', t('Uninstall plugin'), detail.id, busy));
    header.appendChild(actions);
    page.appendChild(header);

    append(
      page,
      'p',
      'plugin-details-description' + (detail.description ? '' : ' is-empty'),
      detail.description || t('No description provided.')
    );

    const facts = document.createElement('dl');
    facts.className = 'plugin-details-facts';
    fact(facts, t('Status'), stateDescriptor.text, stateDescriptor.tone);
    fact(
      facts,
      t('Integrity'),
      detail.integrity.valid ? t('Verified') : t('Verification failed'),
      detail.integrity.valid ? 'enabled' : 'error'
    );
    fact(facts, t('Installed'), formatInstalledAt(detail.installedAt));
    fact(facts, t('Plugin API'), detail.engines.pluginApi || '--');
    fact(facts, t('BOBOCloud'), detail.engines.bobocloud || '--');
    page.appendChild(facts);

    const message = append(page, 'p', 'plugin-details-message', tab.message || '');
    if (tab.messageTone) message.dataset.tone = tab.messageTone;
    if (!tab.message) message.hidden = true;

    renderPermissions(page, detail);
    renderSimpleList(
      page,
      t('Activation events'),
      detail.activationEvents,
      t('No activation events declared'),
      'plugin-details-list plugin-details-code-list'
    );
    renderSimpleList(
      page,
      t('Contributions'),
      detail.contributionPoints,
      t('No contributions declared'),
      'plugin-details-list plugin-details-code-list'
    );
    if (!detail.integrity.valid && detail.integrity.reason) {
      const integritySection = section(page, t('Integrity'));
      append(
        integritySection,
        'p',
        'plugin-details-integrity-reason',
        detail.integrity.reason
      );
    }

    root.scrollTop = scrollTop;
  }

  function captureUnderlyingView(filePath: string): PluginDetailsViewSnapshot {
    const split = document.getElementById('split-container');
    const diff = document.getElementById('diff-container');
    const image = document.getElementById('image-preview');
    return {
      filePath: filePath || '',
      mode: state.currentViewMode === 'split' || state.currentViewMode === 'diff'
        ? state.currentViewMode
        : 'single',
      splitActive: Boolean(split?.classList.contains('active')),
      diffActive: Boolean(diff?.classList.contains('active')),
      imageActive: Boolean(image && !image.classList.contains('hidden')),
      diffOriginalPath: state.diffOriginalPath || '',
      diffModifiedPath: state.diffModifiedPath || ''
    };
  }

  function concealUnderlyingViews(): void {
    document.getElementById('split-container')?.classList.remove('active');
    document.getElementById('diff-container')?.classList.remove('active');
    document.getElementById('image-preview')?.classList.add('hidden');
    dependencies.getDocumentViews()?.hideAll({ restoreEditor: false });
  }

  function restoreUnderlyingView(fileTab: PluginDetailsStateFileTab): void {
    const snapshot = pendingUnderlyingView;
    if (!snapshot || !fileTab || snapshot.filePath !== fileTab.path) return;
    pendingUnderlyingView = null;
    const views = dependencies.getViews();
    if (snapshot.mode === 'split' && snapshot.splitActive && fileTab.model &&
        typeof views?.openSplit === 'function') {
      views.openSplit();
      return;
    }
    if (snapshot.mode === 'diff' && snapshot.diffActive &&
        typeof views?.openDiff === 'function') {
      views.openDiff(snapshot.diffOriginalPath, snapshot.diffModifiedPath);
      return;
    }
    // Image tabs are restored by workspace.activateTab() itself.
  }

  function activate(
    tab: PluginDetailsTab | null | undefined,
    options: PluginDetailsRenderOptions = {}
  ): boolean {
    if (!tab || disposed) return false;
    const root = view();
    if (!root) return false;
    const previousDetailsTab = activeTab();
    const fileTab = state.tabs.find((candidate) => candidate.path === state.activeTabPath);
    if (fileTab) {
      tab.previousFilePath = fileTab.path;
      tab.previousView = captureUnderlyingView(fileTab.path);
      pendingUnderlyingView = null;
    } else if (previousDetailsTab?.previousView) {
      tab.previousFilePath = previousDetailsTab.previousFilePath;
      tab.previousView = previousDetailsTab.previousView;
    }
    concealUnderlyingViews();
    const container = document.getElementById('container');
    if (container) container.style.display = 'none';
    root.hidden = false;
    root.classList.add('active');
    state.currentViewMode = 'plugin-details';
    state.activeTabPath = tab.key;
    renderPage(tab, { resetScroll: options.resetScroll === true });
    const workspace = dependencies.getWorkspace();
    workspace?.updateTabbar();
    workspace?.updateTitlebar();
    workspace?.updateEmptyState();
    return true;
  }

  function deactivate(tabOverride?: PluginDetailsTab | null): void {
    if (state.currentViewMode !== 'plugin-details') return;
    const tab = tabOverride || activeTab();
    if (tab?.previousView) pendingUnderlyingView = tab.previousView;
    const root = document.getElementById(PAGE_ID);
    if (root) {
      root.hidden = true;
      root.classList.remove('active');
    }
    const container = document.getElementById('container');
    if (container) container.style.display = '';
    state.currentViewMode = 'single';
  }

  function restoreAfterClose(tab: PluginDetailsTab | null): void {
    let candidate = tab?.previousFilePath
      ? state.tabs.find((fileTab) => fileTab.path === tab.previousFilePath)
      : undefined;
    if (!candidate && state.tabs.length) candidate = state.tabs[state.tabs.length - 1];
    deactivate(tab);
    const workspace = dependencies.getWorkspace();
    if (candidate && typeof workspace?.activateTab === 'function') {
      workspace.activateTab(candidate.path);
      return;
    }
    state.activeTabPath = null;
    workspace?.updateTabbar();
    workspace?.updateTitlebar();
    workspace?.updateEmptyState();
  }

  function closeByKey(key: string): boolean {
    const tab = findTabByKey(key);
    if (!tab) return false;
    const wasActive = state.activeTabPath === tab.key;
    const index = tabs().indexOf(tab);
    if (index >= 0) tabs().splice(index, 1);
    if (wasActive) restoreAfterClose(tab);
    else dependencies.getWorkspace()?.updateTabbar();
    return true;
  }

  function closeById(id: string): boolean {
    const tab = findTabById(id);
    return tab ? closeByKey(tab.key) : false;
  }

  function statusMessage(tab: PluginDetailsTab | null, text: string, tone: string): void {
    if (!tab || disposed) return;
    tab.message = text || '';
    tab.messageTone = tone || '';
    if (state.activeTabPath === tab.key) renderPage(tab);
  }

  function genericError(): string {
    return t('Unknown error');
  }

  async function refreshDetail(
    id: unknown,
    options: PluginDetailsRefreshOptions = {}
  ): Promise<boolean> {
    const validId = safeId(id);
    if (disposed || !validId || !host) return false;
    const request = (refreshTokens.get(validId) || 0) + 1;
    refreshTokens.set(validId, request);
    try {
      const result = await host.get(validId);
      if (disposed || refreshTokens.get(validId) !== request) return false;
      const detail = normalizeDetail(result);
      if (!detail) {
        closeById(validId);
        return false;
      }
      let tab = findTabById(validId);
      if (!tab) {
        tab = {
          id: validId,
          key: tabKey(validId),
          detail,
          previousFilePath: '',
          message: '',
          messageTone: ''
        };
        tabs().push(tab);
      } else {
        tab.detail = detail;
      }
      if (options.activate) activate(tab, { resetScroll: options.resetScroll === true });
      else if (state.activeTabPath === tab.key) renderPage(tab);
      else dependencies.getWorkspace()?.updateTabbar();
      return true;
    } catch (_) {
      if (disposed || refreshTokens.get(validId) !== request) return false;
      const existing = findTabById(validId);
      if (existing) statusMessage(existing, genericError(), 'error');
      return false;
    }
  }

  async function openValue(id: unknown): Promise<boolean> {
    const validId = safeId(id);
    if (!validId || disposed) return false;
    return refreshDetail(validId, {
      activate: true,
      resetScroll: state.activeTabPath !== tabKey(validId)
    });
  }

  function open(id: string): Promise<boolean> {
    return openValue(id);
  }

  async function updatePlugin(
    id: string,
    action: PluginDetailsMutationAction,
    permission: string
  ): Promise<void> {
    if (busy || disposed) return;
    const tab = findTabById(id);
    if (!tab || !host) return;
    busy = true;
    renderPage(tab);
    try {
      if (action === 'enable') await host.enable(id);
      else if (action === 'disable') await host.disable(id);
      else if (action === 'grant') await host.grant(id, permission as PluginPermissionDto);
      else await host.revoke(id, permission as PluginPermissionDto);
      if (disposed) return;
      await refreshDetail(id, { activate: state.activeTabPath === tab.key });
      const current = findTabById(id);
      if (current) {
        statusMessage(
          current,
          action === 'enable'
            ? t('Plugin enabled')
            : action === 'disable'
              ? t('Plugin disabled')
              : action === 'grant'
                ? t('Permission granted')
                : t('Permission revoked'),
          'success'
        );
      }
    } catch (_) {
      if (!disposed) statusMessage(tab, genericError(), 'error');
    } finally {
      busy = false;
      if (!disposed) renderPage(activeTab());
    }
  }

  async function uninstall(id: string): Promise<void> {
    if (busy || disposed) return;
    const tab = findTabById(id);
    if (!tab || !host) return;
    const confirm = dependencies.getConfirm();
    const approved = confirm
      ? await confirm({
          title: t('Uninstall plugin'),
          message: t(
            'This removes "{name}" from this device. Plugin workspace data is not modified.',
            { name: tab.detail.name }
          ),
          confirmLabel: t('Uninstall'),
          cancelLabel: t('Cancel'),
          danger: true
        })
      : dependencies.nativeConfirm(t('Uninstall "{name}"?', { name: tab.detail.name }));
    if (!approved || disposed) return;
    busy = true;
    renderPage(tab);
    try {
      await host.uninstall(id);
      if (!disposed) closeById(id);
    } catch (_) {
      if (!disposed) statusMessage(tab, genericError(), 'error');
    } finally {
      busy = false;
      if (!disposed) renderPage(activeTab());
    }
  }

  function onViewClick(event: Event): void {
    const target = event.target as Partial<Element> | null;
    if (!target || typeof target.closest !== 'function') return;
    const control = target.closest<HTMLButtonElement>('[data-plugin-details-action]');
    const root = view();
    if (!control || !root?.contains(control) || control.disabled) return;
    const id = safeId(control.dataset.pluginId);
    const action = control.dataset.pluginDetailsAction;
    if (!id || !action) return;
    if (action === 'refresh') void refreshDetail(id, { activate: true });
    else if (action === 'uninstall') void uninstall(id);
    else if (action === 'enable' || action === 'disable' || action === 'grant' || action === 'revoke') {
      void updatePlugin(id, action, control.dataset.permission || '');
    }
  }

  function updateFromChanged(payload: unknown): void {
    if (disposed) return;
    const change = isPlainObject(payload) ? payload : {};
    const supplied = Array.isArray(change.plugins) ? change.plugins : null;
    if (!supplied) {
      tabs().slice().forEach((tab) => {
        void refreshDetail(tab.id);
      });
      return;
    }
    const byId = new Map<string, PluginDetailsDto>();
    supplied.forEach((record) => {
      const detail = normalizeDetail(record);
      if (detail) byId.set(detail.id, detail);
    });
    tabs().slice().forEach((tab) => {
      const detail = byId.get(tab.id);
      if (!detail) {
        closeById(tab.id);
        return;
      }
      tab.detail = detail;
      if (state.activeTabPath === tab.key) renderPage(tab);
    });
    dependencies.getWorkspace()?.updateTabbar();
  }

  function providerTabs(): readonly PluginDetailsWorkbenchTabDto[] {
    return tabs().map((tab) => ({
      key: tab.key,
      name: tab.detail.name,
      title: t('Plugin details') + ': ' + tab.detail.name,
      category: t('Extensions'),
      closeable: true,
      draggable: false
    }));
  }

  function onLanguageChanged(): void {
    if (disposed) return;
    const tab = activeTab();
    if (tab) renderPage(tab);
    const workspace = dependencies.getWorkspace();
    workspace?.updateTabbar();
    workspace?.updateTitlebar();
  }

  function onOpenPluginDetails(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    const id = isPlainObject(detail) ? detail.id : undefined;
    void openValue(id);
  }

  function init(): void {
    if (initialized || disposed) return;
    initialized = true;
    tabs();
    view();

    const workspace = dependencies.getWorkspace();
    if (typeof workspace?.registerWorkbenchTabProvider === 'function') {
      const provider: PluginDetailsTabProvider = {
        getTabs: providerTabs,
        activate: (key) => activate(findTabByKey(key)),
        close: closeByKey,
        deactivate: () => deactivate(),
        afterFileActivation: restoreUnderlyingView
      };
      disposables.add(workspace.registerWorkbenchTabProvider('plugin-details', provider));
    }
    if (host) {
      disposables.add(host.onDidChange((change: PluginManagementChangedDto) => {
        updateFromChanged(change);
      }));
    }
    globalWindow.addEventListener('bobo:language-changed', onLanguageChanged);
    disposables.add(toDisposable(() => {
      globalWindow.removeEventListener('bobo:language-changed', onLanguageChanged);
    }));
    globalWindow.addEventListener('bobo:open-plugin-details', onOpenPluginDetails);
    disposables.add(toDisposable(() => {
      globalWindow.removeEventListener('bobo:open-plugin-details', onOpenPluginDetails);
    }));
  }

  function dispose(): void {
    if (disposed) return;
    if (state.currentViewMode === 'plugin-details') restoreAfterClose(activeTab());
    state.pluginDetailTabs = [];
    const root = document.getElementById(PAGE_ID);
    if (root) root.remove();
    disposed = true;
    busy = false;
    refreshTokens.clear();
    disposables.dispose();
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    init,
    open,
    dispose
  });
}
