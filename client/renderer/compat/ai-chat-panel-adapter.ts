import {
  AI_CHAT_PANEL_SERVICE_ID,
  createAiChatPanelService
} from '../../src/ai-chat-panel';
import { AI_AGENT_BUTTON_SERVICE_ID } from '../../src/ai-agent-button';
import { AI_CONTEXT_SERVICE_ID } from '../../src/ai-context';
import { AI_SERVICE_ID } from '../../src/ai-service';
import { TOAST_SERVICE_ID } from '../../src/toast';
import { WORKBENCH_LAYOUT_SERVICE_ID } from '../../src/workbench-layout';
import type {
  AiChatPanelFacade,
  AiChatPanelRendererState,
  AiChatPanelService
} from '../../types/ai-chat-panel';
import type { AiContextFacade } from '../../types/ai-context';
import type { AiMarkdownFacade } from '../../types/ai-markdown';
import type { AiPromptsFacade } from '../../types/ai-prompts';
import type { AiService } from '../../types/ai-service';
import type { AiAgentButtonFacade } from '../../types/ai-agent-button';
import type { I18nService } from '../../types/i18n';
import type { RendererState } from '../../types/state';
import type { RendererIconsFacade } from '../../types/icons';
import type { ToastFacade } from '../../types/toast';
import type { WorkbenchLayoutFacade } from '../../types/workbench-layout';
import type { StreamRenderSchedulerFactory } from '../../types/stream-render-scheduler';
import { rendererPlatform } from '../core/bootstrap';

// Keep this lazy adapter independent of the side-effectful native-host
// composition module. The core bundle registers the same private id once.
const AI_CHAT_PANEL_HOST_SERVICE_ID = 'host.aiChatPanel' as const;

interface LegacyAiChatPanelBobo {
  state?: RendererState;
  i18n?: I18nService;
  aiService?: AiService;
  aiContext?: AiContextFacade;
  aiPrompts?: AiPromptsFacade;
  aiMarkdown?: AiMarkdownFacade;
  aiSettingsCenter?: { open?(tab?: string): unknown };
  aiAgentButton?: AiAgentButtonFacade;
  workbench?: WorkbenchLayoutFacade;
  icons?: RendererIconsFacade;
  toast?: ToastFacade;
  createStreamRenderScheduler?: StreamRenderSchedulerFactory;
  aiChatPanel?: AiChatPanelFacade;
}

type LegacyAiChatPanelWindow = Window & { BOBO?: LegacyAiChatPanelBobo };

const legacyWindow = window as LegacyAiChatPanelWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('AI chat panel requires renderer state.');

const chatPanel: AiChatPanelService = createAiChatPanelService({
  document: legacyWindow.document,
  window: legacyWindow,
  state: BOBO.state as unknown as AiChatPanelRendererState,
  getI18n: () => rendererPlatform.services.get('workbench.i18n') || BOBO.i18n,
  // Legacy projections remain authoritative when an embedding or test has
  // replaced them; the registry supplies the normal production service.
  getAiService: () => BOBO.aiService || rendererPlatform.services.get(AI_SERVICE_ID),
  getAiContext: () => BOBO.aiContext || rendererPlatform.services.get(AI_CONTEXT_SERVICE_ID),
  getAiPrompts: () => BOBO.aiPrompts,
  getAiMarkdown: () => BOBO.aiMarkdown,
  getSettingsCenter: () => BOBO.aiSettingsCenter,
  getAgentButton: () => BOBO.aiAgentButton || rendererPlatform.services.get(AI_AGENT_BUTTON_SERVICE_ID),
  getWorkbench: () => BOBO.workbench || rendererPlatform.services.get(WORKBENCH_LAYOUT_SERVICE_ID),
  getToast: () => BOBO.toast || rendererPlatform.services.get(TOAST_SERVICE_ID),
  getIcons: () => BOBO.icons as RendererIconsFacade,
  getSchedulerFactory: () => BOBO.createStreamRenderScheduler,
  host: rendererPlatform.services.require(AI_CHAT_PANEL_HOST_SERVICE_ID),
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer),
  logger: console
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  AI_CHAT_PANEL_SERVICE_ID,
  chatPanel,
  { owner: 'core.ai-chat-panel', exposeToPlugins: false }
));

// Keep the historical ten-key writable facade at the compatibility edge. The
// disposable service itself remains private to the trusted renderer registry.
BOBO.aiChatPanel = {
  init: chatPanel.init,
  setVisible: chatPanel.setVisible,
  sendMessage: chatPanel.sendMessage,
  clearChat: chatPanel.clearChat,
  updateContextBar: chatPanel.updateContextBar,
  addReferencedFile: chatPanel.addReferencedFile,
  removeReferencedFile: chatPanel.removeReferencedFile,
  excludeAutoFileContext: chatPanel.excludeAutoFileContext,
  openFilePicker: chatPanel.openFilePicker,
  saveChatHistory: chatPanel.saveChatHistory
};

export { chatPanel };
