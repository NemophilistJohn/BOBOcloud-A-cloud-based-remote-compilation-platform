import type { Disposable } from './lifecycle';

export type WorkbenchEditorViewModeDto = 'single' | 'split' | 'diff' | string;

export interface ViewsUriPort {
  toString(): string;
}

export interface ViewsTextModelPort extends Disposable {
  readonly uri: ViewsUriPort;
  getValue(): string;
  setValue(value: string): void;
  getLanguageId(): string;
  onDidChangeContent(listener: () => void): Disposable;
}

export interface ViewsCodeEditorPort {
  getModel(): ViewsTextModelPort | null;
  setModel(model: ViewsTextModelPort | null): void;
  getOption(option: unknown): string | null | undefined;
  getPosition(): unknown;
  updateOptions(options: Readonly<Record<string, unknown>>): void;
  dispose?(): void;
}

export interface ViewsSplitEditorPort extends ViewsCodeEditorPort {
  rightEditor: ViewsCodeEditorPort;
}

export interface ViewsDiffModelDto {
  readonly original: ViewsTextModelPort;
  readonly modified: ViewsTextModelPort;
}

export interface ViewsDiffEditorPort {
  getModel(): ViewsDiffModelDto | null;
  setModel(model: ViewsDiffModelDto | null): void;
  dispose?(): void;
}

export interface ViewsTabDto {
  readonly path: string;
  readonly model?: ViewsTextModelPort | null;
  readonly [key: string]: unknown;
}

export interface ViewsDiffPathsDto {
  readonly originalPath?: string | null;
  readonly modifiedPath?: string | null;
}

export interface ViewsMonacoEditorPort {
  readonly EditorOption: {
    readonly theme: unknown;
  };
  create(
    element: HTMLElement,
    options: Readonly<Record<string, unknown>>
  ): ViewsCodeEditorPort;
  createModel(
    value: string,
    language?: string,
    uri?: unknown
  ): ViewsTextModelPort;
  createDiffEditor(
    element: HTMLElement,
    options: Readonly<Record<string, unknown>>
  ): ViewsDiffEditorPort;
  setModelLanguage(model: ViewsTextModelPort, language: string): void;
}

export interface ViewsMonacoPort {
  readonly editor: ViewsMonacoEditorPort;
  readonly Uri: {
    parse(value: string): unknown;
  };
}

export interface ViewsRendererState {
  editor: ViewsCodeEditorPort | null;
  splitEditor: ViewsSplitEditorPort | null;
  diffEditor: ViewsDiffEditorPort | null;
  currentViewMode: WorkbenchEditorViewModeDto;
  tabs: ViewsTabDto[];
  activeTabPath: string | null;
  workspaceTransitionLocked?: boolean;
  diffOriginalPath?: string | null;
  diffModifiedPath?: string | null;
  currentImagePath?: string | null;
  imageRotation: number;
  imageScale: number;
}

export interface ViewsHost {
  readFile(filePath: string): Promise<string>;
}

export interface ViewsCollaborationPort {
  isActiveFileReadOnly?(): boolean;
}

export interface ViewsWorkspaceSettingsPort {
  attachEditor?(editor: ViewsCodeEditorPort): unknown;
}

export interface ViewsEditorCorePort {
  updateStatusBar(model: ViewsTextModelPort | null, position: unknown): unknown;
}

export interface ViewsThemePort {
  applyTheme(themeId: string): unknown;
}

export interface ViewsSettingsPort {
  open(scope: 'local'): unknown;
}

export interface ViewsDependencies {
  readonly document: Document;
  readonly state: ViewsRendererState;
  readonly host: Readonly<ViewsHost>;
  readonly getMonaco: () => ViewsMonacoPort | null | undefined;
  readonly getCollaboration: () => ViewsCollaborationPort | null | undefined;
  readonly getWorkspaceSettings: () => ViewsWorkspaceSettingsPort | null | undefined;
  readonly getEditorCore: () => ViewsEditorCorePort | null | undefined;
  readonly getTheme: () => ViewsThemePort | null | undefined;
  readonly getSettings: () => ViewsSettingsPort | null | undefined;
  readonly detectLanguage: (name: string, content: string) => string;
  readonly updateRunOutput: (message: string) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}

export interface ViewsFacade {
  init(): void;
  openSplit(): void;
  closeSplit(): void;
  openDiff(originalPath?: string | null, modifiedPath?: string | null): void;
  closeDiff(): void;
  showImagePreview(filePath: string, name: string): void;
  closeImagePreview(): void;
  openThemePicker(): void;
}

export interface ViewsService extends ViewsFacade, Disposable {
  readonly disposed: boolean;
}
