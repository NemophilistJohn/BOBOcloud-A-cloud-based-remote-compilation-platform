import {
  createRuntimeService,
  RUNTIME_SERVICE_ID
} from '../../src/runtime';
import type {
  RuntimeEnvironmentActivityPort,
  RuntimeFacade,
  RuntimeI18nPort,
  RuntimeLspPort,
  RuntimeRendererState,
  RuntimeRunConfigPort,
  RuntimeSendToServer,
  RuntimeToastPort
} from '../../types/runtime';
import { rendererPlatform } from '../core/bootstrap';
import { I18N_SERVICE_ID } from './i18n-adapter';

interface LegacyRuntimeNamespace {
  state?: RuntimeRendererState;
  i18n?: RuntimeI18nPort;
  langDisplayName?: (language: string) => string;
  lsp?: RuntimeLspPort;
  runConfig?: RuntimeRunConfigPort;
  environmentActivity?: RuntimeEnvironmentActivityPort;
  toast?: RuntimeToastPort;
  sendToServer?: RuntimeSendToServer;
  updateRunOutput?: (message: string) => unknown;
  runtime?: RuntimeFacade;
}

type LegacyRuntimeWindow = Window & {
  BOBO?: LegacyRuntimeNamespace;
};

const legacyWindow = window as LegacyRuntimeWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Runtime selector requires renderer state.');

const registeredI18n = rendererPlatform.services.require(I18N_SERVICE_ID);
const storage = (() => {
  try {
    if (legacyWindow.localStorage) return legacyWindow.localStorage;
  } catch (_) {
    // Sandboxed/private contexts can deny localStorage access.
  }
  return {
    getItem: () => null,
    setItem: () => {}
  };
})();

const sendToServer: RuntimeSendToServer = (action, payload, options) => {
  const sender = BOBO.sendToServer;
  if (!sender) return Promise.reject(new Error('Runtime catalog request failed.'));
  return sender.call(BOBO, action, payload, options);
};

const runtime = createRuntimeService({
  document,
  storage,
  state: BOBO.state,
  sendToServer,
  getI18n: () => BOBO.i18n || registeredI18n,
  getLanguageDisplayName: () => BOBO.langDisplayName,
  getLsp: () => BOBO.lsp,
  getRunConfig: () => BOBO.runConfig,
  getEnvironmentActivity: () => BOBO.environmentActivity,
  getToast: () => BOBO.toast,
  updateRunOutput: (message) => BOBO.updateRunOutput?.call(BOBO, message),
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  RUNTIME_SERVICE_ID,
  runtime,
  { owner: 'core.runtime', exposeToPlugins: false }
));

// Preserve the historical writable facade and insertion order, including the
// intentionally public pure helper bundle used by legacy diagnostics.
BOBO.runtime = {
  init: runtime.init,
  fetchRuntimes: runtime.fetchRuntimes,
  selectRuntime: runtime.selectRuntime,
  autoSelectForLanguage: runtime.autoSelectForLanguage,
  autoSelectForActiveFile: runtime.autoSelectForActiveFile,
  _helpers: runtime._helpers
};
