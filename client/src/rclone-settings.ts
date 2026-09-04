import type { Dispose } from '../types/lifecycle';
import type {
  RcloneBinaryCandidateDto,
  RcloneBinaryScanDto,
  RcloneBinarySourceDto,
  RcloneSettingsDependencies,
  RcloneSettingsService,
  RcloneVersionResultDto
} from '../types/rclone';

export const RCLONE_SETTINGS_SERVICE_ID = 'workbench.rcloneSettings';

const BUNDLED_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Zm0 2.3 5.2 2.9L12 11.1 6.8 8.2 12 5.3Zm-5.5 4.6 4.4 2.5v5.7l-4.4-2.5V9.9Zm6.6 8.2v-5.7l4.4-2.5v5.7l-4.4 2.5Z"/></svg>';
const SYSTEM_ICON = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H4V5Zm2 2v7h12V7H6Zm2 2h2v2H8V9Zm-4 9h16v2H4v-2Z"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';

interface RcloneSettingsElements {
  readonly root: HTMLElement | null;
  readonly trigger: HTMLElement | null;
  readonly title: HTMLElement | null;
  readonly meta: HTMLElement | null;
  readonly options: HTMLElement | null;
  readonly status: HTMLElement | null;
}

interface RcloneSelectionState {
  source: RcloneBinarySourceDto;
  path: string | null;
  version: string | null;
  confirmedAt?: number | null;
}

interface RcloneVersionView {
  readonly available?: boolean;
  readonly path?: string | null;
  readonly source?: RcloneBinarySourceDto;
  readonly version?: string | null;
  readonly error?: string | null;
}

type LastStatus =
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'version'; readonly value: RcloneVersionView | RcloneVersionResultDto | null }
  | { readonly kind: 'configuration-error'; readonly value: string }
  | { readonly kind: 'selection-error'; readonly value: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'activating' };

function emptyElements(): RcloneSettingsElements {
  return {
    root: null,
    trigger: null,
    title: null,
    meta: null,
    options: null,
    status: null
  };
}

function closestElement(target: EventTarget | null, selector: string): Element | null {
  const candidate = target as { closest?: (value: string) => Element | null } | null;
  return candidate && typeof candidate.closest === 'function'
    ? candidate.closest(selector)
    : null;
}

function containsTarget(container: Element, target: EventTarget | null): boolean {
  if (!target) return false;
  try {
    return container.contains(target as Node);
  } catch (_) {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (message !== null && message !== undefined && message !== '') return String(message);
  }
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
}

