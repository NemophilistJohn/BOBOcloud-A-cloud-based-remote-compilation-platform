import type { Disposable } from './lifecycle';

export type AgentPhaseDto = 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
export type AgentModeDto = 'chat' | 'goal';
export type AgentAccessModeDto = 'ask' | 'auto' | 'full';
export type AgentReasoningEffortDto = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentEffectiveReasoningEffortDto = AgentReasoningEffortDto | 'none';
export type AgentSessionStatusDto =
  | 'idle'
  | 'running'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type AgentTimelineKindDto = 'thought' | 'tool' | 'status' | 'skill' | 'compaction' | 'error';
export type AgentTimelineStatusDto = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'rejected';
export type AgentGoalStepStatusDto = 'pending' | 'in-progress' | 'completed' | 'blocked';
export type AgentModelPurposeDto = 'chat' | 'inline';
export type AgentModelCapabilitySourceDto = 'provider-api' | 'official-catalog' | 'user-override' | 'unknown';
export type AgentMessageRoleDto = 'user' | 'assistant' | 'system';
export type AgentApprovalToolDto = 'workspace_write' | 'process_run';
export type AgentApprovalOutcomeDto = 'not-started' | 'unknown';
export type AgentStateChangeType = 'added' | 'state' | 'removed';

export interface AgentCommandMapRegistrationDto {
  readonly create: string;
  readonly select: string;
  readonly delete: string;
  readonly send: string;
  readonly cancel: string;
  readonly approve: string;
  readonly reject: string;
  readonly preferences: string;
  readonly configure: string;
}

export interface AgentCapabilitiesRegistrationDto {
  readonly modes?: readonly AgentModeDto[] | null;
  readonly reasoningEfforts?: readonly AgentReasoningEffortDto[] | null;
  readonly accessModes?: readonly AgentAccessModeDto[] | null;
  readonly skills?: boolean;
  readonly localTools?: boolean;
}

export interface AgentDescriptorRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly icon?: 'sparkles';
  readonly order?: number;
  readonly commands: AgentCommandMapRegistrationDto;
  readonly capabilities?: AgentCapabilitiesRegistrationDto | null;
}

export interface AgentCommandMapDto {
  readonly create: string;
  readonly select: string;
  readonly delete: string;
  readonly send: string;
  readonly cancel: string;
  readonly approve: string;
  readonly reject: string;
  readonly preferences: string;
  readonly configure: string;
}

export interface AgentCapabilitiesDto {
  readonly modes: readonly AgentModeDto[];
  readonly reasoningEfforts: readonly AgentReasoningEffortDto[];
  readonly accessModes: readonly AgentAccessModeDto[];
  readonly skills: boolean;
  readonly localTools: boolean;
}

export interface AgentDescriptorDto {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: 'sparkles';
  readonly order: number;
  readonly commands: AgentCommandMapDto;
  readonly capabilities: AgentCapabilitiesDto;
}

export interface AgentSessionSummaryRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly updatedAt?: string | null;
  readonly status?: AgentSessionStatusDto;
  readonly mode?: AgentModeDto;
}

export interface AgentSessionSummaryDto {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly status: AgentSessionStatusDto;
  readonly mode: AgentModeDto;
}

export interface AgentModelCapabilitiesRegistrationDto {
  readonly contextWindowTokens?: number | null;
  readonly maxOutputTokens?: number | null;
  readonly requestOutputLimitTokens?: number | null;
  readonly tools?: boolean | null;
  readonly streaming?: boolean | null;
  readonly parallelToolCalls?: boolean | null;
  readonly reasoningEfforts?: readonly AgentReasoningEffortDto[] | null;
  readonly effectiveEffortMap?: Readonly<Partial<Record<AgentReasoningEffortDto, AgentEffectiveReasoningEffortDto>>> | null;
  readonly source?: AgentModelCapabilitySourceDto | null;
}

export interface AgentModelCapabilitiesDto {
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly requestOutputLimitTokens: number | null;
  readonly tools: boolean | null;
  readonly streaming: boolean | null;
  readonly parallelToolCalls: boolean | null;
  readonly reasoningEfforts: readonly AgentReasoningEffortDto[];
  readonly effectiveEffortMap: Readonly<Partial<Record<AgentReasoningEffortDto, AgentEffectiveReasoningEffortDto>>>;
  readonly source: AgentModelCapabilitySourceDto;
}

export interface AgentModelChoiceRegistrationDto {
  readonly ref: string;
  readonly name: string;
  readonly provider?: string | null;
  readonly modelId?: string | null;
  readonly purpose?: AgentModelPurposeDto;
  readonly configured?: boolean;
  readonly capabilities?: AgentModelCapabilitiesRegistrationDto | null;
}

export interface AgentModelChoiceDto {
  readonly ref: string;
  readonly name: string;
  readonly provider: string;
  readonly modelId: string;
  readonly purpose: AgentModelPurposeDto;
  readonly configured: boolean;
  readonly capabilities: AgentModelCapabilitiesDto | null;
}

