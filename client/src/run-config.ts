// Per-workspace run configuration and cross-build preset selection.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  RunConfigArgsDto,
  RunConfigDependencies,
  RunConfigFacade,
  RunConfigI18nPort,
  RunConfigRawDto,
  RunConfigService,
  RunConfigTargetMetaDto,
  RunConfigTargetDto,
  RunConfigTargetListResponseDto
} from '../types/run-config';

export const RUN_CONFIG_SERVICE_ID = 'workbench.runConfig' as const;

const STORAGE_KEY = 'bobocloud.runconfig.v2';
const LEGACY_STORAGE_KEY = 'bobocloud.runconfig.v1';
const COMPILED_LANGS: Readonly<Record<string, true>> = {
  c: true, cpp: true, java: true, go: true, rust: true
};
const TARGET_LANGS: Readonly<Record<string, true>> = {
  c: true, cpp: true, go: true, rust: true
};
const LANG_NAMES: Readonly<Record<string, string>> = {
  c: 'C', cpp: 'C++', java: 'Java', go: 'Go', rust: 'Rust', python: 'Python', node: 'Node.js'
};
const EXT_LANG: Readonly<Record<string, string>> = {
  '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.java': 'java', '.go': 'go', '.rs': 'rust',
  '.py': 'python', '.js': 'node', '.mjs': 'node', '.cjs': 'node'
};
const FALLBACK_TARGETS: readonly RunConfigTargetDto[] = [
  { id: 'linux-x86_64', os: 'linux', architecture: 'x86_64', environment: 'hosted', outputPath: '.bobocloud/output', runnable: true },
  { id: 'linux-arm64', os: 'linux', architecture: 'arm64', environment: 'hosted', outputPath: 'artifacts/app_linux_arm64', runnable: false },
  { id: 'windows-x86_64', os: 'windows', architecture: 'x86_64', environment: 'hosted', outputPath: 'artifacts/app_windows_x86_64.exe', runnable: false },
  { id: 'cortex-m4', os: 'none', architecture: 'armv7e-m', environment: 'bare-metal-rtos', outputPath: 'artifacts/app_cortex_m4.elf', runnable: false }
];
const NATIVE_TARGETS: readonly RunConfigTargetDto[] = [FALLBACK_TARGETS[0]!];
const TARGET_META: Readonly<Record<string, RunConfigTargetMetaDto>> = {
  'linux-x86_64': { label: 'Linux x86_64', toolchain: 'gcc / g++ / rustc' },
  'linux-arm64': { label: 'Linux ARM64', toolchain: 'aarch64-linux-gnu / Rust target' },
  'windows-x86_64': { label: 'Windows x86_64', toolchain: 'MinGW-w64 / Rust GNU target' },
  'cortex-m4': { label: 'Cortex-M4', toolchain: 'arm-none-eabi / thumbv7em-none-eabihf' }
};
const TARGET_SYSTEMS: Readonly<Record<string, string>> = {
  linux: 'Linux', windows: 'Windows', 'bare-metal-rtos': 'Bare metal / RTOS'
};

interface TargetCacheEntry {
  readonly targets: readonly RunConfigTargetDto[];
  readonly promise?: Promise<readonly RunConfigTargetDto[]>;
  readonly error?: string;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeTarget(value: unknown): RunConfigTargetDto | null {
  const raw = recordValue(value);
  const id = stringValue(raw.id);
  if (!id) return null;
  return {
    ...raw,
    id,
    os: stringValue(raw.os),
    architecture: stringValue(raw.architecture),
    environment: stringValue(raw.environment),
    ...(raw.outputPath === undefined ? {} : { outputPath: stringValue(raw.outputPath) }),
    ...(raw.runnable === undefined ? {} : { runnable: raw.runnable === true })
  };
}

export function languageForFile(filePath: unknown): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(stringValue(filePath || ''));
  return match ? EXT_LANG['.' + (match[1] || '').toLowerCase()] || null : null;
}

export function splitArgs(value: unknown): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;
  const input = stringValue(value || '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] || '';
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current) out.push(current);
  return out;
}

function normalizeRaw(value: unknown): RunConfigRawDto {
  const raw = recordValue(value);
  return {
    compile: stringValue(raw.compile || ''),
    run: stringValue(raw.run || ''),
    target: stringValue(raw.target || 'linux-x86_64')
  };
}

function createFallbackStorage(): RunConfigDependencies['storage'] {
  return { getItem: () => null, setItem: () => {} };
}

