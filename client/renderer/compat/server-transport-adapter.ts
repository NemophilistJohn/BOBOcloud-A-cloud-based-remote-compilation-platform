import { createServerTransport } from '../../src/server-transport';
import type { ServerTransportService } from '../../types/server-runtime';
import { rendererPlatform } from '../core/bootstrap';

export const SERVER_TRANSPORT_SERVICE_ID = 'workbench.serverTransport';

interface LegacyBobo {
  serverTransport?: Readonly<ServerTransportService>;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const serverTransport = createServerTransport();

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  SERVER_TRANSPORT_SERVICE_ID,
  serverTransport,
  { owner: 'core.serverRuntime', exposeToPlugins: false }
));

BOBO.serverTransport = serverTransport;
