import type { ConfirmFacade } from './confirm-dialog';
import type { Disposable, Dispose } from './lifecycle';

/**
 * User data returned by the authenticated account endpoints.  The renderer
 * deliberately treats fields as untrusted at this boundary: older servers
 * may omit fields and a malformed response must not become a second source of
 * truth for the auth store.
 */
export interface AccountProfileUserDto {
  readonly id?: unknown;
  readonly uid?: unknown;
  readonly avatar?: unknown;
  readonly username?: unknown;
  readonly email?: unknown;
  readonly name?: unknown;
  readonly role?: unknown;
  readonly created_at?: unknown;
  readonly [key: string]: unknown;
}

export interface AccountProfileAuthState {
  token?: unknown;
  user: AccountProfileUserDto | null;
  readonly [key: string]: unknown;
}

/** Mutable auth projection consumed by the profile view. */
export interface AccountProfileRendererState {
  auth?: AccountProfileAuthState | null;
  readonly [key: string]: unknown;
}

export interface AccountProfileActivityDayWireDto {
  readonly date?: unknown;
  readonly count?: unknown;
  readonly [key: string]: unknown;
}

export interface AccountProfileActivityDataWireDto {
  readonly timezone?: unknown;
  readonly from?: unknown;
  readonly through?: unknown;
  readonly days?: unknown;
  readonly [key: string]: unknown;
}

export interface AccountProfileResponseWireDto {
  readonly success?: unknown;
  readonly error?: unknown;
  readonly data?: AccountProfileActivityDataWireDto | null;
  readonly user?: AccountProfileUserDto | null;
  readonly [key: string]: unknown;
}

export interface AccountProfileServerRequestMap {
  readonly getCompileActivity: Record<string, never>;
  readonly updateProfile: Readonly<{ name: string; avatar: string }>;
}

export interface AccountProfileServerResponseMap {
  readonly getCompileActivity: AccountProfileResponseWireDto;
  readonly updateProfile: AccountProfileResponseWireDto;
}

export type AccountProfileServerActionDto = keyof AccountProfileServerRequestMap;

export type AccountProfileSendToServer = <Action extends AccountProfileServerActionDto>(
  action: Action,
  payload: AccountProfileServerRequestMap[Action],
  options: Readonly<{ quiet: true }>
) => Promise<AccountProfileServerResponseMap[Action]>;

export type AccountProfileTabDto = string;

export interface AccountProfileI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
  getActive?(): string;
  onChange?(listener: () => void): Dispose;
}

export interface AccountProfileToastPort {
  info?(message: string): void;
  error?(message: string): void;
  success?(message: string): void;
}

export interface AccountProfileAuthPort {
  openAuthModal?(notice?: string): unknown;
  renderChip?(): unknown;
}

export interface AccountProfileCollaborationPort {
  openProfile?: (tab?: AccountProfileTabDto) => void;
}

export interface AccountProfileClipboardPort {
  writeText(value: string): Promise<void>;
}

export interface AccountProfileImagePort {
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

export interface AccountProfileLogger {
  error(message?: unknown, ...values: unknown[]): void;
}

export interface AccountProfileDependencies {
  readonly document: Document;
  readonly state: AccountProfileRendererState;
  readonly sendToServer: AccountProfileSendToServer;
  readonly getI18n: () => AccountProfileI18nPort | null | undefined;
  readonly getToast: () => AccountProfileToastPort | null | undefined;
  readonly getAuth: () => AccountProfileAuthPort | null | undefined;
  readonly getConfirm: () => AccountProfileConfirmPort | null | undefined;
  readonly getCollaboration: () => AccountProfileCollaborationPort | null | undefined;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (timer: number) => void;
  readonly createObjectURL: (file: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly createImage: () => AccountProfileImagePort;
  readonly clipboard?: AccountProfileClipboardPort | null;
  readonly logger?: AccountProfileLogger;
}

export type AccountProfileConfirmPort = ConfirmFacade;

/** Historical five-key BOBO projection. */
export interface AccountProfileFacade {
  init(): void;
  open(tab?: AccountProfileTabDto): void;
  close(): Promise<void>;
  reset(): void;
  renderActivity(): void;
}

export interface AccountProfileService extends AccountProfileFacade, Disposable {
  readonly disposed: boolean;
}

