import { createSandboxedDocumentView } from '../renderer/core/document-view-sandbox.js';
import { selectDocumentView } from '../renderer/core/document-view.js';
import { toDisposable } from '../renderer/core/disposable.js';
import type {
  DocumentViewContributionChangeEventDto,
  DocumentViewDependencies,
  DocumentViewInstance,
  DocumentViewLocalizationDto,
  DocumentViewPublicDescriptorDto,
  DocumentViewRegistrationDto,
  DocumentViewService,
  DocumentViewTabLike,
  LoadedDocumentViewDto,
  SandboxedDocumentView
} from '../types/document-view';
import type { Disposable } from '../types/lifecycle';

interface PendingCreation {
  readonly path: string;
  readonly fileName: string;
  readonly pluginId: string;
  readonly viewerId: string;
  readonly epoch: number;
  cancelled: boolean;
  promise: Promise<DocumentViewInstance>;
}

function exceptionMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error';
}

function sameRegistration(
  left: DocumentViewRegistrationDto,
  right: DocumentViewRegistrationDto
): boolean {
  return left.pluginId === right.pluginId && left.id === right.id;
}

function asDisposable(value: Disposable | (() => void) | void): Disposable | null {
  if (!value) return null;
  return typeof value === 'function' ? toDisposable(value) : value;
}

function publicViewer(
  loaded: LoadedDocumentViewDto,
  registration: DocumentViewRegistrationDto
): DocumentViewPublicDescriptorDto {
  return Object.freeze({
    id: registration.id,
    title: registration.title,
    extensions: Object.freeze([...loaded.viewer.extensions]),
    priority: loaded.viewer.priority
  });
}

