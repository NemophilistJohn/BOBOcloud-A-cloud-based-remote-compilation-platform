import type { AiOperationResultDto, AiProfileDto, AiService } from './ai-service';
import type { AiContextCurrentFileDto, AiContextFullContextDto } from './ai-context';
import type { AiMarkdownFacade } from './ai-markdown';
import type { AiPromptsFacade } from './ai-prompts';
import type { Disposable, Dispose } from './lifecycle';
import type { RendererIconsFacade } from './icons';
import type {
  I18nInterpolationParams,
  I18nTextBindingOptions,
  I18nTranslatedAttribute
} from './i18n';
import type {
  StreamRenderScheduler,
  StreamRenderSchedulerFactory
} from './stream-render-scheduler';

/** A chat message is intentionally open-ended for compatibility with saved history. */
export interface AiChatPanelMessageDto {
  id?: string;
  role?: string;
  content?: string;
  timestamp?: number;
  reasoning_content?: string;
  [key: string]: unknown;
}

export interface AiChatPanelReferencedFileDto {
  readonly path: string;
  readonly name?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface AiChatPanelConversationDto {
  id: string;
  title?: string;
  messages?: AiChatPanelMessageDto[];
  referencedFiles?: AiChatPanelReferencedFileDto[];
  excludedAutoContextPaths?: string[];
  autoContextDisabled?: boolean;
  createdAt?: number;
  [key: string]: unknown;
}

/** Wire shape accepted by the legacy chat-history IPC handlers. */
export interface AiChatHistoryWireDto {
  messages?: AiChatPanelMessageDto[];
  referencedFiles?: AiChatPanelReferencedFileDto[];
  conversations?: AiChatPanelConversationDto[];
  currentConversationId?: string;
  [key: string]: unknown;
}

export interface AiChatHistoryWriteDto {
  readonly conversations: readonly AiChatPanelConversationDto[];
  readonly currentConversationId: string;
  readonly [key: string]: unknown;
}

/** Minimal tree shape consumed by the file-picker flattening routine. */
export interface AiChatPanelTreeNodeDto {
  readonly type?: string;
  readonly name?: string;
  readonly path?: string;
  readonly children?: readonly AiChatPanelTreeNodeDto[];
  readonly [key: string]: unknown;
}

export interface AiChatPanelContextPolicyDto {
  readonly maxReferencedFiles?: unknown;
  readonly referencedFileChars?: unknown;
  readonly [key: string]: unknown;
}

/** Mutable state required by the panel; additional renderer state stays opaque. */
export interface AiChatPanelAiState {
  chatOpen: boolean;
  chatStreaming: boolean;
  chatMessages: AiChatPanelMessageDto[];
  referencedFiles: AiChatPanelReferencedFileDto[];
  excludedAutoContextPaths: string[];
  autoContextDisabled: boolean;
  conversations: AiChatPanelConversationDto[];
  currentConversationId: string;
  chat?: { context?: AiChatPanelContextPolicyDto | null; [key: string]: unknown } | null;
  readonly [key: string]: unknown;
}

export interface AiChatPanelRendererState {
  ai: AiChatPanelAiState;
  workspaceRoot?: string | null;
  readonly [key: string]: unknown;
}

export interface AiChatPanelI18nPort {
  t(source: unknown, params?: I18nInterpolationParams | null): string;
  bindText<ElementType extends Element>(
    element: ElementType | null | undefined,
    source: unknown,
    params?: I18nInterpolationParams | null,
    options?: I18nTextBindingOptions
  ): ElementType | null | undefined;
  bindAttribute<ElementType extends Element>(
    element: ElementType | null | undefined,
    attribute: I18nTranslatedAttribute,
    source: unknown,
    params?: I18nInterpolationParams | null
  ): ElementType | null | undefined;
  onChange?(listener: () => void): Dispose;
}

export type AiChatPanelAiServicePort = Pick<
  AiService, 'getProfileFor' | 'sendChat' | 'cancelStream'
> & {
  /** The legacy IPC listener accepts both string chunks and object chunks. */
  onStreamChunk(callback: (chunk: string | AiChatPanelStreamChunkDto) => void): void;
  onStreamEnd(callback: () => void): void;
  onStreamError(callback: (error: unknown) => void): void;
};

export interface AiChatPanelStreamChunkDto {
  readonly text?: string;
  readonly reasoning?: string;
  readonly [key: string]: unknown;
}

export type AiChatPanelContextDto = AiContextFullContextDto & {
  referencedFilesContents?: Record<string, unknown>;
};

export type AiChatPanelContextFileDto = AiContextCurrentFileDto;

export interface AiChatPanelContextPort {
  buildFullContext(): AiChatPanelContextDto;
  getCurrentFileContext(): AiChatPanelContextFileDto | null;
}

export type AiChatPanelPromptsPort = Pick<AiPromptsFacade, 'truncate'>;
export type AiChatPanelMarkdownPort = Pick<AiMarkdownFacade, 'render'>;

export interface AiChatPanelSettingsCenterPort {
  open?(tab?: string): unknown;
}

export interface AiChatPanelAgentButtonPort {
  toggleChat?(open?: boolean): unknown;
}

export interface AiChatPanelWorkbenchPort {
  init?(): unknown;
}

export interface AiChatPanelToastPort {
  info?(message: string): void;
}

export type AiChatPanelIconsPort = Pick<
  RendererIconsFacade,
  'fileText' | 'file' | 'folder' | 'close' | 'check' | 'history' | 'trash'
>;

/** Narrow host boundary for file reads and chat-history persistence. */
export interface AiChatPanelHostPort {
  readFiles(filePaths: readonly string[]): Promise<Readonly<Record<string, unknown>>>;
  readTree(workspaceRoot: string): Promise<AiChatPanelTreeNodeDto | null>;
  loadChatHistory(workspaceRoot: string): Promise<AiChatHistoryWireDto | null>;
  saveChatHistory(workspaceRoot: string, data: AiChatHistoryWriteDto): Promise<unknown>;
  onWorkspaceOpened(listener: () => void): Disposable;
}

export interface AiChatPanelWindowPort extends EventTarget {
  readonly innerWidth: number;
  readonly innerHeight: number;
}

export interface AiChatPanelDependencies {
  readonly document: Document;
  readonly window: AiChatPanelWindowPort;
  readonly state: AiChatPanelRendererState;
  readonly getI18n: () => AiChatPanelI18nPort | null | undefined;
  readonly getAiService: () => AiChatPanelAiServicePort | null | undefined;
  readonly getAiContext: () => AiChatPanelContextPort | null | undefined;
  readonly getAiPrompts: () => AiChatPanelPromptsPort | null | undefined;
  readonly getAiMarkdown: () => AiChatPanelMarkdownPort | null | undefined;
  readonly getSettingsCenter: () => AiChatPanelSettingsCenterPort | null | undefined;
  readonly getAgentButton: () => AiChatPanelAgentButtonPort | null | undefined;
  readonly getWorkbench: () => AiChatPanelWorkbenchPort | null | undefined;
  readonly getToast?: () => AiChatPanelToastPort | null | undefined;
  readonly getIcons: () => AiChatPanelIconsPort;
  readonly getSchedulerFactory: () => StreamRenderSchedulerFactory | null | undefined;
  readonly host: AiChatPanelHostPort;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly logger?: Pick<Console, 'error'>;
}

/** Historical ten-key BOBO.aiChatPanel projection. */
export interface AiChatPanelFacade {
  init(): void;
  setVisible(visible: boolean): void;
  sendMessage(): Promise<void>;
  clearChat(): void;
  updateContextBar(): void;
  addReferencedFile(filePath: string, fileName?: string, fileType?: string): void;
  removeReferencedFile(filePath: string): void;
  excludeAutoFileContext(filePath: string): void;
  openFilePicker(filterText?: string): void;
  saveChatHistory(): Promise<void>;
}

export interface AiChatPanelService extends AiChatPanelFacade, Disposable {
  readonly disposed: boolean;
}

/** Alias retained for scheduler consumers that need to narrow the lazy UI port. */
export type AiChatPanelStreamScheduler = StreamRenderScheduler;

export type AiChatPanelResultDto = AiOperationResultDto;

export type AiChatPanelProfileDto = Pick<AiProfileDto, 'id' | 'name'>;
