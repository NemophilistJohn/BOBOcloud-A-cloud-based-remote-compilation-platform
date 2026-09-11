import {
  AI_CONTEXT_SERVICE_ID,
  createAiContextService
} from '../../src/ai-context';
import type {
  AiContextFacade,
  AiContextPromptsPort,
  AiContextRendererState,
  AiContextService
} from '../../types/ai-context';
import type { AiPromptsFacade } from '../../types/ai-prompts';
import type { RendererState } from '../../types/state';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyAiContextBobo {
  state?: RendererState;
  aiPrompts?: AiPromptsFacade;
  aiContext?: AiContextFacade;
}

interface LegacyAiContextWindow extends Window {
  BOBO?: LegacyAiContextBobo;
}

const legacyWindow = window as LegacyAiContextWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('AI context requires renderer state.');

const aiContext: AiContextService = createAiContextService({
  document: legacyWindow.document,
  state: BOBO.state as unknown as AiContextRendererState,
  getAiPrompts: () => BOBO.aiPrompts as AiContextPromptsPort | undefined
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  AI_CONTEXT_SERVICE_ID,
  aiContext,
  { owner: 'core.ai-context', exposeToPlugins: false }
));

// Preserve the historical writable six-method facade. Disposal remains owned
// by the private renderer service registry and is not projected to plugins.
BOBO.aiContext = {
  getCurrentFileContext: aiContext.getCurrentFileContext,
  getSelectionContext: aiContext.getSelectionContext,
  getProjectContext: aiContext.getProjectContext,
  getActiveTabContexts: aiContext.getActiveTabContexts,
  buildFullContext: aiContext.buildFullContext,
  getInlineContext: aiContext.getInlineContext
};

export { aiContext };
