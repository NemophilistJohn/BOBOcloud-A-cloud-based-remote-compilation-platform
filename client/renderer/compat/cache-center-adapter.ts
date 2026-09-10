import {
  CACHE_CENTER_SERVICE_ID,
  createCacheCenterService
} from '../../src/cache-center';
import {
  CATEGORY_ORDER,
  groupInventory,
  isCurrentEnvironmentEntry,
  isServiceCategory
} from '../../src/cache-model';
import { CACHE_STORE_SERVICE_ID } from '../../src/cache-store';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import type {
  CacheCenterConfirmPort,
  CacheCenterFacade,
  CacheCenterI18nPort,
  CacheCenterIconPort,
  CacheCenterModel,
  CacheCenterPackageCenterPort,
  CacheCenterProjectsPort,
  CacheCenterRendererState,
  CacheCenterStore,
  CacheCenterToastPort,
  CacheCenterWorkbenchPort
} from '../../types/cache-center';
import type { CacheModelFacade } from '../../types/cache-model';
import type { CacheStoreFacade } from '../../types/cache-store';
import { rendererPlatform } from '../core/bootstrap';
import { I18N_SERVICE_ID } from './i18n-adapter';

interface LegacyCacheCenterNamespace {
  state?: CacheCenterRendererState;
  i18n?: CacheCenterI18nPort;
  icons?: CacheCenterIconPort;
  cacheModel?: CacheModelFacade;
  cacheStore?: CacheStoreFacade;
  projectKey?: (workspaceRoot: string) => string;
  toast?: CacheCenterToastPort;
  confirm?: CacheCenterConfirmPort;
  projects?: CacheCenterProjectsPort;
  workbench?: CacheCenterWorkbenchPort;
  packageCenter?: CacheCenterPackageCenterPort;
  cacheCenter?: CacheCenterFacade;
}

type LegacyCacheCenterWindow = Window & {
  BOBO?: LegacyCacheCenterNamespace;
};

const legacyWindow = window as LegacyCacheCenterWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state || {};
const registeredStore = rendererPlatform.services.require(CACHE_STORE_SERVICE_ID);
const registeredI18n = rendererPlatform.services.require(I18N_SERVICE_ID);
const registeredConfirm = rendererPlatform.services.require(CONFIRM_SERVICE_ID);

const fallbackModel = {
  CATEGORY_ORDER: CATEGORY_ORDER.slice(),
  groupInventory,
  isCurrentEnvironmentEntry,
  isServiceCategory
} satisfies CacheCenterModel;

function currentModel(): CacheCenterModel {
  return BOBO.cacheModel || fallbackModel;
}

function currentStore(): CacheCenterStore {
  return BOBO.cacheStore || registeredStore;
}

const model = {
  get CATEGORY_ORDER() {
    return currentModel().CATEGORY_ORDER;
  },
  groupInventory: (inventory, options) => (
    currentModel().groupInventory(inventory, options)
  ),
  isCurrentEnvironmentEntry: (entry, context) => (
    currentModel().isCurrentEnvironmentEntry(entry, context)
  ),
  isServiceCategory: (category) => currentModel().isServiceCategory(category)
} satisfies CacheCenterModel;

const confirm: CacheCenterConfirmPort = (options) => {
  const current = BOBO.confirm;
  return current
    ? current.call(BOBO, options)
    : registeredConfirm.confirm(options);
};

const cacheCenter = createCacheCenterService({
  document,
  languageEvents: legacyWindow,
  state,
  model,
  getStore: currentStore,
  projectKey: (workspaceRoot) => BOBO.projectKey
    ? BOBO.projectKey(workspaceRoot)
    : '',
  getI18n: () => BOBO.i18n || registeredI18n,
  getIcons: () => BOBO.icons,
  getToast: () => BOBO.toast,
  getConfirm: () => confirm,
  getProjects: () => BOBO.projects,
  getWorkbench: () => BOBO.workbench,
  getPackageCenter: () => BOBO.packageCenter,
  alert: (message) => {
    if (typeof legacyWindow.alert === 'function') return legacyWindow.alert(message);
    return undefined;
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  CACHE_CENTER_SERVICE_ID,
  cacheCenter,
  { owner: 'core.cacheInventory', exposeToPlugins: false }
));

// Preserve the historical writable facade and insertion order.
BOBO.cacheCenter = {
  init: cacheCenter.init,
  load: cacheCenter.load,
  render: cacheCenter.render,
  setVisible: cacheCenter.setVisible,
  setProjectNames: cacheCenter.setProjectNames,
  dispose: cacheCenter.dispose,
  getFilters: cacheCenter.getFilters
};
