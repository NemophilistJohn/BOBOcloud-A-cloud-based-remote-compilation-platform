import {
  createProjectsService,
  PROJECTS_SERVICE_ID
} from '../../src/projects';
import { CACHE_CENTER_SERVICE_ID } from '../../src/cache-center';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import { WORKBENCH_LAYOUT_SERVICE_ID } from '../../src/workbench-layout';
import type {
  ProjectsCacheCenterPort,
  ProjectsConfirmPort,
  ProjectsFacade,
  ProjectsI18nPort,
  ProjectsRendererState,
  ProjectsRclonePort,
  ProjectsSendToServer,
  ProjectsWorkbenchPort,
  ProjectsWorkspaceLaunchPort
} from '../../types/projects';
import { rendererPlatform } from '../core/bootstrap';
import { PROJECTS_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { I18N_SERVICE_ID } from './i18n-adapter';
import { RCLONE_CLIENT_SERVICE_ID } from './rclone-client-adapter';
import { WORKSPACE_LAUNCH_SERVICE_ID } from '../../src/workspace-launch';
import type { ConfirmDetailsOptions, ConfirmDetailsResultDto, ConfirmOptions } from '../../types/confirm-dialog';

interface LegacyProjectsNamespace {
  state?: ProjectsRendererState;
  i18n?: ProjectsI18nPort;
  confirm?: ProjectsConfirmPort;
  cacheCenter?: ProjectsCacheCenterPort;
  workbench?: ProjectsWorkbenchPort;
  projectKey?: (workspaceRoot: string) => string;
  rclone?: ProjectsRclonePort;
  runner?: { manualSyncWithServer?: () => Promise<unknown> };
  workspaceLaunch?: ProjectsWorkspaceLaunchPort;
  sendToServer?: ProjectsSendToServer;
  projects?: ProjectsFacade;
}

type LegacyProjectsWindow = Window & {
  BOBO?: LegacyProjectsNamespace;
};

const legacyWindow = window as LegacyProjectsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state || {};
const host = rendererPlatform.services.require(PROJECTS_HOST_SERVICE_ID);
const registeredCacheCenter = rendererPlatform.services.require(CACHE_CENTER_SERVICE_ID);
const registeredConfirm = rendererPlatform.services.require(CONFIRM_SERVICE_ID);
const registeredI18n = rendererPlatform.services.require(I18N_SERVICE_ID);
const registeredWorkbench = rendererPlatform.services.require(WORKBENCH_LAYOUT_SERVICE_ID);
const registeredWorkspaceLaunch = rendererPlatform.services.require(WORKSPACE_LAUNCH_SERVICE_ID);
const registeredRclone = rendererPlatform.services.require(RCLONE_CLIENT_SERVICE_ID);

const sendToServer: ProjectsSendToServer = (action, payload, options) => {
  const sender = BOBO.sendToServer;
  if (!sender) return Promise.reject(new Error('Project action failed.'));
  return sender.call(BOBO, action, payload, options);
};

function confirm(options: ConfirmDetailsOptions): Promise<ConfirmDetailsResultDto>;
function confirm(options?: ConfirmOptions): Promise<boolean>;
function confirm(options?: ConfirmDetailsOptions | ConfirmOptions): Promise<boolean | ConfirmDetailsResultDto> {
  const current = BOBO.confirm;
  if (current) {
    return (current as (request: ConfirmDetailsOptions | ConfirmOptions) => Promise<boolean | ConfirmDetailsResultDto>)
      .call(BOBO, options as ConfirmDetailsOptions | ConfirmOptions);
  }
  return (registeredConfirm.confirm as (request: ConfirmDetailsOptions | ConfirmOptions) => Promise<boolean | ConfirmDetailsResultDto>)(
    options as ConfirmDetailsOptions | ConfirmOptions
  );
}

const projects = createProjectsService({
  document,
  events: legacyWindow,
  state,
  host,
  sendToServer,
  getI18n: () => BOBO.i18n || registeredI18n,
  getConfirm: () => confirm,
  getCacheCenter: () => BOBO.cacheCenter || registeredCacheCenter,
  getWorkbench: () => BOBO.workbench || registeredWorkbench,
  getWorkspaceLaunch: () => BOBO.workspaceLaunch || (registeredWorkspaceLaunch as ProjectsWorkspaceLaunchPort),
  getRclone: () => (BOBO.rclone || registeredRclone) as ProjectsRclonePort,
  syncCurrentProject: () => BOBO.runner?.manualSyncWithServer?.() ?? Promise.resolve(false),
  projectKey: (workspaceRoot) => BOBO.projectKey ? BOBO.projectKey(workspaceRoot) : '',
  alert: (message) => {
    if (typeof legacyWindow.alert === 'function') return legacyWindow.alert(message);
    return undefined;
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  PROJECTS_SERVICE_ID,
  projects,
  { owner: 'core.projects', exposeToPlugins: false }
));

// Preserve the historical writable facade and insertion order.
BOBO.projects = {
  init: projects.init,
  open: projects.open,
  openWithQuotaError: projects.openWithQuotaError,
  close: projects.close,
  loadProjects: projects.loadProjects,
  switchTab: projects.switchTab
};
