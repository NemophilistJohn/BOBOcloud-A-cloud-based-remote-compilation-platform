import type { Disposable, Dispose } from './lifecycle';

export interface DocumentViewDescriptorRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly extensions: readonly string[];
  readonly entry: string;
  readonly resources?: readonly string[];
  readonly priority?: number;
}

export interface DocumentViewDescriptorDto {
  readonly id: string;
  readonly title: string;
  readonly extensions: readonly string[];
  readonly entry: string;
  readonly resources: readonly string[];
  readonly priority: number;
}

/** Normalized manifest data returned by main before a localized title is attached. */
export interface DocumentViewManifestDescriptorDto {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly entry: string;
  readonly resources: readonly string[];
  readonly priority: number;
}

/** Descriptor fields that are safe to expose to an isolated viewer iframe. */
export interface DocumentViewPublicDescriptorDto {
  readonly id: string;
  readonly title: string;
  readonly extensions: readonly string[];
  readonly priority: number;
}

export interface DocumentViewRegistrationDto extends DocumentViewPublicDescriptorDto {
  readonly pluginId: string;
}

export interface DocumentViewContributionEntryDto {
  readonly id: string;
  readonly owner: string;
  readonly contribution: DocumentViewDescriptorDto;
}

export interface VerifiedDocumentViewFileDto {
  readonly path: string;
  readonly source: string;
  readonly hash: string;
  readonly mimeType: string;
}

export interface LoadedDocumentViewDto {
  readonly pluginId: string;
  readonly viewer: DocumentViewManifestDescriptorDto;
  readonly entry: VerifiedDocumentViewFileDto;
  readonly resources: readonly VerifiedDocumentViewFileDto[];
}

export interface DocumentViewLocalizationDto {
  readonly locale: string;
  readonly messages: Readonly<Record<string, string>>;
}

export type DocumentViewThemeKindDto = 'light' | 'dark';

export interface DocumentViewThemeDto {
  readonly kind: DocumentViewThemeKindDto;
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly danger: string;
  readonly fontFamily: string;
  readonly monoFontFamily: string;
}

export interface DocumentInfoDto {
  readonly documentId: string;
  readonly name: string;
  readonly extension: string;
  readonly size: number;
  readonly lastModified: string;
  readonly writable?: boolean;
  readonly analyzable?: boolean;
  readonly executable?: boolean;
}

export type DocumentKernelRequest = { readonly kind: 'execute'; readonly code: string } | { readonly kind: 'restart' };
export type DocumentKernelOptions = { readonly runtimeId: string; readonly setupCommands: readonly string[] };
export type DocumentKernelHostRequest = DocumentKernelRequest & Partial<DocumentKernelOptions>;
export type DocumentKernelOutput =
  | { readonly output_type: 'stream'; readonly name: 'stdout' | 'stderr'; readonly text: string }
  | { readonly output_type: 'execute_result'; readonly data: Readonly<{ 'text/plain': string }>; readonly execution_count: number; readonly metadata: Readonly<Record<string, never>> }
  | { readonly output_type: 'display_data'; readonly data: Readonly<{ 'image/png': string }>; readonly metadata: Readonly<Record<string, never>> }
  | { readonly output_type: 'error'; readonly ename: string; readonly evalue: string; readonly traceback: readonly string[] };
export type DocumentKernelResult = { readonly ok: false; readonly code: string } |
  { readonly ok: true; readonly cellOk?: boolean; readonly executionCount?: number; readonly outputs?: readonly DocumentKernelOutput[] };

export type DocumentSaveResultDto = { readonly ok: true } | { readonly ok: false; readonly code: string };
export type DocumentAnalysisRequest =
  | { readonly kind: 'update'; readonly text: string; readonly revision: number }
  | { readonly kind: 'complete'; readonly revision: number; readonly line: number; readonly character: number };
export interface DocumentAnalysisDiagnostic {
  readonly line: number;
  readonly character: number;
  readonly severity: number;
  readonly message: string;
}
export interface DocumentAnalysisCompletion {
  readonly label: string;
  readonly insertText: string;
}
export interface DocumentNavigation {
  readonly providerId: string;
  readonly activeMode: string;
  readonly modes: readonly { readonly id: string; readonly label: string }[];
  readonly outlineLabel: string;
  readonly rows: readonly {
    readonly id: string;
    readonly label: string;
    readonly number: number;
    readonly tone: 'amber' | 'teal' | 'neutral';
  }[];
}
export interface DocumentNavigationPort {
  show(owner: string, value: DocumentNavigation, select: (id: string) => void, reveal: boolean): boolean;
  clear(): void;
}
export interface DocumentAnalysisPort {
  update(path: string, revision: number, text: string,
    diagnostics: (revision: number, items: readonly DocumentAnalysisDiagnostic[]) => void): void;
  complete(path: string, revision: number, line: number, character: number): Promise<readonly DocumentAnalysisCompletion[]>;
  close(path: string): void;
}
export interface DocumentReadRangeDto {
  readonly offset: number;
  readonly length: number;
}

export type DocumentReadDataDto = ArrayBuffer | ArrayBufferView;

export interface DocumentReadResultDto {
  readonly data: DocumentReadDataDto;
  readonly offset: number;
  readonly length: number;
  readonly eof: boolean;
}

export interface DocumentCloseResultDto {
  readonly closed: boolean;
}

