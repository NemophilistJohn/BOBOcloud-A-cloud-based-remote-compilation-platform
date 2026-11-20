// Server project and cache management presentation service.
//
// The service keeps the historical Projects DOM contract intact while moving
// the preload and legacy BOBO dependencies behind typed injected ports.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  ProjectsCacheCenterPort,
  ProjectsDependencies,
  ProjectsListResponseWireDto,
  ProjectsOpenOptionsDto,
  ProjectsProjectDto,
  ProjectsProjectNamesDto,
  ProjectsProjectWireDto,
  ProjectsService,
  ProjectsStorageInfoDto,
  ProjectsStorageInfoWireDto
} from '../types/projects';

export const PROJECTS_SERVICE_ID = 'workbench.projects' as const;

const PROJECT_COLORS = [
  '#61afef', '#98c379', '#e5c07b', '#c678dd',
  '#e06c75', '#56b6c2', '#d19a66', '#ff6b9d',
  '#7ee787', '#79c0ff', '#f0883e', '#a371f7'
] as const;
const QUOTA_COLORS = {
  projects: '#4ca8ed',
  projectsMuted: '#315f79',
  cache: '#42c58b',
  cacheMuted: '#315f58',
  other: '#9a8fc1',
  free: 'rgba(255,255,255,0.055)'
} as const;
type ProjectSort = 'size' | 'modified' | 'name';

interface ProjectView extends ProjectsProjectDto {
  readonly color: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ownStringMap(value: unknown): ProjectsProjectNamesDto {
  const result = Object.create(null) as Record<string, string>;
  if (!isRecord(value)) return result;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch (_) {
    return result;
  }
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) continue;
      if (typeof descriptor.value === 'string' && descriptor.value) result[key] = descriptor.value;
    } catch (_) {
      // A malformed local settings object must not prevent the panel opening.
    }
  }
  return result;
}

function normalizeProject(value: unknown): ProjectsProjectDto | null {
  if (!isRecord(value)) return null;
  const key = stringValue(value.key);
  if (!key) return null;
  return Object.freeze({
    key,
    name: stringValue(value.name),
    sizeBytes: finiteNumber(value.size_bytes),
    files: finiteNumber(value.files),
    modTime: finiteNumber(value.mod_time)
  });
}

function normalizeStorageInfo(value: ProjectsStorageInfoWireDto | null | undefined): ProjectsStorageInfoDto | null {
  if (!value || !isRecord(value)) return null;
  const rawProjects = Array.isArray(value.projects) ? value.projects : [];
  const projects = rawProjects
    .map((project) => normalizeProject(project))
    .filter((project): project is ProjectsProjectDto => project !== null);
  return Object.freeze({
    totalUsedBytes: finiteNumber(value.total_used_bytes),
    quotaBytes: finiteNumber(value.quota_bytes),
    persistBytes: finiteNumber(value.persist_bytes),
    projectsTotalBytes: finiteNumber(value.projects_total_bytes),
    projects: Object.freeze(projects)
  });
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value) return value;
  if (isRecord(value) && typeof value.message === 'string' && value.message) return value.message;
  return fallback;
}

function responseSuccess(value: unknown): boolean {
  return isRecord(value) && Boolean(value.success);
}

/**
 * Resolve a user-facing project label without treating an opaque server key as
 * a durable display name. This remains exported for the cache model tests and
 * older consumers that use the pure helper.
 */
