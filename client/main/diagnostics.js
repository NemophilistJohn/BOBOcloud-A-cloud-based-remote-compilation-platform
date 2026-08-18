function registerDiagnosticsIpc(options) {
  const ipcMain = options.ipcMain;
  const settings = options.settings;
  ipcMain.handle('diagnostics-read', async () => settings.readDiagnosticsSettings());
  ipcMain.handle('diagnostics-write', async (_event, nextSettings) => settings.writeDiagnosticsSettings(nextSettings));
}

module.exports = { registerDiagnosticsIpc };
