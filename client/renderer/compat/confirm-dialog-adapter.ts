import {
  CONFIRM_SERVICE_ID,
  createConfirmService
} from '../../src/confirm-dialog';
import type { ConfirmFacade } from '../../types/confirm-dialog';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyBobo {
  confirm?: ConfirmFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const confirmService = createConfirmService({
  document,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  CONFIRM_SERVICE_ID,
  confirmService,
  { owner: 'core.confirm', exposeToPlugins: false }
));

// Preserve the callable compatibility facade while keeping disposal registry-owned.
BOBO.confirm = confirmService.confirm;
