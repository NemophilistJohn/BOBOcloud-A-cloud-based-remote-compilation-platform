import { createSocialService } from '../../src/social';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import { I18N_SERVICE_ID } from './i18n-adapter';
import { rendererPlatform } from '../core/bootstrap';
import type { RendererState } from '../../types/state';
import type { CollaborationAuthPort } from '../../types/collaboration';
import type { AccountProfileFacade } from '../../types/account-profile';

const legacy = window as Window & { BOBO?: {
  state?: RendererState;
  sendToServer?: (action: string, payload?: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string; storageInfo?: unknown }>;
  accountProfile?: AccountProfileFacade;
  auth?: CollaborationAuthPort;
} };
const bobo = legacy.BOBO!;
const social = createSocialService({
  document, events: window, state: bobo.state!,
  t: (key, params) => rendererPlatform.services.require(I18N_SERVICE_ID).t(key, params),
  confirm: rendererPlatform.services.require(CONFIRM_SERVICE_ID).confirm,
  async send(action, payload) {
    if (!bobo.sendToServer) throw new Error('Server transport unavailable');
    const result = await bobo.sendToServer(action, payload);
    if (!result?.success) throw new Error(result?.error || 'Server action failed');
    return action === 'listProjects' ? result.storageInfo : result.data;
  },
  profile: () => { bobo.accountProfile?.open(); },
  signIn: () => { bobo.auth?.openAuthModal?.(); },
  download: (messageId, name) => rendererPlatform.services.require('host.social').download(messageId, name)
});
rendererPlatform.lifecycle.add(social);
