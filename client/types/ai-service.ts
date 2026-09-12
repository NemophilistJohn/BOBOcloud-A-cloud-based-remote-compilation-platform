import type { AiPromptsFacade } from './ai-prompts';
import type { Dispose, Disposable } from './lifecycle';

export type AiPurpose = 'chat' | 'inline';
export type AiMode = 'chat' | 'fim';
export type AiProtocol =
  | 'chat-completions'
  | 'completions'
  | 'messages'
  | 'responses'
  | (string & {});
export type AiAuthType = 'api-key' | 'bearer' | 'jwt' | (string & {});

export interface AiCapabilitiesDto {
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly tools: boolean | null;
  readonly streaming: boolean | null;
  readonly parallelToolCalls: boolean | null;
  readonly reasoningEfforts: readonly string[];
  readonly effectiveEffortMap: Readonly<Record<string, string>>;
  readonly source: string;
  readonly [key: string]: unknown;
}

/** Canonical v4 profile returned by ai-settings-schema.js. */
export interface AiProfileDto {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly protocol: AiProtocol;
  readonly authType: AiAuthType;
  readonly apiKey: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly mode: AiMode;
  readonly apiVersion: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly region: string;
  readonly billingPlan: string;
  readonly capabilities: AiCapabilitiesDto;
  readonly options: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface AiParametersDto {
  readonly maxTokens: number;
  readonly temperature: number;
  readonly topP: number;
  readonly stop: readonly string[];
  readonly [key: string]: unknown;
}

export interface AiChatContextPolicyDto {
  readonly maxInputChars: number;
  readonly currentFileChars: number;
  readonly selectionChars: number;
  readonly projectChars: number;
  readonly referencedFileChars: number;
  readonly maxReferencedFiles: number;
  readonly historyMessages: number;
  readonly historyMessageChars: number;
  readonly [key: string]: unknown;
}

export interface AiInlineContextPolicyDto {
  readonly prefixChars: number;
  readonly suffixChars: number;
  readonly [key: string]: unknown;
}

export interface AiChatSettingsDto {
  readonly instructions: string;
  readonly parameters: AiParametersDto;
  readonly context: AiChatContextPolicyDto;
  readonly [key: string]: unknown;
}

export interface AiInlineSettingsDto {
  readonly enabled: boolean;
  readonly instructions: string;
  readonly debounceMs: number;
  readonly parameters: AiParametersDto;
  readonly context: AiInlineContextPolicyDto;
  readonly [key: string]: unknown;
}

/** Canonical v4 settings exchanged with the main process. */
export interface AiSettingsDto {
  readonly schemaVersion: 4;
  readonly chatProfiles: readonly AiProfileDto[];
  readonly inlineProfiles: readonly AiProfileDto[];
  readonly chatProfileId: string;
  readonly inlineProfileId: string;
  readonly globalInstructions: string;
  readonly chat: AiChatSettingsDto;
  readonly inline: AiInlineSettingsDto;
  readonly chatOpen: boolean;
  readonly [key: string]: unknown;
}

/** Mutable state projection retained for legacy renderer modules. */
export interface AiServiceMutableState {
  schemaVersion: number;
  chatProfiles: AiProfileDto[];
  inlineProfiles: AiProfileDto[];
  chatProfileId: string;
  inlineProfileId: string;
  globalInstructions: string;
  chat: {
    instructions: string;
    parameters: { maxTokens: number; temperature: number; topP: number; stop: string[]; [key: string]: unknown };
    context: { [key: string]: unknown; maxInputChars: number; currentFileChars: number; selectionChars: number; projectChars: number; referencedFileChars: number; maxReferencedFiles: number; historyMessages: number; historyMessageChars: number };
    [key: string]: unknown;
  };
  inline: {
    enabled: boolean;
    instructions: string;
    debounceMs: number;
    parameters: { maxTokens: number; temperature: number; topP: number; stop: string[]; [key: string]: unknown };
    context: { prefixChars: number; suffixChars: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  chatOpen: boolean;
  connectionHealth: {
    chat: Record<string, AiHealthDto>;
    inline: Record<string, AiHealthDto>;
  };
  status: string;
  chatStreaming: boolean;
  inlineStatus: string;
  chatMessages: unknown[];
  profiles?: AiLegacyModelDto[];
  models?: AiLegacyModelDto[];
  chatModel?: string;
  inlineModel?: string;
  currentModel?: string;
  inlineEnabled?: boolean;
  inlineDebounceMs?: number;
  chatSystemPrompt?: string;
  inlineInstruction?: string;
  inlinePrefixChars?: number;
  inlineSuffixChars?: number;
  inlineMaxTokens?: number;
  [key: string]: unknown;
}

export interface AiServiceRendererState {
  ai: AiServiceMutableState;
  readonly [key: string]: unknown;
}

export interface AiSettingsSchemaPort {
  normalizeSettings(value: unknown): AiSettingsDto;
  normalizeProfile(value: unknown, index: number, purpose: AiPurpose): AiProfileDto;
}

export interface AiConnectionDto {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly protocol: AiProtocol;
  readonly authType: AiAuthType;
  /** This trusted-renderer DTO never crosses the downloaded-plugin boundary. */
  readonly apiKey: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly mode: AiMode;
  readonly apiVersion: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly region: string;
  readonly billingPlan: string;
  readonly capabilities: AiCapabilitiesDto;
  readonly options: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export type AiHealthState = 'missing' | 'invalid' | 'needs-key' | 'untested' | 'testing' | 'ready' | 'error' | 'disabled' | (string & {});

export interface AiHealthDto {
  readonly state: AiHealthState;
  readonly code: string;
  readonly detail?: string;
  readonly fingerprint?: string;
  readonly checkedAt?: number;
  readonly testNonce?: number;
  readonly [key: string]: unknown;
}

export interface AiStatusDto extends AiHealthDto {}

export interface AiResultErrorDto {
  readonly success: false;
  readonly code: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

export interface AiOperationSuccessDto {
  readonly success: true;
  readonly [key: string]: unknown;
}

export type AiOperationResultDto = AiOperationSuccessDto | AiResultErrorDto;

export interface AiLegacyModelDto {
  readonly id?: string;
  readonly name?: string;
  readonly provider?: string;
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly modelId?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly isPreset?: boolean;
  readonly inlineEndpoint?: string;
  readonly inlineModelId?: string;
  readonly inlineMode?: AiMode;
  readonly [key: string]: unknown;
}

export interface AiChatMessageDto {
  readonly role: string;
  readonly content: string;
  readonly [key: string]: unknown;
}

export interface AiChatPayloadDto {
  readonly requestId: string;
  readonly messages: readonly AiChatMessageDto[];
  readonly contextMetadata: Record<string, unknown>;
  readonly modelConfig: AiConnectionDto | null;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly topP: number;
  readonly stop: readonly string[];
  readonly stream: boolean;
  readonly [key: string]: unknown;
}

export interface AiInlineContextDto {
  readonly codeBefore?: unknown;
  readonly codeAfter?: unknown;
  readonly language?: unknown;
  readonly fileName?: unknown;
  readonly [key: string]: unknown;
}

export interface AiInlineRequestDto {
  readonly requestId?: string;
  readonly mode: AiMode;
  readonly modelConfig: AiConnectionDto | null;
  readonly stream: false;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly topP: number;
  readonly stop: readonly string[];
  readonly [key: string]: unknown;
}

export type AiInlineCompletionResultDto = AiOperationResultDto & {
  readonly text?: string;
  readonly cached?: boolean;
};

export interface AiTransportResponseDto {
  readonly success?: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
  readonly code?: string;
  readonly detail?: unknown;
  readonly [key: string]: unknown;
}

export interface AiStreamChunkDto {
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

export interface AiStreamEndDto {
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

export interface AiStreamErrorDto {
  readonly requestId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly detail?: unknown;
  readonly [key: string]: unknown;
}

export type AiStreamChunkListener = (event: AiStreamChunkDto) => void;
export type AiStreamEndListener = (event: AiStreamEndDto) => void;
export type AiStreamErrorListener = (event: AiStreamErrorDto) => void;

/** Narrow trusted host port; no renderer feature module reads Window.api. */
export interface AiServiceHostPort {
  aiReadSettings(): Promise<AiSettingsDto | Record<string, unknown>>;
  aiWriteSettings(settings: AiSettingsDto): Promise<boolean | AiTransportResponseDto>;
  aiChatRequest(payload: AiChatPayloadDto): Promise<AiTransportResponseDto>;
  aiCancelStream(): Promise<AiTransportResponseDto>;
  aiInlineRequest(payload: AiInlineRequestDto): Promise<AiTransportResponseDto>;
  aiCancelInline(requestId: string): Promise<AiTransportResponseDto>;
  aiTestConnection(payload: AiInlineRequestDto | AiChatPayloadDto): Promise<AiTransportResponseDto>;
  onAiChunk(listener: AiStreamChunkListener): Dispose;
  onAiStreamEnd(listener: AiStreamEndListener): Dispose;
  onAiStreamError(listener: AiStreamErrorListener): Dispose;
}

export interface AiServiceDependencies {
  readonly state: AiServiceRendererState;
  readonly schema: AiSettingsSchemaPort;
  readonly getPrompts: () => AiPromptsFacade | null | undefined;
  readonly host: AiServiceHostPort;
  readonly getAgentButton?: () => { updateLEDs?: (status: string) => void } | null | undefined;
}

export interface AiApplySettingsOptions {
  readonly trackCommitted?: boolean;
}

export interface AiActiveConnectionsResultDto {
  readonly chat: AiStatusDto;
  readonly inline: AiStatusDto;
}

/** Historical BOBO.aiService surface (44 keys, intentionally closed). */
export interface AiServiceFacade {
  init(): Promise<AiSettingsDto | AiResultErrorDto>;
  loadSettings(): Promise<AiSettingsDto | AiResultErrorDto>;
  saveSettings(): Promise<AiOperationResultDto>;
  getSettings(): AiSettingsDto;
  updateSettings(patch?: unknown): Promise<AiOperationResultDto>;
  applySettings(value: unknown, options?: AiApplySettingsOptions): AiSettingsDto;
  sendChat(message?: unknown, context?: unknown): Promise<AiOperationResultDto>;
  cancelStream(): Promise<unknown>;
  getInlineCompletion(context: AiInlineContextDto): Promise<AiInlineCompletionResultDto>;
  cancelInline(): void;
  clearInlineCache(): void;
  updateStatus(status: string): void;
  onStreamChunk(callback: AiStreamChunkListener): void;
  onStreamEnd(callback: AiStreamEndListener): void;
  onStreamError(callback: AiStreamErrorListener): void;
  getProfiles(purpose?: AiPurpose): AiProfileDto[];
  getProfileFor(purpose?: AiPurpose): AiProfileDto | null;
  getProfileById(id: string, purpose?: AiPurpose): AiProfileDto | null;
  getConnectionFor(purpose?: AiPurpose): AiConnectionDto | null;
  addProfile(value: unknown, purpose?: AiPurpose): Promise<AiOperationResultDto>;
  updateProfile(id: string, patch: unknown, purpose?: AiPurpose): Promise<AiOperationResultDto>;
  removeProfile(id: string, purpose?: AiPurpose): Promise<AiOperationResultDto>;
  setProfileFor(purpose: AiPurpose, id?: string): Promise<AiOperationResultDto>;
  testProfileConnection(candidate: unknown, purpose?: AiPurpose): Promise<AiOperationResultDto>;
  testActiveConnections(): Promise<AiActiveConnectionsResultDto>;
  getConnectionHealth(purpose: AiPurpose, id: string): AiHealthDto | null;
  getModelFor(purpose?: AiPurpose): AiLegacyModelDto | null;
  getModelById(id: string, purpose?: AiPurpose): AiLegacyModelDto | null;
  getCurrentModelConfig(): AiLegacyModelDto | null;
  getCurrentModelName(): string;
  getModelStatus(candidate: unknown, purpose?: AiPurpose): AiStatusDto;
  addModel(modelOrName: unknown, provider?: unknown, endpoint?: unknown, modelId?: unknown, apiKey?: unknown): Promise<AiOperationResultDto>;
  updateModel(id: string, updates: unknown): Promise<AiOperationResultDto>;
  removeModel(id: string): Promise<AiOperationResultDto>;
  setCurrentModel(id?: string): Promise<AiOperationResultDto>;
  setModelFor(purpose: AiPurpose, id?: string): Promise<AiOperationResultDto>;
  testModelConnection(candidate: unknown, purpose?: AiPurpose): Promise<AiOperationResultDto>;
  buildChatPayload(profile: unknown, userMessage?: unknown, context?: unknown, requestId?: string, stream?: boolean): AiChatPayloadDto;
  buildInlineRequest(candidate: unknown, context?: AiInlineContextDto, requestId?: string): AiInlineRequestDto;
  buildMessages(userMessage?: unknown, context?: unknown): AiChatMessageDto[];
  extractInlineText(response: unknown): string;
  extractChatText(response: unknown): string;
  sanitizeModel(model: unknown): AiLegacyModelDto | null;
  fingerprint(profile: unknown, purpose?: AiPurpose): string;
}

export interface AiService extends AiServiceFacade, Disposable {
  readonly disposed: boolean;
}
