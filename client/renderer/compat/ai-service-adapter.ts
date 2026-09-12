import {
  AI_SERVICE_ID,
  createAiService
} from '../../src/ai-service';
import type {
  AiPromptsFacade
} from '../../types/ai-prompts';
import type {
  AiService,
  AiServiceFacade,
  AiServiceHostPort,
  AiServiceRendererState,
  AiSettingsSchemaPort
} from '../../types/ai-service';
import type { RendererState } from '../../types/state';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyAiServiceBobo {
  state?: RendererState;
  aiSettingsSchema?: AiSettingsSchemaPort;
  aiPrompts?: AiPromptsFacade;
  aiAgentButton?: { updateLEDs?: (status: string) => void } | null;
  aiService?: AiServiceFacade;
}

type LegacyAiServiceWindow = Window & { BOBO?: LegacyAiServiceBobo };

const legacyWindow = window as LegacyAiServiceWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('AI service requires renderer state.');
if (!BOBO.aiSettingsSchema) throw new Error('AI service requires ai-settings-schema.js.');

const host = rendererPlatform.services.require('host.ai') as Readonly<AiServiceHostPort>;
const aiService: AiService = createAiService({
  state: BOBO.state as unknown as AiServiceRendererState,
  schema: BOBO.aiSettingsSchema,
  getPrompts: () => BOBO.aiPrompts,
  host,
  getAgentButton: () => BOBO.aiAgentButton
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  AI_SERVICE_ID,
  aiService,
  { owner: 'core.ai-service', exposeToPlugins: false }
));

// Preserve the historical writable facade.  The disposable service itself is
// retained by the private registry and intentionally not projected to BOBO.
BOBO.aiService = {
  init: aiService.init,
  loadSettings: aiService.loadSettings,
  saveSettings: aiService.saveSettings,
  getSettings: aiService.getSettings,
  updateSettings: aiService.updateSettings,
  applySettings: aiService.applySettings,
  sendChat: aiService.sendChat,
  cancelStream: aiService.cancelStream,
  getInlineCompletion: aiService.getInlineCompletion,
  cancelInline: aiService.cancelInline,
  clearInlineCache: aiService.clearInlineCache,
  updateStatus: aiService.updateStatus,
  onStreamChunk: aiService.onStreamChunk,
  onStreamEnd: aiService.onStreamEnd,
  onStreamError: aiService.onStreamError,
  getProfiles: aiService.getProfiles,
  getProfileFor: aiService.getProfileFor,
  getProfileById: aiService.getProfileById,
  getConnectionFor: aiService.getConnectionFor,
  addProfile: aiService.addProfile,
  updateProfile: aiService.updateProfile,
  removeProfile: aiService.removeProfile,
  setProfileFor: aiService.setProfileFor,
  testProfileConnection: aiService.testProfileConnection,
  testActiveConnections: aiService.testActiveConnections,
  getConnectionHealth: aiService.getConnectionHealth,
  getModelFor: aiService.getModelFor,
  getModelById: aiService.getModelById,
  getCurrentModelConfig: aiService.getCurrentModelConfig,
  getCurrentModelName: aiService.getCurrentModelName,
  getModelStatus: aiService.getModelStatus,
  addModel: aiService.addModel,
  updateModel: aiService.updateModel,
  removeModel: aiService.removeModel,
  setCurrentModel: aiService.setCurrentModel,
  setModelFor: aiService.setModelFor,
  testModelConnection: aiService.testModelConnection,
  buildChatPayload: aiService.buildChatPayload,
  buildInlineRequest: aiService.buildInlineRequest,
  buildMessages: aiService.buildMessages,
  extractInlineText: aiService.extractInlineText,
  extractChatText: aiService.extractChatText,
  sanitizeModel: aiService.sanitizeModel,
  fingerprint: aiService.fingerprint
};

export { aiService };
