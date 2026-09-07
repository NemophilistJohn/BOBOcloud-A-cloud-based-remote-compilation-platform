import type { CacheEntryDto, CacheInventoryDto } from '../types/cache-model';
import type {
  CacheStoreActionDto,
  CacheStoreClearScopeDto,
  CacheStoreClearScopeRequestDto,
  CacheStoreDependencies,
  CacheStoreInvalidationDto,
  CacheStoreListener,
  CacheStoreLoadOptionsDto,
  CacheStoreRequestMap,
  CacheStoreService,
  CacheStoreSnapshotDto,
  CacheStoreStatusDto
} from '../types/cache-store';

export const CACHE_STORE_SERVICE_ID = 'workbench.cacheStore';

const READ_TIMEOUT_MS = 20000;
const MUTATION_TIMEOUT_MS = 30000;

interface CacheStoreError extends Error {
  code?: unknown;
}

interface MutableCacheStoreState {
  status: CacheStoreStatusDto;
  inventory: CacheInventoryDto | null;
  error: unknown | null;
  stale: boolean;
  identity: string;
  mutations: Record<string, true>;
  invalidation: CacheStoreInvalidationDto;
}

interface OperationContext {
  readonly identity: string;
  readonly epoch: number;
}

interface LoadContext extends OperationContext {
  readonly loadEpoch: number;
}

