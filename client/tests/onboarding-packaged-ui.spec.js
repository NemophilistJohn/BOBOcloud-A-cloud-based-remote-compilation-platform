'use strict';

const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PACKAGED_EXE = String(process.env.BOBO_INTERNAL_PACKAGED_EXE || '').trim();
if (!PACKAGED_EXE) throw new Error('BOBO_INTERNAL_PACKAGED_EXE is required for the packaged UI test group');
if (!fs.existsSync(PACKAGED_EXE) || !fs.statSync(PACKAGED_EXE).isFile()) {
  throw new Error('BOBO_INTERNAL_PACKAGED_EXE does not point to a packaged executable: ' + PACKAGED_EXE);
}

async function stop(app) {
  if (!app) return;
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}

test('an internal packaged build seeds its server connection without blocking the workbench', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-internal-bootstrap-ui-'));
  let app;
  try {
    const appData = path.join(sandbox, 'appdata');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    app = await electron.launch({
      executablePath: PACKAGED_EXE,
      args: ['--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: appData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'),
        BOBO_FORCE_FIRST_RUN: '0'
      })
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await expect(page.locator('#settings-modal')).toBeHidden();
    const settings = await page.evaluate(() => window.api.readServerSettings());
    expect(settings.setupCompleted).toBe(true);
    expect(String(settings.ip || '').trim()).not.toBe('');
    expect(String(settings.user || '').trim()).not.toBe('');
    await expect(page.locator('#settings-modal')).toBeHidden();
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
