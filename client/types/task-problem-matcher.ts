import type { Disposable, Dispose } from './lifecycle';

export type TaskProblemSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface TaskProblemPatternDto {
  readonly regexp?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly column?: unknown;
  readonly endLine?: unknown;
  readonly endColumn?: unknown;
  readonly severity?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly loop?: unknown;
  readonly [key: string]: unknown;
}

export interface TaskProblemMatcherDefinitionDto {
  readonly owner?: unknown;
  readonly fileLocation?: unknown;
  readonly pattern?: unknown;
  readonly [key: string]: unknown;
}

export interface TaskProblemExecutionDto {
  readonly problemMatcher?: unknown;
  readonly [key: string]: unknown;
}

export interface TaskProblemDto {
  readonly path: string;
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly severity: TaskProblemSeverity;
  readonly code: string;
  readonly message: string;
  readonly owner: string;
}

export interface TaskProblemMatcherEditorPort {
  revealPositionInCenter(position: { readonly lineNumber: number; readonly column: number }): void;
  setPosition(position: { readonly lineNumber: number; readonly column: number }): void;
  focus(): void;
}

export interface TaskProblemMatcherEditorCorePort {
  refreshDiagnosticsForModel?(model: unknown): void;
}

export interface TaskProblemMatcherWorkspacePort {
  openFile(path: string, name: string): Promise<unknown> | unknown;
}

export interface TaskProblemMatcherState {
  workspaceRoot?: unknown;
  editor?: TaskProblemMatcherEditorPort | null;
  readonly [key: string]: unknown;
}

export interface TaskProblemMatcherI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
}

export interface TaskProblemMatcherModelPort {
  readonly uri?: { readonly fsPath?: unknown } | null;
  readonly [key: string]: unknown;
}

export interface TaskProblemMatcherExternalMarkerDto {
  readonly owner?: unknown;
  readonly source?: unknown;
  readonly severity?: unknown;
  readonly startLineNumber?: unknown;
  readonly startColumn?: unknown;
  readonly endLineNumber?: unknown;
  readonly endColumn?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly [key: string]: unknown;
}

export interface TaskProblemMatcherMarkerDto {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly severity: number;
  readonly message: string;
  readonly code?: string;
  readonly source: string;
}

export interface TaskProblemMatcherMonacoEditorPort {
  getModels?(): readonly TaskProblemMatcherModelPort[];
  setModelMarkers?(model: unknown, owner: string, markers: readonly TaskProblemMatcherMarkerDto[]): void;
  getModelMarkers?(filter: { readonly resource: unknown }): readonly TaskProblemMatcherExternalMarkerDto[];
}

export interface TaskProblemMatcherMonacoPort {
  readonly MarkerSeverity?: {
    readonly Error?: number;
    readonly Warning?: number;
    readonly Info?: number;
    readonly Hint?: number;
  };
  readonly editor?: TaskProblemMatcherMonacoEditorPort;
}

export interface TaskProblemMatcherDependencies {
  readonly document: Document;
  readonly state: TaskProblemMatcherState;
  readonly getMonaco: () => TaskProblemMatcherMonacoPort | null | undefined;
  readonly getI18n: () => TaskProblemMatcherI18nPort | null | undefined;
  readonly getWorkspace: () => TaskProblemMatcherWorkspacePort | null | undefined;
  readonly getEditor: () => TaskProblemMatcherEditorPort | null | undefined;
  readonly getEditorCore: () => TaskProblemMatcherEditorCorePort | null | undefined;
  readonly reportError?: (error: unknown) => void;
}

export interface TaskProblemSession {
  consume(rawLine: unknown, stage?: unknown): void;
  finish(): void;
}

export type TaskProblemMatcherListener = (problems: readonly TaskProblemDto[]) => void;

export interface TaskProblemMatcherFacade {
  init(): void;
  begin(execution?: TaskProblemExecutionDto | null): TaskProblemSession | null;
  clear(): void;
  getProblems(): TaskProblemDto[];
  getAllProblems(): TaskProblemDto[];
  refreshMonacoProblems(): void;
  onDidChange(listener: TaskProblemMatcherListener): Dispose;
  applyModel(model: unknown): void;
  activeSession(): TaskProblemSession | null;
  openProblem(problem: TaskProblemDto | null | undefined): void;
}

export interface TaskProblemMatcherService extends TaskProblemMatcherFacade, Disposable {
  readonly disposed: boolean;
}
