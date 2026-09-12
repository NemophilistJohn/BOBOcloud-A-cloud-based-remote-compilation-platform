import type {
  AgentAccessModeDto,
  AgentApprovalResultDto,
  AgentApprovalToolDto,
  AgentCommandPayloadDto,
  AgentCommandValuesRegistrationDto,
  AgentEffectiveReasoningEffortDto,
  AgentMessageDto,
  AgentModeDto,
  AgentObservedStatePatchDto,
  AgentReasoningEffortDto,
  AgentSessionStatusDto,
  AgentStateChangeEvent,
  AgentStateChangeListener,
  AgentStateDto,
  AgentStateSnapshot,
  AgentTimelineItemDto
} from './agent';
import type { ConfirmFacade } from './confirm-dialog';
import type { Dispose, Disposable } from './lifecycle';
import type {
  RendererPlatformAgentsFacade,
  RendererPlatformCommandsFacade
} from './platform-adapter';
import type { RendererState } from './state';
import type { WorkbenchLayoutFacade } from './workbench-layout';
import type { CommandExecutionResult } from '../renderer/core/command-registry';

/** Stable identifier used by the trusted renderer service registry. */
export type AgentWorkbenchServiceId = 'workbench.agentWorkbench';

/** Stable identifier used by the trusted renderer host service registry. */
export type AgentWorkbenchHostServiceId = 'host.agentWorkbench';

/** A provider/session identity used by the host-owned access-mode broker. */
export interface AgentWorkbenchAccessIdentityDto {
  readonly pluginId: string;
  readonly providerId: string;
  readonly sessionId: string;
}

export interface AgentWorkbenchAccessSetRequestDto
  extends AgentWorkbenchAccessIdentityDto {
  readonly accessMode: AgentAccessModeDto;
  readonly confirmed: boolean;
}

export interface AgentWorkbenchAccessResponseDto
  extends AgentWorkbenchAccessIdentityDto {
  readonly accessMode: AgentAccessModeDto;
}

/** Request sent to describe, decide, or cancel one host approval. */
export interface AgentWorkbenchApprovalRequestDto {
  readonly pluginId: string;
  readonly approvalId: string;
}

export interface AgentWorkbenchApprovalDecisionRequestDto
  extends AgentWorkbenchApprovalRequestDto {
  readonly approved: boolean;
}

export type AgentWorkbenchApprovalRiskDto =
  | 'execute'
  | 'network'
  | 'read'
  | 'write';

export interface AgentWorkbenchWorkspaceWriteApprovalDetailsDto {
  readonly path: string;
  readonly bytes: number;
  readonly expectedSha256: string;
  readonly contentPreview: string;
  readonly contentTruncated: boolean;
}

