import {
  createPluginManagerUI,
  PLUGIN_MANAGER_UI_SERVICE_ID
} from '../../src/plugin-manager-ui';
import type { CommandPaletteRegistrationPort } from '../../types/command-palette';
import type {
  PluginDetailsOpenPort,
  PluginManagerI18n,
  PluginManagerUIFacade,
  PluginManagerWorkbench
} from '../../types/plugin-management';
import { PLUGIN_MANAGEMENT_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { rendererPlatform } from '../core/bootstrap';
import { toDisposable } from '../core/disposable.js';

interface LegacyBobo {
  i18n?: PluginManagerI18n;
  workbench?: PluginManagerWorkbench;
  commands?: CommandPaletteRegistrationPort;
  pluginDetails?: PluginDetailsOpenPort;
  pluginManagerUI?: PluginManagerUIFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

const pluginManagerUI = createPluginManagerUI({
  document,
  window: legacyWindow,
  host: rendererPlatform.services.get(PLUGIN_MANAGEMENT_HOST_SERVICE_ID) || null,
  getI18n: () => BOBO.i18n,
  getWorkbench: () => BOBO.workbench,
  getCommands: () => BOBO.commands,
  getPluginDetails: () => BOBO.pluginDetails,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  PLUGIN_MANAGER_UI_SERVICE_ID,
  pluginManagerUI,
  { owner: 'core.plugin-manager-ui', exposeToPlugins: false }
));

// Preserve the historical six-key compatibility facade and its insertion order.
BOBO.pluginManagerUI = {
  init: pluginManagerUI.init,
  open: pluginManagerUI.open,
  refresh: pluginManagerUI.refresh,
  refreshMarketplace: pluginManagerUI.refreshMarketplace,
  getPlugins: pluginManagerUI.getPlugins,
  getMarketplace: pluginManagerUI.getMarketplace
};

const initialize = (): void => {
  void pluginManagerUI.init();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
  rendererPlatform.lifecycle.add(toDisposable(() => {
    document.removeEventListener('DOMContentLoaded', initialize);
  }));
} else {
  initialize();
}
