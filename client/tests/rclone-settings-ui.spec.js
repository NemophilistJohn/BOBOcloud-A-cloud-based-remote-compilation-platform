'use strict';

const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

async function launch(sandbox, externalDirectory) {
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const inheritedPath = process.env[pathKey] || process.env.PATH || '';
  const app = await electron.launch({
    executablePath: electronPath(),
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'),
      BOBO_FORCE_FIRST_RUN: '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      [pathKey]: externalDirectory + path.delimiter + inheritedPath
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

test('rclone selector scans on demand and requires native confirmation for system binaries', async () => {
  test.setTimeout(90000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-ui-'));
  const externalDirectory = path.join(sandbox, 'external-bin');
  const externalBinary = path.join(externalDirectory, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
  fs.mkdirSync(externalDirectory, { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), 'rclone', process.platform === 'win32' ? 'rclone.exe' : 'rclone'), externalBinary);
  if (process.platform !== 'win32') fs.chmodSync(externalBinary, 0o755);

  let fixture;
  try {
    fixture = await launch(sandbox, externalDirectory);
    const { app, page } = fixture;
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.evaluate(() => window.BOBO.settings.open('server'));
    await expect(page.locator('#settings-modal')).toBeVisible();
    await expect(page.locator('#rclone-select-title')).toHaveText('App bundled rclone (Recommended)');
    await expect(page.locator('#rclone-options')).toBeHidden();

    await page.locator('#rclone-path').click();
    await expect(page.locator('#rclone-options')).toBeVisible();
    await expect.poll(() => page.locator('.rclone-option').count()).toBeGreaterThanOrEqual(2);
    const externalOption = page.locator('.rclone-option').filter({ hasText: externalBinary });
    await expect(externalOption).toBeVisible();
    await expect(externalOption).toContainText('Unverified external executable');

    await app.evaluate(({ dialog }) => {
      globalThis.__rcloneWarningDetails = [];
      dialog.showMessageBox = async (_owner, options) => {
        globalThis.__rcloneWarningDetails.push(options);
        return { response: 0 };
      };
    });
    await externalOption.click();
    await expect(page.locator('#rclone-options')).toBeHidden();
    await expect(page.locator('#rclone-select-title')).toHaveText('App bundled rclone (Recommended)');

    await page.locator('#rclone-path').click();
    await expect(page.locator('#rclone-options')).toBeVisible();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_owner, options) => {
        globalThis.__rcloneWarningDetails.push(options);
        return { response: 1 };
      };
    });
    await page.locator('.rclone-option').filter({ hasText: externalBinary }).click();
    await expect(page.locator('#rclone-select-title')).toHaveText('System PATH rclone', { timeout: 20000 });
    await expect(page.locator('#rclone-select-meta')).toHaveText(fs.realpathSync(externalBinary));
    await expect(page.locator('#rclone-status')).toContainText('System PATH rclone available');

    const warnings = await app.evaluate(() => globalThis.__rcloneWarningDetails);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].type).toBe('warning');
    expect(warnings[0].defaultId).toBe(0);
    expect(warnings[0].cancelId).toBe(0);
    expect(warnings[0].detail).toContain(fs.realpathSync(externalBinary));

    await page.locator('#rclone-path').click();
    await expect(page.locator('#rclone-options')).toBeVisible();
    await page.locator('.settings-tab[data-stab="local"]').click();
    await expect(page.locator('#rclone-options')).toBeHidden();
    await page.locator('.settings-tab[data-stab="server"]').click();
    await expect(page.locator('#rclone-select-title')).toHaveText('System PATH rclone');
    await expect(page.locator('#rclone-status')).toContainText('System PATH rclone available');
    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await expect(page.locator('#rclone-status')).toContainText('系统 PATH rclone 可用');
    await page.evaluate(() => window.BOBO.i18n.setLocale('en'));
    await expect(page.locator('#rclone-status')).toContainText('System PATH rclone available');

    await page.screenshot({ path: path.join(os.tmpdir(), 'bobocloud-rclone-selector.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
    await page.locator('#rclone-path').scrollIntoViewIfNeeded();
    await page.locator('#rclone-path').click();
    await expect(page.locator('#rclone-options')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const menu = document.getElementById('rclone-options').getBoundingClientRect();
      const body = document.querySelector('.settings-body').getBoundingClientRect();
      return { menuTop: menu.top, menuBottom: menu.bottom, bodyTop: body.top, bodyBottom: body.bottom };
    });
    expect(geometry.menuTop).toBeGreaterThanOrEqual(geometry.bodyTop - 1);
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.bodyBottom + 1);
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobocloud-rclone-selector-menu.png') });
    await page.evaluate(() => {
      window.__realRcloneSelectBinary = window.BOBO.rclone.selectBinary;
      window.BOBO.rclone.selectBinary = async () => ({
        cancelled: false,
        selection: { source: 'bundled', path: null },
        version: { available: true, source: 'bundled', version: 'rclone v1.64.0' },
        configurationError: 'test configuration failure'
      });
    });
    await page.locator('.rclone-option').first().click();
    await expect(page.locator('#rclone-status')).toContainText('server configuration failed: test configuration failure');
    await expect(page.locator('#rclone-status')).toHaveAttribute('data-state', 'warning');
    await page.evaluate(() => { window.BOBO.rclone.selectBinary = window.__realRcloneSelectBinary; });
    await page.locator('#rclone-path').click();
    await expect(page.locator('#rclone-options')).toBeVisible();
    await page.locator('.rclone-option').first().click();
    await expect(page.locator('#rclone-select-title')).toHaveText('App bundled rclone (Recommended)');
    await expect(page.locator('#rclone-path')).toBeFocused();
    expect(consoleErrors).toEqual([]);
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
