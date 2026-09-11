// Single owner for the application shell and region geometry.
//
// The renderer still exposes a small BOBO compatibility facade, but all shell
// state and listeners are owned by this disposable service.  Keeping the DOM
// and legacy globals behind injected ports makes the layout slice independently
// type-checkable without changing its lazy initialization semantics.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
import type { RendererState } from '../types/state';
import type {
  WorkbenchAiAgentButtonPort,
  WorkbenchAiChatPanelPort,
  WorkbenchApplyOptionsDto,
  WorkbenchAuxiliaryOptionsDto,
  WorkbenchCollaborationCurrentDto,
  WorkbenchCollaborationPort,
  WorkbenchCommandsPort,
  WorkbenchFileSearchPort,
  WorkbenchLayoutDependencies,
  WorkbenchLayoutEditorPort,
  WorkbenchLayoutFacade,
  WorkbenchLayoutService,
  WorkbenchPersistentStateDto,
  WorkbenchLayoutSnapshotDto,
  WorkbenchLayoutStateDto,
  WorkbenchProjectsPort,
  WorkbenchSettingsPort,
  WorkbenchSwitchPanelPort,
  WorkbenchTerminalPort
} from '../types/workbench-layout';

export const WORKBENCH_LAYOUT_SERVICE_ID = 'workbench.layout';
export const WORKBENCH_LAYOUT_STORAGE_KEY = 'bobocloud.workbench.v1';

export const STATIC_PRIMARY_VIEWS = Object.freeze([
  'explorer',
  'search',
  'cloud',
  'environment',
  'team',
  'extensions'
] as const);

export const WORKBENCH_LAYOUT_DEFAULTS: Readonly<WorkbenchLayoutStateDto> = Object.freeze({
  activity: 'explorer',
  primaryVisible: true,
  sidebarWidth: 260,
  panelVisible: true,
  panelPosition: 'bottom',
  panelSize: 190,
  rightPanelSize: 360,
  density: 'comfortable',
  chatWidth: 350,
  panelMaximized: false,
  focusMode: false
});

type WorkbenchMutableState = {
  -readonly [Key in keyof WorkbenchLayoutStateDto]: WorkbenchLayoutStateDto[Key];
} & {
  [key: string]: unknown;
};

interface ResizeSession {
  readonly kind: 'sidebar' | 'panel' | 'ai';
  readonly target: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  readonly sidebarWidth: number;
  readonly panelSize: number;
  readonly rightPanelSize: number;
  readonly chatWidth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLayoutEditor(value: unknown): value is WorkbenchLayoutEditorPort {
  return isRecord(value) && typeof value.layout === 'function';
}

function isPrimaryViewId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9:._-]{0,239}$/.test(value);
}

