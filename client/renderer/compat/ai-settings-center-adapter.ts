import {
  AI_SETTINGS_CENTER_SERVICE_ID,
  createAiSettingsCenterService
} from '../../src/ai-settings-center';
import { AI_AGENT_BUTTON_SERVICE_ID } from '../../src/ai-agent-button';
import { AI_SERVICE_ID } from '../../src/ai-service';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import type {
  AiSettingsCenterFacade,
  AiSettingsCenterRendererState,
  AiSettingsCenterService,
  AiSettingsCenterSchemaPort
} from '../../types/ai-settings-center';
import type { AiService } from '../../types/ai-service';
import type { ConfirmService } from '../../types/confirm-dialog';
import type { I18nService } from '../../types/i18n';
import type { RendererState } from '../../types/state';
import type { RendererIconsFacade } from '../../types/icons';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyAiSettingsBobo {
  state?: RendererState;
  i18n?: I18nService;
  aiSettingsSchema?: AiSettingsCenterSchemaPort;
  aiService?: AiService;
  confirm?: ConfirmService['confirm'];
  icons?: RendererIconsFacade;
  aiAgentButton?: { updateLEDs?(status: string): void };
  agentWorkbench?: { refreshModels?(): unknown };
  aiSettingsCenter?: AiSettingsCenterFacade;
}

type LegacyAiSettingsWindow = Window & { BOBO?: LegacyAiSettingsBobo };

const legacyWindow = window as LegacyAiSettingsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('AI settings center requires renderer state.');

const confirmService = rendererPlatform.services.get(CONFIRM_SERVICE_ID);

const aiSettingsCenter: AiSettingsCenterService = createAiSettingsCenterService({
  document,
  state: BOBO.state as unknown as AiSettingsCenterRendererState,
  getI18n: () => rendererPlatform.services.get('workbench.i18n') || BOBO.i18n,
  getSchema: () => BOBO.aiSettingsSchema,
  getAiService: () => rendererPlatform.services.get(AI_SERVICE_ID) as AiService | undefined,
  getConfirm: () => BOBO.confirm || confirmService?.confirm,
  getIcons: () => BOBO.icons,
  getAgentButton: () => rendererPlatform.services.get(AI_AGENT_BUTTON_SERVICE_ID),
  getAgentWorkbench: () => BOBO.agentWorkbench,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer),
  logger: console
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  AI_SETTINGS_CENTER_SERVICE_ID,
  aiSettingsCenter,
  { owner: 'core.ai-settings-center', exposeToPlugins: false }
));

// Keep the loader's historical seven-key facade. The disposable service stays
// private to the trusted renderer registry and is not exposed to plugins.
BOBO.aiSettingsCenter = {
  init: aiSettingsCenter.init,
  open: aiSettingsCenter.open,
  close: aiSettingsCenter.close,
  save: aiSettingsCenter.save,
  switchTab: aiSettingsCenter.switchTab,
  isDirty: aiSettingsCenter.isDirty,
  getDraft: aiSettingsCenter.getDraft
};

export { aiSettingsCenter };
