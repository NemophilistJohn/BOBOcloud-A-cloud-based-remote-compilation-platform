// Monaco inline suggestions with debounce and latest-wins cancellation.
//
// The service owns Monaco registrations and every asynchronous request.  The
// compatibility adapter is responsible for projecting the historical BOBO
// facade; this module never reaches the preload bridge or the global namespace.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
import type {
  AiInlineAiContextPort,
  AiInlineAiServicePort,
  AiInlineCancellationTokenPort,
  AiInlineCompletionItemDto,
  AiInlineCompletionListDto,
  AiInlineDependencies,
  AiInlineFacade,
  AiInlineModelPort,
  AiInlineMonacoPort,
  AiInlinePositionDto,
  AiInlineProvider,
  AiInlineRendererState,
  AiInlineService,
  AiInlineStatePort,
  AiInlineTriggerContextDto
} from '../types/ai-inline';
import type { AiOperationResultDto } from '../types/ai-service';

export const AI_INLINE_SERVICE_ID = 'workbench.aiInline' as const;

/** Languages supported by the legacy inline provider. */
export const AI_INLINE_LANGUAGES = Object.freeze([
  'python', 'javascript', 'typescript', 'java', 'c', 'cpp', 'go', 'rust',
  'html', 'css', 'json', 'xml', 'yaml', 'markdown', 'sql', 'shell', 'plaintext',
  'ruby', 'php', 'swift', 'kotlin', 'csharp', 'scala', 'lua', 'perl', 'r'
] as const);

const EMPTY_CODE = 'ai.error.cancelled';

interface PendingRequest {
  readonly sequence: number;
  readonly generation: number;
  readonly resolve: (value: AiInlineCompletionListDto) => void;
  cancelled: boolean;
  settled: boolean;
  timer: unknown | null;
  tokenDisposable: Disposable | null;
}

function isDisposable(value: unknown): value is Disposable {
  return value !== null && value !== undefined &&
    typeof (value as { dispose?: unknown }).dispose === 'function';
}

/** Normalize Monaco and legacy mock registration return values. */
function asDisposable(value: unknown): Disposable {
  if (typeof value === 'function') return toDisposable(value as () => void);
  if (isDisposable(value)) return toDisposable(() => value.dispose());
  // Some older Monaco test doubles return `true`/`undefined` as a marker.
  return toDisposable(() => {});
}

function empty(): AiInlineCompletionListDto {
  return { items: [] };
}

function aiState(state: AiInlineRendererState): AiInlineStatePort | null {
  return state.ai || null;
}

function inlineSettings(state: AiInlineRendererState): {
  readonly enabled?: unknown;
  readonly debounceMs?: unknown;
} {
  const ai = aiState(state);
  const canonical = ai?.inline;
  if (canonical && typeof canonical === 'object') return canonical;
  return {
    enabled: ai?.inlineEnabled === true,
    debounceMs: ai?.inlineDebounceMs
  };
}

function modelVersion(model: AiInlineModelPort): number | null {
  if (typeof model.getVersionId !== 'function') return null;
  try {
    const value = model.getVersionId();
    return typeof value === 'number' ? value : null;
  } catch (_) {
    return null;
  }
}

