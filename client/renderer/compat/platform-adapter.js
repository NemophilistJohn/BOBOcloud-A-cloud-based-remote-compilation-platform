import { rendererPlatform } from '../core/bootstrap.js';
import { ContributionPoint } from '../core/contribution-registry.js';
import {
  FileDecorationLane,
  contributionPointForDecorationLane,
  normalizeFileDecoration
} from '../core/file-decoration.js';
import { PluginPermission } from '../core/plugin-runtime.js';
import { toDisposable } from '../core/disposable.js';
import {
  createSourceControlCommandPayload,
  normalizeSourceControlFormValues
} from '../core/source-control.js';
import { createAgentCommandPayload } from '../core/agent.js';

const BOBO = window.BOBO = window.BOBO || {};

const FILE_DECORATION_LANES = Object.freeze([
  FileDecorationLane.SYNC,
  FileDecorationLane.SCM,
  FileDecorationLane.DIAGNOSTIC
]);

function laneForContributionPoint(point) {
  return FILE_DECORATION_LANES.find((lane) => contributionPointForDecorationLane(lane) === point) || null;
}

function reportDecorationError(phase, entry, error) {
  try {
    console.error('[renderer-platform:file-decoration:' + phase + ']', entry && entry.id || '', error);
  } catch (_) {
    // A provider failure must not escape through host logging.
  }
}

function createFileDecorationBridge() {
  const listeners = new Set();
  const providerSubscriptions = new Map();

  function entryKey(entry) {
    return entry.point + '\u0000' + entry.id;
  }

  function emit(event) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        reportDecorationError('listener', { id: event.providerId }, error);
      }
    }
  }

  function providerEvent(entry, paths, reason) {
    const lane = laneForContributionPoint(entry.point);
    if (!lane) return;
    emit(Object.freeze({
      lane,
      paths: Array.isArray(paths) ? Object.freeze([...paths]) : undefined,
      reason,
      providerId: entry.id
    }));
  }

  function unsubscribeProvider(entry) {
    const key = entryKey(entry);
    const disposable = providerSubscriptions.get(key);
    providerSubscriptions.delete(key);
    if (!disposable) return;
    try {
      disposable.dispose();
    } catch (error) {
      reportDecorationError('unsubscribe', entry, error);
    }
  }

  function subscribeProvider(entry) {
    unsubscribeProvider(entry);
    const provider = entry.contribution;
    if (!provider || typeof provider.onDidChange !== 'function') return;
    try {
      const disposable = provider.onDidChange((paths) => providerEvent(entry, paths, 'provider'));
      if (disposable && typeof disposable.dispose === 'function') {
        providerSubscriptions.set(entryKey(entry), disposable);
      } else if (disposable != null) {
        throw new TypeError('File decoration provider onDidChange must return a disposable.');
      }
    } catch (error) {
      reportDecorationError('subscribe', entry, error);
    }
  }

  function onRegistryChange(event) {
    if (!laneForContributionPoint(event.point)) return;
    if (event.type === 'added') subscribeProvider(event);
    else unsubscribeProvider(event);
    providerEvent(event, undefined, 'registry');
  }

  const registrySubscription = rendererPlatform.contributions.onDidChange(onRegistryChange);
  const languageChangeListener = () => {
    // Decoration providers return localized tooltip text lazily. Request a
    // lane redraw when the workbench language changes without exposing any
    // locale or DOM capability to installed package code.
    for (const lane of FILE_DECORATION_LANES) {
      emit(Object.freeze({ lane, reason: 'language' }));
    }
  };
  if (window && typeof window.addEventListener === 'function') {
    window.addEventListener('bobo:language-changed', languageChangeListener);
  }
  for (const lane of FILE_DECORATION_LANES) {
    const point = contributionPointForDecorationLane(lane);
    for (const entry of rendererPlatform.contributions.listEntries(point)) subscribeProvider(entry);
  }

  function get(lane, resourcePath, node) {
    const point = contributionPointForDecorationLane(lane);
    const entries = rendererPlatform.contributions.listEntries(point).sort((left, right) => {
      const priorityDifference = (right.contribution.priority || 0) - (left.contribution.priority || 0);
      return priorityDifference || left.id.localeCompare(right.id);
    });
    for (const entry of entries) {
      try {
        const value = entry.contribution.getDecoration(resourcePath, node);
        if (value && typeof value.then === 'function') {
          Promise.resolve(value).catch(() => {});
          throw new TypeError('File decoration providers must return synchronously.');
        }
        const decoration = normalizeFileDecoration(value);
        if (decoration) return decoration;
      } catch (error) {
        reportDecorationError('get', entry, error);
      }
    }
    return null;
  }

  function onDidChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('File decoration listener must be a function.');
    listeners.add(listener);
    return toDisposable(() => listeners.delete(listener));
  }

  return Object.freeze({
    get,
    onDidChange,
    dispose() {
      registrySubscription.dispose();
      if (window && typeof window.removeEventListener === 'function') {
        window.removeEventListener('bobo:language-changed', languageChangeListener);
      }
      for (const disposable of Array.from(providerSubscriptions.values()).reverse()) {
        try { disposable.dispose(); } catch (error) { reportDecorationError('unsubscribe', null, error); }
      }
      providerSubscriptions.clear();
      listeners.clear();
    }
  });
}