/** Narrow renderer host capability for document views. */
export interface DocumentViewHost {
  loadDocumentView(pluginId: string, viewerId: string): Promise<LoadedDocumentViewDto>;
  loadLocalization(pluginId: string, locale: string): Promise<DocumentViewLocalizationDto>;
  openDocument(pluginId: string, viewerId: string, filePath: string): Promise<DocumentInfoDto>;
  readDocument(documentId: string, offset: number, length: number): Promise<DocumentReadResultDto>;
  saveDocument?(documentId: string, text: string): Promise<DocumentSaveResultDto>;
  executeDocument?(documentId: string, request: DocumentKernelHostRequest): Promise<DocumentKernelResult>;
  closeDocument(documentId: string): Promise<DocumentCloseResultDto>;
}

export interface SandboxedDocumentViewOptions {
  readonly container: Pick<HTMLElement, 'appendChild'>;
  readonly entry: VerifiedDocumentViewFileDto;
  readonly resources?: readonly VerifiedDocumentViewFileDto[];
  readonly document: DocumentInfoDto;
  readonly viewer: DocumentViewPublicDescriptorDto;
  readonly localization?: DocumentViewLocalizationDto;
  readonly theme?: DocumentViewThemeDto;
  readonly read: (
    range: DocumentReadRangeDto
  ) => DocumentReadResultDto | PromiseLike<DocumentReadResultDto>;
  readonly onError?: (error: Error) => void;
  readonly write?: (text: string) => Promise<DocumentSaveResultDto>;
  readonly onDirty?: (dirty: boolean) => void;
  readonly analyze?: (request: DocumentAnalysisRequest) => unknown;
  readonly execute?: (request: DocumentKernelRequest) => Promise<DocumentKernelResult>;
  readonly onNavigation?: (navigation: DocumentNavigation) => void;
  readonly onFocus?: () => void;
}

export interface SandboxedDocumentView extends Disposable {
  readonly element: HTMLIFrameElement;
  readonly ready: Promise<void>;
  show(): void;
  hide(): void;
  save?(): Promise<boolean>;
  diagnostics?(revision: number, items: readonly DocumentAnalysisDiagnostic[]): void;
  navigate?(id: string): void;
  updateLocalization(value: DocumentViewLocalizationDto): void;
  updateTheme(value: DocumentViewThemeDto): void;
}

export interface DocumentViewInstance {
  readonly path: string;
  readonly pluginId: string;
  readonly viewerId: string;
  readonly documentId: string;
  readonly error: HTMLElement;
  readonly sandbox: SandboxedDocumentView;
  disposed: boolean;
  dirty?: boolean;
  navigation?: DocumentNavigation;
}

export interface DocumentViewTabLike {
  readonly path: string;
  documentView?: DocumentViewInstance | null;
  dirty?: boolean;
}

export interface DocumentViewState {
  currentViewMode: string;
  readonly tabs: DocumentViewTabLike[];
}

export type DocumentViewSubscription = Disposable | Dispose | void;

export interface DocumentViewI18n {
  t(key: string, values?: Readonly<Record<string, string | number>>): string;
  getActive?(): string;
  onChange?(listener: () => void): DocumentViewSubscription;
}

export interface DocumentViewThemePort {
  snapshot(): DocumentViewThemeDto;
  onChange?(listener: () => void): DocumentViewSubscription;
}

export interface DocumentViewViewsPort {
  closeSplit?(): unknown;
  closeDiff?(): unknown;
  closeImagePreview?(): unknown;
}

export interface DocumentViewWorkspacePort {
  activateTab?(path: string): unknown;
  closeTab(path: string, options: Readonly<{ force: true }>): unknown;
}

export interface DocumentViewContributionChangeEventDto {
  readonly type: 'added' | 'removed';
  readonly owner: string;
  readonly id: string;
}

export type DocumentViewContributionChangeDto = DocumentViewContributionChangeEventDto;

export interface DocumentViewContributionPort {
  list(): readonly DocumentViewContributionEntryDto[];
  onDidChange(
    listener: (event: DocumentViewContributionChangeEventDto) => void
  ): Disposable;
}

export interface DocumentViewDependencies {
  readonly kernelOptions?: () => DocumentKernelOptions;
  readonly syncKernelWorkspace?: () => Promise<boolean>;
  readonly document: Document;
  readonly state: DocumentViewState;
  readonly i18n: DocumentViewI18n;
  readonly theme: DocumentViewThemePort;
  readonly views: DocumentViewViewsPort;
  readonly workspace: DocumentViewWorkspacePort;
  readonly contributions: DocumentViewContributionPort;
  readonly host: DocumentViewHost;
  readonly analysis?: DocumentAnalysisPort;
  readonly onDirty?: (path: string, dirty: boolean) => void;
  readonly onSave?: (path: string) => void;
  readonly navigation?: DocumentNavigationPort;
  readonly createSandboxedView?: (
    options: SandboxedDocumentViewOptions
  ) => SandboxedDocumentView;
}

export interface DocumentViewHideOptions {
  readonly restoreEditor?: boolean;
}

export interface DocumentViewService extends Disposable {
  init(): void;
  find(fileName: string): DocumentViewRegistrationDto | null;
  create(
    filePath: string,
    fileName: string,
    registration: DocumentViewRegistrationDto
  ): Promise<DocumentViewInstance>;
  show(tab: DocumentViewTabLike | null | undefined): boolean;
  setSplitVisibility(paths: readonly string[], activePath: string | null): void;
  hideAll(options?: DocumentViewHideOptions): void;
  disposeTab(tab: DocumentViewTabLike | null | undefined): void;
  disposeAll(): void;
  refreshLocalizations(): Promise<void>;
}
