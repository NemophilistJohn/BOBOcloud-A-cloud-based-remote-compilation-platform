const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

async function launch(sandbox) {
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath(),
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'),
      BOBO_FORCE_FIRST_RUN: '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    })
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
  return { app, page };
}

async function stop(app) {
  try { await app.evaluate(({ app }) => app.exit(0)); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}

test('saving local sync preferences preserves active cloud session lifecycle', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-server-settings-'));
  let fixture;
  try {
    fixture = await launch(sandbox);
    const { page } = fixture;
    await page.evaluate(async () => {
      const state = window.BOBO.state;
      const config = {
        ip: 'compiler.example', user: 'tester', pass: 'secret', apiKey: '',
        secureTransport: false, httpPort: 3100, wsPort: 3101, dapChildWsPort: 3102,
        certificateFingerprint: '', syncInterval: 30000, setupCompleted: true
      };
      await window.api.writeServerSettings(config);
      state.serverSettings = await window.api.readServerSettings();
      const calls = window.__serverLifecycleCalls = { auth: 0, dap: 0, run: 0, lsp: 0, autoSync: 0 };
      window.BOBO.auth.onServerChanged = async () => { calls.auth += 1; return { success: true }; };
      window.BOBO.dap.abort = async () => { calls.dap += 1; };
      window.BOBO.runner.invalidateRunIdentity = async () => { calls.run += 1; };
      window.BOBO.lsp.workspaceChanged = () => { calls.lsp += 1; };
      window.BOBO.runner.setupAutoSync = () => { calls.autoSync += 1; };
      window.BOBO.runner.checkRcloneAvailability = () => {};
      window.BOBO.rclone.checkVersion = async () => ({ available: true, version: 'test' });
      window.BOBO.settings.open('server');
    });
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.locator('#sync-interval').fill('45');
    await page.locator('#server-save').click();
    await expect(page.locator('#settings-modal')).toBeHidden();
    expect(await page.evaluate(() => window.__serverLifecycleCalls)).toEqual({ auth: 0, dap: 0, run: 0, lsp: 0, autoSync: 1 });
    expect(await page.evaluate(() => window.BOBO.state.serverSettings.syncInterval)).toBe(45000);
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('SSH account changes require a new password and failed validation rolls settings back', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-server-ssh-settings-'));
  let fixture;
  try {
    fixture = await launch(sandbox);
    const { page } = fixture;
    await page.evaluate(async () => {
      await window.api.writeServerSettings({
        ip: 'compiler.example', user: 'tester', pass: 'old-secret', apiKey: '',
        secureTransport: false, httpPort: 3100, wsPort: 3101, dapChildWsPort: 3102,
        certificateFingerprint: '', syncInterval: 30000, setupCompleted: true
      });
      await window.api.commitServerSettings();
      window.BOBO.state.serverSettings = await window.api.readServerSettings();
      window.__sshValidationCalls = { auth: 0, rclone: 0 };
      window.BOBO.auth.onServerChanged = async () => {
        window.__sshValidationCalls.auth += 1;
        return { success: true };
      };
      window.BOBO.rclone.validateConnection = async () => {
        window.__sshValidationCalls.rclone += 1;
        return { success: false, error: { type: 'AUTH_FAILED', message: 'Authentication failed' } };
      };
      window.BOBO.rcloneSettings.refreshStatus = () => {};
      window.BOBO.settings.open('server');
    });
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.locator('#server-user').fill('other-user');
    await page.locator('#server-save').click();
    await expect(page.locator('#server-connect-status')).toContainText('password are required');
    expect(await page.evaluate(async () => (await window.api.readServerSettings()).user)).toBe('tester');

    await page.locator('#server-pass').fill('wrong-secret');
    await page.locator('#server-save').click();
    await expect(page.locator('#server-connect-status')).toContainText('Could not connect to the server');
    await expect(page.locator('#settings-modal')).toBeVisible();
    expect(await page.evaluate(() => window.__sshValidationCalls)).toEqual({ auth: 0, rclone: 1 });
    expect(await page.evaluate(async () => {
      const stored = await window.api.readServerSettings();
      return { user: stored.user, pass: stored.pass, passConfigured: stored.passConfigured };
    })).toEqual({ user: 'tester', pass: '', passConfigured: true });
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
