import {
  createWorkspaceLaunchService,
  WORKSPACE_LAUNCH_SERVICE_ID
} from '../../src/workspace-launch';
import type {
  WorkspaceLaunchFacade,
  WorkspaceLaunchI18nPort,
  WorkspaceLaunchStoragePort
} from '../../types/workspace-launch';
import { rendererPlatform } from '../core/bootstrap';
import { WORKSPACE_LAUNCH_HOST_SERVICE_ID } from '../core/native-host-adapter';

interface LegacyWorkspaceLaunchBobo {
  i18n?: WorkspaceLaunchI18nPort;
  workspaceLaunch?: WorkspaceLaunchFacade;
}

type LegacyWorkspaceLaunchWindow = Window & {
  BOBO?: LegacyWorkspaceLaunchBobo;
};

const legacyWindow = window as LegacyWorkspaceLaunchWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

function readStorage(): Readonly<WorkspaceLaunchStoragePort> | null {
  try {
    const storage = legacyWindow.localStorage;
    return storage && typeof storage.getItem === 'function' &&
      typeof storage.setItem === 'function'
      ? storage
      : null;
  } catch (_) {
    return null;
  }
}

const workspaceLaunch = createWorkspaceLaunchService({
  document,
  host: rendererPlatform.services.require(WORKSPACE_LAUNCH_HOST_SERVICE_ID),
  storage: readStorage(),
  getI18n: () => BOBO.i18n,
  reportError: (error) => {
    console.error('workspace launch:', error);
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  WORKSPACE_LAUNCH_SERVICE_ID,
  workspaceLaunch,
  { owner: 'core.workspace-launch', exposeToPlugins: false }
));

// Preserve the historical writable facade while keeping disposal registry-owned.
BOBO.workspaceLaunch = {
  init: workspaceLaunch.init,
  requestOpen: workspaceLaunch.requestOpen,
  setConsumer: workspaceLaunch.setConsumer,
  whenIdle: workspaceLaunch.whenIdle
};

workspaceLaunch.init();
