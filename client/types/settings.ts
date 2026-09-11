import type { DiagnosticsBasicSettingsUpdateDto } from './diagnostics';
import type { I18nService } from './i18n';
import type { LanguagePacksPanelFacade } from './language-packs-panel';
import type { Disposable } from './lifecycle';
import type { RcloneSettingsFacade } from './rclone';
import type { ThemeDescriptorDto, ThemeManagerFacade } from './theme';
import type { ToastFacade } from './toast';
import type { WorkbenchLayoutFacade } from './workbench-layout';

/** Tabs understood by the settings shell. Unknown values remain accepted for
 * compatibility with extensions and older deep links. */
export type SettingsTabDto = string;

/**
 * Server settings are normalized by the main-process settings store, but the
 * renderer still receives this object through a legacy state channel. Keep
 * fields as unknown at this boundary and let the settings view apply its
 * display defaults without pretending the wire payload is trusted.
 */
export interface SettingsServerSettingsDto {
  readonly ip?: unknown;
  readonly user?: unknown;
  readonly pass?: unknown;
  readonly apiKey?: unknown;
  readonly httpPort?: unknown;
  readonly wsPort?: unknown;
  readonly dapChildWsPort?: unknown;
  readonly secureTransport?: unknown;
  readonly certificateFingerprint?: unknown;
  readonly certificateFingerprints?: readonly unknown[];
  readonly syncInterval?: unknown;
  readonly firstRunRequired?: unknown;
  readonly setupCompleted?: unknown;
  readonly [key: string]: unknown;
}

/** The small diagnostics projection read by the local-settings pane. */
export interface SettingsDiagnosticsStateDto {
  readonly enabled?: unknown;
  readonly checkOn?: unknown;
  readonly [key: string]: unknown;
}

export type SettingsAiPurposeDto = 'chat' | 'inline';
export type SettingsAiInlineModeDto = 'chat' | 'fim' | (string & {});

/** A normalized legacy AI profile displayed by the settings center. */
export interface SettingsAiModelDto {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly modelId: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly inlineEndpoint?: string;
  readonly inlineModelId?: string;
  readonly inlineMode?: SettingsAiInlineModeDto;
  readonly isPreset?: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** Mutable values accepted by the compatibility add/update methods. */
export interface SettingsAiModelUpdateDto {
  readonly id?: string;
  readonly name?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly inlineEndpoint?: string;
  readonly inlineModelId?: string;
  readonly inlineMode?: SettingsAiInlineModeDto;
  readonly isPreset?: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface SettingsAiModelInputDto extends SettingsAiModelUpdateDto {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly modelId: string;
  readonly endpoint: string;
}

export interface SettingsAiFieldOptionDto {
  readonly value: string;
  readonly label: string;
}

export interface SettingsAiFieldOptions {
  readonly type?: string;
  readonly readOnly?: boolean;
  readonly select?: readonly SettingsAiFieldOptionDto[];
}

export interface SettingsAiFieldResult {
  readonly root: HTMLLabelElement;
  readonly input: HTMLInputElement | HTMLSelectElement;
}

/** Compatibility aliases mirrored by ai-service.js on renderer state. */
export interface SettingsAiStateDto {
  readonly models: readonly SettingsAiModelDto[];
  readonly chatModel?: string;
  readonly inlineModel?: string;
  readonly inlineEnabled?: boolean;
  readonly inlineDebounceMs?: number;
  readonly chatSystemPrompt?: string;
  readonly inlineInstruction?: string;
  readonly inlinePrefixChars?: number;
  readonly inlineSuffixChars?: number;
  readonly inlineMaxTokens?: number;
  readonly [key: string]: unknown;
}

export type SettingsAiStatusStateDto =
  | 'missing'
  | 'invalid'
  | 'needs-key'
  | 'complete'
  | 'untested'
  | 'testing'
  | 'ready'
  | 'error'
  | 'disabled'
  | (string & {});

export interface SettingsAiStatusDto {
  readonly state: SettingsAiStatusStateDto;
  readonly code: string;
  readonly detail?: unknown;
  readonly fingerprint?: string;
  readonly checkedAt?: number;
  readonly testNonce?: number;
  readonly [key: string]: unknown;
}

/** Result envelope returned by AI profile mutations and connection probes. */
export interface SettingsAiResultDto {
  readonly success?: boolean;
  readonly failed?: boolean;
  readonly code?: string;
  readonly detail?: unknown;
  readonly health?: SettingsAiStatusDto | null;
  readonly [key: string]: unknown;
}

/** Narrow AI surface used by the legacy AI section in this shell. */
export interface SettingsAiServicePort {
  getModelStatus(
    model: SettingsAiModelDto | null | undefined,
    purpose: SettingsAiPurposeDto
  ): SettingsAiStatusDto;
  getModelFor(purpose: SettingsAiPurposeDto): SettingsAiModelDto | null;
  testModelConnection(
    model: SettingsAiModelDto | null | undefined,
    purpose: SettingsAiPurposeDto
  ): Promise<SettingsAiResultDto>;
  removeModel(id: string): Promise<SettingsAiResultDto>;
  updateModel(id: string, updates: SettingsAiModelUpdateDto): Promise<SettingsAiResultDto>;
  addModel(value: SettingsAiModelInputDto): Promise<SettingsAiResultDto>;
  addModel(
    name: string,
    provider?: string,
    endpoint?: string,
    modelId?: string,
    apiKey?: string
  ): Promise<SettingsAiResultDto>;
}

export interface SettingsAiSettingsCenterPort {
  open(tab?: string): unknown;
}

/** Translation methods used by the settings view (binding methods are optional
 * because the legacy fallback only provides t()). */
export interface SettingsI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
  bindText?: I18nService['bindText'];
  bindAttribute?: I18nService['bindAttribute'];
}

export interface SettingsThemePort extends Pick<
  ThemeManagerFacade,
  'listThemes' | 'getCurrentTheme' | 'applyTheme'
> {}

export interface SettingsToastPort extends Pick<ToastFacade, 'success'> {}

export interface SettingsDiagnosticsPort {
  updateBasic(
    update: DiagnosticsBasicSettingsUpdateDto | Readonly<Record<string, unknown>>
  ): Promise<boolean> | boolean;
}

export interface SettingsRclonePort extends Pick<RcloneSettingsFacade, 'open' | 'close'> {}

export interface SettingsWorkbenchPort extends Pick<WorkbenchLayoutFacade, 'refreshControls'> {}

export interface SettingsLanguagePacksPort extends Pick<LanguagePacksPanelFacade, 'refresh'> {}

export interface SettingsLspPort {
  renderStatus(): unknown;
}

/** Browser APIs needed by the settings shell, isolated for deterministic tests. */
export interface SettingsWindowPort {
  getComputedStyle(element: Element): Pick<
    CSSStyleDeclaration,
    'display' | 'visibility' | 'opacity'
  >;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timer: number): void;
}

