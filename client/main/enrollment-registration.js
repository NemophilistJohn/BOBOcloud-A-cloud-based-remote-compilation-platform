'use strict';
const { createEnrollmentController } = require('./enrollment');
const { authStorageKey } = require('./server-identity');

function registerEnrollment(options) {
  const { app, auth, settings } = options;
  const enrollment = createEnrollmentController(Object.assign({}, options, {
    applySettings: auth.applyServerSettings,
    installSyncCredential: async (credential, previous) => {
      const host = String(credential.host || previous.ip).toLowerCase();
      const hostKey = typeof credential.hostKey === 'string' ? credential.hostKey.trim() : '';
      if (host !== String(previous.ip).toLowerCase() || !['root', 'restricted'].includes(credential.mode) ||
          !Number.isInteger(credential.port) || credential.port < 1 || credential.port > 65535 ||
          !/^[^\s\0\r\n]{1,128}$/.test(credential.user || '') || typeof credential.password !== 'string' || !credential.password ||
          !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+$/.test(hostKey)) throw new Error('enrollment.error.invalidSyncCredential');
      const updated = await auth.applyServerSettings(Object.assign({}, previous, { user: credential.user, pass: credential.password,
        sshPort: credential.port, sshHostKey: hostKey, syncMode: credential.mode, syncManaged: true }), 'sync-credential-updated', false, authStorageKey(previous));
      if (!updated) throw new Error('enrollment.error.save');
    }
  }));
  enrollment.registerIpc();
  for (const value of process.argv) if (value.startsWith('bobocloud://')) enrollment.captureIncoming(value);
  if (app.isPackaged) app.setAsDefaultProtocolClient('bobocloud');
  app.on('open-url', (event, value) => { event.preventDefault(); enrollment.captureIncoming(value); });
  app.on('second-instance', (_event, argv) => {
    for (const value of argv || []) if (value.startsWith('bobocloud://')) enrollment.captureIncoming(value);
    const window = options.getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  });
  return enrollment;
}
module.exports = { registerEnrollment };
