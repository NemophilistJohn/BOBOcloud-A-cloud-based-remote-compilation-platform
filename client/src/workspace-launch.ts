// Capture workspace-open requests before the editor is ready.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  WorkspaceLaunchConsumer,
  WorkspaceLaunchDependencies,
  WorkspaceLaunchFacade,
  WorkspaceLaunchOpenedWorkspaceDto,
  WorkspaceLaunchService
} from '../types/workspace-launch';

export const WORKSPACE_LAUNCH_SERVICE_ID = 'workbench.workspaceLaunch';
export const RECENT_WORKSPACE_STORAGE_KEY = 'bobocloud.recentProjects.v1';
export const RECENT_WORKSPACE_LIMIT = 5;

type WorkspaceLaunchButton = HTMLElement & { disabled: boolean };

function cleanPath(value: unknown): string {
  let path = typeof value === 'string' ? value.trim().slice(0, 4096) : '';
  while (
    path.length > 1 &&
    /[/\\]$/.test(path) &&
    !/^[A-Za-z]:[/\\]$/.test(path)
  ) {
    path = path.slice(0, -1);
  }
  return path;
}

function pathKey(value: unknown): string {
  const path = cleanPath(value);
  if (/^[A-Za-z]:[/\\]/.test(path) || /^\\\\/.test(path)) {
    return path.replace(/\//g, '\\').toLowerCase();
  }
  return path.replace(/\\/g, '/');
}

function projectName(value: string): string {
  const path = cleanPath(value);
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

function displayPath(value: string): string {
  const path = cleanPath(value);
  const limit = 44;
  if (path.length <= limit) return path;
  const separator = path.indexOf('\\') >= 0 ? '\\' : '/';
  const parts = path.split(/[/\\]/).filter(Boolean);
  const tail: string[] = [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part === undefined) continue;
    const candidate = [part, ...tail].join(separator);
    if (tail.length && candidate.length + 3 + separator.length > limit) break;
    tail.unshift(part);
  }
  let compact = tail.join(separator);
  if (compact.length + 3 + separator.length > limit) {
    compact = compact.slice(-(limit - 3 - separator.length));
  }
  return '...' + separator + compact;
}

export function createWorkspaceLaunchService(
  dependencies: WorkspaceLaunchDependencies
): WorkspaceLaunchService {
  let consumer: WorkspaceLaunchConsumer | null = null;
  const pending: WorkspaceLaunchOpenedWorkspaceDto[] = [];
  let draining: Promise<void> | null = null;
  let requestPromise: Promise<boolean> | null = null;
  let initialized = false;
  let busy = false;
  let disposed = false;

  function report(error: unknown): void {
    try {
      dependencies.reportError(error);
    } catch (_) {
      // Error observers cannot interrupt workspace launch or its teardown.
    }
  }

  const lifecycle = new DisposableStore({
    onError: (event) => report(event.error)
  });

  function readRecentProjects(): string[] {
    try {
      const serialized = dependencies.storage?.getItem(RECENT_WORKSPACE_STORAGE_KEY) || '[]';
      const parsed: unknown = JSON.parse(serialized);
      if (!Array.isArray(parsed)) return [];
      const seen = Object.create(null) as Record<string, true>;
      return parsed
        .map((value) => cleanPath(value))
        .filter((path) => {
          const key = pathKey(path);
          if (!key || seen[key]) return false;
          seen[key] = true;
          return true;
        })
        .slice(0, RECENT_WORKSPACE_LIMIT);
    } catch (_) {
      return [];
    }
  }

  function writeRecentProjects(projects: readonly string[]): string[] {
    const next = projects.slice(0, RECENT_WORKSPACE_LIMIT);
    try {
      dependencies.storage?.setItem(
        RECENT_WORKSPACE_STORAGE_KEY,
        JSON.stringify(next)
      );
    } catch (_) {
      // Local storage may be unavailable in privacy/restricted contexts.
    }
    return next;
  }

  function translate(
    key: string,
    replacements?: Readonly<Record<string, unknown>> | null
  ): string {
    const i18n = dependencies.getI18n();
    return i18n && typeof i18n.t === 'function'
      ? i18n.t(key, replacements)
      : key;
  }

  function refreshRecentProjectTranslations(): void {
    if (typeof dependencies.document.querySelectorAll !== 'function') return;
    const buttons = dependencies.document.querySelectorAll<HTMLElement>('.recent-project-remove');
    buttons.forEach((button) => {
      const name = button.getAttribute('data-project-name') || '';
      const label = translate('Remove {name} from recent projects', { name });
      button.title = label;
      button.setAttribute('aria-label', label);
    });
  }

  function renderRecentProjects(): void {
    const section = dependencies.document.getElementById('recent-projects');
    const list = dependencies.document.getElementById('recent-project-list');
    if (!section || !list || typeof dependencies.document.createElement !== 'function' ||
        typeof list.replaceChildren !== 'function') return;

    const projects = readRecentProjects();
    section.hidden = projects.length === 0;
    list.replaceChildren();
    projects.forEach((path) => {
      const name = projectName(path);
      const row = dependencies.document.createElement('div');
      row.className = 'recent-project-row';
      row.setAttribute('role', 'listitem');

      const open = dependencies.document.createElement(
        'button'
      ) as HTMLButtonElement;
      open.type = 'button';
      open.className = 'recent-project-open';
      open.title = path;
      open.setAttribute('aria-label', name + ' - ' + path);
      open.disabled = busy;
      open.addEventListener('click', () => {
        void requestOpen(path);
      });

      const nameNode = dependencies.document.createElement('span');
      nameNode.className = 'recent-project-name';
      nameNode.textContent = name;
      const pathNode = dependencies.document.createElement('span');
      pathNode.className = 'recent-project-path';
      pathNode.textContent = displayPath(path);
      open.append(nameNode, pathNode);

      const remove = dependencies.document.createElement(
        'button'
      ) as HTMLButtonElement;
      remove.type = 'button';
      remove.className = 'recent-project-remove';
      remove.setAttribute('data-project-name', name);
      remove.disabled = busy;
      const removeLabel = translate(
        'Remove {name} from recent projects',
        { name }
      );
      remove.title = removeLabel;
      remove.setAttribute('aria-label', removeLabel);
      remove.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void removeRecentProject(path);
      });

      row.append(open, remove);
      list.appendChild(row);
    });
  }

  function rememberRecentProject(value: string): string[] {
    const path = cleanPath(value);
    if (!path) return readRecentProjects();
    const key = pathKey(path);
    const projects = readRecentProjects().filter(
      (candidate) => pathKey(candidate) !== key
    );
    projects.unshift(path);
    const next = writeRecentProjects(projects);
    renderRecentProjects();
    return next;
  }

  function removeRecentProject(value: string): string[] {
    const key = pathKey(value);
    const projects = readRecentProjects().filter(
      (candidate) => pathKey(candidate) !== key
    );
    const next = writeRecentProjects(projects);
    try {
      void Promise.resolve(dependencies.host.forgetRecent(value)).catch(() => {
        // Removing the local entry remains successful if the main process is
        // already closing or has no matching settings store entry.
      });
    } catch (_) {
      // A host can disappear synchronously while the window is closing.
    }
    renderRecentProjects();
    return next;
  }

  function setBusy(nextBusy: boolean): void {
    busy = Boolean(nextBusy);
    // Keep first-frame controls and dynamically rendered recent rows in sync.
    const dynamicButtons = typeof dependencies.document.querySelectorAll === 'function'
      ? Array.from(
        dependencies.document.querySelectorAll<HTMLElement>(
          '.recent-project-open, .recent-project-remove'
        )
      ) as WorkspaceLaunchButton[]
      : [];
    for (const id of ['open-folder', 'empty-state-open']) {
      const button = dependencies.document.getElementById(
        id
      ) as WorkspaceLaunchButton | null;
      if (button) dynamicButtons.push(button);
    }
    dynamicButtons.forEach((button) => {
      button.disabled = busy;
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
  }

  function updateBusy(): void {
    setBusy(Boolean(requestPromise || draining || pending.length));
  }

  function drain(): Promise<void> {
    if (draining) return draining;
    if (disposed || !consumer || pending.length === 0) return Promise.resolve();

    draining = Promise.resolve()
      .then(async () => {
        while (!disposed && consumer && pending.length > 0) {
          const opened = pending.shift();
          if (!opened) continue;
          const applied = await consumer(opened);
          if (!disposed && applied !== false && opened.rootPath) {
            rememberRecentProject(opened.rootPath);
          }
        }
      })
      .catch((error: unknown) => {
        report(error);
      })
      .finally(() => {
        draining = null;
        updateBusy();
        if (!disposed && consumer && pending.length > 0) void drain();
      });
    updateBusy();
    return draining;
  }

  function accept(opened: WorkspaceLaunchOpenedWorkspaceDto | null | undefined): Promise<boolean> {
    if (disposed || !opened) return Promise.resolve(false);
    pending.push(opened);
    updateBusy();
    return drain().then(() => true);
  }

  function requestOpen(directoryPath?: string): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (requestPromise) return requestPromise;
    if (draining || pending.length) return drain().then(() => true);

    setBusy(true);
    let picked: Promise<WorkspaceLaunchOpenedWorkspaceDto | null>;
    try {
      picked = dependencies.host.pick(directoryPath);
    } catch (error) {
      report(error);
      setBusy(false);
      return Promise.resolve(false);
    }
    requestPromise = Promise.resolve(picked)
      .then((opened) => accept(opened))
      .catch((error: unknown) => {
        report(error);
        return false;
      })
      .finally(() => {
        requestPromise = null;
        updateBusy();
      });
    return requestPromise;
  }

  function setConsumer(nextConsumer: WorkspaceLaunchConsumer | null | undefined): Promise<void> {
    if (disposed) return Promise.resolve();
    consumer = typeof nextConsumer === 'function' ? nextConsumer : null;
    updateBusy();
    return drain();
  }

  function addClickListener(button: HTMLElement): void {
    const listener = (): void => {
      void requestOpen();
    };
    button.addEventListener('click', listener);
    lifecycle.add(toDisposable(() => {
      if (typeof button.removeEventListener === 'function') {
        button.removeEventListener('click', listener);
      }
    }));
  }

  function init(): void {
    if (disposed || initialized) return;
    initialized = true;
    for (const id of ['open-folder', 'empty-state-open']) {
      const button = dependencies.document.getElementById(id);
      if (button) addClickListener(button);
    }

    try {
      const dispose = dependencies.host.onDidOpen((opened) => {
        void accept(opened);
      });
      lifecycle.add(dispose);
    } catch (error) {
      report(error);
    }

    try {
      const i18n = dependencies.getI18n();
      if (i18n && typeof i18n.onChange === 'function') {
        lifecycle.add(toDisposable(i18n.onChange(() => refreshRecentProjectTranslations())));
      }
    } catch (error) {
      report(error);
    }
    renderRecentProjects();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    consumer = null;
    pending.length = 0;
    lifecycle.dispose();
    updateBusy();
  }

  const service: WorkspaceLaunchService = Object.freeze({
    init,
    requestOpen,
    setConsumer,
    whenIdle: drain,
    dispose,
    get disposed(): boolean {
      return disposed;
    }
  });
  return service;
}

export type { WorkspaceLaunchFacade } from '../types/workspace-launch';
