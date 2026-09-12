import type {
  AiContextModelPort,
  AiContextPositionDto,
  AiContextService
} from './ai-context';
import type { AiOperationResultDto, AiService } from './ai-service';
import type { Disposable } from './lifecycle';

/** Monaco's structural model surface used by the inline provider. */
export type AiInlineModelPort = AiContextModelPort;

/** Monaco position values are deliberately kept independent of the AMD types. */
export type AiInlinePositionDto = AiContextPositionDto;

export interface AiInlineRangeDto {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface AiInlineCompletionItemDto {
  readonly insertText: string;
  readonly range: AiInlineRangeDto;
}

export interface AiInlineCompletionListDto {
  readonly items: AiInlineCompletionItemDto[];
}

export interface AiInlineTriggerContextDto {
  readonly triggerKind?: number;
  readonly [key: string]: unknown;
}

/** Monaco cancellation tokens expose an IDisposable registration. */
export interface AiInlineCancellationTokenPort {
  onCancellationRequested(listener: () => void): Disposable | void;
}

export interface AiInlineProvider {
  provideInlineCompletions(
    model: AiInlineModelPort,
    position: AiInlinePositionDto,
    context: AiInlineTriggerContextDto | null | undefined,
    token: AiInlineCancellationTokenPort | null | undefined
  ): AiInlineCompletionListDto | Promise<AiInlineCompletionListDto>;
  disposeInlineCompletions?(
    completions: AiInlineCompletionListDto
  ): void;
  /** Kept for Monaco releases that used the earlier provider hook name. */
  freeInlineCompletions?(
    completions: AiInlineCompletionListDto
  ): void;
}

export interface AiInlineLanguagesPort {
  readonly InlineCompletionTriggerKind?: {
    readonly Automatic: number;
  };
  registerInlineCompletionsProvider(
    language: string,
    provider: AiInlineProvider
  ): Disposable | void | unknown;
}

export interface AiInlineEditorPort {
  trigger(source: string, action: string, payload: Readonly<Record<string, unknown>>): void;
}

export interface AiInlineMonacoEditorPort {
  onDidCreateModel?(
    listener: (model: AiInlineModelPort) => void
  ): Disposable | void;
}

export interface AiInlineMonacoPort {
  readonly languages: AiInlineLanguagesPort;
  readonly editor?: AiInlineMonacoEditorPort;
}

export interface AiInlineSplitEditorPort {
  readonly rightEditor?: AiInlineEditorPort | null;
}

/** Mutable state projection retained for the legacy workbench namespace. */
export interface AiInlineStatePort {
  readonly inlineProfileId?: string | null;
  readonly inlineEnabled?: unknown;
  readonly inlineDebounceMs?: unknown;
  readonly inline?: {
    readonly enabled?: unknown;
    readonly debounceMs?: unknown;
    readonly [key: string]: unknown;
  } | null;
  readonly [key: string]: unknown;
}

export interface AiInlineRendererState {
  readonly ai?: AiInlineStatePort | null;
  readonly currentViewMode?: string | null;
  readonly editor?: AiInlineEditorPort | null;
  readonly splitEditor?: AiInlineSplitEditorPort | null;
  readonly [key: string]: unknown;
}

export type AiInlineAiServicePort = Pick<
  AiService,
  'updateSettings' | 'getInlineCompletion' | 'cancelInline'
>;

export type AiInlineAiContextPort = Pick<
  AiContextService,
  'getInlineContext'
>;

export interface AiInlineLogger {
  warn?(message?: unknown, ...values: unknown[]): void;
  error?(message?: unknown, ...values: unknown[]): void;
}

export interface AiInlineDependencies {
  readonly state: AiInlineRendererState;
  readonly getAiService: () => AiInlineAiServicePort | null | undefined;
  readonly getAiContext: () => AiInlineAiContextPort | null | undefined;
  readonly getMonaco: () => AiInlineMonacoPort | null | undefined;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly logger?: AiInlineLogger;
}

/** Historical seven-key BOBO projection. */
export interface AiInlineFacade {
  init(monaco?: AiInlineMonacoPort): void;
  setEnabled(enabled: boolean): Promise<AiOperationResultDto>;
  trigger(): boolean;
  cancelPending(): void;
  registerForLanguage(language: string): void;
  registerForAllLanguages(): void;
  _createProvider(): AiInlineProvider;
}

export interface AiInlineService extends AiInlineFacade, Disposable {
  readonly disposed: boolean;
}
