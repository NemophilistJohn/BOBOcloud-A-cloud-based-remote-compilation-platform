import type { Disposable } from './lifecycle';

/** Minimal URI shape consumed by the editor diagnostics bridge. */
export interface EditorCoreUriPort {
  toString(): string;
}

/** Monaco model options used by the status bar. */
export interface EditorCoreModelOptionsDto {
  readonly insertSpaces?: boolean;
  readonly tabSize?: number;
  readonly [key: string]: unknown;
}

/** Structural model contract; the concrete Monaco model stays in the AMD realm. */
export interface EditorCoreModelPort {
  readonly uri: EditorCoreUriPort;
  getLanguageId(): string;
  getOptions(): EditorCoreModelOptionsDto;
  getLineCount(): number;
  isDisposed?(): boolean;
  onDidChangeContent(listener: () => void): Disposable | void;
  onWillDispose?(listener: () => void): Disposable | void;
  updateOptions?(options: Readonly<Record<string, unknown>>): void;
}

export interface EditorCoreCursorPositionEvent {
  readonly position: unknown;
}

export interface EditorCoreModelChangeEvent {
  readonly newModel: EditorCoreModelPort | null;
}

/** Structural standalone editor contract used by the workbench facade. */
export interface EditorCoreEditorPort {
  addCommand(keybinding: number, handler: () => void): string | null | void;
  getModel(): EditorCoreModelPort | null;
  getPosition(): unknown;
  trigger(source: string, action: string): void;
  onDidChangeCursorPosition(
    listener: (event: EditorCoreCursorPositionEvent) => void
  ): Disposable | void;
  onDidChangeModel(
    listener: (event: EditorCoreModelChangeEvent) => void
  ): Disposable | void;
}

export interface EditorCoreMarkerDto {
  readonly severity?: number;
  readonly message?: string;
  readonly startLineNumber?: number;
  readonly startColumn?: number;
  readonly endLineNumber?: number;
  readonly endColumn?: number;
  readonly [key: string]: unknown;
}

export interface EditorCoreMonacoEditorPort {
  create(
    element: HTMLElement,
    options: Readonly<Record<string, unknown>>
  ): EditorCoreEditorPort;
  getModelMarkers(options: { readonly resource: EditorCoreUriPort }): readonly EditorCoreMarkerDto[];
  setModelMarkers(
    model: EditorCoreModelPort,
    owner: string,
    markers: readonly EditorCoreMarkerDto[]
  ): void;
  getModels(): readonly EditorCoreModelPort[];
  onDidCreateModel(listener: (model: EditorCoreModelPort) => void): Disposable | void;
}

export interface EditorCoreKeyModDto {
  readonly CtrlCmd: number;
  readonly Shift: number;
  readonly Alt: number;
}

export interface EditorCoreKeyCodeDto {
  readonly KeyS: number;
  readonly F5: number;
  readonly KeyF: number;
  readonly KeyH: number;
  readonly KeyD: number;
  readonly KeyP: number;
  readonly Comma: number;
  readonly Backslash: number;
}

export interface EditorCoreMarkerSeverityDto {
  readonly Error: number;
  readonly Warning: number;
  readonly Info: number;
}

export interface EditorCoreMonacoPort {
  readonly KeyMod: EditorCoreKeyModDto;
  readonly KeyCode: EditorCoreKeyCodeDto;
  readonly MarkerSeverity: EditorCoreMarkerSeverityDto;
  readonly editor: EditorCoreMonacoEditorPort;
}

export interface EditorCoreDiagnosticsStateDto {
  errors: number;
  warnings: number;
  infos: number;
  readonly [key: string]: unknown;
}

export interface EditorCoreDiagnosticsSettingsDto {
  readonly enabled?: unknown;
  readonly checkOn?: unknown;
  readonly debounceMs?: unknown;
  readonly [key: string]: unknown;
}

export interface EditorCoreTabDto {
  model?: EditorCoreModelPort | null;
  dirty?: boolean;
  readonly [key: string]: unknown;
}

