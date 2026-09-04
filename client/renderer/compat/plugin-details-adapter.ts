import { createPluginDetailsService } from '../../src/plugin-details';
import type {
  PluginConfirm,
  PluginDetailsDocumentViews,
  PluginDetailsFacade,
  PluginDetailsState,
  PluginDetailsViews,
  PluginDetailsWorkspace,
  PluginManagerI18n
} from '../../types/plugin-management';
import { toDisposable } from '../core/disposable.js';
import { rendererPlatform } from '../core/bootstrap';
import { PLUGIN_MANAGEMENT_HOST_SERVICE_ID } from '../core/native-host-adapter';

export const PLUGIN_DETAILS_SERVICE_ID = 'workbench.pluginDetails';

interface LegacyBobo {
  state?: PluginDetailsState;
  i18n?: PluginManagerI18n;
  workspace?: PluginDetailsWorkspace;
  views?: PluginDetailsViews;
  documentViews?: PluginDetailsDocumentViews;
  confirm?: PluginConfirm;
  pluginDetails?: PluginDetailsFacade;
}

type PluginDetailsWindow = Window & {
  BOBO?: LegacyBobo;
};

const legacyWindow = window as PluginDetailsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Plugin Details requires renderer state.');

const pluginDetails = createPluginDetailsService({
  document,
  window: legacyWindow,
  host: rendererPlatform.services.get(PLUGIN_MANAGEMENT_HOST_SERVICE_ID) || null,
  state: BOBO.state,
  getI18n: () => BOBO.i18n,
  getWorkspace: () => BOBO.workspace,
  getViews: () => BOBO.views,
  getDocumentViews: () => BOBO.documentViews,
  getConfirm: () => typeof BOBO.confirm === 'function' ? BOBO.confirm : undefined,
  nativeConfirm: (message: string) => legacyWindow.confirm(message)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  PLUGIN_DETAILS_SERVICE_ID,
  pluginDetails,
  { owner: 'core.plugin-details', exposeToPlugins: false }
));

// Compatibility projection only. Keep the historical frozen single-method API.
BOBO.pluginDetails = Object.freeze({ open: pluginDetails.open });

if (document.readyState === 'loading') {
  const initialize = () => pluginDetails.init();
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
  rendererPlatform.lifecycle.add(toDisposable(() => {
    document.removeEventListener('DOMContentLoaded', initialize);
  }));
} else {
  pluginDetails.init();
}
