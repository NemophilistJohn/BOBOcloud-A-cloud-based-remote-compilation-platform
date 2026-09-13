// Compatibility loader for the lazy AI presentation bundle.
//
// This module intentionally stays a small compatibility edge.  The bundle is
// loaded only after a visible AI action, while the two historical BOBO
// projections continue to behave exactly as they did for legacy callers.
import type {
  AiUiBundle,
  AiUiLoaderBobo,
  AiUiLoaderFacade
} from '../types/ai-ui-loader';
import type { AiChatPanelFacade } from '../types/ai-chat-panel';
import type { AiSettingsCenterFacade } from '../types/ai-settings-center';
import type { AiOperationResultDto } from '../types/ai-service';

type LoaderWindow = Window & { BOBO?: AiUiLoaderBobo };
type InvocationKind = 'chat' | 'settings';
type Invocable = (this: object, ...args: unknown[]) => unknown;

(function(global: LoaderWindow): void {
  'use strict';

  const BOBO = global.BOBO = global.BOBO || {};
  let loadPromise: Promise<AiUiBundle> | null = null;
  let loaded = false;
  let chatInitPending = false;
  let settingsInitPending = false;

  function t(key: string): string {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(key) : key;
  }

  function reportLoadFailure(error: unknown): void {
    console.error('AI UI bundle:', error);
    if (BOBO.toast && BOBO.toast.error) BOBO.toast.error(t('Failed to load'));
  }

  function finishLoad(
    resolve: (value: AiUiBundle) => void,
    reject: (reason?: unknown) => void,
    script: HTMLScriptElement
  ): void {
    const chatPanel = BOBO.aiChatPanel;
    const settingsCenter = BOBO.aiSettingsCenter;
    if (chatPanel === chatProxy || settingsCenter === settingsProxy) {
      const registrationError = new Error('AI UI bundle did not register its public modules.');
      script.remove();
      reject(registrationError);
      return;
    }

    try {
      if (chatInitPending && chatPanel && chatPanel.init) chatPanel.init();
      if (settingsInitPending && settingsCenter && settingsCenter.init) settingsCenter.init();
      loaded = true;
      resolve({ chatPanel, settingsCenter });
    } catch (error) {
      script.remove();
      reject(error);
    }
  }

  function ensureLoaded(): Promise<AiUiBundle> {
    if (loaded) {
      return Promise.resolve({
        chatPanel: BOBO.aiChatPanel,
        settingsCenter: BOBO.aiSettingsCenter
      });
    }
    if (loadPromise) return loadPromise;

    const attempt = new Promise<AiUiBundle>((resolve, reject) => {
      const script = global.document.createElement('script');
      script.src = './renderer-dist/bobo-ai-ui.js';
      script.async = true;
      script.dataset.boboAiUi = 'true';
      script.onload = (): void => { finishLoad(resolve, reject, script); };
      script.onerror = (): void => {
        script.remove();
        reject(new Error('AI UI bundle could not be loaded.'));
      };
      global.document.head.appendChild(script);
    });
    loadPromise = attempt.catch((error: unknown) => {
      loadPromise = null;
      reportLoadFailure(error);
      throw error;
    });
    return loadPromise;
  }

  function invoke<Result = void>(kind: InvocationKind, method: string, args: IArguments): Promise<Result> {
    return ensureLoaded().then(() => {
      const target = kind === 'chat' ? BOBO.aiChatPanel : BOBO.aiSettingsCenter;
      if (!target || target === chatProxy || target === settingsProxy) {
        throw new Error('AI UI method is unavailable: ' + kind + '.' + method);
      }
      const callableTarget = target as unknown as Record<string, unknown>;
      if (typeof callableTarget[method] !== 'function') {
        throw new Error('AI UI method is unavailable: ' + kind + '.' + method);
      }
      // Keep the historical second property lookup before apply().  A legacy
      // embedding may expose an accessor, and the loader must retain its
      // original lookup/dispatch behavior at this compatibility edge.
      return (callableTarget[method] as Invocable).apply(target, Array.from(args)) as Result;
    }).catch(() => undefined as Result);
  }

  const chatProxy: AiChatPanelFacade = {
    init(): void { chatInitPending = true; },
    setVisible(): Promise<void> { return invoke<void>('chat', 'setVisible', arguments); },
    sendMessage(): Promise<void> { return invoke<void>('chat', 'sendMessage', arguments); },
    clearChat(): Promise<void> { return invoke<void>('chat', 'clearChat', arguments); },
    updateContextBar(): Promise<void> { return invoke<void>('chat', 'updateContextBar', arguments); },
    addReferencedFile(): Promise<void> {
      return invoke<void>('chat', 'addReferencedFile', arguments);
    },
    removeReferencedFile(): Promise<void> {
      return invoke<void>('chat', 'removeReferencedFile', arguments);
    },
    excludeAutoFileContext(): Promise<void> {
      return invoke<void>('chat', 'excludeAutoFileContext', arguments);
    },
    openFilePicker(): Promise<void> {
      return invoke<void>('chat', 'openFilePicker', arguments);
    },
    saveChatHistory(): Promise<void> { return invoke<void>('chat', 'saveChatHistory', arguments); }
  };

  const settingsProxy: AiSettingsCenterFacade = {
    init(): void { settingsInitPending = true; },
    open(): Promise<void> { return invoke<void>('settings', 'open', arguments); },
    close(): Promise<void> { return invoke<void>('settings', 'close', arguments); },
    save(): Promise<AiOperationResultDto | undefined> {
      return invoke<AiOperationResultDto | undefined>('settings', 'save', arguments);
    },
    switchTab(): Promise<void> { return invoke<void>('settings', 'switchTab', arguments); },
    isDirty(): boolean { return false; },
    getDraft(): null { return null; }
  };

  BOBO.aiChatPanel = chatProxy;
  BOBO.aiSettingsCenter = settingsProxy;
  const aiUiLoader: AiUiLoaderFacade = {
    ensureLoaded,
    isLoaded: (): boolean => loaded
  };
  BOBO.aiUiLoader = aiUiLoader;
})(window);
