'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerEnrollment } = require('../main/enrollment-registration');

function createRegistration() {
  const previous = {
    ip: '81.70.51.43', secureTransport: true, httpPort: 3100, wsPort: 3101,
    dapChildWsPort: 3102, certificateFingerprints: ['AA'.repeat(32)],
    user: '', pass: '', syncManaged: false
  };
  let installed;
  const enrollment = registerEnrollment({
    app: { isPackaged: false, on() {} },
    auth: { applyServerSettings: async (value) => { installed = value; return true; } },
    settings: { readServerSettings: async () => previous, readAuth: () => ({ servers: {} }), writeAuth: () => true },
    ipcMain: { handle() {} },
    session: {},
    getWindow: () => null
  });
  return { enrollment, getInstalled: () => installed, previous };
}

test('restricted SFTP host keys are normalized before credential installation', async (t) => {
  const fixture = createRegistration();
  t.after(() => fixture.enrollment.dispose());
  const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6';
  const installed = await fixture.enrollment.installCredential({ data: { syncCredential: {
    mode: 'restricted', host: fixture.previous.ip, port: 3103, user: 'bobocloud',
    password: 'short-session-token', hostKey: hostKey + '\n'
  } } }, fixture.previous);
  assert.equal(installed, true);
  assert.equal(fixture.getInstalled().sshHostKey, hostKey);
  assert.equal(fixture.getInstalled().sshPort, 3103);
  assert.equal(fixture.getInstalled().syncManaged, true);
});

test('sync credential host-key validation still rejects embedded newlines', async (t) => {
  const fixture = createRegistration();
  t.after(() => fixture.enrollment.dispose());
  const installed = await fixture.enrollment.installCredential({ data: { syncCredential: {
    mode: 'restricted', host: fixture.previous.ip, port: 3103, user: 'bobocloud',
    password: 'short-session-token', hostKey: 'ssh-ed25519 AAAA\nmalicious'
  } } }, fixture.previous);
  assert.equal(installed, false);
  assert.equal(fixture.getInstalled(), undefined);
});
