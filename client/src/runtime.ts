// Runtime selector dropdown and language-aware Docker preferences.
//
// The selector deliberately keeps its historical BOBO facade, while all
// storage, DOM, and workbench collaborators are injected by the compatibility
// adapter. Runtime catalog reads are fenced by the service lifecycle so a late
// response cannot repopulate a disposed renderer.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  RuntimeDefinitionDto,
  RuntimeDependencies,
  RuntimeHelpersFacade,
  RuntimeListResponseWireDto,
  RuntimeSelectionResultDto,
  RuntimeService
} from '../types/runtime';

export const RUNTIME_SERVICE_ID = 'workbench.runtime' as const;

const RUNTIME_STORAGE_KEY = 'bobocloud.runtime';
const LANGUAGE_PREFERENCE_STORAGE_KEY = 'bobocloud.runtime.language-preferences.v1';
const AUTO_USED_LANGUAGE_STORAGE_KEY = 'bobocloud.runtime.auto-used-languages.v1';
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  javascript: 'node',
  typescript: 'node',
  nodejs: 'node'
};
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  python: 'Python',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  go: 'Go',
  rust: 'Rust',
  node: 'Node.js'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function runtimeRecord(value: unknown): RuntimeDefinitionDto | null {
  return isRecord(value) ? value as RuntimeDefinitionDto : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function normalizeRuntimeId(value: unknown): string {
  const runtimeId = stringValue(value).trim();
  return runtimeId === 'local' ? '' : runtimeId;
}

export function canonicalLanguage(value: unknown): string {
  const language = stringValue(value).trim().toLowerCase();
  return LANGUAGE_ALIASES[language] || language;
}

function languageDisplayName(
  language: unknown,
  getLegacyDisplayName: RuntimeDependencies['getLanguageDisplayName']
): string {
  const canonical = canonicalLanguage(language);
  return LANGUAGE_NAMES[canonical] || getLegacyDisplayName()?.(canonical) || canonical;
}

function runtimeIdOf(runtime: RuntimeDefinitionDto | null | undefined): string {
  return normalizeRuntimeId(runtime && (runtime.runtimeId || runtime.id));
}

function runtimeLanguage(runtime: RuntimeDefinitionDto | null | undefined): string {
  return canonicalLanguage(runtime?.language);
}

export function compareRuntimeVersions(left: unknown, right: unknown): number {
  const leftRuntime = runtimeRecord(left);
  const rightRuntime = runtimeRecord(right);
  const versionParts = (value: unknown): string[] => (
    stringValue(value).match(/[0-9]+|[A-Za-z]+/g) || []
  );
  const a = versionParts(leftRuntime?.version || runtimeIdOf(leftRuntime));
  const b = versionParts(rightRuntime?.version || runtimeIdOf(rightRuntime));
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const aPart = a[index] || '';
    const bPart = b[index] || '';
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart);
    const bNumber = /^\d+$/.test(bPart);
    if (aNumber && bNumber) return Number(aPart) - Number(bPart);
    if (aNumber !== bNumber) return aNumber ? 1 : -1;
    return aPart < bPart ? -1 : 1;
  }
  const aId = runtimeIdOf(leftRuntime);
  const bId = runtimeIdOf(rightRuntime);
  return aId === bId ? 0 : (aId < bId ? -1 : 1);
}

