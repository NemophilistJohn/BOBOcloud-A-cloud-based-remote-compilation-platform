import { rendererPlatform } from './bootstrap.js';
import { PluginExtensionHost } from './plugin-extension-host.js';

function resolvePluginApi() {
  const api = globalThis.window && window.api && window.api.plugins;
  if (!api || typeof api.runtimeDescriptors !== 'function' || typeof api.loadEntry !== 'function') return null;
  return api;
}

const pluginApi = resolvePluginApi();

// Kept module-local on purpose. Installed extension code never receives this
// host, window.BOBO, window.api, Electron IPC, or a DOM reference.
export const rendererExtensionHost = pluginApi
  ? new PluginExtensionHost({
      services: rendererPlatform.services,
      commands: rendererPlatform.commands,
      contributions: rendererPlatform.contributions,
      sourceControls: rendererPlatform.sourceControls,
      listDescriptors: () => pluginApi.runtimeDescriptors(),
      loadEntry: (id) => pluginApi.loadEntry(id),
      loadLocalization: typeof pluginApi.loadLocalization === 'function'
        ? (id, locale) => pluginApi.loadLocalization(id, locale)
        : undefined,
      broker: typeof pluginApi.rpc === 'function'
        ? (id, method, args) => pluginApi.rpc(id, method, args)
        : null,
      localize: (key) => {
        const i18n = window.BOBO && window.BOBO.i18n;
        return i18n && typeof i18n.t === 'function' ? i18n.t(key) : key;
      },
      getLocale: () => {
        const i18n = window.BOBO && window.BOBO.i18n;
        return i18n && typeof i18n.getActive === 'function' ? i18n.getActive() : 'en';
      },
      onLocaleChange: (listener) => {
        const i18n = window.BOBO && window.BOBO.i18n;
        return i18n && typeof i18n.onChange === 'function' ? i18n.onChange(listener) : null;
      },
      getCommandPalette: () => {
        const commands = window.BOBO && window.BOBO.commands;
        return commands && commands.supportsDisposables === true ? commands : null;
      },
      onError: (event) => {
        try { console.error('[plugin-extension:' + event.source + ']', event.id || '', event.error); } catch (_) {}
      }
    })
  : null;

if (rendererExtensionHost) {
  rendererPlatform.lifecycle.add(rendererExtensionHost);
  let started = false;
  let refreshQueued = false;
  const refresh = () => {
    if (!started || refreshQueued || rendererPlatform.disposed) return;
    refreshQueued = true;
    Promise.resolve().then(() => rendererExtensionHost.refresh()).catch(() => {}).finally(() => {
      refreshQueued = false;
    });
  };
  const start = () => {
    if (started || rendererPlatform.disposed) return;
    started = true;
    refresh();
  };

  // src/app.js dispatches this only after Monaco and the legacy command
  // palette are ready. Do not let extension activation compete with startup.
  if (document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true') start();
  else window.addEventListener('bobo:ready', start, { once: true });

  if (typeof pluginApi.onChanged === 'function') {
    const disposeChange = pluginApi.onChanged(refresh);
    if (typeof disposeChange === 'function') rendererPlatform.lifecycle.add({ dispose: disposeChange });
  }
}
