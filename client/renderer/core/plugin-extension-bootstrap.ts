import type { Disposable } from '../../types/lifecycle';
import type {
  PluginExtensionBootstrapObservedErrorEvent,
  PluginExtensionNativeHost
} from '../../types/plugin-extension-bootstrap';
import type {
  PluginExtensionCommandPalettePort,
  PluginExtensionHostContract
} from '../../types/plugin-extension-host';
import type { RendererPluginServiceMap } from '../../types/renderer-platform';
import { rendererPlatform } from './bootstrap';
import { PLUGIN_EXTENSIONS_HOST_SERVICE_ID } from './native-host-adapter';
import { PluginExtensionHost } from './plugin-extension-host.js';

const I18N_SERVICE_ID = 'workbench.i18n';

interface LegacyBoboExtensionSurface {
  readonly commands?: PluginExtensionCommandPalettePort;
}

type PluginExtensionBootstrapWindow = Window & {
  readonly BOBO?: LegacyBoboExtensionSurface;
};

const legacyWindow = window as PluginExtensionBootstrapWindow;

function resolveCommandPalette(): PluginExtensionCommandPalettePort | null {
  const commands = legacyWindow.BOBO?.commands;
  return commands?.supportsDisposables === true ? commands : null;
}

function reportExtensionError(event: PluginExtensionBootstrapObservedErrorEvent): void {
  try {
    console.error('[plugin-extension:' + event.source + ']', event.id || '', event.error);
  } catch (_) {}
}

const pluginApi: Readonly<PluginExtensionNativeHost> | undefined =
  rendererPlatform.services.get(PLUGIN_EXTENSIONS_HOST_SERVICE_ID);
const i18n = rendererPlatform.services.get(I18N_SERVICE_ID);
const loadLocalization = pluginApi?.loadLocalization;
const broker = pluginApi?.broker;

// Kept module-local on purpose. Installed extension code never receives this
// host, window.BOBO, the native host service, Electron IPC, or a DOM reference.
export const rendererExtensionHost: PluginExtensionHostContract | null = pluginApi
  ? new PluginExtensionHost<RendererPluginServiceMap>({
      services: rendererPlatform.services,
      commands: rendererPlatform.commands,
      contributions: rendererPlatform.contributions,
      sourceControls: rendererPlatform.sourceControls,
      agents: rendererPlatform.agents,
      listDescriptors: () => pluginApi.listDescriptors(),
      loadEntry: (id) => pluginApi.loadEntry(id),
      loadLocalization: loadLocalization
        ? (id, locale) => loadLocalization(id, locale)
        : undefined,
      broker: broker || null,
      localize: (key) => i18n ? i18n.t(key) : key,
      getLocale: () => i18n ? i18n.getActive() : 'en',
      onLocaleChange: i18n
        ? (listener) => i18n.onChange(() => listener())
        : undefined,
      getCommandPalette: resolveCommandPalette,
      onError: reportExtensionError
    })
  : null;

if (rendererExtensionHost && pluginApi) {
  let started = false;
  let refreshRunning = false;
  let refreshDirty = false;
  let readyListenerAttached = false;
  let changeSubscription: Disposable | null = null;
  let modelEventSubscription: Disposable | null = null;

  const refresh = (): void => {
    if (!started || rendererPlatform.disposed) return;
    refreshDirty = true;
    if (refreshRunning) return;
    refreshRunning = true;
    void Promise.resolve().then(async () => {
      while (refreshDirty && !rendererPlatform.disposed) {
        refreshDirty = false;
        try { await rendererExtensionHost.refresh(); } catch (_) {}
      }
    }).finally(() => {
      refreshRunning = false;
      if (refreshDirty) refresh();
    });
  };

  const start = (): void => {
    if (started || rendererPlatform.disposed) return;
    readyListenerAttached = false;
    started = true;
    refresh();
  };

  // Own the host before subscribing to preload events so partial setup can
  // never leave a listener or extension worker outside platform teardown.
  rendererPlatform.lifecycle.addAsync({
    async dispose(): Promise<void> {
      if (readyListenerAttached && typeof window.removeEventListener === 'function') {
        try { window.removeEventListener('bobo:ready', start); } catch (error) {
          reportExtensionError({ source: 'extension-bootstrap-dispose', error });
        }
        readyListenerAttached = false;
      }
      for (const subscription of [modelEventSubscription, changeSubscription]) {
        if (!subscription) continue;
        try { subscription.dispose(); } catch (error) {
          reportExtensionError({ source: 'extension-bootstrap-dispose', error });
        }
      }
      await rendererExtensionHost.dispose();
    }
  });

  // src/app.js dispatches this only after Monaco and the legacy command
  // palette are ready. Do not let extension activation compete with startup.
  if (document.documentElement?.getAttribute('data-bobo-ready') === 'true') start();
  else {
    try {
      window.addEventListener('bobo:ready', start, { once: true });
      readyListenerAttached = true;
    } catch (error) {
      reportExtensionError({ source: 'extension-bootstrap-subscribe', error });
    }
  }

  if (pluginApi.onDidChange) {
    try {
      changeSubscription = pluginApi.onDidChange(refresh);
    } catch (error) {
      reportExtensionError({ source: 'extension-bootstrap-subscribe', error });
    }
  }
  if (pluginApi.onAgentModelEvent) {
    try {
      modelEventSubscription = pluginApi.onAgentModelEvent((payload) => {
        rendererExtensionHost.handleAgentModelEvent(payload);
      });
    } catch (error) {
      reportExtensionError({ source: 'extension-bootstrap-subscribe', error });
    }
  }
}
