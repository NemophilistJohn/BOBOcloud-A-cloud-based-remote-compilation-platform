import type {
  RendererCommandMap,
  RendererContributionMap,
  RendererPlatform,
  RendererPlatformErrorEvent,
  RendererPlatformOptions,
  RendererPluginServiceMap,
  RendererServiceMap
} from '../../types/renderer-platform';
import { DisposableStore } from './disposable.js';
import { ServiceRegistry } from './service-registry';
import { CommandRegistry } from './command-registry';
import { ContributionRegistry } from './contribution-registry';
import { SourceControlStateStore } from './source-control.js';
import { AgentStateStore } from './agent.js';
import { PLUGIN_API_VERSION, PluginRuntime } from './plugin-runtime.js';

export function createRendererPlatform(options: RendererPlatformOptions = {}): RendererPlatform {
  const logger = options.logger || console;
  const observer = typeof options.onError === 'function' ? options.onError : null;
  const logError = (event: RendererPlatformErrorEvent): void => {
    try {
      logger.error('[renderer-platform:' + event.source + ']', event.id || '', event.error);
    } catch (_) {
      // Logging must never turn an isolated extension failure into a host failure.
    }
  };
  const onError = (event: RendererPlatformErrorEvent): void => {
    if (!observer) {
      logError(event);
      return;
    }
    try {
      observer(event);
    } catch (error) {
      logError(event);
      logError({ source: 'error-observer', id: event.id, error });
    }
  };

  const lifecycle = new DisposableStore({ onError });
  const services = new ServiceRegistry<RendererServiceMap, RendererPluginServiceMap>({ onError });
  const commands = new CommandRegistry<RendererCommandMap>({ onError });
  const contributions = new ContributionRegistry<RendererContributionMap>({ onError });
  const sourceControls = new SourceControlStateStore({ onError });
  const agents = new AgentStateStore({ onError });
  const plugins = new PluginRuntime({ services, commands, contributions, sourceControls, agents, onError });
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const disposeSafely = async (source: string, dispose: () => void | PromiseLike<void>): Promise<void> => {
    try {
      await dispose();
    } catch (error) {
      onError({ source, error });
    }
  };

  const platform: RendererPlatform = Object.freeze({
    apiVersion: PLUGIN_API_VERSION,
    lifecycle,
    services,
    commands,
    contributions,
    sourceControls,
    agents,
    plugins,
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        await disposeSafely('plugin-runtime-dispose', () => plugins.dispose());
        await disposeSafely('lifecycle-dispose', () => lifecycle.disposeAsync());
        await disposeSafely('source-control-dispose', () => sourceControls.dispose());
        await disposeSafely('agent-state-dispose', () => agents.dispose());
        await disposeSafely('contribution-registry-dispose', () => contributions.dispose());
        await disposeSafely('command-registry-dispose', () => commands.dispose());
        await disposeSafely('service-registry-dispose', () => services.dispose());
      })();
      return disposePromise;
    }
  });

  return platform;
}
