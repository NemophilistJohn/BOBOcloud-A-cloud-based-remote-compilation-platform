export { toDisposable, DisposableStore } from './disposable.js';
export { ServiceRegistry } from './service-registry.js';
export { CommandRegistry } from './command-registry.js';
export { ContributionPoint, ContributionRegistry } from './contribution-registry.js';
export {
  FileDecorationLane,
  contributionPointForDecorationLane,
  normalizeFileDecoration,
  validateFileDecorationProvider
} from './file-decoration.js';
export {
  PLUGIN_API_VERSION,
  PluginPermission,
  PluginRuntime,
  validatePluginManifest
} from './plugin-runtime.js';
export { createRendererPlatform } from './platform.js';
