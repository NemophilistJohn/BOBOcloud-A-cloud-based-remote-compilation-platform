import type { Disposable } from './lifecycle';

export interface RuntimeDefinitionDto {
  readonly runtimeId?: unknown;
  readonly id?: unknown;
  readonly language?: unknown;
  readonly version?: unknown;
  readonly displayName?: unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeListResponseWireDto {
  readonly success?: unknown;
  readonly runtimes?: unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeRequestMap {
  readonly listRuntimes: Record<string, never>;
}

export interface RuntimeResponseMap {
  readonly listRuntimes: RuntimeListResponseWireDto;
}

export type RuntimeActionDto = keyof RuntimeRequestMap;

export type RuntimeSendToServer = <Action extends RuntimeActionDto>(
  action: Action,
  payload: RuntimeRequestMap[Action],
  options: { readonly quiet: true }
) => Promise<RuntimeResponseMap[Action]>;

export interface RuntimeTabDto {
  readonly path?: unknown;
  readonly language?: unknown;
}

export interface RuntimeRendererState {
  selectedRuntime?: unknown;
  availableRuntimes?: RuntimeDefinitionDto[];
  groupedRuntimes?: Record<string, RuntimeDefinitionDto[]>;
  setupCommands?: unknown[];
  tabs?: RuntimeTabDto[];
  activeTabPath?: unknown;
  serverSettings?: {
    readonly ip?: unknown;
    readonly [key: string]: unknown;
  } | null;
}

export interface RuntimeStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RuntimeI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
}

export interface RuntimeLspPort {
  runtimeChanged?(): unknown;
}

export interface RuntimeRunConfigPort {
  refreshForActiveFile?(): unknown;
}

export interface RuntimeEnvironmentActivityPort {
  contextChanged?(reason: string): unknown;
}

export interface RuntimeToastPort {
  info?(message: string): unknown;
}

export interface RuntimeSelectionResultDto {
  readonly changed: boolean;
  readonly reason?: string;
  readonly runtimeId?: string;
  readonly usedLatest?: boolean;
}

export interface RuntimeHelpersFacade {
  canonicalLanguage(value: unknown): string;
  compareRuntimeVersions(left: unknown, right: unknown): number;
  latestRuntimeForLanguage(language: string): RuntimeDefinitionDto | null;
}

export interface RuntimeFacade {
  init(): void;
  fetchRuntimes(): Promise<void>;
  selectRuntime(runtimeId: string): boolean;
  autoSelectForLanguage(language: string): RuntimeSelectionResultDto;
  autoSelectForActiveFile(): RuntimeSelectionResultDto;
  readonly _helpers: RuntimeHelpersFacade;
}

export interface RuntimeDependencies {
  readonly document: Document;
  readonly storage: RuntimeStoragePort;
  readonly state: RuntimeRendererState;
  readonly sendToServer: RuntimeSendToServer;
  readonly getI18n: () => RuntimeI18nPort | null | undefined;
  readonly getLanguageDisplayName: () => ((language: string) => string) | null | undefined;
  readonly getLsp: () => RuntimeLspPort | null | undefined;
  readonly getRunConfig: () => RuntimeRunConfigPort | null | undefined;
  readonly getEnvironmentActivity: () => RuntimeEnvironmentActivityPort | null | undefined;
  readonly getToast: () => RuntimeToastPort | null | undefined;
  readonly updateRunOutput: (message: string) => unknown;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}

export interface RuntimeService extends RuntimeFacade, Disposable {
  readonly disposed: boolean;
}
