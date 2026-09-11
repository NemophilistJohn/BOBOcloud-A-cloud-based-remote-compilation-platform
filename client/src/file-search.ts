// Persistent Quick Open search in the primary sidebar.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  FileSearchDependencies,
  FileSearchEventTarget,
  FileSearchFacade,
  FileSearchFileDto,
  FileSearchService,
  FileSearchTreeNodeDto
} from '../types/file-search';

export const FILE_SEARCH_SERVICE_ID = 'workbench.fileSearch' as const;

const HISTORY_PREFIX = 'bobocloud.quickFileHistory.v1:';
const HISTORY_LIMIT = 12;
const SUGGESTION_LIMIT = 8;
const RESULT_LIMIT = 50;
const IMPORTANT_FILES = [
  'readme.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'makefile'
] as const;

interface FileSearchSectionOptions {
  readonly kind?: string;
  readonly clearHistory?: boolean;
}

interface RankedFile {
  readonly file: FileSearchFileDto;
  readonly score: number;
}

function isTreeNode(value: unknown): value is FileSearchTreeNodeDto {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createFileSearchService(
  dependencies: FileSearchDependencies
): FileSearchService {
  const lifecycle = new DisposableStore();
  let input: HTMLInputElement | null = null;
  let results: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  let cachedFiles: FileSearchFileDto[] = [];
  let cachedTree: unknown = null;
  let cachedRoot = '';
  let selectedIndex = 0;
  let visibleItems: FileSearchFileDto[] = [];
  let focusTimer: number | null = null;
  let disposed = false;

  function t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, params);
    return String(source).replace(/\{([^}]+)\}/g, (match, key: string) => {
      return params && params[key] !== undefined ? String(params[key]) : match;
    });
  }

  function normalizedPath(value: unknown): string {
    const normalized = String(value || '').replace(/\\/g, '/');
    return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  }

  function relativePath(filePath: unknown, rootPath: unknown): string {
    const file = String(filePath || '').replace(/\\/g, '/');
    const root = String(rootPath || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedPath(file).indexOf(normalizedPath(root) + '/') === 0) {
      return file.slice(root.length + 1);
    }
    return file.split('/').pop() || file;
  }

  function flattenTree(tree: FileSearchTreeNodeDto): FileSearchFileDto[] {
    const flattened: FileSearchFileDto[] = [];
    // Workspace settings are stable for this synchronous rebuild. Resolve the
    // port once so a large tree does not pay a getter/closure cost per node.
    const settings = dependencies.getWorkspaceSettings();
    const walk = (node: FileSearchTreeNodeDto): void => {
      if (!node) return;
      if (node !== tree) {
        if (settings && typeof settings.isPathExcluded === 'function' &&
            settings.isPathExcluded(node.path)) return;
      }
      if (node.type === 'file') {
        const path = String(node.path || '');
        const relative = relativePath(path, tree.path);
        const parts = relative.split('/');
        const name = String(node.name || parts[parts.length - 1] || '');
        const lowerName = name.toLowerCase();
        const importantIndex = IMPORTANT_FILES.indexOf(
          lowerName as typeof IMPORTANT_FILES[number]
        );
        let suggestionBase = importantIndex >= 0 ? 400 - importantIndex : 0;
        if (/^(?:main|index|app|application|program)\.[a-z0-9]+$/.test(lowerName)) {
          suggestionBase += 260;
        }
        suggestionBase += Math.max(0, 80 - (parts.length - 1) * 20);
        flattened.push({
          path,
          normalizedPath: normalizedPath(path),
          name,
          dir: parts.slice(0, -1).join('/'),
          relativePath: relative,
          searchName: lowerName,
          searchPath: relative.toLowerCase(),
          suggestionBase
        });
      }
      if (Array.isArray(node.children)) {
        // Avoid allocating a filtered child array for every directory in a
        // large workspace while retaining the legacy depth-first order.
        for (const child of node.children) {
          if (isTreeNode(child)) walk(child);
        }
      }
    };
    walk(tree);
    return flattened;
  }

  function rebuildCache(force: boolean): void {
    const tree = dependencies.state.workspaceTree;
    const root = String(dependencies.state.workspaceRoot || '');
    if (!root || !tree || !isTreeNode(tree)) {
      const hadWorkspace = Boolean(cachedRoot);
      cachedTree = null;
      cachedRoot = '';
      cachedFiles = [];
      if (hadWorkspace && input) input.value = '';
      return;
    }
    if (!force && cachedTree === tree && cachedRoot === root) return;
    const rootChanged = Boolean(cachedRoot) && cachedRoot !== root;
    cachedTree = tree;
    cachedRoot = root;
    cachedFiles = flattenTree(tree);
    if (rootChanged && input) input.value = '';
  }

  function storageKey(): string {
    const root = dependencies.state.workspaceRoot;
    if (!root) return '';
    return HISTORY_PREFIX + encodeURIComponent(normalizedPath(root));
  }

  function currentFileMap(): Map<string, FileSearchFileDto> {
    const files = new Map<string, FileSearchFileDto>();
    cachedFiles.forEach((file) => files.set(file.normalizedPath, file));
    return files;
  }

  function readHistory(): FileSearchFileDto[] {
    const key = storageKey();
    if (!key) return [];
    let paths: unknown[] = [];
    try {
      const value = JSON.parse(dependencies.storage?.getItem(key) || '[]') as unknown;
      if (Array.isArray(value)) paths = value;
    } catch (_) {}
    const files = currentFileMap();
    const seen = new Set<string>();
    const history: FileSearchFileDto[] = [];
    paths.forEach((filePath) => {
      const normalized = normalizedPath(filePath);
      const file = files.get(normalized);
      if (!file || seen.has(normalized)) return;
      seen.add(normalized);
      history.push(file);
    });
    return history.slice(0, HISTORY_LIMIT);
  }

  function writeHistory(items: readonly FileSearchFileDto[]): void {
    const key = storageKey();
    if (!key || !dependencies.storage) return;
    try {
      dependencies.storage.setItem(
        key,
        JSON.stringify(items.slice(0, HISTORY_LIMIT).map((item) => item.path))
      );
    } catch (_) {}
  }

  function recordHistory(item: FileSearchFileDto | null | undefined): void {
    const target = item && item.normalizedPath || normalizedPath(item && item.path);
    if (!target || !item) return;
    const next = [item].concat(readHistory().filter((entry) => {
      return entry.normalizedPath !== target;
    }));
    writeHistory(next);
  }

  function clearHistory(): void {
    if (disposed) return;
    const key = storageKey();
    if (key && dependencies.storage) {
      try { dependencies.storage.removeItem(key); } catch (_) {}
    }
    filter();
    if (input) input.focus();
  }

  function fuzzyMatch(query: string, text: string): number {
    if (!query) return 0;
    let score = 0;
    let queryIndex = 0;
    let previousMatch = false;
    for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
      if (text[textIndex] === query[queryIndex]) {
        score += previousMatch ? 3 : 1;
        if (textIndex === 0 || '/_-.'.indexOf(text[textIndex - 1] || '') !== -1) score += 5;
        queryIndex += 1;
        previousMatch = true;
      } else {
        previousMatch = false;
      }
    }
    return queryIndex === query.length ? score : -1;
  }

  function compareMatches(left: RankedFile, right: RankedFile): number {
    return right.score - left.score || left.file.relativePath.localeCompare(right.file.relativePath);
  }

  // Keep the bounded insertion strategy: Quick Open never sorts the complete
  // workspace result set, which matters for large remote trees.
  function insertBoundedMatch(matches: RankedFile[], match: RankedFile, limit: number): void {
    const last = matches[matches.length - 1];
    if (matches.length === limit && last && compareMatches(match, last) >= 0) return;
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const middleMatch = matches[middle]!;
      if (compareMatches(match, middleMatch) < 0) high = middle;
      else low = middle + 1;
    }
    matches.splice(low, 0, match);
    if (matches.length > limit) matches.pop();
  }

  function searchFiles(query: string): FileSearchFileDto[] {
    const normalizedQuery = String(query || '').toLowerCase();
    const matches: RankedFile[] = [];
    cachedFiles.forEach((file) => {
      const nameScore = fuzzyMatch(normalizedQuery, file.searchName);
      const pathScore = fuzzyMatch(normalizedQuery, file.searchPath);
      const score = Math.max(nameScore >= 0 ? nameScore + 4 : -1, pathScore);
      if (score >= 0) insertBoundedMatch(matches, { file, score }, RESULT_LIMIT);
    });
    return matches.map((match) => match.file);
  }

  function suggestionScore(file: FileSearchFileDto, tabRanks: Map<string, number>): number {
    let score = file.suggestionBase;
    const tabIndex = tabRanks.has(file.normalizedPath) ? tabRanks.get(file.normalizedPath) : -1;
    if (tabIndex !== undefined && tabIndex >= 0) score += 600 - tabIndex;
    return score;
  }

  function suggestedFiles(excluded: Set<string>): FileSearchFileDto[] {
    const tabRanks = new Map<string, number>();
    (dependencies.state.tabs || []).forEach((tab, index) => {
      const path = normalizedPath(tab && tab.path);
      if (path && !tabRanks.has(path)) tabRanks.set(path, index);
    });
    const suggestions: RankedFile[] = [];
    cachedFiles.forEach((file) => {
      if (excluded.has(file.normalizedPath)) return;
      insertBoundedMatch(
        suggestions,
        { file, score: suggestionScore(file, tabRanks) },
        SUGGESTION_LIMIT
      );
    });
    return suggestions.map((entry) => entry.file);
  }

  function createFileIcon(file: FileSearchFileDto): HTMLSpanElement {
    const icon = dependencies.document.createElement('span');
    icon.className = 'file-search-result-icon';
    const iconPath = dependencies.getFileIcons()?.getFileIcon?.(file.name);
    if (iconPath) {
      const image = dependencies.document.createElement('img');
      image.src = iconPath;
      image.alt = '';
      icon.appendChild(image);
    } else {
      const fileIcon = dependencies.getIcons()?.file;
      if (fileIcon) icon.innerHTML = fileIcon;
    }
    return icon;
  }

  function appendFile(section: HTMLElement, file: FileSearchFileDto): void {
    const itemIndex = visibleItems.length;
    visibleItems.push(file);
    const button = dependencies.document.createElement('button');
    button.type = 'button';
    button.id = 'quick-file-search-result-' + itemIndex;
    button.className = 'file-search-result' + (itemIndex === selectedIndex ? ' selected' : '');
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', itemIndex === selectedIndex ? 'true' : 'false');
    button.setAttribute('data-path', file.path);
    button.title = file.relativePath;
    button.appendChild(createFileIcon(file));

    const copy = dependencies.document.createElement('span');
    copy.className = 'file-search-result-copy';
    const name = dependencies.document.createElement('span');
    name.className = 'file-search-result-name';
    name.textContent = file.name;
    copy.appendChild(name);
    if (file.dir) {
      const directory = dependencies.document.createElement('span');
      directory.className = 'file-search-result-dir';
      directory.textContent = file.dir;
      copy.appendChild(directory);
    }
    button.appendChild(copy);
    button.addEventListener('click', () => {
      selectedIndex = itemIndex;
      openSelected();
    });
    section.appendChild(button);
  }

  function appendSection(
    title: string,
    items: readonly FileSearchFileDto[],
    options?: FileSearchSectionOptions
  ): void {
    if (!items.length || !results) return;
    const section = dependencies.document.createElement('section');
    section.className = 'file-search-section';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', t(title));
    section.setAttribute('data-search-section', options?.kind || 'results');
    const heading = dependencies.document.createElement('div');
    heading.className = 'file-search-section-heading';
    const label = dependencies.document.createElement('strong');
    label.textContent = t(title);
    heading.appendChild(label);
    if (options?.clearHistory) {
      const clear = dependencies.document.createElement('button');
      clear.type = 'button';
      clear.className = 'file-search-clear-history';
      clear.title = t('Clear search history');
      clear.setAttribute('aria-label', t('Clear search history'));
      const trashIcon = dependencies.getIcons()?.trash;
      if (trashIcon) clear.innerHTML = trashIcon;
      clear.addEventListener('click', clearHistory);
      heading.appendChild(clear);
    }
    section.appendChild(heading);
    items.forEach((file) => appendFile(section, file));
    results.appendChild(section);
  }

  function renderEmpty(message: string, withOpenAction: boolean): void {
    if (!results) return;
    const empty = dependencies.document.createElement('div');
    empty.className = 'file-search-empty';
    const searchIcon = dependencies.getIcons()?.search;
    if (searchIcon) {
      const icon = dependencies.document.createElement('span');
      icon.className = 'file-search-empty-icon';
      icon.innerHTML = searchIcon;
      empty.appendChild(icon);
    }
    const copy = dependencies.document.createElement('span');
    copy.textContent = t(message);
    empty.appendChild(copy);
    if (withOpenAction) {
      const open = dependencies.document.createElement('button');
      open.type = 'button';
      open.textContent = t('Open Folder');
      open.addEventListener('click', () => {
        if (!disposed) dependencies.getWorkspaceLaunch()?.requestOpen?.();
      });
      empty.appendChild(open);
    }
    results.appendChild(empty);
  }

  function syncSelection(): void {
    if (!results || !input) return;
    const searchInput = input;
    const buttons = results.querySelectorAll<HTMLElement>('.file-search-result');
    buttons.forEach((button, index) => {
      const selected = index === selectedIndex;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) {
        searchInput.setAttribute('aria-activedescendant', button.id);
        button.scrollIntoView({ block: 'nearest' });
      }
    });
    if (!buttons.length) searchInput.removeAttribute('aria-activedescendant');
  }

  function render(): void {
    if (!input || !results || !status || disposed) return;
    results.innerHTML = '';
    visibleItems = [];
    const query = input.value.trim();
    const state = dependencies.state;
    if (!state.workspaceRoot || !state.workspaceTree) {
      renderEmpty('Open a folder to search files.', true);
      status.textContent = t('Open a folder to search files.');
      input.disabled = true;
      return;
    }
    input.disabled = false;
    if (query) {
      const matches = searchFiles(query);
      if (matches.length) appendSection('Search results', matches, { kind: 'results' });
      else renderEmpty('No matching files', false);
      status.textContent = matches.length
        ? t('Search results: {count}', { count: matches.length })
        : t('No matching files');
    } else {
      const recent = readHistory();
      const recentPaths = new Set(recent.map((file) => file.normalizedPath));
      const suggestions = suggestedFiles(recentPaths);
      appendSection('Recently opened', recent, { kind: 'recent', clearHistory: true });
      appendSection('Suggested files', suggestions, { kind: 'suggested' });
      if (!recent.length && !suggestions.length) {
        renderEmpty('Start typing to search your workspace.', false);
      }
      status.textContent = t('{count} files available', { count: cachedFiles.length });
    }
    if (visibleItems.length === 0) selectedIndex = 0;
    else selectedIndex = Math.max(0, Math.min(selectedIndex, visibleItems.length - 1));
    syncSelection();
  }

  function filter(): void {
    if (disposed) return;
    rebuildCache(false);
    selectedIndex = 0;
    render();
  }

  function navigate(direction: number): void {
    if (!visibleItems.length || disposed) return;
    selectedIndex = (selectedIndex + direction + visibleItems.length) % visibleItems.length;
    syncSelection();
  }

  function openSelected(): void {
    if (disposed) return;
    const item = visibleItems[selectedIndex];
    if (!item) return;
    recordHistory(item);
    dependencies.getWorkspace()?.openFile?.(item.path, item.name);
    if (!input?.value.trim()) render();
  }

  function listen(target: FileSearchEventTarget, type: string, callback: (event: Event) => void): void {
    const listener = callback as EventListener;
    target.addEventListener(type, listener);
    lifecycle.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function ensureDOM(): void {
    if (input || disposed) return;
    input = dependencies.document.getElementById('quick-file-search-input') as HTMLInputElement | null;
    results = dependencies.document.getElementById('quick-file-search-results');
    status = dependencies.document.getElementById('quick-file-search-status');
    if (!input || !results || !status) return;
    const searchInput = input;
    listen(searchInput, 'input', () => filter());
    listen(searchInput, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'ArrowDown') {
        keyboardEvent.preventDefault();
        navigate(1);
      } else if (keyboardEvent.key === 'ArrowUp') {
        keyboardEvent.preventDefault();
        navigate(-1);
      } else if (keyboardEvent.key === 'Enter') {
        keyboardEvent.preventDefault();
        openSelected();
      } else if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        if (searchInput.value) {
          searchInput.value = '';
          filter();
        } else {
          hide();
        }
      }
    });
    filter();
  }

  function focusSoon(): void {
    if (focusTimer !== null) {
      dependencies.clearTimer(focusTimer);
      focusTimer = null;
    }
    let firedSynchronously = false;
    const timer = dependencies.setTimer(() => {
      firedSynchronously = true;
      focusTimer = null;
      if (disposed) return;
      if (input && !input.disabled) input.focus();
    }, 0);
    if (!firedSynchronously) focusTimer = timer;
  }

  function show(): void {
    if (disposed) return;
    ensureDOM();
    dependencies.getWorkbench()?.setPrimaryView?.('search');
    filter();
    focusSoon();
  }

  function hide(): void {
    if (disposed) return;
    dependencies.getWorkbench()?.setPrimaryView?.('explorer');
  }

  function refreshCache(force = false): void {
    if (disposed) return;
    rebuildCache(force === true);
    if (input) render();
  }

  listen(dependencies.eventTarget, 'bobo:language-changed', () => {
    if (input && !disposed) render();
  });
  listen(dependencies.eventTarget, 'bobo:workspace-changed', () => {
    if (!disposed) refreshCache(true);
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (focusTimer !== null) dependencies.clearTimer(focusTimer);
    focusTimer = null;
    lifecycle.dispose();
    input = null;
    results = null;
    status = null;
    visibleItems = [];
    cachedFiles = [];
    cachedTree = null;
    cachedRoot = '';
  }

  const facade: FileSearchFacade = { show, hide, refreshCache };
  const service: FileSearchService = {
    get disposed(): boolean { return disposed; },
    show: facade.show,
    hide: facade.hide,
    refreshCache: facade.refreshCache,
    dispose
  };
  return Object.freeze(service);
}
