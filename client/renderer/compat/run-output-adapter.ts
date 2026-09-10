import { createRunOutputService, RUN_OUTPUT_SERVICE_ID } from '../../src/run-output';
import type {
  RunOutputFacade,
  RunOutputI18nPort,
  RunOutputOutputPort,
  RunOutputService,
  RunOutputUpdateOptionsDto
} from '../../types/run-output';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyRunOutputNamespace {
  i18n?: RunOutputI18nPort;
  runOutput?: RunOutputFacade;
  updateRunOutput?: (message: string, options?: RunOutputUpdateOptionsDto) => void;
  clearRunOutputDetails?: () => void;
  refreshRunOutputOmission?: () => void;
}

type RunOutputWindow = Window & {
  BOBO?: LegacyRunOutputNamespace;
};

const legacyWindow = window as RunOutputWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

const output: RunOutputOutputPort = {
  updateRunOutput: (message, options) => {
    if (typeof BOBO.updateRunOutput !== 'function') {
      throw new Error('Run output transcript is unavailable.');
    }
    BOBO.updateRunOutput.call(BOBO, message, options);
  },
  clearRunOutputDetails: () => BOBO.clearRunOutputDetails?.call(BOBO),
  refreshRunOutputOmission: () => BOBO.refreshRunOutputOmission?.call(BOBO)
};

const runOutput: RunOutputService = createRunOutputService({
  document,
  output,
  getI18n: () => BOBO.i18n
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  RUN_OUTPUT_SERVICE_ID,
  runOutput,
  { owner: 'core.run-output', exposeToPlugins: false }
));

// Preserve the historical writable facade while keeping lifecycle ownership in
// the private typed service registry.
BOBO.runOutput = {
  init: runOutput.init,
  begin: runOutput.begin,
  detail: runOutput.detail,
  phase: runOutput.phase,
  handleStatus: runOutput.handleStatus,
  finish: runOutput.finish,
  clear: runOutput.clear,
  clearTranscript: runOutput.clearTranscript,
  isActive: runOutput.isActive,
  setDetailsVisible: runOutput.setDetailsVisible,
  setPanelActive: runOutput.setPanelActive
};