function copyDefaults(): WorkbenchMutableState {
  return {
    activity: WORKBENCH_LAYOUT_DEFAULTS.activity,
    primaryVisible: WORKBENCH_LAYOUT_DEFAULTS.primaryVisible,
    sidebarWidth: WORKBENCH_LAYOUT_DEFAULTS.sidebarWidth,
    panelVisible: WORKBENCH_LAYOUT_DEFAULTS.panelVisible,
    panelPosition: WORKBENCH_LAYOUT_DEFAULTS.panelPosition,
    panelSize: WORKBENCH_LAYOUT_DEFAULTS.panelSize,
    rightPanelSize: WORKBENCH_LAYOUT_DEFAULTS.rightPanelSize,
    density: WORKBENCH_LAYOUT_DEFAULTS.density,
    chatWidth: WORKBENCH_LAYOUT_DEFAULTS.chatWidth,
    panelMaximized: WORKBENCH_LAYOUT_DEFAULTS.panelMaximized,
    focusMode: WORKBENCH_LAYOUT_DEFAULTS.focusMode
  };
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

function sanitize(raw: unknown): WorkbenchMutableState {
  const value = copyDefaults();
  const record = isRecord(raw) ? raw : {};
  value.activity = STATIC_PRIMARY_VIEWS.includes(record.activity as typeof STATIC_PRIMARY_VIEWS[number])
    ? record.activity as string
    : value.activity;
  value.primaryVisible = record.primaryVisible !== false;
  value.sidebarWidth = numberInRange(record.sidebarWidth, value.sidebarWidth, 180, 520);
  value.panelVisible = record.panelVisible !== false;
  value.panelPosition = record.panelPosition === 'right' ? 'right' : 'bottom';
  value.panelSize = numberInRange(record.panelSize, value.panelSize, 96, 700);
  value.rightPanelSize = numberInRange(record.rightPanelSize, value.rightPanelSize, 280, 760);
  value.density = record.density === 'compact' ? 'compact' : 'comfortable';
  value.chatWidth = numberInRange(record.chatWidth, value.chatWidth, 260, 640);
  return value;
}

export function createWorkbenchLayoutService(
  dependencies: WorkbenchLayoutDependencies
): WorkbenchLayoutService {
  const state = dependencies.state;
  const lifecycle = new DisposableStore();
  const dynamicPrimaryViews = new Set<string>();
  let layout: HTMLElement | null = null;
  let menu: HTMLElement | null = null;
  let initialized = false;
  let disposed = false;
  let resizeSession: ResizeSession | null = null;
  let saveTimer: number | null = null;
  let editorLayoutTimer: number | null = null;
  let editorFrameOne: number | null = null;
  let editorFrameTwo: number | null = null;
  let teamRevealFrame: number | null = null;
  let contextObserver: MutationObserver | null = null;

  function report(error: unknown): void {
    try {
      dependencies.reportError(error);
    } catch (_) {
      // Error observers cannot interrupt the layout service.
    }
  }

  function listen(
    target: EventTarget,
    type: string,
    listener: (event: Event) => void
  ): void {
    const registered = listener as EventListener;
    target.addEventListener(type, registered);
    lifecycle.add(toDisposable(() => target.removeEventListener(type, registered)));
  }

  function load(): WorkbenchMutableState {
    try {
      const serialized = dependencies.storage?.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) || '{}';
      return sanitize(JSON.parse(serialized));
    } catch (_) {
      return copyDefaults();
    }
  }

  const workbenchState = load();
  // `RendererState` keeps its open-ended compatibility fields readonly so
  // consumers cannot accidentally replace them.  The layout service owns the
  // one legacy slot it initializes, so narrow that write at this boundary.
  const legacyState = state as RendererState & { workbench?: WorkbenchMutableState };
  legacyState.workbench = workbenchState;

  function persistentState(): WorkbenchPersistentStateDto {
    return {
      activity: workbenchState.activity,
      primaryVisible: workbenchState.primaryVisible,
      sidebarWidth: workbenchState.sidebarWidth,
      panelVisible: workbenchState.panelVisible,
      panelPosition: workbenchState.panelPosition,
      panelSize: workbenchState.panelSize,
      rightPanelSize: workbenchState.rightPanelSize,
      density: workbenchState.density,
      chatWidth: workbenchState.chatWidth
    };
  }

  function persistSoon(immediate = false): void {
    if (disposed) return;
    if (saveTimer !== null) {
      dependencies.clearTimer(saveTimer);
      saveTimer = null;
    }
    const save = (): void => {
      saveTimer = null;
      if (disposed) return;
      try {
        dependencies.storage?.setItem(
          WORKBENCH_LAYOUT_STORAGE_KEY,
          JSON.stringify(persistentState())
        );
      } catch (_) {}
    };
    if (immediate) save();
    else saveTimer = dependencies.setTimer(save, 100);
  }

  function clampToViewport(): void {
    if (!layout) return;
    const rect = layout.getBoundingClientRect();
    workbenchState.sidebarWidth = numberInRange(
      workbenchState.sidebarWidth,
      WORKBENCH_LAYOUT_DEFAULTS.sidebarWidth,
      180,
      Math.max(180, Math.min(520, rect.width * 0.46))
    );
    workbenchState.panelSize = numberInRange(
      workbenchState.panelSize,
      WORKBENCH_LAYOUT_DEFAULTS.panelSize,
      96,
      Math.max(96, rect.height * 0.72)
    );
    workbenchState.rightPanelSize = numberInRange(
      workbenchState.rightPanelSize,
      WORKBENCH_LAYOUT_DEFAULTS.rightPanelSize,
      280,
      Math.max(280, Math.min(760, rect.width * 0.58))
    );
    workbenchState.chatWidth = numberInRange(
      workbenchState.chatWidth,
      WORKBENCH_LAYOUT_DEFAULTS.chatWidth,
      260,
      Math.max(260, Math.min(640, rect.width * 0.55))
    );
  }

  function layoutEditors(): void {
    const editors: unknown[] = [state.editor, state.splitEditor, state.diffEditor];
    editors.forEach((editor) => {
      if (!isLayoutEditor(editor)) return;
      try {
        editor.layout();
      } catch (_) {}
    });
  }

  function cancelEditorLayout(): void {
    if (editorFrameOne !== null && dependencies.cancelAnimationFrame) {
      dependencies.cancelAnimationFrame(editorFrameOne);
    }
    if (editorFrameTwo !== null && dependencies.cancelAnimationFrame) {
      dependencies.cancelAnimationFrame(editorFrameTwo);
    }
    editorFrameOne = null;
    editorFrameTwo = null;
    if (teamRevealFrame !== null && dependencies.cancelAnimationFrame) {
      dependencies.cancelAnimationFrame(teamRevealFrame);
    }
    teamRevealFrame = null;
    if (editorLayoutTimer !== null) {
      dependencies.clearTimer(editorLayoutTimer);
      editorLayoutTimer = null;
    }
  }

  function requestEditorLayout(): void {
    if (disposed) return;
    if (editorFrameOne !== null && dependencies.cancelAnimationFrame) {
      dependencies.cancelAnimationFrame(editorFrameOne);
    }
    if (editorFrameTwo !== null && dependencies.cancelAnimationFrame) {
      dependencies.cancelAnimationFrame(editorFrameTwo);
    }
    editorFrameTwo = null;
    editorFrameOne = dependencies.requestAnimationFrame(() => {
      editorFrameOne = null;
      if (disposed) return;
      editorFrameTwo = dependencies.requestAnimationFrame(() => {
        editorFrameTwo = null;
        if (!disposed) layoutEditors();
      });
    });
    if (editorLayoutTimer !== null) dependencies.clearTimer(editorLayoutTimer);
    editorLayoutTimer = dependencies.setTimer(() => {
      editorLayoutTimer = null;
      if (!disposed) layoutEditors();
    }, 240);
  }

  function getState(): WorkbenchLayoutSnapshotDto {
    const value = persistentState();
    return {
      activity: value.activity,
      primaryVisible: value.primaryVisible,
      sidebarWidth: value.sidebarWidth,
      panelVisible: value.panelVisible,
      panelPosition: value.panelPosition,
      panelSize: value.panelSize,
      rightPanelSize: value.rightPanelSize,
      density: value.density,
      chatWidth: value.chatWidth,
      panelMaximized: workbenchState.panelMaximized,
      focusMode: workbenchState.focusMode,
      auxiliaryVisible: Boolean(state.ai && state.ai.chatOpen)
    };
  }

  function emitChange(): void {
    if (disposed) return;
    try {
      dependencies.eventTarget.dispatchEvent(
        dependencies.createCustomEvent('bobo:workbench-changed', { detail: getState() })
      );
    } catch (_) {}
  }

  function renderPrimaryView(view: string): void {
    dependencies.document.querySelectorAll('[data-sidebar-view]').forEach((section) => {
      section.classList.toggle('active', section.getAttribute('data-sidebar-view') === view);
    });
  }

  function isPrimaryView(view: string): boolean {
    return STATIC_PRIMARY_VIEWS.includes(view as typeof STATIC_PRIMARY_VIEWS[number]) ||
      dynamicPrimaryViews.has(view);
  }

  function refreshControls(): void {
    if (disposed || !layout) return;
    const document = dependencies.document;
    document.querySelectorAll('[data-workbench-view]').forEach((button) => {
      const active = button.getAttribute('data-workbench-view') === workbenchState.activity;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-layout-toggle="primarySidebar"]').forEach((button) => {
      button.setAttribute('aria-checked', workbenchState.primaryVisible ? 'true' : 'false');
    });
    document.querySelectorAll('[data-layout-toggle="bottomPanel"]').forEach((button) => {
      button.setAttribute('aria-checked', workbenchState.panelVisible ? 'true' : 'false');
    });
    document.querySelectorAll('[data-layout-toggle="auxiliaryBar"]').forEach((button) => {
      button.setAttribute('aria-checked', state.ai && state.ai.chatOpen ? 'true' : 'false');
    });
    document.querySelectorAll('[data-layout-action="focus"]').forEach((button) => {
      button.setAttribute('aria-checked', workbenchState.focusMode ? 'true' : 'false');
    });
    document.querySelectorAll('button[data-panel-position]').forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        button.getAttribute('data-panel-position') === workbenchState.panelPosition ? 'true' : 'false'
      );
    });
    document.querySelectorAll('button[data-density]').forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        button.getAttribute('data-density') === workbenchState.density ? 'true' : 'false'
      );
    });

    const positionButton = document.getElementById('panel-position-toggle') as HTMLButtonElement | null;
    if (positionButton) {
      positionButton.title = workbenchState.panelPosition === 'bottom'
        ? 'Move panel to the right'
        : 'Move panel to the bottom';
    }
    const maximizeButton = document.getElementById('panel-maximize') as HTMLButtonElement | null;
    if (maximizeButton) {
      maximizeButton.title = workbenchState.panelMaximized ? 'Restore panel size' : 'Maximize panel';
    }

    const sidebarSetting = document.getElementById('settings-layout-sidebar') as HTMLInputElement | null;
    const panelSetting = document.getElementById('settings-layout-panel') as HTMLInputElement | null;
    const aiSetting = document.getElementById('settings-layout-ai') as HTMLInputElement | null;
    const positionSetting = document.getElementById('settings-panel-position') as HTMLSelectElement | null;
    const densitySetting = document.getElementById('settings-density') as HTMLSelectElement | null;
    if (sidebarSetting) sidebarSetting.checked = workbenchState.primaryVisible;
    if (panelSetting) panelSetting.checked = workbenchState.panelVisible;
    if (aiSetting) aiSetting.checked = Boolean(state.ai && state.ai.chatOpen);
    if (positionSetting) positionSetting.value = workbenchState.panelPosition;
    if (densitySetting) densitySetting.value = workbenchState.density;
    updateSeparatorAria();
  }

  function pathName(value: unknown): string {
    if (!value) return 'No folder opened';
    const stringValue = String(value);
    const parts = stringValue.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || stringValue;
  }

  function refreshContext(): void {
    if (disposed) return;
    const document = dependencies.document;
    const workspaceName = document.getElementById('sidebar-workspace-name');
    if (workspaceName) {
      workspaceName.textContent = pathName(state.workspaceRoot);
      workspaceName.title = state.workspaceRoot || '';
    }
    const sync = document.getElementById('cloud-view-sync') as HTMLButtonElement | null;
    if (sync) sync.disabled = !state.workspaceRoot;

    const current = state.collaboration?.current as WorkbenchCollaborationCurrentDto | null | undefined;
    const project = document.getElementById('team-sidebar-project');
    const branch = document.getElementById('team-sidebar-branch');
    const panel = document.getElementById('team-sidebar-panel') as HTMLButtonElement | null;
    if (project) {
      project.textContent = current
        ? String(current.teamName) + ' / ' + String(current.projectName)
        : 'Personal project';
    }
    if (branch) branch.textContent = current ? String(current.branch) : 'No team mapping';
    if (panel) panel.disabled = !current;
  }

  function updateSeparatorAria(): void {
    const document = dependencies.document;
    const sidebar = document.getElementById('sidebar-resizer');
    const panel = document.getElementById('output-resizer');
    const ai = document.getElementById('ai-chat-resizer');
    if (sidebar) sidebar.setAttribute('aria-valuenow', String(Math.round(workbenchState.sidebarWidth)));
    if (panel) {
      panel.setAttribute(
        'aria-orientation',
        workbenchState.panelPosition === 'bottom' ? 'horizontal' : 'vertical'
      );
      panel.setAttribute(
        'aria-valuenow',
        String(Math.round(
          workbenchState.panelPosition === 'bottom'
            ? workbenchState.panelSize
            : workbenchState.rightPanelSize
        ))
      );
    }
    if (ai) ai.setAttribute('aria-valuenow', String(Math.round(workbenchState.chatWidth)));
  }

  function apply(options: WorkbenchApplyOptionsDto | null = {}): void {
    if (disposed) return;
    options = options || {};
    if (!layout) layout = dependencies.document.getElementById('layout');
    if (!layout) return;
    clampToViewport();
    layout.classList.toggle('primary-sidebar-hidden', !workbenchState.primaryVisible);
    layout.classList.toggle('panel-hidden', !workbenchState.panelVisible);
    layout.classList.toggle(
      'panel-maximized',
      workbenchState.panelVisible && workbenchState.panelMaximized
    );
    layout.classList.toggle('focus-mode', workbenchState.focusMode);
    layout.setAttribute('data-panel-position', workbenchState.panelPosition);
    layout.setAttribute('data-density', workbenchState.density);
    layout.style.setProperty('--sidebar-width', workbenchState.sidebarWidth + 'px');
    const bottomPanelVisible = workbenchState.panelVisible &&
      !workbenchState.focusMode && workbenchState.panelPosition === 'bottom';
    layout.style.setProperty(
      '--workbench-panel-size',
      bottomPanelVisible ? workbenchState.panelSize + 'px' : '0px'
    );
    layout.style.setProperty('--workbench-right-panel-size', workbenchState.rightPanelSize + 'px');
    layout.style.setProperty('--chat-width', workbenchState.chatWidth + 'px');
    refreshControls();
    refreshContext();
    if (options.persist !== false) persistSoon(Boolean(options.immediate));
    if (options.layoutEditor !== false) requestEditorLayout();
    emitChange();
  }

  function setPrimaryVisible(visible: boolean): void {
    if (disposed) return;
    workbenchState.primaryVisible = Boolean(visible);
    if (workbenchState.primaryVisible) workbenchState.focusMode = false;
    apply();
  }

  function togglePrimary(): void {
    setPrimaryVisible(!workbenchState.primaryVisible);
  }

  function registerPrimaryView(view: string): Disposable {
    if (disposed) return toDisposable(() => {});
    if (!isPrimaryViewId(view)) throw new TypeError('Primary workbench view id is invalid.');
    dynamicPrimaryViews.add(view);
    refreshControls();
    return toDisposable(() => unregisterPrimaryView(view));
  }

  function unregisterPrimaryView(view: string): void {
    if (disposed || !dynamicPrimaryViews.delete(view)) return;
    if (workbenchState.activity === view) {
      workbenchState.activity = 'explorer';
      renderPrimaryView(workbenchState.activity);
      apply();
      return;
    }
    refreshControls();
  }

  function setPrimaryView(view: string): void {
    if (disposed || !isPrimaryView(view)) return;
    workbenchState.activity = view;
    workbenchState.primaryVisible = true;
    workbenchState.focusMode = false;
    renderPrimaryView(view);
    apply();
  }

  function setPanelVisible(visible: boolean): void {
    if (disposed) return;
    workbenchState.panelVisible = Boolean(visible);
    if (!workbenchState.panelVisible) workbenchState.panelMaximized = false;
    if (workbenchState.panelVisible) workbenchState.focusMode = false;
    apply();
  }

  function togglePanel(): void {
    setPanelVisible(!workbenchState.panelVisible);
  }

  function revealPanel(): void {
    if (disposed) return;
    if (!workbenchState.panelVisible || workbenchState.focusMode) {
      workbenchState.panelVisible = true;
      workbenchState.focusMode = false;
      apply();
    }
  }

  function ensureBottomPanelSize(minimumSize: number): void {
    if (disposed) return;
    if (workbenchState.panelPosition !== 'bottom') {
      revealPanel();
      return;
    }
    let requested = Number(minimumSize);
    if (!Number.isFinite(requested)) requested = WORKBENCH_LAYOUT_DEFAULTS.panelSize;
    workbenchState.panelSize = Math.max(workbenchState.panelSize, requested);
    workbenchState.panelVisible = true;
    workbenchState.focusMode = false;
    apply();
  }

  function setPanelPosition(position: string): void {
    if (disposed) return;
    workbenchState.panelPosition = position === 'right' ? 'right' : 'bottom';
    workbenchState.panelMaximized = false;
    workbenchState.panelVisible = true;
    workbenchState.focusMode = false;
    apply();
  }

  function togglePanelPosition(): void {
    setPanelPosition(workbenchState.panelPosition === 'bottom' ? 'right' : 'bottom');
  }

  function togglePanelMaximized(): void {
    if (disposed) return;
    workbenchState.panelVisible = true;
    workbenchState.focusMode = false;
    workbenchState.panelMaximized = !workbenchState.panelMaximized;
    apply({ persist: false });
  }

  function setDensity(density: string): void {
    if (disposed) return;
    workbenchState.density = density === 'compact' ? 'compact' : 'comfortable';
    apply();
  }

  function setFocusMode(enabled: boolean): void {
    if (disposed) return;
    workbenchState.focusMode = Boolean(enabled);
    workbenchState.panelMaximized = false;
    apply({ persist: false });
  }

  function toggleFocusMode(): void {
    setFocusMode(!workbenchState.focusMode);
  }

  function setAuxiliaryVisible(
    visible: boolean,
    options: WorkbenchAuxiliaryOptionsDto | null = {}
  ): void {
    if (disposed) return;
    options = options || {};
    const nextVisible = Boolean(visible);
    if (nextVisible) workbenchState.focusMode = false;
    if (state.ai) state.ai.chatOpen = nextVisible;
    if (layout) layout.classList.toggle('chat-open', nextVisible);
    const activity = dependencies.document.getElementById('activity-ai');
    if (activity) {
      activity.classList.toggle('active', nextVisible);
      activity.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
    }
    const aiChatPanel = dependencies.getAiChatPanel();
    if (!options.skipContent) aiChatPanel?.setVisible?.(nextVisible);
    refreshControls();
    requestEditorLayout();
    emitChange();
  }

  function toggleAuxiliary(): void {
    if (disposed) return;
    const next = !(state.ai && state.ai.chatOpen);
    const aiAgentButton = dependencies.getAiAgentButton();
    if (aiAgentButton?.toggleChat) aiAgentButton.toggleChat(next);
    else setAuxiliaryVisible(next);
  }

  function reset(): void {
    if (disposed) return;
    const fresh = copyDefaults();
    Object.keys(fresh).forEach((key) => {
      workbenchState[key] = fresh[key];
    });
    const aiAgentButton = dependencies.getAiAgentButton();
    if (aiAgentButton?.toggleChat) aiAgentButton.toggleChat(false);
    else {
      if (state.ai) state.ai.chatOpen = false;
      if (layout) layout.classList.remove('chat-open');
    }
    setPrimaryView('explorer');
    apply({ immediate: true });
  }

  function beginResize(kind: ResizeSession['kind'], event: PointerEvent): void {
    if (disposed || event.button !== 0 || !layout) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    resizeSession = {
      kind,
      target,
      startX: event.clientX,
      startY: event.clientY,
      sidebarWidth: workbenchState.sidebarWidth,
      panelSize: workbenchState.panelSize,
      rightPanelSize: workbenchState.rightPanelSize,
      chatWidth: workbenchState.chatWidth
    };
    target.classList.add('resizing');
    if (dependencies.document.body) {
      dependencies.document.body.style.userSelect = 'none';
      dependencies.document.body.style.cursor = kind === 'panel' &&
        workbenchState.panelPosition === 'bottom' ? 'ns-resize' : 'ew-resize';
    }
    layout.style.transition = 'none';
    try {
      target.setPointerCapture(event.pointerId);
    } catch (_) {}
  }

  function moveResize(event: PointerEvent): void {
    if (disposed || !resizeSession || !layout) return;
    const rect = layout.getBoundingClientRect();
    if (resizeSession.kind === 'sidebar') {
      workbenchState.sidebarWidth = numberInRange(
        resizeSession.sidebarWidth + event.clientX - resizeSession.startX,
        workbenchState.sidebarWidth,
        180,
        Math.min(520, rect.width * 0.46)
      );
    } else if (resizeSession.kind === 'panel' && workbenchState.panelPosition === 'bottom') {
      workbenchState.panelSize = numberInRange(
        resizeSession.panelSize + resizeSession.startY - event.clientY,
        workbenchState.panelSize,
        96,
        rect.height * 0.72
      );
    } else if (resizeSession.kind === 'panel') {
      workbenchState.rightPanelSize = numberInRange(
        resizeSession.rightPanelSize + resizeSession.startX - event.clientX,
        workbenchState.rightPanelSize,
        280,
        Math.min(760, rect.width * 0.58)
      );
    } else {
      workbenchState.chatWidth = numberInRange(
        resizeSession.chatWidth + resizeSession.startX - event.clientX,
        workbenchState.chatWidth,
        260,
        Math.min(640, rect.width * 0.55)
      );
    }
    apply({ persist: false, layoutEditor: false });
  }

  function endResize(persist = true): void {
    if (!resizeSession) return;
    resizeSession.target.classList.remove('resizing');
    resizeSession = null;
    if (dependencies.document.body) {
      dependencies.document.body.style.userSelect = '';
      dependencies.document.body.style.cursor = '';
    }
    if (layout) layout.style.transition = '';
    if (!disposed && persist) {
      persistSoon(true);
      requestEditorLayout();
    }
  }

  function adjustFromKeyboard(kind: ResizeSession['kind'], event: KeyboardEvent): void {
    if (disposed) return;
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 12;
    if (kind === 'sidebar') {
      if (key === 'Home') workbenchState.sidebarWidth = 180;
      else if (key === 'End') workbenchState.sidebarWidth = 520;
      else workbenchState.sidebarWidth += key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0;
    } else if (kind === 'ai') {
      if (key === 'Home') workbenchState.chatWidth = 260;
      else if (key === 'End') workbenchState.chatWidth = 640;
      else workbenchState.chatWidth += key === 'ArrowLeft' ? step : key === 'ArrowRight' ? -step : 0;
    } else if (workbenchState.panelPosition === 'bottom') {
      if (key === 'Home') workbenchState.panelSize = 96;
      else if (key === 'End') workbenchState.panelSize = 700;
      else workbenchState.panelSize += key === 'ArrowUp' ? step : key === 'ArrowDown' ? -step : 0;
    } else {
      if (key === 'Home') workbenchState.rightPanelSize = 280;
      else if (key === 'End') workbenchState.rightPanelSize = 760;
      else workbenchState.rightPanelSize += key === 'ArrowLeft' ? step : key === 'ArrowRight' ? -step : 0;
    }
    apply({ immediate: true });
  }

  function bindResizer(id: string, kind: ResizeSession['kind']): void {
    const element = dependencies.document.getElementById(id);
    if (!element) return;
    listen(element, 'pointerdown', (event) => beginResize(kind, event as PointerEvent));
    listen(element, 'pointermove', (event) => moveResize(event as PointerEvent));
    listen(element, 'pointerup', () => endResize());
    listen(element, 'pointercancel', () => endResize());
    listen(element, 'keydown', (event) => adjustFromKeyboard(kind, event as KeyboardEvent));
  }

  function closeMenu(): void {
    if (!menu) return;
    menu.classList.remove('open');
    const button = dependencies.document.getElementById('layout-menu-button');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  async function closeWorkbenchPanel(): Promise<void> {
    try {
      const terminal = dependencies.getTerminal();
      if (terminal?.close) await terminal.close('panel-close');
    } finally {
      setPanelVisible(false);
    }
  }

  function bindShell(): void {
    const document = dependencies.document;
    const commandCenter = document.getElementById('command-center');
    if (commandCenter) listen(commandCenter, 'click', () => dependencies.getCommands()?.show?.());

    document.querySelectorAll('[data-workbench-view]').forEach((button) => {
      listen(button, 'click', () => {
        const view = button.getAttribute('data-workbench-view');
        if (view) setPrimaryView(view);
        if (view === 'team') {
          if (teamRevealFrame !== null && dependencies.cancelAnimationFrame) {
            dependencies.cancelAnimationFrame(teamRevealFrame);
          }
          teamRevealFrame = dependencies.requestAnimationFrame(() => {
            teamRevealFrame = null;
            if (disposed) return;
            const sidebar = document.getElementById('sidebar');
            const collaboration = dependencies.getCollaboration();
            if (sidebar && dependencies.getComputedStyle(sidebar).display === 'none') {
              collaboration?.openHub?.();
            }
          });
        }
      });
    });
    document.querySelectorAll('.sidebar-hide').forEach((button) => {
      listen(button, 'click', () => setPrimaryVisible(false));
    });

    const search = document.getElementById('activity-search');
    if (search) listen(search, 'click', () => dependencies.getFileSearch()?.show?.());
    const ai = document.getElementById('activity-ai');
    if (ai) listen(ai, 'click', () => toggleAuxiliary());
    const settings = document.getElementById('activity-settings');
    if (settings) listen(settings, 'click', () => dependencies.getSettings()?.open?.('workbench'));
    const cloudStorage = document.getElementById('cloud-open-storage');
    if (cloudStorage) listen(cloudStorage, 'click', () => dependencies.getProjects()?.open?.());
    const cloudSettings = document.getElementById('cloud-open-settings');
    if (cloudSettings) listen(cloudSettings, 'click', () => dependencies.getSettings()?.open?.('server'));
    const cloudSync = document.getElementById('cloud-view-sync');
    if (cloudSync) listen(cloudSync, 'click', () => {
      const button = document.getElementById('cloud-sync-btn') as HTMLButtonElement | null;
      button?.click();
    });
    const teamPanel = document.getElementById('team-sidebar-panel');
    if (teamPanel) listen(teamPanel, 'click', () => dependencies.getSwitchToPanel()?.('team'));

    const menuButton = document.getElementById('layout-menu-button');
    menu = document.getElementById('layout-menu');
    if (menuButton && menu) {
      listen(menuButton, 'click', (event) => {
        event.stopPropagation();
        if (!menu) return;
        const open = !menu.classList.contains('open');
        menu.classList.toggle('open', open);
        menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      listen(menu, 'click', (event) => event.stopPropagation());
      listen(document, 'click', () => closeMenu());
      listen(document, 'keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Escape') closeMenu();
      });
    }

    document.querySelectorAll('[data-layout-toggle]').forEach((button) => {
      listen(button, 'click', () => {
        const type = button.getAttribute('data-layout-toggle');
        if (type === 'primarySidebar') togglePrimary();
        if (type === 'bottomPanel') togglePanel();
        if (type === 'auxiliaryBar') toggleAuxiliary();
      });
    });
    document.querySelectorAll('button[data-panel-position]').forEach((button) => {
      listen(button, 'click', () => setPanelPosition(button.getAttribute('data-panel-position') || ''));
    });
    document.querySelectorAll('button[data-density]').forEach((button) => {
      listen(button, 'click', () => setDensity(button.getAttribute('data-density') || ''));
    });
    document.querySelectorAll('[data-layout-action="focus"]').forEach((button) => {
      listen(button, 'click', () => toggleFocusMode());
    });
    document.querySelectorAll('[data-layout-action="reset"]').forEach((button) => {
      listen(button, 'click', () => reset());
    });

    const positionToggle = document.getElementById('panel-position-toggle');
    const maximize = document.getElementById('panel-maximize');
    const closePanel = document.getElementById('panel-close');
    if (positionToggle) listen(positionToggle, 'click', () => togglePanelPosition());
    if (maximize) listen(maximize, 'click', () => togglePanelMaximized());
    if (closePanel) listen(closePanel, 'click', () => { void closeWorkbenchPanel(); });

    const sidebarSetting = document.getElementById('settings-layout-sidebar') as HTMLInputElement | null;
    const panelSetting = document.getElementById('settings-layout-panel') as HTMLInputElement | null;
    const aiSetting = document.getElementById('settings-layout-ai') as HTMLInputElement | null;
    const positionSetting = document.getElementById('settings-panel-position') as HTMLSelectElement | null;
    const densitySetting = document.getElementById('settings-density') as HTMLSelectElement | null;
    const resetSetting = document.getElementById('settings-layout-reset');
    if (sidebarSetting) listen(sidebarSetting, 'change', () => setPrimaryVisible(sidebarSetting.checked));
    if (panelSetting) listen(panelSetting, 'change', () => setPanelVisible(panelSetting.checked));
    if (aiSetting) listen(aiSetting, 'change', () => {
      const aiAgentButton = dependencies.getAiAgentButton();
      if (aiAgentButton?.toggleChat) aiAgentButton.toggleChat(aiSetting.checked);
      else setAuxiliaryVisible(aiSetting.checked);
    });
    if (positionSetting) listen(positionSetting, 'change', () => setPanelPosition(positionSetting.value));
    if (densitySetting) listen(densitySetting, 'change', () => setDensity(densitySetting.value));
    if (resetSetting) listen(resetSetting, 'click', () => reset());

    bindResizer('sidebar-resizer', 'sidebar');
    bindResizer('output-resizer', 'panel');
    bindResizer('ai-chat-resizer', 'ai');

    const eventTarget = dependencies.eventTarget as unknown as EventTarget;
    listen(eventTarget, 'blur', () => endResize());
    listen(eventTarget, 'resize', () => apply({ persist: false }));
    listen(eventTarget, 'keydown', (event) => {
      const keyboard = event as KeyboardEvent;
      const primary = keyboard.ctrlKey || keyboard.metaKey;
      if (primary && !keyboard.shiftKey && (keyboard.key === 'b' || keyboard.key === 'B')) {
        keyboard.preventDefault();
        togglePrimary();
      }
      if (primary && !keyboard.shiftKey && (keyboard.key === 'j' || keyboard.key === 'J')) {
        keyboard.preventDefault();
        togglePanel();
      }
      if (primary && keyboard.shiftKey && keyboard.key === 'F11') {
        keyboard.preventDefault();
        toggleFocusMode();
      }
    });
  }

  function observeContext(): void {
    const document = dependencies.document;
    const workspace = document.getElementById('workspace-label');
    const teamBadge = document.getElementById('team-project-badge');
    if (!dependencies.createMutationObserver || (!workspace && !teamBadge)) return;
    contextObserver = dependencies.createMutationObserver(() => refreshContext());
    if (workspace) contextObserver.observe(workspace, { childList: true, subtree: true });
    if (teamBadge) {
      contextObserver.observe(teamBadge, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style']
      });
    }
    lifecycle.add(toDisposable(() => {
      contextObserver?.disconnect();
      contextObserver = null;
    }));
  }

  function init(): void {
    if (disposed || initialized) return;
    initialized = true;
    layout = dependencies.document.getElementById('layout');
    if (!layout) return;
    listen(layout, 'transitionend', (event) => {
      const transition = event as TransitionEvent;
      if (!layout || transition.target !== layout ||
          !['grid-template-rows', 'grid-template-columns'].includes(transition.propertyName)) return;
      if (editorLayoutTimer !== null) {
        dependencies.clearTimer(editorLayoutTimer);
        editorLayoutTimer = null;
      }
      layoutEditors();
    });
    bindShell();
    observeContext();
    renderPrimaryView(workbenchState.activity);
    apply({ persist: false, layoutEditor: false });

    const commands = dependencies.getCommands();
    if (commands) {
      lifecycle.add(commands.register(
        'view-toggle-primary-sidebar',
        'Toggle Primary Sidebar',
        'Ctrl+B',
        'View',
        togglePrimary
      ));
      lifecycle.add(commands.register(
        'view-toggle-panel',
        'Toggle Workbench Panel',
        'Ctrl+J',
        'View',
        togglePanel
      ));
      lifecycle.add(commands.register(
        'view-move-panel',
        'Move Panel to Bottom or Right',
        '',
        'View',
        togglePanelPosition
      ));
      lifecycle.add(commands.register(
        'view-focus-mode',
        'Toggle Focus Mode',
        'Ctrl+Shift+F11',
        'View',
        toggleFocusMode
      ));
      lifecycle.add(commands.register(
        'view-reset-layout',
        'Reset Workbench Layout',
        '',
        'View',
        reset
      ));
    }
  }

  function dispose(): void {
    if (disposed) return;
    // Remove an active pointer session before marking the service disposed so
    // body styles and the resizer class cannot leak across a reload.
    endResize(false);
    disposed = true;
    cancelEditorLayout();
    if (saveTimer !== null) {
      dependencies.clearTimer(saveTimer);
      saveTimer = null;
    }
    try {
      lifecycle.dispose();
    } catch (error) {
      report(error);
    }
    contextObserver = null;
    dynamicPrimaryViews.clear();
    menu = null;
    layout = null;
  }

  const service: WorkbenchLayoutFacade & WorkbenchLayoutService = {
    get disposed(): boolean {
      return disposed;
    },
    init,
    getState,
    apply,
    refreshControls,
    refreshContext,
    registerPrimaryView,
    unregisterPrimaryView,
    setPrimaryView,
    setPrimaryVisible,
    togglePrimary,
    setPanelVisible,
    togglePanel,
    revealPanel,
    ensureBottomPanelSize,
    setPanelPosition,
    togglePanelPosition,
    togglePanelMaximized,
    setDensity,
    setFocusMode,
    setAuxiliaryVisible,
    toggleAuxiliary,
    reset,
    dispose
  };
  return Object.freeze(service);
}
