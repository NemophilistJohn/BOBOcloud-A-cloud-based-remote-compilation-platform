import type { I18nService } from './i18n';
import type { Disposable } from './lifecycle';

export type RcloneBinarySourceDto = 'bundled' | 'system';

export interface RcloneBundledSelectionDto {
  readonly source: 'bundled';
  readonly path: null;
  readonly version: null;
}

export interface RcloneSystemSelectionDto {
  readonly source: 'system';
  readonly path: string;
  readonly version: string;
  readonly confirmedAt: number | null;
}

export type RcloneSelectionDto =
  | RcloneBundledSelectionDto
  | RcloneSystemSelectionDto;

export interface RcloneBundledCandidateDto {
  readonly id: string;
  readonly source: 'bundled';
  readonly path: null;
  readonly selected: boolean;
}

export interface RcloneSystemCandidateDto {
  readonly id: string;
  readonly source: 'system';
  readonly path: string;
  readonly selected: boolean;
}

export type RcloneBinaryCandidateDto =
  | RcloneBundledCandidateDto
  | RcloneSystemCandidateDto;

export interface RcloneBinaryScanDto {
  readonly scanId: string;
  readonly selection: RcloneSelectionDto;
  readonly candidates: readonly RcloneBinaryCandidateDto[];
}

export interface RcloneSelectBinaryRequestDto {
  readonly scanId: string;
  readonly candidateId: string;
}

export interface RcloneAvailableVersionDto {
  readonly available: true;
  readonly path: string | null;
  readonly source: RcloneBinarySourceDto;
  readonly version: string;
  readonly revision?: string;
}

export interface RcloneUnavailableVersionDto {
  readonly available: false;
  readonly path: string | null;
  readonly source: RcloneBinarySourceDto;
  readonly error: string;
  readonly code?: string | number | null;
  readonly revision?: string;
}

export type RcloneVersionResultDto =
  | RcloneAvailableVersionDto
  | RcloneUnavailableVersionDto;

export interface RcloneSelectBinaryCancelledDto {
  readonly cancelled: true;
  readonly selection: RcloneSelectionDto;
}

export interface RcloneSelectBinarySuccessDto {
  readonly cancelled: false;
  readonly selection: RcloneSelectionDto;
  readonly version: RcloneAvailableVersionDto;
  readonly configurationError?: string;
}

export type RcloneSelectBinaryResultDto =
  | RcloneSelectBinaryCancelledDto
  | RcloneSelectBinarySuccessDto;

export interface RcloneConnectionErrorDto {
  readonly type: string;
  readonly message: string;
  readonly exitCode?: number | null;
}

export interface RcloneConnectionSuccessDto {
  readonly success: true;
}

export interface RcloneConnectionFailureDto {
  readonly success: false;
  readonly error: RcloneConnectionErrorDto;
  readonly stats?: Readonly<{ durationMs: number }>;
}

export type RcloneConnectionResultDto =
  | RcloneConnectionSuccessDto
  | RcloneConnectionFailureDto;

export interface RcloneRendererState {
  workspaceRoot?: string;
  workspaceIdentity?: unknown;
}

export interface RcloneOperationOptions {
  src?: string;
  dest?: string;
  localGrant?: string;
  remoteGrantId?: string;
  onProgress?: (line: unknown) => void;
}

export interface RcloneClient {
  prepareWorkspace(request?: unknown, options?: RcloneOperationOptions | null): Promise<unknown>;
  prepareTeamPull(request?: unknown, options?: RcloneOperationOptions | null): Promise<unknown>;
  sync(options?: RcloneOperationOptions | null): Promise<unknown>;
  pull(options?: RcloneOperationOptions | null): Promise<unknown>;
  cancel(operationId: string): Promise<unknown>;
  cancelAll(reason?: string): Promise<unknown>;
  listBinaries(): Promise<RcloneBinaryScanDto>;
  getSelection(): Promise<RcloneSelectionDto>;
  selectBinary(scanId: string, candidateId: string): Promise<RcloneSelectBinaryResultDto>;
  checkVersion(): Promise<RcloneVersionResultDto>;
  validateConnection(): Promise<RcloneConnectionResultDto>;
}

export type RcloneSettingsClientPort = Pick<
  RcloneClient,
  'listBinaries' | 'getSelection' | 'selectBinary' | 'checkVersion'
>;

export interface RcloneSettingsI18n {
  readonly t?: I18nService['t'];
  readonly onChange?: I18nService['onChange'];
}

export interface RcloneSettingsWindow {
  readonly innerHeight: number;
  addEventListener(type: 'resize', listener: EventListener): void;
  removeEventListener(type: 'resize', listener: EventListener): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export interface RcloneSettingsDependencies {
  readonly document: Document;
  readonly window: RcloneSettingsWindow;
  readonly client: RcloneSettingsClientPort;
  readonly getI18n: () => RcloneSettingsI18n | null | undefined;
}

export interface RcloneSettingsFacade {
  initialize(): void;
  open(): Promise<void>;
  close(): void;
  refreshStatus(): Promise<RcloneVersionResultDto | null>;
}

export interface RcloneSettingsService extends RcloneSettingsFacade, Disposable {
  readonly disposed: boolean;
}
