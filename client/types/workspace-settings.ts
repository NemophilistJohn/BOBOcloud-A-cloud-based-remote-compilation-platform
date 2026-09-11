import type { Disposable } from './lifecycle';

export type WorkspaceSettingsLanguageIdDto =
  | 'c'
  | 'cpp'
  | 'css'
  | 'go'
  | 'html'
  | 'java'
  | 'javascript'
  | 'json'
  | 'less'
  | 'markdown'
  | 'php'
  | 'plaintext'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'scss'
  | 'shell'
  | 'sql'
  | 'typescript'
  | 'xml'
  | 'yaml';

export type WorkspaceSettingsWordWrapDto = 'off' | 'on' | 'wordWrapColumn' | 'bounded';
export type WorkspaceSettingsRenderWhitespaceDto =
  | 'none'
  | 'boundary'
  | 'selection'
  | 'trailing'
  | 'all';

export type WorkspaceSettingsConfigKeyDto =
  | 'editor.tabSize'
  | 'editor.insertSpaces'
  | 'editor.wordWrap'
  | 'editor.wordWrapColumn'
  | 'editor.renderWhitespace'
  | 'editor.minimap.enabled'
  | 'editor.bracketPairColorization.enabled';

export type WorkspaceSettingsConfigValueDto = string | number | boolean | undefined;

export interface WorkspaceEditorSettingsDto {
  readonly tabSize?: number;
  readonly insertSpaces?: boolean;
  readonly wordWrap?: WorkspaceSettingsWordWrapDto;
  readonly wordWrapColumn?: number;
  readonly rulers?: readonly number[];
  readonly renderWhitespace?: WorkspaceSettingsRenderWhitespaceDto;
  readonly minimapEnabled?: boolean;
  readonly bracketPairColorizationEnabled?: boolean;
}

export interface WorkspaceSettingsAssociationDto {
  readonly pattern: string;
  readonly languageId: WorkspaceSettingsLanguageIdDto;
}

export interface WorkspaceSettingsExcludeRuleDto {
  readonly pattern: string;
  readonly regexp: string;
  readonly flags: '' | 'i';
  readonly matcher: RegExp;
}

export interface WorkspaceSettingsFilesDto {
  readonly exclude: readonly WorkspaceSettingsExcludeRuleDto[];
}

export interface WorkspaceSettingsValuesDto {
  readonly editor: WorkspaceEditorSettingsDto;
  readonly languages: Readonly<Partial<Record<WorkspaceSettingsLanguageIdDto, WorkspaceEditorSettingsDto>>>;
  readonly associations: readonly WorkspaceSettingsAssociationDto[];
  readonly files: WorkspaceSettingsFilesDto;
}

export interface WorkspaceSettingsWarningDto {
  readonly code: string;
  readonly count: number;
}

export interface WorkspaceSettingsLoadedSnapshotDto {
  readonly schemaVersion: 1;
  readonly rootPath: string;
  readonly workspaceIdentity: number;
  readonly settings: WorkspaceSettingsValuesDto;
  readonly warnings: readonly WorkspaceSettingsWarningDto[];
}

export interface WorkspaceSettingsEmptySnapshotDto {
  readonly schemaVersion: 1;
  readonly rootPath: null;
  readonly workspaceIdentity: null;
  readonly settings: WorkspaceSettingsValuesDto;
  readonly warnings: readonly WorkspaceSettingsWarningDto[];
}

export type WorkspaceSettingsSnapshotDto =
  | WorkspaceSettingsLoadedSnapshotDto
  | WorkspaceSettingsEmptySnapshotDto;

export interface WorkspaceSettingsRequestDto {
  readonly rootPath: string;
  readonly workspaceIdentity: number;
}

export type WorkspaceSettingsChangedListener = (snapshot: unknown) => void;

export interface WorkspaceSettingsHost {
  read(request: WorkspaceSettingsRequestDto): Promise<unknown>;
  onDidChange(listener: WorkspaceSettingsChangedListener): Disposable;
}

export interface WorkspaceSettingsUriPort {
  readonly fsPath?: unknown;
  readonly path?: unknown;
  toString?(): string;
}

export interface WorkspaceSettingsModelOptionsDto {
  readonly tabSize?: unknown;
  readonly insertSpaces?: unknown;
  readonly [key: string]: unknown;
}

export interface WorkspaceSettingsModelUpdateDto {
  readonly tabSize?: number;
  readonly insertSpaces?: boolean;
}

export interface WorkspaceSettingsModelPort {
  readonly uri?: WorkspaceSettingsUriPort | null;
  getLanguageId(): string;
  getValue?(): string;
  getOptions?(): WorkspaceSettingsModelOptionsDto;
  updateOptions?(options: WorkspaceSettingsModelUpdateDto): void;
}

export interface WorkspaceSettingsEditorRawOptionsDto {
  readonly wordWrap?: unknown;
  readonly wordWrapColumn?: unknown;
  readonly rulers?: unknown;
  readonly renderWhitespace?: unknown;
  readonly minimap?: { readonly enabled?: unknown } | null;
  readonly bracketPairColorization?: { readonly enabled?: unknown } | null;
  readonly [key: string]: unknown;
}

