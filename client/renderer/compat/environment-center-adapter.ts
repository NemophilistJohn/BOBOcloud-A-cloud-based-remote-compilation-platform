import {
  createEnvironmentCenterService,
  ENVIRONMENT_CENTER_SERVICE_ID
} from '../../src/environment-center';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import { ENVIRONMENT_ACTIVITY_SERVICE_ID } from '../../src/environment-activity';
import type {
  EnvironmentCenterActivityPort,
  EnvironmentCenterConfirmPort,
  EnvironmentCenterDependencies,
  EnvironmentCenterFacade,
  EnvironmentCenterI18nPort,
  EnvironmentCenterLspPort,
  EnvironmentCenterPackageCenterPort,
  EnvironmentCenterProblemMatcherPort,
  EnvironmentCenterRendererState,
  EnvironmentCenterServerActionDto,
  EnvironmentCenterServerRequestMap,
  EnvironmentCenterServerResponseMap,
  EnvironmentCenterToastPort,
  EnvironmentCenterWorkbenchPort,
  EnvironmentCenterWorkspacePort
} from '../../types/environment-center';
import { rendererPlatform } from '../core/bootstrap';
import { ENVIRONMENT_CENTER_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { I18N_SERVICE_ID } from './i18n-adapter';

interface LegacyEnvironmentCenterNamespace {
  state?: EnvironmentCenterRendererState;
  i18n?: EnvironmentCenterI18nPort;
  lsp?: EnvironmentCenterLspPort;
  environmentActivity?: EnvironmentCenterActivityPort;
  taskProblemMatcher?: EnvironmentCenterProblemMatcherPort;
  workspace?: EnvironmentCenterWorkspacePort;
  packageCenter?: EnvironmentCenterPackageCenterPort;
  workbench?: EnvironmentCenterWorkbenchPort;
  toast?: EnvironmentCenterToastPort;
  confirm?: EnvironmentCenterConfirmPort;
  projectKey?: (workspaceRoot: string) => string;
  sendToServer?: EnvironmentCenterDependencies['sendToServer'];
  environmentCenter?: EnvironmentCenterFacade;
}

type LegacyEnvironmentCenterWindow = Window & {
  BOBO?: LegacyEnvironmentCenterNamespace;
  monaco?: {
    readonly editor?: ReturnType<EnvironmentCenterDependencies['getMarkerPort']>;
  };
};

const legacyWindow = window as LegacyEnvironmentCenterWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state || {};
const registeredActivity = rendererPlatform.services.require(ENVIRONMENT_ACTIVITY_SERVICE_ID);
const registeredConfirm = rendererPlatform.services.require(CONFIRM_SERVICE_ID);
const registeredI18n = rendererPlatform.services.require(I18N_SERVICE_ID);
const nativeHost = rendererPlatform.services.require(ENVIRONMENT_CENTER_HOST_SERVICE_ID);

const confirm: EnvironmentCenterConfirmPort = (options) => {
  const current = BOBO.confirm;
  return current
    ? current.call(BOBO, options)
    : registeredConfirm.confirm(options);
};

function sendToServer<Action extends EnvironmentCenterServerActionDto>(
  action: Action,
  payload: EnvironmentCenterServerRequestMap[Action],
  options: { readonly quiet: true }
): Promise<EnvironmentCenterServerResponseMap[Action]> {
  const sender = BOBO.sendToServer;
  if (!sender) return Promise.reject(new Error('Environment action failed.'));
  return sender.call(BOBO, action, payload, options) as Promise<
    EnvironmentCenterServerResponseMap[Action]
  >;
}

const environmentCenter = createEnvironmentCenterService({
  document,
  events: legacyWindow,
  state,
  getNativeHost: () => nativeHost,
  getI18n: () => BOBO.i18n || registeredI18n,
  getLsp: () => BOBO.lsp,
  getEnvironmentActivity: () => BOBO.environmentActivity || registeredActivity,
  getTaskProblemMatcher: () => BOBO.taskProblemMatcher,
  getWorkspace: () => BOBO.workspace,
  getPackageCenter: () => BOBO.packageCenter,
  getWorkbench: () => BOBO.workbench,
  getToast: () => BOBO.toast,
  getConfirm: () => confirm,
  projectKey: (workspaceRoot) => BOBO.projectKey
    ? BOBO.projectKey(workspaceRoot)
    : '',
  getMarkerPort: () => legacyWindow.monaco?.editor,
  sendToServer,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer),
  now: () => Date.now()
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  ENVIRONMENT_CENTER_SERVICE_ID,
  environmentCenter,
  { owner: 'core.environment-center', exposeToPlugins: false }
));

// Preserve the historical writable facade and insertion order.
BOBO.environmentCenter = {
  init: environmentCenter.init,
  refresh: environmentCenter.refresh,
  scheduleRefresh: environmentCenter.scheduleRefresh,
  runAction: environmentCenter.runAction,
  getSnapshot: environmentCenter.getSnapshot,
  getRequestContext: environmentCenter.getRequestContext,
  dispose: environmentCenter.dispose
};
