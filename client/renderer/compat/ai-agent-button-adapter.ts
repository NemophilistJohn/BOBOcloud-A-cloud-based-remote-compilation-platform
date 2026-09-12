import {
  AI_AGENT_BUTTON_SERVICE_ID,
  createAiAgentButtonService
} from '../../src/ai-agent-button';
import { AI_INLINE_SERVICE_ID } from '../../src/ai-inline';
import { AI_SERVICE_ID } from '../../src/ai-service';
import { TOAST_SERVICE_ID } from '../../src/toast';
import { WORKBENCH_LAYOUT_SERVICE_ID } from '../../src/workbench-layout';
import type {
  AiAgentButtonChatPanelPort,
  AiAgentButtonFacade,
  AiAgentButtonRendererState,
  AiAgentButtonService,
  AiAgentButtonSettingsCenterPort
} from '../../types/ai-agent-button';
import type { AiInlineService } from '../../types/ai-inline';
import type { AiService } from '../../types/ai-service';
import type { I18nService } from '../../types/i18n';
import type { RendererState } from '../../types/state';
import type { ToastService } from '../../types/toast';
import type { WorkbenchLayoutService } from '../../types/workbench-layout';
import { AI_UI_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyAiAgentButtonBobo {
  state?: RendererState;
  i18n?: I18nService;
  toast?: ToastService;
  workbench?: WorkbenchLayoutService;
  aiService?: AiService;
  aiInline?: AiInlineService;
  aiChatPanel?: AiAgentButtonChatPanelPort;
  aiSettingsCenter?: AiAgentButtonSettingsCenterPort;
  aiAgentButton?: AiAgentButtonFacade;
}

type LegacyAiAgentButtonWindow = Window & { BOBO?: LegacyAiAgentButtonBobo };

const legacyWindow = window as LegacyAiAgentButtonWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('AI agent button requires renderer state.');

const aiAgentButton: AiAgentButtonService = createAiAgentButtonService({
  document,
  state: BOBO.state as unknown as AiAgentButtonRendererState,
  getI18n: () => rendererPlatform.services.get('workbench.i18n') || BOBO.i18n,
  getAiService: () => rendererPlatform.services.get(AI_SERVICE_ID),
  getAiInline: () => rendererPlatform.services.get(AI_INLINE_SERVICE_ID),
  getWorkbench: () => rendererPlatform.services.get(WORKBENCH_LAYOUT_SERVICE_ID),
  getChatPanel: () => BOBO.aiChatPanel,
  getSettingsCenter: () => BOBO.aiSettingsCenter,
  getToast: () => rendererPlatform.services.get(TOAST_SERVICE_ID) || BOBO.toast,
  host: rendererPlatform.services.get(AI_UI_HOST_SERVICE_ID),
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  AI_AGENT_BUTTON_SERVICE_ID,
  aiAgentButton,
  { owner: 'core.ai-agent-button', exposeToPlugins: false }
));

// Preserve the historical writable five-key facade. The disposable service
// remains private to the renderer service registry and is never sent to a
// downloaded plugin.
BOBO.aiAgentButton = {
  init: aiAgentButton.init,
  updateLEDs: aiAgentButton.updateLEDs,
  toggleChat: aiAgentButton.toggleChat,
  openMenu: aiAgentButton.openMenu,
  closeMenu: aiAgentButton.closeMenu
};

export { aiAgentButton };
