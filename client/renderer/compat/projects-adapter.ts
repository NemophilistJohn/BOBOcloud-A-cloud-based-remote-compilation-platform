import {
  createProjectsService,
  PROJECTS_SERVICE_ID
} from '../../src/projects';
import { CACHE_CENTER_SERVICE_ID } from '../../src/cache-center';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import type {
  ProjectsCacheCenterPort,
  ProjectsConfirmPort,
  ProjectsFacade,
  ProjectsI18nPort,
  ProjectsRendererState,
  ProjectsSendToServer
} from '../../types/projects';
import { rendererPlatform } from '../core/bootstrap';
import { PROJECTS_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { I18N_SERVICE_ID } from './i18n-adapter';

interface LegacyProjectsNamespace {
  state?: ProjectsRendererState;
  i18n?: ProjectsI18nPort;
  confirm?: ProjectsConfirmPort;
  cacheCenter?: ProjectsCacheCenterPort;
  projectKey?: (workspaceRoot: string) => string;
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

const sendToServer: ProjectsSendToServer = (action, payload, options) => {
  const sender = BOBO.sendToServer;
  if (!sender) return Promise.reject(new Error('Project action failed.'));
  return sender.call(BOBO, action, payload, options);
};

const confirm: ProjectsConfirmPort = (options) => {
  const current = BOBO.confirm;
  return current
    ? current.call(BOBO, options)
    : registeredConfirm.confirm(options);
};

const projects = createProjectsService({
  document,
  events: legacyWindow,
  state,
  host,
  sendToServer,
  getI18n: () => BOBO.i18n || registeredI18n,
  getConfirm: () => confirm,
  getCacheCenter: () => BOBO.cacheCenter || registeredCacheCenter,
  projectKey: (workspaceRoot) => BOBO.projectKey ? BOBO.projectKey(workspaceRoot) : '',
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer),
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
