import { rendererPlatform } from '../core/bootstrap.ts';
import { ContributionPoint } from '../core/contribution-registry.ts';
import { PluginPermission } from '../core/plugin-runtime.js';
import { fileDecorationService } from './file-decoration-adapter.ts';
import {
  createSourceControlCommandPayload,
  normalizeSourceControlFormValues
} from '../core/source-control.js';
import { createAgentCommandPayload } from '../core/agent.js';

const BOBO = window.BOBO = window.BOBO || {};

// Legacy modules can discover the new platform through BOBO while new modules
// import their dependencies directly. Plugins receive a narrower context from
// PluginRuntime and should never use this trusted compatibility facade.
BOBO.platform = Object.freeze({
  apiVersion: rendererPlatform.apiVersion,
  contributionPoints: ContributionPoint,
  permissions: PluginPermission,
  fileDecorations: Object.freeze({
    get: (lane, resourcePath, node) => fileDecorationService.get(lane, resourcePath, node),
    onDidChange: (listener) => fileDecorationService.onDidChange(listener)
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
