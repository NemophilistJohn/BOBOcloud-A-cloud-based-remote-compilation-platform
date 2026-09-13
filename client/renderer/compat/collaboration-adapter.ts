import {
  COLLABORATION_SERVICE_ID,
  createCollaborationService
} from '../../src/collaboration';
import type {
  CollaborationAccountProfilePort,
  CollaborationAuthPort,
  CollaborationConfirmPort,
  CollaborationEnvironmentActivityPort,
  CollaborationFacade,
  CollaborationHostPort,
  CollaborationHostServiceId,
  CollaborationI18nPort,
  CollaborationPanelPort,
  CollaborationRclonePort,
  CollaborationRendererState,
  CollaborationRunnerPort,
  CollaborationSendToServer,
  CollaborationService,
  CollaborationStoragePort,
  CollaborationToastPort,
  CollaborationWorkbenchPort,
  CollaborationWorkspacePort
} from '../../types/collaboration';
import type { RendererState } from '../../types/state';
import type { I18nService } from '../../types/i18n';
import type { ToastService } from '../../types/toast';
import type { WorkbenchLayoutFacade } from '../../types/workbench-layout';
import type { EnvironmentActivityService } from '../../types/environment-activity';
import type { RcloneClient } from '../../types/rclone';
import { rendererPlatform } from '../core/bootstrap';

// Keep the lazy adapter independent from the side-effectful native-host
// composition module.  The core bundle registers this private id once.
const COLLABORATION_HOST_SERVICE_ID: CollaborationHostServiceId = 'host.collaboration';

interface LegacyCollaborationBobo {
  state?: RendererState;
  i18n?: I18nService;
  toast?: ToastService;
  auth?: CollaborationAuthPort;
  accountProfile?: CollaborationAccountProfilePort;
  workspace?: CollaborationWorkspacePort;
  rclone?: RcloneClient;
  runner?: CollaborationRunnerPort;
  workbench?: WorkbenchLayoutFacade;
  environmentActivity?: EnvironmentActivityService;
  switchToPanel?: CollaborationPanelPort;
  sendToServer?: (...args: any[]) => Promise<any>;
  collaboration?: CollaborationFacade;
}

type LegacyCollaborationWindow = Window & {
  BOBO?: LegacyCollaborationBobo;
  Image: typeof Image;
  URL: typeof URL;
};

const legacyWindow = window as LegacyCollaborationWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Collaboration requires renderer state.');

function readStorage(): CollaborationStoragePort | null {
  try {
    const candidate = legacyWindow.localStorage;
    return candidate as unknown as CollaborationStoragePort;
  } catch (_) {
    return null;
  }
}

const registeredHost = rendererPlatform.services.require(COLLABORATION_HOST_SERVICE_ID);

const sendToServer: CollaborationSendToServer = (action, payload, options) => {
  const sender = BOBO.sendToServer;
  if (typeof sender !== 'function') {
    return Promise.reject(new Error('Collaboration server action is unavailable.')) as any;
  }
  return sender.call(BOBO, action, payload, options) as any;
};

const collaboration: CollaborationService = createCollaborationService({
  document: legacyWindow.document,
  eventTarget: legacyWindow,
  state: BOBO.state as unknown as CollaborationRendererState,
  host: registeredHost as CollaborationHostPort,
  sendToServer,
  getI18n: () => BOBO.i18n as unknown as CollaborationI18nPort | undefined,
  getToast: () => BOBO.toast as unknown as CollaborationToastPort | undefined,
  getAuth: () => BOBO.auth,
  getAccountProfile: () => BOBO.accountProfile,
  getWorkspace: () => BOBO.workspace,
  getRclone: () => BOBO.rclone as unknown as CollaborationRclonePort | undefined,
  getRunner: () => BOBO.runner,
  getWorkbench: () => BOBO.workbench as unknown as CollaborationWorkbenchPort | undefined,
  getEnvironmentActivity: () => BOBO.environmentActivity as unknown as CollaborationEnvironmentActivityPort | undefined,
  getSwitchToPanel: () => BOBO.switchToPanel,
  getConfirm: () => undefined as unknown as CollaborationConfirmPort | undefined,
  storage: readStorage(),
  clipboard: legacyWindow.navigator?.clipboard as any,
  createImage: () => new legacyWindow.Image() as unknown as import('../../types/collaboration').CollaborationImagePort,
  createObjectURL: (file) => legacyWindow.URL.createObjectURL(file),
  revokeObjectURL: (url) => legacyWindow.URL.revokeObjectURL(url),
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer),
  setInterval: (callback, delayMs) => legacyWindow.setInterval(callback, delayMs),
  clearInterval: (timer) => legacyWindow.clearInterval(timer),
  logger: console
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  COLLABORATION_SERVICE_ID,
  collaboration,
  { owner: 'core.collaboration', exposeToPlugins: false }
));

// Preserve the historical writable thirteen-key facade and insertion order.
// Disposal remains owned by the private renderer registry.
BOBO.collaboration = {
  init: collaboration.init,
  openHub: collaboration.openHub,
  openProfile: collaboration.openProfile,
  clearCurrent: collaboration.clearCurrent,
  restoreMapping: collaboration.restoreMapping,
  updateTeamChrome: collaboration.updateTeamChrome,
  refreshWorkbench: collaboration.refreshWorkbench,
  uploadCurrent: collaboration.uploadCurrent,
  onFileOpened: collaboration.onFileOpened,
  onFileClosed: collaboration.onFileClosed,
  onFileActivated: collaboration.onFileActivated,
  isActiveFileReadOnly: collaboration.isActiveFileReadOnly,
  releaseForLogout: collaboration.releaseForLogout
};

export { collaboration };