/** Narrow mutable state view; the compatibility adapter supplies the legacy object. */
export interface EditorCoreRendererState {
  editor: EditorCoreEditorPort | null;
  currentViewMode: string;
  tabs: EditorCoreTabDto[];
  currentDiagnostics: EditorCoreDiagnosticsStateDto;
  diagnosticsSettings?: EditorCoreDiagnosticsSettingsDto | null;
  autoScrollEnabled: boolean;
}

export interface EditorCoreI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
}

export interface EditorCoreThemePort {
  setMonaco(monaco: EditorCoreMonacoPort): unknown;
  getCurrentTheme(): string;
}

export interface EditorCoreWorkspacePort {
  saveActiveTab?(): unknown;
  updateTabbar?(): unknown;
  updateTitlebar?(): unknown;
  updateEmptyState?(): unknown;
}

export interface EditorCoreDapPort {
  isPaused(): boolean;
  execute(command: string): unknown;
  isActive(): boolean;
  start(): unknown;
}

export interface EditorCoreProjectTasksPort {
  runSelected(): unknown;
}

export interface EditorCoreRunnerPort {
  runActive(): unknown;
}

export interface EditorCoreCommandsPort {
  show(): unknown;
}

export interface EditorCoreSettingsPort {
  open(scope: 'local'): unknown;
}

export interface EditorCoreAiInlinePort {
  trigger(): unknown;
}

export interface EditorCoreTaskProblemMatcherPort {
  refreshMonacoProblems?(): unknown;
  getAllProblems?(): readonly unknown[];
}

export interface EditorCoreDiagnosticsSettingsPort {
  load?(): unknown;
  init?(): unknown;
}

export interface EditorCoreWorkspaceSettingsPort {
  setMonaco?(monaco: EditorCoreMonacoPort): unknown;
  attachEditor?(editor: EditorCoreEditorPort): unknown;
}

export interface EditorCoreRuleRegistryPort {
  getSyntaxMarkers(
    model: EditorCoreModelPort,
    monaco: EditorCoreMonacoPort,
    options: { readonly largeFile: boolean }
  ): readonly EditorCoreMarkerDto[];
}

export interface EditorCoreGlobalEventPort extends EventTarget {}

export interface EditorCoreDependencies {
  readonly document: Document;
  readonly eventTarget: EditorCoreGlobalEventPort;
  readonly state: EditorCoreRendererState;
  readonly getI18n: () => EditorCoreI18nPort | null | undefined;
  readonly getTheme: () => EditorCoreThemePort | null | undefined;
  readonly getWorkspace: () => EditorCoreWorkspacePort | null | undefined;
  readonly getDap: () => EditorCoreDapPort | null | undefined;
  readonly getProjectTasks: () => EditorCoreProjectTasksPort | null | undefined;
  readonly getRunner: () => EditorCoreRunnerPort | null | undefined;
  readonly getCommands: () => EditorCoreCommandsPort | null | undefined;
  readonly getSettings: () => EditorCoreSettingsPort | null | undefined;
  readonly getAiInline: () => EditorCoreAiInlinePort | null | undefined;
  readonly getTaskProblemMatcher: () => EditorCoreTaskProblemMatcherPort | null | undefined;
  readonly getDiagnosticsSettings: () => EditorCoreDiagnosticsSettingsPort | null | undefined;
  readonly getWorkspaceSettings: () => EditorCoreWorkspaceSettingsPort | null | undefined;
  readonly getRuleRegistry: () => EditorCoreRuleRegistryPort | null | undefined;
  readonly getLanguageDisplayName: (languageId: string) => string;
  readonly switchToPanel?: (panelName: string) => unknown;
  readonly registerCompletionProviders: (monaco: EditorCoreMonacoPort) => unknown;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}

/** Historical eight-method BOBO projection. */
export interface EditorCoreFacade {
  init(monaco: EditorCoreMonacoPort): void;
  updateStatusBar(model: EditorCoreModelPort | null, position: unknown): void;
  updateDiagnosticsStatus(): void;
  refreshDiagnosticsForModel(model: EditorCoreModelPort | null): void;
  showFindWidget(): void;
  showReplaceWidget(): void;
  recheckAll(): void;
  checkActiveOnSave(): void;
}

export interface EditorCoreService extends EditorCoreFacade, Disposable {
  readonly disposed: boolean;
}
