import type { Disposable } from './lifecycle';

export interface RunConfigRawDto {
  readonly compile: string;
  readonly run: string;
  readonly target: string;
}

export interface RunConfigArgsDto {
  readonly compileArgs: string[];
  readonly runArgs: string[];
  readonly buildTarget: string;
}

export interface RunConfigTargetDto {
  readonly id: string;
  readonly os: string;
  readonly architecture: string;
  readonly environment: string;
  readonly outputPath?: string;
  readonly runnable?: boolean;
  readonly [key: string]: unknown;
}

export interface RunConfigTargetMetaDto {
  readonly label?: string;
  readonly toolchain?: string;
}

export interface RunConfigTargetListResponseDto {
  readonly success?: unknown;
  readonly buildTargets?: unknown;
  readonly [key: string]: unknown;
}

export interface RunConfigRequestMap {
  readonly listBuildTargets: {
    readonly language: string;
    readonly runtime: string;
  };
}

export interface RunConfigResponseMap {
  readonly listBuildTargets: RunConfigTargetListResponseDto;
}

export type RunConfigActionDto = keyof RunConfigRequestMap;
export type RunConfigSendToServer = <Action extends RunConfigActionDto>(
  action: Action,
  payload: RunConfigRequestMap[Action],
  options: { readonly quiet: true }
) => Promise<RunConfigResponseMap[Action]>;

export interface RunConfigTabDto {
  readonly path?: unknown;
}

export interface RunConfigRendererState {
  workspaceRoot?: unknown;
  selectedRuntime?: unknown;
  tabs?: RunConfigTabDto[];
  activeTabPath?: unknown;
}

export interface RunConfigStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RunConfigI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
  onChange?(listener: (event: unknown) => void): Disposable | (() => void) | void;
}

export interface RunConfigWindowPort {
  readonly innerWidth: number;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timer: number): void;
}

export interface RunConfigDependencies {
  readonly document: Document;
  readonly window: RunConfigWindowPort;
  readonly storage: RunConfigStoragePort;
  readonly state: RunConfigRendererState;
  readonly sendToServer?: RunConfigSendToServer;
  readonly getI18n: () => RunConfigI18nPort | null | undefined;
}

export interface RunConfigFacade {
  init(): void;
  languageForFile(filePath: unknown): string | null;
  getArgs(language: string): RunConfigArgsDto;
  describeTarget(id: string): string;
  refreshForActiveFile(): void;
  close(): void;
  _splitArgs(value: unknown): string[];
}

export interface RunConfigService extends RunConfigFacade, Disposable {
  readonly disposed: boolean;
}