interface LoadFlight extends LoadContext {
  readonly version: number;
  readonly controller: ReturnType<CacheStoreDependencies['createAbortController']>;
  readonly promise: Promise<CacheInventoryDto | null>;
  readonly resolve: (inventory: CacheInventoryDto | null) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

interface TrailingRefresh extends LoadContext {
  readonly promise: Promise<CacheInventoryDto | null>;
  readonly resolve: (inventory: CacheInventoryDto | null) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

interface MutationToken extends OperationContext {
  readonly key: string;
  readonly value: symbol;
}

type ResponseObject = Record<string, unknown>;
type ResponsePropertySource = Record<string, unknown>;

function asResponseObject(value: unknown): ResponseObject | null {
  return value !== null && typeof value === 'object'
    ? value as ResponseObject
    : null;
}

function asResponsePropertySource(value: unknown): ResponsePropertySource | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as ResponsePropertySource
    : null;
}

export function extractData(response: unknown): Record<string, unknown> {
  const source = asResponseObject(response);
  if (!source) return {};
  const data = source.data;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  const legacyData = source.Data;
  if (legacyData && typeof legacyData === 'object') {
    return legacyData as Record<string, unknown>;
  }
  return source;
}

export function extractCacheInventory(response: unknown): unknown | null {
  const data = extractData(response);
  const source = asResponsePropertySource(response);
  return data.cacheInventory || source?.cacheInventory || null;
}

export function extractCacheEntry(response: unknown): unknown | null {
  const data = extractData(response);
  const source = asResponsePropertySource(response);
  return data.cacheEntry || source?.cacheEntry || null;
}

function responseError(response: unknown, fallback?: unknown): string {
  const source = asResponsePropertySource(response);
  const data = extractData(response);
  return String(source?.error || data.error || fallback || 'Cache request failed.');
}

function createDeferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function createCacheStoreService(
  dependencies: CacheStoreDependencies
): CacheStoreService {
  const model = dependencies.model;
  const listeners = new Set<CacheStoreListener>();
  const mutationTokens = new Map<string, MutationToken>();
  let contextEpoch = 0;
  let loadEpoch = 0;
  let refreshVersion = 0;
  let committedVersion = -1;
  let currentLoad: LoadFlight | null = null;
  let trailingRefresh: TrailingRefresh | null = null;
  let active = false;
  let disposed = false;
  let abortDepth = 0;
  const state: MutableCacheStoreState = {
    status: 'idle',
    inventory: null,
    error: null,
    stale: true,
    identity: '',
    mutations: Object.create(null) as Record<string, true>,
    invalidation: null
  };

  function identity(): string {
    const source = dependencies.getState() || {};
    const auth = source.auth || {};
    const server = source.serverSettings || {};
    const user = auth.user || {};
    return [server.ip || '', auth.token || '', user.id || user.uid || ''].join('\n');
  }

  function snapshot(): CacheStoreSnapshotDto {
    return {
      status: state.status,
      inventory: state.inventory,
      error: state.error,
      stale: state.stale,
      identity: state.identity,
      mutations: Object.assign({}, state.mutations),
      invalidation: state.invalidation
    };
  }

  function emit(reason?: unknown): void {
    const current = snapshot();
    listeners.forEach((listener) => {
      try {
        listener(current, String(reason || 'change'));
      } catch (error) {
        try { dependencies.reportListenerError(error); } catch (_) {
          // Observability cannot strand the store's request coordinator.
        }
      }
    });
  }

  function subscribe(listener: CacheStoreListener): () => void {
    if (disposed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    listener(snapshot(), 'subscribe');
    return () => { listeners.delete(listener); };
  }

  function fail(message?: unknown, code?: unknown): CacheStoreError {
    const error = new Error(String(message || 'Cache request failed.')) as CacheStoreError;
    if (code) error.code = code;
    return error;
  }

  function disposedError(): CacheStoreError {
    return fail('Cache store has been disposed.', 'cache_store_disposed');
  }

  function contextError(kind: 'request' | 'operation'): CacheStoreError {
    return fail(
      kind === 'request'
        ? 'The server or account changed during the cache request.'
        : 'The server or account changed during the cache operation.',
      'cache_context_changed'
    );
  }

  function ensureResponse(response: unknown, fallback: string): unknown {
    const source = asResponsePropertySource(response);
    if (!response || source?.success === false) {
      throw fail(
        responseError(response, fallback),
        source && (source.errorCode || source.error_code)
      );
    }
    return response;
  }

  function settleLoad(
    flight: LoadFlight,
    kind: 'resolve' | 'reject',
    value: CacheInventoryDto | null | unknown
  ): void {
    if (flight.settled) return;
    flight.settled = true;
    if (kind === 'resolve') flight.resolve(value as CacheInventoryDto | null);
    else flight.reject(value);
  }

  function settleTrailing(
    refresh: TrailingRefresh,
    kind: 'resolve' | 'reject',
    value: CacheInventoryDto | null | unknown
  ): void {
    if (refresh.settled) return;
    refresh.settled = true;
    if (kind === 'resolve') refresh.resolve(value as CacheInventoryDto | null);
    else refresh.reject(value);
  }

  function cancelReadRequests(): boolean {
    loadEpoch += 1;
    const flight = currentLoad;
    currentLoad = null;
    const refresh = trailingRefresh;
    trailingRefresh = null;
    if (refresh) settleTrailing(refresh, 'resolve', null);
    if (flight) {
      settleLoad(flight, 'resolve', null);
      abortDepth += 1;
      try { flight.controller?.abort(); } catch (_) {
        // Cancellation is already fenced by the load epoch.
      } finally {
        abortDepth -= 1;
      }
    }
    return Boolean(flight || refresh);
  }

  function clearIdentityState(nextIdentity: string): void {
    contextEpoch += 1;
    mutationTokens.clear();
    refreshVersion = 0;
    committedVersion = -1;
    state.status = 'idle';
    state.inventory = null;
    state.error = null;
    state.stale = true;
    state.identity = nextIdentity;
    state.mutations = Object.create(null) as Record<string, true>;
    state.invalidation = null;
    cancelReadRequests();
  }

  function observeContext(): OperationContext {
    if (disposed) throw disposedError();
    const nextIdentity = identity();
    if (state.identity !== nextIdentity) clearIdentityState(nextIdentity);
    return { identity: nextIdentity, epoch: contextEpoch };
  }

  function operationInvalidation(
    context: OperationContext,
    kind: 'request' | 'operation'
  ): CacheStoreError | null {
    if (disposed) return disposedError();
    const nextIdentity = identity();
    if (nextIdentity !== context.identity) clearIdentityState(nextIdentity);
    if (context.epoch !== contextEpoch || nextIdentity !== context.identity) {
      return contextError(kind);
    }
    return null;
  }

  function loadContextCurrent(context: LoadContext): boolean {
    if (disposed || context.epoch !== contextEpoch || context.loadEpoch !== loadEpoch) return false;
    const nextIdentity = identity();
    if (nextIdentity !== context.identity) {
      clearIdentityState(nextIdentity);
      return false;
    }
    return true;
  }

  function markDirty(): number {
    refreshVersion += 1;
    return refreshVersion;
  }

  async function executeLoad(flight: LoadFlight): Promise<void> {
    if (flight.settled) return;
    try {
      const response = await dependencies.sendToServer('getCacheInventory', {}, {
        quiet: true,
        timeoutMs: READ_TIMEOUT_MS,
        signal: flight.controller && flight.controller.signal
      });
      if (!loadContextCurrent(flight) || flight.version !== refreshVersion) {
        settleLoad(flight, 'resolve', null);
        return;
      }
      ensureResponse(response, 'Failed to load cache inventory.');
      const inventory = model!.normalizeInventory(extractCacheInventory(response));
      if (!loadContextCurrent(flight) || flight.version !== refreshVersion) {
        settleLoad(flight, 'resolve', null);
        return;
      }
      state.inventory = inventory;
      state.status = 'ready';
      state.error = null;
      state.stale = false;
      state.identity = flight.identity;
      committedVersion = flight.version;
      emit('load-success');
      settleLoad(
        flight,
        'resolve',
        loadContextCurrent(flight) && flight.version === refreshVersion ? inventory : null
      );
    } catch (error) {
      let current = false;
      try {
        current = loadContextCurrent(flight);
      } catch (contextCheckError) {
        settleLoad(flight, 'reject', contextCheckError);
        return;
      }
      if (!current || flight.version !== refreshVersion) {
        settleLoad(flight, 'resolve', null);
        return;
      }
      state.status = 'error';
      state.error = error;
      state.stale = true;
      emit('load-error');
      settleLoad(flight, 'reject', error);
    } finally {
      if (currentLoad === flight) currentLoad = null;
    }
  }

  function startLoad(context: OperationContext, version: number): LoadFlight {
    const deferred = createDeferred<CacheInventoryDto | null>();
    let controller: ReturnType<CacheStoreDependencies['createAbortController']>;
    try {
      controller = dependencies.createAbortController();
    } catch (error) {
      const failedFlight: LoadFlight = {
        identity: context.identity,
        epoch: context.epoch,
        loadEpoch,
        version,
        controller: null,
        promise: deferred.promise,
        resolve: deferred.resolve,
        reject: deferred.reject,
        settled: false
      };
      settleLoad(failedFlight, 'reject', error);
      return failedFlight;
    }
    const flight: LoadFlight = {
      identity: context.identity,
      epoch: context.epoch,
      loadEpoch,
      version,
      controller,
      promise: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
      settled: false
    };
    currentLoad = flight;
    state.status = state.inventory && state.identity === context.identity
      ? 'refreshing'
      : 'loading';
    state.error = null;
    state.identity = context.identity;
    try {
      emit('load-start');
    } catch (error) {
      if (currentLoad === flight) currentLoad = null;
      settleLoad(flight, 'reject', error);
      return flight;
    }
    if (!flight.settled) void executeLoad(flight);
    return flight;
  }

  async function driveTrailingRefresh(refresh: TrailingRefresh): Promise<void> {
    try {
      while (!refresh.settled) {
        if (!loadContextCurrent(refresh)) {
          settleTrailing(refresh, 'resolve', null);
          return;
        }
        const flight = currentLoad &&
          currentLoad.identity === refresh.identity &&
          currentLoad.epoch === refresh.epoch &&
          currentLoad.loadEpoch === refresh.loadEpoch
          ? currentLoad
          : startLoad(refresh, refreshVersion);
        try {
          await flight.promise;
        } catch (error) {
          if (!loadContextCurrent(refresh)) {
            settleTrailing(refresh, 'resolve', null);
            return;
          }
          if (flight.version < refreshVersion) continue;
          settleTrailing(refresh, 'reject', error);
          return;
        }
        if (!loadContextCurrent(refresh)) {
          settleTrailing(refresh, 'resolve', null);
          return;
        }
        if (
          state.status === 'ready' &&
          !state.stale &&
          committedVersion === refreshVersion
        ) {
          settleTrailing(refresh, 'resolve', state.inventory);
          return;
        }
      }
    } catch (error) {
      settleTrailing(refresh, 'reject', error);
    } finally {
      if (trailingRefresh === refresh) trailingRefresh = null;
    }
  }

  function ensureTrailingRefresh(context: OperationContext): Promise<CacheInventoryDto | null> {
    if (abortDepth > 0) return Promise.resolve(null);
    if (
      trailingRefresh &&
      trailingRefresh.identity === context.identity &&
      trailingRefresh.epoch === context.epoch &&
      trailingRefresh.loadEpoch === loadEpoch
    ) {
      return trailingRefresh.promise;
    }
    const deferred = createDeferred<CacheInventoryDto | null>();
    const refresh: TrailingRefresh = {
      identity: context.identity,
      epoch: context.epoch,
      loadEpoch,
      promise: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
      settled: false
    };
    trailingRefresh = refresh;
    void driveTrailingRefresh(refresh);
    return refresh.promise;
  }

  function load(loadOptions?: CacheStoreLoadOptionsDto | null): Promise<CacheInventoryDto | null> {
    if (disposed) return Promise.reject(disposedError());
    if (abortDepth > 0) return Promise.resolve(null);
    if (!model || typeof model.normalizeInventory !== 'function') {
      return Promise.reject(fail('Cache inventory model is unavailable.'));
    }
    let context: OperationContext;
    try {
      context = observeContext();
    } catch (error) {
      return Promise.reject(error);
    }
    const force = Boolean(loadOptions && loadOptions.force);
    if (force) {
      markDirty();
      return ensureTrailingRefresh(context);
    }
    if (state.status === 'ready' && !state.stale && state.identity === context.identity) {
      return Promise.resolve(state.inventory);
    }
    if (
      trailingRefresh &&
      trailingRefresh.identity === context.identity &&
      trailingRefresh.epoch === context.epoch &&
      trailingRefresh.loadEpoch === loadEpoch &&
      (!currentLoad || currentLoad.version < refreshVersion)
    ) {
      return trailingRefresh.promise;
    }
    if (
      currentLoad &&
      currentLoad.identity === context.identity &&
      currentLoad.epoch === context.epoch &&
      currentLoad.loadEpoch === loadEpoch
    ) {
      return currentLoad.promise;
    }
    return startLoad(context, refreshVersion).promise;
  }

  async function getEntry(cacheId: unknown): Promise<CacheEntryDto | null> {
    const id = String(cacheId || '').trim();
    if (!id) throw fail('Cache entry id is required.', 'cache_id_required');
    const context = observeContext();
    let response: unknown;
    try {
      response = await dependencies.sendToServer('getCacheEntry', { cacheId: id }, {
        quiet: true,
        timeoutMs: READ_TIMEOUT_MS
      });
    } catch (error) {
      const invalidation = operationInvalidation(context, 'request');
      if (invalidation) throw invalidation;
      throw error;
    }
    const invalidation = operationInvalidation(context, 'request');
    if (invalidation) throw invalidation;
    ensureResponse(response, 'Failed to load cache details.');
    const entry = extractCacheEntry(response);
    if (!entry) return null;
    return model!.normalizeEntry(entry);
  }

  function mutationKey(kind: string, id: unknown): string {
    return kind + ':' + String(id || 'owner');
  }

  function beginMutation(key: string, context: OperationContext): MutationToken {
    const invalidation = operationInvalidation(context, 'operation');
    if (invalidation) throw invalidation;
    if (mutationTokens.has(key)) {
      throw fail('This cache operation is already running.', 'cache_mutation_in_progress');
    }
    const token: MutationToken = { ...context, key, value: Symbol(key) };
    mutationTokens.set(key, token);
    state.mutations[key] = true;
    try {
      emit('mutation-start');
    } catch (error) {
      if (mutationTokens.get(key) === token) {
        mutationTokens.delete(key);
        delete state.mutations[key];
      }
      throw error;
    }
    const afterEmitInvalidation = operationInvalidation(context, 'operation');
    if (afterEmitInvalidation || mutationTokens.get(key) !== token) {
      if (mutationTokens.get(key) === token) {
        mutationTokens.delete(key);
        delete state.mutations[key];
      }
      throw afterEmitInvalidation || contextError('operation');
    }
    return token;
  }

  function finishMutation(token: MutationToken): void {
    if (
      disposed ||
      token.epoch !== contextEpoch ||
      mutationTokens.get(token.key) !== token
    ) return;
    mutationTokens.delete(token.key);
    delete state.mutations[token.key];
    emit('mutation-end');
  }

  async function refreshAfterMutationFailure(
    error: unknown,
    context: OperationContext
  ): Promise<never> {
    const invalidation = operationInvalidation(context, 'operation');
    if (invalidation) throw invalidation;
    state.stale = true;
    try { await load({ force: true }); } catch (_) {}
    const afterRefreshInvalidation = operationInvalidation(context, 'operation');
    if (afterRefreshInvalidation) throw afterRefreshInvalidation;
    throw error;
  }

  async function mutate<Action extends Extract<
    CacheStoreActionDto,
    'deleteCacheEntry' | 'clearCacheScope'
  >> (
    action: Action,
    key: string,
    payload: CacheStoreRequestMap[Action],
    fallback: string,
    context: OperationContext
  ): Promise<unknown> {
    const token = beginMutation(key, context);
    try {
      let response: unknown;
      try {
        response = await dependencies.sendToServer(action, payload, {
          quiet: true,
          timeoutMs: MUTATION_TIMEOUT_MS
        });
      } catch (error) {
        return await refreshAfterMutationFailure(error, context);
      }
      const invalidation = operationInvalidation(context, 'operation');
      if (invalidation) throw invalidation;
      try {
        ensureResponse(response, fallback);
      } catch (error) {
        return await refreshAfterMutationFailure(error, context);
      }
      state.stale = true;
      await load({ force: true });
      const afterRefreshInvalidation = operationInvalidation(context, 'operation');
      if (afterRefreshInvalidation) throw afterRefreshInvalidation;
      return response;
    } finally {
      finishMutation(token);
    }
  }

  function expectedRevision(): string {
    return state.inventory && state.inventory.revision || '';
  }

  async function deleteEntry(cacheId: unknown): Promise<unknown> {
    const id = String(cacheId || '').trim();
    if (!id) throw fail('Cache entry id is required.', 'cache_id_required');
    const context = observeContext();
    return mutate('deleteCacheEntry', mutationKey('delete', id), {
      cacheId: id,
      expectedRevision: expectedRevision()
    }, 'Failed to delete cache entry.', context);
  }

  async function clearScope(scopeRequest?: CacheStoreClearScopeRequestDto | null): Promise<unknown> {
    const request: Partial<CacheStoreClearScopeRequestDto> = scopeRequest || {};
    const scope = String(request.scope || '').trim();
    if (!['owner', 'workspace', 'shared'].includes(scope)) {
      throw fail('Cache clear scope is invalid.', 'cache_scope_invalid');
    }
    const context = observeContext();
    const payload: {
      scope: CacheStoreClearScopeDto;
      expectedRevision: string;
      workspaceId?: string;
      category?: string;
    } = {
      scope: scope as CacheStoreClearScopeDto,
      expectedRevision: expectedRevision()
    };
    if (request.workspaceId) payload.workspaceId = String(request.workspaceId);
    if (request.category && request.category !== 'all') {
      payload.category = String(request.category);
    }
    if (scope === 'workspace' && !payload.workspaceId) {
      throw fail('Workspace id is required.', 'cache_workspace_required');
    }
    return mutate(
      'clearCacheScope',
      mutationKey(
        'clear',
        scope + ':' + (payload.workspaceId || '') + ':' + (payload.category || 'all')
      ),
      payload,
      'Failed to clear cache.',
      context
    );
  }

  function invalidate(detail?: CacheStoreInvalidationDto): void {
    if (disposed) return;
    let context: OperationContext;
    try {
      context = observeContext();
    } catch (_) {
      return;
    }
    markDirty();
    state.stale = true;
    state.invalidation = detail || { reason: 'external-change' };
    emit('invalidate');
    dependencies.dispatchInvalidationEvent(state.invalidation);
    if (operationInvalidation(context, 'request')) return;
    if (active || currentLoad || trailingRefresh) {
      void ensureTrailingRefresh(context).catch(() => {});
    }
  }

  function setActive(value: unknown): void {
    if (disposed) return;
    active = Boolean(value);
    if (active && state.stale) {
      void load({ force: true }).catch(() => {});
    }
    if (!active && (currentLoad || trailingRefresh)) {
      state.status = state.inventory ? 'ready' : 'idle';
      cancelReadRequests();
      emit('load-cancel');
    }
  }

  function reset(): void {
    if (disposed) return;
    contextEpoch += 1;
    mutationTokens.clear();
    refreshVersion = 0;
    committedVersion = -1;
    state.status = 'idle';
    state.inventory = null;
    state.error = null;
    state.stale = true;
    state.identity = '';
    state.mutations = Object.create(null) as Record<string, true>;
    state.invalidation = null;
    cancelReadRequests();
    emit('reset');
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    contextEpoch += 1;
    cancelReadRequests();
    mutationTokens.clear();
    state.status = 'idle';
    state.inventory = null;
    state.error = null;
    state.stale = true;
    state.identity = '';
    state.mutations = Object.create(null) as Record<string, true>;
    state.invalidation = null;
    listeners.clear();
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    subscribe,
    getState: snapshot,
    load,
    getEntry,
    deleteEntry,
    clearScope,
    invalidate,
    setActive,
    reset,
    dispose
  });
}
