import { createRunConfigService, RUN_CONFIG_SERVICE_ID } from '../../src/run-config';
import type {
  RunConfigFacade,
  RunConfigI18nPort,
  RunConfigRendererState,
  RunConfigSendToServer,
  RunConfigService
} from '../../types/run-config';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyRunConfigNamespace {
  state?: RunConfigRendererState;
  i18n?: RunConfigI18nPort;
  sendToServer?: RunConfigSendToServer;
  runConfig?: RunConfigFacade;
}

type RunConfigWindow = Window & {
  BOBO?: LegacyRunConfigNamespace;
};

const legacyWindow = window as RunConfigWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Run configuration requires renderer state.');

const storage = (() => {
  try {
    if (legacyWindow.localStorage) return legacyWindow.localStorage;
  } catch (_) {
    // Sandboxed/private contexts can deny localStorage access.
  }
  return { getItem: () => null, setItem: () => {} };
})();

const sendToServer: RunConfigSendToServer = (action, payload, options) => {
  const sender = BOBO.sendToServer;
  if (!sender) return Promise.reject(new Error('Build target request failed.'));
  return sender.call(BOBO, action, payload, options);
};

const runConfig: RunConfigService = createRunConfigService({
  document,
  window: legacyWindow,
  storage,
  state: BOBO.state,
  sendToServer,
  getI18n: () => BOBO.i18n
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  RUN_CONFIG_SERVICE_ID,
  runConfig,
  { owner: 'core.run-config', exposeToPlugins: false }
));

BOBO.runConfig = {
  init: runConfig.init,
  languageForFile: runConfig.languageForFile,
  getArgs: runConfig.getArgs,
  describeTarget: runConfig.describeTarget,
  refreshForActiveFile: runConfig.refreshForActiveFile,
  close: runConfig.close,
  _splitArgs: runConfig._splitArgs
};
