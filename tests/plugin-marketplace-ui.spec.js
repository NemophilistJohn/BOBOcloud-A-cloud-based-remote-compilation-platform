const { test, expect, _electron: electron } = require('playwright/test');
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

async function installMarketplaceMock(app) {
  await app.evaluate(({ ipcMain }) => {
    let installed = false;
    const catalog = () => ({
      registryId: 'official',
      updatedAt: '2026-08-17T00:00:00.000Z',
      fetchedAt: '2026-08-17T00:00:01.000Z',
      revision: 'fixture-revision',
      provenance: 'verified-cache',
      stale: true,
      packages: [
        {
          id: 'bobocloud.local-scm',
          displayName: { en: 'Local Source Control', 'zh-CN': '本地源代码管理', ja: 'ローカルソース管理' },
          description: {
            en: 'Local Git history, changes, branches, and remote operations.',
            'zh-CN': '本地 Git 历史、改动、分支和远程操作。',
            ja: 'ローカル Git の履歴、変更、ブランチ、リモート操作。'
          },
          categories: ['scm', 'official'],
          latest: '1.0.0',
          installedVersion: installed ? '1.0.0' : '',
          installedStatus: installed ? 'disabled' : '',
          updateAvailable: false,
          versions: [{
            version: '1.0.0',
            publishedAt: '2026-08-17T00:00:00.000Z',
            engines: { bobocloud: '>=2.6.0 <3.0.0', pluginApi: '^1.2.0' },
            permissions: ['sourceControl.register', 'scm.git.read', 'scm.git.write'],
            locales: ['en', 'zh-CN', 'ja'],
            size: 46353,
            source: { repository: 'NemophilistJohn/BOBOCLOUD-Compiler-Git-Integration-Plugin-Official-', ref: 'v1.0.0' },
            compatible: true,
            installed: installed
          }]
        },
        {
          id: 'example.remote-metadata',
          displayName: { en: 'Metadata Example', 'zh-CN': '元数据示例', ja: 'メタデータの例' },
          description: { en: '<img data-remote-xss="1">literal metadata', 'zh-CN': '安全元数据', ja: '安全なメタデータ' },
          categories: ['example'],
          latest: '2.0.0',
          installedVersion: '',
          installedStatus: '',
          updateAvailable: false,
          versions: [{
            version: '2.0.0',
            publishedAt: '2026-08-17T00:00:00.000Z',
            engines: { bobocloud: '>=2.6.0 <3.0.0', pluginApi: '^1.2.0' },
            permissions: [],
            locales: ['en'],
            size: 100,
            source: 'official',
            compatible: true,
            installed: false
          }]
        }
      ]
    });

    for (const channel of ['plugins:marketplace-list', 'plugins:marketplace-refresh', 'plugins:marketplace-install']) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle('plugins:marketplace-list', () => catalog());
    ipcMain.handle('plugins:marketplace-refresh', () => catalog());
    ipcMain.handle('plugins:marketplace-install', (_event, request) => {
      if (!request || request.id !== 'bobocloud.local-scm' || Object.keys(request).some((key) => key !== 'id')) {
        const error = new Error('fixture package missing');
        error.code = 'plugins.marketplace.notFound';
        throw error;
      }
      installed = true;
      return { id: request.id, version: '1.0.0', status: 'disabled' };
    });
  });
}

test('Extensions Marketplace renders verified metadata safely, filters it, and installs a selected package', async () => {
  test.setTimeout(90000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-plugin-marketplace-'));
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
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true' && window.BOBO.pluginManagerUI, null, { timeout: 25000 });
    await expect.poll(() => page.evaluate(() => Boolean(window.api.plugins.marketplace))).toBe(true);
    await installMarketplaceMock(app);
    await page.evaluate(async () => { await window.BOBO.pluginManagerUI.refreshMarketplace({ force: true }); });

    await page.locator('#activity-extensions').click();
    const marketplace = page.locator('#extensions-marketplace-view');
    const sourceControl = marketplace.locator('.extensions-marketplace-item[data-package-id="bobocloud.local-scm"]');
    await expect(sourceControl).toBeVisible();
    await expect(marketplace).toContainText('Using verified cached Marketplace catalog');
    await expect(sourceControl.locator('.extensions-marketplace-name')).toHaveText('Local Source Control');
    await expect(sourceControl.locator('.extensions-marketplace-description')).toContainText('Local Git history');
    await expect(sourceControl.locator('.extensions-marketplace-action')).toHaveText('Install');
    await sourceControl.locator('summary').click();
    await expect(sourceControl.locator('.extensions-marketplace-detail-list')).toContainText('sourceControl.register');
    await expect(sourceControl.locator('.extensions-marketplace-detail-list')).toContainText('BOBOCLOUD-Compiler-Git-Integration-Plugin-Official- @ v1.0.0');
    await expect(marketplace.locator('[data-remote-xss="1"]')).toHaveCount(0);
    await expect(marketplace.locator('.extensions-marketplace-item[data-package-id="example.remote-metadata"] .extensions-marketplace-description')).toHaveText('<img data-remote-xss="1">literal metadata');

    await page.locator('#extensions-search-input').fill('metadata example');
    await expect(marketplace.locator('.extensions-marketplace-item')).toHaveCount(1);
    await page.locator('#extensions-search-input').fill('');
    await expect(marketplace.locator('.extensions-marketplace-item')).toHaveCount(2);

    await sourceControl.locator('.extensions-marketplace-action').click();
    await expect(sourceControl.locator('.extensions-marketplace-state')).toHaveText('Installed');
    await expect(sourceControl.locator('.extensions-marketplace-action')).toBeDisabled();

    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('zh-CN'); });
    await expect(sourceControl.locator('.extensions-marketplace-name')).toHaveText('本地源代码管理');
    await expect(sourceControl.locator('.extensions-marketplace-state')).toHaveText('已安装');
    await page.screenshot({ path: evidencePath('plugin-marketplace-installed.png'), fullPage: false });
    expect(issues).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
