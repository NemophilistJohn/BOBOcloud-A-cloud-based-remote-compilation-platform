import {
  createEnvironmentActivityService,
  ENVIRONMENT_ACTIVITY_EVENT_NAME,
  ENVIRONMENT_ACTIVITY_SERVICE_ID,
  ENVIRONMENT_ACTIVITY_STORAGE_KEY
} from '../../src/environment-activity';
import type {
  EnvironmentActivityFacade,
  EnvironmentActivityRendererState,
  EnvironmentActivityStorage
} from '../../types/environment-activity';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyBobo {
  state?: EnvironmentActivityRendererState;
  projectKey?: (workspaceRoot: string) => string;
  environmentActivity?: EnvironmentActivityFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state || {};
let storage: EnvironmentActivityStorage | null = null;
try {
  storage = legacyWindow.localStorage;
} catch (_) {
  // Storage can be denied for opaque origins; the in-memory ledger still works.
}

const environmentActivity = createEnvironmentActivityService({
  state,
  storage,
  projectKey: (workspaceRoot) => BOBO.projectKey
    ? BOBO.projectKey(workspaceRoot)
    : '',
  now: () => Date.now(),
  dispatchEvent: (event) => {
    legacyWindow.dispatchEvent(new CustomEvent(ENVIRONMENT_ACTIVITY_EVENT_NAME, { detail: event }));
  },
  reportSubscriberError: (error) => {
    console.error('environment activity subscriber:', error);
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  ENVIRONMENT_ACTIVITY_SERVICE_ID,
  environmentActivity,
  { owner: 'core.environment-activity', exposeToPlugins: false }
));

// Preserve the historical writable seven-key facade while disposal stays registry-owned.
BOBO.environmentActivity = {
  read: environmentActivity.read,
  record: environmentActivity.record,
  contextChanged: environmentActivity.contextChanged,
  subscribe: environmentActivity.subscribe,
  getScope: environmentActivity.getScope,
  getScopeKey: environmentActivity.getScopeKey,
  _storageKey: ENVIRONMENT_ACTIVITY_STORAGE_KEY
};
