import { DisposableStore } from './disposable.js';
import { ServiceRegistry } from './service-registry.js';
import { CommandRegistry } from './command-registry.js';
import { ContributionRegistry } from './contribution-registry.js';
import { SourceControlStateStore } from './source-control.js';
import { AgentStateStore } from './agent.js';
import { PLUGIN_API_VERSION, PluginRuntime } from './plugin-runtime.js';

export function createRendererPlatform(options = {}) {
  const logger = options.logger || console;
  const onError = typeof options.onError === 'function'
    ? options.onError
    : (event) => {
        try {
          logger.error('[renderer-platform:' + event.source + ']', event.id || '', event.error);
        } catch (_) {
          // Logging must never turn an isolated extension failure into a host failure.
        }
      };

  const lifecycle = new DisposableStore({ onError });
  const services = new ServiceRegistry({ onError });
  const commands = new CommandRegistry({ onError });
  const contributions = new ContributionRegistry({ onError });
  const sourceControls = new SourceControlStateStore({ onError });
  const agents = new AgentStateStore({ onError });
  const plugins = new PluginRuntime({ services, commands, contributions, sourceControls, agents, onError });
  let disposed = false;

  return Object.freeze({
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
    async dispose() {
      if (disposed) return;
      disposed = true;
      await plugins.dispose();
      lifecycle.dispose();
      sourceControls.dispose();
      agents.dispose();
      contributions.dispose();
      commands.dispose();
      services.dispose();
    }
  });
}