export interface AgentSkillChoiceRegistrationDto {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly source?: 'workspace' | 'user';
  readonly enabled?: boolean;
  readonly revision?: string | null;
  readonly sizeBytes?: number | null;
  readonly estimatedTokens?: number | null;
}

export interface AgentSkillChoiceDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'workspace' | 'user';
  readonly enabled: boolean;
  readonly revision: string;
  readonly sizeBytes: number | null;
  readonly estimatedTokens: number | null;
}

export interface AgentMessageRegistrationDto {
  readonly id: string;
  readonly role: AgentMessageRoleDto;
  readonly content?: string | null;
  readonly reasoning?: string | null;
  readonly createdAt?: string | null;
}

export interface AgentMessageDto {
  readonly id: string;
  readonly role: AgentMessageRoleDto;
  readonly content: string;
  readonly reasoning: string;
  readonly createdAt: string;
}

export interface AgentTimelineItemRegistrationDto {
  readonly id: string;
  readonly kind?: AgentTimelineKindDto;
  readonly title: string;
  readonly detail?: string | null;
  readonly status?: AgentTimelineStatusDto;
  readonly createdAt?: string | null;
}

export interface AgentTimelineItemDto {
  readonly id: string;
  readonly kind: AgentTimelineKindDto;
  readonly title: string;
  readonly detail: string;
  readonly status: AgentTimelineStatusDto;
  readonly createdAt: string;
}

export interface AgentGoalStepRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly status?: AgentGoalStepStatusDto;
}

export interface AgentGoalStepDto {
  readonly id: string;
  readonly title: string;
  readonly status: AgentGoalStepStatusDto;
}

export interface AgentGoalRegistrationDto {
  readonly title: string;
  readonly status?: AgentGoalStepStatusDto;
  readonly steps?: readonly AgentGoalStepRegistrationDto[];
}

export interface AgentGoalDto {
  readonly title: string;
  readonly status: AgentGoalStepStatusDto;
  readonly steps: readonly AgentGoalStepDto[];
}

export interface AgentApprovalRegistrationDto {
  readonly id: string;
}

export interface AgentApprovalDto {
  readonly id: string;
}

export interface AgentCompactionRegistrationDto {
  readonly count?: number;
  readonly compactedMessages?: number;
  readonly estimatedTokensBefore?: number;
  readonly estimatedTokensAfter?: number;
  readonly compactedAt?: string | null;
}

export interface AgentCompactionDto {
  readonly count: number;
  readonly compactedMessages: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly compactedAt: string;
}

export interface AgentActiveSessionRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly status?: AgentSessionStatusDto;
  readonly mode?: AgentModeDto;
  readonly reasoningEffort?: AgentReasoningEffortDto;
  readonly effectiveReasoningEffort?: AgentEffectiveReasoningEffortDto;
  readonly accessMode?: AgentAccessModeDto;
  readonly modelRef?: string | null;
  readonly messages?: readonly AgentMessageRegistrationDto[] | null;
  readonly timeline?: readonly AgentTimelineItemRegistrationDto[] | null;
  readonly goal?: AgentGoalRegistrationDto | null;
  readonly approval?: AgentApprovalRegistrationDto | null;
  readonly compacting?: boolean;
  readonly compaction?: AgentCompactionRegistrationDto | null;
}

export interface AgentActiveSessionDto {
  readonly id: string;
  readonly title: string;
  readonly status: AgentSessionStatusDto;
  readonly mode: AgentModeDto;
  readonly reasoningEffort: AgentReasoningEffortDto;
  readonly effectiveReasoningEffort: AgentEffectiveReasoningEffortDto;
  readonly accessMode: AgentAccessModeDto;
  readonly modelRef: string;
  readonly messages: readonly AgentMessageDto[];
  readonly timeline: readonly AgentTimelineItemDto[];
  readonly goal: AgentGoalDto | null;
  readonly approval: AgentApprovalDto | null;
  readonly compacting: boolean;
  readonly compaction: AgentCompactionDto | null;
}

export interface AgentStateRegistrationDto {
  readonly phase?: AgentPhaseDto;
  readonly message?: string | null;
  readonly activeSessionId?: string | null;
  readonly sessions?: readonly AgentSessionSummaryRegistrationDto[] | null;
  readonly models?: readonly AgentModelChoiceRegistrationDto[] | null;
  readonly skills?: readonly AgentSkillChoiceRegistrationDto[] | null;
  readonly activeSession?: AgentActiveSessionRegistrationDto | null;
}

export interface AgentStateDto {
  readonly phase: AgentPhaseDto;
  readonly message: string;
  readonly activeSessionId: string;
  readonly sessions: readonly AgentSessionSummaryDto[];
  readonly models: readonly AgentModelChoiceDto[];
  readonly skills: readonly AgentSkillChoiceDto[];
  readonly activeSession: AgentActiveSessionDto | null;
}

