import type { Dispose } from '../types/lifecycle';
import type {
  LanguagePackPanelViewDto,
  LanguagePacksPanelDependencies,
  LanguagePacksPanelI18n,
  LanguagePacksPanelRenderOptions,
  LanguagePacksPanelService
} from '../types/language-packs-panel';

export const LANGUAGE_PACKS_PANEL_SERVICE_ID = 'workbench.languagePacksPanel';

type UnknownRecord = Record<string, unknown>;
type StatusTone = 'neutral' | 'error' | 'warning' | 'success';

interface LanguagePacksPanelElements {
  readonly current: HTMLSelectElement | null;
  readonly list: HTMLElement | null;
  readonly install: HTMLButtonElement | null;
  readonly openFolder: HTMLButtonElement | null;
  readonly refresh: HTMLButtonElement | null;
  readonly status: HTMLElement | null;
  readonly activeMeta: HTMLElement | null;
}

function emptyElements(): LanguagePacksPanelElements {
  return {
    current: null,
    list: null,
    install: null,
    openFolder: null,
    refresh: null,
    status: null,
    activeMeta: null
  };
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object'
    ? value as UnknownRecord
    : {};
}

function resolvePackValue(
  pack: UnknownRecord,
  keys: readonly string[],
  fallback: unknown
): unknown {
  const manifest = asRecord(pack.manifest);
  for (const key of keys) {
    const direct = pack[key];
    if (direct !== null && direct !== undefined && direct !== '') return direct;
    const nested = manifest[key];
    if (nested !== null && nested !== undefined && nested !== '') return nested;
  }
  return fallback;
}

export function normalizeLanguagePackPanelEntry(
  value: unknown,
  index: number
): LanguagePackPanelViewDto {
  const pack = asRecord(value);
  const id = String(resolvePackValue(pack, ['id', 'locale', 'code', 'language'], `pack-${index}`));
  const source = String(resolvePackValue(pack, ['source', 'origin'], '')).toLowerCase();
  const builtIn = pack.builtIn === true || pack.builtin === true || pack.bundled === true ||
    source === 'builtin' || source === 'built-in' || source === 'bundled' || source === 'core';
  const nativeName = String(resolvePackValue(
    pack,
    ['nativeName', 'native_name', 'displayName', 'label', 'name'],
    id
  ));
  const name = String(resolvePackValue(pack, ['name', 'englishName', 'english_name'], nativeName));
  const removable = resolvePackValue(pack, ['removable'], !builtIn) !== false && !builtIn;

  return {
    raw: pack,
    id,
    name,
    nativeName,
    version: String(resolvePackValue(pack, ['version'], '1.0.0')),
    builtIn,
    removable
  };
}

export function normalizeLanguagePackPanelEntries(
  value: unknown
): readonly LanguagePackPanelViewDto[] {
  const record = asRecord(value);
  const values = Array.isArray(value)
    ? value
    : Array.isArray(record.packs) ? record.packs : [];
  const ids = new Set<string>();
  const packs: LanguagePackPanelViewDto[] = [];

  values.forEach((entry, index) => {
    const pack = normalizeLanguagePackPanelEntry(entry, index);
    if (ids.has(pack.id)) return;
    ids.add(pack.id);
    packs.push(pack);
  });
  return packs;
}

function activePackId(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const record = value as UnknownRecord;
    return String(record.id || record.locale || record.code || record.language || '');
  }
  return value === null || value === undefined ? '' : String(value);
}

function sameElements(
  left: LanguagePacksPanelElements,
  right: LanguagePacksPanelElements
): boolean {
  return left.current === right.current &&
    left.list === right.list &&
    left.install === right.install &&
    left.openFolder === right.openFolder &&
    left.refresh === right.refresh &&
    left.status === right.status &&
    left.activeMeta === right.activeMeta;
}

function closestElement(target: EventTarget | null, selector: string): Element | null {
  const candidate = target as { closest?: (value: string) => Element | null } | null;
  return candidate && typeof candidate.closest === 'function'
    ? candidate.closest(selector)
    : null;
}

function messageFor(error: unknown, fallback: string): string {
  const message = asRecord(error).message;
  return message ? String(message) : fallback;
}

