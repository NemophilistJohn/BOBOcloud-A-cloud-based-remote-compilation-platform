import { createI18nService } from '../../src/i18n';
import type { I18nService, I18nToast } from '../../types/i18n';
import { rendererPlatform } from '../core/bootstrap';
import { LANGUAGE_PACKS_HOST_SERVICE_ID } from '../core/native-host-adapter';

export const I18N_SERVICE_ID = 'workbench.i18n';

interface LegacyBobo {
  i18n?: I18nService;
  toast?: I18nToast;
}

type I18nWindow = Window & {
  BOBO?: LegacyBobo;
};

const legacyWindow = window as I18nWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const i18n = createI18nService({
  host: rendererPlatform.services.require(LANGUAGE_PACKS_HOST_SERVICE_ID),
  document,
  eventTarget: window,
  createMutationObserver: (callback) => new MutationObserver(callback),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => window.clearTimeout(timer),
  getToast: () => BOBO.toast,
  logger: console
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  I18N_SERVICE_ID,
  i18n,
  { owner: 'core.i18n', exposeToPlugins: false }
));

// Compatibility projection only. The service registry owns this instance.
BOBO.i18n = i18n;
