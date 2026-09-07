import {
  CACHE_STORE_SERVICE_ID,
  createCacheStoreService,
  extractCacheEntry,
  extractCacheInventory,
  extractData
} from '../../src/cache-store';
import type { CacheModelFacade } from '../../types/cache-model';
import type {
  CacheStoreAbortController,
  CacheStoreFacade,
  CacheStoreFactoryFacade,
  CacheStoreInvalidationDto,
  CacheStoreRendererState,
  CacheStoreSendToServer,
  CacheStoreService,
  LegacyCacheStoreFactoryOptions
} from '../../types/cache-store';
import { rendererPlatform } from '../core/bootstrap';

interface AbortControllerConstructor {
  new(): CacheStoreAbortController;
}

interface CustomEventConstructor {
  new(type: string, init: { readonly detail: CacheStoreInvalidationDto }): unknown;
}

interface LegacyCacheStoreNamespace {
  state?: CacheStoreRendererState;
  sendToServer?: CacheStoreSendToServer;
  cacheModel?: CacheModelFacade;
  cacheStore?: CacheStoreFacade;
  cacheStoreFactory?: CacheStoreFactoryFacade;
}

interface LegacyCacheStoreRoot {
  BOBO?: LegacyCacheStoreNamespace;
  AbortController?: AbortControllerConstructor;
  CustomEvent?: CustomEventConstructor;
  dispatchEvent?: (event: unknown) => unknown;
}

function facadeFor(service: CacheStoreService): CacheStoreFacade {
  return {
    subscribe: service.subscribe,
    getState: service.getState,
    load: service.load,
    getEntry: service.getEntry,
    deleteEntry: service.deleteEntry,
    clearScope: service.clearScope,
    invalidate: service.invalidate,
    setActive: service.setActive,
    reset: service.reset
  };
}

function legacyService(options?: LegacyCacheStoreFactoryOptions | null): CacheStoreService {
  const resolved = (options || {}) as LegacyCacheStoreFactoryOptions;
  const root = (resolved.global || window) as LegacyCacheStoreRoot;
  const namespace = (
    resolved.BOBO || root.BOBO || {}
  ) as LegacyCacheStoreNamespace;
  const model = resolved.model || namespace.cacheModel;

  return createCacheStoreService({
    model,
    getState: () => namespace.state,
    sendToServer: (action, payload, transportOptions) => {
      const sender = namespace.sendToServer as CacheStoreSendToServer;
      return sender.call(namespace, action, payload, transportOptions);
    },
    createAbortController: () => {
      const Controller = root.AbortController;
      if (typeof Controller !== 'function') return null;
      try {
        return new Controller();
      } catch (_) {
        return null;
      }
    },
    dispatchInvalidationEvent: (detail) => {
      const EventConstructor = root.CustomEvent;
      if (root.dispatchEvent && typeof EventConstructor === 'function') {
        root.dispatchEvent.call(root, new EventConstructor('bobo:cache-changed', { detail }));
      }
    },
    reportListenerError: (error) => {
      console.error('cache store listener:', error);
    }
  });
}

function createLegacyCacheStore(
  options?: LegacyCacheStoreFactoryOptions | null
): CacheStoreFacade {
  return facadeFor(legacyService(options));
}

const legacyWindow = window as Window & LegacyCacheStoreRoot;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

const cacheStore = legacyService({ global: legacyWindow, BOBO });

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  CACHE_STORE_SERVICE_ID,
  cacheStore,
  { owner: 'core.cacheInventory', exposeToPlugins: false }
));

// Preserve both historical writable facades; disposal remains registry-owned.
BOBO.cacheStoreFactory = {
  createCacheStore: createLegacyCacheStore,
  extractData,
  extractCacheInventory,
  extractCacheEntry
};
BOBO.cacheStore = facadeFor(cacheStore);
