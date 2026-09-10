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
const FREE_COLOR = 'rgba(255,255,255,0.06)';

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
  let previouslyFocused: Element | null = null;
  let localProjectNames: ProjectsProjectNamesDto = Object.freeze(Object.create(null));
  let focusTimer: number | null = null;
  let quotaBannerTimer: number | null = null;

  function byId<ElementType extends HTMLElement = HTMLElement>(id: string): ElementType {
    const element = documentRef.getElementById(id);
    if (!element) throw new Error('Missing required projects element: ' + id);
    return element as ElementType;
  }

  function optionalCacheCenter(): ProjectsCacheCenterPort | null {
    return dependencies.getCacheCenter() || null;
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

  function projectsModalOpen(): boolean {
    return Boolean(documentRef.getElementById('projects-modal')?.classList.contains('open'));
  }

  function clearFocusTimer(): void {
    if (focusTimer === null) return;
    dependencies.clearTimer(focusTimer);
    focusTimer = null;
  }

  function clearQuotaBannerTimer(): void {
    if (quotaBannerTimer === null) return;
    dependencies.clearTimer(quotaBannerTimer);
    quotaBannerTimer = null;
  }

  function removeQuotaBanner(): void {
    documentRef.getElementById('quota-warn-banner')?.remove();
  }

  function scheduleFocus(): void {
    clearFocusTimer();
    focusTimer = dependencies.setTimer(() => {
      focusTimer = null;
      if (disposed) return;
      const activeTab = documentRef.querySelector<HTMLElement>('.projects-tab.active');
      activeTab?.focus();
    }, 0);
  }

  function open(options: ProjectsOpenOptionsDto = {}): void {
    if (disposed) return;
    removeQuotaBanner();
    previouslyFocused = documentRef.activeElement;
    const modal = byId('projects-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    switchTab(options.tab || 'projects');
    void loadAll();
    scheduleFocus();
  }

  function close(): void {
    if (disposed) return;
    projectNamesLoadVersion += 1;
    projectsLoadVersion += 1;
    clearQuotaBannerTimer();
    const modal = byId('projects-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    optionalCacheCenter()?.setVisible(false);
    if (previouslyFocused && typeof (previouslyFocused as HTMLElement).focus === 'function') {
      (previouslyFocused as HTMLElement).focus();
    }
    previouslyFocused = null;
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
    documentRef.querySelector<HTMLElement>('.projects-card')?.classList.toggle('cache-active', name === 'cache');
    optionalCacheCenter()?.setVisible(name === 'cache' && projectsModalOpen());
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
        requestIdentity !== projectViewIdentity() || !projectsModalOpen()) return;
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

  function renderSummary(
    summary: HTMLElement,
    totalUsed: number,
    quotaBytes: number,
    persistBytes: number,
    projectsTotal: number
  ): void {
    if (quotaBytes > 0) {
      const percentage = Math.min(100, Math.round(totalUsed / quotaBytes * 100));
      const warningClass = percentage >= 90 ? 'warn' : '';
      summary.innerHTML =
        '<span class="storage-big ' + warningClass + '">' + formatBytes(totalUsed) + '</span>' +
        ' / ' + formatBytes(quotaBytes) +
        ' <span class="storage-pct ' + warningClass + '">(' + percentage + '%)</span>' +
        '<div class="storage-bar">' +
          '<div class="storage-bar-fill ' + warningClass + '" style="width:' + percentage + '%"></div>' +
        '</div>' +
        '<div class="storage-sub">Projects ' + formatBytes(projectsTotal) +
        ' · Cache ' + formatBytes(persistBytes) +
        (quotaBytes > totalUsed ? ' · Free ' + formatBytes(quotaBytes - totalUsed) : '') +
        '</div>';
    } else {
      summary.innerHTML =
        '<span class="storage-big">' + formatBytes(totalUsed) + '</span> used' +
        '<div class="storage-bar">' +
          '<div class="storage-bar-fill" style="width:100%"></div>' +
        '</div>' +
        '<div class="storage-sub">Projects ' + formatBytes(projectsTotal) +
        ' · Cache ' + formatBytes(persistBytes) + ' · No quota limit</div>';
    }
  }

  function renderPie(
    pie: HTMLElement,
    center: HTMLElement,
    text: HTMLElement,
    projects: readonly ProjectView[],
    projectsTotal: number
  ): void {
    if (projectsTotal > 0) {
      const segments: string[] = [];
      let cursor = 0;
      for (const project of projects) {
        if (project.sizeBytes <= 0) continue;
        const percentage = project.sizeBytes / projectsTotal * 100;
        segments.push(project.color + ' ' + cursor.toFixed(2) + '% ' + (cursor + percentage).toFixed(2) + '%');
        cursor += percentage;
      }
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        if (lastSegment) {
          const last = lastSegment.split(' ');
          last[last.length - 1] = '100%';
          segments[segments.length - 1] = last.join(' ');
        }
      }
      pie.style.background = 'conic-gradient(' + segments.join(', ') + ')';
      center.innerHTML = projects.length + '<span style="font-size:9px;opacity:0.6">proj</span>';
      text.innerHTML = '<div style="font-weight:600;color:var(--text)">' + formatBytes(projectsTotal) + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim)">total project size</div>';
    } else {
      pie.style.background = 'conic-gradient(' + FREE_COLOR + ' 0% 100%)';
      center.textContent = '—';
      text.innerHTML = '<div style="font-size:11px;color:var(--text-dim)">No project data</div>';
    }
  }

  function renderProjectList(list: HTMLElement, projects: readonly ProjectView[], projectsTotal: number): void {
    if (projects.length === 0) {
      list.innerHTML = '<div class="projects-empty">No projects on server yet.</div>';
      return;
    }

    let html = '<table class="admin-table"><thead><tr>' +
      '<th>Project</th><th>Size</th><th>Files</th><th>Modified</th><th></th>' +
      '</tr></thead><tbody>';
    for (const project of projects) {
      const displayName = resolveProjectDisplayName(project, localProjectNames);
      const modTime = project.modTime ? new Date(project.modTime * 1000).toLocaleDateString() : '-';
      const percentage = projectsTotal > 0
        ? (project.sizeBytes / projectsTotal * 100).toFixed(1) + '%'
        : '';
      html += '<tr>' +
        '<td>' +
          '<span class="proj-dot" style="background:' + project.color + '"></span>' +
          '<code>' + escapeHtml(displayName) + '</code>' +
          (percentage ? '<span class="proj-pct">' + percentage + '</span>' : '') +
        '</td>' +
        '<td>' + formatBytes(project.sizeBytes) + '</td>' +
        '<td class="dim">' + project.files + '</td>' +
        '<td class="dim">' + modTime + '</td>' +
        '<td><button class="admin-mini-btn danger proj-del" data-key="' + escapeHtml(project.key) +
          '" data-name="' + escapeHtml(displayName) + '">Delete</button></td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    list.innerHTML = html;
  }

  async function deleteProject(button: HTMLButtonElement): Promise<void> {
    const key = button.dataset.key || '';
    const displayName = button.dataset.name || key;
    const confirm = dependencies.getConfirm();
    if (!confirm) return;
    const ok = await confirm({
      title: 'Delete project',
      message: '"' + displayName + '"\nThis cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    projectsLoadVersion += 1;
    button.disabled = true;
    button.textContent = '...';
    try {
      const response = await dependencies.sendToServer('deleteProject', { folderKey: key }, { quiet: true });
      if (responseSuccess(response)) {
        await loadAll();
      } else {
        dependencies.alert?.(errorMessage(isRecord(response) ? response.error : undefined, 'Delete failed'));
        button.disabled = false;
        button.textContent = 'Delete';
      }
    } catch (error) {
      dependencies.alert?.(errorMessage(error, 'Delete failed'));
      button.disabled = false;
      button.textContent = 'Delete';
    }
  }

  async function loadProjects(): Promise<void> {
    if (disposed) return;
    const requestVersion = ++projectsLoadVersion;
    const requestIdentity = projectViewIdentity();
    const summary = byId('projects-summary');
    const pie = byId('quota-pie');
    const pieCenter = byId('quota-pie-center');
    const pieText = byId('quota-pie-text');
    const list = byId('projects-list');

    summary.textContent = 'Loading...';
    pie.style.background = '';
    pieCenter.textContent = '...';
    pieText.textContent = '';
    list.innerHTML = '<div class="projects-loading">Loading…</div>';

    const rawResponse = await dependencies.sendToServer('listProjects', {}, { quiet: true });
    const response = rawResponse as ProjectsListResponseWireDto;
    if (disposed || requestVersion !== projectsLoadVersion ||
        requestIdentity !== projectViewIdentity() || !projectsModalOpen()) return;

    const storageInfo = responseSuccess(response) ? normalizeStorageInfo(response.storageInfo) : null;
    if (!storageInfo) {
      const error = errorMessage(isRecord(response) ? response.error : undefined, 'Failed to load');
      summary.textContent = error;
      list.innerHTML = '<div class="projects-empty">' + escapeHtml(error) + '</div>';
      return;
    }

    const totalUsed = storageInfo.totalUsedBytes;
    const quotaBytes = storageInfo.quotaBytes;
    const persistBytes = storageInfo.persistBytes;
    const projectsTotal = storageInfo.projectsTotalBytes;
    const projects = storageInfo.projects
      .slice()
      .sort((left, right) => right.sizeBytes - left.sizeBytes)
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

    renderSummary(summary, totalUsed, quotaBytes, persistBytes, projectsTotal);
    renderPie(pie, pieCenter, pieText, projects, projectsTotal);
    renderProjectList(list, projects, projectsTotal);
  }

  function refreshActiveTab(): Promise<void> {
    if (activeTabName() === 'cache') {
      const cacheCenter = optionalCacheCenter();
      if (cacheCenter) {
        return Promise.resolve(cacheCenter.load({ force: true }))
          .then(() => undefined)
          .catch(() => undefined);
      }
    }
    return loadAll();
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

    const closeX = byId('projects-close-x');
    const closeButton = byId('projects-close');
    const refresh = byId('projects-refresh');
    const modal = byId('projects-modal');
    const list = byId('projects-list');

    listen(closeX, 'click', () => close());
    listen(closeButton, 'click', () => close());
    listen(refresh, 'click', () => { void refreshActiveTab(); });
    listen(modal, 'click', (event) => {
      if (event.target === modal) close();
    });
    // A single delegated listener replaces one closure per project row while
    // retaining the exact button data attributes and click semantics.
    listen(list, 'click', (event) => {
      const target = (event as MouseEvent).target as Element | null;
      const button = target?.closest<HTMLButtonElement>('.proj-del');
      if (!button || !list.contains(button)) return;
      void deleteProject(button);
    });
    documentRef.querySelectorAll<HTMLElement>('.projects-tab').forEach((tab) => {
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
    listen(modal, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        close();
      }
    });
    listen(dependencies.events, 'bobo:language-changed', () => {
      if (!projectsModalOpen()) return;
      if (activeTabName() === 'cache') optionalCacheCenter()?.render();
      else void loadProjects();
    });
    listeners.add(dependencies.host.onOpenServerProjects(() => open()));
  }

  function openWithQuotaError(errorMsg?: string | null): void {
    if (disposed) return;
    removeQuotaBanner();
    clearQuotaBannerTimer();
    open();
    if (!errorMsg) return;
    quotaBannerTimer = dependencies.setTimer(() => {
      quotaBannerTimer = null;
      if (disposed) return;
      removeQuotaBanner();
      const warning = documentRef.createElement('div');
      warning.id = 'quota-warn-banner';
      warning.className = 'quota-warn-banner';
      warning.textContent = errorMsg;
      const card = documentRef.querySelector<HTMLElement>('.projects-card');
      if (card) card.insertBefore(warning, card.children[1] || null);
    }, 400);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    projectNamesLoadVersion += 1;
    projectsLoadVersion += 1;
    clearFocusTimer();
    clearQuotaBannerTimer();
    listeners.dispose();
    optionalCacheCenter()?.setVisible(false);
    removeQuotaBanner();
    const modal = documentRef.getElementById('projects-modal');
    modal?.classList.remove('open');
    modal?.setAttribute('aria-hidden', 'true');
    if (previouslyFocused && typeof (previouslyFocused as HTMLElement).focus === 'function') {
      (previouslyFocused as HTMLElement).focus();
    }
    previouslyFocused = null;
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
