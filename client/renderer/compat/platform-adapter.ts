import type {
  RendererPlatformCompatibilityFacade,
  RendererPlatformContributionsFacade,
  RendererPlatformServicesFacade
} from '../../types/platform-adapter';
import type { RendererPluginServiceMap } from '../../types/renderer-platform';
import { rendererPlatform } from '../core/bootstrap';
import { ContributionPoint } from '../core/contribution-registry';
import { PluginPermission } from '../core/plugin-runtime.js';
import { fileDecorationService } from './file-decoration-adapter';
import {
  createSourceControlCommandPayload,
  normalizeSourceControlFormValues
} from '../core/source-control.js';
import { createAgentCommandPayload } from '../core/agent.js';

interface LegacyBoboPlatformSurface {
  platform?: RendererPlatformCompatibilityFacade<RendererPluginServiceMap>;
}

type PlatformAdapterWindow = Window & {
  BOBO?: LegacyBoboPlatformSurface;
};

type PlatformFacade = RendererPlatformCompatibilityFacade<RendererPluginServiceMap>;

const legacyWindow = window as PlatformAdapterWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// These casts are confined to the trusted compatibility boundary. The
// registries intentionally keep their primary TypeScript API map-keyed, while
// the legacy JavaScript facade retains its existing dynamic lookup semantics.
const dynamicServices = rendererPlatform.services as unknown as RendererPlatformServicesFacade;
const dynamicContributionReads = rendererPlatform.contributions as unknown as Pick<
  RendererPlatformContributionsFacade,
  'list' | 'collect' | 'describe'
>;

// Legacy modules can discover the new platform through BOBO while new modules
// import their dependencies directly. Plugins receive a narrower context from
// PluginRuntime and should never use this trusted compatibility facade.
export const rendererPlatformFacade = Object.freeze({
  apiVersion: rendererPlatform.apiVersion,
  contributionPoints: ContributionPoint,
  permissions: PluginPermission,
  fileDecorations: Object.freeze({
    get: (lane, resourcePath, node) => fileDecorationService.get(lane, resourcePath, node),
    onDidChange: (listener) => fileDecorationService.onDidChange(listener)
  } satisfies PlatformFacade['fileDecorations']),
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
  } satisfies PlatformFacade['sourceControl']),
  agents: Object.freeze({
    list: () => rendererPlatform.agents.list(),
    get: (id) => rendererPlatform.agents.get(id),
    onDidChange: (listener) => rendererPlatform.agents.onDidChange(listener),
    createCommandPayload: (providerId, action, values) => (
      createAgentCommandPayload(providerId, action, values)
    )
  } satisfies PlatformFacade['agents']),
  services: Object.freeze({
    has: (id) => dynamicServices.has(id),
    get: (id) => dynamicServices.get(id),
    describe: () => dynamicServices.describe()
  } satisfies PlatformFacade['services']),
  commands: Object.freeze({
    register: (id, handler, metadata) => (
      rendererPlatform.commands.registerDynamic(id, handler, metadata)
    ),
    execute: (id, ...args) => rendererPlatform.commands.executeDynamic(id, ...args),
    executeIsolated: (id, ...args) => (
      rendererPlatform.commands.executeDynamicIsolated(id, ...args)
    ),
    describe: () => rendererPlatform.commands.describe()
  } satisfies PlatformFacade['commands']),
  contributions: Object.freeze({
    register: (point, contribution, options) => (
      rendererPlatform.contributions.registerDynamic(point, contribution, options)
    ),
    list: (point) => dynamicContributionReads.list(point),
    collect: (point, method, ...args) => dynamicContributionReads.collect(point, method, ...args),
    describe: (point) => dynamicContributionReads.describe(point)
  } satisfies PlatformFacade['contributions']),
  plugins: Object.freeze({
    activate: (manifest, pluginModule) => rendererPlatform.plugins.activate(manifest, pluginModule),
    deactivate: (id) => rendererPlatform.plugins.deactivate(id),
    list: () => rendererPlatform.plugins.list()
  } satisfies PlatformFacade['plugins'])
} satisfies PlatformFacade);

BOBO.platform = rendererPlatformFacade;
