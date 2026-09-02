const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

async function launchIsolatedApp(prefix) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath(),
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
    })
  });
  const page = await app.firstWindow();
  const issues = [];
  page.on('pageerror', error => issues.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text());
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.boboReady === 'true',
    null,
    { timeout: 20000 }
  );
  return { app, page, sandbox, issues };
}

async function closeIsolatedApp(fixture) {
  if (!fixture) return;
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
  await fs.promises.rm(fixture.sandbox, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 200
  });
}

async function openDiagnosticsFromMain(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
    if (!target) throw new Error('Workbench window is unavailable.');
    target.webContents.send('open-diagnostics-settings');
  });
  await expect(page.locator('#diag-modal')).toBeVisible();
}

async function readForm(page) {
  return page.locator('#diag-modal').evaluate(modal => ({
    enabled: modal.querySelector('.diag-global-row input[type="checkbox"]').checked,
    checkOn: modal.querySelector('.diag-global-row select').value,
    debounceMs: Number(modal.querySelector('.diag-global-row input[type="number"]').value),
    missingSemicolonEnabled: modal.querySelector('input[data-check-id="missingSemicolon"]').checked,
    missingSemicolonSeverity: modal.querySelector('select[data-check-id="missingSemicolon"]').value
  }));
}

async function readAppliedSettings(page) {
  return page.evaluate(() => {
    const state = window.BOBO.state.diagnosticsSettings;
    const registry = window.editorRuleRegistry.getDiagnosticsSettings();
    const project = value => ({
      enabled: value.enabled,
      checkOn: value.checkOn,
      debounceMs: value.debounceMs,
      missingSemicolonEnabled: value.checks.missingSemicolon.enabled,
      missingSemicolonSeverity: value.checks.missingSemicolon.severity
    });
    return { state: project(state), registry: project(registry) };
  });
}

test('Diagnostics modal preserves drafts and commits only a successful save', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launchIsolatedApp('bobo-diagnostics-settings-');
    const { app, page } = fixture;
    await page.setViewportSize({ width: 1100, height: 760 });
    await expect.poll(() => page.evaluate(() => Boolean(
      window.BOBO
      && window.BOBO.state
      && window.BOBO.state.diagnosticsSettings
      && window.editorRuleRegistry
    ))).toBe(true);

    const skipFirstRun = page.locator('#server-skip-first-run');
    if (await skipFirstRun.isVisible()) {
      await skipFirstRun.click();
      await expect(page.locator('#settings-modal')).toBeHidden();
    }

    await page.evaluate(() => {
      window.__diagnosticsRecheckCount = 0;
      const original = window.BOBO.editorCore.recheckAll;
      window.BOBO.editorCore.recheckAll = function(...args) {
        window.__diagnosticsRecheckCount += 1;
        return original.apply(this, args);
      };
    });

    await openDiagnosticsFromMain(app, page);
    await page.locator('#diag-body .diag-global-row .diag-toggle .slider').first().click();
    await page.locator('#diag-body .diag-global-row select').selectOption('save');
    await page.locator('#diag-body .diag-global-row input[type="number"]').fill('0');
    await page.locator('input[data-check-id="missingSemicolon"] + .slider').click();
    await page.locator('select[data-check-id="missingSemicolon"]').selectOption('hint');

    const savedSettings = {
      enabled: false,
      checkOn: 'save',
      debounceMs: 0,
      missingSemicolonEnabled: false,
      missingSemicolonSeverity: 'hint'
    };
    expect(await readForm(page)).toEqual(savedSettings);

    await page.evaluate(() => window.BOBO.i18n.setLocale('ja'));
    await expect(page.locator('#diag-modal .ss-title')).toHaveText('診断設定');
    await expect(page.locator('#diag-body')).toContainText('セミコロンの欠落');
    expect(await readForm(page)).toEqual(savedSettings);

    await page.locator('#diag-save').click();
    await expect(page.locator('#diag-modal')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__diagnosticsRecheckCount)).toBeGreaterThan(0);
    await expect.poll(() => readAppliedSettings(page)).toEqual({
      state: savedSettings,
      registry: savedSettings
    });

    await openDiagnosticsFromMain(app, page);
    expect(await readForm(page)).toEqual(savedSettings);

    await page.locator('#diag-reset').click();
    expect(await readForm(page)).toEqual({
      enabled: true,
      checkOn: 'type',
      debounceMs: 300,
      missingSemicolonEnabled: true,
      missingSemicolonSeverity: 'error'
    });
    await page.locator('#diag-close').click();
    await expect(page.locator('#diag-modal')).toBeHidden();
    expect(await readAppliedSettings(page)).toEqual({
      state: savedSettings,
      registry: savedSettings
    });

    await openDiagnosticsFromMain(app, page);
    expect(await readForm(page)).toEqual(savedSettings);
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    const diagnosticsPath = path.resolve(userData, 'diagnostics-settings.json');
    const sandboxRoot = path.resolve(fixture.sandbox) + path.sep;
    if (!diagnosticsPath.startsWith(sandboxRoot)) {
      throw new Error('Diagnostics failure fixture escaped its isolated sandbox.');
    }
    fs.rmSync(diagnosticsPath, { force: true });
    fs.mkdirSync(diagnosticsPath);

    await page.locator('#diag-body .diag-global-row .diag-toggle .slider').first().click();
    const failedDraft = { ...savedSettings, enabled: true };
    expect(await readForm(page)).toEqual(failedDraft);
    await page.locator('#diag-save').click();
    await expect(page.locator('#diag-modal')).toBeVisible();
    expect(await readForm(page)).toEqual(failedDraft);
    expect(await readAppliedSettings(page)).toEqual({ state: savedSettings, registry: savedSettings });
    const failureMessage = await page.evaluate(() => (
      window.BOBO.i18n.t('Failed to save diagnostics settings')
    ));
    await expect(page.locator('.toast-error .toast-msg').last()).toHaveText(failureMessage);
    await page.locator('#diag-close').click();
    await expect(page.locator('#diag-modal')).toBeHidden();

    await page.evaluate(() => window.BOBO.settings.open('local'));
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.locator('#settings-diag-enabled + .slider').click();
    await page.locator('#settings-diag-mode').selectOption('type');
    await page.locator('#settings-save-local').click();
    await expect(page.locator('#settings-modal')).toBeVisible();
    await expect(page.locator('#settings-diag-enabled')).toBeChecked();
    await expect(page.locator('#settings-diag-mode')).toHaveValue('type');
    await expect(page.locator('.toast-error .toast-msg').last()).toHaveText(failureMessage);
    expect(await readAppliedSettings(page)).toEqual({ state: savedSettings, registry: savedSettings });
    await page.evaluate(() => window.BOBO.settings.close());
    await expect(page.locator('#settings-modal')).toBeHidden();
    expect(fixture.issues).toEqual([]);
  } finally {
    await closeIsolatedApp(fixture);
  }
});
