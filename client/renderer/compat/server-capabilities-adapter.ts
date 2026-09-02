import { createServerCapabilities } from '../../src/server-capabilities';
import type {
  ServerCapabilityService,
  ServerCapabilityState,
  ServerInfoSender
} from '../../types/server-runtime';
import { rendererPlatform } from '../core/typed-platform';

export const SERVER_CAPABILITIES_SERVICE_ID = 'workbench.serverCapabilities';

interface LegacyBobo {
  state?: ServerCapabilityState;
  sendToServer?: ServerInfoSender;
  serverCapabilities?: ServerCapabilityService;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const serverCapabilities = createServerCapabilities({
  getState: () => BOBO.state,
  getSendToServer: () => BOBO.sendToServer?.bind(BOBO),
  emitChange: (detail) => {
    if (
      typeof legacyWindow.dispatchEvent === 'function'
      && typeof CustomEvent === 'function'
    ) {
      legacyWindow.dispatchEvent(new CustomEvent(
        'bobo:server-capabilities-changed',
        { detail }
      ));
    }
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  SERVER_CAPABILITIES_SERVICE_ID,
  serverCapabilities,
  { owner: 'core.serverRuntime', exposeToPlugins: false }
));

BOBO.serverCapabilities = serverCapabilities;
