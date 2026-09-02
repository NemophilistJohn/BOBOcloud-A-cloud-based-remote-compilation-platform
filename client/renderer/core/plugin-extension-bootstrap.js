import { rendererPlatform } from './bootstrap.ts';
import { PluginExtensionHost } from './plugin-extension-host.js';
import { unwrapPluginRpcResult } from './plugin-extension-protocol.js';

function resolvePluginApi() {
  const api = globalThis.window && window.api && window.api.plugins;
  if (!api || typeof api.runtimeDescriptors !== 'function' || typeof api.loadEntry !== 'function') return null;
  return api;
}

const pluginApi = resolvePluginApi();

function reportExtensionError(event) {
  try { console.error('[plugin-extension:' + event.source + ']', event.id || '', event.error); } catch (_) {}
}

// Kept module-local on purpose. Installed extension code never receives this
// host, window.BOBO, window.api, Electron IPC, or a DOM reference.
export const rendererExtensionHost = pluginApi
  ? new PluginExtensionHost({
      services: rendererPlatform.services,
      commands: rendererPlatform.commands,
      contributions: rendererPlatform.contributions,
      sourceControls: rendererPlatform.sourceControls,
      agents: rendererPlatform.agents,
      listDescriptors: () => pluginApi.runtimeDescriptors(),
      loadEntry: (id) => pluginApi.loadEntry(id),
      loadLocalization: typeof pluginApi.loadLocalization === 'function'
        ? (id, locale) => pluginApi.loadLocalization(id, locale)
        : undefined,
      broker: typeof pluginApi.rpc === 'function'
        ? (id, method, args) => Promise.resolve(pluginApi.rpc(id, method, args)).then(unwrapPluginRpcResult)
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
      onError: reportExtensionError
    })
  : null;

if (rendererExtensionHost) {
  let started = false;
  let refreshRunning = false;
  let refreshDirty = false;
  let readyListenerAttached = false;
  let disposeChange = null;
  let disposeModelEvent = null;
  const refresh = () => {
    if (!started || rendererPlatform.disposed) return;
    refreshDirty = true;
    if (refreshRunning) return;
    refreshRunning = true;
    Promise.resolve().then(async () => {
      while (refreshDirty && !rendererPlatform.disposed) {
        refreshDirty = false;
        try { await rendererExtensionHost.refresh(); } catch (_) {}
      }
    }).finally(() => {
      refreshRunning = false;
      if (refreshDirty) refresh();
    });
  };
  const start = () => {
    if (started || rendererPlatform.disposed) return;
    readyListenerAttached = false;
    started = true;
    refresh();
  };

  // Own the host before subscribing to preload events so partial setup can
  // never leave a listener or extension worker outside platform teardown.
  rendererPlatform.lifecycle.addAsync({
    async dispose() {
      if (readyListenerAttached && typeof window.removeEventListener === 'function') {
        try { window.removeEventListener('bobo:ready', start); } catch (error) {
          reportExtensionError({ source: 'extension-bootstrap-dispose', error });
        }
        readyListenerAttached = false;
      }
      for (const dispose of [disposeModelEvent, disposeChange]) {
        if (typeof dispose !== 'function') continue;
        try { await dispose(); } catch (error) {
          reportExtensionError({ source: 'extension-bootstrap-dispose', error });
        }
      }
      await rendererExtensionHost.dispose();
    }
  });

  // src/app.js dispatches this only after Monaco and the legacy command
  // palette are ready. Do not let extension activation compete with startup.
  if (document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true') start();
  else {
    try {
      window.addEventListener('bobo:ready', start, { once: true });
      readyListenerAttached = true;
    } catch (error) {
      reportExtensionError({ source: 'extension-bootstrap-subscribe', error });
    }
  }

  if (typeof pluginApi.onChanged === 'function') {
    try {
      const candidate = pluginApi.onChanged(refresh);
      if (typeof candidate === 'function') disposeChange = candidate;
    } catch (error) {
      reportExtensionError({ source: 'extension-bootstrap-subscribe', error });
    }
  }
  if (typeof pluginApi.onAgentModelEvent === 'function') {
    try {
      const candidate = pluginApi.onAgentModelEvent((payload) => {
        rendererExtensionHost.handleAgentModelEvent(payload);
      });
      if (typeof candidate === 'function') disposeModelEvent = candidate;
    } catch (error) {
      reportExtensionError({ source: 'extension-bootstrap-subscribe', error });
    }
  }
}
