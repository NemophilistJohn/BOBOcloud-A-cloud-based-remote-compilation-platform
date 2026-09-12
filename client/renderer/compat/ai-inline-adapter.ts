import {
  AI_INLINE_SERVICE_ID,
  createAiInlineService
} from '../../src/ai-inline';
import type {
  AiInlineFacade,
  AiInlineMonacoPort,
  AiInlineService,
  AiInlineRendererState
} from '../../types/ai-inline';
import type { AiContextFacade, AiContextService } from '../../types/ai-context';
import type { AiService, AiServiceFacade } from '../../types/ai-service';
import type { RendererState } from '../../types/state';
import {
  AI_CONTEXT_SERVICE_ID
} from '../../src/ai-context';
import { AI_SERVICE_ID } from '../../src/ai-service';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyAiInlineBobo {
  state?: RendererState;
  aiService?: AiServiceFacade;
  aiContext?: AiContextFacade;
  aiInline?: AiInlineFacade;
}

type LegacyAiInlineWindow = Window & {
  BOBO?: LegacyAiInlineBobo;
  monaco?: AiInlineMonacoPort;
};

const legacyWindow = window as LegacyAiInlineWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('AI inline requires renderer state.');

const aiInline: AiInlineService = createAiInlineService({
  state: BOBO.state as unknown as AiInlineRendererState,
  getAiService: () => rendererPlatform.services.require(AI_SERVICE_ID) as AiService,
  getAiContext: () => rendererPlatform.services.require(AI_CONTEXT_SERVICE_ID) as AiContextService,
  getMonaco: () => legacyWindow.monaco,
  setTimeout: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimeout: (timer) => legacyWindow.clearTimeout(timer as number),
  logger: console
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  AI_INLINE_SERVICE_ID,
  aiInline,
  { owner: 'core.ai-inline', exposeToPlugins: false }
));

// Preserve the historical writable facade. The disposable service remains
// private to the renderer service registry and is not exposed to plugins.
BOBO.aiInline = {
  init: aiInline.init,
  setEnabled: aiInline.setEnabled,
  trigger: aiInline.trigger,
  cancelPending: aiInline.cancelPending,
  registerForLanguage: aiInline.registerForLanguage,
  registerForAllLanguages: aiInline.registerForAllLanguages,
  _createProvider: aiInline._createProvider
};

export { aiInline };
