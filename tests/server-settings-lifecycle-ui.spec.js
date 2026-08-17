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
        certificateFingerprint: '', rclonePath: '', syncInterval: 30000, setupCompleted: true
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