export function createRcloneSettings(
  dependencies: RcloneSettingsDependencies
): RcloneSettingsService {
  const hostDocument = dependencies.document;
  const hostWindow = dependencies.window;
  let initialized = false;
  let menuOpen = false;
  let scanEpoch = 0;
  let statusEpoch = 0;
  let selectionOperation = 0;
  let selectionPending = false;
  let scanResult: RcloneBinaryScanDto | null = null;
  let selection: RcloneSelectionState = { source: 'bundled', path: null, version: null };
  let lastStatus: LastStatus = { kind: 'unchecked' };
  let elements = emptyElements();
  let settingsBody: HTMLElement | null = null;
  let renderedOptions: HTMLButtonElement[] = [];
  let optionIndexes = new WeakMap<HTMLButtonElement, number>();
  let unsubscribeI18n: Dispose | null = null;
  let resizeFrame: number | null = null;
  let settingsActive = false;
  let disposed = false;

  function i18n() {
    return dependencies.getI18n() || null;
  }

  function t(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    const service = i18n();
    if (service && typeof service.t === 'function') return service.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, (match, key: string) => (
      replacements && replacements[key] !== undefined
        ? String(replacements[key])
        : match
    ));
  }

  function findElements(): RcloneSettingsElements {
    return {
      root: hostDocument.getElementById('rclone-selector'),
      trigger: hostDocument.getElementById('rclone-path'),
      title: hostDocument.getElementById('rclone-select-title'),
      meta: hostDocument.getElementById('rclone-select-meta'),
      options: hostDocument.getElementById('rclone-options'),
      status: hostDocument.getElementById('rclone-status')
    };
  }

  function selectionTitle(value: RcloneSelectionState): string {
    return value.source === 'system'
      ? t('System PATH rclone')
      : t('App bundled rclone (Recommended)');
  }

  function renderSelection(): void {
    if (disposed || !elements.trigger) return;
    if (elements.title) elements.title.textContent = selectionTitle(selection);
    if (elements.meta) {
      elements.meta.textContent = selection.source === 'system'
        ? selection.path || t('Unverified external executable')
        : t('Managed by BOBOCLOUD');
    }
    elements.trigger.title = selection.source === 'system' ? selection.path || '' : '';
  }

  function setStatus(state: string, message: string, title?: string | null): void {
    if (disposed || !elements.status) return;
    elements.status.dataset.state = state;
    elements.status.textContent = message;
    if (title) elements.status.title = title;
    else elements.status.removeAttribute('title');
  }

  function renderVersion(
    result: RcloneVersionView | RcloneVersionResultDto | null,
    remember = true
  ): void {
    if (remember) lastStatus = { kind: 'version', value: result };
    if (result?.available) {
      setStatus('available', t('{source} rclone available: {version}', {
        source: result.source === 'system' ? t('System PATH') : t('Bundled'),
        version: result.version || t('unknown version')
      }), result.path || '');
      return;
    }
    setStatus('unavailable', t('rclone unavailable: {error}', {
      error: result?.error || t('unknown error')
    }), result?.path || '');
  }

  function renderConfigurationError(error: string, remember = true): void {
    if (remember) lastStatus = { kind: 'configuration-error', value: error };
    setStatus('warning', t('rclone is available, but server configuration failed: {error}', {
      error: error || t('unknown error')
    }), error || '');
  }

  function renderLastStatus(): void {
    if (lastStatus.kind === 'version') renderVersion(lastStatus.value, false);
    else if (lastStatus.kind === 'configuration-error') {
      renderConfigurationError(lastStatus.value, false);
    } else if (lastStatus.kind === 'selection-error') {
      setStatus('unavailable', t('Could not select rclone: {error}', { error: lastStatus.value }));
    } else if (lastStatus.kind === 'checking') {
      setStatus('checking', t('Checking rclone...'));
    } else if (lastStatus.kind === 'activating') {
      setStatus('checking', t('Validating and activating rclone...'));
    } else {
      setStatus('checking', t('Not checked'));
    }
  }

  function optionButton(candidate: RcloneBinaryCandidateDto, index: number): HTMLButtonElement {
    const button = hostDocument.createElement('button');
    button.type = 'button';
    button.className = 'rclone-option';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', candidate.selected ? 'true' : 'false');
    button.tabIndex = candidate.selected ? 0 : -1;
    button.disabled = selectionPending;
    button.dataset.candidateId = candidate.id;

    const icon = hostDocument.createElement('span');
    icon.className = 'rclone-option-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = candidate.source === 'bundled' ? BUNDLED_ICON : SYSTEM_ICON;
    button.appendChild(icon);

    const copy = hostDocument.createElement('span');
    copy.className = 'rclone-option-copy';
    const title = hostDocument.createElement('span');
    title.className = 'rclone-option-title';
    title.textContent = candidate.source === 'bundled'
      ? t('App bundled rclone (Recommended)')
      : candidate.path;
    copy.appendChild(title);
    const meta = hostDocument.createElement('span');
    meta.className = 'rclone-option-meta';
    meta.textContent = candidate.source === 'bundled'
      ? t('Managed by BOBOCLOUD')
      : t('Unverified external executable');
    copy.appendChild(meta);
    button.appendChild(copy);

    if (candidate.selected) {
      const check = hostDocument.createElement('span');
      check.className = 'rclone-option-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = CHECK_ICON;
      button.appendChild(check);
    }
    renderedOptions.push(button);
    optionIndexes.set(button, index);
    return button;
  }

  function renderOptions(result: RcloneBinaryScanDto): void {
    const container = elements.options;
    if (disposed || !container) return;
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const fragment = hostDocument.createDocumentFragment();
    renderedOptions = [];
    optionIndexes = new WeakMap<HTMLButtonElement, number>();
    candidates.forEach((candidate, index) => {
      fragment.appendChild(optionButton(candidate, index));
    });
    if (!candidates.some((candidate) => candidate.source === 'system')) {
      const empty = hostDocument.createElement('div');
      empty.className = 'rclone-options-empty';
      empty.textContent = t('No additional rclone installations found');
      fragment.appendChild(empty);
    }
    container.replaceChildren(fragment);
    positionMenu();
  }

  function positionMenu(): void {
    if (disposed || !menuOpen || !elements.root || !elements.trigger || !elements.options) return;
    const triggerRect = elements.trigger.getBoundingClientRect();
    const boundary = settingsBody
      ? settingsBody.getBoundingClientRect()
      : { top: 0, bottom: hostWindow.innerHeight };
    const spaceBelow = Math.max(0, boundary.bottom - triggerRect.bottom - 7);
    const spaceAbove = Math.max(0, triggerRect.top - boundary.top - 7);
    const openUp = spaceBelow < 150 && spaceAbove > spaceBelow;
    elements.root.classList.toggle('open-up', openUp);
    const available = openUp ? spaceAbove : spaceBelow;
    elements.root.style.setProperty(
      '--rclone-options-max-height',
      `${Math.max(72, Math.min(230, available))}px`
    );
  }

  function scheduleMenuPosition(): void {
    if (disposed || resizeFrame !== null) return;
    resizeFrame = hostWindow.requestAnimationFrame(() => {
      resizeFrame = null;
      positionMenu();
    });
  }

  function closeMenu(restoreFocus: boolean): void {
    menuOpen = false;
    scanEpoch += 1;
    elements.root?.classList.remove('open');
    if (elements.trigger) {
      elements.trigger.setAttribute('aria-expanded', 'false');
      elements.trigger.removeAttribute('aria-busy');
    }
    if (elements.options) elements.options.hidden = true;
    if (restoreFocus) elements.trigger?.focus();
  }

  function preferredOption(): HTMLButtonElement | null {
    return renderedOptions.find((option) => option.getAttribute('aria-selected') === 'true') ||
      renderedOptions[0] || null;
  }

  async function openMenu(focusOption: boolean): Promise<void> {
    if (disposed || selectionPending || !elements.root || !elements.trigger ||
        !elements.options || menuOpen) return;
    menuOpen = true;
    const epoch = ++scanEpoch;
    elements.root.classList.add('open');
    elements.trigger.setAttribute('aria-expanded', 'true');
    elements.trigger.setAttribute('aria-busy', 'true');
    elements.options.hidden = false;
    renderedOptions = [];
    optionIndexes = new WeakMap<HTMLButtonElement, number>();
    const loading = hostDocument.createElement('div');
    loading.className = 'rclone-options-loading';
    loading.textContent = t('Scanning rclone installations...');
    elements.options.replaceChildren(loading);
    positionMenu();
    try {
      const result = await dependencies.client.listBinaries();
      if (disposed || !menuOpen || epoch !== scanEpoch) return;
      scanResult = result;
      if (result.selection) selection = { ...result.selection };
      renderSelection();
      renderOptions(result);
      if (focusOption) preferredOption()?.focus();
    } catch (error) {
      if (disposed || !menuOpen || epoch !== scanEpoch) return;
      const failure = hostDocument.createElement('div');
      failure.className = 'rclone-options-error';
      failure.textContent = t('Could not scan system PATH: {error}', {
        error: errorMessage(error)
      });
      elements.options.replaceChildren(failure);
    } finally {
      if (!disposed && menuOpen && epoch === scanEpoch) {
        elements.trigger.removeAttribute('aria-busy');
      }
    }
  }

  function setOptionsDisabled(disabled: boolean): void {
    renderedOptions.forEach((button) => {
      button.disabled = disabled;
    });
  }

  async function chooseCandidate(candidateId: string): Promise<void> {
    const activeScan = scanResult;
    if (disposed || selectionPending || !activeScan || !candidateId) return;
    selectionPending = true;
    const operation = ++statusEpoch;
    const selectionToken = ++selectionOperation;
    const menuToken = scanEpoch;
    const previousStatus = lastStatus;
    const trigger = elements.trigger;
    lastStatus = { kind: 'activating' };
    renderLastStatus();
    trigger?.setAttribute('aria-busy', 'true');
    setOptionsDisabled(true);
    try {
      const result = await dependencies.client.selectBinary(activeScan.scanId, candidateId);
      if (disposed || selectionToken !== selectionOperation) return;
      const ownsMenu = menuOpen && menuToken === scanEpoch;
      if (!result || result.cancelled) {
        if (!ownsMenu) {
          if (settingsActive && operation === statusEpoch) {
            lastStatus = previousStatus;
            renderSelection();
            renderLastStatus();
          }
          return;
        }
        closeMenu(true);
        if (operation === statusEpoch) {
          lastStatus = previousStatus;
          renderSelection();
          renderLastStatus();
        }
        return;
      }
      if (!ownsMenu) {
        if (settingsActive) void openSettings();
        return;
      }
      // A completed mutation is newer than any status read that began while it
      // was pending. Invalidate those reads before committing its result.
      statusEpoch += 1;
      if (result.selection) selection = { ...result.selection };
      closeMenu(true);
      renderSelection();
      if (result.configurationError) renderConfigurationError(result.configurationError);
      else if (result.version) renderVersion(result.version);
      else await refreshStatus();
    } catch (error) {
      if (disposed || selectionToken !== selectionOperation || operation !== statusEpoch) return;
      const message = errorMessage(error);
      const ownsMenu = menuOpen && menuToken === scanEpoch;
      if (ownsMenu) closeMenu(true);
      else if (!settingsActive) return;
      lastStatus = { kind: 'selection-error', value: message };
      setStatus('unavailable', t('Could not select rclone: {error}', { error: message }));
    } finally {
      selectionPending = false;
      if (disposed) return;
      if (selectionToken === selectionOperation && menuOpen && menuToken === scanEpoch) {
        setOptionsDisabled(false);
        trigger?.removeAttribute('aria-busy');
      } else if (operation === statusEpoch) {
        trigger?.removeAttribute('aria-busy');
      }
    }
  }

  async function refreshStatus(): Promise<RcloneVersionResultDto | null> {
    if (disposed) return null;
    const operation = ++statusEpoch;
    lastStatus = { kind: 'checking' };
    renderLastStatus();
    try {
      const result = await dependencies.client.checkVersion();
      if (disposed || operation !== statusEpoch) return null;
      if (result?.source) {
        selection = {
          ...selection,
          source: result.source,
          path: result.path || selection.path,
          version: result.available ? result.version || null : null
        };
        renderSelection();
      }
      renderVersion(result);
      return result;
    } catch (error) {
      if (disposed || operation !== statusEpoch) return null;
      renderVersion({
        available: false,
        source: selection.source,
        path: selection.path,
        error: errorMessage(error)
      });
      return null;
    }
  }

  async function openSettings(): Promise<void> {
    if (disposed) return;
    settingsActive = true;
    const operation = ++statusEpoch;
    closeMenu(false);
    try {
      const current = await dependencies.client.getSelection();
      if (disposed || operation !== statusEpoch) return;
      if (current) selection = { ...current };
      renderSelection();
    } catch (error) {
      if (disposed || operation !== statusEpoch) return;
      const unavailable: RcloneVersionResultDto = {
        available: false,
        source: selection.source,
        path: selection.path,
        error: errorMessage(error)
      };
      lastStatus = { kind: 'version', value: unavailable };
      setStatus('unavailable', t('rclone unavailable: {error}', { error: unavailable.error }));
      return;
    }
    await refreshStatus();
  }

  function deactivate(): void {
    if (disposed) return;
    settingsActive = false;
    statusEpoch += 1;
    closeMenu(false);
  }

  function moveOptionFocus(current: HTMLButtonElement, direction: number): void {
    const count = renderedOptions.length;
    if (!count) return;
    const currentIndex = optionIndexes.get(current) ?? -1;
    for (let offset = 1; offset <= count; offset += 1) {
      const candidateIndex = currentIndex < 0
        ? 0
        : (currentIndex + (direction * offset) + count) % count;
      const candidate = renderedOptions[candidateIndex];
      if (!candidate || candidate.disabled) continue;
      if (current !== candidate) current.tabIndex = -1;
      candidate.tabIndex = 0;
      candidate.focus();
      return;
    }
  }

  function onTriggerClick(): void {
    if (menuOpen) closeMenu(false);
    else if (!selectionPending) void openMenu(false);
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (menuOpen) preferredOption()?.focus();
      else if (!selectionPending) void openMenu(true);
    } else if (event.key === 'Escape') {
      closeMenu(false);
    }
  }

  function optionForEvent(event: Event): HTMLButtonElement | null {
    const option = closestElement(event.target, '[data-candidate-id]');
    return option as HTMLButtonElement | null;
  }

  function onOptionsClick(event: MouseEvent): void {
    const option = optionForEvent(event);
    if (option?.dataset.candidateId) void chooseCandidate(option.dataset.candidateId);
  }

  function onOptionsKeydown(event: KeyboardEvent): void {
    const option = optionForEvent(event);
    if (!option) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveOptionFocus(option, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (option.dataset.candidateId) void chooseCandidate(option.dataset.candidateId);
    } else if (event.key === 'Escape') {
      closeMenu(false);
      elements.trigger?.focus();
    }
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    if (menuOpen && elements.root && !containsTarget(elements.root, event.target)) closeMenu(false);
  }

  function onWindowResize(): void {
    scheduleMenuPosition();
  }

  function onSettingsScroll(): void {
    closeMenu(false);
  }

  function onI18nChange(): void {
    if (disposed) return;
    renderSelection();
    if (menuOpen && scanResult) renderOptions(scanResult);
    renderLastStatus();
  }

  function initialize(): void {
    if (disposed || initialized) return;
    const next = findElements();
    if (!next.root || !next.trigger || !next.options) return;
    elements = next;
    settingsBody = next.root.closest('.settings-body') as HTMLElement | null;
    initialized = true;
    renderSelection();
    next.trigger.addEventListener('click', onTriggerClick);
    next.trigger.addEventListener('keydown', onTriggerKeydown);
    next.options.addEventListener('click', onOptionsClick);
    next.options.addEventListener('keydown', onOptionsKeydown);
    hostDocument.addEventListener('pointerdown', onDocumentPointerDown);
    hostWindow.addEventListener('resize', onWindowResize);
    settingsBody?.addEventListener('scroll', onSettingsScroll, { passive: true });
    const service = i18n();
    if (service && typeof service.onChange === 'function') {
      const dispose = service.onChange(onI18nChange);
      if (typeof dispose === 'function') unsubscribeI18n = dispose;
    }
  }

  function dispose(): void {
    if (disposed) return;
    statusEpoch += 1;
    selectionOperation += 1;
    selectionPending = false;
    settingsActive = false;
    closeMenu(false);
    disposed = true;
    if (resizeFrame !== null) {
      hostWindow.cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
    }
    if (initialized) {
      elements.trigger?.removeEventListener('click', onTriggerClick);
      elements.trigger?.removeEventListener('keydown', onTriggerKeydown);
      elements.options?.removeEventListener('click', onOptionsClick);
      elements.options?.removeEventListener('keydown', onOptionsKeydown);
      hostDocument.removeEventListener('pointerdown', onDocumentPointerDown);
      hostWindow.removeEventListener('resize', onWindowResize);
      settingsBody?.removeEventListener('scroll', onSettingsScroll);
    }
    unsubscribeI18n?.();
    unsubscribeI18n = null;
    settingsBody = null;
    renderedOptions = [];
    optionIndexes = new WeakMap<HTMLButtonElement, number>();
    elements = emptyElements();
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    initialize,
    open: openSettings,
    close: deactivate,
    refreshStatus,
    dispose
  });
}
