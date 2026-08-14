const fs = require('fs');
const { LspTransport } = require('../lsp-transport');
const {
  ClientAnalysisCache,
  normalizeScope: normalizeClientAnalysisScope
} = require('../client-analysis-cache');

function createLspController(options) {
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const settings = options.settings;
  let transport = null;
  let analysisCache = null;

  function cachePolicy() {
    const current = settings.readLspSettings();
    return {
      mode: current.clientCacheMode,
      sizeMiB: current.clientCacheSizeMiB,
      dependencyIndexEnabled: current.clientCacheDependencyIndexEnabled === true
    };
  }

  function ensureAnalysisCache() {
    if (!analysisCache) {
      analysisCache = new ClientAnalysisCache({ baseDir: settings.paths.clientAnalysisCache });
      const policy = cachePolicy();
      if (policy.mode === 'off') {
        analysisCache.clear({ scope: 'all' }, { mode: 'active', sizeMiB: policy.sizeMiB }).catch(() => {});
      } else {
        analysisCache.prune(policy, false).catch(() => {});
      }
    }
    return analysisCache;
  }

  function readCacheServerIdentity() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settings.paths.server, 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function cacheServerId(serverSettings) {
    return String(serverSettings && serverSettings.ip || '').trim().toLowerCase() || 'local-profile';
  }

  function cacheUserId(serverSettings) {
    const host = String(serverSettings && serverSettings.ip || '');
    const credential = host ? settings.readAuth().servers[host] : null;
    const user = credential && credential.user;
    return String(user && (user.uid || user.id || user.userId || user.username) || 'local-profile');
  }

  function rendererCacheScope(rawScope) {
    const serverSettings = readCacheServerIdentity();
    const raw = rawScope && typeof rawScope === 'object' ? rawScope : {};
    return normalizeClientAnalysisScope(Object.assign({}, raw, {
      serverId: cacheServerId(serverSettings),
      userId: cacheUserId(serverSettings)
    })).value;
  }

  async function currentCredential() {
    const serverSettings = await settings.readServerSettings();
    const serverKey = serverSettings.ip || '';
    const stored = settings.readAuth().servers[serverKey];
    if (stored && stored.token && (!stored.expiresAt || stored.expiresAt > Date.now())) return stored.token;
    return serverSettings.apiKey || '';
  }

  function ensureTransport() {
    if (transport) return transport;
    transport = new LspTransport({
      getCredential: currentCredential,
      emit: (channel, payload) => {
        const window = getWindow();
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('lsp:' + channel, payload);
        }
      }
    });
    return transport;
  }

  function dispose() {
    if (!transport) return;
    transport.dispose();
    transport = null;
  }

  function initializeRetentionPolicy() {
    if (cachePolicy().mode === 'off') ensureAnalysisCache();
  }

  function registerIpc() {
    ipcMain.handle('lsp:settings-read', async () => settings.readLspSettings());
    ipcMain.handle('lsp:settings-write', async (_event, nextSettings) => {
      const previous = settings.readLspSettings();
      const next = settings.writeLspSettings(nextSettings);
      if (previous.clientCacheMode !== 'off' && next.clientCacheMode === 'off') {
        await ensureAnalysisCache().clear({ scope: 'all' }, { mode: 'active', sizeMiB: previous.clientCacheSizeMiB });
      } else if (next.clientCacheMode !== 'off') {
        await ensureAnalysisCache().prune({
          mode: next.clientCacheMode,
          sizeMiB: next.clientCacheSizeMiB,
          dependencyIndexEnabled: next.clientCacheDependencyIndexEnabled === true
        }, true);
      }
      if (previous.clientCacheDependencyIndexEnabled && !next.clientCacheDependencyIndexEnabled) {
        await ensureAnalysisCache().clearDependencyIndexes(
          { scope: 'all' },
          { mode: 'active', sizeMiB: previous.clientCacheSizeMiB }
        );
      }
      return next;
    });
    ipcMain.handle('lsp:client-cache-get', async (_event, scope, key) => {
      return ensureAnalysisCache().get(rendererCacheScope(scope), key, cachePolicy());
    });
    ipcMain.handle('lsp:client-cache-put', async (_event, scope, key, value) => {
      return ensureAnalysisCache().put(rendererCacheScope(scope), key, value, cachePolicy());
    });
    ipcMain.handle('lsp:client-cache-stats', async (_event, scope) => {
      const normalized = scope && typeof scope === 'object' && scope.workspace ? rendererCacheScope(scope) : null;
      return ensureAnalysisCache().stats(normalized, cachePolicy());
    });
    ipcMain.handle('lsp:client-cache-clear', async (_event, request) => {
      const raw = typeof request === 'string' ? { scope: request } : (request && typeof request === 'object' ? request : {});
      const context = raw.context && typeof raw.context === 'object'
        ? rendererCacheScope(raw.context)
        : (raw.scope && typeof raw.scope === 'object' && raw.scope.workspace ? rendererCacheScope(raw.scope) : null);
      return ensureAnalysisCache().clear({
        scope: typeof raw.scope === 'string' ? raw.scope : 'workspace',
        context
      }, cachePolicy());
    });
    ipcMain.handle('lsp:client-cache-prune', async (_event, force) => {
      return ensureAnalysisCache().prune(cachePolicy(), force === true);
    });
    ipcMain.handle('lsp:client-cache-dependency-index-get', async (_event, scope, key) => {
      return ensureAnalysisCache().getDependencyIndex(rendererCacheScope(scope), key, cachePolicy());
    });
    ipcMain.handle('lsp:client-cache-dependency-index-put', async (_event, scope, key, value) => {
      return ensureAnalysisCache().putDependencyIndex(rendererCacheScope(scope), key, value, cachePolicy());
    });
    ipcMain.handle('lsp:client-cache-dependency-index-clear', async (_event, request) => {
      const raw = typeof request === 'string' ? { scope: request } : (request && typeof request === 'object' ? request : {});
      const context = raw.context && typeof raw.context === 'object' ? rendererCacheScope(raw.context) : null;
      return ensureAnalysisCache().clearDependencyIndexes({
        scope: typeof raw.scope === 'string' ? raw.scope : 'workspace',
        context
      }, cachePolicy());
    });
    ipcMain.handle('lsp:configure', async (_event, config) => {
      const serverSettings = await settings.readServerSettings();
      return ensureTransport().configure(Object.assign({}, config, { serverHost: serverSettings.ip || '' }));
    });
    ipcMain.handle('lsp:request', async (_event, payload) => {
      if (!payload || typeof payload.method !== 'string') throw new Error('Invalid LSP request');
      return ensureTransport().request(payload.method, payload.params, payload.requestKey, payload.timeoutMs);
    });
    ipcMain.handle('lsp:notify', async (_event, payload) => {
      if (!payload || typeof payload.method !== 'string') throw new Error('Invalid LSP notification');
      return ensureTransport().notify(payload.method, payload.params);
    });
    ipcMain.handle('lsp:cancel', async (_event, requestKey) => ensureTransport().cancel(String(requestKey || '')));
    ipcMain.handle('lsp:control', async (_event, payload) => {
      const allowedTypes = ['lsp.restart', 'lsp.cache.clear', 'lsp.dependency.refresh', 'lsp.dependency.index.request'];
      if (!payload || !allowedTypes.includes(payload.type)) throw new Error('Invalid LSP control');
      const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {};
      if (payload.type === 'lsp.dependency.index.request') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const cursor = typeof params.cursor === 'string' ? params.cursor : '';
        const maxBytes = Number.isInteger(params.maxBytes) ? params.maxBytes : 0;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(requestId) || cursor.length > 128 ||
            (maxBytes !== 0 && (maxBytes < 64 * 1024 || maxBytes > 190 * 1024))) {
          throw new Error('Invalid dependency API index control');
        }
        return ensureTransport().sendControl(payload.type, { requestId, cursor, maxBytes });
      }
      return ensureTransport().sendControl(payload.type, params);
    });
    ipcMain.handle('lsp:status', async () => ensureTransport().snapshot());
  }

  return { registerIpc, initializeRetentionPolicy, dispose };
}

module.exports = { createLspController };