export function createRuntimeService(dependencies: RuntimeDependencies): RuntimeService {
  const documentRef = dependencies.document;
  const state = dependencies.state;
  const listeners = new DisposableStore();
  let initialized = false;
  let disposed = false;
  let legacyRuntimeId = normalizeRuntimeId(state.selectedRuntime);
  let fetchEpoch = 0;
  let outsideClickTimer: number | null = null;

  function tr(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, replacements);
    return source.replace(/\{([^}]+)\}/g, (match, key: string) => (
      replacements && replacements[key] !== undefined ? String(replacements[key]) : match
    ));
  }

  function runtimeForId(runtimeId: unknown): RuntimeDefinitionDto | null {
    const normalized = normalizeRuntimeId(runtimeId);
    return (state.availableRuntimes || []).find((runtime) => runtimeIdOf(runtime) === normalized) || null;
  }

  function loadLanguagePreferences(): Record<string, string> {
    try {
      const raw = dependencies.storage.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!isRecord(parsed) || Array.isArray(parsed)) return {};
      const result: Record<string, string> = {};
      for (const key of Object.keys(parsed)) {
        const language = canonicalLanguage(key);
        const runtimeId = normalizeRuntimeId(parsed[key]);
        if (language && runtimeId) result[language] = runtimeId;
      }
      return result;
    } catch (_) {
      return {};
    }
  }

  function saveLanguagePreferences(preferences: Readonly<Record<string, string>>): void {
    try {
      dependencies.storage.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, JSON.stringify(preferences));
    } catch (_) {
      // Storage may be unavailable in a private browsing context.
    }
  }

  function rememberLanguageRuntime(language: unknown, runtimeId: unknown): void {
    const canonical = canonicalLanguage(language);
    const normalized = normalizeRuntimeId(runtimeId);
    if (!canonical || !normalized) return;
    const preferences = loadLanguagePreferences();
    if (preferences[canonical] === normalized) return;
    preferences[canonical] = normalized;
    saveLanguagePreferences(preferences);
  }

  function loadAutoUsedLanguages(): Record<string, true> {
    try {
      const raw = dependencies.storage.getItem(AUTO_USED_LANGUAGE_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!isRecord(parsed) || Array.isArray(parsed)) return {};
      const result: Record<string, true> = {};
      for (const key of Object.keys(parsed)) {
        const language = canonicalLanguage(key);
        if (language && parsed[key] === true) result[language] = true;
      }
      return result;
    } catch (_) {
      return {};
    }
  }

  function markAutoUsedLanguage(language: unknown): boolean {
    const canonical = canonicalLanguage(language);
    if (!canonical) return false;
    const used = loadAutoUsedLanguages();
    if (used[canonical]) return false;
    used[canonical] = true;
    try {
      dependencies.storage.setItem(AUTO_USED_LANGUAGE_STORAGE_KEY, JSON.stringify(used));
    } catch (_) {
      // Best effort; the in-memory selection remains valid.
    }
    return true;
  }

  function loadSavedRuntime(): void {
    try {
      const saved = dependencies.storage.getItem(RUNTIME_STORAGE_KEY);
      // An empty value is an intentional Local choice and must survive restart.
      if (saved !== null) state.selectedRuntime = normalizeRuntimeId(saved);
      // Releases before language-aware preferences only kept this single
      // runtime. It is migrated once for its matching language below.
      if (Object.keys(loadLanguagePreferences()).length === 0) {
        legacyRuntimeId = normalizeRuntimeId(state.selectedRuntime);
      }
    } catch (_) {
      // Storage access is optional and must not prevent the selector opening.
    }
  }

  function saveRuntimePreference(): void {
    try {
      dependencies.storage.setItem(RUNTIME_STORAGE_KEY, normalizeRuntimeId(state.selectedRuntime));
    } catch (_) {
      // Ignore unavailable storage, matching the legacy best-effort behavior.
    }
  }

  function runtimesForLanguage(language: unknown): RuntimeDefinitionDto[] {
    const canonical = canonicalLanguage(language);
    return (state.availableRuntimes || []).filter((runtime) => (
      runtimeLanguage(runtime) === canonical && Boolean(runtimeIdOf(runtime))
    ));
  }

  function latestRuntimeForLanguage(language: string): RuntimeDefinitionDto | null {
    const candidates = runtimesForLanguage(language);
    if (!candidates.length) return null;
    return candidates.reduce<RuntimeDefinitionDto | null>((latest, candidate) => (
      !latest || compareRuntimeVersions(candidate, latest) > 0 ? candidate : latest
    ), null);
  }

  function runtimeDisplayName(runtime: RuntimeDefinitionDto | null | undefined): string {
    return stringValue(runtime && (runtime.displayName || runtime.version || runtimeIdOf(runtime)));
  }

  function buildRuntimeMenu(): void {
    if (disposed) return;
    const menu = documentRef.getElementById('runtime-menu');
    if (!menu) return;
    menu.innerHTML = '';

    // "Local" is a user-controlled mode, never an implicit fallback.
    const localRow = documentRef.createElement('div');
    localRow.className = 'rt-cat';
    localRow.textContent = tr('Local (no Docker)');
    if (!normalizeRuntimeId(state.selectedRuntime)) localRow.classList.add('active');
    localRow.onclick = () => { selectRuntime(''); };
    menu.appendChild(localRow);

    const separator = documentRef.createElement('div');
    separator.style.cssText = 'border-top:1px solid #00000033;margin:4px 0';
    menu.appendChild(separator);

    const preferredOrder = ['python', 'java', 'c', 'cpp', 'go', 'rust', 'node'];
    const grouped = state.groupedRuntimes || {};
    const availableLanguages = Object.keys(grouped);
    const languageOrder = preferredOrder.filter((language) => availableLanguages.includes(language));
    availableLanguages.sort().forEach((language) => {
      if (!languageOrder.includes(language)) languageOrder.push(language);
    });

    for (const language of languageOrder) {
      const versions = grouped[language];
      if (!versions || versions.length === 0) continue;

      const categoryRow = documentRef.createElement('div');
      categoryRow.className = 'rt-cat';
      categoryRow.innerHTML = '<span></span><span>&#9654;</span>';
      const first = categoryRow.firstElementChild;
      if (first) first.textContent = languageDisplayName(language, dependencies.getLanguageDisplayName);
      categoryRow.onclick = (event) => {
        event.stopPropagation();
        const wasExpanded = categoryRow.classList.contains('expanded');
        menu.querySelectorAll<HTMLElement>('.rt-cat.expanded').forEach((element) => {
          element.classList.remove('expanded');
        });
        if (!wasExpanded) categoryRow.classList.add('expanded');
      };

      const subMenu = documentRef.createElement('div');
      subMenu.className = 'sub-menu';
      for (const version of versions) {
        const versionRow = documentRef.createElement('div');
        versionRow.className = 'rt-ver';
        versionRow.textContent = stringValue(version.version);
        if (normalizeRuntimeId(state.selectedRuntime) === runtimeIdOf(version)) {
          versionRow.classList.add('active');
        }
        const selectedId = runtimeIdOf(version);
        versionRow.onclick = (event) => {
          event.stopPropagation();
          selectRuntime(selectedId);
        };
        subMenu.appendChild(versionRow);
      }
      menu.appendChild(categoryRow);
      menu.appendChild(subMenu);
    }
  }

  function updateRuntimeButtonLabel(): void {
    const button = documentRef.getElementById('runtime-btn');
    if (!button) return;
    let label = button.querySelector<HTMLElement>('.runtime-label');
    if (!label) {
      label = documentRef.createElement('span');
      label.className = 'runtime-label';
      button.textContent = '';
      button.appendChild(label);
    }
    const selectedRuntime = normalizeRuntimeId(state.selectedRuntime);
    const selected = selectedRuntime ? runtimeForId(selectedRuntime) : null;
    label.textContent = selectedRuntime
      ? selected ? runtimeDisplayName(selected) : selectedRuntime
      : tr('Local');
  }

  function closeRuntimeMenu(): void {
    const menu = documentRef.getElementById('runtime-menu');
    if (menu) menu.style.display = 'none';
    documentRef.removeEventListener('click', closeRuntimeMenuOnClickOutside);
    if (outsideClickTimer !== null) {
      dependencies.clearTimer(outsideClickTimer);
      outsideClickTimer = null;
    }
  }

  function applyRuntimeSelection(runtimeId: unknown, options: { readonly rememberLanguage?: boolean; readonly log?: boolean } = {}): boolean {
    const normalized = normalizeRuntimeId(runtimeId);
    const previousRuntime = normalizeRuntimeId(state.selectedRuntime);
    const runtime = runtimeForId(normalized);
    state.selectedRuntime = normalized;
    saveRuntimePreference();
    if (runtime && options.rememberLanguage !== false) rememberLanguageRuntime(runtimeLanguage(runtime), normalized);
    updateRuntimeButtonLabel();
    buildRuntimeMenu();
    closeRuntimeMenu();

    if (previousRuntime !== normalized) {
      state.setupCommands = [];
      dependencies.getLsp()?.runtimeChanged?.();
      dependencies.getRunConfig()?.refreshForActiveFile?.();
      dependencies.getEnvironmentActivity()?.contextChanged?.('runtime');
    }
    if (options.log !== false) {
      dependencies.updateRunOutput('[Runtime selected: ' + (normalized || 'Local') + ']');
    }
    return previousRuntime !== normalized;
  }

  function selectRuntime(runtimeId: string): boolean {
    // Direct selector interactions are explicit user choices. They refresh the
    // remembered version for that language, while Local remains a global mode.
    legacyRuntimeId = '';
    return applyRuntimeSelection(runtimeId, { rememberLanguage: true, log: true });
  }

  function autoSelectForLanguage(language: string): RuntimeSelectionResultDto {
    // Local is an explicit choice. File activation must never turn it back
    // into a Docker runtime.
    if (!normalizeRuntimeId(state.selectedRuntime)) return { changed: false, reason: 'local' };

    const canonical = canonicalLanguage(language);
    if (!canonical) return { changed: false, reason: 'unsupported-language' };
    const candidates = runtimesForLanguage(canonical);
    if (!candidates.length) return { changed: false, reason: 'no-runtime' };

    const preferences = loadLanguagePreferences();
    const preferredId = normalizeRuntimeId(preferences[canonical]);
    let selected = preferredId
      ? candidates.find((runtime) => runtimeIdOf(runtime) === preferredId) || null
      : null;

    // Existing releases only saved one global runtime. Preserve it as the
    // first known preference for its own language when upgrading. New
    // automatic defaults deliberately do not become a version pin.
    if (!selected && !preferredId && legacyRuntimeId) {
      const current = runtimeForId(legacyRuntimeId);
      if (current && runtimeLanguage(current) === canonical) selected = current;
      if (selected) {
        rememberLanguageRuntime(canonical, runtimeIdOf(selected));
        legacyRuntimeId = '';
      }
    }

    let usedLatest = false;
    if (!selected) {
      selected = latestRuntimeForLanguage(canonical);
      usedLatest = true;
    }
    if (!selected) return { changed: false, reason: 'no-runtime' };

    const selectedId = runtimeIdOf(selected);
    const changed = applyRuntimeSelection(selectedId, { rememberLanguage: false, log: false });
    if (usedLatest && markAutoUsedLanguage(canonical)) {
      dependencies.getToast()?.info?.(tr('Using the latest {language} runtime for this file: {runtime}', {
        language: languageDisplayName(canonical, dependencies.getLanguageDisplayName),
        runtime: runtimeDisplayName(selected)
      }));
    }
    return { changed, runtimeId: selectedId, usedLatest };
  }

  function autoSelectForActiveFile(): RuntimeSelectionResultDto {
    const active = (state.tabs || []).find((tab) => tab.path === state.activeTabPath);
    return active
      ? autoSelectForLanguage(stringValue(active.language))
      : { changed: false, reason: 'no-active-file' };
  }

  async function fetchRuntimes(): Promise<void> {
    if (!state.serverSettings?.ip || disposed) return;
    const requestEpoch = ++fetchEpoch;
    try {
      // Multiple-user mode needs the authenticated request path; otherwise the
      // server returns 401 and the selector incorrectly falls back to Local.
      const rawResult = await dependencies.sendToServer('listRuntimes', {}, { quiet: true });
      const result = rawResult as RuntimeListResponseWireDto;
      if (disposed || requestEpoch !== fetchEpoch || !responseSuccess(result) || !Array.isArray(result.runtimes)) return;
      const runtimes = result.runtimes
        .map((runtime) => runtimeRecord(runtime))
        .filter((runtime): runtime is RuntimeDefinitionDto => runtime !== null);
      state.availableRuntimes = runtimes;
      state.groupedRuntimes = {};
      for (const runtime of runtimes) {
        const language = runtimeLanguage(runtime);
        if (!language || !runtimeIdOf(runtime)) continue;
        if (!state.groupedRuntimes[language]) state.groupedRuntimes[language] = [];
        state.groupedRuntimes[language].push(runtime);
      }
      buildRuntimeMenu();
      updateRuntimeButtonLabel();
      // File activation can precede the asynchronous runtime list request.
      // Reconcile the active file now that a real catalog is available.
      autoSelectForActiveFile();
      dependencies.getEnvironmentActivity()?.contextChanged?.('runtimes-loaded');
    } catch (_) {
      // A missing or unauthorized catalog leaves the explicit current choice.
    }
  }

  function toggleRuntimeMenu(): void {
    if (disposed) return;
    const menu = documentRef.getElementById('runtime-menu');
    if (!menu) return;
    if (menu.style.display === 'none') {
      menu.style.display = 'block';
      if (outsideClickTimer !== null) dependencies.clearTimer(outsideClickTimer);
      outsideClickTimer = dependencies.setTimer(() => {
        outsideClickTimer = null;
        if (!disposed && menu.style.display === 'block') {
          documentRef.addEventListener('click', closeRuntimeMenuOnClickOutside);
        }
      }, 0);
    } else {
      closeRuntimeMenu();
    }
  }

  function closeRuntimeMenuOnClickOutside(event: MouseEvent): void {
    const selector = documentRef.getElementById('runtime-selector');
    if (!selector || !selector.contains(event.target as Node | null)) closeRuntimeMenu();
  }

  function listen(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    type: string,
    listener: (event: Event) => void
  ): void {
    target.addEventListener(type, listener);
    listeners.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function init(): void {
    if (initialized || disposed) return;
    initialized = true;
    loadSavedRuntime();
    const button = documentRef.getElementById('runtime-btn');
    if (button) {
      listen(button, 'click', (event) => {
        event.stopPropagation();
        toggleRuntimeMenu();
      });
    }
    updateRuntimeButtonLabel();
    buildRuntimeMenu();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    fetchEpoch += 1;
    closeRuntimeMenu();
    listeners.dispose();
  }

  const helpers: RuntimeHelpersFacade = {
    canonicalLanguage,
    compareRuntimeVersions,
    latestRuntimeForLanguage
  };
  const service: RuntimeService = {
    get disposed() { return disposed; },
    init,
    fetchRuntimes,
    selectRuntime,
    autoSelectForLanguage,
    autoSelectForActiveFile,
    _helpers: helpers,
    dispose
  };
  return Object.freeze(service);
}

function responseSuccess(value: unknown): boolean {
  return isRecord(value) && Boolean(value.success);
}
