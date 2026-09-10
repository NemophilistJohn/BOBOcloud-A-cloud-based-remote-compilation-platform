import {
  createToastService,
  TOAST_SERVICE_ID
} from '../../src/toast';
import type { RendererIconsFacade } from '../../types/icons';
import type { ToastFacade } from '../../types/toast';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyToastNamespace {
  icons?: RendererIconsFacade;
  toast?: ToastFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyToastNamespace };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const toast = createToastService({
  document,
  getIcons: () => BOBO.icons,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  TOAST_SERVICE_ID,
  toast,
  { owner: 'core.toast', exposeToPlugins: false }
));

// Preserve the historical writable three-method facade.
BOBO.toast = {
  success: toast.success,
  error: toast.error,
  info: toast.info
};
