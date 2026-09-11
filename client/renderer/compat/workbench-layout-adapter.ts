import {
  createWorkbenchLayoutService,
  WORKBENCH_LAYOUT_SERVICE_ID
} from '../../src/workbench-layout';
import type {
  WorkbenchAiAgentButtonPort,
  WorkbenchAiChatPanelPort,
  WorkbenchCollaborationPort,
  WorkbenchCommandsPort,
  WorkbenchFileSearchPort,
  WorkbenchLayoutFacade,
  WorkbenchProjectsPort,
  WorkbenchSettingsPort,
  WorkbenchSwitchPanelPort,
  WorkbenchTerminalPort
} from '../../types/workbench-layout';
import type { RendererState } from '../../types/state';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyWorkbenchBobo {
  state?: RendererState;
  workbench?: WorkbenchLayoutFacade;
  commands?: WorkbenchCommandsPort;
  terminal?: WorkbenchTerminalPort;
  fileSearch?: WorkbenchFileSearchPort;
  settings?: WorkbenchSettingsPort;
  projects?: WorkbenchProjectsPort;
  collaboration?: WorkbenchCollaborationPort;
  aiAgentButton?: WorkbenchAiAgentButtonPort;
  aiChatPanel?: WorkbenchAiChatPanelPort;
  switchToPanel?: WorkbenchSwitchPanelPort;
}

type WorkbenchWindow = Window & { BOBO?: LegacyWorkbenchBobo };

const legacyWindow = window as WorkbenchWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state;
if (!state) throw new Error('Renderer state must be initialized before workbench layout.');

let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch (_) {
  storage = null;
}

export const workbenchLayout = createWorkbenchLayoutService({
  document,
  eventTarget: window,
  state,
  storage,
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => window.clearTimeout(timer),
  getComputedStyle: (element) => window.getComputedStyle(element),
  createCustomEvent: (type, init) => new CustomEvent(type, init),
  createMutationObserver: typeof window.MutationObserver === 'function'
    ? (callback) => new window.MutationObserver(callback)
    : undefined,
  getCommands: () => BOBO.commands,
  getTerminal: () => BOBO.terminal,
  getFileSearch: () => BOBO.fileSearch,
  getSettings: () => BOBO.settings,
  getProjects: () => BOBO.projects,
  getCollaboration: () => BOBO.collaboration,
  getAiAgentButton: () => BOBO.aiAgentButton,
  getAiChatPanel: () => BOBO.aiChatPanel,
  getSwitchToPanel: () => BOBO.switchToPanel,
  reportError: (error) => console.error('workbench layout:', error)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  WORKBENCH_LAYOUT_SERVICE_ID,
  workbenchLayout,
  { owner: 'core.workbench-layout', exposeToPlugins: false }
));

// Preserve the exact writable legacy facade while keeping the implementation
// and disposal ownership inside the typed service registry.
BOBO.workbench = {
  init: workbenchLayout.init,
  getState: workbenchLayout.getState,
  apply: workbenchLayout.apply,
  refreshControls: workbenchLayout.refreshControls,
  refreshContext: workbenchLayout.refreshContext,
  registerPrimaryView: workbenchLayout.registerPrimaryView,
  unregisterPrimaryView: workbenchLayout.unregisterPrimaryView,
  setPrimaryView: workbenchLayout.setPrimaryView,
  setPrimaryVisible: workbenchLayout.setPrimaryVisible,
  togglePrimary: workbenchLayout.togglePrimary,
  setPanelVisible: workbenchLayout.setPanelVisible,
  togglePanel: workbenchLayout.togglePanel,
  revealPanel: workbenchLayout.revealPanel,
  ensureBottomPanelSize: workbenchLayout.ensureBottomPanelSize,
  setPanelPosition: workbenchLayout.setPanelPosition,
  togglePanelPosition: workbenchLayout.togglePanelPosition,
  togglePanelMaximized: workbenchLayout.togglePanelMaximized,
  setDensity: workbenchLayout.setDensity,
  setFocusMode: workbenchLayout.setFocusMode,
  setAuxiliaryVisible: workbenchLayout.setAuxiliaryVisible,
  toggleAuxiliary: workbenchLayout.toggleAuxiliary,
  reset: workbenchLayout.reset
};

