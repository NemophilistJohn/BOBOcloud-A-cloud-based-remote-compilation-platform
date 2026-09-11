import {
  createOutputPanelService,
  OUTPUT_PANEL_SERVICE_ID
} from '../../src/output-panel';
import type {
  OutputPanelFacade,
  OutputPanelProblemMatcherPort,
  OutputPanelRunOutputPort,
  OutputPanelService,
  OutputPanelState,
  OutputPanelTerminalPort,
  OutputPanelWorkbenchPort,
  OutputPanelDapPort
} from '../../types/output-panel';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyOutputPanelNamespace {
  state?: OutputPanelState;
  outputPanel?: OutputPanelFacade;
  switchToPanel?: (panelName: string) => void;
  workbench?: OutputPanelWorkbenchPort;
  runOutput?: OutputPanelRunOutputPort;
  terminal?: OutputPanelTerminalPort;
  dap?: OutputPanelDapPort;
  taskProblemMatcher?: OutputPanelProblemMatcherPort;
  clearRunOutput?: () => void;
}

const legacyWindow = window as Window & { BOBO?: LegacyOutputPanelNamespace };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state || {};
BOBO.state = state;

const outputPanel: OutputPanelService = createOutputPanelService({
  document,
  state,
  getWorkbench: () => BOBO.workbench,
  getRunOutput: () => BOBO.runOutput,
  getTerminal: () => BOBO.terminal,
  getDap: () => BOBO.dap,
  getTaskProblemMatcher: () => BOBO.taskProblemMatcher,
  getClearRunOutput: () => {
    if (typeof BOBO.clearRunOutput !== 'function') return undefined;
    return () => BOBO.clearRunOutput?.call(BOBO);
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  OUTPUT_PANEL_SERVICE_ID,
  outputPanel,
  { owner: 'core.output-panel', exposeToPlugins: false }
));

// Preserve the exact historical writable facade and standalone switch helper.
BOBO.outputPanel = {
  init: outputPanel.init,
  setupOutputResizer: outputPanel.setupOutputResizer
};
BOBO.switchToPanel = outputPanel.switchToPanel;
