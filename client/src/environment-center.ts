// src/environment-center.ts - Project environment diagnosis and action workflow.
import type {
  EnvironmentCenterActionDto,
  EnvironmentCenterDependencies,
  EnvironmentCenterRefreshOptionsDto,
  EnvironmentCenterRuntimeDefinitionDto,
  EnvironmentCenterService,
  EnvironmentHealthDto,
  EnvironmentServerEnvelopeDto,
  EnvironmentViewStateDto,
  ProjectEnvironmentActionDto,
  ProjectEnvironmentActionRequestDto,
  ProjectEnvironmentCapabilityDto,
  ProjectEnvironmentManifestDto,
  ProjectEnvironmentRepairPlanDto,
  ProjectEnvironmentRequestContextDto,
  ProjectEnvironmentSnapshotDto,
  ProjectEnvironmentWireDto
} from '../types/environment-center';
import type { Disposable, Dispose } from '../types/lifecycle';
import {
  canonicalLanguage,
  dependencyIssueRows,
  environmentHealthValue,
  environmentManifestRule,
  environmentPathName,
  environmentTranslate,
  healthFallbackDetail,
  languageMatchesRuntime,
  localizedDependencyReason,
  localizedDynamicText,
  mergeEnvironmentActivity,
  mergeLiveDependencyDiagnostics,
  mergeServerSnapshot,
  normalizeHealth,
  packageIdentity,
  recognizeManifests,
  unresolvedPythonImport
} from './environment-center-model';

export {
  canonicalLanguage,
  dependencyIssueRows,
  healthFallbackDetail,
  languageMatchesRuntime,
  localizedDependencyReason,
  localizedDynamicText,
  mergeLiveDependencyDiagnostics,
  mergeServerSnapshot,
  normalizeHealth,
  packageIdentity,
  recognizeManifests,
  unresolvedPythonImport
} from './environment-center-model';

export const ENVIRONMENT_CENTER_SERVICE_ID = 'workbench.environmentCenter' as const;

interface OperationIntent {
  readonly epoch: number;
  readonly identity: string;
}

interface FileEventLike {
  readonly path?: unknown;
  readonly filePath?: unknown;
  readonly name?: unknown;
}

interface WorkbenchChangeEvent extends Event {
  readonly detail?: { readonly activity?: unknown };
}

type EnvironmentListAction =
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly displayName: string;
    }
  | {
      readonly kind: 'package';
      readonly name: string;
      readonly mode: 'installed' | 'discover';
    };

