import type { Disposable } from './lifecycle';
import type { RendererState } from './state';

export type WorkbenchPrimaryViewId = string;
export type WorkbenchPanelPositionDto = 'bottom' | 'right';
export type WorkbenchDensityDto = 'comfortable' | 'compact';
export type WorkbenchResizeKindDto = 'sidebar' | 'panel' | 'ai';

export interface WorkbenchLayoutStateDto {
  readonly activity: WorkbenchPrimaryViewId;
  readonly primaryVisible: boolean;
  readonly sidebarWidth: number;
  readonly panelVisible: boolean;
  readonly panelPosition: WorkbenchPanelPositionDto;
  readonly panelSize: number;
  readonly rightPanelSize: number;
  readonly density: WorkbenchDensityDto;
  readonly chatWidth: number;
  readonly panelMaximized: boolean;
  readonly focusMode: boolean;
}

export type WorkbenchPersistentStateDto = Readonly<Pick<
  WorkbenchLayoutStateDto,
  | 'activity'
  | 'primaryVisible'
  | 'sidebarWidth'
  | 'panelVisible'
  | 'panelPosition'
  | 'panelSize'
  | 'rightPanelSize'
  | 'density'
  | 'chatWidth'
>>;

export interface WorkbenchLayoutSnapshotDto extends WorkbenchPersistentStateDto {
  readonly panelMaximized: boolean;
  readonly focusMode: boolean;
  readonly auxiliaryVisible: boolean;
}

export interface WorkbenchApplyOptionsDto {
  readonly persist?: boolean;
  readonly immediate?: boolean;
  readonly layoutEditor?: boolean;
}

export interface WorkbenchAuxiliaryOptionsDto {
  readonly skipContent?: boolean;
}

export interface WorkbenchLayoutEditorPort {
  layout(): void;
}

export interface WorkbenchCommandsPort {
  register(
    id: string,
    label: string,
    hint: string,
    category: string,
    handler: () => unknown
  ): Disposable;
  show?(): unknown;
}

export interface WorkbenchTerminalPort {
  close?(reason: string): Promise<unknown> | unknown;
}

export interface WorkbenchFileSearchPort {
  show?(): unknown;
}

export interface WorkbenchSettingsPort {
  open?(tab: string): unknown;
}

export interface WorkbenchProjectsPort {
  open?(): unknown;
}

export interface WorkbenchCollaborationCurrentDto {
  readonly teamName?: string;
  readonly projectName?: string;
  readonly branch?: string;
}

export interface WorkbenchCollaborationPort {
  readonly current?: WorkbenchCollaborationCurrentDto | null;
  openHub?(): unknown;
}

export interface WorkbenchAiAgentButtonPort {
  toggleChat?(visible: boolean): unknown;
}

export interface WorkbenchAiChatPanelPort {
  setVisible?(visible: boolean): unknown;
}

export interface WorkbenchSwitchPanelPort {
  (panel: string): unknown;
}

export interface WorkbenchStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkbenchLayoutDependencies {
  readonly document: Document;
  readonly eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;
  readonly state: RendererState;
  readonly storage?: Readonly<WorkbenchStoragePort> | null;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly getComputedStyle: (element: Element) => Pick<CSSStyleDeclaration, 'display'>;
  readonly createCustomEvent: (
    type: string,
    init: CustomEventInit<WorkbenchLayoutSnapshotDto>
  ) => Event;
  readonly createMutationObserver?: (callback: MutationCallback) => MutationObserver;
  readonly getCommands: () => WorkbenchCommandsPort | null | undefined;
  readonly getTerminal: () => WorkbenchTerminalPort | null | undefined;
  readonly getFileSearch: () => WorkbenchFileSearchPort | null | undefined;
  readonly getSettings: () => WorkbenchSettingsPort | null | undefined;
  readonly getProjects: () => WorkbenchProjectsPort | null | undefined;
  readonly getCollaboration: () => WorkbenchCollaborationPort | null | undefined;
  readonly getAiAgentButton: () => WorkbenchAiAgentButtonPort | null | undefined;
  readonly getAiChatPanel: () => WorkbenchAiChatPanelPort | null | undefined;
  readonly getSwitchToPanel: () => WorkbenchSwitchPanelPort | null | undefined;
  readonly reportError: (error: unknown) => void;
}

export interface WorkbenchLayoutFacade {
  init(): void;
  getState(): WorkbenchLayoutSnapshotDto;
  apply(options?: WorkbenchApplyOptionsDto): void;
  refreshControls(): void;
  refreshContext(): void;
  registerPrimaryView(view: string): Disposable;
  unregisterPrimaryView(view: string): void;
  setPrimaryView(view: string): void;
  setPrimaryVisible(visible: boolean): void;
  togglePrimary(): void;
  setPanelVisible(visible: boolean): void;
  togglePanel(): void;
  revealPanel(): void;
  ensureBottomPanelSize(minimumSize: number): void;
  setPanelPosition(position: string): void;
  togglePanelPosition(): void;
  togglePanelMaximized(): void;
  setDensity(density: string): void;
  setFocusMode(enabled: boolean): void;
  setAuxiliaryVisible(visible: boolean, options?: WorkbenchAuxiliaryOptionsDto): void;
  toggleAuxiliary(): void;
  reset(): void;
}

export interface WorkbenchLayoutService extends WorkbenchLayoutFacade, Disposable {
  readonly disposed: boolean;
}
