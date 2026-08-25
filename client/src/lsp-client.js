// Thin Monaco <-> remote LSP adapter. Transport and credentials stay in the
// Electron main process; this layer only handles editor state and URI mapping.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var monacoRef = null;
  var settings = {
    mode: 'local',
    clientCacheMode: 'lazy',
    clientCacheSizeMiB: 32,
    clientCacheDependencyIndexEnabled: false
  };
  var status = { state: 'local', mode: 'local', bytesSent: 0, bytesReceived: 0, latencyMs: null, cache: null };
  var clientCacheUi = { state: 'loading', stats: null, error: '', operation: '' };
  var disposables = [];
  var openedDocuments = new Map();
  var changeQueues = new Map();
  var configureTimer = null;
  var configureGeneration = 0;
  var requestSequence = 1;
  var completionContextGeneration = 0;
  var completionHintPrewarmTimer = null;
  var activeLanguage = '';
  var lastConfigSignature = '';
  var auxiliaryModels = new Map();
  var pendingCacheClear = null;
  var restartButtonTimer = null;
  var dependencyRefreshCoordinator = null;
  var capabilityReconnectCoordinator = null;
  var indexStatus = '';
  var fallbackSupportedLanguages = ['c', 'cpp', 'java', 'go', 'rust', 'python', 'javascript', 'typescript'];
  var supportedLanguages = fallbackSupportedLanguages.slice();
  var LEGACY_CAPABILITY_CACHE_TTL_MS = 30000;
  var legacyCapabilityCache = { key: '', expiresAt: 0, languages: null, promise: null };
  var registeredProviderLanguages = Object.create(null);
  var registeredCompletionProviders = Object.create(null);
  var globalProvidersRegistered = false;
  // Capabilities returned by the LSP initialize response. This is independent
  // from the BOBO serverInfo feature descriptor in S.serverCapabilities.
  var lspProtocolCapabilities = {};
  var remoteTransportActive = false;
  var documentSyncGeneration = 0;
  var documentSyncQueue = createDocumentSyncQueue();
  var completionCoordinator = createRemoteCompletionCoordinator({ cancel: cancelRequestKey });
  var completionHintCache = createCompletionHintCache();
  var dependencyApiIndexCache = createDependencyApiIndexCache();
  var dependencyApiIndexUi = { state: 'disabled', error: '' };
  var dependencyApiIndexBuilds = new Map();
  var dependencyApiIndexSequence = 1;

  // Completion responses are asynchronous. Any identity or analysis-context
  // boundary must invalidate both cache tiers before a late response can be
  // replayed or persisted under the next context.
  function invalidateCompletionContext() {
    completionContextGeneration += 1;
    if (completionHintPrewarmTimer) {
      clearTimeout(completionHintPrewarmTimer);
      completionHintPrewarmTimer = null;
    }
    completionCoordinator.clear();
    completionHintCache.clear();
    dependencyApiIndexCache.clear();
    cancelDependencyApiIndexBuilds();
  }

  // A dependency tree is tied to one gateway session. Keep a warm, already
  // verified summary across a reconnect when its revision still matches, but
  // never leave its in-flight page request owned by a closed WebSocket.
  function cancelDependencyApiIndexBuilds() {
    dependencyApiIndexBuilds.forEach(function(build) {
      build.cancelled = true;
      if (build.timer) clearTimeout(build.timer);
    });
    dependencyApiIndexBuilds.clear();
    // A closed transport must not let an old disk-read promise block a new
    // session using the same logical scope. Keep already verified summaries
    // warm; only invalidate in-flight ownership.
    dependencyApiIndexCache.cancelPending();
  }

  function t(source, replacements) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(source, replacements) : source;
  }

  function lspFeatureDecision(language) {
    if (BOBO.cloudFeaturePolicy && typeof BOBO.cloudFeaturePolicy.evaluate === 'function') {
      return BOBO.cloudFeaturePolicy.evaluate('lsp', language ? { language: language } : undefined);
    }
    return { feature: 'lsp', available: false, state: 'unknown', reason: 'policy_unavailable' };
  }

  function lspUnavailableText(decision, language) {
    if (decision && decision.reason === 'unsupported_language' && language) {
      return t('Remote analysis is not available for {language}', {
        language: BOBO.langDisplayName ? BOBO.langDisplayName(language) : language
      });
    }
    return t('Remote analysis is unavailable on this server.');
  }

  function activeLspDecision() {
    var model = currentModel();
    var language = activeLanguage || (model && model.getLanguageId ? model.getLanguageId() : '');
    var decision = lspFeatureDecision(language);
    if (decision.state === 'legacy' && language && supportedLanguages.indexOf(language) < 0) {
      return { feature: 'lsp', available: false, state: 'legacy', reason: 'unsupported_language', language: language };
    }
    return decision;
  }

  function createDependencyRefreshCoordinator(options) {
    var config = options || {};
    var setTimer = config.setTimer || setTimeout;
    var clearTimer = config.clearTimer || clearTimeout;
    var timeoutMs = config.timeoutMs === undefined ? 15000 : Math.max(0, Number(config.timeoutMs) || 0);
    var retryDelayMs = config.retryDelayMs === undefined ? 250 : Math.max(0, Number(config.retryDelayMs) || 0);
    var pending = null;

    function settle(success, error) {
      if (!pending) return false;
      var current = pending;
      pending = null;
      if (current.timer) clearTimer(current.timer);
      if (current.retryTimer) clearTimer(current.retryTimer);
      if (error && config.onError) config.onError(error);
      current.resolve(success === true);
      return true;
    }

    function canSend() {
      try { return !config.canSend || config.canSend() === true; } catch (_) { return false; }
    }

    function retryLater(current) {
      if (!pending || pending !== current || current.retryTimer) return;
      current.retryTimer = setTimer(function() {
        current.retryTimer = null;
        attempt(current);
      }, retryDelayMs);
    }

    function attempt(current) {
      if (!pending || pending !== current || current.sending || !canSend()) return false;
      current.sending = true;
      try {
        Promise.resolve(current.send()).then(function(sent) {
          current.sending = false;
          if (!pending || pending !== current) return;
          if (sent === false) {
            current.lastError = new Error(t('Remote analysis is not ready'));
            retryLater(current);
          }
        }, function(error) {
          current.sending = false;
          if (!pending || pending !== current) return;
          current.lastError = error;
          retryLater(current);
        });
      } catch (error) {
        current.sending = false;
        current.lastError = error;
        retryLater(current);
      }
      return true;
    }

    function request(send, key) {
      key = String(key || '');
      if (pending && pending.key === key) return pending.promise;
      if (pending) settle(false);
      var resolvePromise;
      var promise = new Promise(function(resolve) { resolvePromise = resolve; });
      var current = {
        promise: promise,
        resolve: resolvePromise,
        timer: null,
        retryTimer: null,
        send: send,
        sending: false,
        lastError: null,
        key: key
      };
      pending = current;
      current.timer = setTimer(function() { settle(false, current.lastError); }, timeoutMs);
      attempt(current);
      return promise;
    }

    return {
      request: request,
      settle: settle,
      notifyReady: function(key) {
        if (!pending) return false;
        if (pending.key && String(key || '') !== pending.key) return settle(false);
        if (pending.retryTimer) {
          clearTimer(pending.retryTimer);
          pending.retryTimer = null;
        }
        return attempt(pending);
      },
      isPending: function() { return !!pending; },
      activeKey: function() { return pending ? pending.key : ''; }
    };
  }

  function createCapabilityReconnectCoordinator(options) {
    var config = options || {};
    var active = null;

    function currentIdentity() {
      try { return String(config.identity ? config.identity() : ''); } catch (_) { return ''; }
    }

    function reportError(error) {
      if (!config.onError) return;
      try { config.onError(error); } catch (_) {}
    }

    function handle(previousState, nextState) {
      if (previousState !== 'ready' || ['disconnected', 'error'].indexOf(nextState) < 0) {
        return Promise.resolve({ handled: false });
      }
      var key = currentIdentity();
      if (!key) return Promise.resolve({ handled: false, stale: true });
      if (active && active.key === key) return active.promise;

      var record = { key: key, promise: null };
      var pending = Promise.resolve().then(function() {
        if (!config.stop) return true;
        try {
          return Promise.resolve(config.stop()).then(function() { return true; }, function(error) {
            reportError(error);
            return false;
          });
        } catch (error) {
          reportError(error);
          return false;
        }
      }).then(function(stopped) {
        if (!stopped) return { handled: true, reconnected: false, reason: 'stop_failed' };
        if (active !== record || currentIdentity() !== key) {
          return { handled: true, reconnected: false, stale: true };
        }
        if (!config.refresh) return null;
        try {
          return Promise.resolve(config.refresh()).catch(function(error) {
            reportError(error);
            return { success: false, reason: 'probe_failed' };
          });
        } catch (error) {
          reportError(error);
          return { success: false, reason: 'probe_failed' };
        }
      }).then(function(refreshResult) {
        if (refreshResult && refreshResult.reason === 'stop_failed') return refreshResult;
        if (active !== record || currentIdentity() !== key) {
          return { handled: true, reconnected: false, stale: true };
        }
        if (!config.reconnect) return { handled: true, reconnected: false };
        try {
          return Promise.resolve(config.reconnect(refreshResult)).then(function(reconnected) {
            return { handled: true, reconnected: reconnected !== false, refresh: refreshResult || null };
          });
        } catch (error) {
          reportError(error);
          return { handled: true, reconnected: false, reason: 'reconnect_failed' };
        }
      }).catch(function(error) {
        reportError(error);
        return { handled: true, reconnected: false, reason: 'reconnect_failed' };
      }).finally(function() {
        if (active === record) active = null;
      });
      record.promise = pending;
      active = record;
      return pending;
    }

    return {
      handle: handle,
      isActive: function() { return !!active; },
      activeIdentity: function() { return active ? active.key : ''; }
    };
  }

  function createDocumentSyncQueue() {
    var epoch = 0;
    var chains = new Map();

    function enqueue(uri, task) {
      if (!uri || typeof task !== 'function') return Promise.resolve(false);
      var taskEpoch = epoch;
      var previous = chains.get(uri) || Promise.resolve(true);
      var next = previous.catch(function() { return false; }).then(function(previousSucceeded) {
        if (taskEpoch !== epoch) return false;
        if (previousSucceeded === false) return false;
        return task();
      });
      chains.set(uri, next);
      var cleanup = function() {
        if (chains.get(uri) === next) chains.delete(uri);
      };
      next.then(cleanup, cleanup);
      return next;
    }

    return {
      enqueue: enqueue,
      wait: function(uri) { return chains.get(uri) || Promise.resolve(true); },
      reset: function() { epoch += 1; chains.clear(); },
      has: function(uri) { return chains.has(uri); }
    };
  }

  // This is deliberately a renderer-memory mirror, not another Monaco
  // completion provider. A provider must be able to return immediately; disk
  // cache hydration happens in the background and only primes this map.
  function createCompletionHintCache() {
    var entries = new Map();
    var pending = new Map();
    var epoch = 0;
    var totalBytes = 0;
    var maxEntries = 512;
    var maxBytes = 2 * 1024 * 1024;

    function entryId(scope, key) {
      return String(scope || '') + ':' + String(key || '');
    }

    function clone(value) {
      if (!value) return value;
      try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
    }

    function compactText(value, limit) {
      var text = value === undefined || value === null ? '' : String(value);
      return text.replace(/[\0\r\n]/g, ' ').slice(0, limit);
    }

    function compactValue(value) {
      var source = Array.isArray(value) ? { items: value } : value;
      if (!source || source.isIncomplete === true || !Array.isArray(source.items)) return null;
      var items = [];
      for (var index = 0; index < source.items.length && items.length < 50; index += 1) {
        var item = source.items[index];
        // Hints are replayed against Monaco's current word range. LSP textEdit
        // ranges may replace more than that range, so preserve those only in
        // the authoritative remote response.
        if (!item || item.textEdit || item.additionalTextEdits || item.command || item.data) continue;
        var rawLabel = completionItemLabel(item);
        var label = compactText(rawLabel, 320);
        if (!label) continue;
        var insertText = typeof item.insertText === 'string'
          ? item.insertText
          : rawLabel;
        // Do not turn a multiline completion into a different single-line
        // edit. Both hot and durable tiers must share this safety boundary.
        if (!insertText || /[\0\r\n]/.test(insertText)) continue;
        var candidate = {
          label: label,
          kind: Math.max(1, Math.min(25, Math.floor(Number(item.kind) || 1))),
          insertText: compactText(insertText, 1200),
          detail: compactText(item.detail, 500),
          filterText: compactText(item.filterText || label, 320),
          sortText: compactText(item.sortText || label, 320)
        };
        if (!candidate.insertText) continue;
        if (Number(item.insertTextFormat) === 2) candidate.insertTextFormat = 2;
        if (Array.isArray(item.commitCharacters)) {
          var commits = item.commitCharacters.map(function(character) {
            return /[\0\r\n]/.test(String(character || '')) ? '' : compactText(character, 2);
          })
            .filter(function(character, commitIndex, all) { return character.length === 1 && all.indexOf(character) === commitIndex; })
            .slice(0, 16);
          if (commits.length) candidate.commitCharacters = commits;
        }
        items.push(candidate);
        if (JSON.stringify({ items: items }).length > 24 * 1024) {
          items.pop();
          break;
        }
      }
      return items.length ? { items: items } : null;
    }

    function entryBytes(value) {
      try { return JSON.stringify(value).length; } catch (_) { return 0; }
    }

    function evict() {
      while (entries.size > maxEntries || totalBytes > maxBytes) {
        var oldest = entries.entries().next().value;
        if (!oldest) break;
        entries.delete(oldest[0]);
        totalBytes -= oldest[1].bytes || 0;
      }
      if (totalBytes < 0) totalBytes = 0;
    }

    function configure(policy) {
      var mode = String(policy && policy.mode || 'lazy').toLowerCase();
      var sizeMiB = Math.max(1, Math.min(1024, Math.floor(Number(policy && policy.sizeMiB) || 32)));
      // Disk capacity is user-configurable up to 1 GiB. The renderer mirror
      // remains deliberately smaller so a large local cache never turns into
      // unbounded Electron heap growth.
      maxBytes = mode === 'off'
        ? 0
        : Math.min(32 * 1024 * 1024, Math.max(512 * 1024, Math.floor(sizeMiB * 1024 * 1024 / 8)));
      maxEntries = mode === 'off'
        ? 0
        : Math.min(4096, Math.max(128, Math.floor(maxBytes / 4096)));
      evict();
    }

    return {
      peek: function(scope, key) {
        var id = entryId(scope, key);
        var entry = entries.get(id);
        if (entry) {
          entries.delete(id);
          entries.set(id, entry);
        }
        return entry ? clone(entry.value) : null;
      },
      source: function(scope, key) {
        var entry = entries.get(entryId(scope, key));
        return entry ? entry.source : '';
      },
      prime: function(scope, key, value, source) {
        if (!scope || !key || !value) return false;
        var id = entryId(scope, key);
        var existing = entries.get(id);
        // A live answer is newer than an IPC/disk hydrate that completed late.
        if (existing && existing.source === 'live' && source !== 'live') return false;
        var compact = compactValue(value);
        if (!compact) return false;
        var bytes = entryBytes(compact);
        if (bytes <= 0 || bytes > 24 * 1024) return false;
        if (existing) totalBytes -= existing.bytes || 0;
        entries.delete(id);
        entries.set(id, { value: compact, source: source || 'memory', bytes: bytes });
        totalBytes += bytes;
        evict();
        return true;
      },
      hasPending: function(scope, key) { return pending.has(entryId(scope, key)); },
      begin: function(scope, key, promise) {
        var id = entryId(scope, key);
        if (pending.has(id)) return pending.get(id);
        var task = Promise.resolve(promise).finally(function() { pending.delete(id); });
        pending.set(id, task);
        return task;
      },
      clear: function() { epoch += 1; totalBytes = 0; entries.clear(); pending.clear(); },
      removeScope: function(scope) {
        var prefix = String(scope || '') + ':';
        entries.forEach(function(entry, id) {
          if (id.indexOf(prefix) !== 0) return;
          totalBytes -= entry.bytes || 0;
          entries.delete(id);
        });
        pending.forEach(function(_entry, id) { if (id.indexOf(prefix) === 0) pending.delete(id); });
        epoch += 1;
        if (totalBytes < 0) totalBytes = 0;
      },
      configure: configure,
      size: function() { return entries.size; },
      epoch: function() { return epoch; },
      isCurrent: function(value) { return value === epoch; }
    };
  }

  // API summaries are a separate cache type from completion hints. They are
  // keyed by the server-derived dependency revision, have a small renderer
  // mirror, and contain only module names plus public identifiers. In
  // particular, they never retain source text, paths, edits or diagnostics.
  function createDependencyApiIndexCache() {
    var entries = new Map();
    var pending = new Map();
    var totalBytes = 0;
    var maxBytes = 0;
    var maxEntries = 0;
    var epoch = 0;

    function entryId(scopeId, key) {
      return String(scopeId || '') + ':' + String(key || '');
    }

    function clone(value) {
      if (!value) return null;
      try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
    }

    function bytes(value) {
      try { return JSON.stringify(value).length; } catch (_) { return 0; }
    }

    function evict() {
      while (entries.size > maxEntries || totalBytes > maxBytes) {
        var oldest = entries.entries().next().value;
        if (!oldest) break;
        entries.delete(oldest[0]);
        totalBytes -= oldest[1].bytes || 0;
      }
      if (totalBytes < 0) totalBytes = 0;
    }

    return {
      configure: function(policy) {
        var enabled = policy && policy.enabled === true;
        var sizeMiB = Math.max(1, Math.min(1024, Math.floor(Number(policy && policy.sizeMiB) || 32)));
        // Keep at most 8 MiB of already-sanitized summaries in Electron. The
        // durable layer has a larger, separately enforced quota.
        maxBytes = enabled ? Math.min(8 * 1024 * 1024, Math.floor(sizeMiB * 1024 * 1024 * 0.25)) : 0;
        maxEntries = enabled ? Math.max(1, Math.min(8, Math.floor(maxBytes / (256 * 1024)) || 1)) : 0;
        evict();
      },
      peek: function(scopeId, key) {
        var id = entryId(scopeId, key);
        var entry = entries.get(id);
        if (!entry) return null;
        entries.delete(id);
        entries.set(id, entry);
        return clone(entry.value);
      },
      prime: function(scopeId, key, value) {
        if (!scopeId || !key || !value) return false;
        var size = bytes(value);
        if (size <= 0 || size > maxBytes) return false;
        var id = entryId(scopeId, key);
        var previous = entries.get(id);
        if (previous) totalBytes -= previous.bytes || 0;
        entries.delete(id);
        entries.set(id, { value: clone(value), bytes: size });
        totalBytes += size;
        evict();
        return entries.has(id);
      },
      hasPending: function(scopeId, key) { return pending.has(entryId(scopeId, key)); },
      begin: function(scopeId, key, promise) {
        var id = entryId(scopeId, key);
        if (pending.has(id)) return pending.get(id);
        // Store the task before executing a loader. This makes coalescing
        // reliable even if a cache API implementation re-enters synchronously.
        var task = Promise.resolve().then(function() {
          return typeof promise === 'function' ? promise() : promise;
        }).finally(function() {
          if (pending.get(id) === task) pending.delete(id);
        });
        pending.set(id, task);
        return task;
      },
      cancelPending: function() { epoch += 1; pending.clear(); },
      clear: function() { epoch += 1; totalBytes = 0; entries.clear(); pending.clear(); },
      epoch: function() { return epoch; },
      isCurrent: function(value) { return value === epoch; }
    };
  }

  function stableCompletionHash(value) {
    var input = String(value || '');
    var first = 0x811c9dc5;
    var second = 0x01000193;
    for (var index = 0; index < input.length; index += 1) {
      var code = input.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 0x01000193) >>> 0;
      second ^= code + index;
      second = Math.imul(second, 0x85ebca6b) >>> 0;
    }
    return 'cc1_' + first.toString(36) + '_' + second.toString(36);
  }

  function completionValueFingerprint(value) {
    var items = Array.isArray(value) ? value : (value && value.items) || [];
    return stableCompletionHash(items.slice(0, 50).map(function(item) {
      return [completionItemLabel(item), item && item.kind, item && item.insertText, item && item.filterText, item && item.sortText].join('\u001f');
    }).join('\u001e'));
  }

  function completionItemLabel(item) {
    if (!item) return '';
    if (typeof item.label === 'string') return item.label;
    return item.label && typeof item.label.label === 'string' ? item.label.label : '';
  }

  function textEditMatchesWordRange(edit, wordRange) {
    if (!edit || !edit.range || edit.insert || edit.replace || !wordRange) return false;
    var range = edit.range;
    if (!range.start || !range.end) return false;
    return Number(range.start.line) === Number(wordRange.startLineNumber) - 1 &&
      Number(range.start.character) === Number(wordRange.startColumn) - 1 &&
      Number(range.end.line) === Number(wordRange.endLineNumber) - 1 &&
      Number(range.end.character) === Number(wordRange.endColumn) - 1;
  }

  // LSP textEdit ranges are normally not safe to replay from a cache. The one
  // exception is a verified, single-line edit that replaces exactly Monaco's
  // current word range. Normalize only that narrow form before it reaches the
  // hot or durable cache; all other edits stay remote-only.
  function normalizeCacheableCompletionResult(value, model, position) {
    var source = Array.isArray(value) ? { items: value } : value;
    if (!source || source.isIncomplete === true || !Array.isArray(source.items) || !model || !position) return null;
    var word = model.getWordUntilPosition ? model.getWordUntilPosition(position) : null;
    if (!word) return null;
    var wordRange = {
      startLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endLineNumber: position.lineNumber,
      endColumn: word.endColumn
    };
    var items = [];
    source.items.forEach(function(item) {
      if (!item || item.additionalTextEdits || item.command || item.data) return;
      var normalized = item;
      if (item.textEdit) {
        if (!textEditMatchesWordRange(item.textEdit, wordRange) || typeof item.textEdit.newText !== 'string' ||
          !item.textEdit.newText || /[\0\r\n]/.test(item.textEdit.newText)) return;
        normalized = Object.assign({}, item, { insertText: item.textEdit.newText });
        delete normalized.textEdit;
      }
      items.push(normalized);
    });
    return items.length ? { items: items } : null;
  }

  function createRemoteCompletionCoordinator(options) {
    var config = options || {};
    var states = new Map();
    var sequence = 0;
    var skipped = {};

    function isValid(args) {
      if (!args || typeof args.isValid !== 'function') return true;
      try { return args.isValid() !== false; } catch (_) { return false; }
    }

    function cancelRun(run) {
      if (!run || run.cancelled) return;
      run.cancelled = true;
      if (run.requestKey && typeof config.cancel === 'function') {
        try { config.cancel(run.requestKey); } catch (_) {}
      }
    }

    function isCurrent(uri, state, run) {
      return states.get(uri) === state && state.generation === run.generation && state.inFlight === run && !run.cancelled;
    }

    function finish(uri, state, run) {
      if (isCurrent(uri, state, run)) state.inFlight = null;
    }

    function readOrRefresh(args) {
      if (!args || !args.uri || !args.key || typeof args.load !== 'function' || !isValid(args)) return null;
      var state = states.get(args.uri);
      if (!state) {
        state = { generation: 0, cache: null, inFlight: null };
        states.set(args.uri, state);
      }
      if (state.cache && state.cache.key === args.key) {
        var cachedContextKey = String(args.requestContextKey || '');
        if (state.cache.requestContextKey === cachedContextKey) return state.cache.value;
        if (state.cache.allowCrossContextOnce) {
          state.cache.allowCrossContextOnce = false;
          return state.cache.value;
        }
        state.cache = null;
      }
      if (state.inFlight && state.inFlight.key === args.key && state.inFlight.requestContextKey === String(args.requestContextKey || '')) {
        state.inFlight.consumer = args;
        return null;
      }

      cancelRun(state.inFlight);
      state.generation += 1;
      state.cache = null;
      var run = {
        generation: state.generation,
        key: args.key,
        requestContextKey: String(args.requestContextKey || ''),
        requestKey: (config.requestKeyPrefix || 'textDocument/completion:') + (++sequence),
        cancelled: false,
        consumer: args
      };
      state.inFlight = run;

      Promise.resolve().then(function() {
        if (!isCurrent(args.uri, state, run) || !isValid(run.consumer)) return skipped;
        return run.consumer.load(run.requestKey, function() {
          return isCurrent(args.uri, state, run) && isValid(run.consumer);
        });
      }).then(function(value) {
        var consumer = run.consumer;
        if (value === skipped || value === undefined || !isCurrent(args.uri, state, run) || !isValid(consumer)) {
          finish(args.uri, state, run);
          return;
        }
        state.inFlight = null;
        state.cache = {
          key: args.key,
          requestContextKey: run.requestContextKey,
          value: value,
          retriggered: false,
          allowCrossContextOnce: false
        };
        var hasResults = typeof consumer.hasResults === 'function' ? consumer.hasResults(value) : true;
        var hasFocus = typeof consumer.hasFocus === 'function' ? consumer.hasFocus() : true;
        if ((!hasResults && consumer.retriggerOnEmpty !== true) || !hasFocus || !isValid(consumer) || state.cache.retriggered) return;
        if (typeof consumer.shouldRetrigger === 'function') {
          try {
            if (consumer.shouldRetrigger(value) === false) return;
          } catch (_) {
            // The remote answer remains available in the session cache even if
            // a best-effort local hint write fails.
          }
        }
        state.cache.retriggered = true;
        state.cache.allowCrossContextOnce = true;
        if (typeof consumer.retrigger === 'function') {
          try { consumer.retrigger(value); } catch (_) {}
        }
      }).catch(function() {
        finish(args.uri, state, run);
      });
      return null;
    }

    function invalidate(uri) {
      var state = states.get(uri);
      if (!state) return false;
      cancelRun(state.inFlight);
      states.delete(uri);
      return true;
    }

    function read(uri, key, requestContextKey) {
      var state = states.get(uri);
      if (!state || !state.cache || state.cache.key !== key) return null;
      return state.cache.requestContextKey === String(requestContextKey || '') ? state.cache.value : null;
    }

    return {
      readOrRefresh: readOrRefresh,
      read: read,
      invalidate: invalidate,
      clear: function() {
        states.forEach(function(state) { cancelRun(state.inFlight); });
        states.clear();
      },
      matches: function(uri, key) {
        var state = states.get(uri);
        return !!(state && ((state.cache && state.cache.key === key) || (state.inFlight && state.inFlight.key === key)));
      },
      peek: function(uri) { return states.get(uri) || null; }
    };
  }

  function completionProviderCapability(capabilities) {
    var provider = capabilities && capabilities.completionProvider;
    if (provider === true) return {};
    return provider && typeof provider === 'object' && !Array.isArray(provider) ? provider : null;
  }

  function completionTriggerCharacters(capabilities) {
    var provider = completionProviderCapability(capabilities);
    var values = provider && Array.isArray(provider.triggerCharacters) ? provider.triggerCharacters : [];
    var unique = [];
    values.forEach(function(value) {
      var trigger = String(value || '');
      if (!trigger || /[\0\r\n]/.test(trigger) || Array.from(trigger).length !== 1 || unique.indexOf(trigger) >= 0) return;
      if (unique.length < 32) unique.push(trigger);
    });
    return unique;
  }

  function lspCompletionContext(context) {
    var monacoKind = Number(context && context.triggerKind);
    var triggerKind = Number.isInteger(monacoKind) && monacoKind >= 0 && monacoKind <= 2
      ? monacoKind + 1
      : 1;
    var result = { triggerKind: triggerKind };
    if (triggerKind === 2 && context && typeof context.triggerCharacter === 'string' && context.triggerCharacter) {
      result.triggerCharacter = context.triggerCharacter;
    }
    return result;
  }

  function getDependencyRefreshCoordinator() {
    if (!dependencyRefreshCoordinator) {
      dependencyRefreshCoordinator = createDependencyRefreshCoordinator({
        canSend: function() { return status.state === 'ready'; },
        onError: function(error) {
          if (BOBO.toast) BOBO.toast.error(t('Could not refresh dependencies: {message}', { message: error.message }));
        }
      });
    }
    return dependencyRefreshCoordinator;
  }

  function pathInsideRoot(filePath, rootPath) {
    var file = String(filePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var root = String(rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:/.test(root)) { file = file.toLowerCase(); root = root.toLowerCase(); }
    return file === root || file.indexOf(root + '/') === 0;
  }

  function relativePathForModel(model) {
    if (!model || !S.workspaceRoot) return '';
    var tab = (S.tabs || []).find(function(item) { return item.model === model; });
    var filePath = tab && tab.path;
    if (!filePath && model.uri && model.uri.scheme === 'file') filePath = model.uri.fsPath;
    if (!filePath || !pathInsideRoot(filePath, S.workspaceRoot)) return '';
    return String(filePath).slice(String(S.workspaceRoot).length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
  }

  function encodeWireUri(relativePath) {
    var clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    var segments = clean.split('/').filter(Boolean);
    if (!segments.length || segments.some(function(part) { return part === '.' || part === '..'; })) return '';
    return 'bobocloud-lsp:///' + segments.map(encodeURIComponent).join('/');
  }

  function decodeWireUri(uri) {
    var prefix = 'bobocloud-lsp:///';
    if (typeof uri !== 'string' || uri.indexOf(prefix) !== 0) return '';
    var encoded = uri.slice(prefix.length);
    var segments;
    try { segments = encoded.split('/').map(decodeURIComponent); } catch (_) { return ''; }
    if (!segments.length || segments.some(function(part) { return !part || part === '.' || part === '..' || /[/\\]/.test(part); })) return '';
    return segments.join('/');
  }

  function localUriFromWire(uri) {
    var relative = decodeWireUri(uri);
    if (!relative || !S.workspaceRoot || !monacoRef) return null;
    var separator = String(S.workspaceRoot).indexOf('\\') >= 0 ? '\\' : '/';
    var localPath = String(S.workspaceRoot).replace(/[/\\]+$/, '') + separator + relative.replace(/\//g, separator);
    if (!pathInsideRoot(localPath, S.workspaceRoot)) return null;
    return monacoRef.Uri.file(localPath);
  }

  function wireUriForModel(model) {
    return encodeWireUri(relativePathForModel(model));
  }

  function toLspPosition(position) {
    return { line: Math.max(0, position.lineNumber - 1), character: Math.max(0, position.column - 1) };
  }

  function fromLspRange(range) {
    if (!range || !range.start || !range.end) return null;
    return new monacoRef.Range(
      range.start.line + 1, range.start.character + 1,
      range.end.line + 1, range.end.character + 1
    );
  }

  function toLspRange(range) {
    if (!range || typeof range.startLineNumber !== 'number' || typeof range.startColumn !== 'number' ||
        typeof range.endLineNumber !== 'number' || typeof range.endColumn !== 'number') return null;
    return {
      start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
      end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn })
    };
  }

  function formattingOptionsForModel(model, requestedOptions) {
    var requested = requestedOptions && typeof requestedOptions === 'object' ? requestedOptions : {};
    var modelOptions = model && typeof model.getOptions === 'function' ? (model.getOptions() || {}) : {};
    var requestedTabSize = Number(requested.tabSize);
    var modelTabSize = Number(modelOptions.tabSize);
    var tabSize = Number.isFinite(requestedTabSize) && requestedTabSize > 0
      ? requestedTabSize
      : (Number.isFinite(modelTabSize) && modelTabSize > 0 ? modelTabSize : 4);
    var result = {
      tabSize: Math.max(1, Math.floor(tabSize)),
      insertSpaces: typeof requested.insertSpaces === 'boolean'
        ? requested.insertSpaces
        : (typeof modelOptions.insertSpaces === 'boolean' ? modelOptions.insertSpaces : true)
    };
    ['trimTrailingWhitespace', 'insertFinalNewline', 'trimFinalNewlines'].forEach(function(key) {
      if (typeof requested[key] === 'boolean') result[key] = requested[key];
    });
    return result;
  }

  function formattingParamsForModel(model, range, requestedOptions) {
    var uri = wireUriForModel(model);
    if (!uri) return null;
    var params = {
      textDocument: { uri: uri },
      options: formattingOptionsForModel(model, requestedOptions)
    };
    if (range) {
      var mappedRange = toLspRange(range);
      if (!mappedRange) return null;
      params.range = mappedRange;
    }
    return params;
  }

  function textDocumentPosition(model, position) {
    return { textDocument: { uri: wireUriForModel(model) }, position: toLspPosition(position) };
  }

  function workspaceIdentity() {
    var team = S.collaboration && S.collaboration.current;
    if (team) {
      return { kind: 'team', teamId: team.teamId, projectId: team.projectId, branch: team.branch };
    }
    if (!S.workspaceRoot) return null;
    var parts = String(S.workspaceRoot).split(/[/\\]/).filter(Boolean);
    return {
      kind: 'personal',
      folderName: parts[parts.length - 1] || 'workspace',
      folderKey: BOBO.projectKey ? BOBO.projectKey(S.workspaceRoot) : (parts[parts.length - 1] || 'workspace')
    };
  }

  function lspReconnectIdentityKey() {
    var model = currentModel();
    return JSON.stringify({
      cloud: legacyCapabilityCacheKey(),
      workspace: workspaceIdentity(),
      workspaceGeneration: Number(S.workspaceGeneration || 0),
      mode: String(settings.mode || 'local'),
      language: model && model.getLanguageId ? String(model.getLanguageId() || '') : '',
      runtime: String(S.selectedRuntime || '')
    });
  }

  function currentModel() {
    return S.editor && S.editor.getModel ? S.editor.getModel() : null;
  }

  function desiredLanguage() {
    var model = currentModel();
    if (!model) return '';
    var language = model.getLanguageId();
    var decision = lspFeatureDecision(language);
    return supportedLanguages.indexOf(language) >= 0 || (decision.state === 'compatible' && decision.available) ? language : '';
  }

  function protocolLanguageId(language) {
    var decision = lspFeatureDecision(language);
    return supportedLanguages.indexOf(language) >= 0 || (decision.state === 'compatible' && decision.available) ? language : '';
  }

  function canonicalRuntimeLanguage(language) {
    var value = String(language || '').toLowerCase();
    if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'node', 'js', 'ts'].indexOf(value) >= 0) return 'node';
    if (value === 'c++') return 'cpp';
    if (value === 'py') return 'python';
    return value;
  }

  function runtimeForLanguage(language, runtimeId) {
    var selected = String(runtimeId || '');
    if (!selected || selected === 'local') return 'local';
    var runtimeLanguage = canonicalRuntimeLanguage(selected.split(':')[0]);
    var editorLanguage = canonicalRuntimeLanguage(language);
    if (runtimeLanguage === editorLanguage || (runtimeLanguage === 'c' && editorLanguage === 'cpp') || (runtimeLanguage === 'cpp' && editorLanguage === 'c')) return selected;
    return 'local';
  }

  function normalizeCapabilities(result) {
    var data = result && result.data ? result.data : result;
    var languages = data && Array.isArray(data.languages) ? data.languages : [];
    var unique = [];
    languages.forEach(function(language) {
      var value = String(language || '').trim().toLowerCase();
      if (value && unique.indexOf(value) < 0) unique.push(value);
    });
    return unique;
  }

  function legacyCapabilityCacheKey() {
    var server = S.serverSettings || {};
    var user = S.auth && S.auth.user;
    return JSON.stringify({
      ip: String(server.ip || ''),
      httpPort: Number(server.httpPort || 0),
      wsPort: Number(server.wsPort || 0),
      secureTransport: server.secureTransport === true,
      fingerprints: Array.isArray(server.certificateFingerprints)
        ? server.certificateFingerprints.map(String)
        : [String(server.certificateFingerprint || '')],
      authMode: String(S.auth && S.auth.mode || ''),
      userId: String(user && (user.id || user.username) || ''),
      authEpoch: Number(S.runIdentityEpoch || 0)
    });
  }

  function applySupportedLanguages(languages) {
    supportedLanguages = languages.slice();
    if (monacoRef) registerProviders();
    return supportedLanguages;
  }

  function invalidateLegacyCapabilityCache() {
    legacyCapabilityCache = { key: '', expiresAt: 0, languages: null, promise: null };
  }

  function refreshLegacyCapabilities() {
    var key = legacyCapabilityCacheKey();
    if (legacyCapabilityCache.key === key && legacyCapabilityCache.languages && legacyCapabilityCache.expiresAt > Date.now()) {
      return Promise.resolve(applySupportedLanguages(legacyCapabilityCache.languages));
    }
    if (legacyCapabilityCache.key === key && legacyCapabilityCache.promise) return legacyCapabilityCache.promise;

    var record = { key: key, expiresAt: 0, languages: null, promise: null };
    var pending = Promise.resolve().then(function() {
      return BOBO.sendToServer('getLSPInfo', {}, { quiet: true });
    }).then(function(result) {
      if (legacyCapabilityCache !== record) return supportedLanguages;
      var languages = normalizeCapabilities(result);
      if (result && result.success !== false && languages.length) {
        record.languages = languages.slice();
        record.expiresAt = Date.now() + LEGACY_CAPABILITY_CACHE_TTL_MS;
        return applySupportedLanguages(languages);
      }
      return supportedLanguages;
    }).catch(function() {
      return supportedLanguages;
    }).finally(function() {
      if (legacyCapabilityCache === record) record.promise = null;
    });
    record.promise = pending;
    legacyCapabilityCache = record;
    return pending;
  }

  async function refreshCapabilities() {
    var decision = lspFeatureDecision();
    if (decision.state === 'compatible') {
      invalidateLegacyCapabilityCache();
      supportedLanguages = decision.available && BOBO.cloudFeaturePolicy && typeof BOBO.cloudFeaturePolicy.languages === 'function'
        ? BOBO.cloudFeaturePolicy.languages()
        : [];
      if (monacoRef) registerProviders();
      return supportedLanguages;
    }
    if (!decision.available) {
      invalidateLegacyCapabilityCache();
      supportedLanguages = [];
      if (monacoRef) registerProviders();
      return supportedLanguages;
    }
    if (!BOBO.sendToServer || !S.serverSettings || !S.serverSettings.ip) return supportedLanguages;
    return refreshLegacyCapabilities();
  }

  function scheduleConfigure() {
    if (configureTimer) clearTimeout(configureTimer);
    configureTimer = setTimeout(configure, 120);
  }

  async function configure() {
    configureTimer = null;
    var model = currentModel();
    var editorLanguage = model && model.getLanguageId ? model.getLanguageId() : '';
    var language = desiredLanguage();
    var workspace = workspaceIdentity();
    var mode = settings.mode;
    var serviceDecision = lspFeatureDecision();
    var capabilityDecision = lspFeatureDecision(editorLanguage);
    var blockedByCapability = mode !== 'local' && !capabilityDecision.available;
    if (blockedByCapability) mode = 'local';
    if (!workspace || !language || !S.serverSettings || !S.serverSettings.ip) mode = 'local';
    var nextConfig = mode === 'local' ? { mode: 'local' } : {
      mode: mode,
      languageId: language,
      runtimeId: runtimeForLanguage(language, S.selectedRuntime),
      workspace: workspace,
      setupCommands: Array.isArray(S.setupCommands) ? S.setupCommands.slice() : []
    };
    var signature = JSON.stringify({
      server: S.serverSettings && S.serverSettings.ip || '',
      transport: nextConfig,
      capability: { state: capabilityDecision.state, reason: capabilityDecision.reason }
    });
    activeLanguage = language;
    if (signature === lastConfigSignature) {
      if (status.state === 'ready') openDocument(currentModel());
      renderStatus();
      return;
    }
    var generation = ++configureGeneration;
    lastConfigSignature = signature;
    // A configuration boundary may switch workspace, runtime or authenticated
    // analyzer state. Durable entries remain safely namespaced, while the hot
    // renderer mirror is intentionally short-lived.
    invalidateCompletionContext();
    updateCompletionCapabilities({});
    openedDocuments.clear();
    clearChangeQueues();
    clearRemoteMarkers();
    try {
      // A server that advertises LSP=false must not cause a fresh renderer IPC
      // call. A local configure is sent only when it is needed to tear down an
      // already active remote transport.
      var nextStatus = (blockedByCapability || !serviceDecision.available) && !remoteTransportActive
        ? { state: 'local', mode: 'local', bytesSent: 0, bytesReceived: 0, latencyMs: null, cache: null }
        : await global.api.lspConfigure(nextConfig);
      if (generation !== configureGeneration) return;
      remoteTransportActive = mode !== 'local';
      status = nextStatus;
      if (settings.mode !== 'local' && blockedByCapability) {
        status = Object.assign({}, status, {
          state: capabilityDecision.reason === 'unsupported_language' ? 'unsupported' : 'disabled',
          mode: 'local',
          error: lspUnavailableText(capabilityDecision, editorLanguage)
        });
      } else if (settings.mode !== 'local' && workspace && editorLanguage && !language) {
        status = Object.assign({}, status, {
          state: 'unsupported',
          mode: settings.mode,
          error: t('Remote analysis is not available for {language}', { language: BOBO.langDisplayName ? BOBO.langDisplayName(editorLanguage) : editorLanguage })
        });
      }
      S.lsp.status = status;
      if (status.state === 'ready') monacoRef.editor.getModels().forEach(openDocument);
      renderStatus();
    } catch (error) {
      if (generation !== configureGeneration) return;
      status = Object.assign({}, status, { state: 'error', error: error.message, mode: mode });
      renderStatus();
    }
  }

  function clearChangeQueues() {
    changeQueues.forEach(function(queue) { clearTimeout(queue.timer); });
    changeQueues.clear();
    documentSyncGeneration += 1;
    documentSyncQueue.reset();
    completionCoordinator.clear();
  }

  function sendNotification(method, params) {
    if (status.state !== 'ready' || !activeLspDecision().available) return Promise.resolve(false);
    return global.api.lspNotify({ method: method, params: params })
      .then(function(result) { return result !== false; })
      .catch(function() { return false; });
  }

  function openDocument(model) {
    if (!model || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return Promise.resolve(false);
    var uri = wireUriForModel(model);
    if (!uri) return Promise.resolve(false);
    if (openedDocuments.has(uri)) return documentSyncQueue.wait(uri);
    var version = model.getVersionId();
    var languageId = model.getLanguageId();
    var text = model.getValue();
    var syncGeneration = documentSyncGeneration;
    openedDocuments.set(uri, version);
    return documentSyncQueue.enqueue(uri, function() {
      return sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: uri,
          languageId: languageId,
          version: version,
          text: text
        }
      });
    }).then(function(succeeded) {
      if (succeeded === false && documentSyncGeneration === syncGeneration) openedDocuments.delete(uri);
      return succeeded !== false;
    });
  }

  function closeDocument(model) {
    var uri = wireUriForModel(model);
    if (!uri) return;
    var queue = changeQueues.get(uri);
    if (queue && queue.timer) clearTimeout(queue.timer);
    changeQueues.delete(uri);
    completionCoordinator.invalidate(uri);
    if (!openedDocuments.has(uri)) return;
    openedDocuments.delete(uri);
    documentSyncQueue.enqueue(uri, function() {
      return sendNotification('textDocument/didClose', { textDocument: { uri: uri } });
    });
    if (monacoRef) monacoRef.editor.setModelMarkers(model, 'remote-lsp', []);
    if (BOBO.editorCore && BOBO.editorCore.refreshDiagnosticsForModel) BOBO.editorCore.refreshDiagnosticsForModel(model);
  }

  function queueChanges(model, event) {
    if (!model || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return;
    var uri = wireUriForModel(model);
    if (!uri) return;
    completionCoordinator.invalidate(uri);
    if (!openedDocuments.has(uri)) {
      openDocument(model);
      return;
    }
    var queue = changeQueues.get(uri);
    if (!queue) queue = { model: model, changes: [], timer: null };
    Array.prototype.push.apply(queue.changes, (event.changes || []).map(function(change) {
      return {
        range: {
          start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
          end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 }
        },
        rangeLength: change.rangeLength,
        text: change.text
      };
    }));
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(function() { flushChanges(uri); }, 80);
    changeQueues.set(uri, queue);
  }

  function flushChanges(uri) {
    var queue = changeQueues.get(uri);
    if (!queue) return documentSyncQueue.wait(uri);
    if (queue.timer) clearTimeout(queue.timer);
    changeQueues.delete(uri);
    var version = queue.model.getVersionId();
    var syncGeneration = documentSyncGeneration;
    openedDocuments.set(uri, version);
    return documentSyncQueue.enqueue(uri, function() {
      return sendNotification('textDocument/didChange', {
        textDocument: { uri: uri, version: version },
        contentChanges: queue.changes
      });
    }).then(function(succeeded) {
      if (succeeded === false && documentSyncGeneration === syncGeneration) openedDocuments.delete(uri);
      return succeeded !== false;
    });
  }

  function ensureDocumentSynchronized(model) {
    if (!model || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return Promise.resolve(false);
    var uri = wireUriForModel(model);
    if (!uri) return Promise.resolve(false);
    openDocument(model);
    flushChanges(uri);
    return documentSyncQueue.wait(uri);
  }

  function documentSaved(model) {
    if (!model || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return;
    var uri = wireUriForModel(model);
    if (uri) ensureDocumentSynchronized(model).then(function(synchronized) {
      if (synchronized) sendNotification('textDocument/didSave', { textDocument: { uri: uri } });
    });
  }

  function cancelRequestKey(key) {
    if (!key || !global.api || typeof global.api.lspCancel !== 'function') return;
    try { Promise.resolve(global.api.lspCancel(key)).catch(function() {}); } catch (_) {}
  }

  function request(method, params, token, timeoutMs, requestKey, undefinedOnFailure) {
    if (status.state !== 'ready' || !activeLspDecision().available) return Promise.resolve(null);
    var key = requestKey || (method + ':' + requestSequence++);
    var unsubscribe = null;
    if (token && token.onCancellationRequested) {
      unsubscribe = token.onCancellationRequested(function() { cancelRequestKey(key); });
    }
    return global.api.lspRequest({ method: method, params: params, requestKey: key, timeoutMs: timeoutMs })
      .then(function(result) {
        if (result && (result.__bobocloudLspRequestState === 'cancelled' || result.__bobocloudLspRequestState === 'timedOut')) {
          return undefinedOnFailure ? undefined : null;
        }
        return result;
      })
      .catch(function() { return undefinedOnFailure ? undefined : null; })
      .finally(function() { if (unsubscribe && unsubscribe.dispose) unsubscribe.dispose(); });
  }

  function completionKind(kind) {
    var K = monacoRef.languages.CompletionItemKind;
    var map = [K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface,
      K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference,
      K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];
    return map[Math.max(1, Number(kind) || 1) - 1] || K.Text;
  }

  function markdown(value) {
    if (!value) return undefined;
    if (typeof value === 'string') return { value: value };
    return { value: value.value || '' };
  }

  function mapCompletion(item, fallbackRange, localHint) {
    var textEdit = item.textEdit && item.textEdit.newText !== undefined ? item.textEdit : null;
    var insertText = textEdit ? textEdit.newText : (typeof item.insertText === 'string' ? item.insertText : item.label);
    var mapped = {
      label: item.label,
      kind: completionKind(item.kind),
      detail: item.detail || '',
      documentation: markdown(item.documentation),
      insertText: insertText,
      insertTextRules: item.insertTextFormat === 2 ? monacoRef.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      range: textEdit && textEdit.range
        ? fromLspRange(textEdit.range)
        : (textEdit && textEdit.insert && textEdit.replace
          ? { insert: fromLspRange(textEdit.insert), replace: fromLspRange(textEdit.replace) }
          : fallbackRange),
      sortText: '0000:' + (item.sortText || item.label || ''),
      filterText: item.filterText || item.label,
      preselect: !!item.preselect,
      commitCharacters: item.commitCharacters,
      tags: item.tags,
      // Cached hints deliberately do not resolve through the remote server.
      // Their payload was reduced to an insertable candidate and has no stable
      // completion-item data to resolve after a reconnect.
      _boboLsp: localHint ? null : item
    };
    if (item.additionalTextEdits) {
      mapped.additionalTextEdits = item.additionalTextEdits.map(function(edit) {
        return { range: fromLspRange(edit.range), text: edit.newText };
      }).filter(function(edit) { return !!edit.range; });
    }
    return mapped;
  }

  function mapFormattingEdits(edits) {
    if (!Array.isArray(edits)) return [];
    return edits.map(function(edit) {
      var range = edit && fromLspRange(edit.range);
      return range && typeof edit.newText === 'string' ? { range: range, text: edit.newText } : null;
    }).filter(Boolean);
  }

  function updateCompletionCapabilities(capabilities) {
    lspProtocolCapabilities = capabilities && typeof capabilities === 'object' ? capabilities : {};
    var advertised = completionTriggerCharacters(lspProtocolCapabilities);
    Object.keys(registeredCompletionProviders).forEach(function(language) {
      var desired = status.state === 'ready' && language === activeLanguage ? advertised : [];
      installRemoteCompletionProvider(language, desired);
    });
  }

  function completionSnapshot(model, position, token) {
    var uri = wireUriForModel(model);
    if (!uri || !position) return null;
    var prefix = '';
    try { prefix = model.getLineContent(position.lineNumber).slice(0, Math.max(0, position.column - 1)); } catch (_) {}
    var snapshot = {
      uri: uri,
      model: model,
      version: model.getVersionId(),
      lineNumber: position.lineNumber,
      column: position.column,
      prefix: prefix,
      sessionId: String(status.sessionId || ''),
      contextGeneration: completionContextGeneration,
      token: token || null
    };
    snapshot.key = JSON.stringify([snapshot.contextGeneration, snapshot.sessionId, snapshot.version, snapshot.lineNumber, snapshot.column, snapshot.prefix]);
    return snapshot;
  }

  function clientCompletionCacheScope(model, requireReadyDependency) {
    var workspace = workspaceIdentity();
    var language = model && model.getLanguageId ? model.getLanguageId() : desiredLanguage();
    var dependency = status && status.dependency;
    if (!workspace || !language) return null;
    var statusLanguage = status && status.languageId;
    var sameAnalysisLanguage = !statusLanguage || canonicalRuntimeLanguage(statusLanguage) === canonicalRuntimeLanguage(language) ||
      ((canonicalRuntimeLanguage(statusLanguage) === 'c' || canonicalRuntimeLanguage(statusLanguage) === 'cpp') &&
        (canonicalRuntimeLanguage(language) === 'c' || canonicalRuntimeLanguage(language) === 'cpp'));
    if (requireReadyDependency !== false && (!dependency || !dependencyCanBackLocalCache(dependency) || !sameAnalysisLanguage)) return null;
    // Until configure() has established a new session, status describes the
    // running analyzer more accurately than the newly selected UI runtime.
    // This prevents an old analyzer response from entering the new namespace.
    var runtimeId = status && status.state === 'ready' && status.runtimeId && sameAnalysisLanguage
      ? runtimeForLanguage(language, status.runtimeId)
      : runtimeForLanguage(language, S.selectedRuntime);
    return {
      workspace: workspace,
      languageId: language,
      runtimeId: runtimeId,
      dependencyRevision: dependency && dependency.revision ? String(dependency.revision) : 'unknown'
    };
  }

  function dependencyCanBackLocalCache(dependency) {
    if (!dependency || !dependency.revision) return false;
    // `empty` is a valid, stable view for language services such as clangd
    // when there are no external packages to mount. `mixed` deliberately stays
    // out: a legacy Python package directory can span incompatible ABIs.
    return ['ready', 'empty'].indexOf(String(dependency.status || '').toLowerCase()) >= 0;
  }

  function clientCompletionCacheScopeId(scope) {
    return scope ? stableCompletionHash(JSON.stringify(scope)) : '';
  }

  function clientCompletionCacheKey(snapshot, protocolContext) {
    if (!snapshot) return '';
    // The opaque key is made in the renderer. The IPC boundary only receives
    // this digest, never a workspace path, URI or source fragment.
    return stableCompletionHash(JSON.stringify({
      schema: 2,
      mode: settings.mode,
      uri: snapshot.uri,
      language: snapshot.model && snapshot.model.getLanguageId ? snapshot.model.getLanguageId() : '',
      trigger: protocolContext || {},
      line: snapshot.lineNumber,
      column: snapshot.column,
      prefix: String(snapshot.prefix || '').slice(-384)
    }));
  }

  var dependencyApiIndexSchema = 'dependency-api-index-v1';
  var dependencyApiIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function clientCacheDependencyIndexEnabled() {
    return settings && settings.clientCacheDependencyIndexEnabled === true &&
      clientCacheMode() === 'active' && clientCacheSizeMiB() >= 30;
  }

  function dependencyApiIndexCapability() {
    var capabilities = status && status.gatewayCapabilities;
    var value = capabilities && capabilities.dependencyApiIndex;
    if (!value || value.enabled !== true || value.schema !== dependencyApiIndexSchema) return null;
    var languages = Array.isArray(value.languages) ? value.languages.map(function(language) {
      return canonicalRuntimeLanguage(language);
    }) : [];
    return languages.indexOf('python') >= 0 ? value : null;
  }

  function dependencyApiIndexScope(model) {
    var workspace = workspaceIdentity();
    var language = model && model.getLanguageId ? model.getLanguageId() : desiredLanguage();
    var dependency = status && status.dependency;
    if (!workspace || canonicalRuntimeLanguage(language) !== 'python' || status.state !== 'ready' ||
        !dependency || !dependency.revision || canonicalRuntimeLanguage(status.languageId) !== 'python') return null;
    var runtimeId = runtimeForLanguage(language, status.runtimeId || S.selectedRuntime);
    if (!runtimeId || runtimeId === 'local') return null;
    return {
      workspace: workspace,
      languageId: 'python',
      runtimeId: runtimeId,
      dependencyRevision: String(dependency.revision)
    };
  }

  function dependencyApiIndexKey(scope) {
    if (!scope) return '';
    return stableCompletionHash(JSON.stringify({
      schema: dependencyApiIndexSchema,
      languageId: scope.languageId,
      runtimeId: scope.runtimeId,
      dependencyRevision: scope.dependencyRevision
    }));
  }

  function canUseDependencyApiIndex(model) {
    return clientCacheDependencyIndexEnabled() && settings.mode !== 'local' &&
      !!dependencyApiIndexCapability() && !!dependencyApiIndexScope(model) && !!(global.api && global.api.lspClientCacheDependencyIndexGet &&
        global.api.lspClientCacheDependencyIndexPut && global.api.lspControl);
  }

  function dependencyApiIndexBuildId(scopeId, key) {
    return String(scopeId || '') + ':' + String(key || '');
  }

  function dependencyApiIndexNode(name) {
    return { name: name, kind: 'module', members: [], modules: [], _members: Object.create(null), _modules: Object.create(null) };
  }

  function dependencyApiIndexPreferredRootPrefixes(snapshot) {
    var prefix = String(snapshot && snapshot.prefix || '').slice(-512);
    var values = [];
    function append(value) {
      var root = String(value || '').split('.')[0];
      if (!dependencyApiIdentifier.test(root) || values.indexOf(root) >= 0) return;
      values.push(root);
    }
    var importMatch = /^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(prefix);
    if (importMatch) append(importMatch[1]);
    var fromMatch = /^\s*from\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(prefix);
    if (fromMatch) append(fromMatch[1]);
    var receiverMatch = /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\./.exec(prefix);
    if (receiverMatch) {
      append(receiverMatch[1]);
      append(dependencyApiIndexImportedRootForAlias(snapshot, receiverMatch[1]));
    }
    return values;
  }

  function dependencyApiIndexImportedRootForAlias(snapshot, alias) {
    if (!snapshot || !snapshot.model || !dependencyApiIdentifier.test(String(alias || ''))) return '';
    var model = snapshot.model;
    if (typeof model.getVersionId !== 'function' || model.getVersionId() !== snapshot.version ||
        typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') return '';
    // Imports must precede the cursor and stay at module scope. This mirrors
    // the completion alias boundary without requiring the partially-built
    // index to already contain the target package.
    var limit = Math.min(Math.max(0, (Number(snapshot.lineNumber) || 0) - 1), model.getLineCount(), 512);
    var target = '';
    for (var lineNumber = 1; lineNumber <= limit; lineNumber += 1) {
      var line = String(model.getLineContent(lineNumber) || '');
      if (/^[ \t]/.test(line)) continue;
      var match = /^\s*import\s+([A-Za-z_][A-Za-z0-9_\.]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/.exec(line);
      if (match && match[2] === alias) target = match[1].split('.')[0];
    }
    return target;
  }

  function dependencyApiIndexRefreshPreferredRoots(build, snapshot) {
    if (build) build.preferredRootPrefixes = dependencyApiIndexPreferredRootPrefixes(snapshot);
  }

  function dependencyApiIndexRootIsPreferred(build, root) {
    var prefixes = build && build.preferredRootPrefixes;
    return Array.isArray(prefixes) && prefixes.some(function(prefix) {
      return root.indexOf(prefix) === 0;
    });
  }

  function dependencyApiIndexMarkTruncated(build) {
    if (build) build.truncated = true;
  }

  function dependencyApiIndexDiscardRoot(build, rootName) {
    var root = build && build.roots && build.roots[rootName];
    if (!root) return false;
    function discardNode(node, moduleName, isRoot) {
      if (!isRoot) build.moduleCount = Math.max(0, build.moduleCount - 1);
      build.memberCount = Math.max(0, build.memberCount - (node.members || []).length);
      (node.modules || []).forEach(function(child) {
        discardNode(child, moduleName + '.' + child.name, false);
      });
      delete build.modules[moduleName];
    }
    discardNode(root, rootName, true);
    delete build.roots[rootName];
    build.rootCount = Math.max(0, build.rootCount - 1);
    return true;
  }

  function dependencyApiIndexMakeRoomForPreferredRoot(build) {
    var names = Object.keys(build && build.roots || {});
    for (var index = 0; index < names.length; index += 1) {
      if (!dependencyApiIndexRootIsPreferred(build, names[index])) {
        dependencyApiIndexMarkTruncated(build);
        return dependencyApiIndexDiscardRoot(build, names[index]);
      }
    }
    return false;
  }

  function dependencyApiIndexEnsureModule(build, moduleName) {
    var parts = String(moduleName || '').split('.');
    if (!parts.length || parts.length > 8 || parts.some(function(part) { return !dependencyApiIdentifier.test(part); })) return null;
    var node = null;
    var full = '';
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index];
      full = full ? full + '.' + part : part;
      if (index === 0) {
        node = build.roots[part];
        if (!node) {
          // A large environment is delivered in deterministic order. When the
          // durable schema is full, replace one unrelated root for a module
          // implicated by the current editing context instead of silently
          // losing the candidate or exceeding its fixed 64-root limit.
          var preferred = dependencyApiIndexRootIsPreferred(build, part);
          if (build.rootCount >= 64 && (!preferred || !dependencyApiIndexMakeRoomForPreferredRoot(build))) {
            dependencyApiIndexMarkTruncated(build);
            return null;
          }
          node = dependencyApiIndexNode(part);
          build.roots[part] = node;
          build.rootCount += 1;
        }
      } else {
        var child = node._modules[part];
        if (!child) {
          if (build.moduleCount >= 2048) {
            dependencyApiIndexMarkTruncated(build);
            return null;
          }
          child = dependencyApiIndexNode(part);
          node._modules[part] = child;
          node.modules.push(child);
          build.moduleCount += 1;
        }
        node = child;
      }
      build.modules[full] = node;
    }
    return node;
  }

  function dependencyApiIndexKind(kind) {
    var value = String(kind || '').toLowerCase();
    var allowed = ['class', 'function', 'method', 'property', 'field', 'variable', 'constant', 'type', 'enum', 'alias', 'module'];
    return allowed.indexOf(value) >= 0 ? value : 'variable';
  }

  function dependencyApiIndexInsertPage(build, page) {
    if (!page || page.schema !== dependencyApiIndexSchema || !Array.isArray(page.roots) || !Array.isArray(page.entries)) return false;
    if (page.roots.some(function(root) { return !dependencyApiIdentifier.test(String(root || '')); })) return false;
    if (page.truncated === true) dependencyApiIndexMarkTruncated(build);
    page.roots.forEach(function(root) {
      if (!dependencyApiIndexEnsureModule(build, String(root))) dependencyApiIndexMarkTruncated(build);
    });
    for (var index = 0; index < page.entries.length; index += 1) {
      var entry = page.entries[index];
      if (!entry || !dependencyApiIdentifier.test(String(entry.module || '').split('.')[0] || '')) continue;
      var node = dependencyApiIndexEnsureModule(build, entry.module);
      if (!node) {
        dependencyApiIndexMarkTruncated(build);
        continue;
      }
      if (!Array.isArray(entry.symbols)) continue;
      for (var symbolIndex = 0; symbolIndex < entry.symbols.length; symbolIndex += 1) {
        var symbol = entry.symbols[symbolIndex] || {};
        var name = String(symbol.name || '');
        // This is a public API acceleration feature. Private implementation
        // names remain the remote analyzer's responsibility.
        if (!dependencyApiIdentifier.test(name) || name.charAt(0) === '_' || node._members[name]) continue;
        if (build.memberCount >= 16384) {
          build.truncated = true;
          break;
        }
        node._members[name] = true;
        node.members.push({ name: name, kind: dependencyApiIndexKind(symbol.kind) });
        build.memberCount += 1;
      }
    }
    return true;
  }

  function dependencyApiIndexSerializableNode(node) {
    var result = { name: node.name, kind: node.kind };
    if (node.members.length) result.members = node.members.slice().sort(function(left, right) { return left.name.localeCompare(right.name); });
    if (node.modules.length) result.modules = node.modules.slice().sort(function(left, right) {
      return left.name.localeCompare(right.name);
    }).map(dependencyApiIndexSerializableNode);
    return result;
  }

  function dependencyApiIndexResult(build) {
    var roots = Object.keys(build.roots).sort().map(function(root) {
      return dependencyApiIndexSerializableNode(build.roots[root]);
    });
    // The persistent cache has a deliberately strict, path-safe schema. A
    // partial page is tracked on the build and never serialized as a complete
    // durable summary; callers can still use its bounded in-memory hints.
    return roots.length ? { schema: dependencyApiIndexSchema, roots: roots } : null;
  }

  function dependencyApiIndexFindModule(index, path) {
    var segments = String(path || '').split('.');
    if (!index || !Array.isArray(index.roots) || !segments.length) return null;
    var node = index.roots.find(function(root) { return root && root.name === segments[0]; });
    for (var position = 1; node && position < segments.length; position += 1) {
      node = (node.modules || []).find(function(child) { return child && child.name === segments[position]; });
    }
    return node || null;
  }

  function dependencyApiCompletionKind(kind) {
    var value = String(kind || '').toLowerCase();
    if (value === 'module') return 9;
    if (value === 'class' || value === 'type' || value === 'interface') return 7;
    if (value === 'function' || value === 'method') return 3;
    if (value === 'property' || value === 'field') return 10;
    if (value === 'constant' || value === 'enum') return 21;
    return 6;
  }

  function dependencyApiCandidate(name, kind, detail) {
    return {
      label: name,
      kind: dependencyApiCompletionKind(kind),
      insertText: name,
      filterText: name,
      sortText: '9000:' + name,
      detail: detail || ''
    };
  }

  function dependencyApiFilter(items, prefix) {
    var normalized = String(prefix || '');
    var seen = Object.create(null);
    return (items || []).filter(function(item) {
      if (!item || !item.name || seen[item.name] || (normalized && item.name.indexOf(normalized) !== 0)) return false;
      seen[item.name] = true;
      return true;
    }).slice(0, 100);
  }

  function dependencyApiAliasTarget(index, snapshot, alias) {
    if (!index || !snapshot || !snapshot.model || !dependencyApiIdentifier.test(String(alias || ''))) return '';
    var model = snapshot.model;
    if (typeof model.getVersionId !== 'function' || model.getVersionId() !== snapshot.version ||
        typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') return '';
    var limit = Math.min(Math.max(0, (Number(snapshot.lineNumber) || 0) - 1), model.getLineCount(), 512);
    var aliases = Object.create(null);
    for (var lineNumber = 1; lineNumber <= limit; lineNumber += 1) {
      var line = String(model.getLineContent(lineNumber) || '');
      // Aliases are deliberately derived only from simple, top-level imports
      // before this cursor. This avoids guessing through control flow, local
      // scopes, or another document's state.
      if (/^[ \t]/.test(line)) continue;
      var match = /^\s*import\s+([A-Za-z_][A-Za-z0-9_\.]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/.exec(line);
      if (!match || !dependencyApiIndexFindModule(index, match[1])) continue;
      aliases[match[2]] = match[1];
    }
    return aliases[alias] || '';
  }

  function dependencyApiIndexCompletions(index, snapshot) {
    if (!index || !snapshot) return null;
    var prefix = String(snapshot.prefix || '').slice(-512);
    var match = /^\s*import\s+([A-Za-z_][A-Za-z0-9_\.]*)?$/.exec(prefix);
    if (match) {
      var importText = String(match[1] || '');
      var dot = importText.lastIndexOf('.');
      if (dot < 0) {
        return { items: dependencyApiFilter((index.roots || []).map(function(root) {
          return { name: root.name, kind: 'module' };
        }), importText).map(function(item) { return dependencyApiCandidate(item.name, item.kind, ''); }) };
      }
      var importParent = dependencyApiIndexFindModule(index, importText.slice(0, dot));
      return importParent ? { items: dependencyApiFilter(importParent.modules || [], importText.slice(dot + 1)).map(function(item) {
        return dependencyApiCandidate(item.name, 'module', importText.slice(0, dot));
      }) } : null;
    }
    match = /^\s*from\s+([A-Za-z_][A-Za-z0-9_\.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(prefix);
    if (match) {
      var fromNode = dependencyApiIndexFindModule(index, match[1]);
      if (!fromNode) return null;
      var imported = dependencyApiFilter((fromNode.modules || []).map(function(node) {
        return { name: node.name, kind: 'module' };
      }).concat(fromNode.members || []), match[2] || '');
      return { items: imported.map(function(item) { return dependencyApiCandidate(item.name, item.kind, match[1]); }) };
    }
    match = /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_\.]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(prefix);
    if (!match) return null;
    var receiver = match[1];
    var memberNode = dependencyApiIndexFindModule(index, receiver);
    if (!memberNode && receiver.indexOf('.') < 0) {
      receiver = dependencyApiAliasTarget(index, snapshot, receiver);
      memberNode = dependencyApiIndexFindModule(index, receiver);
    }
    if (!memberNode) return null;
    var members = dependencyApiFilter((memberNode.modules || []).map(function(node) {
      return { name: node.name, kind: 'module' };
    }).concat(memberNode.members || []), match[2] || '');
    return { items: members.map(function(item) { return dependencyApiCandidate(item.name, item.kind, receiver); }) };
  }

  function mergeLocalCompletionResults(primary, fallback) {
    var first = Array.isArray(primary) ? primary : (primary && primary.items) || [];
    var second = Array.isArray(fallback) ? fallback : (fallback && fallback.items) || [];
    if (!first.length && !second.length) return null;
    var seen = Object.create(null);
    var primaryItems = [];
    var fallbackItems = [];
    function append(items, item) {
      var key = String(item && (item.insertText || completionItemLabel(item)) || '');
      if (!key || seen[key]) return;
      seen[key] = true;
      items.push(item);
    }
    first.forEach(function(item) { append(primaryItems, item); });
    second.forEach(function(item) { append(fallbackItems, item); });
    // A dependency-summary candidate is already matched against an import or
    // receiver prefix. Reserve a small tail for it so a broad server response
    // cannot crowd out `numpy` or `numpy.array` at the exact moment this
    // acceleration feature is needed.
    var fallbackReserve = Math.min(24, fallbackItems.length);
    var primaryLimit = Math.max(0, 100 - fallbackReserve);
    var items = primaryItems.slice(0, primaryLimit).concat(fallbackItems.slice(0, fallbackReserve));
    return items.length ? { items: items } : null;
  }

  function dependencyApiIndexCurrentScope(scope, key) {
    var current = dependencyApiIndexScope(currentModel());
    return !!current && clientCompletionCacheScopeId(current) === scope && dependencyApiIndexKey(current) === key;
  }

  function dependencyApiIndexRequestPage(build) {
    if (!build || build.cancelled || !dependencyApiIndexCurrentScope(build.scopeId, build.key) ||
        !dependencyApiIndexCapability() || !global.api || typeof global.api.lspControl !== 'function') return false;
    if (build.pageCount >= 128 || build.approxBytes >= 6 * 1024 * 1024) {
      build.truncated = true;
      return dependencyApiIndexFinish(build);
    }
    build.requestId = 'dependency-api-' + (dependencyApiIndexSequence++) + '-' + stableCompletionHash(build.id).slice(0, 24);
    build.waiting = true;
    if (build.timer) clearTimeout(build.timer);
    build.timer = setTimeout(function() {
      if (dependencyApiIndexBuilds.get(build.id) !== build) return;
      build.waiting = false;
      build.error = 'timeout';
      dependencyApiIndexBuilds.delete(build.id);
      dependencyApiIndexUi = { state: 'error', error: '' };
      renderClientCacheUi();
    }, 15000);
    try {
      Promise.resolve(global.api.lspControl({
        type: 'lsp.dependency.index.request',
        params: { requestId: build.requestId, cursor: build.cursor || undefined, maxBytes: 98304 }
      })).catch(function() {
        if (dependencyApiIndexBuilds.get(build.id) !== build) return;
        if (build.timer) clearTimeout(build.timer);
        build.timer = null;
        dependencyApiIndexBuilds.delete(build.id);
        dependencyApiIndexUi = { state: 'error', error: '' };
        renderClientCacheUi();
      });
      return true;
    } catch (_) {
      clearTimeout(build.timer);
      build.timer = null;
      dependencyApiIndexBuilds.delete(build.id);
      return false;
    }
  }

  function dependencyApiIndexFinish(build) {
    if (!build || dependencyApiIndexBuilds.get(build.id) !== build) return false;
    if (build.timer) clearTimeout(build.timer);
    build.timer = null;
    dependencyApiIndexBuilds.delete(build.id);
    var value = dependencyApiIndexResult(build);
    if (!value || !dependencyApiIndexCurrentScope(build.scopeId, build.key) || !clientCacheDependencyIndexEnabled()) return false;
    if (!dependencyApiIndexCache.prime(build.scopeId, build.key, value)) return false;
    // A truncated response remains useful for this live session, but must not
    // masquerade as a complete cross-session durable API tree.
    if (!build.truncated) {
      try { Promise.resolve(global.api.lspClientCacheDependencyIndexPut(build.scope, build.key, value)).catch(function() {}); } catch (_) {}
    }
    dependencyApiIndexUi = { state: 'enabled', error: '' };
    renderClientCacheUi();
    var model = currentModel();
    var position = S.editor && S.editor.getPosition ? S.editor.getPosition() : null;
    var snapshot = model && position ? completionSnapshot(model, position, null) : null;
    if (snapshot && dependencyApiIndexCompletions(value, snapshot)) retriggerCompletion(snapshot);
    return true;
  }

  function startDependencyApiIndexBuild(scope, scopeId, key) {
    var id = dependencyApiIndexBuildId(scopeId, key);
    if (dependencyApiIndexBuilds.has(id)) return;
    var build = {
      id: id, scope: scope, scopeId: scopeId, key: key, cursor: '', requestId: '', waiting: false,
      timer: null, pageCount: 0, approxBytes: 0, rootCount: 0, moduleCount: 0, memberCount: 0,
      roots: Object.create(null), modules: Object.create(null), truncated: false, preferredRootPrefixes: []
    };
    var model = currentModel();
    var position = S.editor && S.editor.getPosition ? S.editor.getPosition() : null;
    dependencyApiIndexRefreshPreferredRoots(build, model && position ? completionSnapshot(model, position, null) : null);
    dependencyApiIndexBuilds.set(id, build);
    dependencyApiIndexUi = { state: 'loading', error: '' };
    renderClientCacheUi();
    if (!dependencyApiIndexRequestPage(build)) {
      dependencyApiIndexBuilds.delete(id);
      dependencyApiIndexUi = { state: 'enabled', error: '' };
      renderClientCacheUi();
    }
  }

  function hydrateDependencyApiIndex(scope, scopeId, key) {
    if (!scope || !scopeId || !key || dependencyApiIndexCache.peek(scopeId, key) || dependencyApiIndexCache.hasPending(scopeId, key)) return;
    var epoch = dependencyApiIndexCache.epoch();
    dependencyApiIndexCache.begin(scopeId, key, function() {
      if (!dependencyApiIndexCache.isCurrent(epoch)) return false;
      return Promise.resolve().then(function() {
        return global.api.lspClientCacheDependencyIndexGet(scope, key);
      }).then(function(value) {
        if (!dependencyApiIndexCache.isCurrent(epoch) || !dependencyApiIndexCurrentScope(scopeId, key) || !clientCacheDependencyIndexEnabled()) return false;
        if (value && dependencyApiIndexCache.prime(scopeId, key, value)) {
          dependencyApiIndexUi = { state: 'enabled', error: '' };
          renderClientCacheUi();
          return true;
        }
        startDependencyApiIndexBuild(scope, scopeId, key);
        return false;
      }).catch(function() {
        if (dependencyApiIndexCache.isCurrent(epoch) && dependencyApiIndexCurrentScope(scopeId, key)) startDependencyApiIndexBuild(scope, scopeId, key);
        return false;
      });
    });
  }

  function ensureDependencyApiIndex(model) {
    if (!canUseDependencyApiIndex(model)) return null;
    var scope = dependencyApiIndexScope(model);
    var scopeId = clientCompletionCacheScopeId(scope);
    var key = dependencyApiIndexKey(scope);
    var value = dependencyApiIndexCache.peek(scopeId, key);
    if (!value) hydrateDependencyApiIndex(scope, scopeId, key);
    return { scope: scope, scopeId: scopeId, key: key, value: value };
  }

  function handleDependencyApiIndexMessage(message) {
    if (!message || message.type !== 'lsp.dependency.index' || !message.requestId) return;
    var build = null;
    dependencyApiIndexBuilds.forEach(function(candidate) {
      if (!build && candidate && candidate.requestId === String(message.requestId)) build = candidate;
    });
    if (!build) return;
    if (build.timer) clearTimeout(build.timer);
    build.timer = null;
    build.waiting = false;
    if (message.success !== true || !message.page || !dependencyApiIndexCurrentScope(build.scopeId, build.key)) {
      dependencyApiIndexBuilds.delete(build.id);
      dependencyApiIndexUi = { state: message.success === false ? 'error' : 'enabled', error: '' };
      renderClientCacheUi();
      return;
    }
    var page = message.page;
    var model = currentModel();
    var position = S.editor && S.editor.getPosition ? S.editor.getPosition() : null;
    dependencyApiIndexRefreshPreferredRoots(build, model && position ? completionSnapshot(model, position, null) : null);
    if (page.schema !== dependencyApiIndexSchema || page.languageId !== 'python' ||
        String(page.runtimeId || '') !== String(build.scope.runtimeId) || String(page.revision || '') !== String(build.scope.dependencyRevision) ||
        !dependencyApiIndexInsertPage(build, page)) {
      dependencyApiIndexBuilds.delete(build.id);
      dependencyApiIndexUi = { state: 'error', error: '' };
      renderClientCacheUi();
      return;
    }
    if (page.truncated === true) build.truncated = true;
    build.pageCount += 1;
    try { build.approxBytes += JSON.stringify(page).length; } catch (_) { build.approxBytes = 6 * 1024 * 1024; }
    if (page.complete === true || !page.nextCursor || build.pageCount >= 128 || build.approxBytes >= 6 * 1024 * 1024) {
      if (page.complete !== true) build.truncated = true;
      dependencyApiIndexFinish(build);
      return;
    }
    build.cursor = String(page.nextCursor);
    dependencyApiIndexRequestPage(build);
  }

  function canUseClientCompletionCache(model) {
    return clientCacheMode() !== 'off' && settings.mode !== 'local' && status.state === 'ready' &&
      !!clientCompletionCacheScope(model, true) && !!(global.api && global.api.lspClientCacheGet && global.api.lspClientCachePut);
  }

  function primeCompletionHint(scopeId, key, value, source) {
    return completionHintCache.prime(scopeId, key, value, source);
  }

  function hydrateCompletionHint(scope, scopeId, key, snapshot, retriggerOnHit) {
    if (!scope || !scopeId || !key || completionHintCache.peek(scopeId, key) || completionHintCache.hasPending(scopeId, key)) return;
    var cacheEpoch = completionHintCache.epoch();
    var hydration = Promise.resolve(global.api.lspClientCacheGet(scope, key)).then(function(value) {
      if (!completionHintCache.isCurrent(cacheEpoch) || !value || !completionSnapshotIsValid(snapshot)) return false;
      if (!primeCompletionHint(scopeId, key, value, 'durable')) return false;
      if (retriggerOnHit !== false) retriggerCompletion(snapshot);
      return true;
    }).catch(function() { return false; });
    completionHintCache.begin(scopeId, key, hydration);
  }

  // Lazy mode prewarms the opaque, position-specific durable key while the
  // cursor is stable. This keeps disk IPC off Monaco's provider path and lets
  // a later completion hit return immediately without opening a remote request.
  function scheduleCompletionHintPrewarm(model, position) {
    if (clientCacheMode() !== 'lazy' || !model || !position || !canUseClientCompletionCache(model)) return;
    if (completionHintPrewarmTimer) clearTimeout(completionHintPrewarmTimer);
    completionHintPrewarmTimer = setTimeout(function() {
      completionHintPrewarmTimer = null;
      if (clientCacheMode() !== 'lazy' || !canUseClientCompletionCache(model)) return;
      var snapshot = completionSnapshot(model, position, null);
      if (!snapshot || !completionSnapshotIsValid(snapshot)) return;
      var scope = clientCompletionCacheScope(model, true);
      var scopeId = clientCompletionCacheScopeId(scope);
      var key = clientCompletionCacheKey(snapshot, { triggerKind: 1 });
      if (scope && !completionHintCache.peek(scopeId, key)) hydrateCompletionHint(scope, scopeId, key, snapshot, false);
    }, 90);
  }

  function persistCompletionHint(scope, scopeId, key, value, model, position) {
    var safeValue = normalizeCacheableCompletionResult(value, model, position);
    if (!scope || !scopeId || !key || !safeValue || !completionResultHasItems(safeValue)) return false;
    var previous = completionHintCache.peek(scopeId, key);
    var changed = !previous || completionValueFingerprint(previous) !== completionValueFingerprint(safeValue);
    primeCompletionHint(scopeId, key, safeValue, 'live');
    // Persisting is deliberately detached from the Monaco completion path.
    // The main process re-sanitizes every candidate before writing a record.
    try { Promise.resolve(global.api.lspClientCachePut(scope, key, safeValue)).catch(function() {}); } catch (_) {}
    return changed;
  }

  function completionSnapshotIsValid(snapshot) {
    if (!snapshot || settings.mode === 'local' || status.state !== 'ready') return false;
    if (snapshot.contextGeneration !== completionContextGeneration) return false;
    if (snapshot.token && snapshot.token.isCancellationRequested) return false;
    if (String(status.sessionId || '') !== snapshot.sessionId || snapshot.model.getLanguageId() !== activeLanguage) return false;
    if (typeof snapshot.model.isDisposed === 'function' && snapshot.model.isDisposed()) return false;
    if (snapshot.model.getVersionId() !== snapshot.version || currentModel() !== snapshot.model) return false;
    var editorPosition = S.editor && S.editor.getPosition ? S.editor.getPosition() : null;
    if (!editorPosition || editorPosition.lineNumber !== snapshot.lineNumber || editorPosition.column !== snapshot.column) return false;
    var current = completionSnapshot(snapshot.model, editorPosition, snapshot.token);
    return !!current && current.key === snapshot.key;
  }

  function completionResultHasItems(result) {
    var items = Array.isArray(result) ? result : (result && result.items) || [];
    return items.length > 0;
  }

  function completionList(result, model, position, localHint) {
    var items = Array.isArray(result) ? result : (result && result.items) || [];
    var word = model.getWordUntilPosition(position);
    var range = new monacoRef.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    return {
      suggestions: items.slice(0, 100).map(function(item) { return mapCompletion(item, range, localHint); }),
      incomplete: !!(result && result.isIncomplete)
    };
  }

  function canRetriggerCompletion(snapshot) {
    return completionSnapshotIsValid(snapshot) && !!(S.editor && typeof S.editor.hasTextFocus === 'function' && S.editor.hasTextFocus());
  }

  function retriggerCompletion(snapshot) {
    if (!canRetriggerCompletion(snapshot) || typeof S.editor.trigger !== 'function') return;
    var controller = typeof S.editor.getContribution === 'function'
      ? S.editor.getContribution('editor.contrib.suggestController')
      : null;
    if (controller && typeof controller.triggerSuggest === 'function') {
      controller.triggerSuggest(undefined, true, undefined);
      return;
    }
    S.editor.trigger('remote-lsp', 'editor.action.triggerSuggest', {});
  }

  function provideRemoteCompletion(model, position, context, token) {
    var providerCapability = completionProviderCapability(lspProtocolCapabilities);
    if (settings.mode === 'local' || status.state !== 'ready' || !providerCapability || model.getLanguageId() !== activeLanguage || (token && token.isCancellationRequested)) {
      return { suggestions: [] };
    }
    var snapshot = completionSnapshot(model, position, token);
    if (!snapshot) return { suggestions: [] };
    var protocolContext = lspCompletionContext(context);
    var cacheScope = canUseClientCompletionCache(model) ? clientCompletionCacheScope(model, true) : null;
    var cacheScopeId = clientCompletionCacheScopeId(cacheScope);
    var cacheKey = cacheScope ? clientCompletionCacheKey(snapshot, protocolContext) : '';
    var localHint = cacheScope ? completionHintCache.peek(cacheScopeId, cacheKey) : null;
    if (cacheScope && !localHint) hydrateCompletionHint(cacheScope, cacheScopeId, cacheKey, snapshot, true);
    // API summaries are only enabled for Active cache. They remain inside this
    // provider rather than registering another Monaco provider, so local
    // module/member names cannot race or duplicate semantic LSP candidates.
    var dependencyIndex = ensureDependencyApiIndex(model);
    var apiHint = dependencyIndex && dependencyIndex.value
      ? dependencyApiIndexCompletions(dependencyIndex.value, snapshot)
      : null;
    var requestContextKey = JSON.stringify(protocolContext);
    var sessionHint = completionCoordinator.read(snapshot.uri, snapshot.key, requestContextKey);
    // L1 is exact for this editor position and always wins. L2 lazy mode then
    // serves a validated local hint without opening a remote request. Active
    // mode intentionally falls through to stale-while-revalidate.
    if (sessionHint !== null) return completionList(mergeLocalCompletionResults(sessionHint, apiHint), model, position, false);
    if (localHint && clientCacheMode() === 'lazy') return completionList(mergeLocalCompletionResults(localHint, apiHint), model, position, true);
    var cached = completionCoordinator.readOrRefresh({
      uri: snapshot.uri,
      key: snapshot.key,
      requestContextKey: requestContextKey,
      isValid: function() { return completionSnapshotIsValid(snapshot); },
      hasFocus: function() { return canRetriggerCompletion(snapshot); },
      hasResults: completionResultHasItems,
      // A cached local list needs one follow-up render when the server proves
      // that the authoritative result is empty, otherwise stale suggestions
      // would linger until the user invokes completion again.
      retriggerOnEmpty: !!localHint || !!apiHint,
      shouldRetrigger: function(value) {
        if (!cacheScope || !completionSnapshotIsValid(snapshot)) return true;
        if (!completionResultHasItems(value)) return !!localHint || !!apiHint;
        // The remote analyzer is authoritative. If it differs from a library
        // summary, request exactly one replacement render even when the normal
        // completion cache did not change.
        var hintChanged = persistCompletionHint(cacheScope, cacheScopeId, cacheKey, value, model, position);
        return !!apiHint || hintChanged;
      },
      retrigger: function() { retriggerCompletion(snapshot); },
      load: function(requestKey, isCurrentValid) {
        return ensureDocumentSynchronized(model).then(function(synchronized) {
          if (!synchronized || !isCurrentValid()) return undefined;
          var params = textDocumentPosition(model, position);
          params.context = protocolContext;
          return request('textDocument/completion', params, null, 1800, requestKey, true);
        });
      }
    });
    // Keep the analyzer's semantic result first, but preserve missing public
    // library names from the static summary. A warm remote answer must not
    // make `numpy` or `numpy.array` disappear after the first local render.
    var result = cached === null
      ? mergeLocalCompletionResults(localHint, apiHint)
      : mergeLocalCompletionResults(cached, apiHint);
    return result === null ? { suggestions: [] } : completionList(result, model, position, cached === null && !!result);
  }

  function installRemoteCompletionProvider(language, triggerCharacters) {
    var registration = registeredCompletionProviders[language];
    if (!registration || !monacoRef) return;
    var triggers = (triggerCharacters || []).slice();
    var capability = completionProviderCapability(lspProtocolCapabilities);
    var resolveEnabled = status.state === 'ready' && language === activeLanguage && !!(capability && capability.resolveProvider === true);
    var providerKey = JSON.stringify({ triggers: triggers, resolveProvider: resolveEnabled });
    if (registration.disposable && registration.providerKey === providerKey) return;
    if (registration.disposable) {
      try { registration.disposable.dispose(); } catch (_) {}
    }
    var completionProvider = {
      triggerCharacters: triggers,
      provideCompletionItems: function(model, position, context, token) {
        return provideRemoteCompletion(model, position, context, token);
      }
    };
    if (resolveEnabled) {
      completionProvider.resolveCompletionItem = async function(item, token) {
        if (!item._boboLsp || status.state !== 'ready') return item;
        var resolved = await request('completionItem/resolve', item._boboLsp, token, 1800);
        if (token && token.isCancellationRequested) return item;
        return resolved ? mapCompletion(resolved, item.range) : item;
      };
    }
    registration.provider = completionProvider;
    registration.providerKey = providerKey;
    registration.disposable = monacoRef.languages.registerCompletionItemProvider(language, completionProvider);
  }

  function registerProviders() {
    supportedLanguages.forEach(function(language) {
      if (registeredProviderLanguages[language]) return;
      registeredProviderLanguages[language] = true;
      var registration = { provider: null, disposable: null, providerKey: '' };
      registeredCompletionProviders[language] = registration;
      disposables.push({
        dispose: function() {
          if (registration.disposable) {
            try { registration.disposable.dispose(); } catch (_) {}
            registration.disposable = null;
          }
        }
      });
      installRemoteCompletionProvider(language, []);

      disposables.push(monacoRef.languages.registerHoverProvider(language, {
        provideHover: async function(model, position, token) {
          if (settings.mode === 'local' || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return null;
          var result = await request('textDocument/hover', textDocumentPosition(model, position), token, 2500);
          if (!result || !result.contents) return null;
          var contents = Array.isArray(result.contents) ? result.contents : [result.contents];
          return { range: result.range ? fromLspRange(result.range) : undefined, contents: contents.map(markdown).filter(Boolean) };
        }
      }));

      disposables.push(monacoRef.languages.registerDefinitionProvider(language, {
        provideDefinition: async function(model, position, token) {
          if (settings.mode === 'local' || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return null;
          return mapLocations(await request('textDocument/definition', textDocumentPosition(model, position), token, 3000));
        }
      }));

      if (monacoRef.languages.registerDocumentFormattingEditProvider) {
        disposables.push(monacoRef.languages.registerDocumentFormattingEditProvider(language, {
          provideDocumentFormattingEdits: async function(model, options, token) {
            if (settings.mode === 'local' || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return [];
            openDocument(model);
            var params = formattingParamsForModel(model, null, options);
            if (!params) return [];
            return mapFormattingEdits(await request('textDocument/formatting', params, token, 10000));
          }
        }));
      }

      if (monacoRef.languages.registerDocumentRangeFormattingEditProvider) {
        disposables.push(monacoRef.languages.registerDocumentRangeFormattingEditProvider(language, {
          provideDocumentRangeFormattingEdits: async function(model, range, options, token) {
            if (settings.mode === 'local' || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return [];
            openDocument(model);
            var params = formattingParamsForModel(model, range, options);
            if (!params) return [];
            return mapFormattingEdits(await request('textDocument/rangeFormatting', params, token, 10000));
          }
        }));
      }

      disposables.push(monacoRef.languages.registerReferenceProvider(language, {
        provideReferences: async function(model, position, context, token) {
          if (settings.mode !== 'full' || status.state !== 'ready' || model.getLanguageId() !== activeLanguage) return null;
          var params = textDocumentPosition(model, position);
          params.context = { includeDeclaration: !!context.includeDeclaration };
          return mapLocations(await request('textDocument/references', params, token, 8000));
        }
      }));

      disposables.push(monacoRef.languages.registerRenameProvider(language, {
        resolveRenameLocation: async function(model, position, token) {
          if (settings.mode !== 'full' || status.state !== 'ready') return { rejectReason: t('Full remote analysis is required for rename') };
          var result = await request('textDocument/prepareRename', textDocumentPosition(model, position), token, 3000);
          if (!result) return { rejectReason: t('This symbol cannot be renamed') };
          if (result.defaultBehavior) {
            var word = model.getWordAtPosition(position);
            if (!word) return { rejectReason: t('This symbol cannot be renamed') };
            return {
              range: new monacoRef.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
              text: word.word
            };
          }
          var range = result.range || result;
          if (!range || !range.start || !range.end) return { rejectReason: t('This symbol cannot be renamed') };
          return { range: fromLspRange(range), text: result.placeholder || model.getValueInRange(fromLspRange(range)) };
        },
        provideRenameEdits: async function(model, position, newName, token) {
          if (settings.mode !== 'full' || status.state !== 'ready') return { edits: [], rejectReason: t('Full remote analysis is required for rename') };
          var params = textDocumentPosition(model, position);
          params.newName = newName;
          return await mapWorkspaceEdit(await request('textDocument/rename', params, token, 10000));
        }
      }));
    });

    updateCompletionCapabilities(lspProtocolCapabilities);

    if (globalProvidersRegistered) return;
    globalProvidersRegistered = true;

    if (monacoRef.languages.registerWorkspaceSymbolProvider) {
      disposables.push(monacoRef.languages.registerWorkspaceSymbolProvider({
        provideWorkspaceSymbols: async function(query, token) {
          if (settings.mode !== 'full' || status.state !== 'ready') return [];
          var result = await request('workspace/symbol', { query: query }, token, 10000);
          return (result || []).slice(0, 200).map(function(symbol) {
            var resource = localUriFromWire(symbol.location && symbol.location.uri);
            if (!resource) return null;
            return {
              name: symbol.name,
              detail: symbol.containerName || '',
              kind: Math.max(0, (Number(symbol.kind) || 1) - 1),
              containerName: symbol.containerName || '',
              location: { uri: resource, range: fromLspRange(symbol.location.range) },
              _boboWireUri: symbol.location.uri
            };
          }).filter(Boolean);
        },
        resolveWorkspaceSymbol: async function(symbol) {
          if (symbol && symbol.location && symbol.location.uri) await ensureLocalModel(symbol.location.uri);
          return symbol;
        }
      }));
    }

    if (monacoRef.editor.registerEditorOpener) {
      disposables.push(monacoRef.editor.registerEditorOpener({ openCodeEditor: openWorkspaceResource }));
    }
  }

  async function openWorkspaceResource(_source, resource, selectionOrPosition) {
    if (!resource || resource.scheme !== 'file' || !S.workspaceRoot || !pathInsideRoot(resource.fsPath, S.workspaceRoot)) return false;
    if (!BOBO.workspace || !BOBO.workspace.openFile) return false;
    var name = String(resource.fsPath || '').split(/[/\\]/).pop();
    if (!name) return false;
    try {
      await BOBO.workspace.openFile(resource.fsPath, name);
      var editor = S.editor;
      if (!editor) return false;
      if (selectionOrPosition) {
        if (typeof selectionOrPosition.endLineNumber === 'number') {
          editor.setSelection(selectionOrPosition);
          editor.revealRangeInCenter(selectionOrPosition);
        } else {
          editor.setPosition(selectionOrPosition);
          editor.revealPositionInCenter(selectionOrPosition);
        }
      }
      editor.focus();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function ensureLocalModel(resource) {
    if (!resource || !monacoRef) return;
    var resourceKey = resource.toString();
    if (monacoRef.editor.getModel(resource)) {
      if (auxiliaryModels.has(resourceKey)) {
        var existing = auxiliaryModels.get(resourceKey);
        auxiliaryModels.delete(resourceKey);
        auxiliaryModels.set(resourceKey, existing);
      }
      return true;
    }
    try {
      var content = await global.api.readFile(resource.fsPath);
      var model = monacoRef.editor.createModel(content, BOBO.detectLanguage(resource.path || resource.fsPath, content), resource);
      auxiliaryModels.set(resourceKey, model);
      while (auxiliaryModels.size > 80) {
        var oldest = auxiliaryModels.entries().next().value;
        if (!oldest) break;
        auxiliaryModels.delete(oldest[0]);
        var isOpenTab = (S.tabs || []).some(function(tab) { return tab.model === oldest[1]; });
        if (!isOpenTab) {
          try { oldest[1].dispose(); } catch (_) {}
        }
      }
      return true;
    } catch (_) { return false; }
  }

  function workspaceChanged() {
    invalidateCompletionContext();
    auxiliaryModels.forEach(function(model) {
      var isOpenTab = (S.tabs || []).some(function(tab) { return tab.model === model; });
      if (!isOpenTab) {
        try { model.dispose(); } catch (_) {}
      }
    });
    auxiliaryModels.clear();
    scheduleConfigure();
  }

  function credentialsChanged() {
    lastConfigSignature = '';
    invalidateCompletionContext();
    if (settings.mode !== 'local' && lspFeatureDecision().available && global.api && global.api.lspControl) {
      global.api.lspControl({ type: 'lsp.restart' }).catch(function() {});
    }
    return refreshCapabilities().finally(scheduleConfigure);
  }

  // Used when authentication is removed, rather than replaced. Do not attempt
  // a reconnect without credentials, but immediately make old remote results
  // and their local cache mirror ineligible for replay.
  function identityChanged() {
    lastConfigSignature = '';
    invalidateCompletionContext();
    if (dependencyRefreshCoordinator) dependencyRefreshCoordinator.settle(false);
    status = Object.assign({}, status, { state: 'disconnected', error: '' });
    updateCompletionCapabilities({});
    clearRemoteMarkers();
    if (S.lsp) S.lsp.status = status;
    renderStatus();
  }

  async function mapLocations(value) {
    if (!value) return null;
    var locations = (Array.isArray(value) ? value : [value]).slice(0, 80);
    var mapped = locations.map(function(location) {
      var uri = location.uri || location.targetUri;
      var range = location.range || location.targetSelectionRange || location.targetRange;
      var resource = localUriFromWire(uri);
      return resource && range ? { uri: resource, range: fromLspRange(range) } : null;
    }).filter(Boolean);
    var loaded = await Promise.all(mapped.map(function(location) { return ensureLocalModel(location.uri); }));
    return mapped.filter(function(_location, index) { return loaded[index] !== false; });
  }

  async function mapWorkspaceEdit(edit) {
    if (!edit) return { edits: [], rejectReason: t('Rename produced no changes') };
    var result = [];
    var textResources = new Map();
    var affectedResources = new Set();
    var unsupportedOperation = false;
    function resolveResource(uri, needsModel) {
      var resource = localUriFromWire(uri);
      if (!resource) {
        unsupportedOperation = true;
        return null;
      }
      var key = resource.toString();
      affectedResources.add(key);
      if (needsModel) textResources.set(key, resource);
      return resource;
    }
    Object.keys(edit.changes || {}).forEach(function(uri) {
      var resource = resolveResource(uri, true);
      if (!resource) return;
      (edit.changes[uri] || []).forEach(function(textEdit) {
        result.push({ resource: resource, textEdit: { range: fromLspRange(textEdit.range), text: textEdit.newText }, versionId: undefined });
      });
    });
    (edit.documentChanges || []).forEach(function(change) {
      if (change.textDocument && Array.isArray(change.edits)) {
        var resource = resolveResource(change.textDocument.uri, true);
        if (!resource) return;
        change.edits.forEach(function(textEdit) {
          result.push({
            resource: resource,
            textEdit: { range: fromLspRange(textEdit.range), text: textEdit.newText },
            versionId: change.textDocument.version === null || change.textDocument.version === undefined
              ? undefined
              : Number(change.textDocument.version)
          });
        });
        return;
      }
      var options = change.options ? Object.assign({}, change.options) : undefined;
      if (change.kind === 'create') {
        var created = resolveResource(change.uri, false);
        if (created) result.push({ newResource: created, options: options });
      } else if (change.kind === 'rename') {
        var oldResource = resolveResource(change.oldUri, false);
        var newResource = resolveResource(change.newUri, false);
        if (oldResource && newResource) result.push({ oldResource: oldResource, newResource: newResource, options: options });
      } else if (change.kind === 'delete') {
        var deleted = resolveResource(change.uri, false);
        if (deleted) result.push({ oldResource: deleted, options: options });
      } else {
        unsupportedOperation = true;
      }
    });
    if (unsupportedOperation) {
      return { edits: [], rejectReason: t('Rename includes an unsupported or external file operation') };
    }
    if (affectedResources.size > 50 || result.length > 2000) {
      return {
        edits: [],
        rejectReason: t('Rename affects too many files or edits ({files} files, {edits} edits).', { files: affectedResources.size, edits: result.length })
      };
    }
    var originalActivePath = S.activeTabPath;
    try {
      for (var resource of textResources.values()) {
        var openTab = (S.tabs || []).some(function(tab) { return tab.path === resource.fsPath; });
        if (!openTab) {
          var name = String(resource.fsPath || '').split(/[/\\]/).pop();
          await BOBO.workspace.openFile(resource.fsPath, name);
        }
      }
    } catch (error) {
      return { edits: [], rejectReason: t('Could not prepare files for rename: {message}', { message: error.message }) };
    } finally {
      if (originalActivePath && BOBO.workspace && BOBO.workspace.activateTab) BOBO.workspace.activateTab(originalActivePath);
      if (S.editor && S.editor.focus) S.editor.focus();
    }
    return { edits: result };
  }

  function applyDiagnostics(params) {
    if (!params || !params.uri || !monacoRef || !activeLspDecision().available) return;
    var resource = localUriFromWire(params.uri);
    if (!resource) return;
    var model = monacoRef.editor.getModel(resource);
    if (!model) return;
    var severities = [monacoRef.MarkerSeverity.Error, monacoRef.MarkerSeverity.Warning, monacoRef.MarkerSeverity.Info, monacoRef.MarkerSeverity.Hint];
    var markers = (params.diagnostics || []).map(function(item) {
      var range = fromLspRange(item.range);
      return {
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn,
        severity: severities[Math.max(1, Number(item.severity) || 3) - 1] || monacoRef.MarkerSeverity.Info,
        message: item.message || '',
        source: item.source || 'LSP',
        code: item.code === undefined ? undefined : String(item.code),
        tags: item.tags
      };
    });
    monacoRef.editor.setModelMarkers(model, 'remote-lsp', markers);
    if (BOBO.editorCore && BOBO.editorCore.refreshDiagnosticsForModel) BOBO.editorCore.refreshDiagnosticsForModel(model);
  }

  function clearRemoteMarkers() {
    if (!monacoRef) return;
    monacoRef.editor.getModels().forEach(function(model) { monacoRef.editor.setModelMarkers(model, 'remote-lsp', []); });
    if (BOBO.editorCore && BOBO.editorCore.refreshDiagnosticsForModel) BOBO.editorCore.refreshDiagnosticsForModel(currentModel());
  }

  function onStatus(next) {
    if (next && next.state !== 'local' && next.state !== 'disconnected' && !activeLspDecision().available) {
      clearRemoteMarkers();
      return;
    }
    var previousState = status.state;
    var previousSessionId = status.sessionId;
    status = next || status;
    if (status.state === 'ready' || status.state === 'connecting' || status.state === 'initializing') remoteTransportActive = true;
    if (status.state === 'local' || status.state === 'disconnected' || status.state === 'error') remoteTransportActive = false;
    if (capabilityReconnectCoordinator) {
      capabilityReconnectCoordinator.handle(previousState, status.state).catch(function(error) {
        console.error('LSP capability refresh:', error);
      });
    }
    if (status.state === 'ready') updateCompletionCapabilities(status.capabilities || lspProtocolCapabilities);
    else updateCompletionCapabilities({});
    if (next && next.dependencyRefresh) {
      if (next.dependencyRefresh.success !== false && next.dependencyRefresh.changed === true) {
        invalidateCompletionContext();
      }
      if (dependencyRefreshCoordinator) dependencyRefreshCoordinator.settle(next.dependencyRefresh.success !== false);
    }
    if (dependencyRefreshCoordinator && dependencyRefreshCoordinator.isPending()) {
      if (status.state === 'ready' && (previousState !== 'ready' || previousSessionId !== status.sessionId)) {
        dependencyRefreshCoordinator.notifyReady(lspReconnectIdentityKey());
      } else if (status.state === 'local' || status.state === 'disabled' || status.state === 'unsupported') {
        dependencyRefreshCoordinator.settle(false);
      }
    }
    if (status.state === 'connecting' || status.state === 'local' || status.state === 'disconnected' || status.state === 'error') indexStatus = '';
    if (S.lsp) S.lsp.status = status;
    if (previousState === 'ready' && status.state !== 'ready') {
      openedDocuments.clear();
      clearChangeQueues();
      cancelDependencyApiIndexBuilds();
    }
    if (status.state === 'ready' && (previousState !== 'ready' || previousSessionId !== status.sessionId)) {
      clearChangeQueues();
      openedDocuments.clear();
      if (previousSessionId && previousSessionId !== status.sessionId) cancelDependencyApiIndexBuilds();
      monacoRef.editor.getModels().forEach(openDocument);
    }
    if (status.state === 'ready' && clientCacheDependencyIndexEnabled()) ensureDependencyApiIndex(currentModel());
    if (status.state === 'ready' || status.state === 'error' || status.state === 'disconnected') finishRestartButton();
    if (BOBO.environmentActivity) {
      if (status.state === 'ready' && (previousState !== 'ready' || previousSessionId !== status.sessionId)) {
        BOBO.environmentActivity.record('index', { outcome: 'completed' });
      } else if (previousState !== status.state) {
        BOBO.environmentActivity.contextChanged('lsp');
      }
    }
    renderStatus();
  }

  function finishRestartButton() {
    if (restartButtonTimer) {
      clearTimeout(restartButtonTimer);
      restartButtonTimer = null;
    }
    var restart = document.getElementById('lsp-restart');
    if (!restart) return;
    restart.disabled = false;
    restart.removeAttribute('aria-busy');
    restart.textContent = t('Restart analysis');
  }

  function humanBytes(value) {
    var bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function stateLabel() {
    if (settings.mode === 'local') return t('Local completion');
    if (!lspFeatureDecision().available) return t('Remote analysis is unavailable on this server.');
    if (status.state === 'ready') return t('Remote analysis ready');
    if (status.state === 'connecting') return t('Connecting to remote analysis...');
    if (status.state === 'initializing') return t('Initializing remote analysis...');
    if (status.state === 'error') return t('Remote analysis error');
    return t('Remote analysis offline');
  }

  function dependencyStatusLabel(value) {
    var labels = {
      ready: t('Ready'),
      mixed: t('Compatibility'),
      empty: t('Empty'),
      unavailable: t('Unavailable')
    };
    return labels[String(value || '').toLowerCase()] || '--';
  }

  function dependencyLanguageLabel(dependency) {
    var language = dependency && dependency.languageId;
    if (!language) return '--';
    return BOBO.langDisplayName ? BOBO.langDisplayName(language) : String(language);
  }

  function dependencyRuntimeLabel(dependency) {
    var runtimeId = dependency && dependency.runtimeId;
    if (!runtimeId) return '--';
    if (runtimeId === 'local') return t('Local');
    var runtime = (S.availableRuntimes || []).find(function(item) { return item.runtimeId === runtimeId; });
    return runtime && runtime.displayName ? runtime.displayName : String(runtimeId);
  }

  function renderDependencyMetrics() {
    var dependency = status.dependency;
    var dependencyState = document.getElementById('lsp-metric-dependency');
    if (dependencyState) {
      dependencyState.dataset.state = dependency ? String(dependency.status || '') : '';
      dependencyState.textContent = dependencyStatusLabel(dependency && dependency.status);
      dependencyState.title = dependency && dependency.source === 'mixed'
        ? t('Dependency cache may include packages from another runtime version.')
        : (dependency && dependency.detail ? String(dependency.detail) : '');
    }
    var revision = document.getElementById('lsp-metric-dependency-revision');
    if (revision) {
      var revisionValue = dependency && dependency.revision !== undefined && dependency.revision !== null
        ? String(dependency.revision)
        : '';
      revision.textContent = revisionValue || '--';
      revision.title = revisionValue;
    }
    var language = document.getElementById('lsp-metric-dependency-language');
    if (language) language.textContent = dependencyLanguageLabel(dependency);
    var runtime = document.getElementById('lsp-metric-dependency-runtime');
    if (runtime) runtime.textContent = dependencyRuntimeLabel(dependency);
  }

  // The renderer only consumes this narrow LSP facade. Cache ownership,
  // workspace scoping and IPC remain behind BOBO.lsp so this panel cannot
  // accidentally merge team and personal project data.
  function clientCacheFacade() {
    var lsp = BOBO.lsp;
    if (!lsp || typeof lsp.getClientCacheStats !== 'function' || typeof lsp.setClientCachePolicy !== 'function' || typeof lsp.clearClientCache !== 'function') return null;
    return lsp;
  }

  function clientCacheMode() {
    var mode = String(settings && settings.clientCacheMode || 'lazy').toLowerCase();
    if (mode === 'session') mode = 'lazy';
    if (mode === 'persistent') mode = 'active';
    return ['off', 'lazy', 'active'].indexOf(mode) >= 0 ? mode : 'lazy';
  }

  function clientCacheSizeMiB(value) {
    var requested = value === undefined || value === null || value === ''
      ? settings && settings.clientCacheSizeMiB
      : value;
    var size = Math.floor(Number(requested));
    return Math.max(1, Math.min(1024, Number.isFinite(size) ? size : 32));
  }

  function configureCompletionHintCache() {
    completionHintCache.configure({ mode: clientCacheMode(), sizeMiB: clientCacheSizeMiB() });
    dependencyApiIndexCache.configure({
      enabled: clientCacheDependencyIndexEnabled(),
      sizeMiB: clientCacheSizeMiB()
    });
  }

  function dependencyApiIndexEligible() {
    return clientCacheMode() === 'active' && clientCacheSizeMiB() >= 30;
  }

  function dependencyApiIndexSupportedHere() {
    return !!dependencyApiIndexCapability() && !!dependencyApiIndexScope(currentModel());
  }

  function renderDependencyApiIndexUi() {
    var panel = document.getElementById('lsp-client-cache-dependency-index');
    var toggle = document.getElementById('lsp-client-cache-dependency-index-toggle');
    var state = document.getElementById('lsp-client-cache-dependency-index-state');
    var hint = document.getElementById('lsp-client-cache-dependency-index-hint');
    if (!panel || !toggle || !state || !hint) return;
    var mode = clientCacheMode();
    var eligible = dependencyApiIndexEligible();
    var supported = dependencyApiIndexSupportedHere();
    var configured = clientCacheDependencyIndexEnabled();
    var enabled = configured && supported;
    panel.hidden = mode !== 'active';
    // Keep the disable action available after switching away from Python, but
    // never let an unsupported analyzer promise that it can build an index.
    toggle.disabled = (!eligible || (!configured && !supported)) || !!clientCacheUi.operation;
    toggle.setAttribute('aria-pressed', configured ? 'true' : 'false');
    toggle.textContent = configured ? t('Disable library API cache') : t('Enable library API cache');
    var stateValue = enabled ? (dependencyApiIndexUi.state || 'enabled') : (supported ? 'disabled' : 'unavailable');
    state.dataset.state = stateValue === 'loading' ? 'loading' : (stateValue === 'error' ? 'error' : (enabled ? 'enabled' : 'disabled'));
    state.textContent = !eligible
      ? t('Library API cache is disabled')
      : (!enabled && !supported ? t('Library API cache is unavailable for the current analysis.') : (enabled
      ? (stateValue === 'loading' ? t('Loading local cache...') : t('Library API cache is enabled'))
      : t('Library API cache is disabled')));
    hint.textContent = mode !== 'active'
      ? t('Library API cache is available only with active cache.')
      : (!eligible ? t('Requires active cache and at least 30 MB.') : (!supported
        ? t('A compatible Python dependency view is required.')
        : t('Requires active cache and at least 30 MB.')));
  }

  function clientCacheNumber(stats, names) {
    if (!stats) return null;
    for (var i = 0; i < names.length; i += 1) {
      var value = stats[names[i]];
      if (value !== undefined && value !== null && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  }

  function clientCacheCleanupLabel(stats, mode) {
    if (mode === 'off') return t('No local data is retained.');
    if (stats && stats.policy && stats.policy.refreshStrategy === 'on-miss-or-invalidation') return t('Refreshes matching hints when needed.');
    if (stats && stats.policy && stats.policy.refreshStrategy === 'stale-while-revalidate') return t('Refreshes local hints in the background.');
    if (mode === 'lazy') return t('Refreshes matching hints when needed.');
    if (mode === 'active') return t('Refreshes local hints in the background.');
    if (stats && stats.cleanupDescription) return String(stats.cleanupDescription);
    return t('Clears oldest entries when its local storage limit is reached.');
  }

  function clientCacheStateLabel(mode, state, stats) {
    if (state === 'loading') return t('Loading local cache...');
    if (state === 'error') return t('Local cache is unavailable');
    if (mode === 'off') return t('Local cache is off');
    var entries = clientCacheNumber(stats, ['entryCount', 'entries', 'count', 'items']);
    if (entries === 0) return t('No local cache data');
    return mode === 'lazy' ? t('Lazy cache is ready') : t('Active cache is ready');
  }

  function renderClientCacheUi() {
    var mode = clientCacheMode();
    var facade = clientCacheFacade();
    var state = clientCacheUi.state || 'loading';
    var stats = clientCacheUi.stats;
    var available = !!facade;
    var size = clientCacheNumber(stats, ['sizeBytes', 'bytes', 'totalBytes', 'usedBytes']);
    var entries = clientCacheNumber(stats, ['entryCount', 'entries', 'count', 'items']);
    // init() renders before BOBO.lsp is published below. Keep that short
    // interval as loading instead of flashing a false unavailable state.
    var effectiveState = state;
    var message = clientCacheStateLabel(mode, effectiveState, stats);
    var stateEl = document.getElementById('lsp-client-cache-state');
    if (stateEl) {
      stateEl.dataset.state = effectiveState === 'ready' && entries === 0 ? 'empty' : effectiveState;
      stateEl.textContent = clientCacheUi.operation ? t('Clearing local cache...') : message;
    }
    var sizeEl = document.getElementById('lsp-client-cache-size');
    if (sizeEl) {
      sizeEl.dataset.state = effectiveState === 'error' ? 'error' : (size === 0 ? 'empty' : (effectiveState === 'ready' ? 'ready' : effectiveState));
      var quota = clientCacheNumber(stats, ['totalQuotaBytes', 'effectiveQuotaBytes', 'quotaBytes', 'scopeQuotaBytes']);
      sizeEl.textContent = effectiveState === 'loading' ? '--' : (humanBytes(size || 0) + (quota ? ' / ' + humanBytes(quota) : ''));
    }
    var entriesEl = document.getElementById('lsp-client-cache-entries');
    if (entriesEl) {
      entriesEl.dataset.state = effectiveState === 'error' ? 'error' : (entries === 0 ? 'empty' : (effectiveState === 'ready' ? 'ready' : effectiveState));
      entriesEl.textContent = effectiveState === 'loading' ? '--' : String(entries === null ? 0 : entries);
    }
    var cleanupEl = document.getElementById('lsp-client-cache-cleanup');
    if (cleanupEl) {
      cleanupEl.dataset.state = effectiveState === 'error' ? 'error' : (effectiveState === 'ready' ? 'ready' : effectiveState);
      cleanupEl.textContent = effectiveState === 'loading' ? '--' : clientCacheCleanupLabel(stats, mode);
      cleanupEl.title = cleanupEl.textContent;
    }
    document.querySelectorAll('input[name="lsp-client-cache-mode"]').forEach(function(input) {
      input.checked = input.value === mode;
      input.disabled = !available || !!clientCacheUi.operation;
    });
    var capacity = document.querySelector('.lsp-client-cache-capacity');
    var sizeSlider = document.getElementById('lsp-client-cache-size-mib');
    var sizeOutput = document.getElementById('lsp-client-cache-size-output');
    var sizeMiB = clientCacheSizeMiB(stats && stats.configuredSizeMiB);
    if (capacity) capacity.setAttribute('aria-disabled', mode === 'off' ? 'true' : 'false');
    if (sizeSlider) {
      sizeSlider.value = String(sizeMiB);
      sizeSlider.disabled = !available || mode === 'off' || !!clientCacheUi.operation;
      sizeSlider.setAttribute('aria-valuetext', sizeMiB + ' MB');
    }
    if (sizeOutput) sizeOutput.textContent = sizeMiB + ' MB';
    ['lsp-client-cache-clear-workspace', 'lsp-client-cache-clear-all'].forEach(function(id) {
      var button = document.getElementById(id);
      if (!button) return;
      button.disabled = !available || !!clientCacheUi.operation;
      if (clientCacheUi.operation) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    });
    var detail = document.getElementById('lsp-client-cache-detail');
    if (detail) {
      detail.hidden = effectiveState !== 'error';
      detail.textContent = effectiveState === 'error' && clientCacheUi.error ? clientCacheUi.error : '';
    }
    renderDependencyApiIndexUi();
  }

  async function refreshClientCacheStats() {
    var facade = clientCacheFacade();
    if (!facade) {
      clientCacheUi = { state: 'error', stats: null, error: t('Local cache is unavailable'), operation: '' };
      renderClientCacheUi();
      return null;
    }
    if (!clientCacheUi.operation) {
      clientCacheUi.state = 'loading';
      clientCacheUi.error = '';
      renderClientCacheUi();
    }
    try {
      var stats = await facade.getClientCacheStats();
      clientCacheUi = { state: 'ready', stats: stats || {}, error: '', operation: '' };
      renderClientCacheUi();
      return stats || {};
    } catch (error) {
      clientCacheUi = { state: 'error', stats: null, error: error && error.message ? error.message : t('Unknown error'), operation: '' };
      renderClientCacheUi();
      return null;
    }
  }

  async function setClientCachePolicyFromUi(mode, sizeMiB) {
    if (['off', 'lazy', 'active'].indexOf(mode) < 0) return;
    var facade = clientCacheFacade();
    if (!facade) return;
    clientCacheUi.operation = 'policy';
    renderClientCacheUi();
    try {
      var result = await facade.setClientCachePolicy(mode, sizeMiB);
      settings.clientCacheMode = result && result.clientCacheMode ? result.clientCacheMode : mode;
      settings.clientCacheSizeMiB = clientCacheSizeMiB(result && result.clientCacheSizeMiB !== undefined
        ? result.clientCacheSizeMiB
        : sizeMiB);
      settings.clientCacheDependencyIndexEnabled = result && result.clientCacheDependencyIndexEnabled === true;
      if (S.lsp) S.lsp.settings = settings;
      configureCompletionHintCache();
      clientCacheUi.operation = '';
      await refreshClientCacheStats();
    } catch (error) {
      clientCacheUi.operation = '';
      clientCacheUi.state = 'error';
      clientCacheUi.error = t('Could not update local cache policy: {message}', { message: error && error.message ? error.message : t('Unknown error') });
      renderClientCacheUi();
      if (BOBO.toast) BOBO.toast.error(clientCacheUi.error);
    }
  }

  function getClientCacheScope() {
    var current = clientCompletionCacheScope(currentModel(), false);
    if (current) return current;
    var workspace = workspaceIdentity();
    if (!workspace) return null;
    var language = protocolLanguageId(status && status.languageId) || protocolLanguageId(activeLanguage) || 'plaintext';
    return {
      workspace: workspace,
      languageId: language,
      runtimeId: runtimeForLanguage(language, S.selectedRuntime),
      dependencyRevision: status && status.dependency && status.dependency.revision ? String(status.dependency.revision) : 'unknown'
    };
  }

  async function getClientCacheStats() {
    if (!global.api || typeof global.api.lspClientCacheStats !== 'function') throw new Error(t('Local cache is unavailable'));
    return global.api.lspClientCacheStats(getClientCacheScope());
  }

  async function setClientCachePolicy(mode, sizeMiB) {
    var nextMode = String(mode || '').toLowerCase();
    if (nextMode === 'session') nextMode = 'lazy';
    if (nextMode === 'persistent') nextMode = 'active';
    if (['off', 'lazy', 'active'].indexOf(nextMode) < 0) throw new Error(t('Invalid local cache policy'));
    var nextSize = clientCacheSizeMiB(sizeMiB);
    if (!global.api || typeof global.api.lspSettingsWrite !== 'function') throw new Error(t('Local cache is unavailable'));
    var next = await global.api.lspSettingsWrite({
      mode: settings.mode,
      clientCacheMode: nextMode,
      clientCacheSizeMiB: nextSize,
      clientCacheDependencyIndexEnabled: settings.clientCacheDependencyIndexEnabled === true
    });
    settings = Object.assign({}, settings, next || { clientCacheMode: nextMode, clientCacheSizeMiB: nextSize });
    if (S.lsp) S.lsp.settings = settings;
    configureCompletionHintCache();
    invalidateCompletionContext();
    return settings;
  }

  async function setClientCacheDependencyIndexEnabled(enabled) {
    var nextEnabled = enabled === true;
    if (nextEnabled && !dependencyApiIndexEligible()) throw new Error(t('Invalid local cache policy'));
    if (!global.api || typeof global.api.lspSettingsWrite !== 'function') throw new Error(t('Local cache is unavailable'));
    var next = await global.api.lspSettingsWrite({
      mode: settings.mode,
      clientCacheMode: clientCacheMode(),
      clientCacheSizeMiB: clientCacheSizeMiB(),
      clientCacheDependencyIndexEnabled: nextEnabled
    });
    settings = Object.assign({}, settings, next || { clientCacheDependencyIndexEnabled: nextEnabled });
    if (S.lsp) S.lsp.settings = settings;
    configureCompletionHintCache();
    invalidateCompletionContext();
    if (!nextEnabled && global.api && typeof global.api.lspClientCacheDependencyIndexClear === 'function') {
      try { await global.api.lspClientCacheDependencyIndexClear({ scope: 'all' }); } catch (_) {}
    }
    dependencyApiIndexUi = { state: nextEnabled ? 'loading' : 'disabled', error: '' };
    if (nextEnabled) ensureDependencyApiIndex(currentModel());
    renderStatus();
    return settings;
  }

  function setClientCacheMode(mode) {
    return setClientCachePolicy(mode, clientCacheSizeMiB());
  }

  async function clearClientCache(scope) {
    var clearScope = ['workspace', 'team', 'all'].indexOf(String(scope || '').toLowerCase()) >= 0
      ? String(scope).toLowerCase()
      : 'workspace';
    if (!global.api || typeof global.api.lspClientCacheClear !== 'function') throw new Error(t('Local cache is unavailable'));
    var context = getClientCacheScope();
    if (clearScope !== 'all' && !context) throw new Error(t('Open a workspace to clear its local cache'));
    var result = await global.api.lspClientCacheClear({ scope: clearScope, context: context || undefined });
    // The persistent clear is scoped by the main process. Clearing the small
    // renderer mirror too avoids presenting a just-deleted hint once.
    invalidateCompletionContext();
    return result;
  }

  async function clearClientCacheFromUi(scope) {
    var facade = clientCacheFacade();
    if (!facade) return;
    clientCacheUi.operation = scope;
    clientCacheUi.error = '';
    renderClientCacheUi();
    try {
      await facade.clearClientCache(scope);
      clientCacheUi.operation = '';
      await refreshClientCacheStats();
      if (BOBO.toast) BOBO.toast.success(t('Local cache cleared'));
    } catch (error) {
      clientCacheUi.operation = '';
      clientCacheUi.state = 'error';
      clientCacheUi.error = t('Could not clear local cache: {message}', { message: error && error.message ? error.message : t('Unknown error') });
      renderClientCacheUi();
      if (BOBO.toast) BOBO.toast.error(clientCacheUi.error);
    }
  }

  async function restartAnalysis() {
    if (!activeLspDecision().available || !global.api || typeof global.api.lspControl !== 'function') throw new Error(t('Remote analysis is not ready'));
    return global.api.lspControl({ type: 'lsp.restart' });
  }

  async function clearAnalysisCache() {
    if (status.state !== 'ready' || !activeLspDecision().available) throw new Error(t('Remote analysis is not ready'));
    if (!global.api || typeof global.api.lspControl !== 'function') throw new Error(t('Remote analysis is not ready'));
    if (pendingCacheClear) throw new Error(t('Analysis cache request is already in progress'));
    var response = new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        pendingCacheClear = null;
        reject(new Error(t('Analysis cache request timed out')));
      }, 15000);
      pendingCacheClear = { resolve: resolve, reject: reject, timer: timer };
    });
    try {
      await global.api.lspControl({ type: 'lsp.cache.clear' });
      var result = await response;
      if (result && result.success === false) throw new Error(result.error || result.message || t('Unknown error'));
      return result || { success: true };
    } catch (error) {
      if (pendingCacheClear) {
        clearTimeout(pendingCacheClear.timer);
        pendingCacheClear = null;
      }
      throw error;
    }
  }

  function renderStatus() {
    var chip = document.getElementById('status-lsp');
    if (chip) {
      chip.dataset.state = settings.mode === 'local' ? 'local' : status.state;
      chip.textContent = settings.mode === 'local' ? t('LSP: Local') : (status.state === 'ready' ? t('LSP: Remote') : ((status.state === 'connecting' || status.state === 'initializing') ? t('LSP: Connecting') : t('LSP: Offline')));
      chip.title = stateLabel() + (settings.mode !== 'local' && status.error ? '\n' + t('Reason: {message}', { message: status.error }) : '');
    }
    var stateEl = document.getElementById('lsp-settings-state');
    if (stateEl) {
      stateEl.dataset.state = settings.mode === 'local' ? 'local' : status.state;
      stateEl.textContent = stateLabel();
    }
    var detail = document.getElementById('lsp-settings-detail');
    if (detail) {
      var showError = settings.mode !== 'local' && !!status.error;
      detail.hidden = !showError;
      detail.textContent = showError ? t('Reason: {message}', { message: status.error }) : '';
    }
    var latency = document.getElementById('lsp-metric-latency');
    if (latency) latency.textContent = status.latencyMs === null || status.latencyMs === undefined ? '--' : Math.round(status.latencyMs) + ' ms';
    var traffic = document.getElementById('lsp-metric-traffic');
    if (traffic) traffic.textContent = humanBytes(status.bytesSent) + ' / ' + humanBytes(status.bytesReceived);
    var cache = document.getElementById('lsp-metric-cache');
    if (cache) {
      var cacheValue = status.cache && (status.cache.bytes !== undefined
        ? status.cache.bytes
        : (status.cache.sizeBytes !== undefined ? status.cache.sizeBytes : status.cache.totalBytes));
      cache.textContent = cacheValue === undefined || cacheValue === null ? '--' : humanBytes(cacheValue);
    }
    var index = document.getElementById('lsp-metric-index');
    if (index) {
      var visibleIndexStatus = indexStatus || (status.cache && status.cache.indexStatus ? String(status.cache.indexStatus) : '');
      var indexLabels = { ready: t('Ready'), indexing: t('Indexing'), warm: t('Warm'), cold: t('Cold') };
      index.textContent = visibleIndexStatus ? (indexLabels[visibleIndexStatus.toLowerCase()] || visibleIndexStatus) : '--';
    }
    renderDependencyMetrics();
    var baseDecision = lspFeatureDecision();
    document.querySelectorAll('input[name="lsp-mode"]').forEach(function(input) {
      input.checked = input.value === settings.mode;
      input.disabled = input.value !== 'local' && !baseDecision.available;
      if (input.value !== 'local') input.title = baseDecision.available ? '' : lspUnavailableText(baseDecision);
    });
    var actions = document.getElementById('lsp-settings-actions');
    if (actions) actions.hidden = settings.mode === 'local' || !baseDecision.available;
    renderClientCacheUi();
  }

  async function setMode(mode) {
    if (['local', 'standard', 'full'].indexOf(mode) < 0) return;
    settings.mode = mode;
    if (S.lsp) S.lsp.settings = settings;
    invalidateCompletionContext();
    var next = await global.api.lspSettingsWrite({
      mode: mode,
      clientCacheMode: clientCacheMode(),
      clientCacheSizeMiB: clientCacheSizeMiB(),
      clientCacheDependencyIndexEnabled: settings.clientCacheDependencyIndexEnabled === true
    });
    settings = Object.assign({}, settings, next || {});
    if (S.lsp) S.lsp.settings = settings;
    renderStatus();
    scheduleConfigure();
  }

  function dependenciesChanged() {
    if (settings.mode === 'local' || !activeLspDecision().available || !global.api || !global.api.lspControl) return Promise.resolve(false);
    var identity = lspReconnectIdentityKey();
    // setupCommands participate in the project dependency digest. Re-run the
    // configuration boundary so the main-process transport reconnects when
    // that digest input changed; same-config calls remain a cheap no-op there.
    lastConfigSignature = '';
    scheduleConfigure();
    return getDependencyRefreshCoordinator().request(function() {
      if (identity !== lspReconnectIdentityKey() || status.state !== 'ready') {
        throw new Error(t('Remote analysis is not ready'));
      }
      return global.api.lspControl({ type: 'lsp.dependency.refresh' });
    }, identity);
  }

  function bindUi() {
    var chip = document.getElementById('status-lsp');
    if (chip) chip.addEventListener('click', function() { if (BOBO.settings) BOBO.settings.open('lsp'); });
    document.querySelectorAll('input[name="lsp-mode"]').forEach(function(input) {
      input.addEventListener('change', function() { if (input.checked) setMode(input.value); });
    });
    document.querySelectorAll('input[name="lsp-client-cache-mode"]').forEach(function(input) {
      input.addEventListener('change', function() {
        if (input.checked) setClientCachePolicyFromUi(input.value, clientCacheSizeMiB());
      });
    });
    var clientCacheSize = document.getElementById('lsp-client-cache-size-mib');
    if (clientCacheSize) {
      clientCacheSize.addEventListener('input', function() {
        var output = document.getElementById('lsp-client-cache-size-output');
        var sizeMiB = clientCacheSizeMiB(clientCacheSize.value);
        clientCacheSize.setAttribute('aria-valuetext', sizeMiB + ' MB');
        if (output) output.textContent = sizeMiB + ' MB';
      });
      clientCacheSize.addEventListener('change', function() {
        setClientCachePolicyFromUi(clientCacheMode(), clientCacheSizeMiB(clientCacheSize.value));
      });
    }
    var clearClientWorkspace = document.getElementById('lsp-client-cache-clear-workspace');
    if (clearClientWorkspace) clearClientWorkspace.addEventListener('click', function() { clearClientCacheFromUi('workspace'); });
    var clearClientAll = document.getElementById('lsp-client-cache-clear-all');
    if (clearClientAll) clearClientAll.addEventListener('click', function() { clearClientCacheFromUi('all'); });
    var dependencyIndexToggle = document.getElementById('lsp-client-cache-dependency-index-toggle');
    if (dependencyIndexToggle) dependencyIndexToggle.addEventListener('click', function() {
      setClientCacheDependencyIndexEnabled(!clientCacheDependencyIndexEnabled()).catch(function(error) {
        dependencyApiIndexUi = { state: 'error', error: error && error.message ? error.message : '' };
        renderClientCacheUi();
        if (BOBO.toast) BOBO.toast.error(error && error.message ? error.message : t('Local cache is unavailable'));
      });
    });
    var restart = document.getElementById('lsp-restart');
    if (restart) restart.addEventListener('click', async function() {
      restart.disabled = true;
      restart.setAttribute('aria-busy', 'true');
      restart.textContent = t('Restarting...');
      if (restartButtonTimer) clearTimeout(restartButtonTimer);
      restartButtonTimer = setTimeout(finishRestartButton, 15000);
      try {
        await restartAnalysis();
      } catch (error) {
        finishRestartButton();
        if (BOBO.toast) BOBO.toast.error(error.message);
      }
    });
    var clearCache = document.getElementById('lsp-clear-cache');
    if (clearCache) clearCache.addEventListener('click', async function() {
      if (status.state !== 'ready') {
        if (BOBO.toast) BOBO.toast.error(t('Remote analysis is not ready'));
        return;
      }
      clearCache.disabled = true;
      clearCache.setAttribute('aria-busy', 'true');
      try {
        await clearAnalysisCache();
        if (BOBO.toast) BOBO.toast.success(t('Analysis cache cleared'));
      } catch (error) {
        if (BOBO.toast) BOBO.toast.error(t('Could not clear analysis cache: {message}', { message: error.message }));
      } finally {
        clearCache.disabled = false;
        clearCache.removeAttribute('aria-busy');
      }
    });
  }

  async function init(monacoInstance) {
    monacoRef = monacoInstance;
    try { settings = await global.api.lspSettingsRead(); } catch (_) { settings = { mode: 'local', clientCacheMode: 'lazy', clientCacheSizeMiB: 32, clientCacheDependencyIndexEnabled: false }; }
    if (!settings || ['local', 'standard', 'full'].indexOf(settings.mode) < 0) settings = { mode: 'local', clientCacheMode: 'lazy', clientCacheSizeMiB: 32, clientCacheDependencyIndexEnabled: false };
    if (settings.clientCacheMode === 'session') settings.clientCacheMode = 'lazy';
    if (settings.clientCacheMode === 'persistent') settings.clientCacheMode = 'active';
    if (['off', 'lazy', 'active'].indexOf(settings.clientCacheMode) < 0) settings.clientCacheMode = 'lazy';
    settings.clientCacheSizeMiB = clientCacheSizeMiB(settings.clientCacheSizeMiB);
    settings.clientCacheDependencyIndexEnabled = settings.clientCacheDependencyIndexEnabled === true &&
      settings.clientCacheMode === 'active' && settings.clientCacheSizeMiB >= 30;
    configureCompletionHintCache();
    S.lsp = { settings: settings, status: status };
    await refreshCapabilities();
    registerProviders();
    bindUi();
    capabilityReconnectCoordinator = createCapabilityReconnectCoordinator({
      identity: lspReconnectIdentityKey,
      stop: function() {
        if (configureTimer) {
          clearTimeout(configureTimer);
          configureTimer = null;
        }
        configureGeneration += 1;
        lastConfigSignature = '';
        remoteTransportActive = false;
        return global.api.lspConfigure({ mode: 'local' });
      },
      refresh: function() {
        if (!BOBO.serverCapabilities || typeof BOBO.serverCapabilities.refresh !== 'function') {
          return Promise.resolve({ success: false, reason: 'refresh_unavailable' });
        }
        return BOBO.serverCapabilities.refresh({ reason: 'lsp-reconnect' });
      },
      reconnect: function() {
        return refreshCapabilities().then(function() {
          if (settings.mode === 'local' || !activeLspDecision().available) {
            renderStatus();
            return false;
          }
          lastConfigSignature = '';
          return configure().then(function() { return true; });
        });
      },
      onError: function(error) { console.error('LSP capability reconnect:', error); }
    });
    global.api.onLspStatus(onStatus);
    global.api.onLspNotification(function(message) {
      if (message && message.method === 'textDocument/publishDiagnostics') applyDiagnostics(message.params);
      if (message && message.method === '$/progress' && message.params && message.params.value) {
        var kind = String(message.params.value.kind || '').toLowerCase();
        if (kind === 'begin' || kind === 'report') indexStatus = 'indexing';
        if (kind === 'end') {
          indexStatus = 'ready';
          if (BOBO.environmentActivity) BOBO.environmentActivity.record('index', { outcome: 'completed' });
        }
        renderStatus();
      }
    });
    global.api.onLspCache(function(message) {
      if (message && message.cache) status.cache = message.cache;
      if (pendingCacheClear) {
        clearTimeout(pendingCacheClear.timer);
        var waiter = pendingCacheClear;
        pendingCacheClear = null;
        waiter.resolve(message || { success: false, error: t('Unknown error') });
      }
      if (S.lsp) S.lsp.status = status;
      renderStatus();
    });
    if (typeof global.api.onLspDependencyIndex === 'function') global.api.onLspDependencyIndex(handleDependencyApiIndexMessage);
    global.addEventListener('bobo:language-changed', renderStatus);
    global.addEventListener('bobo:dependencies-changed', dependenciesChanged);
    global.addEventListener('bobo:server-capabilities-changed', function(event) {
      var controlledReconnectRefresh = !!(capabilityReconnectCoordinator && capabilityReconnectCoordinator.isActive() &&
        event && event.detail && event.detail.reason === 'lsp-reconnect');
      configureGeneration += 1;
      lastConfigSignature = '';
      invalidateCompletionContext();
      updateCompletionCapabilities({});
      if (!activeLspDecision().available) {
        var currentDecision = activeLspDecision();
        status = Object.assign({}, status, {
          state: settings.mode === 'local' ? 'local' : 'disabled',
          mode: 'local',
          error: settings.mode === 'local' ? '' : lspUnavailableText(currentDecision, currentDecision.language || activeLanguage)
        });
        clearRemoteMarkers();
        if (S.lsp) S.lsp.status = status;
        renderStatus();
      }
      refreshCapabilities().finally(function() {
        if (!controlledReconnectRefresh) scheduleConfigure();
      });
    });
    monacoRef.editor.onDidCreateModel(function(model) {
      model.onDidChangeContent(function(event) { queueChanges(model, event); });
      model.onWillDispose(function() { closeDocument(model); });
      if (status.state === 'ready') openDocument(model);
    });
    monacoRef.editor.getModels().forEach(function(model) {
      model.onDidChangeContent(function(event) { queueChanges(model, event); });
      model.onWillDispose(function() { closeDocument(model); });
    });
    if (S.editor) {
      S.editor.onDidChangeModel(function() {
        invalidateCompletionContext();
        scheduleConfigure();
      });
      if (S.editor.onDidChangeCursorPosition) {
        S.editor.onDidChangeCursorPosition(function(event) {
          var model = currentModel();
          var snapshot = model && completionSnapshot(model, event && event.position, null);
          if (snapshot && !completionCoordinator.matches(snapshot.uri, snapshot.key)) completionCoordinator.invalidate(snapshot.uri);
          if (model && event && event.position) scheduleCompletionHintPrewarm(model, event.position);
        });
      }
    }
    renderStatus();
    scheduleConfigure();
    // BOBO.lsp publishes its cache facade immediately after init returns. Defer
    // the first stats read so initialization order cannot produce a false error.
    setTimeout(refreshClientCacheStats, 0);
  }

  BOBO.lsp = {
    init: init,
    setMode: setMode,
    getMode: function() { return settings.mode; },
    getStatus: function() { return Object.assign({}, status); },
    workspaceChanged: workspaceChanged,
    credentialsChanged: credentialsChanged,
    identityChanged: identityChanged,
    runtimeChanged: function() {
      invalidateCompletionContext();
      scheduleConfigure();
    },
    dependenciesChanged: dependenciesChanged,
    documentSaved: documentSaved,
    renderStatus: renderStatus,
    getClientCacheScope: getClientCacheScope,
    getClientCacheStats: getClientCacheStats,
    setClientCachePolicy: setClientCachePolicy,
    setClientCacheMode: setClientCacheMode,
    setClientCacheDependencyIndexEnabled: setClientCacheDependencyIndexEnabled,
    clearClientCache: clearClientCache,
    clearAnalysisCache: clearAnalysisCache,
    restartAnalysis: restartAnalysis,
    _helpers: {
      encodeWireUri: encodeWireUri,
      decodeWireUri: decodeWireUri,
      pathInsideRoot: pathInsideRoot,
      protocolLanguageId: protocolLanguageId,
      runtimeForLanguage: runtimeForLanguage,
      normalizeCapabilities: normalizeCapabilities,
      completionTriggerCharacters: completionTriggerCharacters,
      lspCompletionContext: lspCompletionContext,
      dependencyStatusLabel: dependencyStatusLabel,
      refreshCapabilities: refreshCapabilities,
      openWorkspaceResource: openWorkspaceResource,
      mapWorkspaceEdit: mapWorkspaceEdit,
      formattingOptionsForModel: formattingOptionsForModel,
      formattingParamsForModel: formattingParamsForModel
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      encodeWireUri: encodeWireUri,
      decodeWireUri: decodeWireUri,
      pathInsideRoot: pathInsideRoot,
      protocolLanguageId: protocolLanguageId,
      runtimeForLanguage: runtimeForLanguage,
      normalizeCapabilities: normalizeCapabilities,
      createCapabilityReconnectCoordinator: createCapabilityReconnectCoordinator,
      createDependencyRefreshCoordinator: createDependencyRefreshCoordinator,
      createDocumentSyncQueue: createDocumentSyncQueue,
      createRemoteCompletionCoordinator: createRemoteCompletionCoordinator,
      createCompletionHintCache: createCompletionHintCache,
      createDependencyApiIndexCache: createDependencyApiIndexCache,
      normalizeCacheableCompletionResult: normalizeCacheableCompletionResult,
      dependencyCanBackLocalCache: dependencyCanBackLocalCache,
      dependencyApiIndexInsertPage: dependencyApiIndexInsertPage,
      dependencyApiIndexResult: dependencyApiIndexResult,
      dependencyApiIndexCompletions: dependencyApiIndexCompletions,
      mergeLocalCompletionResults: mergeLocalCompletionResults,
      stableCompletionHash: stableCompletionHash,
      completionValueFingerprint: completionValueFingerprint,
      clientCompletionCacheKey: clientCompletionCacheKey,
      completionProviderCapability: completionProviderCapability,
      completionTriggerCharacters: completionTriggerCharacters,
      lspCompletionContext: lspCompletionContext,
      formattingOptionsForModel: formattingOptionsForModel
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