export interface SettingsLogger {
  error(message?: unknown, ...values: unknown[]): void;
}

/** Mutable state projection consumed by settings; other state keys stay private. */
export interface SettingsRendererState {
  serverSettings: SettingsServerSettingsDto | null;
  diagnosticsSettings: SettingsDiagnosticsStateDto | null | undefined;
  ai: SettingsAiStateDto;
  readonly [key: string]: unknown;
}

export interface SettingsDependencies {
  readonly document: Document;
  readonly window: SettingsWindowPort;
  readonly state: SettingsRendererState;
  readonly getI18n: () => SettingsI18nPort | null | undefined;
  readonly getThemeManager: () => SettingsThemePort | null | undefined;
  readonly getToast: () => SettingsToastPort | null | undefined;
  readonly getDiagnosticsSettings: () => SettingsDiagnosticsPort | null | undefined;
  readonly getRcloneSettings: () => SettingsRclonePort | null | undefined;
  readonly getWorkbench: () => SettingsWorkbenchPort | null | undefined;
  readonly getLanguagePacksPanel: () => SettingsLanguagePacksPort | null | undefined;
  readonly getLsp: () => SettingsLspPort | null | undefined;
  readonly getAiService: () => SettingsAiServicePort | null | undefined;
  readonly getAiSettingsCenter: () => SettingsAiSettingsCenterPort | null | undefined;
  readonly logger?: SettingsLogger;
}

/** Historical writable BOBO.settings projection. Keep this surface closed. */
export interface SettingsFacade {
  init(): void;
  open(tab?: SettingsTabDto): void;
  close(): void;
  openFirstRun(): boolean;
  finishFirstRun(): void;
  isFirstRunOpen(): boolean;
}

export interface SettingsService extends SettingsFacade, Disposable {
  readonly disposed: boolean;
}

/** Theme DTO is re-exported here for consumers that render the settings list. */
export type SettingsThemeDescriptorDto = ThemeDescriptorDto;