export function createRunConfigService(dependencies: RunConfigDependencies): RunConfigService {
  const documentRef = dependencies.document;
  const windowRef = dependencies.window;
  const storage = dependencies.storage || createFallbackStorage();
  const state = dependencies.state;
  const listeners = new DisposableStore();
  const targetCache = new Map<string, TargetCacheEntry>();
  let currentLang: string | null = null;
  let pointerTimer: number | null = null;
  let initialized = false;
  let disposed = false;

  function tr(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    const i18n: RunConfigI18nPort | null | undefined = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, replacements);
    return source.replace(/\{([^}]+)\}/g, (match, key: string) => (
      replacements && replacements[key] !== undefined ? String(replacements[key]) : match
    ));
  }

  function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return documentRef.getElementById(id) as T | null;
  }

  function configKey(language: string): string {
    return (stringValue(state.workspaceRoot) || '_global') + '|' + language;
  }

  function loadAll(): Record<string, unknown> {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) return recordValue(JSON.parse(raw));
      return recordValue(JSON.parse(storage.getItem(LEGACY_STORAGE_KEY) || '{}'));
    } catch (_) {
      return {};
    }
  }

  function saveAll(all: Record<string, unknown>): void {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (_) {
      // Storage can be unavailable in a private or restricted renderer.
    }
  }

  function getRaw(language: string): RunConfigRawDto {
    return normalizeRaw(loadAll()[configKey(language)]);
  }

  function setRaw(language: string, value: RunConfigRawDto): void {
    const all = loadAll();
    all[configKey(language)] = normalizeRaw(value);
    saveAll(all);
  }

  function getArgs(language: string): RunConfigArgsDto {
    const raw = getRaw(language);
    const selectedRuntime = stringValue(state.selectedRuntime);
    return {
      compileArgs: splitArgs(raw.compile),
      runArgs: splitArgs(raw.run),
      // Native Linux is the compatibility default. A cross target is sent
      // only after this server has confirmed that its toolchain is installed.
      buildTarget: TARGET_LANGS[language] && selectedRuntime && isTargetReadyForRun(language, raw.target)
        ? raw.target
        : ''
    };
  }

  function activeLanguage(): string | null {
    const active = (state.tabs || []).find((tab) => tab.path === state.activeTabPath);
    return active ? languageForFile(active.path) : null;
  }

  function isConfigurable(language: string | null): boolean {
    return Boolean(language && COMPILED_LANGS[language]);
  }

  function targetLabel(target: Pick<RunConfigTargetDto, 'id'>): string {
    return tr(TARGET_META[target.id]?.label || target.id);
  }

  function targetSystem(target: RunConfigTargetDto): string {
    return target.environment === 'bare-metal-rtos' ? 'bare-metal-rtos' : target.os;
  }

  function targetSystemLabel(id: string): string {
    return tr(TARGET_SYSTEMS[id] || id);
  }

  function fallbackTargetsFor(language: string): readonly RunConfigTargetDto[] {
    return FALLBACK_TARGETS.filter((target) => (
      (language !== 'rust' && language !== 'go') || target.id !== 'cortex-m4'
    ));
  }

  function targetCacheKey(language: string | null): string {
    return stringValue(language) + '|' + (stringValue(state.selectedRuntime) || 'local');
  }

  function targetsFor(language: string): readonly RunConfigTargetDto[] {
    const cache = targetCache.get(targetCacheKey(language));
    return cache && cache.targets.length ? cache.targets : fallbackTargetsFor(language);
  }

  function isTargetReadyForRun(language: string, targetId: string): boolean {
    if (!targetId || targetId === 'linux-x86_64') return false;
    const cache = targetCache.get(targetCacheKey(language));
    return Boolean(cache && !cache.promise && cache.targets.some((target) => target.id === targetId));
  }

  function loadTargets(language: string): Promise<readonly RunConfigTargetDto[]> {
    if (!TARGET_LANGS[language] || !dependencies.sendToServer) return Promise.resolve(targetsFor(language));
    const key = targetCacheKey(language);
    const existing = targetCache.get(key);
    if (existing?.promise) return existing.promise;
    const request = Promise.resolve(dependencies.sendToServer(
      'listBuildTargets',
      { language, runtime: stringValue(state.selectedRuntime) },
      { quiet: true }
    )).then((result: RunConfigTargetListResponseDto) => {
      const rawTargets = Array.isArray(result?.buildTargets) ? result.buildTargets : [];
      const targets = rawTargets
        .map((target) => normalizeTarget(target))
        .filter((target): target is RunConfigTargetDto => target !== null);
      const nextTargets = targets.length ? targets : NATIVE_TARGETS;
      const current = targetCache.get(key);
      if (!disposed && current?.promise === request) {
        targetCache.set(key, {
          targets: nextTargets,
          error: targets.length ? '' : 'empty'
        });
      }
      return nextTargets;
    }).catch(() => {
      const nextTargets = NATIVE_TARGETS;
      const current = targetCache.get(key);
      if (!disposed && current?.promise === request) {
        targetCache.set(key, { targets: nextTargets, error: 'unavailable' });
      }
      return nextTargets;
    });
    targetCache.set(key, {
      targets: existing?.targets || fallbackTargetsFor(language),
      promise: request
    });
    return request;
  }

  function clearOptions(select: HTMLSelectElement | null): void {
    while (select && select.firstChild) select.removeChild(select.firstChild);
  }

  function createOption(value: string, text: string): HTMLOptionElement {
    const item = documentRef.createElement('option');
    item.value = value;
    item.textContent = text;
    return item;
  }

  function selectedTarget(targets: readonly RunConfigTargetDto[], raw: RunConfigRawDto): RunConfigTargetDto | null {
    return targets.find((item) => item.id === raw.target) ||
      targets.find((item) => item.id === 'linux-x86_64') || targets[0] || null;
  }

  function targetToolchain(language: string, target: RunConfigTargetDto, meta: { readonly toolchain?: string }): string {
    if (language !== 'go') return meta.toolchain || target.id;
    if (target.id === 'linux-x86_64') return 'go build';
    return 'GOOS=' + target.os + ' GOARCH=' +
      (target.architecture === 'x86_64' ? 'amd64' : target.architecture) +
      ' CGO_ENABLED=0 go build';
  }

  function renderTargetControls(): void {
    if (disposed) return;
    const field = element('rc-target-field');
    if (!field) return;
    if (!currentLang || !TARGET_LANGS[currentLang]) {
      field.hidden = true;
      return;
    }
    field.hidden = false;
    const raw = getRaw(currentLang);
    const targets = targetsFor(currentLang);
    const selected = selectedTarget(targets, raw);
    if (!selected) return;
    const systemSelect = element<HTMLSelectElement>('rc-target-system');
    const architectureSelect = element<HTMLSelectElement>('rc-target-arch');
    if (!systemSelect || !architectureSelect) return;
    const system = targetSystem(selected);
    clearOptions(systemSelect);
    const seen = new Set<string>();
    targets.forEach((target) => {
      const id = targetSystem(target);
      if (!seen.has(id)) {
        seen.add(id);
        systemSelect.appendChild(createOption(id, targetSystemLabel(id)));
      }
    });
    systemSelect.value = system;
    clearOptions(architectureSelect);
    targets.filter((target) => targetSystem(target) === system).forEach((target) => {
      architectureSelect.appendChild(createOption(target.id, targetLabel(target)));
    });
    architectureSelect.value = selected.id;
    const meta = TARGET_META[selected.id] || {};
    const toolchain = element('rc-target-toolchain');
    const output = element('rc-target-output');
    const mode = element('rc-target-mode');
    if (toolchain) toolchain.textContent = targetToolchain(currentLang, selected, meta);
    if (output) output.textContent = selected.outputPath || '.bobocloud/output';
    if (mode) {
      mode.textContent = selected.runnable
        ? tr('Runs in cloud')
        : tr('Build only - returned as an artifact');
      mode.className = 'rc-target-mode ' + (selected.runnable ? 'is-runnable' : 'is-artifact');
    }
  }

  function updateSelectedTarget(id: string): void {
    if (!currentLang) return;
    const raw = getRaw(currentLang);
    setRaw(currentLang, { ...raw, target: id });
    renderTargetControls();
  }

  function onSystemChange(): void {
    if (!currentLang) return;
    const select = element<HTMLSelectElement>('rc-target-system');
    if (!select) return;
    const target = targetsFor(currentLang).find((item) => targetSystem(item) === select.value);
    if (target) updateSelectedTarget(target.id);
  }

  function onTargetChange(): void {
    const select = element<HTMLSelectElement>('rc-target-arch');
    if (select) updateSelectedTarget(select.value);
  }

  function positionPopover(): void {
    const pop = element('run-config-pop');
    const button = element('run-config-btn');
    if (!pop || !button) return;
    const rect = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(rect.right - width, windowRef.innerWidth - width - 8)) + 'px';
    pop.style.top = (rect.bottom + 6) + 'px';
  }

  function clearPointerTimer(): void {
    if (pointerTimer === null) return;
    windowRef.clearTimeout(pointerTimer);
    pointerTimer = null;
  }

  function closePopover(): void {
    const pop = element('run-config-pop');
    if (pop) pop.style.display = 'none';
    clearPointerTimer();
    documentRef.removeEventListener('pointerdown', onPointerDown, true);
  }

  function onPointerDown(event: Event): void {
    const pop = element('run-config-pop');
    const target = event.target as Element | null;
    if (pop && !pop.contains(target) && !target?.closest('#run-config-btn')) closePopover();
  }

  function openPopover(): void {
    if (disposed) return;
    const pop = element('run-config-pop');
    const language = activeLanguage();
    currentLang = language;
    if (!pop || !isConfigurable(language)) return;
    const raw = getRaw(language as string);
    const languageLabel = element('rc-lang');
    const compile = element<HTMLInputElement>('rc-compile-args');
    const run = element<HTMLInputElement>('rc-run-args');
    const hint = element('rc-hint');
    if (languageLabel) languageLabel.textContent = '- ' + (LANG_NAMES[language as string] || language);
    if (compile) compile.value = raw.compile;
    if (run) run.value = raw.run;
    if (hint) hint.textContent = tr('Saved per workspace and language. Changes apply to the next run.');
    pop.style.display = 'block';
    renderTargetControls();
    positionPopover();
    const requestedTargetKey = targetCacheKey(language as string);
    void loadTargets(language as string).then(() => {
      if (!disposed && pop.style.display === 'block' && currentLang === activeLanguage() &&
          targetCacheKey(activeLanguage()) === requestedTargetKey) {
        renderTargetControls();
        positionPopover();
      }
    });
    clearPointerTimer();
    let firedSynchronously = false;
    const timer = windowRef.setTimeout(() => {
      firedSynchronously = true;
      pointerTimer = null;
      if (!disposed && pop.style.display === 'block') {
        documentRef.addEventListener('pointerdown', onPointerDown, true);
      }
    }, 0);
    if (!firedSynchronously) pointerTimer = timer;
  }

  function onInput(): void {
    if (!currentLang) return;
    const compile = element<HTMLInputElement>('rc-compile-args');
    const run = element<HTMLInputElement>('rc-run-args');
    const raw = getRaw(currentLang);
    setRaw(currentLang, {
      compile: compile ? compile.value : raw.compile,
      run: run ? run.value : raw.run,
      target: raw.target
    });
  }

  function refreshForActiveFile(): void {
    if (disposed) return;
    const button = element('run-config-btn');
    if (!button) return;
    const language = activeLanguage();
    if (currentLang && currentLang !== language) closePopover();
    button.hidden = !isConfigurable(language);
    if (!isConfigurable(language)) closePopover();
  }

  function close(): void {
    if (disposed) return;
    closePopover();
  }

  type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

  function listen<T extends EventTargetLike>(
    target: T | null,
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (!target) return;
    target.addEventListener(type, callback, options);
    listeners.add(toDisposable(() => target.removeEventListener(type, callback, options)));
  }

  function init(): void {
    if (disposed || initialized) return;
    const button = element('run-config-btn');
    const pop = element('run-config-pop');
    if (!button || !pop) return;
    initialized = true;
    listen(button, 'click', (event) => {
      event.stopPropagation();
      const currentPopover = element('run-config-pop');
      if (currentPopover?.style.display === 'block') closePopover();
      else openPopover();
    });
    listen(element('rc-compile-args'), 'input', onInput);
    listen(element('rc-run-args'), 'input', onInput);
    listen(element('rc-target-system'), 'change', onSystemChange);
    listen(element('rc-target-arch'), 'change', onTargetChange);
    listen(pop, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        closePopover();
        button.focus();
      }
      event.stopPropagation();
    });
    listen(windowRef, 'resize', () => {
      if (element('run-config-pop')?.style.display === 'block') positionPopover();
    });
    const i18n = dependencies.getI18n();
    const onChange = i18n?.onChange;
    if (i18n && typeof onChange === 'function') {
      const registration = onChange.call(i18n, () => {
        if (element('run-config-pop')?.style.display === 'block') renderTargetControls();
      });
      if (typeof registration === 'function') listeners.add(toDisposable(registration));
      else if (registration) listeners.add(registration);
    }
    refreshForActiveFile();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    closePopover();
    listeners.dispose();
    targetCache.clear();
    currentLang = null;
  }

  const facade: RunConfigFacade = {
    init,
    languageForFile,
    getArgs,
    describeTarget: (id) => targetLabel({ id }),
    refreshForActiveFile,
    close,
    _splitArgs: splitArgs
  };
  const service: RunConfigService = {
    ...facade,
    get disposed() { return disposed; },
    dispose
  };
  return Object.freeze(service);
}
