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

function installNotebookFixture(userData) {
  const id = 'example.notebook-fixture';
  const viewerId = id + '.viewer';
  const files = {
    'dist/extension.js': 'export function activate(context) { return context.documentViews.register({ id: "example.notebook-fixture.viewer", title: "Notebook Fixture" }); }',
    'dist/view.js': 'export function activate(context) { context.root.textContent = "Notebook fixture is visible"; }'
  };
  const digest = (contents) => crypto.createHash('sha256').update(contents).digest('hex');
  const manifest = JSON.stringify({
    schemaVersion: 2, id, version: '1.0.0', displayName: 'Notebook Fixture',
    engines: { bobocloud: '>=2.8.1', pluginApi: '>=1.3.0' },
    main: 'dist/extension.js', activationEvents: ['onStartupFinished'],
    permissions: ['documentViews.register', 'documents.read'],
    contributes: { documentViewers: [{ id: viewerId, extensions: ['.ipynb'], entry: 'dist/view.js' }] },
    integrity: { algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])) }
  });
  const root = path.join(userData, 'plugins', id);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(root, '.bobocloud-install.json'), JSON.stringify({
    schemaVersion: 1, id, version: '1.0.0', manifestSha256: digest(manifest), installedAt: new Date().toISOString()
  }));
}

test('plugin details use a reusable source-free workbench tab alongside the existing split editor', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-plugin-details-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'workspace');
  const sourceFile = path.join(workspace, 'main.js');
  const secondFile = path.join(workspace, 'second.js');
  const notebookFile = path.join(workspace, 'fixture.ipynb');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(sourceFile, 'console.log("details");\n', 'utf8');
  fs.writeFileSync(secondFile, 'console.log("second");\n', 'utf8');
  fs.writeFileSync(notebookFile, '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}', 'utf8');
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
    installNotebookFixture(userData);
    await page.evaluate(async ({ workspacePath, sourcePath, secondPath }) => {
      await window.api.plugins.refresh();
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.workspace.openFile(sourcePath, 'main.js');
      await window.BOBO.workspace.openFile(secondPath, 'second.js');
      window.BOBO.views.openSplit();
      window.__pluginDetailsOriginalModel = window.BOBO.state.editor.getModel();
    }, { workspacePath: workspace, sourcePath: sourceFile, secondPath: secondFile });
    await expect.poll(() => page.evaluate(() => window.BOBO.state.currentViewMode)).toBe('split');

    await page.evaluate(() => window.BOBO.pluginDetails.open('example.hello-plugin'));
    const details = page.locator('#plugin-details-view.active');
    await expect(details).toBeVisible();
    await expect(details.locator('.plugin-details-page[data-plugin-id="example.hello-plugin"]')).toBeVisible();
    await expect(details.locator('.plugin-details-title')).toHaveText('Hello Plugin');
    await expect(details.locator('.plugin-details-permission-id')).toHaveText('commands.register');
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]')).toHaveCount(1);
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"] .tab-title')).toHaveAttribute('draggable', 'true');
    const detailTab = page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]');
    const mainTab = page.locator('#tabbar .tab:not([data-tab-provider])', { hasText: 'main.js' });
    const detailBounds = await detailTab.locator('.tab-title').boundingBox();
    const mainBounds = await mainTab.boundingBox();
    if (!detailBounds || !mainBounds) throw new Error('Plugin and file tabs must be visible for drag regression');
    const startX = detailBounds.x + detailBounds.width / 2;
    const startY = detailBounds.y + detailBounds.height / 2;
    const approachY = mainBounds.y + mainBounds.height + 12;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 8, startY, { steps: 2 });
    await page.mouse.move(startX + 8, approachY, { steps: 4 });
    await page.mouse.move(mainBounds.x + 4, approachY, { steps: 10 });
    await page.mouse.move(mainBounds.x + 4, mainBounds.y + mainBounds.height / 2, { steps: 4 });
    await expect(mainTab).toHaveClass(/drop-before/);
    await page.mouse.up();
    expect(await page.locator('#tabbar .tab').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabPath))).toEqual([
      'plugin-details:example.hello-plugin', sourceFile, secondFile
    ]);
    await expect.poll(() => page.evaluate(() => ({
      mode: window.BOBO.state.currentViewMode,
      leftModelUnchanged: window.BOBO.state.splitEditor.getModel() === window.__pluginDetailsOriginalModel,
      fileTabs: window.BOBO.state.tabs.length,
      splitVisible: document.getElementById('split-container').classList.contains('active')
    }))).toEqual({ mode: 'split', leftModelUnchanged: true, fileTabs: 2, splitVisible: true });
    await expect(details).toHaveClass(/workbench-split-right/);
    expect(await page.locator('#split-left').isVisible()).toBe(true);

    // Opening the same extension cannot create a duplicate workbench tab.
    await page.evaluate(() => window.BOBO.pluginDetails.open('example.hello-plugin'));
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]')).toHaveCount(1);
    await page.screenshot({ path: evidencePath('plugin-details-main-tab.png'), fullPage: false });

    await page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"] .close').press('Enter');
    await expect(page.locator('#plugin-details-view.active')).toHaveCount(0);
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => ({
      mode: window.BOBO.state.currentViewMode,
      modelRestored: window.BOBO.state.editor.getModel() === window.__pluginDetailsOriginalModel,
      splitVisible: document.getElementById('split-container').classList.contains('active')
    }))).toEqual({ mode: 'split', modelRestored: true, splitVisible: true });

    const enabled = await page.evaluate(async () => {
      const id = 'example.notebook-fixture';
      await window.api.plugins.grant(id, 'documentViews.register');
      await window.api.plugins.grant(id, 'documents.read');
      return window.api.plugins.enable(id);
    });
    expect(enabled).toMatchObject({ enabled: true, status: 'enabled' });
    await expect.poll(async () => ({
      registered: await page.evaluate(() => Boolean(window.BOBO.documentViews.find('fixture.ipynb'))),
      issues
    })).toEqual({ registered: true, issues: [] });
    await page.evaluate((file) => window.BOBO.workspace.openFile(file, 'fixture.ipynb'), notebookFile);
    const notebook = page.frameLocator('#document-view-host iframe.document-view-frame');
    await expect(notebook.getByText('Notebook fixture is visible')).toBeVisible();
    await page.evaluate(() => window.BOBO.pluginDetails.open('example.hello-plugin'));
    await expect(page.locator('#plugin-details-view.active')).toBeVisible();
    await page.locator('#tabbar .tab-title', { hasText: 'fixture.ipynb' }).click();
    await expect(page.locator('#plugin-details-view.active')).toHaveCount(0);
    await expect(notebook.getByText('Notebook fixture is visible')).toBeVisible();
    await page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"] .close').click();
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="plugin-details"]')).toHaveCount(0);
    await expect(page.locator('#tabbar .tab.active .tab-title')).toHaveText('fixture.ipynb');
    await expect(notebook.getByText('Notebook fixture is visible')).toBeVisible();
    await page.locator('#tabbar .tab-title', { hasText: 'second.js' }).click();

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
    }))).toEqual({ activePath: secondFile, fileTabs: 3, modelRestored: true });
    expect(issues).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
