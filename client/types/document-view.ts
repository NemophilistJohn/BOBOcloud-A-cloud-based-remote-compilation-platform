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
}

export interface SandboxedDocumentView extends Disposable {
  readonly element: HTMLIFrameElement;
  readonly ready: Promise<void>;
  show(): void;
  hide(): void;
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
}

export interface DocumentViewTabLike {
  readonly path: string;
  documentView?: DocumentViewInstance | null;
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
  readonly document: Document;
  readonly state: DocumentViewState;
  readonly i18n: DocumentViewI18n;
  readonly theme: DocumentViewThemePort;
  readonly views: DocumentViewViewsPort;
  readonly workspace: DocumentViewWorkspacePort;
  readonly contributions: DocumentViewContributionPort;
  readonly host: DocumentViewHost;
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
  hideAll(options?: DocumentViewHideOptions): void;
  disposeTab(tab: DocumentViewTabLike | null | undefined): void;
  disposeAll(): void;
  refreshLocalizations(): Promise<void>;
}
