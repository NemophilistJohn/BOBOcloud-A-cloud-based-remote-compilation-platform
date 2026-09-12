import {
  AGENT_WORKBENCH_SERVICE_ID,
  createAgentWorkbenchService
} from '../../src/agent-workbench';
import { createAgentCommandPayload } from '../core/agent.js';
import type {
  AgentWorkbenchAgentsPort,
  AgentWorkbenchAiSettingsCenterPort,
  AgentWorkbenchCommandsPort,
  AgentWorkbenchConfirmPort,
  AgentWorkbenchDocumentViewsPort,
  AgentWorkbenchFacade,
  AgentWorkbenchI18nPort,
  AgentWorkbenchService,
  AgentWorkbenchViewsPort,
  AgentWorkbenchWorkbenchPort,
  AgentWorkbenchWorkspacePort,
  AgentWorkbenchRendererState
} from '../../types/agent-workbench';
import type { ConfirmFacade } from '../../types/confirm-dialog';
import type { I18nService } from '../../types/i18n';
import type { RendererState } from '../../types/state';
import { rendererPlatform } from '../core/bootstrap';
import { toDisposable } from '../core/disposable.js';

// Keep this adapter independent from the native-host and platform compatibility
// modules.  The composition root loads those modules before this one, so these
// ids are stable registry contracts rather than runtime imports (which could
// otherwise re-run side effects or create a second host projection).
const AGENT_WORKBENCH_HOST_SERVICE_ID = 'host.agentWorkbench' as const;
const AI_SETTINGS_CENTER_SERVICE_ID = 'workbench.aiSettingsCenter' as const;
const CONFIRM_SERVICE_ID = 'workbench.confirm' as const;
const DOCUMENT_VIEWS_SERVICE_ID = 'workbench.documentViews' as const;
const I18N_SERVICE_ID = 'workbench.i18n' as const;
const VIEWS_SERVICE_ID = 'workbench.views' as const;
const WORKBENCH_LAYOUT_SERVICE_ID = 'workbench.layout' as const;

interface LegacyAgentWorkbenchPlatform {
  agents?: AgentWorkbenchAgentsPort;
  commands?: AgentWorkbenchCommandsPort;
}

interface LegacyAgentWorkbenchBobo {
  state?: RendererState;
  platform?: LegacyAgentWorkbenchPlatform;
  i18n?: I18nService;
  confirm?: ConfirmFacade;
  aiSettingsCenter?: AgentWorkbenchAiSettingsCenterPort;
  workspace?: AgentWorkbenchWorkspacePort;
  workbench?: AgentWorkbenchWorkbenchPort;
  views?: AgentWorkbenchViewsPort;
  documentViews?: AgentWorkbenchDocumentViewsPort;
  agentWorkbench?: AgentWorkbenchFacade;
}

type AgentWorkbenchWindow = Window & { BOBO?: LegacyAgentWorkbenchBobo };

const legacyWindow = window as AgentWorkbenchWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state;
if (!state) throw new Error('Agent workbench requires renderer state.');

// `rendererPlatform` exposes the strongly typed stores directly, while the
// old BOBO surface expects the small facade methods used by the workbench.
// Build that bridge locally so this adapter does not import platform-adapter
// (and therefore cannot instantiate or overwrite its compatibility projection).
const fallbackAgents: AgentWorkbenchAgentsPort = Object.freeze({
  list: (...args: Parameters<typeof rendererPlatform.agents.list>) => (
    rendererPlatform.agents.list(...args)
  ),
  get: (...args: Parameters<typeof rendererPlatform.agents.get>) => (
    rendererPlatform.agents.get(...args)
  ),
  onDidChange: (...args: Parameters<typeof rendererPlatform.agents.onDidChange>) => (
    rendererPlatform.agents.onDidChange(...args)
  ),
  createCommandPayload: (providerId, action, values) => (
    createAgentCommandPayload(providerId, action, values)
  )
});

const fallbackCommands: AgentWorkbenchCommandsPort = Object.freeze({
  executeIsolated: (id, ...args) => (
    rendererPlatform.commands.executeDynamicIsolated(id, ...args)
  )
});

/**
 * Keep the historical BOBO projections usable for embedders that replace a
 * sibling service, while normal production bootstraps prefer the typed
 * registry. Each getter is evaluated at call time to preserve replacement
 * semantics and avoid capturing an initialization-order race.
 */
const agentWorkbench: AgentWorkbenchService = createAgentWorkbenchService({
  document: legacyWindow.document,
  eventTarget: legacyWindow,
  state: state as AgentWorkbenchRendererState,
  getI18n: () => (
    rendererPlatform.services.get(I18N_SERVICE_ID) as I18nService | undefined || BOBO.i18n
  ) as AgentWorkbenchI18nPort | undefined,
  getAgents: () => (
    BOBO.platform?.agents || fallbackAgents
  ) as AgentWorkbenchAgentsPort,
  getCommands: () => (
    BOBO.platform?.commands || fallbackCommands
  ) as AgentWorkbenchCommandsPort,
  getConfirm: () => {
    if (BOBO.confirm) return BOBO.confirm as AgentWorkbenchConfirmPort;
    const service = rendererPlatform.services.get(CONFIRM_SERVICE_ID);
    return service ? service.confirm : undefined;
  },
  getAiSettingsCenter: () => (
    BOBO.aiSettingsCenter || rendererPlatform.services.get(AI_SETTINGS_CENTER_SERVICE_ID)
  ) as AgentWorkbenchAiSettingsCenterPort | undefined,
  getWorkspace: () => BOBO.workspace,
  getWorkbench: () => (
    BOBO.workbench || rendererPlatform.services.get(WORKBENCH_LAYOUT_SERVICE_ID)
  ) as AgentWorkbenchWorkbenchPort | undefined,
  getViews: () => (
    BOBO.views || rendererPlatform.services.get(VIEWS_SERVICE_ID)
  ) as AgentWorkbenchViewsPort | undefined,
  getDocumentViews: () => (
    BOBO.documentViews || rendererPlatform.services.get(DOCUMENT_VIEWS_SERVICE_ID)
  ) as AgentWorkbenchDocumentViewsPort | undefined,
  host: rendererPlatform.services.require(AGENT_WORKBENCH_HOST_SERVICE_ID),
  navigator: legacyWindow.navigator,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer),
  requestAnimationFrame: (callback) => legacyWindow.requestAnimationFrame(callback),
  logger: console
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  AGENT_WORKBENCH_SERVICE_ID,
  agentWorkbench,
  { owner: 'core.agent-workbench', exposeToPlugins: false }
));

// Preserve the historical frozen six-key facade. Disposal remains owned by
// the private renderer registry and is intentionally not exposed to plugins.
BOBO.agentWorkbench = Object.freeze({
  init: agentWorkbench.init,
  dispose: agentWorkbench.dispose,
  open: agentWorkbench.open,
  openConfiguration: agentWorkbench.openConfiguration,
  refresh: agentWorkbench.refresh,
  refreshModels: agentWorkbench.refreshModels
});

// The legacy implementation initialized on `bobo:ready`; retain that timing
// so agent state is available only after the app has restored its foundations.
const initialize = () => agentWorkbench.init();
if (legacyWindow.document.documentElement?.getAttribute('data-bobo-ready') === 'true') {
  initialize();
} else {
  legacyWindow.addEventListener('bobo:ready', initialize, { once: true });
  rendererPlatform.lifecycle.add(toDisposable(() => {
    legacyWindow.removeEventListener('bobo:ready', initialize);
  }));
}

export { agentWorkbench };
