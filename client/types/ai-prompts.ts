export type AiPromptKeep = 'head' | 'tail' | 'middle' | (string & {});

export interface AiPromptSelectionDto {
  readonly text?: unknown;
  readonly startLine?: unknown;
  readonly endLine?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptCurrentFileDto {
  readonly path?: unknown;
  readonly name?: unknown;
  readonly language?: unknown;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptPolicyDto {
  readonly selectionChars?: unknown;
  readonly currentFileChars?: unknown;
  readonly projectChars?: unknown;
  readonly referencedFileChars?: unknown;
  readonly maxReferencedFiles?: unknown;
  readonly historyMessages?: unknown;
  readonly historyMessageChars?: unknown;
  readonly maxInputChars?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptContextDto {
  readonly selection?: AiPromptSelectionDto | null;
  readonly currentFile?: AiPromptCurrentFileDto | null;
  readonly referencedFilesContents?: Readonly<Record<string, unknown>> | null;
  readonly projectStructure?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptChatSettingsDto {
  readonly instructions?: unknown;
  readonly context?: AiPromptPolicyDto | null;
  readonly [key: string]: unknown;
}

export interface AiPromptInlineSettingsDto {
  readonly instructions?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptSettingsDto {
  readonly globalInstructions?: unknown;
  readonly chat?: AiPromptChatSettingsDto | null;
  readonly inline?: AiPromptInlineSettingsDto | null;
  readonly [key: string]: unknown;
}

export interface AiPromptHistoryMessageDto {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptBuildOptionsDto {
  readonly settings?: AiPromptSettingsDto | null;
  readonly context?: AiPromptContextDto | null;
  readonly history?: readonly AiPromptHistoryMessageDto[] | unknown;
  readonly userMessage?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptMessageDto {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface AiPromptBuildMetadataDto {
  readonly schema: 'bobo-ai-context/v2';
  readonly maxInputChars: number;
  readonly inputChars: number;
  readonly historyMessages: number;
  readonly capabilityRegistry: 'informational-only';
}

export interface AiPromptBuildResultDto {
  readonly messages: AiPromptMessageDto[];
  readonly metadata: AiPromptBuildMetadataDto;
}

export interface AiPromptInlineContextDto {
  readonly language?: unknown;
  readonly fileName?: unknown;
  readonly codeBefore?: unknown;
  readonly codeAfter?: unknown;
  readonly [key: string]: unknown;
}

export interface AiPromptsFacade {
  CORE_PROMPT: string;
  APP_KNOWLEDGE: string;
  truncate(value: unknown, limit: unknown, keep?: AiPromptKeep): string;
  buildContextSections(context?: unknown, policy?: unknown): string[];
  buildSystemPrompt(settings?: unknown, context?: unknown, budget?: number): string;
  buildChatMessages(options?: AiPromptBuildOptionsDto): AiPromptBuildResultDto;
  buildInlineChatMessage(settings?: unknown, context?: AiPromptInlineContextDto): string;
  messagesLength(messages: readonly AiPromptMessageDto[]): number;
}