export interface AgentWorkbenchProcessApprovalDetailsDto {
  readonly command: string;
  readonly resolvedExecutable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** Canonical detail returned by the main-process approval broker. */
export interface AgentWorkbenchWorkspaceWriteApprovalDetailDto {
  readonly approvalId: string;
  readonly tool: 'workspace_write';
  readonly summary: string;
  readonly risk: AgentWorkbenchApprovalRiskDto;
  readonly expiresAt: string;
  readonly details: AgentWorkbenchWorkspaceWriteApprovalDetailsDto;
}

export interface AgentWorkbenchProcessApprovalDetailDto {
  readonly approvalId: string;
  readonly tool: 'process_run';
  readonly summary: string;
  readonly risk: AgentWorkbenchApprovalRiskDto;
  readonly expiresAt: string;
  readonly details: AgentWorkbenchProcessApprovalDetailsDto;
}

export type AgentWorkbenchApprovalDetailDto =
  | AgentWorkbenchWorkspaceWriteApprovalDetailDto
  | AgentWorkbenchProcessApprovalDetailDto;

/** Common broker metadata present on an approval description response. */
interface AgentWorkbenchApprovalDetailWireBase {
  readonly approvalId: string;
  readonly summary: string;
  readonly risk: AgentWorkbenchApprovalRiskDto;
  readonly riskLevel?: string;
  readonly accessMode?: AgentAccessModeDto;
  readonly permission?: string;
  readonly expiresAt: string;
}

/** Wire detail for a write operation.  The hash is absent for a new file. */
export interface AgentWorkbenchWorkspaceWriteApprovalDetailWireDto
  extends AgentWorkbenchApprovalDetailWireBase {
  readonly tool: 'workspace_write';
  readonly details: Omit<
    AgentWorkbenchWorkspaceWriteApprovalDetailsDto,
    'expectedSha256'
  > & { readonly expectedSha256?: string };
}

/** Wire detail for an allow-listed process operation. */
export interface AgentWorkbenchProcessApprovalDetailWireDto
  extends AgentWorkbenchApprovalDetailWireBase {
  readonly tool: 'process_run';
  readonly details: AgentWorkbenchProcessApprovalDetailsDto;
}

/**
 * The wire shape includes broker metadata that the renderer currently does
 * not display.  Keeping it here makes the adapter lossless while allowing the
 * view to consume the smaller canonical detail DTO above.
 */
export type AgentWorkbenchApprovalDetailWireDto =
  | AgentWorkbenchWorkspaceWriteApprovalDetailWireDto
  | AgentWorkbenchProcessApprovalDetailWireDto;

export type AgentWorkbenchApprovalUnavailableCodeDto =
  | 'AGENT_APPROVAL_EXPIRED'
  | 'AGENT_APPROVAL_NOT_FOUND';

export interface AgentWorkbenchApprovalUnavailableDto {
  readonly approvalUnavailable: true;
  readonly errorCode: AgentWorkbenchApprovalUnavailableCodeDto;
  readonly errorMessage: string;
  readonly tool?: AgentApprovalToolDto;
}

export interface AgentWorkbenchApprovalCancelResultDto {
  readonly cancelled: boolean;
}

/** Result returned by the broker after an approval decision. */
export interface AgentWorkbenchApprovalResultWireDto {
  readonly approved?: boolean;
  readonly rejected?: boolean;
  readonly tool?: AgentApprovalToolDto;
  readonly path?: string;
  readonly sha256?: string;
  readonly exitCode?: number | null;
  readonly signal?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly failed?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly outcome?: 'not-started' | 'unknown';
  readonly mayHaveExecuted?: boolean;
  readonly autoApproved?: boolean;
  readonly accessMode?: AgentAccessModeDto;
  readonly riskLevel?: string;
}

export type AgentWorkbenchApprovalDescribeResponseDto =
  | AgentWorkbenchApprovalDetailWireDto
  | AgentWorkbenchApprovalUnavailableDto;

export type AgentWorkbenchApprovalDecisionResponseDto =
  | AgentWorkbenchApprovalResultWireDto
  | AgentWorkbenchApprovalUnavailableDto;

export type AgentWorkbenchApprovalResultDto = AgentApprovalResultDto;

/** Mutable per-provider controls retained by the compatibility view. */
export interface AgentWorkbenchPreferenceDto {
  sessionId: string;
  mode: AgentModeDto;
  reasoningEffort: AgentReasoningEffortDto;
  accessMode: AgentAccessModeDto;
  modelRef: string;
  skillIds: string[];
}

export type AgentWorkbenchAccessRequestStatusDto =
  | 'loading'
  | 'saving'
  | 'ready'
  | 'error';

export interface AgentWorkbenchAccessRequestStateDto {
  status: AgentWorkbenchAccessRequestStatusDto;
  accessMode?: AgentAccessModeDto;
}

export type AgentWorkbenchApprovalDetailStatusDto =
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'terminal';

export interface AgentWorkbenchApprovalDetailStateDto {
  status: AgentWorkbenchApprovalDetailStatusDto;
  detail?: AgentWorkbenchApprovalDetailDto;
  fallbackDetail?: AgentWorkbenchApprovalDetailDto;
}

export type AgentWorkbenchApprovalDecisionStatusDto =
  | 'deciding'
  | 'running'
  | 'cancelling'
  | 'delivering'
  | 'delivered'
  | 'delivery-failed';

export interface AgentWorkbenchApprovalDecisionStateDto {
  status: AgentWorkbenchApprovalDecisionStatusDto;
  approved: boolean;
  approvalId: string;
  sessionId: string;
  action: 'approve' | 'reject' | '';
  approvalResult: AgentWorkbenchApprovalResultDto | null;
}

/** Snapshot used to restore an editor/split/diff view after closing Agent. */
export type AgentWorkbenchUnderlyingViewModeDto = 'single' | 'split' | 'diff';

export interface AgentWorkbenchUnderlyingViewSnapshotDto {
  readonly filePath: string;
  readonly mode: AgentWorkbenchUnderlyingViewModeDto;
  readonly splitActive: boolean;
  readonly diffActive: boolean;
  readonly imageActive: boolean;
  readonly diffOriginalPath: string;
  readonly diffModifiedPath: string;
}

export interface AgentWorkbenchTabMetadataDto {
  previousFilePath: string;
  previousView: AgentWorkbenchUnderlyingViewSnapshotDto | null;
}

/** Minimal tab data passed back by the legacy workspace tab provider. */
export interface AgentWorkbenchFileTabDto {
  readonly path: string;
  readonly model?: unknown;
  readonly [key: string]: unknown;
}

export interface AgentWorkbenchTabDto {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly category: string;
  readonly closeable: true;
  readonly draggable: false;
}

export interface AgentWorkbenchTabProvider {
  getTabs(): readonly AgentWorkbenchTabDto[];
  activate(key: string): boolean | void;
  close(key: string): boolean;
  deactivate(tabOverride?: string): void;
  afterFileActivation(tab: AgentWorkbenchFileTabDto): void;
}

export interface AgentWorkbenchWorkspacePort {
  registerWorkbenchTabProvider(
    providerId: string,
    provider: AgentWorkbenchTabProvider
  ): Disposable;
  activateTab(path: string): void;
  updateTabbar(): void;
  updateTitlebar(): void;
  updateEmptyState(): void;
}

export interface AgentWorkbenchViewsPort {
  openSplit(): void;
  openDiff(originalPath?: string, modifiedPath?: string): void;
}

export interface AgentWorkbenchDocumentViewsPort {
  hideAll(options: Readonly<{ restoreEditor: false }>): void;
}

export type AgentWorkbenchWorkbenchPort = Pick<
  WorkbenchLayoutFacade,
  'registerPrimaryView' | 'setPrimaryView' | 'setPrimaryVisible' | 'refreshControls'
>;

export interface AgentWorkbenchI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
  onChange?(listener: () => void): Disposable | Dispose | void;
}