export type AgentStatePatchOperationDto =
  | Readonly<{
      type: 'state.merge';
      value: Partial<Omit<AgentStateRegistrationDto, 'activeSession'>>;
    }>
  | Readonly<{
      type: 'session.merge';
      value: Partial<Omit<AgentActiveSessionRegistrationDto, 'messages' | 'timeline'>>;
    }>
  | Readonly<{ type: 'message.upsert'; value: AgentMessageRegistrationDto }>
  | Readonly<{ type: 'timeline.upsert'; value: AgentTimelineItemRegistrationDto }>;

export interface AgentStatePatchDto {
  readonly baseVersion: number;
  readonly operations: readonly AgentStatePatchOperationDto[];
}

export type AgentObservedStatePatchOperationDto =
  | Readonly<{ type: 'state.merge'; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: 'session.merge'; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: 'message.upsert'; value: AgentMessageDto }>
  | Readonly<{ type: 'timeline.upsert'; value: AgentTimelineItemDto }>;

export interface AgentObservedStatePatchDto {
  readonly baseVersion: number;
  readonly operations: readonly AgentObservedStatePatchOperationDto[];
}

export interface AgentApprovalResultRegistrationDto {
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
  readonly outcome?: AgentApprovalOutcomeDto;
  readonly mayHaveExecuted?: boolean;
}

export interface AgentApprovalResultDto extends AgentApprovalResultRegistrationDto {}

export interface AgentCommandValuesRegistrationDto {
  readonly sessionId?: string | null;
  readonly text?: string | null;
  readonly mode?: AgentModeDto;
  readonly reasoningEffort?: AgentReasoningEffortDto;
  readonly accessMode?: AgentAccessModeDto;
  readonly modelRef?: string | null;
  readonly skillIds?: readonly string[];
  readonly approvalId?: string | null;
  readonly approvalResult?: AgentApprovalResultRegistrationDto;
}

export interface AgentCommandPayloadDto {
  readonly providerId: string;
  readonly action: string;
  readonly sessionId?: string;
  readonly text?: string;
  readonly mode?: AgentModeDto;
  readonly reasoningEffort?: AgentReasoningEffortDto;
  readonly accessMode?: AgentAccessModeDto;
  readonly modelRef?: string;
  readonly skillIds?: readonly string[];
  readonly approvalId?: string;
  readonly approvalResult?: AgentApprovalResultDto;
}

export interface AgentVersionDto {
  readonly version: number;
}

export interface AgentStatePatchAppliedDto extends AgentVersionDto {
  readonly applied: true;
}

export interface AgentStatePatchRejectedDto extends AgentVersionDto {
  readonly applied: false;
}

export type AgentStateUpdateResultDto = AgentStatePatchAppliedDto | AgentStatePatchRejectedDto;

export interface AgentStateSnapshot<State extends AgentStateDto | null = AgentStateDto | null> {
  readonly id: string;
  readonly owner: string;
  readonly descriptor: AgentDescriptorDto;
  readonly state: State;
  readonly version: number;
}

interface AgentStateChangeEventBase<State extends AgentStateDto | null = AgentStateDto | null> {
  readonly record: AgentStateSnapshot<State>;
}

export interface AgentStateAddedEvent extends AgentStateChangeEventBase<null> {
  readonly type: 'added';
  readonly patch: null;
}

export interface AgentStateSetEvent extends AgentStateChangeEventBase<AgentStateDto> {
  readonly type: 'state';
  readonly patch: null;
}

export interface AgentStatePatchedEvent extends AgentStateChangeEventBase<AgentStateDto> {
  readonly type: 'state';
  readonly patch: AgentObservedStatePatchDto;
}

export interface AgentStateClearedEvent extends AgentStateChangeEventBase<null> {
  readonly type: 'state';
  readonly patch: null;
}

export interface AgentStateRemovedEvent extends AgentStateChangeEventBase {
  readonly type: 'removed';
  readonly patch: null;
}

export type AgentStateChangedEvent = AgentStateSetEvent | AgentStatePatchedEvent | AgentStateClearedEvent;
export type AgentStateChangeEvent = AgentStateAddedEvent | AgentStateChangedEvent | AgentStateRemovedEvent;
export type AgentStateChangeListener = (event: AgentStateChangeEvent) => void;

export interface AgentStateHandle extends Disposable {
  readonly id: string;
  setState(state: AgentStateRegistrationDto): AgentVersionDto;
  updateState(patch: AgentStatePatchDto): AgentStateUpdateResultDto;
  clearState(): AgentVersionDto;
}

export interface AgentStateRegistrationOptions {
  readonly owner?: string;
}

export interface AgentStateStoreErrorEvent {
  readonly source: 'agent-state-listener';
  readonly id: string;
  readonly error: unknown;
}

export interface AgentStateStoreOptions {
  readonly onError?: (event: AgentStateStoreErrorEvent) => void;
}

export interface AgentStateStoreContract extends Disposable {
  register(
    descriptor: AgentDescriptorRegistrationDto,
    options?: AgentStateRegistrationOptions
  ): AgentStateHandle;
  list(): readonly AgentStateSnapshot[];
  get(id: string): AgentStateSnapshot | null;
  onDidChange(listener: AgentStateChangeListener): Disposable;
  disposeOwner(owner: string): void;
}