export function resolveProjectDisplayName(
  project: ProjectsProjectWireDto | ProjectsProjectDto | null | undefined,
  names: ProjectsProjectNamesDto | null | undefined
): string {
  const source = project || {};
  const key = stringValue(source.key);
  const serverName = source.name && stringValue(source.name) !== key
    ? stringValue(source.name)
    : '';
  return serverName || names?.[key] || key || '';
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createProjectsService(dependencies: ProjectsDependencies): ProjectsService {
  const documentRef = dependencies.document;
  const state = dependencies.state;
  const listeners = new DisposableStore();
  let initialized = false;
  let disposed = false;
  let projectNamesLoadVersion = 0;
  let projectsLoadVersion = 0;
  let connectionLoadVersion = 0;
  let localProjectNames: ProjectsProjectNamesDto = Object.freeze(Object.create(null));
  let projectSort: ProjectSort = 'size';
  let suppressDownloadOpenPrompt = false;
  let activeProjectMenu: string | null = null;
  let projectMenuCloseTimer: number | null = null;
  let lastProjects: readonly ProjectView[] = Object.freeze([]);
  let lastStorageInfo: ProjectsStorageInfoDto | null = null;

  function byId<ElementType extends HTMLElement = HTMLElement>(id: string): ElementType {
    const element = documentRef.getElementById(id);
    if (!element) throw new Error('Missing required projects element: ' + id);
    return element as ElementType;
  }

  function optionalCacheCenter(): ProjectsCacheCenterPort | null {
    return dependencies.getCacheCenter() || null;
  }

  function t(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, (match, key: string) => (
      replacements && replacements[key] !== undefined ? String(replacements[key]) : match
    ));
  }

  function projectViewIdentity(): string {
    const auth = state.auth || {};
    const server = state.serverSettings || {};
    const user = auth.user || {};
    return [
      stringValue(server.ip),
      stringValue(auth.token),
      stringValue(user.id || user.uid)
    ].join('\n');
  }

  function cloudViewOpen(): boolean {
    return Boolean(documentRef.getElementById('cloud-sidebar-view')?.classList.contains('active'));
  }

  function removeQuotaBanner(): void {
    documentRef.getElementById('quota-warn-banner')?.remove();
  }

  function open(options: ProjectsOpenOptionsDto = {}): void {
    if (disposed) return;
    removeQuotaBanner();
    const workbench = dependencies.getWorkbench();
    if (!cloudViewOpen()) workbench?.setPrimaryView?.('cloud');
    workbench?.setPrimaryVisible?.(true);
    switchTab(options.tab || activeTabName());
    void loadAll();
    void refreshConnectionLatency();
  }

  function close(): void {
    if (disposed) return;
    projectNamesLoadVersion += 1;
    projectsLoadVersion += 1;
    connectionLoadVersion += 1;
    optionalCacheCenter()?.setVisible(false);
    closeSortMenu();
  }

  function activeTabName(): 'projects' | 'cache' {
    const active = documentRef.querySelector<HTMLElement>('.projects-tab.active');
    return active?.dataset.ptab === 'cache' ? 'cache' : 'projects';
  }

  function switchTab(name: string): void {
    if (disposed || (name !== 'projects' && name !== 'cache')) return;
    documentRef.querySelectorAll<HTMLElement>('.projects-tab').forEach((tab) => {
      const active = tab.dataset.ptab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    });
    documentRef.querySelectorAll<HTMLElement>('.projects-pane').forEach((pane) => {
      const active = pane.id === 'projects-pane-' + name;
      pane.classList.toggle('active', active);
      pane.hidden = !active;
    });
    const cloudView = documentRef.getElementById('cloud-sidebar-view');
    cloudView?.classList.toggle('cache-active', name === 'cache');
    cloudView?.classList.toggle('quota-projects-active', name === 'projects');
    cloudView?.classList.toggle('quota-cache-active', name === 'cache');
    optionalCacheCenter()?.setVisible(name === 'cache' && cloudViewOpen());
    renderQuota(lastStorageInfo);
  }

  async function loadAll(): Promise<void> {
    if (disposed) return;
    const requestVersion = ++projectNamesLoadVersion;
    const requestIdentity = projectViewIdentity();
    let names: ProjectsProjectNamesDto;
    try {
      names = ownStringMap(await dependencies.host.readProjectNames());
    } catch (_) {
      names = Object.freeze(Object.create(null));
    }
    if (disposed || requestVersion !== projectNamesLoadVersion ||
        requestIdentity !== projectViewIdentity() || !cloudViewOpen()) return;
    localProjectNames = names;
    optionalCacheCenter()?.setProjectNames(names);
    const cacheCenter = optionalCacheCenter();
    await Promise.all([
      loadProjects(),
      cacheCenter
        ? Promise.resolve(cacheCenter.load({ force: true })).catch(() => undefined)
        : Promise.resolve()
    ]);
  }

  function renderQuota(storageInfo: ProjectsStorageInfoDto | null): void {
    const summary = documentRef.getElementById('projects-summary');
    const pie = documentRef.getElementById('quota-pie');
    const center = documentRef.getElementById('quota-pie-center');
    const legend = documentRef.getElementById('quota-pie-text');
    if (!summary || !pie || !center || !legend) return;
    if (!storageInfo) {
      summary.textContent = t('Loading...');
      center.textContent = '—';
      pie.style.background = 'conic-gradient(' + QUOTA_COLORS.free + ' 0% 100%)';
      legend.textContent = '';
      return;
    }

    const used = Math.max(0, storageInfo.totalUsedBytes);
    const quota = Math.max(0, storageInfo.quotaBytes);
    const projects = Math.max(0, storageInfo.projectsTotalBytes);
    const cache = Math.max(0, storageInfo.persistBytes);
    const other = Math.max(0, used - projects - cache);
    const free = quota > 0 ? Math.max(0, quota - used) : 0;
    const totalForChart = quota > 0 ? Math.max(quota, used) : used;
    const chartTotal = totalForChart || 1;
    const projectColor = activeTabName() === 'projects' ? QUOTA_COLORS.projects : QUOTA_COLORS.projectsMuted;
    const cacheColor = activeTabName() === 'cache' ? QUOTA_COLORS.cache : QUOTA_COLORS.cacheMuted;
    const slices: Array<readonly [string, number]> = [
      [projectColor, projects],
      [cacheColor, cache],
      [QUOTA_COLORS.other, other]
    ];
    if (quota > 0) slices.push([QUOTA_COLORS.free, free]);
    const gradients: string[] = [];
    let cursor = 0;
    slices.forEach(([color, bytes]) => {
      const value = Math.max(0, Math.min(bytes, chartTotal - cursor));
      if (value <= 0) return;
      const next = Math.min(100, cursor / chartTotal * 100 + value / chartTotal * 100);
      gradients.push(color + ' ' + (cursor / chartTotal * 100).toFixed(2) + '% ' + next.toFixed(2) + '%');
      cursor += value;
    });
    if (cursor < chartTotal) gradients.push(QUOTA_COLORS.free + ' ' + (cursor / chartTotal * 100).toFixed(2) + '% 100%');
    pie.style.background = 'conic-gradient(' + (gradients.length ? gradients.join(', ') : QUOTA_COLORS.free + ' 0% 100%') + ')';
    pie.setAttribute('aria-label', quota > 0
      ? t('Account storage {used} / {quota}', { used: formatBytes(used), quota: formatBytes(quota) })
      : t('Account storage {used}', { used: formatBytes(used) }));
    center.innerHTML = '<strong>' + escapeHtml(formatBytes(used)) + '</strong>' +
      '<small>' + escapeHtml(quota > 0 ? '/ ' + formatBytes(quota) : t('Unlimited')) + '</small>';
    const percent = quota > 0 ? Math.min(100, Math.round(used / quota * 100)) : 0;
    summary.innerHTML = quota > 0
      ? '<strong>' + escapeHtml(formatBytes(used)) + '</strong><small>' + escapeHtml(t('of {quota}', { quota: formatBytes(quota) })) + '</small>'
      : '<strong>' + escapeHtml(formatBytes(used)) + '</strong><small>' + escapeHtml(t('Unlimited')) + '</small>';
    const rows: Array<readonly [string, string, number]> = [
      [t('Projects'), QUOTA_COLORS.projects, projects],
      [t('Cache'), QUOTA_COLORS.cache, cache]
    ];
    if (other > 0) rows.push([t('Other'), QUOTA_COLORS.other, other]);
    if (quota > 0) rows.push([t('Free'), QUOTA_COLORS.free, free]);
    legend.innerHTML = rows.map(([label, color, bytes]) => (
      '<div class="cloud-storage-legend-row"><span class="cloud-storage-swatch" style="background:' + color + '"></span>' +
      '<span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(formatBytes(bytes)) + '</strong></div>'
    )).join('');
  }

  function sortedProjects(): readonly ProjectView[] {
    return lastProjects.slice().sort((left, right) => {
      if (projectSort === 'modified') return right.modTime - left.modTime || right.sizeBytes - left.sizeBytes;
      if (projectSort === 'name') {
        return resolveProjectDisplayName(left, localProjectNames).localeCompare(
          resolveProjectDisplayName(right, localProjectNames),
          documentRef.documentElement.lang || undefined,
          { sensitivity: 'base' }
        );
      }
      return right.sizeBytes - left.sizeBytes || right.modTime - left.modTime;
    });
  }

  function renderProjectList(): void {
    const list = documentRef.getElementById('projects-list');
    if (!list) return;
    const count = documentRef.getElementById('cloud-project-count');
    if (count) count.textContent = t('Projects {count}', { count: lastProjects.length });
    const projects = sortedProjects();
    if (projects.length === 0) {
      list.innerHTML = '<div class="projects-empty">' + escapeHtml(t('No projects on server yet.')) + '</div>';
      return;
    }

    list.innerHTML = projects.map((project) => {
      const displayName = resolveProjectDisplayName(project, localProjectNames);
      const modTime = project.modTime
        ? new Date(project.modTime * 1000).toLocaleDateString(documentRef.documentElement.lang || undefined)
        : '—';
      const workspaceRoot = stringValue(state.workspaceRoot);
      const isCurrentProject = Boolean(workspaceRoot && dependencies.projectKey(workspaceRoot) === project.key);
      const actions = '<div class="cloud-project-actions">' +
        '<button type="button" class="cloud-project-menu-toggle" data-key="' + escapeHtml(project.key) +
          '" aria-label="' + escapeHtml(t('Project actions')) + '" title="' + escapeHtml(t('Project actions')) +
          '" aria-haspopup="menu" aria-expanded="' + (activeProjectMenu === project.key ? 'true' : 'false') + '">' +
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>' +
        '<div class="cloud-project-menu" role="menu"' + (activeProjectMenu === project.key ? '' : ' hidden') + '>' +
          '<button type="button" role="menuitem" data-project-action="download" data-key="' + escapeHtml(project.key) +
            '" data-name="' + escapeHtml(displayName) + '"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + escapeHtml(t('Download')) + '</span></button>' +
          (isCurrentProject ? '<button type="button" role="menuitem" data-project-action="sync" data-key="' + escapeHtml(project.key) +
            '"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5m10.2-2A7 7 0 0 0 6.4 7L4 9m16 6-2.4 2A7 7 0 0 1 4.8 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + escapeHtml(t('Sync')) + '</span></button>' : '') +
          '<button type="button" role="menuitem" class="is-danger" data-project-action="delete" data-key="' + escapeHtml(project.key) +
            '" data-name="' + escapeHtml(displayName) + '"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + escapeHtml(t('Delete project')) + '</span></button>' +
        '</div></div>';
      return '<article class="cloud-project-row" title="' + escapeHtml(displayName) + '">' +
        '<span class="proj-dot" style="background:' + project.color + '"></span>' +
        '<span class="cloud-project-copy"><strong>' + escapeHtml(displayName) + '</strong>' +
          '<small><span>' + escapeHtml(formatBytes(project.sizeBytes)) + '</span><span>' +
          escapeHtml(t('{count} files', { count: project.files })) + '</span><span>' +
          escapeHtml(t('Modified {date}', { date: modTime })) + '</span></small></span>' +
        actions +
        '</article>';
    }).join('');
  }

  function closeProjectMenu(): void {
    if (projectMenuCloseTimer !== null) {
      clearTimeout(projectMenuCloseTimer);
      projectMenuCloseTimer = null;
    }
    if (!activeProjectMenu) return;
    activeProjectMenu = null;
    documentRef.querySelectorAll<HTMLElement>('.cloud-project-menu').forEach((menu) => { menu.hidden = true; });
    documentRef.querySelectorAll<HTMLButtonElement>('.cloud-project-menu-toggle').forEach((button) => {
      button.setAttribute('aria-expanded', 'false');
    });
  }

  function openProjectMenu(button: HTMLButtonElement): void {
    const key = button.dataset.key || '';
    if (!key) return;
    if (activeProjectMenu === key) return;
    closeProjectMenu();
    activeProjectMenu = key;
    button.setAttribute('aria-expanded', 'true');
    button.parentElement?.querySelector<HTMLElement>('.cloud-project-menu')?.removeAttribute('hidden');
  }

  function deferProjectMenuClose(): void {
    if (projectMenuCloseTimer !== null) clearTimeout(projectMenuCloseTimer);
    projectMenuCloseTimer = window.setTimeout(() => {
      projectMenuCloseTimer = null;
      closeProjectMenu();
    }, 260);
  }

  async function downloadProject(button: HTMLButtonElement): Promise<void> {
    const key = button.dataset.key || '';
    const name = button.dataset.name || key;
    const rclone = dependencies.getRclone();
    if (!key || !rclone) return;
    closeProjectMenu();
    button.disabled = true;
    try {
      const destination = await rclone.pickProjectDownload(name);
      if (!destination) return;
      const prepared = await rclone.prepareProjectDownload(
        { folderName: name, folderKey: key },
        { dest: destination.path, localGrant: destination.grantId }
      ) as { success?: unknown; remoteGrantId?: unknown; error?: unknown } | null;
      if (!prepared || prepared.success !== true || typeof prepared.remoteGrantId !== 'string') {
        throw new Error(errorMessage(prepared?.error, 'Project download failed'));
      }
      const result = await rclone.pull({
        dest: destination.path,
        localGrant: destination.grantId,
        remoteGrantId: prepared.remoteGrantId
      }) as { success?: unknown; error?: { message?: unknown } } | null;
      if (!result || result.success !== true) {
        throw new Error(errorMessage(result?.error, 'Project download failed'));
      }
      if (suppressDownloadOpenPrompt) return;
      const confirm = dependencies.getConfirm();
      if (!confirm) return;
      const decision = await confirm({
        title: t('Open downloaded project'),
        message: t("Do you want to open project '{name}'?", { name }),
        confirmLabel: t('Yes'),
        cancelLabel: t('No'),
        checkboxLabel: t("Don't ask again this session"),
        returnDetails: true
      });
      if (decision.checkboxChecked) {
        suppressDownloadOpenPrompt = true;
        return;
      }
      if (!decision.confirmed) return;
      const opened = await dependencies.getWorkspaceLaunch()?.requestOpen({
        path: destination.path,
        localGrant: destination.grantId
      });
      if (opened) dependencies.getWorkbench()?.setPrimaryView?.('explorer');
    } catch (error) {
      dependencies.alert?.(errorMessage(error, 'Project download failed'));
    } finally {
      button.disabled = false;
    }
  }

  async function syncProject(button: HTMLButtonElement): Promise<void> {
    closeProjectMenu();
    button.disabled = true;
    try {
      const result = await dependencies.syncCurrentProject();
      if (result === false) dependencies.alert?.(t('Project sync failed'));
    } catch (error) {
      dependencies.alert?.(errorMessage(error, 'Project sync failed'));
    } finally {
      button.disabled = false;
    }
  }

  async function deleteProject(button: HTMLButtonElement): Promise<void> {
    closeProjectMenu();
    const key = button.dataset.key || '';
    const displayName = button.dataset.name || key;
    const confirm = dependencies.getConfirm();
    if (!confirm) return;
    const ok = await confirm({
      title: t('Delete project'),
      message: '"' + displayName + '"\n' + t('This cannot be undone.'),
      confirmLabel: t('Delete'),
      danger: true
    });
    if (!ok) return;
    projectsLoadVersion += 1;
    button.disabled = true;
    try {
      const response = await dependencies.sendToServer('deleteProject', { folderKey: key }, { quiet: true });
      if (responseSuccess(response)) {
        await loadAll();
      } else {
        dependencies.alert?.(errorMessage(isRecord(response) ? response.error : undefined, 'Delete failed'));
        button.disabled = false;
      }
    } catch (error) {
      dependencies.alert?.(errorMessage(error, 'Delete failed'));
      button.disabled = false;
    }
  }

  async function loadProjects(): Promise<void> {
    if (disposed) return;
    const requestVersion = ++projectsLoadVersion;
    const requestIdentity = projectViewIdentity();
    const list = byId('projects-list');

    renderQuota(lastStorageInfo);
    list.innerHTML = '<div class="projects-loading">Loading…</div>';

    const rawResponse = await dependencies.sendToServer('listProjects', {}, { quiet: true });
    const response = rawResponse as ProjectsListResponseWireDto;
    if (disposed || requestVersion !== projectsLoadVersion ||
        requestIdentity !== projectViewIdentity() || !cloudViewOpen()) return;

    const storageInfo = responseSuccess(response) ? normalizeStorageInfo(response.storageInfo) : null;
    if (!storageInfo) {
      const error = errorMessage(isRecord(response) ? response.error : undefined, 'Failed to load');
      const summary = documentRef.getElementById('projects-summary');
      if (summary) summary.innerHTML = '<small class="cloud-storage-error">' + escapeHtml(error) + '</small>';
      list.innerHTML = '<div class="projects-empty">' + escapeHtml(error) + '</div>';
      return;
    }

    lastStorageInfo = storageInfo;
    lastProjects = storageInfo.projects
      .map((project, index) => Object.freeze({
        ...project,
        color: PROJECT_COLORS[index % PROJECT_COLORS.length] || PROJECT_COLORS[0]
      }));

    // Fill a missing local label from the current workspace immediately. The
    // write is deliberately fire-and-forget so a settings failure never blocks
    // the server project view.
    const workspaceRoot = stringValue(state.workspaceRoot);
    if (workspaceRoot) {
      const currentName = workspaceRoot.split(/[/\\]/).pop() || '';
      const currentKey = dependencies.projectKey(workspaceRoot);
      if (currentKey && currentName && !localProjectNames[currentKey]) {
        const mutableNames = { ...localProjectNames, [currentKey]: currentName };
        localProjectNames = Object.freeze(mutableNames);
        try {
          void Promise.resolve(dependencies.host.saveProjectName(currentKey, currentName))
            .catch(() => undefined);
        } catch (_) {
          // A legacy host mock may reject the write synchronously.
        }
      }
    }

    renderQuota(storageInfo);
    renderProjectList();
  }

  async function refreshConnectionLatency(): Promise<void> {
    const latency = documentRef.getElementById('cloud-server-latency');
    const endpoint = documentRef.getElementById('cloud-server-ip');
    if (!latency || !endpoint) return;
    const server = stringValue(state.serverSettings?.ip);
    endpoint.textContent = server || t('Not configured');
    endpoint.title = server;
    latency.title = '';
    const requestVersion = ++connectionLoadVersion;
    const requestIdentity = projectViewIdentity();
    if (!server) {
      latency.textContent = '—';
      return;
    }
    latency.textContent = t('Checking...');
    const startedAt = Date.now();
    try {
      const response = await dependencies.sendToServer('whoami', {}, { quiet: true });
      if (disposed || requestVersion !== connectionLoadVersion ||
          requestIdentity !== projectViewIdentity() || !cloudViewOpen()) return;
      latency.textContent = responseSuccess(response)
        ? t('{latency} ms', { latency: Math.max(0, Date.now() - startedAt) })
        : t('Unavailable');
      latency.title = latency.textContent;
    } catch (_) {
      if (!disposed && requestVersion === connectionLoadVersion &&
          requestIdentity === projectViewIdentity() && cloudViewOpen()) {
        latency.textContent = t('Unavailable');
        latency.title = latency.textContent;
      }
    }
  }

  function closeSortMenu(): void {
    const menu = documentRef.getElementById('projects-sort-menu');
    const button = documentRef.getElementById('projects-sort-toggle');
    if (menu) menu.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }

  function selectProjectSort(value: string): void {
    if (value !== 'size' && value !== 'modified' && value !== 'name') return;
    projectSort = value;
    documentRef.querySelectorAll<HTMLElement>('[data-project-sort]').forEach((item) => {
      item.setAttribute('aria-checked', item.dataset.projectSort === value ? 'true' : 'false');
    });
    closeSortMenu();
    renderProjectList();
  }

  function listen(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    type: string,
    listener: (event: Event) => void
  ): void {
    target.addEventListener(type, listener);
    listeners.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function bindUI(): void {
    if (initialized || disposed) return;
    initialized = true;
    const cacheCenter = optionalCacheCenter();
    cacheCenter?.init();

    const refresh = byId('projects-refresh');
    const list = byId('projects-list');
    const sortButton = byId('projects-sort-toggle');
    const sortMenu = byId('projects-sort-menu');

    listen(refresh, 'click', () => {
      void loadAll();
      void refreshConnectionLatency();
    });
    listen(sortButton, 'click', (event) => {
      event.stopPropagation();
      const open = sortMenu.hidden;
      sortMenu.hidden = !open;
      sortButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    listen(sortMenu, 'click', (event) => {
      const target = (event as MouseEvent).target as Element | null;
      const option = target?.closest<HTMLElement>('[data-project-sort]');
      if (option && sortMenu.contains(option)) selectProjectSort(option.dataset.projectSort || '');
    });
    listen(documentRef, 'click', (event) => {
      const target = (event as MouseEvent).target as Element | null;
      if (target?.closest('.cloud-project-sort')) return;
      if (target?.closest('.cloud-project-actions')) return;
      closeProjectMenu();
      closeSortMenu();
    });
    listen(documentRef, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') { closeSortMenu(); closeProjectMenu(); }
    });
    listen(list, 'pointerover', (event) => {
      const target = (event as PointerEvent).target as Element | null;
      if (target?.closest('.cloud-project-actions')) {
        if (projectMenuCloseTimer !== null) {
          clearTimeout(projectMenuCloseTimer);
          projectMenuCloseTimer = null;
        }
      }
      const button = target?.closest<HTMLButtonElement>('.cloud-project-menu-toggle');
      if (button && list.contains(button)) openProjectMenu(button);
    });
    listen(list, 'pointerout', (event) => {
      const target = (event as PointerEvent).target as Element | null;
      const actions = target?.closest<HTMLElement>('.cloud-project-actions');
      const next = (event as PointerEvent).relatedTarget as Element | null;
      if (actions && !actions.contains(next)) deferProjectMenuClose();
    });
    // A single delegated listener replaces one closure per project row while
    // retaining the exact button data attributes and click semantics.
    listen(list, 'click', (event) => {
      const target = (event as MouseEvent).target as Element | null;
      const button = target?.closest<HTMLButtonElement>('.cloud-project-menu-toggle, [data-project-action]');
      if (!button || !list.contains(button)) return;
      if (button.classList.contains('cloud-project-menu-toggle')) {
        event.stopPropagation();
        openProjectMenu(button);
        return;
      }
      const action = button.dataset.projectAction;
      if (action === 'delete') void deleteProject(button);
      else if (action === 'download') void downloadProject(button);
      else if (action === 'sync') void syncProject(button);
    });
    documentRef.querySelectorAll<HTMLElement>('#cloud-sidebar-view .projects-tab').forEach((tab) => {
      listen(tab, 'click', () => switchTab(tab.dataset.ptab || 'projects'));
      listen(tab, 'keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'ArrowLeft' && keyboardEvent.key !== 'ArrowRight') return;
        keyboardEvent.preventDefault();
        const next = tab.dataset.ptab === 'projects' ? 'cache' : 'projects';
        switchTab(next);
        documentRef.querySelector<HTMLElement>('.projects-tab[data-ptab="' + next + '"]')?.focus();
      });
    });
    listen(dependencies.events, 'bobo:language-changed', () => {
      if (!cloudViewOpen()) return;
      if (activeTabName() === 'cache') optionalCacheCenter()?.render();
      else renderProjectList();
      renderQuota(lastStorageInfo);
      void refreshConnectionLatency();
    });
    listen(dependencies.events, 'bobo:cloud-storage-changed', () => {
      if (cloudViewOpen()) void loadAll();
    });
    listeners.add(dependencies.host.onOpenServerProjects(() => open()));
  }

  function openWithQuotaError(errorMsg?: string | null): void {
    if (disposed) return;
    removeQuotaBanner();
    open();
    if (!errorMsg) return;
    const slot = documentRef.getElementById('quota-warn-slot');
    if (!slot) return;
    const warning = documentRef.createElement('div');
    warning.id = 'quota-warn-banner';
    warning.className = 'quota-warn-banner';
    warning.textContent = errorMsg;
    slot.replaceChildren(warning);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    projectNamesLoadVersion += 1;
    projectsLoadVersion += 1;
    connectionLoadVersion += 1;
    listeners.dispose();
    optionalCacheCenter()?.setVisible(false);
    removeQuotaBanner();
    closeSortMenu();
  }

  const service: ProjectsService = {
    get disposed() { return disposed; },
    init: bindUI,
    open,
    openWithQuotaError,
    close,
    loadProjects: loadAll,
    switchTab,
    dispose
  };
  return Object.freeze(service);
}
