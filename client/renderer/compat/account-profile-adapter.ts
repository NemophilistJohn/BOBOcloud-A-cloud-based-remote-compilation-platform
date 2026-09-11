import {
  ACCOUNT_PROFILE_SERVICE_ID,
  createAccountProfileService
} from '../../src/account-profile';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import type {
  AccountProfileAuthPort,
  AccountProfileCollaborationPort,
  AccountProfileConfirmPort,
  AccountProfileFacade,
  AccountProfileI18nPort,
  AccountProfileImagePort,
  AccountProfileSendToServer,
  AccountProfileService,
  AccountProfileToastPort,
  AccountProfileRendererState
} from '../../types/account-profile';
import type { ConfirmFacade } from '../../types/confirm-dialog';
import type { I18nService } from '../../types/i18n';
import type { RendererState } from '../../types/state';
import type { ToastService } from '../../types/toast';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyAccountProfileBobo {
  state?: RendererState;
  i18n?: I18nService;
  toast?: ToastService;
  auth?: AccountProfileAuthPort;
  confirm?: AccountProfileConfirmPort;
  collaboration?: AccountProfileCollaborationPort;
  sendToServer?: (
    action: string,
    payload?: Record<string, unknown>,
    options?: Readonly<Record<string, unknown>>
  ) => Promise<unknown>;
  accountProfile?: AccountProfileFacade;
}

type LegacyAccountProfileWindow = Window & {
  BOBO?: LegacyAccountProfileBobo;
  URL: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  Image: new () => AccountProfileImagePort;
};

const legacyWindow = window as LegacyAccountProfileWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state;
if (!state) throw new Error('Account profile requires renderer state.');

const registeredConfirm = rendererPlatform.services.require(CONFIRM_SERVICE_ID);
const sendToServer: AccountProfileSendToServer = (action, payload, options) => {
  const sender = BOBO.sendToServer;
  if (!sender) return Promise.reject(new Error('Account profile action failed.'));
  return sender.call(BOBO, action, payload, options) as Promise<
    Awaited<ReturnType<AccountProfileSendToServer>>
  >;
};

export const accountProfile: AccountProfileService = createAccountProfileService({
  document,
  state: state as unknown as AccountProfileRendererState,
  sendToServer,
  getI18n: () => BOBO.i18n as AccountProfileI18nPort | undefined,
  getToast: () => BOBO.toast as AccountProfileToastPort | undefined,
  getAuth: () => BOBO.auth,
  getConfirm: () => {
    const current = BOBO.confirm;
    return current || registeredConfirm.confirm as ConfirmFacade;
  },
  getCollaboration: () => BOBO.collaboration,
  setTimeout: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimeout: (timer) => legacyWindow.clearTimeout(timer),
  createObjectURL: (file) => legacyWindow.URL.createObjectURL(file),
  revokeObjectURL: (url) => legacyWindow.URL.revokeObjectURL(url),
  createImage: () => new legacyWindow.Image(),
  clipboard: legacyWindow.navigator?.clipboard
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  ACCOUNT_PROFILE_SERVICE_ID,
  accountProfile,
  { owner: 'core.account-profile', exposeToPlugins: false }
));

// Preserve the historical writable five-key facade. Disposal remains owned by
// the private renderer service registry and is intentionally not projected.
BOBO.accountProfile = {
  init: accountProfile.init,
  open: accountProfile.open,
  close: accountProfile.close,
  reset: accountProfile.reset,
  renderActivity: accountProfile.renderActivity
};
