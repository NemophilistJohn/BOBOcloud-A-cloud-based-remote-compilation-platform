import {
  createServerCommService,
  SERVER_COMM_SERVICE_ID
} from '../../src/server-comm';
import type {
  ServerCommAbortController,
  ServerCommAuthPort,
  ServerCommFacade,
  ServerCommFetchResponse,
  ServerCommI18nPort,
  ServerCommRendererState,
  ServerCommRunOutputPort,
  ServerCommService,
  ServerCommWorkspacePort
} from '../../types/server-comm';
import type { I18nService } from '../../types/i18n';
import type { RendererState } from '../../types/state';
import type { ServerTransportService } from '../../types/server-runtime';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyServerCommBobo {
  state?: RendererState;
  i18n?: I18nService | ServerCommI18nPort;
  serverTransport?: ServerTransportService;
  workspace?: ServerCommWorkspacePort;
  auth?: ServerCommAuthPort;
  runOutput?: ServerCommRunOutputPort;
  localPathSeparator?: (workspaceRoot: unknown) => string;
  // The adapter is the only writer of these five historical keys at startup.
  updateRunOutput?: ServerCommFacade['updateRunOutput'];
  clearRunOutput?: ServerCommFacade['clearRunOutput'];
  clearRunOutputDetails?: ServerCommFacade['clearRunOutputDetails'];
  refreshRunOutputOmission?: ServerCommFacade['refreshRunOutputOmission'];
  sendToServer?: ServerCommFacade['sendToServer'];
}

interface LegacyServerCommWindow extends Window {
  BOBO?: LegacyServerCommBobo;
  AbortController?: typeof AbortController;
}

const legacyWindow = window as LegacyServerCommWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Server communication requires renderer state.');

function createAbortController(): ServerCommAbortController | null {
  const Controller = legacyWindow.AbortController;
  if (typeof Controller !== 'function') return null;
  try {
    return new Controller() as unknown as ServerCommAbortController;
  } catch (_) {
    return null;
  }
}

const serverComm: ServerCommService = createServerCommService({
  document: legacyWindow.document,
  getState: () => BOBO.state as unknown as ServerCommRendererState | undefined,
  getI18n: () => BOBO.i18n as ServerCommI18nPort | undefined,
  getTransport: () => BOBO.serverTransport,
  getWorkspace: () => BOBO.workspace,
  getAuth: () => BOBO.auth,
  getRunOutput: () => BOBO.runOutput,
  getLocalPathSeparator: (workspaceRoot) => {
    const separator = BOBO.localPathSeparator;
    return typeof separator === 'function' ? separator(workspaceRoot) : '/';
  },
  fetch: (url, init) => {
    // Keep the legacy unqualified-fetch behavior while making the host explicit
    // for tests and for CSP/auditing. A missing fetch rejects at call time and
    // is normalized by sendToServer's existing transport error path.
    const fetchImpl = legacyWindow.fetch;
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('fetch is unavailable'));
    }
    return fetchImpl.call(legacyWindow, url, init as unknown as RequestInit) as unknown as Promise<ServerCommFetchResponse>;
  },
  createAbortController,
  setTimeout: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimeout: (timer) => legacyWindow.clearTimeout(timer as unknown as number)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  SERVER_COMM_SERVICE_ID,
  serverComm,
  { owner: 'core.serverRuntime', exposeToPlugins: false }
));

// Preserve the historical writable five-key facade. Disposal remains owned by
// the private renderer service registry and is intentionally not projected.
BOBO.updateRunOutput = serverComm.updateRunOutput;
BOBO.clearRunOutput = serverComm.clearRunOutput;
BOBO.clearRunOutputDetails = serverComm.clearRunOutputDetails;
BOBO.refreshRunOutputOmission = serverComm.refreshRunOutputOmission;
BOBO.sendToServer = serverComm.sendToServer;

export { serverComm };
