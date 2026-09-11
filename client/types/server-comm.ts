import type { Disposable } from './lifecycle';
import type { ServerTransportService } from './server-runtime';

/** Server actions are intentionally open: collaboration and server plugins can
 * add actions without requiring a renderer release. */
export type ServerCommActionDto = string;

export type ServerCommOutputKind = 'program' | 'detail';

/** Options accepted by the historical BOBO.updateRunOutput facade. */
export interface ServerCommOutputUpdateOptionsDto {
  readonly kind?: ServerCommOutputKind;
  readonly stage?: string;
  readonly raw?: string;
  readonly streamFragment?: boolean;
  readonly streamKey?: string;
  readonly append?: boolean;
  readonly replace?: boolean;
  readonly outputPrefix?: string;
  readonly newline?: boolean;
  readonly [key: string]: unknown;
}

/** Transport controls for a server action. */
export interface ServerCommRequestOptionsDto {
  readonly quiet?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: ServerCommAbortSignal | null;
  readonly [key: string]: unknown;
}

export interface ServerCommAbortSignal {
  readonly aborted: boolean;
  addEventListener?(
    type: 'abort',
    listener: () => void,
    options?: Readonly<{ once?: boolean }>
  ): void;
  removeEventListener?(
    type: 'abort',
    listener: () => void
  ): void;
}

export interface ServerCommAbortController {
  readonly signal: ServerCommAbortSignal;
  abort(): void;
}

export interface ServerCommResponseHeaders {
  get(name: string): string | null;
}

/** Minimal fetch response used by the renderer and by isolated VM fixtures. */
export interface ServerCommFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: ServerCommResponseHeaders;
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

export interface ServerCommFetchInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: ServerCommAbortSignal;
}

export type ServerCommFetch = (
  url: string,
  init: ServerCommFetchInit
) => Promise<ServerCommFetchResponse>;

/** Open response envelope. Action-specific DTOs remain owned by each module. */
export interface ServerCommResponseEnvelopeDto {
  readonly success?: unknown;
  readonly error?: unknown;
  readonly errorCode?: unknown;
  readonly status?: unknown;
  readonly retryAfterSeconds?: unknown;
  readonly [key: string]: unknown;
}

export interface ServerCommServerSettingsDto {
  readonly ip?: unknown;
  readonly apiKey?: unknown;
  readonly [key: string]: unknown;
}

export interface ServerCommAuthStatePort {
  readonly token?: unknown;
  readonly [key: string]: unknown;
}

export interface ServerCommEditorPort {
  revealLineInCenter(line: number): unknown;
  setPosition(position: { readonly lineNumber: number; readonly column: number }): unknown;
}

export interface ServerCommWorkspacePort {
  openFile(path: string, name: string): unknown;
}

export interface ServerCommAuthPort {
  handleAuthExpired?(): unknown;
}

export interface ServerCommRunOutputPort {
  clearTranscript?(): unknown;
}

export interface ServerCommI18nPort {
  t(source: string, replacements?: Readonly<Record<string, unknown>>): string;
}

/** Mutable state projection consumed by the legacy transcript and transport. */
export interface ServerCommRendererState {
  serverSettings?: ServerCommServerSettingsDto | null;
  auth?: ServerCommAuthStatePort | null;
  workspaceRoot?: unknown;
  editor?: ServerCommEditorPort | null;
  runLogInitialized?: boolean;
  runSessionTimestamp?: unknown;
  showTimestampNextLine?: boolean;
  autoScrollEnabled?: boolean;
  readonly [key: string]: unknown;
}

export type ServerCommTimer = ReturnType<typeof setTimeout>;

/** Host ports keep DOM/global access at the compatibility boundary. */
export interface ServerCommDependencies {
  readonly document: Document;
  readonly getState: () => ServerCommRendererState | null | undefined;
  readonly getI18n: () => ServerCommI18nPort | null | undefined;
  readonly getTransport: () => ServerTransportService | null | undefined;
  readonly getWorkspace: () => ServerCommWorkspacePort | null | undefined;
  readonly getAuth: () => ServerCommAuthPort | null | undefined;
  readonly getRunOutput: () => ServerCommRunOutputPort | null | undefined;
  readonly getLocalPathSeparator: (workspaceRoot: unknown) => string;
  readonly fetch: ServerCommFetch;
  readonly createAbortController: () => ServerCommAbortController | null;
  readonly setTimeout: (callback: () => void, delayMs: number) => ServerCommTimer;
  readonly clearTimeout: (timer: ServerCommTimer) => void;
}

/** Historical five-key writable BOBO projection. */
export interface ServerCommFacade {
  updateRunOutput(message: unknown, options?: ServerCommOutputUpdateOptionsDto): void;
  clearRunOutput(): void;
  clearRunOutputDetails(): void;
  refreshRunOutputOmission(): void;
  sendToServer(
    action: ServerCommActionDto,
    data?: Readonly<Record<string, unknown>>,
    options?: ServerCommRequestOptionsDto
  ): Promise<ServerCommResponseEnvelopeDto | null>;
}

export interface ServerCommService extends ServerCommFacade, Disposable {
  readonly disposed: boolean;
}