export function createAiInlineService(
  dependencies: AiInlineDependencies
): AiInlineService {
  const { state } = dependencies;
  const lifecycle = new DisposableStore({
    onError: (event) => warn('AI inline disposal:', event.error)
  });

  let monacoRef: AiInlineMonacoPort | null = null;
  const registrations = new Map<string, Disposable>();
  let modelListener: Disposable | null = null;
  let modelListenerBound = false;
  let initialized = false;
  let sequence = 0;
  let lifecycleGeneration = 0;
  let pending: PendingRequest | null = null;
  let disposed = false;

  function warn(message: string, error?: unknown): void {
    const logger = dependencies.logger;
    if (!logger || typeof logger.warn !== 'function') return;
    if (error === undefined) logger.warn(message);
    else logger.warn(message, error);
  }

  function safeClearTimer(handle: unknown): void {
    try {
      dependencies.clearTimeout(handle);
    } catch (error) {
      warn('AI inline timer cleanup failed.', error);
    }
  }

  function safeDispose(disposable: Disposable, message: string): void {
    try {
      disposable.dispose();
    } catch (error) {
      warn(message, error);
    }
  }

  function disposeToken(request: PendingRequest): void {
    const registration = request.tokenDisposable;
    request.tokenDisposable = null;
    if (!registration) return;
    lifecycle.delete(registration);
    safeDispose(registration, 'AI inline token cleanup failed.');
  }

  function settle(request: PendingRequest, value: AiInlineCompletionListDto): void {
    if (request.settled) return;
    request.settled = true;
    if (pending === request) pending = null;
    if (request.timer !== null) {
      safeClearTimer(request.timer);
      request.timer = null;
    }
    disposeToken(request);
    request.resolve(value);
  }

  function cancelTransport(): void {
    let service: AiInlineAiServicePort | null | undefined;
    try {
      service = dependencies.getAiService();
    } catch (error) {
      warn('AI inline service unavailable during cancellation.', error);
      return;
    }
    if (!service || typeof service.cancelInline !== 'function') return;
    try {
      service.cancelInline();
    } catch (error) {
      warn('AI inline cancellation failed.', error);
    }
  }

  function cancelPending(): void {
    sequence += 1;
    const request = pending;
    pending = null;
    if (request) {
      request.cancelled = true;
      request.settled = true;
      if (request.timer !== null) {
        safeClearTimer(request.timer);
        request.timer = null;
      }
      disposeToken(request);
      request.resolve(empty());
    }
    cancelTransport();
  }

  function requestIsCurrent(request: PendingRequest): boolean {
    return !disposed && !request.cancelled && !request.settled &&
      request.sequence === sequence && request.generation === lifecycleGeneration;
  }

  async function runRequest(
    request: PendingRequest,
    model: AiInlineModelPort,
    position: AiInlinePositionDto,
    capturedVersion: number | null
  ): Promise<void> {
    if (!requestIsCurrent(request) || inlineSettings(state).enabled !== true) {
      settle(request, empty());
      return;
    }

    let contextService: AiInlineAiContextPort | null | undefined;
    try {
      contextService = dependencies.getAiContext();
    } catch (error) {
      warn('AI inline context service unavailable.', error);
      settle(request, empty());
      return;
    }
    if (!contextService || typeof contextService.getInlineContext !== 'function') {
      settle(request, empty());
      return;
    }

    let context;
    try {
      context = contextService.getInlineContext(model, position);
    } catch (error) {
      warn('AI inline context unavailable.', error);
      settle(request, empty());
      return;
    }
    if (!context) {
      settle(request, empty());
      return;
    }

    let service: AiInlineAiServicePort | null | undefined;
    try {
      service = dependencies.getAiService();
    } catch (error) {
      warn('AI inline service unavailable.', error);
      settle(request, empty());
      return;
    }
    if (!service || typeof service.getInlineCompletion !== 'function') {
      settle(request, empty());
      return;
    }

    let result;
    try {
      result = await service.getInlineCompletion(context);
    } catch (error) {
      // A provider/network failure must not leave Monaco's completion promise
      // pending or surface an unhandled rejection during a superseded request.
      if (requestIsCurrent(request)) warn('AI inline completion failed.', error);
      settle(request, empty());
      return;
    }

    if (!requestIsCurrent(request) || inlineSettings(state).enabled !== true) {
      settle(request, empty());
      return;
    }
    if (capturedVersion !== null && modelVersion(model) !== capturedVersion) {
      settle(request, empty());
      return;
    }
    if (!result || !result.success || !result.text) {
      settle(request, empty());
      return;
    }

    const item: AiInlineCompletionItemDto = {
      insertText: result.text,
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }
    };
    settle(request, { items: [item] });
  }

  function schedule(
    model: AiInlineModelPort,
    position: AiInlinePositionDto,
    token: AiInlineCancellationTokenPort | null | undefined
  ): Promise<AiInlineCompletionListDto> {
    cancelPending();
    const requestSequence = sequence;
    const requestGeneration = lifecycleGeneration;
    const capturedVersion = modelVersion(model);
    const rawDelay = Number(inlineSettings(state).debounceMs) || 450;
    const delay = Math.max(150, Math.min(2000, rawDelay));

    return new Promise<AiInlineCompletionListDto>((resolve) => {
      const request: PendingRequest = {
        sequence: requestSequence,
        generation: requestGeneration,
        resolve,
        cancelled: false,
        settled: false,
        timer: null,
        tokenDisposable: null
      };
      pending = request;

      let tokenCancelled = false;
      if (token && typeof token.onCancellationRequested === 'function') {
        try {
          const registration = token.onCancellationRequested(() => {
            if (request.settled) return;
            tokenCancelled = true;
            request.cancelled = true;
            if (request.sequence === sequence && request.generation === lifecycleGeneration) {
              cancelPending();
            } else {
              settle(request, empty());
            }
          });
          const disposable = asDisposable(registration);
          if (!tokenCancelled && !request.settled && !disposed) {
            request.tokenDisposable = disposable;
            lifecycle.add(disposable);
          } else {
            disposable.dispose();
          }
        } catch (error) {
          warn('AI inline cancellation token unavailable.', error);
        }
      }

      if (request.settled || request.cancelled || disposed) return;

      let timerFiredSynchronously = false;
      let timerHandle: unknown = null;
      const onTimer = (): void => {
        timerFiredSynchronously = true;
        if (request.timer === timerHandle || request.timer === null) request.timer = null;
        void runRequest(request, model, position, capturedVersion);
      };
      try {
        timerHandle = dependencies.setTimeout(onTimer, delay);
      } catch (error) {
        warn('AI inline timer unavailable.', error);
        settle(request, empty());
        return;
      }
      if (!timerFiredSynchronously && !request.settled && pending === request) {
        request.timer = timerHandle;
      }
    });
  }

  function createProvider(): AiInlineProvider {
    return {
      provideInlineCompletions(
        model,
        position,
        context,
        token
      ): AiInlineCompletionListDto | Promise<AiInlineCompletionListDto> {
        const ai = aiState(state);
        if (disposed || !ai || inlineSettings(state).enabled !== true) return empty();
        let service: AiInlineAiServicePort | null | undefined;
        try {
          service = dependencies.getAiService();
        } catch (error) {
          warn('AI inline service unavailable.', error);
          return empty();
        }
        if (!service) return empty();
        const automatic = monacoRef?.languages?.InlineCompletionTriggerKind?.Automatic;
        if (context && context.triggerKind !== automatic) return empty();
        return schedule(model, position, token);
      },
      disposeInlineCompletions: (_completions) => {},
      // Kept for Monaco versions that used the earlier provider hook name.
      freeInlineCompletions: (_completions) => {}
    };
  }

  function registerForLanguage(language: string): void {
    if (disposed || !monacoRef || typeof language !== 'string' || !language || registrations.has(language)) {
      return;
    }
    try {
      const registration = monacoRef.languages.registerInlineCompletionsProvider(
        language,
        createProvider()
      );
      const disposable = asDisposable(registration);
      registrations.set(language, disposable);
      lifecycle.add(disposable);
    } catch (error) {
      warn('AI inline provider unavailable for ' + language, error);
    }
  }

  function registerForAllLanguages(): void {
    if (disposed || !monacoRef) return;
    for (const language of AI_INLINE_LANGUAGES) registerForLanguage(language);

    if (!modelListenerBound && monacoRef.editor &&
        typeof monacoRef.editor.onDidCreateModel === 'function') {
      modelListenerBound = true;
      const target = monacoRef;
      try {
        const registration = target.editor?.onDidCreateModel?.((model) => {
          if (monacoRef !== target || disposed) return;
          try {
            registerForLanguage(model.getLanguageId());
          } catch (error) {
            warn('AI inline model registration failed.', error);
          }
        });
        modelListener = asDisposable(registration);
        lifecycle.add(modelListener);
      } catch (error) {
        modelListenerBound = false;
        warn('AI inline model listener unavailable.', error);
      }
    }
  }

  function disposeMonacoRegistrations(): void {
    const listener = modelListener;
    modelListener = null;
    modelListenerBound = false;
    if (listener) {
      lifecycle.delete(listener);
      safeDispose(listener, 'AI inline model listener cleanup failed.');
    }
    for (const registration of registrations.values()) {
      lifecycle.delete(registration);
      safeDispose(registration, 'AI inline provider cleanup failed.');
    }
    registrations.clear();
  }

  function init(monaco?: AiInlineMonacoPort): void {
    if (disposed) return;
    let next: AiInlineMonacoPort | null | undefined;
    try {
      next = monaco || dependencies.getMonaco();
    } catch (error) {
      warn('AI inline Monaco instance unavailable.', error);
      return;
    }
    if (!next) return;
    if (initialized && monacoRef === next) {
      registerForAllLanguages();
      return;
    }
    if (monacoRef && monacoRef !== next) {
      cancelPending();
      disposeMonacoRegistrations();
    }
    monacoRef = next;
    initialized = true;
    registerForAllLanguages();
  }

  async function setEnabled(enabled: boolean): Promise<AiOperationResultDto> {
    if (disposed) return { success: false, code: EMPTY_CODE };
    const value = enabled === true;
    let service: AiInlineAiServicePort | null | undefined;
    try {
      service = dependencies.getAiService();
    } catch (error) {
      warn('AI inline service unavailable.', error);
      return { success: false, code: 'ai.error.settingsWrite' };
    }
    if (!service || typeof service.updateSettings !== 'function') {
      return { success: false, code: 'ai.error.settingsWrite' };
    }
    if (value && !aiState(state)?.inlineProfileId) {
      return { success: false, code: 'ai.error.noModel' };
    }

    const requestGeneration = lifecycleGeneration;
    let result: AiOperationResultDto | null = null;
    try {
      result = await service.updateSettings({ inline: { enabled: value } });
    } catch (error) {
      if (disposed || requestGeneration !== lifecycleGeneration) {
        return { success: false, code: EMPTY_CODE };
      }
      warn('AI inline settings update failed.', error);
      return { success: false, code: 'ai.error.settingsWrite' };
    }
    if (disposed || requestGeneration !== lifecycleGeneration) {
      return { success: false, code: EMPTY_CODE };
    }
    if (!result || result.success === false) {
      return result || { success: false, code: 'ai.error.settingsWrite' };
    }
    if (!value) cancelPending();
    return result;
  }

  function trigger(): boolean {
    const split = state.currentViewMode === 'split' ? state.splitEditor : null;
    const editor = split?.rightEditor || state.editor || null;
    if (!editor || typeof editor.trigger !== 'function') return false;
    editor.trigger('bobo.ai', 'editor.action.inlineSuggest.trigger', {});
    return true;
  }

  function dispose(): void {
    if (disposed) return;
    lifecycleGeneration += 1;
    disposed = true;
    cancelPending();
    disposeMonacoRegistrations();
    lifecycle.dispose();
    monacoRef = null;
    initialized = false;
  }

  const facade: AiInlineFacade = {
    init,
    setEnabled,
    trigger,
    cancelPending,
    registerForLanguage,
    registerForAllLanguages,
    _createProvider: createProvider
  };
  const service: AiInlineService = {
    ...facade,
    get disposed(): boolean { return disposed; },
    dispose
  };
  return Object.freeze(service);
}