export function createLanguagePacksPanel(
  dependencies: LanguagePacksPanelDependencies
): LanguagePacksPanelService {
  const hostDocument = dependencies.document;
  let elements = emptyElements();
  let eventsBound = false;
  let unsubscribe: Dispose | null = null;
  let renderSequence = 0;
  let busyCount = 0;
  let availablePackCount = 0;
  let initPromise: Promise<boolean> | null = null;
  let disposed = false;

  function i18n(): LanguagePacksPanelI18n | null {
    return dependencies.getI18n() || null;
  }

  function interpolate(source: unknown, params?: Readonly<Record<string, unknown>>): string {
    return String(source).replace(/\{([\w.-]+)\}/g, (match, key: string) => (
      params?.[key] !== null && params?.[key] !== undefined
        ? String(params[key])
        : match
    ));
  }

  function tr(source: string, params?: Readonly<Record<string, unknown>>): string {
    const service = i18n();
    if (service && typeof service.t === 'function') {
      try {
        return service.t(source, params);
      } catch (_) {
        // Fall through to deterministic source interpolation.
      }
    }
    return interpolate(source, params);
  }

  function bindTo(target: LanguagePacksPanelElements): void {
    target.current?.addEventListener('change', onLocaleChange);
    target.install?.addEventListener('click', onInstallClick);
    target.openFolder?.addEventListener('click', onOpenFolderClick);
    target.refresh?.addEventListener('click', onRefreshClick);
    target.list?.addEventListener('click', onListClick);
  }

  function unbindFrom(target: LanguagePacksPanelElements): void {
    target.current?.removeEventListener('change', onLocaleChange);
    target.install?.removeEventListener('click', onInstallClick);
    target.openFolder?.removeEventListener('click', onOpenFolderClick);
    target.refresh?.removeEventListener('click', onRefreshClick);
    target.list?.removeEventListener('click', onListClick);
  }

  function cacheElements(): void {
    const next: LanguagePacksPanelElements = {
      current: hostDocument.getElementById('language-pack-current') as HTMLSelectElement | null,
      list: hostDocument.getElementById('language-pack-list'),
      install: hostDocument.getElementById('language-pack-install') as HTMLButtonElement | null,
      openFolder: hostDocument.getElementById('language-pack-open-folder') as HTMLButtonElement | null,
      refresh: hostDocument.getElementById('language-pack-refresh') as HTMLButtonElement | null,
      status: hostDocument.getElementById('language-pack-status'),
      activeMeta: hostDocument.getElementById('language-pack-active-meta')
    };

    if (eventsBound && !sameElements(elements, next)) {
      unbindFrom(elements);
      bindTo(next);
    }
    elements = next;

    if (elements.current) {
      elements.current.classList.add('language-pack-select');
      if (!elements.current.getAttribute('aria-label')) {
        elements.current.setAttribute('aria-label', tr('Display language'));
      }
    }
    if (elements.list) {
      elements.list.classList.add('language-pack-list');
      elements.list.setAttribute('role', 'list');
      elements.list.setAttribute('aria-label', tr('Installed language packs'));
    }
    if (elements.status) {
      elements.status.classList.add('language-pack-status');
      elements.status.setAttribute('role', 'status');
      elements.status.setAttribute('aria-live', 'polite');
      elements.status.setAttribute('aria-atomic', 'true');
    }
    [elements.install, elements.openFolder, elements.refresh].forEach((button) => {
      button?.classList.add('language-pack-action');
    });
  }

  function setStatus(message: string, tone: StatusTone): void {
    if (disposed || !elements.status) return;
    elements.status.textContent = message || '';
    elements.status.dataset.tone = tone || 'neutral';
  }

  function setBusy(busy: boolean): void {
    busyCount = Math.max(0, busyCount + (busy ? 1 : -1));
    if (disposed) return;
    const active = busyCount > 0;
    [elements.install, elements.openFolder, elements.refresh].forEach((control) => {
      if (control) control.disabled = active;
    });
    if (elements.current) elements.current.disabled = active || availablePackCount === 0;
    elements.list?.querySelectorAll<HTMLButtonElement>('.language-pack-remove').forEach((button) => {
      button.disabled = active;
    });
    elements.list?.setAttribute('aria-busy', active ? 'true' : 'false');
  }

  function appendText(
    parent: Element,
    tag: string,
    className: string,
    text: string
  ): HTMLElement {
    const node = hostDocument.createElement(tag);
    node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function renderEmpty(message: string, error: boolean): void {
    if (!elements.list) return;
    elements.list.replaceChildren();
    const empty = hostDocument.createElement('div');
    empty.className = `language-pack-empty${error ? ' is-error' : ''}`;
    empty.setAttribute('role', error ? 'alert' : 'note');
    appendText(
      empty,
      'strong',
      'language-pack-empty-title',
      error ? tr('Language packs unavailable') : tr('No language packs installed')
    );
    appendText(empty, 'span', 'language-pack-empty-detail', message);
    elements.list.appendChild(empty);
  }

  function sourceLabel(pack: LanguagePackPanelViewDto): string {
    return pack.builtIn ? tr('Built in') : tr('User installed');
  }

  function removeIcon(): string {
    const icon = dependencies.getTrashIcon();
    if (icon) return icon;
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2 0-.6 9H4.6L4 4m2.3 2.5v4m3.4-4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function renderPack(pack: LanguagePackPanelViewDto, selected: boolean): HTMLElement {
    const row = hostDocument.createElement('div');
    row.className = `language-pack-row${selected ? ' is-active' : ''}`;
    row.setAttribute('role', 'listitem');
    row.dataset.packId = pack.id;

    const marker = hostDocument.createElement('span');
    marker.className = 'language-pack-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = selected ? 'A' : pack.nativeName.slice(0, 1).toUpperCase();
    row.appendChild(marker);

    const identity = hostDocument.createElement('div');
    identity.className = 'language-pack-identity';
    const title = appendText(identity, 'strong', 'language-pack-name', pack.nativeName);
    if (pack.name && pack.name !== pack.nativeName) {
      appendText(title, 'span', 'language-pack-secondary-name', pack.name);
    }
    const meta = hostDocument.createElement('div');
    meta.className = 'language-pack-meta';
    appendText(meta, 'span', 'language-pack-locale', pack.id);
    appendText(meta, 'span', 'language-pack-version', `v${pack.version}`);
    appendText(meta, 'span', 'language-pack-source', sourceLabel(pack));
    identity.appendChild(meta);
    row.appendChild(identity);

    const actions = hostDocument.createElement('div');
    actions.className = 'language-pack-row-actions';
    if (selected) {
      const active = appendText(actions, 'span', 'language-pack-active-label', tr('Current'));
      active.setAttribute('aria-label', tr('Current display language'));
    }
    if (pack.removable) {
      const remove = hostDocument.createElement('button');
      remove.type = 'button';
      remove.className = 'language-pack-remove';
      remove.dataset.removePack = pack.id;
      remove.title = tr('Remove {name}', { name: pack.nativeName });
      remove.setAttribute('aria-label', remove.title);
      remove.disabled = busyCount > 0;
      remove.innerHTML = removeIcon();
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    return row;
  }

  function populateSelect(
    packs: readonly LanguagePackPanelViewDto[],
    selectedId: string
  ): void {
    availablePackCount = packs.length;
    if (!elements.current) return;
    const fragment = hostDocument.createDocumentFragment();
    let selected: LanguagePackPanelViewDto | null = null;
    for (const pack of packs) {
      const option = hostDocument.createElement('option');
      option.value = pack.id;
      option.textContent = pack.nativeName + (pack.name !== pack.nativeName ? ` - ${pack.name}` : '');
      fragment.appendChild(option);
      if (pack.id === selectedId) selected = pack;
    }
    elements.current.replaceChildren(fragment);
    elements.current.value = selectedId;
    elements.current.disabled = busyCount > 0 || packs.length === 0;
    if (elements.activeMeta) {
      elements.activeMeta.textContent = selected
        ? `${selected.nativeName} / ${selected.id} / v${selected.version}`
        : '';
    }
  }

  async function render(
    options: LanguagePacksPanelRenderOptions = {}
  ): Promise<readonly LanguagePackPanelViewDto[]> {
    const renderOptions = options || {};
    if (disposed) return [];
    cacheElements();
    const service = i18n();
    if (!elements.list || !service) {
      renderEmpty(tr('The language service is not ready.'), true);
      setStatus(tr('Language service unavailable'), 'error');
      return [];
    }

    const sequence = ++renderSequence;
    if (!renderOptions.quiet) setStatus(tr('Loading language packs...'), 'neutral');
    try {
      const values = await Promise.all([
        Promise.resolve(service.listPacks()),
        Promise.resolve(service.getActive()),
        Promise.resolve(typeof service.getErrors === 'function' ? service.getErrors() : [])
      ]);
      if (disposed || sequence !== renderSequence || !elements.list) return [];
      const packs = normalizeLanguagePackPanelEntries(values[0]);
      const selectedId = activePackId(values[1]);
      populateSelect(packs, selectedId);
      elements.list.replaceChildren();
      if (!packs.length) {
        renderEmpty(tr('Install a language pack or open the pack folder to add one.'), false);
      } else {
        const fragment = hostDocument.createDocumentFragment();
        packs.forEach((pack) => fragment.appendChild(renderPack(pack, pack.id === selectedId)));
        elements.list.appendChild(fragment);
      }
      if (!renderOptions.preserveStatus) {
        const packErrors = Array.isArray(values[2]) ? values[2] : [];
        if (packErrors.length) {
          setStatus(tr('{count} language packs could not be loaded', { count: packErrors.length }), 'warning');
        } else {
          setStatus(tr('{count} language packs available', { count: packs.length }), 'neutral');
        }
      }
      return packs;
    } catch (error) {
      if (disposed || sequence !== renderSequence) return [];
      const message = messageFor(error, tr('Unknown error'));
      populateSelect([], '');
      renderEmpty(message, true);
      setStatus(tr('Could not load language packs: {message}', { message }), 'error');
      return [];
    }
  }

  async function changeLocale(): Promise<void> {
    const service = i18n();
    if (disposed || !service || !elements.current) return;
    const nextId = elements.current.value;
    const previousId = activePackId(await Promise.resolve(service.getActive()));
    if (disposed || !nextId || nextId === previousId) return;
    setBusy(true);
    setStatus(tr('Switching display language...'), 'neutral');
    try {
      const result = await Promise.resolve(service.setLocale(nextId));
      await render({ preserveStatus: true, quiet: true });
      if (result?.editorReloadRecommended) {
        setStatus(tr('Display language changed. Editor menus update after reload.'), 'success');
      } else {
        setStatus(tr('Display language changed'), 'success');
      }
    } catch (error) {
      if (!disposed && elements.current) elements.current.value = previousId;
      setStatus(tr('Could not change language: {message}', {
        message: messageFor(error, tr('Unknown error'))
      }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function installPack(): Promise<void> {
    const service = i18n();
    if (disposed || !service) return;
    setBusy(true);
    setStatus(tr('Installing language pack...'), 'neutral');
    try {
      const result: unknown = await Promise.resolve(service.install());
      if (result === null || result === undefined || result === false || asRecord(result).canceled === true) {
        setStatus(tr('Installation cancelled'), 'neutral');
        return;
      }
      await render({ preserveStatus: true, quiet: true });
      setStatus(tr('Language pack installed'), 'success');
    } catch (error) {
      setStatus(tr('Could not install language pack: {message}', {
        message: messageFor(error, tr('Unknown error'))
      }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removePack(packId: string): Promise<void> {
    const service = i18n();
    if (disposed || !service) return;
    let row: HTMLElement | null = null;
    const rows = elements.list?.querySelectorAll<HTMLElement>('[data-pack-id]') || [];
    for (const candidate of rows) {
      if (candidate.dataset.packId === packId) {
        row = candidate;
        break;
      }
    }
    const nameNode = row?.querySelector<HTMLElement>('.language-pack-name');
    const name = nameNode?.childNodes[0]?.textContent || packId;
    if (!dependencies.confirm(tr('Remove language pack "{name}"?', { name }))) return;
    setBusy(true);
    row?.setAttribute('aria-busy', 'true');
    setStatus(tr('Removing language pack...'), 'neutral');
    try {
      await Promise.resolve(service.remove(packId));
      await render({ preserveStatus: true, quiet: true });
      setStatus(tr('Language pack removed'), 'success');
    } catch (error) {
      if (!disposed) row?.removeAttribute('aria-busy');
      setStatus(tr('Could not remove language pack: {message}', {
        message: messageFor(error, tr('Unknown error'))
      }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openFolder(): Promise<void> {
    const service = i18n();
    if (disposed || !service) return;
    setBusy(true);
    try {
      await Promise.resolve(service.openFolder());
      setStatus(tr('Language pack folder opened'), 'success');
    } catch (error) {
      setStatus(tr('Could not open the language pack folder: {message}', {
        message: messageFor(error, tr('Unknown error'))
      }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refresh(): Promise<void> {
    const service = i18n();
    if (disposed || !service) return;
    setBusy(true);
    setStatus(tr('Reloading language packs...'), 'neutral');
    try {
      await Promise.resolve(service.refresh());
      await render({ preserveStatus: true, quiet: true });
      const packErrors = typeof service.getErrors === 'function'
        ? await Promise.resolve(service.getErrors())
        : [];
      if (Array.isArray(packErrors) && packErrors.length) {
        setStatus(tr('{count} language packs could not be loaded', { count: packErrors.length }), 'warning');
      } else {
        setStatus(tr('Language packs reloaded'), 'success');
      }
    } catch (error) {
      setStatus(tr('Could not reload language packs: {message}', {
        message: messageFor(error, tr('Unknown error'))
      }), 'error');
    } finally {
      setBusy(false);
    }
  }

  function onLocaleChange(): void {
    void changeLocale();
  }

  function onInstallClick(): void {
    void installPack();
  }

  function onOpenFolderClick(): void {
    void openFolder();
  }

  function onRefreshClick(): void {
    void refresh();
  }

  function onListClick(event: MouseEvent): void {
    const button = closestElement(event.target, '[data-remove-pack]') as HTMLElement | null;
    if (!button || !elements.list?.contains(button)) return;
    const packId = button.dataset.removePack;
    if (packId !== undefined) void removePack(packId);
  }

  function bindEvents(): void {
    if (eventsBound || disposed) return;
    eventsBound = true;
    bindTo(elements);
  }

  function onLanguagePacksChanged(): void {
    void render({ quiet: true, preserveStatus: false });
  }

  function subscribe(service: LanguagePacksPanelI18n): void {
    if (unsubscribe || disposed || typeof service.onChange !== 'function') return;
    const dispose = service.onChange(onLanguagePacksChanged);
    unsubscribe = dispose;
  }

  async function initialize(): Promise<boolean> {
    cacheElements();
    bindEvents();
    const service = i18n();
    if (!service) {
      await render();
      return false;
    }
    try {
      if (typeof service.init === 'function') await Promise.resolve(service.init());
      if (disposed) return false;
      subscribe(service);
      await render();
      return !disposed;
    } catch (error) {
      if (disposed) return false;
      const message = messageFor(error, tr('Unknown error'));
      renderEmpty(message, true);
      setStatus(tr('Could not initialize language packs: {message}', { message }), 'error');
      return false;
    }
  }

  function init(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (initPromise) return initPromise;
    const pending = initialize();
    initPromise = pending;
    void pending.then(
      () => {
        if (initPromise === pending) initPromise = null;
      },
      () => {
        if (initPromise === pending) initPromise = null;
      }
    );
    return pending;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    renderSequence += 1;
    initPromise = null;
    if (eventsBound) unbindFrom(elements);
    eventsBound = false;
    const disposeSubscription = unsubscribe;
    unsubscribe = null;
    if (disposeSubscription) {
      try {
        disposeSubscription();
      } catch (_) {
        // The remaining local listeners still need to be released.
      }
    }
    elements = emptyElements();
    busyCount = 0;
    availablePackCount = 0;
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    init,
    render,
    refresh,
    dispose
  });
}
