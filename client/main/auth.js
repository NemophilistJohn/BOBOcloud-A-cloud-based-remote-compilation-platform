const {
  authStorageKey,
  credentialForServer,
  legacyAuthStorageKeys,
  rcloneConnectionIdentity,
  serverTransportIdentity
} = require('./server-identity');

function rendererServerSettings(value) {
  const settings = Object.assign({}, value || {});
  settings.passConfigured = Boolean(settings.pass);
  settings.pass = '';
  return settings;
}

function createAuthController(options) {
  const ipcMain = options.ipcMain;
  const settings = options.settings;
  const onStateChanged = options.onStateChanged || (() => {});
  const onServerSettingsWritten = options.onServerSettingsWritten || (() => {});
  const onCredentialChanged = options.onCredentialChanged || (() => {});
  const disposeLsp = options.disposeLsp || (() => {});
  let currentState = { loggedIn: false, role: '' };
  let settingsRollbackSnapshot = null;

  async function applyServerSettings(nextSettings, reason, captureRollback) {
    const previous = await settings.readServerSettings();
    const requested = Object.assign({}, nextSettings || {});
    if (!requested.pass && requested.passConfigured === true) requested.pass = previous.pass;
    delete requested.passConfigured;
    const prospectiveConnectionChanged = serverTransportIdentity(previous) !== serverTransportIdentity(requested);
    const prospectiveRcloneChanged = rcloneConnectionIdentity(previous) !== rcloneConnectionIdentity(requested);
    if (captureRollback && !settingsRollbackSnapshot && (prospectiveConnectionChanged || prospectiveRcloneChanged)) {
      settingsRollbackSnapshot = previous;
    }
    const wrote = await settings.writeServerSettings(requested);
    if (!wrote) return false;
    const current = await settings.readServerSettings();
    const connectionChanged = serverTransportIdentity(previous) !== serverTransportIdentity(current);
    const rcloneChanged = rcloneConnectionIdentity(previous) !== rcloneConnectionIdentity(current);
    if (connectionChanged) await Promise.resolve(disposeLsp(reason));
    await Promise.resolve(onServerSettingsWritten(current, { previous, connectionChanged, rcloneChanged, reason }));
    return true;
  }

  function registerIpc() {
    ipcMain.handle('read-server-settings', async () => rendererServerSettings(await settings.readServerSettings()));
    ipcMain.handle('write-server-settings', async (_event, payload) => {
      if (payload && payload.__serverSettingsAction === 'commit') {
        settingsRollbackSnapshot = null;
        return true;
      }
      if (payload && payload.__serverSettingsAction === 'rollback') {
        if (!settingsRollbackSnapshot) return true;
        const rollback = settingsRollbackSnapshot;
        const restored = await applyServerSettings(rollback, 'server-settings-rollback', false);
        if (restored) settingsRollbackSnapshot = null;
        return restored;
      }
      return applyServerSettings(payload, 'server-settings-changed', true);
    });
    ipcMain.handle('auth-get', async () => {
      const serverSettings = await settings.readServerSettings();
      if (!serverSettings.ip) return null;
      const data = settings.readAuth();
      const found = credentialForServer(data, serverSettings);
      if (found.credential && found.legacy) {
        data.servers[authStorageKey(serverSettings)] = found.credential;
        for (const key of legacyAuthStorageKeys(serverSettings)) delete data.servers[key];
        settings.writeAuth(data);
      }
      return found.credential;
    });
    ipcMain.handle('auth-set', async (_event, payload) => {
      if (!payload || !payload.credential || typeof payload.credential !== 'object') return false;
      const serverSettings = await settings.readServerSettings();
      if (!serverSettings.ip) return false;
      const data = settings.readAuth();
      const previous = credentialForServer(data, serverSettings).credential;
      const next = Object.assign({}, payload.credential, { savedAt: Date.now() });
      data.servers[authStorageKey(serverSettings)] = next;
      for (const key of legacyAuthStorageKeys(serverSettings)) delete data.servers[key];
      const wrote = settings.writeAuth(data);
      if (wrote && (!previous || previous.token !== next.token ||
          String(previous.user && (previous.user.uid || previous.user.id) || '') !== String(next.user && (next.user.uid || next.user.id) || ''))) {
        await Promise.resolve(disposeLsp('credential-changed'));
        await Promise.resolve(onCredentialChanged({ type: 'set', serverSettings }));
      }
      return wrote;
    });
    ipcMain.handle('auth-clear', async () => {
      const serverSettings = await settings.readServerSettings();
      const data = settings.readAuth();
      const found = credentialForServer(data, serverSettings);
      delete data.servers[authStorageKey(serverSettings)];
      for (const key of legacyAuthStorageKeys(serverSettings)) delete data.servers[key];
      const wrote = settings.writeAuth(data);
      if (wrote && found.credential) {
        await Promise.resolve(disposeLsp('credential-cleared'));
        await Promise.resolve(onCredentialChanged({ type: 'clear', serverSettings }));
      }
      return wrote;
    });
    ipcMain.on('auth-state-update', (_event, state) => {
      currentState = {
        loggedIn: Boolean(state && state.loggedIn),
        role: state && state.role || ''
      };
      onStateChanged(currentState);
    });
  }

  return {
    registerIpc,
    applyServerSettings,
    discardServerSettingsRollback: () => { settingsRollbackSnapshot = null; },
    getState: () => Object.assign({}, currentState)
  };
}

module.exports = { createAuthController, rendererServerSettings };
