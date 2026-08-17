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

test('plugin details use a reusable source-free workbench tab and restore the prior editor view', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-plugin-details-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'workspace');
  const sourceFile = path.join(workspace, 'main.js');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(sourceFile, 'console.log("details");\n', 'utf8');
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
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    installExamplePackage(userData);
    await page.evaluate(async ({ workspacePath, sourcePath }) => {
      await window.api.plugins.refresh();
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.workspace.openFile(sourcePath, 'main.js');
      window.BOBO.views.openSplit();
      window.__pluginDetailsOriginalModel = window.BOBO.state.editor.getModel();
    }, { workspacePath: workspace, sourcePath: sourceFile });
    await expect.poll(() => page.evaluate(() => window.BOBO.state.currentViewMode)).toBe('split');

    await page.evaluate(() => window.BOBO.pluginDetails.open('example.hello-plugin'));
    const details = page.locator('#plugin-details-view.active');
    await expect(details).toBeVisible();
    await expect(details.locator('.plugin-details-page[data-plugin-id="example.hello-plugin"]')).toBeVisible();
    await expect(details.locator('.plugin-details-title')).toHaveText('Hello Plugin');
    await expect(details.locator('.plugin-details-permission-id')).toHaveText('commands.register');
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => ({
      mode: window.BOBO.state.currentViewMode,
      editorModelUnchanged: window.BOBO.state.editor.getModel() === window.__pluginDetailsOriginalModel,
      fileTabs: window.BOBO.state.tabs.length,
      splitVisible: document.getElementById('split-container').classList.contains('active')
    }))).toEqual({ mode: 'plugin-details', editorModelUnchanged: true, fileTabs: 1, splitVisible: false });

    // Opening the same extension cannot create a duplicate workbench tab.
    await page.evaluate(() => window.BOBO.pluginDetails.open('example.hello-plugin'));
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]')).toHaveCount(1);
    await page.screenshot({ path: evidencePath('plugin-details-main-tab.png'), fullPage: false });

    await page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"] .close').click();
    await expect(page.locator('#plugin-details-view.active')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => ({
      mode: window.BOBO.state.currentViewMode,
      modelRestored: window.BOBO.state.editor.getModel() === window.__pluginDetailsOriginalModel,
      splitVisible: document.getElementById('split-container').classList.contains('active')
    }))).toEqual({ mode: 'split', modelRestored: true, splitVisible: true });

    // The controller emits plugins:changed on uninstall. Active detail tabs
    // must disappear and fall back without exposing package source data.
    await page.evaluate(() => window.BOBO.pluginDetails.open('example.hello-plugin'));
    await expect(details).toBeVisible();
    await page.evaluate(async () => { await window.api.plugins.uninstall('example.hello-plugin'); });
    await expect(page.locator('#plugin-details-view.active')).toHaveCount(0);
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => ({
      activePath: window.BOBO.state.activeTabPath,
      fileTabs: window.BOBO.state.tabs.length,
      modelRestored: window.BOBO.state.editor.getModel() === window.__pluginDetailsOriginalModel
    }))).toEqual({ activePath: sourceFile, fileTabs: 1, modelRestored: true });
    expect(issues).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