export type AgentWorkbenchConfirmPort = ConfirmFacade;

export interface AgentWorkbenchAiSettingsCenterPort {
  open?(tab?: string): unknown;
}

export interface AgentWorkbenchWindowPort {
  readonly navigator?: Pick<Navigator, 'clipboard'> | null;
}

export type AgentWorkbenchAgentsPort = Pick<
  RendererPlatformAgentsFacade,
  'list' | 'get' | 'onDidChange' | 'createCommandPayload'
>;

export type AgentWorkbenchAgentPort = AgentWorkbenchAgentsPort;

export type AgentWorkbenchCommandsPort = Pick<
  RendererPlatformCommandsFacade,
  'executeIsolated'
>;

export type AgentWorkbenchCommandExecutionResultDto = CommandExecutionResult<unknown>;

/** The six host operations formerly read directly from window.api. */
export interface AgentWorkbenchHostPort {
  getAccessMode(
    request: AgentWorkbenchAccessIdentityDto
  ): Promise<AgentWorkbenchAccessResponseDto>;
  setAccessMode(
    request: AgentWorkbenchAccessSetRequestDto
  ): Promise<AgentWorkbenchAccessResponseDto>;
  clearAccessMode(
    request: AgentWorkbenchAccessIdentityDto
  ): Promise<AgentWorkbenchAccessResponseDto>;
  describeApproval(
    request: AgentWorkbenchApprovalRequestDto
  ): Promise<AgentWorkbenchApprovalDescribeResponseDto>;
  decideApproval(
    request: AgentWorkbenchApprovalDecisionRequestDto
  ): Promise<AgentWorkbenchApprovalDecisionResponseDto>;
  cancelApproval(
    request: AgentWorkbenchApprovalRequestDto
  ): Promise<AgentWorkbenchApprovalCancelResultDto>;
}