export interface WorkspaceSettingsEditorUpdateDto {
  readonly wordWrap?: WorkspaceSettingsWordWrapDto;
  readonly wordWrapColumn?: number;
  readonly rulers?: readonly number[];
  readonly renderWhitespace?: WorkspaceSettingsRenderWhitespaceDto;
  readonly minimap?: { readonly enabled: boolean };
  readonly bracketPairColorization?: { readonly enabled: boolean };
}

export interface WorkspaceSettingsEditorModelChangeDto {
  readonly newModel?: WorkspaceSettingsModelPort | null;
}

export interface WorkspaceSettingsEditorPort {
  getModel?(): WorkspaceSettingsModelPort | null;
  getPosition?(): unknown;
  getRawOptions?(): WorkspaceSettingsEditorRawOptionsDto;
  updateOptions?(options: WorkspaceSettingsEditorUpdateDto): void;
  onDidChangeModel?(
    listener: (event: WorkspaceSettingsEditorModelChangeDto) => void
  ): Disposable | void;
}

export interface WorkspaceSettingsSplitEditorPort extends WorkspaceSettingsEditorPort {
  readonly rightEditor?: WorkspaceSettingsEditorPort | null;
}

export interface WorkspaceSettingsMonacoPort {
  readonly editor?: {
    getModels(): readonly WorkspaceSettingsModelPort[];
    onDidCreateModel?(
      listener: (model: WorkspaceSettingsModelPort) => void
    ): Disposable | void;
    setModelLanguage?(model: WorkspaceSettingsModelPort, languageId: string): void;
  } | null;
}

export interface WorkspaceSettingsTabDto {
  readonly name?: string;
  readonly path?: string;
  readonly model?: WorkspaceSettingsModelPort | null;
  language?: string;
  languageFromWorkspaceSettings?: boolean;
  readonly [key: string]: unknown;
}

export interface WorkspaceSettingsTreeNodeDto {
  readonly path?: string;
  readonly children?: readonly WorkspaceSettingsTreeNodeDto[];
  readonly [key: string]: unknown;
}

export interface WorkspaceSettingsRendererState {
  workspaceRoot: string | null;
  workspaceIdentity: number | null;
  workspaceSettings: WorkspaceSettingsSnapshotDto | null;
  workspaceTree?: WorkspaceSettingsTreeNodeDto | null;
  tabs: WorkspaceSettingsTabDto[];
  editor?: WorkspaceSettingsEditorPort | null;
  splitEditor?: WorkspaceSettingsSplitEditorPort | null;
  readonly [key: string]: unknown;
}

export interface WorkspaceSettingsEditorCorePort {
  updateStatusBar(model: WorkspaceSettingsModelPort | null, position: unknown): unknown;
}

export interface WorkspaceSettingsRuntimePort {
  autoSelectForLanguage(languageId: string): unknown;
}

export interface WorkspaceSettingsLspPort {
  workspaceChanged(): unknown;
}

export interface WorkspaceSettingsEnvironmentActivityPort {
  contextChanged(reason: string): unknown;
}

export interface WorkspaceSettingsWorkspacePort {
  renderTree(tree: WorkspaceSettingsTreeNodeDto): unknown;
}

export interface WorkspaceSettingsFileSearchPort {
  refreshCache(force?: boolean): unknown;
}

export type WorkspaceSettingsDetectLanguage = (name: string, content: string) => string;

export interface WorkspaceSettingsDependencies {
  readonly state: WorkspaceSettingsRendererState;
  readonly host: Readonly<WorkspaceSettingsHost>;
  readonly getDetectLanguage: () => WorkspaceSettingsDetectLanguage | null | undefined;
  readonly getEditorCore: () => WorkspaceSettingsEditorCorePort | null | undefined;
  readonly getRuntime: () => WorkspaceSettingsRuntimePort | null | undefined;
  readonly getLsp: () => WorkspaceSettingsLspPort | null | undefined;
  readonly getEnvironmentActivity: () => WorkspaceSettingsEnvironmentActivityPort | null | undefined;
  readonly getWorkspace: () => WorkspaceSettingsWorkspacePort | null | undefined;
  readonly getFileSearch: () => WorkspaceSettingsFileSearchPort | null | undefined;
  readonly reportError: (phase: 'dispose', error: unknown) => void;
}

export interface WorkspaceSettingsFacade {
  applySnapshot(raw: unknown): boolean;
  refreshForWorkspace(rootPath: string, workspaceIdentity: number): Promise<boolean>;
  clear(): void;
  setMonaco(monaco: WorkspaceSettingsMonacoPort | null | undefined): void;
  attachEditor(editor: WorkspaceSettingsEditorPort | null | undefined): void;
  applyAll(): void;
  applyModel(model: WorkspaceSettingsModelPort | null | undefined): boolean;
  languageForFile(name: unknown, fallback: string): string;
  effectiveEditorSettings(languageId: string): WorkspaceEditorSettingsDto;
  configValue(
    key: WorkspaceSettingsConfigKeyDto | string,
    languageId?: string
  ): WorkspaceSettingsConfigValueDto;
  isPathExcluded(value: unknown): boolean;
  filterTreeChildren<Node extends WorkspaceSettingsTreeNodeDto>(
    children: readonly Node[] | null | undefined
  ): Node[];
}

export interface WorkspaceSettingsService extends WorkspaceSettingsFacade, Disposable {
  readonly disposed: boolean;
}
