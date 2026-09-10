import type { Disposable } from './lifecycle';

export type RunOutputKnownPhase =
  | 'preparing'
  | 'syncing'
  | 'runtime'
  | 'dependencies'
  | 'workspace'
  | 'container'
  | 'compiling'
  | 'running'
  | 'artifacts'
  | 'analysis'
  | 'completed'
  | 'failed'
  | 'stopped';

/** Phase names supplied by the server may be extended without a client release. */
export type RunOutputPhase = RunOutputKnownPhase | (string & {});
export type RunOutputState = 'running' | 'completed' | 'failed' | 'stopped';

export interface RunOutputBeginOptionsDto {
  readonly target?: unknown;
  readonly label?: unknown;
  readonly runtime?: unknown;
}

export interface RunOutputUpdateOptionsDto {
  readonly kind?: 'program' | 'detail';
  readonly stage?: string;
  readonly raw?: string;
  readonly sessionId?: number;
  readonly streamFragment?: boolean;
  readonly streamKey?: string;
  readonly append?: boolean;
  readonly replace?: boolean;
  readonly outputPrefix?: string;
  readonly newline?: boolean;
}

export interface RunOutputDetailOptionsDto extends RunOutputUpdateOptionsDto {}

export interface RunOutputStatusDto {
  readonly type?: unknown;
  readonly stage?: unknown;
  readonly message?: unknown;
  readonly [key: string]: unknown;
}

export interface RunOutputFinishOptionsDto {
  readonly sessionId?: number;
  readonly cancelled?: boolean;
  readonly success?: boolean;
  readonly returnCode?: unknown;
  readonly message?: unknown;
}

export interface RunOutputI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
  onChange?(listener: (event: unknown) => void): Disposable | (() => void) | void;
}

export interface RunOutputOutputPort {
  updateRunOutput(message: string, options?: RunOutputUpdateOptionsDto): void;
  clearRunOutputDetails?(): void;
  refreshRunOutputOmission?(): void;
}

export interface RunOutputDependencies {
  readonly document: Document;
  readonly output: Readonly<RunOutputOutputPort>;
  readonly getI18n: () => RunOutputI18nPort | null | undefined;
}

export interface RunOutputFacade {
  init(): void;
  begin(options?: RunOutputBeginOptionsDto): number;
  detail(message: string, options?: RunOutputDetailOptionsDto): boolean;
  phase(
    name: RunOutputPhase,
    message?: string,
    options?: RunOutputDetailOptionsDto
  ): boolean;
  handleStatus(payload?: RunOutputStatusDto, sessionId?: number): boolean;
  finish(options?: RunOutputFinishOptionsDto): boolean;
  clear(): void;
  clearTranscript(): void;
  isActive(sessionId?: number): boolean;
  setDetailsVisible(visible: boolean): void;
  setPanelActive(value: boolean): void;
}

export interface RunOutputService extends RunOutputFacade, Disposable {
  readonly disposed: boolean;
}