export interface AgentWorkbenchLogger {
  error(message?: unknown, ...values: unknown[]): void;
}

/** Mutable state consumed by the host-rendered Agent workbench. */
export interface AgentWorkbenchRendererState extends RendererState {}

export type AgentWorkbenchRecordDto = AgentStateSnapshot;
export type AgentWorkbenchStateDto = AgentStateDto;
export type AgentWorkbenchStateChangeDto = AgentStateChangeEvent;
export type AgentWorkbenchStateChangeListener = AgentStateChangeListener;
export type AgentWorkbenchStatePatchDto = AgentObservedStatePatchDto;
export type AgentWorkbenchMessageDto = AgentMessageDto;
export type AgentWorkbenchTimelineItemDto = AgentTimelineItemDto;
export type AgentWorkbenchCommandValuesDto = AgentCommandValuesRegistrationDto;
export type AgentWorkbenchCommandPayloadDto = AgentCommandPayloadDto;
export type AgentWorkbenchSessionStatusDto = AgentSessionStatusDto;
export type AgentWorkbenchEffectiveReasoningEffortDto = AgentEffectiveReasoningEffortDto;

/** Browser-side dependencies injected into the TypeScript implementation. */
export interface AgentWorkbenchDependencies {
  readonly document: Document;
  readonly eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly state: AgentWorkbenchRendererState;
  readonly getI18n: () => AgentWorkbenchI18nPort | null | undefined;
  readonly getAgents: () => AgentWorkbenchAgentsPort | null | undefined;
  readonly getCommands: () => AgentWorkbenchCommandsPort | null | undefined;
  readonly getConfirm: () => AgentWorkbenchConfirmPort | null | undefined;
  readonly getAiSettingsCenter: () => AgentWorkbenchAiSettingsCenterPort | null | undefined;
  readonly getWorkspace: () => AgentWorkbenchWorkspacePort | null | undefined;
  readonly getWorkbench: () => AgentWorkbenchWorkbenchPort | null | undefined;
  readonly getViews: () => AgentWorkbenchViewsPort | null | undefined;
  readonly getDocumentViews: () => AgentWorkbenchDocumentViewsPort | null | undefined;
  readonly host: AgentWorkbenchHostPort;
  readonly navigator?: Pick<Navigator, 'clipboard'> | null;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly logger?: AgentWorkbenchLogger;
}

/** Historical six-key BOBO.agentWorkbench compatibility facade. */
export interface AgentWorkbenchFacade {
  init(): void;
  dispose(): void;
  open(providerId: string): boolean | void;
  openConfiguration(
    recordOrId?: AgentWorkbenchRecordDto | string | null
  ): Promise<[unknown, boolean[]]>;
  refresh(change?: AgentWorkbenchStateChangeDto): void;
  refreshModels(providerId?: string): Promise<boolean[]>;
}

export interface AgentWorkbenchService extends AgentWorkbenchFacade, Disposable {
  readonly disposed: boolean;
}

/** Internal feed union used by keyed incremental rendering. */
export interface AgentWorkbenchMessageFeedItemDto {
  readonly type: 'message';
  readonly value: AgentWorkbenchMessageDto;
  readonly index: number;
}

export interface AgentWorkbenchTimelineFeedItemDto {
  readonly type: 'timeline';
  readonly value: AgentWorkbenchTimelineItemDto;
  readonly index: number;
}

export type AgentWorkbenchFeedItemDto =
  | AgentWorkbenchMessageFeedItemDto
  | AgentWorkbenchTimelineFeedItemDto;

export interface AgentWorkbenchFeedScrollSnapshotDto {
  readonly nearBottom: boolean;
  readonly scrollTop: number;
  readonly anchorKey: string;
  readonly anchorOffset: number;
}