// Trusted host-owned orchestration for isolated document viewers. Package code
// receives only the sandbox DTOs; filesystem and package access stay behind the
// injected host port.
export function createDocumentViewService(
  dependencies: DocumentViewDependencies
): DocumentViewService {
  const {
    document: hostDocument,
    state,
    i18n,
    theme,
    views,
    workspace,
    contributions,
    host
  } = dependencies;
  const createSandboxedView = dependencies.createSandboxedView || createSandboxedDocumentView;
  const instances = new Set<DocumentViewInstance>();
  const instancesByPath = new Map<string, DocumentViewInstance>();
  const pendingByPath = new Map<string, PendingCreation>();
  const releasedInstances = new WeakSet<DocumentViewInstance>();
  const subscriptions: Disposable[] = [];
  let activeInstance: DocumentViewInstance | null = null;
  let creationEpoch = 0;
  let localeEpoch = 0;
  let initialized = false;
  let disposed = false;

  function t(source: string): string {
    return i18n.t(source);
  }

  function activeLocale(): string {
    return typeof i18n.getActive === 'function' ? i18n.getActive() : 'en';
  }

  function find(fileName: string): DocumentViewRegistrationDto | null {
    const entry = selectDocumentView(contributions.list(), fileName);
    if (!entry) return null;
    return Object.freeze({
      pluginId: entry.owner,
      id: entry.contribution.id,
      title: entry.contribution.title,
      extensions: entry.contribution.extensions,
      priority: entry.contribution.priority
    });
  }

  function currentRegistration(
    fileName: string,
    expected: DocumentViewRegistrationDto
  ): DocumentViewRegistrationDto {
    const current = find(fileName);
    if (!current || !sameRegistration(current, expected)) {
      throw new Error('Document viewer registration is no longer current.');
    }
    return current;
  }

  function assertCreationCurrent(
    pending: PendingCreation,
    expected: DocumentViewRegistrationDto
  ): DocumentViewRegistrationDto {
    if (disposed || pending.cancelled || pending.epoch !== creationEpoch || pendingByPath.get(pending.path) !== pending) {
      throw new Error('Document view creation was cancelled.');
    }
    return currentRegistration(pending.fileName, expected);
  }

  function showFailure(instance: DocumentViewInstance, error: unknown): void {
    if (instance.disposed) return;
    try { instance.sandbox.dispose(); } catch (_) {}
    releaseDocument(instance);
    instance.error.hidden = activeInstance !== instance;
    instance.error.textContent = t('Document preview failed') + ': ' + exceptionMessage(error);
  }

  function closeDocument(documentId: string): void {
    try {
      void Promise.resolve(host.closeDocument(documentId)).catch(() => {});
    } catch (_) {}
  }

  function releaseDocument(instance: DocumentViewInstance): void {
    if (releasedInstances.has(instance)) return;
    releasedInstances.add(instance);
    closeDocument(instance.documentId);
  }

  async function stableLocalization(
    pluginId: string,
    initialLocale: string,
    pending: PendingCreation,
    registration: DocumentViewRegistrationDto,
    initialRequest: Promise<DocumentViewLocalizationDto>
  ): Promise<DocumentViewLocalizationDto> {
    let requestedLocale = initialLocale;
    let localization = await initialRequest;
    assertCreationCurrent(pending, registration);
    while (activeLocale() !== requestedLocale) {
      requestedLocale = activeLocale();
      localization = await host.loadLocalization(pluginId, requestedLocale);
      assertCreationCurrent(pending, registration);
    }
    return localization;
  }

  async function createPending(
    pending: PendingCreation,
    registration: DocumentViewRegistrationDto
  ): Promise<DocumentViewInstance> {
    let documentId = '';
    let errorView: HTMLDivElement | null = null;
    let sandbox: SandboxedDocumentView | null = null;
    let instance: DocumentViewInstance | null = null;
    try {
      let current = assertCreationCurrent(pending, registration);
      const locale = activeLocale();
      const localizationRequest = host.loadLocalization(current.pluginId, locale);
      const [loaded, localization] = await Promise.all([
        host.loadDocumentView(current.pluginId, current.id),
        stableLocalization(current.pluginId, locale, pending, registration, localizationRequest)
      ]);
      current = assertCreationCurrent(pending, registration);
      if (!loaded || loaded.pluginId !== current.pluginId || loaded.viewer.id !== current.id) {
        throw new Error('Document viewer identity mismatch.');
      }

      const rootBeforeOpen = hostDocument.getElementById('document-view-host');
      if (!rootBeforeOpen) throw new Error('Document view host is unavailable.');
      const documentInfo = await host.openDocument(current.pluginId, current.id, pending.path);
      documentId = documentInfo.documentId;
      current = assertCreationCurrent(pending, registration);
      const root = hostDocument.getElementById('document-view-host');
      if (!root || root !== rootBeforeOpen) throw new Error('Document view host is unavailable.');

      errorView = hostDocument.createElement('div');
      errorView.className = 'document-view-host-error';
      errorView.hidden = true;
      root.appendChild(errorView);

      instance = {
        path: pending.path,
        pluginId: current.pluginId,
        viewerId: current.id,
        documentId,
        error: errorView,
        get sandbox(): SandboxedDocumentView {
          if (!sandbox) throw new Error('Document view sandbox is unavailable.');
          return sandbox;
        },
        disposed: false
      } satisfies DocumentViewInstance;

      const createdSandbox = createSandboxedView({
        container: root,
        entry: loaded.entry,
        resources: loaded.resources,
        document: documentInfo,
        viewer: publicViewer(loaded, current),
        localization,
        theme: theme.snapshot(),
        read: (range) => host.readDocument(documentId, range.offset, range.length),
        onError: (error) => showFailure(instance as DocumentViewInstance, error)
      });
      sandbox = createdSandbox;
      assertCreationCurrent(pending, registration);
      instances.add(instance);
      instancesByPath.set(pending.path, instance);
      void createdSandbox.ready.catch((error) => showFailure(instance as DocumentViewInstance, error));
      return instance;
    } catch (error) {
      try { sandbox?.dispose(); } catch (_) {}
      errorView?.remove();
      if (instance) releaseDocument(instance);
      else if (documentId) closeDocument(documentId);
      throw error;
    }
  }

  function create(
    filePath: string,
    fileName: string,
    registration: DocumentViewRegistrationDto
  ): Promise<DocumentViewInstance> {
    if (disposed) return Promise.reject(new Error('Document view service has been disposed.'));
    const current = currentRegistration(fileName, registration);
    const existing = instancesByPath.get(filePath);
    if (existing && !existing.disposed) {
      if (existing.pluginId === current.pluginId && existing.viewerId === current.id) {
        return Promise.resolve(existing);
      }
      disposeInstance(existing);
    }

    const inflight = pendingByPath.get(filePath);
    if (inflight && inflight.pluginId === current.pluginId && inflight.viewerId === current.id) {
      return inflight.promise;
    }

    const pending: PendingCreation = {
      path: filePath,
      fileName,
      pluginId: current.pluginId,
      viewerId: current.id,
      epoch: creationEpoch,
      cancelled: false,
      promise: Promise.resolve(null as never)
    };
    pendingByPath.set(filePath, pending);
    pending.promise = createPending(pending, current);
    const clearPending = (): void => {
      if (pendingByPath.get(filePath) === pending) pendingByPath.delete(filePath);
    };
    void pending.promise.then(clearPending, clearPending);
    return pending.promise;
  }

  function show(tab: DocumentViewTabLike | null | undefined): boolean {
    const instance = tab?.documentView;
    if (!instance || instance.disposed || !instances.has(instance)) return false;
    if (state.currentViewMode === 'split') views.closeSplit?.();
    if (state.currentViewMode === 'diff') views.closeDiff?.();
    views.closeImagePreview?.();
    const editor = hostDocument.getElementById('container');
    const root = hostDocument.getElementById('document-view-host');
    if (editor) editor.style.display = 'none';
    root?.classList.remove('hidden');

    if (activeInstance && activeInstance !== instance && !activeInstance.disposed) {
      activeInstance.sandbox.hide();
      activeInstance.error.hidden = true;
    }
    activeInstance = instance;
    instance.error.hidden = instance.error.textContent === '';
    instance.sandbox.show();
    state.currentViewMode = 'document-view';
    return true;
  }

  function hideAll(options: { readonly restoreEditor?: boolean } = {}): void {
    hostDocument.getElementById('document-view-host')?.classList.add('hidden');
    if (activeInstance && !activeInstance.disposed) {
      activeInstance.sandbox.hide();
      activeInstance.error.hidden = true;
    }
    activeInstance = null;
    if (options.restoreEditor !== false) {
      const editor = hostDocument.getElementById('container');
      if (editor) editor.style.display = '';
      if (state.currentViewMode === 'document-view') state.currentViewMode = 'single';
    }
  }

  function disposeInstance(instance: DocumentViewInstance | null | undefined): void {
    if (!instance || instance.disposed) return;
    instance.disposed = true;
    instances.delete(instance);
    if (instancesByPath.get(instance.path) === instance) instancesByPath.delete(instance.path);
    if (activeInstance === instance) activeInstance = null;
    try { instance.sandbox.dispose(); } catch (_) {}
    instance.error.remove();
    releaseDocument(instance);
  }

  function disposeTab(tab: DocumentViewTabLike | null | undefined): void {
    if (!tab?.documentView) return;
    disposeInstance(tab.documentView);
    tab.documentView = null;
  }

  function disposeAllInstances(): void {
    for (const instance of Array.from(instances)) disposeInstance(instance);
    hideAll();
  }

  function disposeAll(): void {
    creationEpoch += 1;
    pendingByPath.clear();
    disposeAllInstances();
  }

  function closeAffectedTab(tab: DocumentViewTabLike): void {
    disposeTab(tab);
    try {
      void Promise.resolve(workspace.closeTab(tab.path, { force: true })).catch(() => {});
    } catch (_) {}
  }

  function handleContributionChange(event: DocumentViewContributionChangeEventDto): void {
    if (!event || event.type !== 'removed') return;
    for (const pending of Array.from(pendingByPath.values())) {
      if (pending.pluginId !== event.owner || pending.viewerId !== event.id) continue;
      pending.cancelled = true;
      if (pendingByPath.get(pending.path) === pending) pendingByPath.delete(pending.path);
    }
    const matches = (instance: DocumentViewInstance): boolean => (
      instance.pluginId === event.owner && instance.viewerId === event.id
    );
    for (const instance of Array.from(instances)) {
      if (matches(instance)) disposeInstance(instance);
    }
    state.tabs.filter((tab) => tab.documentView && matches(tab.documentView)).forEach(closeAffectedTab);
  }

  async function refreshLocalizations(): Promise<void> {
    const refreshEpoch = ++localeEpoch;
    if (disposed || instances.size === 0) return;
    const locale = activeLocale();
    const byPlugin = new Map<string, DocumentViewInstance[]>();
    for (const instance of instances) {
      if (instance.disposed) continue;
      const group = byPlugin.get(instance.pluginId);
      if (group) group.push(instance);
      else byPlugin.set(instance.pluginId, [instance]);
    }
    await Promise.all(Array.from(byPlugin, async ([pluginId, pluginInstances]) => {
      try {
        const localization = await host.loadLocalization(pluginId, locale);
        if (disposed || refreshEpoch !== localeEpoch || locale !== activeLocale()) return;
        for (const instance of pluginInstances) {
          if (!instance.disposed && instances.has(instance)) {
            instance.sandbox.updateLocalization(localization);
          }
        }
      } catch (_) {}
    }));
  }

  function refreshThemes(): void {
    if (disposed) return;
    const snapshot = theme.snapshot();
    for (const instance of instances) {
      if (!instance.disposed) instance.sandbox.updateTheme(snapshot);
    }
  }

  function init(): void {
    if (disposed) throw new Error('Document view service has been disposed.');
    if (initialized) return;
    initialized = true;
    try {
      subscriptions.push(contributions.onDidChange(handleContributionChange));
      const localeSubscription = asDisposable(i18n.onChange?.(() => {
        void refreshLocalizations();
      }));
      if (localeSubscription) subscriptions.push(localeSubscription);
      const themeSubscription = asDisposable(theme.onChange?.(refreshThemes));
      if (themeSubscription) subscriptions.push(themeSubscription);
    } catch (error) {
      initialized = false;
      subscriptions.splice(0).reverse().forEach((subscription) => {
        try { subscription.dispose(); } catch (_) {}
      });
      throw error;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    creationEpoch += 1;
    localeEpoch += 1;
    pendingByPath.clear();
    subscriptions.splice(0).reverse().forEach((subscription) => {
      try { subscription.dispose(); } catch (_) {}
    });
    disposeAllInstances();
  }

  return Object.freeze({
    init,
    find,
    create,
    show,
    hideAll,
    disposeTab,
    disposeAll,
    refreshLocalizations,
    dispose
  });
}
