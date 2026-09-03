import type { Disposable, Dispose } from './lifecycle';

export type LanguagePackDirectionDto = 'ltr' | 'rtl';
export type LanguagePackSourceDto = 'builtin' | 'user';
export type LanguagePackMessagesDto = Readonly<Record<string, string>>;

export interface LanguagePackManifestDto {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly nativeName: string;
  readonly locale: string;
  readonly version: string;
  readonly direction: LanguagePackDirectionDto;
  readonly monacoLocale: string;
  readonly fallback: string;
}

export interface LanguagePackSummaryDto {
  readonly manifest: LanguagePackManifestDto;
  readonly source: LanguagePackSourceDto;
  readonly removable: boolean;
  readonly byteSize: number;
  readonly stale: boolean;
}

export interface LanguagePackDto extends LanguagePackSummaryDto {
  readonly messages: LanguagePackMessagesDto;
}

export interface LanguagePackErrorDto {
  readonly source: string;
  readonly directory: string;
  readonly error: string;
  readonly preserved?: boolean;
}

export interface LanguagePacksListDto {
  readonly activeId: string;
  readonly packs: readonly LanguagePackSummaryDto[];
  readonly errors: readonly LanguagePackErrorDto[];
}

export interface LanguagePacksStartupDto extends LanguagePacksListDto {
  readonly pack: LanguagePackDto | null;
}

export interface LanguagePacksChangedDto extends LanguagePacksListDto {
  readonly reason: string;
}

export interface LanguagePackInstallCanceledDto {
  readonly canceled: true;
}

export type LanguagePackInstallResultDto =
  | LanguagePacksStartupDto
  | LanguagePackInstallCanceledDto
  | null;

export interface LanguagePackOpenFolderResultDto {
  readonly success: true;
  readonly path: string;
}

export type LanguagePacksChangedListener = (change: LanguagePacksChangedDto) => void;
export interface LanguagePacksInvalidationHint {
  readonly reason?: 'filesystem';
}
export type LanguagePacksInvalidationListener = (hint: LanguagePacksInvalidationHint) => void;

export interface LanguagePacksHost {
  startup(): Promise<LanguagePacksStartupDto>;
  list(): Promise<LanguagePacksListDto | readonly LanguagePackSummaryDto[]>;
  load(id: string): Promise<LanguagePackDto>;
  setActive(id: string): Promise<LanguagePacksStartupDto>;
  install(): Promise<LanguagePackInstallResultDto>;
  remove(id: string): Promise<LanguagePacksStartupDto>;
  openFolder(): Promise<LanguagePackOpenFolderResultDto>;
  refresh(): Promise<LanguagePacksStartupDto>;
  onDidChange(listener: LanguagePacksInvalidationListener): Disposable;
}

export type I18nInterpolationParams = Readonly<Record<string, unknown>>;
export type I18nTranslatedAttribute = 'title' | 'aria-label' | 'placeholder';

export interface I18nTextBindingOptions {
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface I18nSnapshot {
  readonly initialized: boolean;
  readonly activeId: string;
  readonly pack: LanguagePackDto | null;
  readonly packs: readonly LanguagePackSummaryDto[];
  readonly errors: readonly LanguagePackErrorDto[];
  readonly monacoLocale: string;
}

export interface I18nChangeEvent extends I18nSnapshot {
  readonly reason: string;
}

export interface I18nLocaleSelectionResult {
  readonly snapshot: I18nSnapshot;
  readonly editorReloadRecommended: boolean;
}

export type I18nChangeListener = (event: I18nChangeEvent) => void;

export interface I18nToast {
  info(message: string): void;
}

export interface I18nLogger {
  error(message?: unknown, ...values: unknown[]): void;
}

export interface I18nServiceDependencies {
  readonly host?: LanguagePacksHost | null;
  readonly document: Document;
  readonly eventTarget: Pick<Window, 'dispatchEvent'>;
  readonly createMutationObserver?: (callback: MutationCallback) => MutationObserver;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (timer: number) => void;
  readonly getToast?: () => I18nToast | null | undefined;
  readonly logger?: I18nLogger;
}

export interface I18nService extends Disposable {
  readonly disposed: boolean;
  init(): Promise<I18nSnapshot>;
  t(source: unknown, params?: I18nInterpolationParams | null): string;
  bindText<ElementType extends Element>(
    element: ElementType | null | undefined,
    source: unknown,
    params?: I18nInterpolationParams | null,
    options?: I18nTextBindingOptions
  ): ElementType | null | undefined;
  bindAttribute<ElementType extends Element>(
    element: ElementType | null | undefined,
    attribute: I18nTranslatedAttribute,
    source: unknown,
    params?: I18nInterpolationParams | null
  ): ElementType | null | undefined;
  unbind<ElementType extends Element>(
    element: ElementType | null | undefined,
    attribute?: I18nTranslatedAttribute
  ): ElementType | null | undefined;
  apply(): void;
  listPacks(): Promise<readonly LanguagePackSummaryDto[]>;
  getActive(): string;
  getErrors(): readonly LanguagePackErrorDto[];
  getSnapshot(): I18nSnapshot;
  getMonacoLocale(): string;
  setLocale(id: string): Promise<I18nLocaleSelectionResult>;
  install(): Promise<LanguagePackInstallResultDto>;
  remove(id: string): Promise<LanguagePacksStartupDto>;
  openFolder(): Promise<LanguagePackOpenFolderResultDto>;
  refresh(): Promise<I18nSnapshot>;
  onChange(listener: I18nChangeListener): Dispose;
}
