// Identity-bound state and mutations for Cache Inventory v2.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;

  function extractData(response) {
    if (!response || typeof response !== 'object') return {};
    if (response.data && typeof response.data === 'object') return response.data;
    if (response.Data && typeof response.Data === 'object') return response.Data;
    return response;
  }

  function extractCacheInventory(response) {
    var data = extractData(response);
    return data.cacheInventory || response && response.cacheInventory || null;
  }

  function extractCacheEntry(response) {
    var data = extractData(response);
    return data.cacheEntry || response && response.cacheEntry || null;
  }

  function responseError(response, fallback) {
    var data = extractData(response);
    return String(response && response.error || data.error || fallback || 'Cache request failed.');
  }

  function createCacheStore(options) {
    options = options || {};
    var root = options.global || global;
    var namespace = options.BOBO || root.BOBO || {};
    var model = options.model || namespace.cacheModel;
    var listeners = new Set();
    var requestSequence = 0;
    var requestController = null;
    var active = false;
    var state = {
      status: 'idle',
      inventory: null,
      error: null,
      stale: true,
      identity: '',
      mutations: Object.create(null),
      invalidation: null
    };

    function identity() {
      var source = namespace.state || {};
      var auth = source.auth || {};
      var server = source.serverSettings || {};
      var user = auth.user || {};
      return [server.ip || '', auth.token || '', user.id || user.uid || ''].join('\n');
    }

    function snapshot() {
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

    function emit(reason) {
      var current = snapshot();
      listeners.forEach(function(listener) {
        try { listener(current, reason || 'change'); } catch (error) { console.error('cache store listener:', error); }
      });
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return function() {};
      listeners.add(listener);
      listener(snapshot(), 'subscribe');
      return function() { listeners.delete(listener); };
    }

    function fail(message, code) {
      var error = new Error(String(message || 'Cache request failed.'));
      if (code) error.code = code;
      return error;
    }

    function ensureResponse(response, fallback) {
      if (!response || response.success === false) {
        throw fail(responseError(response, fallback), response && (response.errorCode || response.error_code));
      }
      return response;
    }

    async function load(loadOptions) {
      loadOptions = loadOptions || {};
      if (!model || typeof model.normalizeInventory !== 'function') throw fail('Cache inventory model is unavailable.');
      var nextIdentity = identity();
      if (!loadOptions.force && state.status === 'ready' && !state.stale && state.identity === nextIdentity) return state.inventory;

      requestSequence += 1;
      var sequence = requestSequence;
      if (requestController) requestController.abort();
      requestController = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      state.status = state.inventory && state.identity === nextIdentity ? 'refreshing' : 'loading';
      state.error = null;
      state.identity = nextIdentity;
      emit('load-start');

      try {
        var response = await namespace.sendToServer('getCacheInventory', {}, {
          quiet: true,
          timeoutMs: 20000,
          signal: requestController && requestController.signal
        });
        if (sequence !== requestSequence || nextIdentity !== identity()) return null;
        ensureResponse(response, 'Failed to load cache inventory.');
        var inventory = model.normalizeInventory(extractCacheInventory(response));
        state.inventory = inventory;
        state.status = 'ready';
        state.error = null;
        state.stale = false;
        state.identity = nextIdentity;
        emit('load-success');
        return inventory;
      } catch (error) {
        if (sequence !== requestSequence || nextIdentity !== identity()) return null;
        state.status = 'error';
        state.error = error;
        state.stale = true;
        emit('load-error');
        throw error;
      } finally {
        if (sequence === requestSequence) requestController = null;
      }
    }

    async function getEntry(cacheId) {
      var id = String(cacheId || '').trim();
      if (!id) throw fail('Cache entry id is required.', 'cache_id_required');
      var requestIdentity = identity();
      var response = await namespace.sendToServer('getCacheEntry', { cacheId: id }, { quiet: true, timeoutMs: 20000 });
      if (requestIdentity !== identity()) throw fail('The server or account changed during the cache request.', 'cache_context_changed');
      ensureResponse(response, 'Failed to load cache details.');
      var entry = extractCacheEntry(response);
      return entry && model.normalizeEntry(entry);
    }

    function mutationKey(kind, id) {
      return kind + ':' + String(id || 'owner');
    }

    function setMutation(key, pending) {
      if (pending) state.mutations[key] = true;
      else delete state.mutations[key];
      emit(pending ? 'mutation-start' : 'mutation-end');
    }

    async function mutate(action, key, payload, fallback) {
      if (state.mutations[key]) throw fail('This cache operation is already running.', 'cache_mutation_in_progress');
      var requestIdentity = identity();
      setMutation(key, true);
      try {
        var response = await namespace.sendToServer(action, payload, { quiet: true, timeoutMs: 30000 });
        if (requestIdentity !== identity()) throw fail('The server or account changed during the cache operation.', 'cache_context_changed');
        ensureResponse(response, fallback);
        state.stale = true;
        await load({ force: true });
        return response;
      } catch (error) {
        state.stale = true;
        try { await load({ force: true }); } catch (_) {}
        throw error;
      } finally {
        setMutation(key, false);
      }
    }

    function expectedRevision() {
      return state.inventory && state.inventory.revision || '';
    }

    async function deleteEntry(cacheId) {
      var id = String(cacheId || '').trim();
      if (!id) throw fail('Cache entry id is required.', 'cache_id_required');
      return mutate('deleteCacheEntry', mutationKey('delete', id), {
        cacheId: id,
        expectedRevision: expectedRevision()
      }, 'Failed to delete cache entry.');
    }

    async function clearScope(scopeRequest) {
      scopeRequest = scopeRequest || {};
      var scope = String(scopeRequest.scope || '').trim();
      if (['owner', 'workspace', 'shared'].indexOf(scope) < 0) throw fail('Cache clear scope is invalid.', 'cache_scope_invalid');
      var payload = {
        scope: scope,
        expectedRevision: expectedRevision()
      };
      if (scopeRequest.workspaceId) payload.workspaceId = String(scopeRequest.workspaceId);
      if (scopeRequest.category && scopeRequest.category !== 'all') payload.category = String(scopeRequest.category);
      if (scope === 'workspace' && !payload.workspaceId) throw fail('Workspace id is required.', 'cache_workspace_required');
      return mutate('clearCacheScope', mutationKey('clear', scope + ':' + (payload.workspaceId || '') + ':' + (payload.category || 'all')), payload, 'Failed to clear cache.');
    }

    function invalidate(detail) {
      state.stale = true;
      state.invalidation = detail || { reason: 'external-change' };
      emit('invalidate');
      if (root.dispatchEvent && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('bobo:cache-changed', { detail: state.invalidation }));
      }
      if (active) load({ force: true }).catch(function() {});
    }

    function setActive(value) {
      active = Boolean(value);
      if (active && state.stale) load({ force: true }).catch(function() {});
      if (!active && requestController && (state.status === 'loading' || state.status === 'refreshing')) {
        requestSequence += 1;
        requestController.abort();
        requestController = null;
        state.status = state.inventory ? 'ready' : 'idle';
        emit('load-cancel');
      }
    }

    function reset() {
      requestSequence += 1;
      if (requestController) requestController.abort();
      requestController = null;
      state.status = 'idle';
      state.inventory = null;
      state.error = null;
      state.stale = true;
      state.identity = '';
      state.mutations = Object.create(null);
      state.invalidation = null;
      emit('reset');
    }

    return {
      subscribe: subscribe,
      getState: snapshot,
      load: load,
      getEntry: getEntry,
      deleteEntry: deleteEntry,
      clearScope: clearScope,
      invalidate: invalidate,
      setActive: setActive,
      reset: reset
    };
  }

  var api = {
    createCacheStore: createCacheStore,
    extractData: extractData,
    extractCacheInventory: extractCacheInventory,
    extractCacheEntry: extractCacheEntry
  };
  BOBO.cacheStoreFactory = api;
  BOBO.cacheStore = createCacheStore({ global: global, BOBO: BOBO, model: BOBO.cacheModel });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
