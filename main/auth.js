function createAuthController(options) {
  const ipcMain = options.ipcMain;
  const settings = options.settings;
  const onStateChanged = options.onStateChanged || (() => {});
  const disposeLsp = options.disposeLsp || (() => {});
  let currentState = { loggedIn: false, role: '' };

  function registerIpc() {
    ipcMain.handle('read-server-settings', async () => settings.readServerSettings());
    ipcMain.handle('write-server-settings', async (_event, nextSettings) => {
      disposeLsp();
      return settings.writeServerSettings(nextSettings);
    });
    ipcMain.handle('auth-get', async (_event, serverIp) => {
      if (!serverIp) return null;
      return settings.readAuth().servers[serverIp] || null;
    });
    ipcMain.handle('auth-set', async (_event, payload) => {
      if (!payload || !payload.serverIp) return false;
      disposeLsp();
      const data = settings.readAuth();
      if (payload.credential) {
        data.servers[payload.serverIp] = Object.assign({}, payload.credential, { savedAt: Date.now() });
      } else {
        delete data.servers[payload.serverIp];
      }
      return settings.writeAuth(data);
    });
    ipcMain.handle('auth-clear', async (_event, serverIp) => {
      disposeLsp();
      const data = settings.readAuth();
      if (serverIp) delete data.servers[serverIp];
      else data.servers = {};
      return settings.writeAuth(data);
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
    getState: () => Object.assign({}, currentState)
  };
}

module.exports = { createAuthController };