const fileDecorationBridge = createFileDecorationBridge();
rendererPlatform.lifecycle.add(fileDecorationBridge);

// Legacy modules can discover the new platform through BOBO while new modules
// import their dependencies directly. Plugins receive a narrower context from
// PluginRuntime and should never use this trusted compatibility facade.
BOBO.platform = Object.freeze({
  apiVersion: rendererPlatform.apiVersion,
  contributionPoints: ContributionPoint,
  permissions: PluginPermission,
  fileDecorations: Object.freeze({
    get: (lane, resourcePath, node) => fileDecorationBridge.get(lane, resourcePath, node),
    onDidChange: (listener) => fileDecorationBridge.onDidChange(listener)
  }),
  // This is a trusted compatibility projection for the host-rendered sidebar.
  // Installed extension Workers never receive BOBO.platform or this store.
  sourceControl: Object.freeze({
    list: () => rendererPlatform.sourceControls.list(),
    get: (id) => rendererPlatform.sourceControls.get(id),
    onDidChange: (listener) => rendererPlatform.sourceControls.onDidChange(listener),
    normalizeFormValues: (form, values) => normalizeSourceControlFormValues(form, values),
    createCommandPayload: (descriptorId, actionId, values, details) => (
      createSourceControlCommandPayload(descriptorId, actionId, values, details)
    )
  }),
  agents: Object.freeze({
    list: () => rendererPlatform.agents.list(),
    get: (id) => rendererPlatform.agents.get(id),
    onDidChange: (listener) => rendererPlatform.agents.onDidChange(listener),
    createCommandPayload: (providerId, action, values) => createAgentCommandPayload(providerId, action, values)
  }),
  services: Object.freeze({
    has: (id) => rendererPlatform.services.has(id),
    get: (id) => rendererPlatform.services.get(id),
    describe: () => rendererPlatform.services.describe()
  }),
  commands: Object.freeze({
    register: (id, handler, metadata) => rendererPlatform.commands.register(id, handler, metadata),
    execute: (id, ...args) => rendererPlatform.commands.execute(id, ...args),
    executeIsolated: (id, ...args) => rendererPlatform.commands.executeIsolated(id, ...args),
    describe: () => rendererPlatform.commands.describe()
  }),
  contributions: Object.freeze({
    register: (point, contribution, options) => rendererPlatform.contributions.register(point, contribution, options),
    list: (point) => rendererPlatform.contributions.list(point),
    collect: (point, method, ...args) => rendererPlatform.contributions.collect(point, method, ...args),
    describe: (point) => rendererPlatform.contributions.describe(point)
  }),
  plugins: Object.freeze({
    activate: (manifest, pluginModule) => rendererPlatform.plugins.activate(manifest, pluginModule),
    deactivate: (id) => rendererPlatform.plugins.deactivate(id),
    list: () => rendererPlatform.plugins.list()
  })
});
