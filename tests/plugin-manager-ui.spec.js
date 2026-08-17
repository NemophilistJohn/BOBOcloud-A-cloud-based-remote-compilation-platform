const { test, expect, _electron: electron } = require('playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

function evidencePath(name) {
  const directory = process.env.BOBO_UI_EVIDENCE_DIR || path.join(os.tmpdir(), 'bobo-ui-evidence');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

async function stop(app) {
  if (!app) return;
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}

function installExamplePackage(userData) {
  const sourceRoot = path.join(process.cwd(), 'examples', 'plugins', 'hello-plugin');
  const pluginRoot = path.join(userData, 'plugins', 'example.hello-plugin');
  const sourceManifest = fs.readFileSync(path.join(sourceRoot, 'manifest.json'));
  fs.mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'manifest.json'), path.join(pluginRoot, 'manifest.json'));
  fs.copyFileSync(path.join(sourceRoot, 'dist', 'extension.js'), path.join(pluginRoot, 'dist', 'extension.js'));
  fs.writeFileSync(path.join(pluginRoot, '.bobocloud-install.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'example.hello-plugin',
    version: '1.0.0',
    manifestSha256: crypto.createHash('sha256').update(sourceManifest).digest('hex'),
    installedAt: new Date().toISOString()
  }, null, 2) + '\n');
}

test('Extensions uses a VS Code-style sidebar and opens installed extension details in a workbench tab', async () => {
  test.setTimeout(90000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-extensions-sidebar-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  let app;

  try {
    app = await electron.launch({
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
    const issues = [];
    page.on('pageerror', (error) => issues.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('[plugin-extension:')) issues.push(message.text());
    });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true' && window.BOBO.pluginDetails, null, { timeout: 25000 });
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    installExamplePackage(userData);
    await page.evaluate(async () => { await window.api.plugins.refresh(); });

    // Plugin management no longer lives in the Settings dialog.
    await expect(page.locator('#settings-plugins-tab')).toHaveCount(0);
    await expect(page.locator('[data-spane="plugins"]')).toHaveCount(0);

    await page.locator('#activity-extensions').click();
    await expect(page.locator('#extensions-sidebar')).toHaveClass(/active/);
    await expect(page.locator('#extensions-marketplace-view')).toBeVisible();
    await expect(page.locator('#extensions-marketplace-list')).toBeVisible();

    await page.locator('#extensions-installed-tab').click();
    await expect(page.locator('#extensions-installed-view')).toBeVisible();
    const plugin = page.locator('.extensions-installed-item[data-plugin-id="example.hello-plugin"]');
    await expect(plugin).toBeVisible();
    await expect(plugin).toContainText('Hello Plugin');
    await expect(plugin.locator('.extensions-item-state')).toHaveText('Disabled');

    // A row selection, unlike an action button, opens a web-style detail tab.
    await plugin.click();
    await expect(page.locator('#plugin-details-view.active')).toBeVisible();
    const detail = page.locator('.plugin-details-page[data-plugin-id="example.hello-plugin"]');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.plugin-details-title')).toHaveText('Hello Plugin');
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"][data-tab-path="plugin-details:example.hello-plugin"]')).toBeVisible();

    const permission = detail.locator('.plugin-details-permission').filter({ hasText: 'commands.register' });
    await expect(permission).toBeVisible();
    await expect(permission.locator('[data-plugin-details-action="revoke"]')).toBeVisible();
    await detail.locator('[data-plugin-details-action="enable"]').click();
    await page.waitForFunction(() => window.BOBO.commands.has('example.hello-plugin.hello'), null, { timeout: 15000 });
    await detail.locator('[data-plugin-details-action="disable"]').click();
    await page.waitForFunction(() => !window.BOBO.commands.has('example.hello-plugin.hello'), null, { timeout: 15000 });

    // Static sidebar chrome and generated list state both update from the packs.
    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('zh-CN'); });
    await expect(page.locator('#extensions-installed-tab')).toHaveText('已安装');
    await expect(plugin.locator('.extensions-item-state')).toHaveText('已停用');
    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('ja'); });
    await expect(page.locator('#extensions-installed-tab')).toHaveText('インストール済み');
    await expect(plugin.locator('.extensions-item-state')).toHaveText('無効');
    await page.screenshot({ path: evidencePath('extensions-sidebar-installed.png'), fullPage: false });

    expect(issues).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