export function createEnvironmentCenterService(
  dependencies: EnvironmentCenterDependencies
): EnvironmentCenterService {
  const documentRef = dependencies.document;
  const S = dependencies.state;
  let initialized = false;
  let initializing = false;
  let disposed = false;
  let snapshot: ProjectEnvironmentSnapshotDto | null = null;
  let refreshTimer: number | null = null;
  let refreshSequence = 0;
  let refreshPromise: Promise<ProjectEnvironmentSnapshotDto | null> | null = null;
  let refreshQueued = false;
  let busyAction: EnvironmentCenterActionDto | '' = '';
  let manifestPaths = Object.create(null) as Record<string, string>;
  let localManifestCache: ProjectEnvironmentManifestDto[] | null = null;
  let localManifestWorkspace = '';
  let fileEventUnsubscribe: Dispose | null = null;
  let markerEventDisposable: Disposable | null = null;
  let activityUnsubscribe: Dispose | null = null;
  let lastWorkbenchActivity = '';
  let lifecycleEpoch = 0;
  let actionSequence = 0;
  const buttonDisposers: Dispose[] = [];
  const waitTimers = new Map<number, () => void>();
  const rowActions = new WeakMap<HTMLElement, EnvironmentListAction>();

  function t(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    return environmentTranslate(dependencies.getI18n(), source, replacements);
  }

  function byId(id: string): HTMLElement | null {
    return documentRef.getElementById(id);
  }

  function currentLanguage(): string {
    const tab = (S.tabs || []).find((item) => item.path === S.activeTabPath);
    if (tab && tab.language && tab.language !== 'image') return String(tab.language);
    const model = S.editor && typeof S.editor.getModel === 'function' ? S.editor.getModel() : null;
    return model && typeof model.getLanguageId === 'function' ? String(model.getLanguageId() || '') : '';
  }

  function runtimeDefinition(runtimeId: string): EnvironmentCenterRuntimeDefinitionDto | null {
    return (S.availableRuntimes || []).find((runtime) => (
      runtime && String(runtime.runtimeId || '') === runtimeId
    )) || null;
  }

  function localSnapshot(manifests: readonly ProjectEnvironmentManifestDto[]): ProjectEnvironmentSnapshotDto {
    const language = currentLanguage();
    const runtimeId = String(S.selectedRuntime || '');
    const runtime = runtimeDefinition(runtimeId);
    const lspPort = dependencies.getLsp();
    const lsp = lspPort && typeof lspPort.getStatus === 'function' ? lspPort.getStatus() : {};
    const dependency = lsp.dependency || {};
    const runtimeMatch = runtimeId ? languageMatchesRuntime(language, runtime || { runtimeId }) : null;
    const lspHealth: EnvironmentHealthDto = lsp.state === 'ready' ? 'ready' : (lsp.state === 'starting' || lsp.state === 'connecting' ? 'busy' : (lsp.state === 'local' ? 'warning' : 'error'));
    let dependencyHealth = normalizeHealth(dependency.status);
    if (!dependency.status && manifests.length === 0) dependencyHealth = 'ready';
    const overall = [lspHealth, runtimeMatch === false ? 'error' : (runtimeMatch === true ? 'ready' : 'warning'), dependencyHealth].indexOf('error') >= 0
      ? 'error'
      : ([lspHealth, runtimeMatch === true ? 'ready' : 'warning', dependencyHealth].indexOf('warning') >= 0 ? 'warning' : 'ready');
    const current = S.collaboration && S.collaboration.current;
    const workspaceRoot = String(S.workspaceRoot || '');
    const projectName = String(current && (current.projectName || current.name) || environmentPathName(workspaceRoot) || t('Current project'));
    const folderKey = dependencies.projectKey(workspaceRoot);
    return {
      schema: 'project-environment/v1',
      source: 'local',
      checkedAt: new Date(dependencies.now()).toISOString(),
      workspace: {
        kind: current ? 'team' : 'personal',
        id: current ? String(current.projectId || '') : folderKey,
        name: projectName,
        key: folderKey,
        teamId: String(current && current.teamId || ''),
        projectId: String(current && current.projectId || ''),
        branch: String(current && current.branch || '')
      },
      language: { id: language || 'plaintext', source: 'editor' },
      runtime: {
        id: runtimeId || 'local',
        language: String(runtime && runtime.language || ''),
        version: String(runtime && runtime.version || ''),
        image: String(runtime && (runtime.dockerImage || runtime.image) || (runtimeId ? '' : t('Local runtime'))),
        displayName: String(runtime && runtime.displayName || runtimeId || t('Local runtime')),
        status: runtimeMatch === false ? 'mismatch' : (runtimeMatch === true ? 'ready' : 'unknown')
      },
      manifests: [...manifests],
      packages: { declared: [], installed: [], missing: [], unknown: [] },
      dependencyCache: { scope: 'local', status: 'unavailable' },
      consistency: {
        status: overall,
        languageRuntime: { status: runtimeMatch === false ? 'mismatch' : (runtimeMatch === true ? 'ready' : 'unknown'), detail: runtimeMatch === false ? t('Selected runtime does not match the active language.') : (runtimeMatch === true ? t('Runtime matches the active language.') : t('Select a cloud runtime to verify compatibility.')) },
        dependencyRuntime: { status: dependencyHealth, detail: String(dependency.detail || (manifests.length ? t('Dependency files detected; package versions require cloud verification.') : t('No dependency files detected.'))) },
        lspDependencies: { status: lspHealth, detail: lsp.state === 'ready' ? t('Language service is ready.') : (lsp.state === 'local' ? t('Local code intelligence is active.') : String(lsp.error || t('Language service is not ready.'))) }
      },
      activity: {},
      actions: {
        refreshIndex: { supported: Boolean(lspPort && lsp.state === 'ready') },
        clearCache: { supported: Boolean(lspPort && S.workspaceRoot), scope: 'workspace' },
        repair: { supported: false, requiresConfirmation: true, reason: t('Cloud environment diagnostics are required before repair.') },
        rebuild: { supported: false, requiresConfirmation: true, reason: t('Cloud environment diagnostics are required before rebuild.') }
      }
    };
  }

  function requestContext(): ProjectEnvironmentRequestContextDto {
    const current = S.collaboration && S.collaboration.current;
    const language = currentLanguage();
    const workspaceRoot = String(S.workspaceRoot || '');
    return {
      folderName: environmentPathName(workspaceRoot),
      folderKey: dependencies.projectKey(workspaceRoot),
      runtime: String(S.selectedRuntime || ''),
      language,
      teamId: String(current && current.teamId || ''),
      projectId: String(current && current.projectId || ''),
      branch: String(current && current.branch || ''),
      setupCommands: Array.isArray(S.setupCommands) ? S.setupCommands.slice() : []
    };
  }

  async function readLocalManifests(): Promise<ProjectEnvironmentManifestDto[]> {
    const workspaceRoot = String(S.workspaceRoot || '');
    const nativeHost = dependencies.getNativeHost();
    if (!workspaceRoot || !nativeHost || typeof nativeHost.readTree !== 'function') return [];
    if (localManifestCache && localManifestWorkspace === workspaceRoot) return localManifestCache.slice();
    try {
      const tree = await nativeHost.readTree(workspaceRoot);
      if (workspaceRoot !== String(S.workspaceRoot || '') || nativeHost !== dependencies.getNativeHost()) return [];
      localManifestWorkspace = workspaceRoot;
      localManifestCache = recognizeManifests(tree, workspaceRoot);
      return localManifestCache.slice();
    } catch (_) {
      return [];
    }
  }

  function extractResponseData(
    response: EnvironmentServerEnvelopeDto<ProjectEnvironmentWireDto> | null | undefined
  ): ProjectEnvironmentWireDto | null {
    if (!response || response.success === false) return null;
    const value = response.data && typeof response.data === 'object' ? response.data : response;
    if (!value || typeof value !== 'object') return null;
    const source = value as Partial<ProjectEnvironmentWireDto>;
    return source.schema === 'project-environment/v1' ? source as ProjectEnvironmentWireDto : null;
  }

  function currentLocalActivity() {
    const activity = dependencies.getEnvironmentActivity();
    try {
      return activity && typeof activity.read === 'function' ? activity.read() : {};
    } catch (_) {
      return {};
    }
  }

  async function fetchSnapshot(
    intent: OperationIntent
  ): Promise<ProjectEnvironmentSnapshotDto | null> {
    const manifests = await readLocalManifests();
    if (!isIntentCurrent(intent)) return null;
    const discovered = localSnapshot(manifests);
    const local: ProjectEnvironmentSnapshotDto = {
      ...discovered,
      activity: mergeEnvironmentActivity(discovered.activity, currentLocalActivity())
    };
    if (!S.serverSettings || !S.serverSettings.ip) return local;
    try {
      const response = await dependencies.sendToServer('getProjectEnvironment', requestContext(), { quiet: true });
      if (!isIntentCurrent(intent)) return null;
      const remote = extractResponseData(response);
      const lsp = dependencies.getLsp();
      const lspStatus = lsp && typeof lsp.getStatus === 'function' ? lsp.getStatus() : {};
      return remote ? mergeServerSnapshot(local, remote, {
        localization: dependencies.getI18n(),
        lspStatus,
        localActivity: currentLocalActivity()
      }) : local;
    } catch (_) {
      return local;
    }
  }

  function setVisibleState(name: EnvironmentViewStateDto, message?: string): void {
    (['empty', 'loading', 'error', 'ready'] as const).forEach((state) => {
      const element = byId('environment-center-' + state);
      if (element) element.hidden = state !== name;
    });
    const error = byId('environment-center-error-message');
    if (error && message) error.textContent = message;
  }

  function statusLabel(status: EnvironmentHealthDto): string {
    const labels: Readonly<Record<EnvironmentHealthDto, string>> = { ready: t('Healthy'), warning: t('Needs attention'), error: t('Issue detected'), busy: t('In progress'), unknown: t('Not checked') };
    return labels[status] || labels.unknown;
  }

  function renderHealth(id: string, value: unknown, fallbackDetail: string): void {
    const normalized = environmentHealthValue(value);
    const row = byId('environment-health-' + id);
    const state = byId('environment-health-' + id + '-state');
    const detail = byId('environment-health-' + id + '-detail');
    if (row) row.dataset.health = normalized.status;
    if (state) state.textContent = statusLabel(normalizeHealth(normalized.status));
    if (detail) detail.textContent = localizedDynamicText(
      normalized.detail,
      healthFallbackDetail(id, normalized.status, fallbackDetail, dependencies.getI18n()),
      dependencies.getI18n()
    ) || '--';
  }

  function createListRow(
    primary: unknown,
    secondary: unknown,
    meta: unknown,
    status: string,
    localPath: string
  ): HTMLElement {
    const row = documentRef.createElement(localPath ? 'button' : 'div');
    row.className = 'environment-list-row';
    row.setAttribute('role', 'listitem');
    if (status) row.dataset.status = status;
    if (localPath) {
      (row as HTMLButtonElement).type = 'button';
      row.classList.add('environment-list-link');
      rowActions.set(row, {
        kind: 'file',
        path: localPath,
        displayName: environmentPathName(localPath)
      });
    }
    const icon = documentRef.createElement('span');
    icon.className = 'environment-list-icon';
    icon.textContent = status === 'missing' ? '!' : (status === 'warning' ? '?' : '#');
    icon.setAttribute('aria-hidden', 'true');
    const copy = documentRef.createElement('span');
    copy.className = 'environment-list-copy';
    const strong = documentRef.createElement('strong');
    strong.textContent = String(primary || '--');
    const small = documentRef.createElement('small');
    small.textContent = String(secondary || '');
    copy.append(strong, small);
    const suffix = documentRef.createElement('span');
    suffix.className = 'environment-list-meta';
    suffix.textContent = String(meta || '');
    row.append(icon, copy, suffix);
    return row;
  }

  function makePackageCenterLink(
    row: HTMLElement,
    packageName: string,
    mode: 'installed' | 'discover'
  ): HTMLElement {
    if (!row || !packageName) return row;
    row.classList.add('environment-list-actionable');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', t('Manage {name} in Library Center', { name: packageName }));
    rowActions.set(row, { kind: 'package', name: packageName, mode: mode || 'discover' });
    return row;
  }

  function delegatedRow(event: Event): HTMLElement | null {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return null;
    const row = target.closest(
      '.environment-list-link, .environment-list-actionable'
    ) as HTMLElement | null;
    const center = byId('environment-center');
    return row && center?.contains(row) ? row : null;
  }

  function activateDelegatedRow(row: HTMLElement): void {
    const action = rowActions.get(row);
    if (!action) return;
    if (action.kind === 'package') {
      const packageCenter = dependencies.getPackageCenter();
      if (packageCenter && typeof packageCenter.open === 'function') {
        packageCenter.open({ query: action.name, mode: action.mode });
      }
      return;
    }
    const workspace = dependencies.getWorkspace();
    if (workspace && typeof workspace.openFile === 'function') {
      workspace.openFile(action.path, action.displayName);
    }
  }

  function onDelegatedRowClick(event: Event): void {
    const row = delegatedRow(event);
    if (row) activateDelegatedRow(row);
  }

  function onDelegatedRowKeydown(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
    const row = delegatedRow(event);
    // Manifest rows are native buttons and synthesize their own click.
    if (!row || rowActions.get(row)?.kind !== 'package') return;
    keyboardEvent.preventDefault();
    activateDelegatedRow(row);
  }

  function localPathForManifest(manifest: ProjectEnvironmentManifestDto): string {
    if (manifest && manifest.localPath) return manifest.localPath;
    const relative = String(manifest && manifest.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relative || relative.split('/').some((part) => part === '..')) return '';
    const knownPath = manifestPaths[relative.toLowerCase()];
    if (knownPath) return knownPath;
    const separator = String(S.workspaceRoot || '').indexOf('\\') >= 0 ? '\\' : '/';
    return String(S.workspaceRoot || '').replace(/[\\/]+$/, '') + separator + relative.replace(/\//g, separator);
  }

  function renderList<Value>(
    listId: string,
    emptyId: string,
    countId: string,
    input: readonly Value[] | null | undefined,
    builder: (value: Value) => HTMLElement
  ): void {
    const list = byId(listId);
    const empty = byId(emptyId);
    const count = byId(countId);
    const values = Array.isArray(input) ? input : [];
    if (list) {
      const fragment = documentRef.createDocumentFragment();
      values.forEach((value) => { fragment.appendChild(builder(value)); });
      list.replaceChildren(fragment);
    }
    if (empty) empty.hidden = values.length > 0;
    if (count) count.textContent = String(values.length);
  }

  function formatTime(value: unknown): string {
    const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
    if (!Number.isFinite(timestamp) || timestamp <= 0) return t('No activity yet');
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(timestamp)); }
    catch (_) { return new Date(timestamp).toLocaleString(); }
  }

  function actionDescriptor(name: EnvironmentCenterActionDto): ProjectEnvironmentCapabilityDto {
    const actions = snapshot?.actions;
    if (!actions) return {};
    if (name === 'refresh') return actions.refreshIndex || {};
    if (name === 'clear') return actions.clearCache || {};
    return actions[name] || {};
  }

  function renderActions(): void {
    const defaultTitles: Readonly<Record<EnvironmentCenterActionDto, string>> = {
      repair: t('Repair detected environment issues'),
      rebuild: t('Rebuild environment'),
      refresh: t('Refresh index'),
      clear: t('Clear environment cache')
    };
    (['repair', 'rebuild', 'refresh', 'clear'] as const).forEach((name) => {
      const button = byId('environment-action-' + name) as HTMLButtonElement | null;
      if (!button) return;
      const descriptor = actionDescriptor(name);
      const supported = descriptor.supported === true;
      button.disabled = Boolean(busyAction) || !supported;
      const reason = descriptor.reason
        ? t(descriptor.reason)
        : (!supported ? t('This action is not available for the current environment.') : '');
      button.title = reason || defaultTitles[name];
    });
    const center = byId('environment-center');
    const busy = byId('environment-center-busy');
    if (center) center.setAttribute('aria-busy', busyAction ? 'true' : 'false');
    if (busy) busy.hidden = !busyAction;
  }

  function setText(id: string, value: unknown): void {
    const element = byId(id);
    if (element) element.textContent = String(value ?? '');
  }

  function render(value: ProjectEnvironmentSnapshotDto | null): void {
    snapshot = value;
    if (!S.workspaceRoot) {
      setVisibleState('empty');
      return;
    }
    if (!value) {
      setVisibleState('loading');
      return;
    }
    const matcher = dependencies.getTaskProblemMatcher();
    const problems = matcher && typeof matcher.getAllProblems === 'function'
      ? matcher.getAllProblems()
      : [];
    const renderedValue = mergeLiveDependencyDiagnostics(
      value,
      problems,
      dependencies.getI18n()
    ) || value;
    setVisibleState('ready');
    manifestPaths = Object.create(null) as Record<string, string>;
    for (const item of renderedValue.manifests || []) {
      if (item?.path && item.localPath) manifestPaths[String(item.path).toLowerCase()] = item.localPath;
    }

    const projectName = renderedValue.workspace?.name
      || renderedValue.workspace?.id
      || environmentPathName(S.workspaceRoot);
    const language = renderedValue.language?.displayName
      || renderedValue.language?.id
      || currentLanguage()
      || '--';
    const runtime = renderedValue.runtime;
    const consistency = renderedValue.consistency;
    const overall = normalizeHealth(consistency.status || runtime.status);
    setText('environment-context-heading', projectName || t('Current project'));
    setText('environment-context-language', language);
    setText('environment-context-runtime', runtime.displayName || runtime.id || '--');
    setText('environment-context-image', runtime.image || t('Not reported'));
    setText(
      'environment-context-project',
      renderedValue.workspace.kind === 'team'
        ? [renderedValue.workspace.name || renderedValue.workspace.projectId, renderedValue.workspace.branch]
          .filter(Boolean)
          .join(' / ')
        : projectName
    );
    const dependencyCache = renderedValue.dependencyCache;
    const scopeLabels: Readonly<Record<string, string>> = {
      'project-lock': t('Project and lock digest'),
      'legacy-user': t('Legacy user cache'),
      local: t('Local runtime'),
      none: t('Not available')
    };
    const cacheStatusLabels: Readonly<Record<string, string>> = {
      hit: t('Cached'),
      miss: t('Not materialized'),
      legacy: t('Legacy'),
      error: t('Issue detected'),
      unavailable: t('Not available')
    };
    const dependencyScope = String(dependencyCache.scope || '');
    const cacheStatus = String(dependencyCache.status || '');
    setText(
      'environment-context-dependency-scope',
      scopeLabels[dependencyScope] || dependencyScope || t('Not reported')
    );
    setText(
      'environment-context-cache-status',
      cacheStatusLabels[cacheStatus] || cacheStatus || t('Not reported')
    );
    const dependencyDigest = byId('environment-context-dependency-digest');
    if (dependencyDigest) {
      const digest = dependencyCache.digest ? String(dependencyCache.digest).slice(0, 16) : '--';
      const source = dependencyCache.source ? t(String(dependencyCache.source)) : '';
      dependencyDigest.textContent = [source, digest].filter(Boolean).join(' / ');
      dependencyDigest.title = dependencyCache.digest || '';
    }
    const overallElement = byId('environment-overall-status');
    if (overallElement) {
      overallElement.dataset.status = overall;
      overallElement.textContent = statusLabel(overall);
    }

    renderHealth('lsp', consistency.lspDependencies, t('Language service status is not available.'));
    renderHealth('runtime', consistency.languageRuntime || runtime.status, t('Runtime compatibility is not available.'));
    renderHealth('dependencies', consistency.dependencyRuntime, t('Dependency state is not available.'));

    renderList(
      'environment-manifest-list',
      'environment-manifest-empty',
      'environment-manifest-count',
      renderedValue.manifests,
      (item) => createListRow(
        item.path,
        [item.manager, item.kind].filter(Boolean).join(' / '),
        item.status === 'parsed' || item.parsed ? t('parsed') : t('detected'),
        '',
        localPathForManifest(item)
      )
    );
    renderList(
      'environment-installed-list',
      'environment-installed-empty',
      'environment-installed-count',
      renderedValue.packages.installed || [],
      (item) => makePackageCenterLink(
        createListRow(item.name, [item.source, item.scope].filter(Boolean).join(' / '), item.version || '--', '', ''),
        item.name,
        'installed'
      )
    );
    const dependencyIssues = dependencyIssueRows(renderedValue.packages, renderedValue.language.id);
    renderList(
      'environment-missing-list',
      'environment-missing-empty',
      'environment-missing-count',
      dependencyIssues,
      (item) => makePackageCenterLink(
        createListRow(
          item.name,
          localizedDependencyReason(item, dependencies.getI18n()),
          item.constraint || (item._status === 'warning' ? t('verify') : t('missing')),
          item._status,
          ''
        ),
        item.name,
        'discover'
      )
    );

    setText('environment-activity-index-time', formatTime(renderedValue.activity.lastIndexedAt));
    setText('environment-activity-install-time', formatTime(renderedValue.activity.lastInstalledAt));
    setText('environment-activity-compile-time', formatTime(renderedValue.activity.lastCompiledAt));
    renderActions();
  }

  function contextIdentity(): string {
    const current = S.collaboration?.current;
    const user = S.auth?.user;
    const context = requestContext();
    return JSON.stringify([
      String(S.serverSettings?.ip || ''),
      String(S.auth?.token || ''),
      String(user?.id || user?.uid || user?.userId || ''),
      String(S.workspaceIdentity || ''),
      String(S.workspaceRoot || ''),
      context.folderKey,
      context.runtime,
      context.teamId || String(current?.teamId || ''),
      context.projectId || String(current?.projectId || ''),
      context.branch || String(current?.branch || ''),
      context.language,
      context.setupCommands
    ]);
  }

  function captureIntent(): OperationIntent {
    return { epoch: lifecycleEpoch, identity: contextIdentity() };
  }

  function isIntentCurrent(intent: OperationIntent): boolean {
    return !disposed
      && intent.epoch === lifecycleEpoch
      && intent.identity === contextIdentity();
  }

  function revisionIsCurrent(value: ProjectEnvironmentSnapshotDto): boolean {
    if (snapshot === value) return true;
    const revision = String(value.revision || '');
    return Boolean(revision) && String(snapshot?.revision || '') === revision;
  }

  async function refresh(
    options?: EnvironmentCenterRefreshOptionsDto | null
  ): Promise<ProjectEnvironmentSnapshotDto | null> {
    const refreshOptions = options || {};
    if (disposed) return null;
    if (refreshPromise) {
      const activeRefresh = refreshPromise;
      refreshQueued = true;
      await activeRefresh;
      if (refreshOptions.force === true && !disposed) {
        return refresh({ ...refreshOptions, force: false });
      }
      return snapshot;
    }
    const activeRefresh = performRefresh(refreshOptions);
    refreshPromise = activeRefresh;
    try {
      return await activeRefresh;
    } finally {
      if (refreshPromise === activeRefresh) {
        refreshPromise = null;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          scheduleRefresh('coalesced', 80);
        }
      }
    }
  }

  async function performRefresh(
    options: EnvironmentCenterRefreshOptionsDto
  ): Promise<ProjectEnvironmentSnapshotDto | null> {
    const sequence = ++refreshSequence;
    const intent = captureIntent();
    if (!S.workspaceRoot) {
      if (!isIntentCurrent(intent) || sequence !== refreshSequence) return null;
      snapshot = null;
      setVisibleState('empty');
      return null;
    }
    if (options.loading !== false && !snapshot) setVisibleState('loading');
    try {
      const value = await fetchSnapshot(intent);
      if (!value || !isIntentCurrent(intent) || sequence !== refreshSequence) return null;
      render(value);
      return value;
    } catch (error) {
      if (!isIntentCurrent(intent) || sequence !== refreshSequence) return null;
      if (snapshot) render(snapshot);
      else setVisibleState('error', errorMessage(error, t('Unknown error')));
      return null;
    }
  }

  function scheduleRefresh(reason = '', delay = 120): void {
    if (disposed) return;
    if (refreshTimer !== null) dependencies.clearTimer(refreshTimer);
    const epoch = lifecycleEpoch;
    refreshTimer = dependencies.setTimer(() => {
      refreshTimer = null;
      if (disposed || epoch !== lifecycleEpoch) return;
      const workbench = dependencies.getWorkbench();
      const state = workbench && typeof workbench.getState === 'function' ? workbench.getState() : {};
      if (state.activity === 'environment' || reason === 'workspace') {
        void refresh({ loading: !snapshot });
      }
    }, Math.max(0, Number(delay || 120)));
  }

  function busyLabel(name: EnvironmentCenterActionDto): string {
    const labels: Readonly<Record<EnvironmentCenterActionDto, string>> = {
      repair: t('Repairing environment...'),
      rebuild: t('Rebuilding environment...'),
      refresh: t('Refreshing analysis index...'),
      clear: t('Clearing environment cache...')
    };
    return labels[name] || t('Preparing environment action...');
  }

  function setBusy(name: EnvironmentCenterActionDto | ''): void {
    busyAction = name;
    const label = byId('environment-center-busy-label');
    if (label && name) label.textContent = busyLabel(name);
    renderActions();
  }

  function waitForIntent(delayMs: number, intent: OperationIntent): Promise<boolean> {
    if (!isIntentCurrent(intent)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: number | null = null;
      let settled = false;
      const settle = (current: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) waitTimers.delete(timer);
        resolve(current);
      };
      const createdTimer = dependencies.setTimer(() => settle(isIntentCurrent(intent)), delayMs);
      timer = createdTimer;
      if (settled) dependencies.clearTimer(createdTimer);
      else waitTimers.set(createdTimer, () => settle(false));
    });
  }

  function clearWaitTimers(): void {
    const pending = [...waitTimers.entries()];
    waitTimers.clear();
    for (const [timer, resolve] of pending) {
      dependencies.clearTimer(timer);
      resolve();
    }
  }

  async function waitForReady(
    timeoutMs: number,
    previousSessionId: unknown,
    intent: OperationIntent
  ): Promise<boolean> {
    const end = dependencies.now() + Number(timeoutMs || 20000);
    let observedTransition = false;
    while (dependencies.now() < end && isIntentCurrent(intent)) {
      const lsp = dependencies.getLsp();
      const status = lsp && typeof lsp.getStatus === 'function' ? lsp.getStatus() : {};
      if (status.state !== 'ready') observedTransition = true;
      if (
        status.state === 'ready'
        && (observedTransition || !previousSessionId || String(status.sessionId || '') !== String(previousSessionId))
      ) return true;
      if (!await waitForIntent(180, intent)) return false;
    }
    return false;
  }

  async function refreshAnalysisIndex(intent: OperationIntent): Promise<boolean> {
    const lsp = dependencies.getLsp();
    if (
      !lsp
      || typeof lsp.clearAnalysisCache !== 'function'
      || typeof lsp.restartAnalysis !== 'function'
    ) throw new Error(t('Remote analysis is not ready'));
    const previous = typeof lsp.getStatus === 'function' ? lsp.getStatus() : {};
    await lsp.clearAnalysisCache();
    if (!isIntentCurrent(intent)) return false;
    await lsp.restartAnalysis();
    if (!isIntentCurrent(intent)) return false;
    if (!await waitForReady(20000, previous.sessionId, intent)) {
      if (!isIntentCurrent(intent)) return false;
      throw new Error(t('Language service did not become ready in time.'));
    }
    const activity = dependencies.getEnvironmentActivity();
    if (activity && typeof activity.record === 'function') {
      activity.record('index', { outcome: 'completed' });
    }
    return true;
  }

  function actionPayload(
    name: ProjectEnvironmentActionDto,
    context: ProjectEnvironmentRequestContextDto,
    revision: string,
    planId?: string
  ): ProjectEnvironmentActionRequestDto {
    return {
      ...context,
      environmentAction: name,
      revision,
      ...(planId ? { planId } : {})
    };
  }

  function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return fallback;
  }

  function responseError(response: EnvironmentServerEnvelopeDto | null | undefined, fallback: string): string {
    return errorMessage(response?.error || response?.message, fallback);
  }

  async function clearEnvironmentCaches(
    intent: OperationIntent,
    operationSnapshot: ProjectEnvironmentSnapshotDto,
    context: ProjectEnvironmentRequestContextDto
  ): Promise<boolean> {
    const lsp = dependencies.getLsp();
    if (!lsp) throw new Error(t('Remote analysis is not ready'));
    if (typeof lsp.clearClientCache === 'function') await lsp.clearClientCache('workspace');
    if (!isIntentCurrent(intent) || !revisionIsCurrent(operationSnapshot)) return false;
    if (operationSnapshot.source === 'cloud') {
      const response = await dependencies.sendToServer(
        'applyProjectEnvironmentAction',
        actionPayload('clearCache', context, String(operationSnapshot.revision || '')),
        { quiet: true }
      );
      if (!isIntentCurrent(intent) || !revisionIsCurrent(operationSnapshot)) return false;
      if (!response || response.success === false) {
        throw new Error(responseError(response, t('Environment action failed.')));
      }
      return true;
    }
    const state = typeof lsp.getStatus === 'function' ? lsp.getStatus() : {};
    if (state.state === 'ready' && typeof lsp.clearAnalysisCache === 'function') {
      await lsp.clearAnalysisCache();
      return isIntentCurrent(intent) && revisionIsCurrent(operationSnapshot);
    }
    return true;
  }

  function planSteps(plan: ProjectEnvironmentRepairPlanDto): string[] {
    const steps = plan.steps || plan.operations || plan.actions;
    if (!Array.isArray(steps)) return [];
    return steps.slice(0, 12).map((step) => {
      if (typeof step === 'string') return step;
      return step && (step.label || step.description || step.kind || step.action) || '';
    }).filter(Boolean);
  }

  async function requestManagedAction(
    name: 'repair' | 'rebuild',
    intent: OperationIntent,
    operationSnapshot: ProjectEnvironmentSnapshotDto,
    context: ProjectEnvironmentRequestContextDto
  ): Promise<boolean> {
    const revision = String(operationSnapshot.revision || '');
    const planResponse = await dependencies.sendToServer(
      'planProjectEnvironmentRepair',
      actionPayload(name, context, revision),
      { quiet: true }
    );
    if (!isIntentCurrent(intent) || !revisionIsCurrent(operationSnapshot)) return false;
    if (!planResponse || planResponse.success === false) {
      throw new Error(responseError(planResponse, t('Environment action could not be planned.')));
    }
    const source = planResponse.data || planResponse.plan || planResponse;
    const plan = source && typeof source === 'object'
      ? source as ProjectEnvironmentRepairPlanDto
      : {};
    if (plan.supported !== true) throw new Error(plan.reason || t('No safe repair plan is available.'));
    const steps = planSteps(plan);
    if (steps.length === 0) throw new Error(plan.reason || t('No safe repair plan is available.'));
    const title = name === 'rebuild' ? t('Rebuild project environment?') : t('Repair project environment?');
    let message = name === 'rebuild'
      ? t('This recreates the selected runtime dependency environment and then verifies it again.')
      : t('The server will apply only the diagnosed dependency repairs and then verify the environment again.');
    message += '\n\n' + steps.map((step) => '• ' + step).join('\n');
    const confirm = dependencies.getConfirm();
    if (!confirm) throw new Error(t('Environment action failed.'));
    const confirmed = await confirm({
      title,
      message,
      confirmLabel: name === 'rebuild' ? t('Rebuild environment') : t('Repair issues'),
      danger: name === 'rebuild'
    });
    if (!confirmed) return false;
    if (!isIntentCurrent(intent) || !revisionIsCurrent(operationSnapshot)) return false;
    const apply = await dependencies.sendToServer(
      'applyProjectEnvironmentAction',
      actionPayload(name, context, revision, plan.planId || plan.id || ''),
      { quiet: true }
    );
    if (!isIntentCurrent(intent) || !revisionIsCurrent(operationSnapshot)) return false;
    if (!apply || apply.success === false) {
      throw new Error(responseError(apply, t('Environment action failed.')));
    }
    const activity = dependencies.getEnvironmentActivity();
    if (activity && typeof activity.record === 'function') {
      activity.record(name, { outcome: 'completed' });
    }
    const lsp = dependencies.getLsp();
    if (lsp && typeof lsp.dependenciesChanged === 'function') lsp.dependenciesChanged();
    return true;
  }

  async function runAction(name: EnvironmentCenterActionDto): Promise<void> {
    if (disposed || busyAction || !snapshot) return;
    const descriptor = actionDescriptor(name);
    if (descriptor.supported !== true) {
      const toast = dependencies.getToast();
      if (toast && typeof toast.error === 'function') {
        toast.error(descriptor.reason || t('This action is not available for the current environment.'));
      }
      return;
    }
    const intent = captureIntent();
    const operationSnapshot = snapshot;
    const context = requestContext();
    if (name === 'clear') {
      const confirm = dependencies.getConfirm();
      if (!confirm) return;
      const clear = await confirm({
        title: t('Clear environment cache?'),
        message: t('This clears the current workspace analysis and local completion caches. Installed dependencies are preserved.'),
        confirmLabel: t('Clear cache'),
        danger: true
      });
      if (!clear || !isIntentCurrent(intent) || !revisionIsCurrent(operationSnapshot)) return;
    }
    const action = ++actionSequence;
    setBusy(name);
    try {
      let completed = false;
      if (name === 'refresh') completed = await refreshAnalysisIndex(intent);
      else if (name === 'clear') completed = await clearEnvironmentCaches(intent, operationSnapshot, context);
      else completed = await requestManagedAction(name, intent, operationSnapshot, context);
      if (!completed || !isIntentCurrent(intent) || action !== actionSequence) return;
      const toast = dependencies.getToast();
      if (toast && typeof toast.success === 'function') {
        toast.success(
          name === 'clear'
            ? t('Environment cache cleared')
            : (name === 'refresh' ? t('Analysis index refreshed') : t('Environment action completed'))
        );
      }
      await refresh({ loading: false, force: true });
    } catch (error) {
      if (!isIntentCurrent(intent) || action !== actionSequence) return;
      const activity = dependencies.getEnvironmentActivity();
      if (
        (name === 'repair' || name === 'rebuild')
        && activity
        && typeof activity.record === 'function'
      ) activity.record(name, { outcome: 'failed' });
      const toast = dependencies.getToast();
      if (toast && typeof toast.error === 'function') {
        toast.error(errorMessage(error, t('Environment action failed.')));
      }
      await refresh({ loading: false, force: true });
    } finally {
      if (!disposed && action === actionSequence) setBusy('');
    }
  }

  function listen(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    type: string,
    listener: EventListener
  ): void {
    target.addEventListener(type, listener);
    buttonDisposers.push(() => target.removeEventListener(type, listener));
  }

  function bind(): void {
    const center = byId('environment-center');
    if (center) {
      listen(center, 'click', onDelegatedRowClick);
      listen(center, 'keydown', onDelegatedRowKeydown);
    }
    const retry = byId('environment-center-error-retry');
    if (retry) listen(retry, 'click', () => { void refresh({ loading: true }); });
    (['repair', 'rebuild', 'refresh', 'clear'] as const).forEach((name) => {
      const button = byId('environment-action-' + name);
      if (button) listen(button, 'click', () => { void runAction(name); });
    });
    listen(dependencies.events, 'bobo:workbench-changed', (source) => {
      const event = source as WorkbenchChangeEvent;
      const activity = String(event.detail?.activity || '');
      if (activity === 'environment' && lastWorkbenchActivity !== 'environment') {
        scheduleRefresh('view', 0);
      }
      lastWorkbenchActivity = activity;
    });
    listen(dependencies.events, 'bobo:workspace-changed', () => {
      snapshot = null;
      localManifestCache = null;
      localManifestWorkspace = '';
      refreshSequence += 1;
      scheduleRefresh('workspace', 0);
    });
    listen(dependencies.events, 'bobo:environment-changed', () => {
      snapshot = null;
      refreshSequence += 1;
      scheduleRefresh('environment-change', 0);
    });
    listen(dependencies.events, 'bobo:language-changed', () => {
      if (snapshot) render(snapshot);
    });
    const markerPort = dependencies.getMarkerPort();
    if (markerPort && typeof markerPort.onDidChangeMarkers === 'function') {
      markerEventDisposable = markerPort.onDidChangeMarkers(() => {
        if (!disposed && snapshot) render(snapshot);
      }) || null;
    }
    const activity = dependencies.getEnvironmentActivity();
    if (activity && typeof activity.subscribe === 'function') {
      activityUnsubscribe = activity.subscribe((event) => {
        if (event?.kind === 'context') {
          snapshot = null;
          refreshSequence += 1;
        }
        scheduleRefresh('activity', event?.kind === 'context' ? 80 : 180);
      });
    }
    const nativeHost = dependencies.getNativeHost();
    if (nativeHost && typeof nativeHost.onFileEvent === 'function') {
      fileEventUnsubscribe = nativeHost.onFileEvent((source) => {
        const event = source && typeof source === 'object' ? source as FileEventLike : {};
        const value = event.path || event.filePath || event.name || '';
        if (environmentManifestRule(String(value).replace(/\\/g, '/'))) {
          localManifestCache = null;
          scheduleRefresh('manifest', 180);
        }
      });
    }
  }

  function cleanupBindings(): void {
    for (const disposeListener of buttonDisposers.splice(0).reverse()) {
      try { disposeListener(); } catch (_) { /* Best-effort lifecycle cleanup. */ }
    }
    if (typeof activityUnsubscribe === 'function') {
      try { activityUnsubscribe(); } catch (_) { /* Best-effort lifecycle cleanup. */ }
    }
    activityUnsubscribe = null;
    if (typeof fileEventUnsubscribe === 'function') {
      try { fileEventUnsubscribe(); } catch (_) { /* Best-effort lifecycle cleanup. */ }
    }
    fileEventUnsubscribe = null;
    if (markerEventDisposable && typeof markerEventDisposable.dispose === 'function') {
      try { markerEventDisposable.dispose(); } catch (_) { /* Best-effort lifecycle cleanup. */ }
    }
    markerEventDisposable = null;
  }

  function init(): void {
    if (initialized || initializing) return;
    initializing = true;
    disposed = false;
    const epoch = ++lifecycleEpoch;
    try {
      const workbench = dependencies.getWorkbench();
      const workbenchState = workbench && typeof workbench.getState === 'function'
        ? workbench.getState()
        : {};
      if (disposed || epoch !== lifecycleEpoch) return;
      lastWorkbenchActivity = String(workbenchState.activity || '');
      bind();
      if (disposed || epoch !== lifecycleEpoch) {
        cleanupBindings();
        return;
      }
      initialized = true;
      if (S.workspaceRoot) scheduleRefresh('workspace', 0);
      else setVisibleState('empty');
    } catch (error) {
      cleanupBindings();
      initialized = false;
      lifecycleEpoch += 1;
      disposed = true;
      throw error;
    } finally {
      initializing = false;
    }
  }

  function dispose(): void {
    if (disposed && !initialized && !initializing) return;
    disposed = true;
    initialized = false;
    initializing = false;
    lifecycleEpoch += 1;
    refreshSequence += 1;
    actionSequence += 1;
    refreshQueued = false;
    refreshPromise = null;
    if (refreshTimer !== null) {
      dependencies.clearTimer(refreshTimer);
      refreshTimer = null;
    }
    clearWaitTimers();
    cleanupBindings();
    localManifestCache = null;
    localManifestWorkspace = '';
    busyAction = '';
    const center = byId('environment-center');
    const busy = byId('environment-center-busy');
    if (center) center.setAttribute('aria-busy', 'false');
    if (busy) busy.hidden = true;
  }

  return Object.freeze({
    get disposed(): boolean { return disposed; },
    init,
    refresh,
    scheduleRefresh,
    runAction,
    getSnapshot: () => snapshot,
    getRequestContext: requestContext,
    dispose
  });
}
