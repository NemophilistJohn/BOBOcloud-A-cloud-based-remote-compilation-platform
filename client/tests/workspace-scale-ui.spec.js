const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronExecutablePath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

async function closeFixture(app) {
  if (!app) return;
  let child = null;
  try { child = app.process(); } catch {}
  if (!child) {
    await new Promise(resolve => setTimeout(resolve, 300));
    return;
  }
  const exited = new Promise(resolve => {
    if (!child || child.exitCode !== null) resolve();
    else child.once('exit', resolve);
  });
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') {
      require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  }
  await new Promise(resolve => setTimeout(resolve, 300));
}

async function removeSandbox(sandbox) {
  await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('large workspaces stay searchable while the tree renders in pages', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-scale-'));
  const appDataDir = path.join(sandbox, 'appdata');
  const homeDir = path.join(sandbox, 'home');
  const workspaceDir = path.join(sandbox, 'workspace');
  const manyDir = path.join(workspaceDir, 'many');
  const dependencyDir = path.join(workspaceDir, 'node_modules', 'fixture-package');
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(manyDir, { recursive: true });
  fs.mkdirSync(dependencyDir, { recursive: true });
  for (let index = 0; index < 250; index += 1) {
    fs.writeFileSync(path.join(manyDir, `file-${String(index).padStart(3, '0')}.txt`), `value ${index}\n`, 'utf8');
  }
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(path.join(dependencyDir, `dependency-${index}.js`), 'module.exports = true;\n', 'utf8');
  }

  let app;
  let stage = 'launch';
  try {
    app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: appDataDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: homeDir,
        USERPROFILE: homeDir,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
      })
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    stage = 'ready';
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true', null, { timeout: 20000 });

    stage = 'open workspace';
    const modelSummary = await page.evaluate(async workspacePath => {
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree);
      const many = opened.tree.children.find(entry => entry.name === 'many');
      const dependency = opened.tree.children.find(entry => entry.name === 'node_modules');
      return {
        manyCount: many && many.children.length,
        dependencyCount: dependency && dependency.children.length
      };
    }, workspaceDir);
    expect(modelSummary).toEqual({ manyCount: 250, dependencyCount: 0 });

    stage = 'first page';
    await page.locator('.tree-row[data-name="many"]').click();
    await expect(page.locator('.tree-row[data-type="file"]')).toHaveCount(200);
    await expect(page.locator('.tree-load-more')).toHaveText('Load 50 more items');

    stage = 'search';
    await page.evaluate(() => window.BOBO.fileSearch.show());
    const searchView = page.locator('[data-sidebar-view="search"]');
    const searchInput = page.locator('#quick-file-search-input');
    await expect(searchView).toHaveClass(/active/);
    await expect(searchInput).toBeFocused();
    await expect(page.locator('.cmd-palette-overlay.open')).toHaveCount(0);
    await searchInput.fill('file-249.txt');
    const matchingFile = searchView.locator('.file-search-result-name', { hasText: 'file-249.txt' });
    await expect(matchingFile).toHaveCount(1);
    await matchingFile.click();
    await expect.poll(() => page.evaluate(() => window.BOBO.state.activeTabPath && window.BOBO.state.activeTabPath.endsWith('file-249.txt'))).toBe(true);

    stage = 'search state and history';
    await page.locator('[data-workbench-view="explorer"]').click();
    await page.keyboard.press('Control+P');
    await expect(searchView).toHaveClass(/active/);
    await expect(searchInput).toHaveValue('file-249.txt');
    await expect(page.locator('.cmd-palette-overlay.open')).toHaveCount(0);
    await searchInput.fill('');
    const recentSection = searchView.locator('[data-search-section="recent"]');
    await expect(recentSection.locator('.file-search-result-name')).toHaveText('file-249.txt');
    await expect(searchView.locator('[data-search-section="suggested"]')).toBeVisible();

    stage = 'search localization';
    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await expect(searchInput).toHaveAttribute('placeholder', '搜索文件...');
    await expect(recentSection.locator('.file-search-section-heading strong')).toHaveText('最近打开');
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.cmd-input')).toHaveAttribute('placeholder', '输入命令...');
    await expect(page.locator('.cmd-item .cmd-label', { hasText: '打开文件夹' })).toHaveCount(1);
    await page.evaluate(() => window.BOBO.i18n.setLocale('ja'));
    await expect(page.locator('.cmd-input')).toHaveAttribute('placeholder', 'コマンドを入力...');
    await expect(page.locator('.cmd-item .cmd-label', { hasText: 'フォルダーを開く' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(searchInput).toHaveAttribute('placeholder', 'ファイルを検索...');
    await page.locator('#sidebar-resizer').press('Home');
    await expect(page.locator('#sidebar-resizer')).toHaveAttribute('aria-valuenow', '180');
    await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width))).toBe(180);
    const sidebarBounds = await page.evaluate(() => {
      const sidebar = document.getElementById('sidebar').getBoundingClientRect();
      const input = document.getElementById('quick-file-search-input').getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll('[data-sidebar-view="search"] .file-search-result'));
      return {
        width: Math.round(sidebar.width),
        inputContained: input.left >= sidebar.left && input.right <= sidebar.right,
        rowsContained: rows.every(row => {
          const bounds = row.getBoundingClientRect();
          return bounds.left >= sidebar.left && bounds.right <= sidebar.right;
        })
      };
    });
    expect(sidebarBounds).toEqual({ width: 180, inputContained: true, rowsContained: true });
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobocloud-quick-open-sidebar.png'), fullPage: false });
    await page.evaluate(() => window.BOBO.i18n.setLocale('en'));
    await searchView.locator('.file-search-clear-history').click();
    await expect(searchView.locator('[data-search-section="recent"]')).toHaveCount(0);
    await page.locator('[data-workbench-view="explorer"]').click();

    stage = 'load more';
    await page.locator('.tree-load-more').click();
    await expect(page.locator('.tree-row[data-type="file"]')).toHaveCount(250);
    await expect(page.locator('.tree-load-more')).toHaveCount(0);

    stage = 'watcher change';
    await page.evaluate(() => {
      window.__workspaceScaleRenderCount = 0;
      const original = window.BOBO.workspace.renderTree;
      window.BOBO.workspace.renderTree = function(tree) {
        window.__workspaceScaleRenderCount += 1;
        return original(tree);
      };
    });
    await page.waitForTimeout(500);
    fs.writeFileSync(path.join(manyDir, 'file-249.txt'), 'changed\n', 'utf8');
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => window.__workspaceScaleRenderCount)).toBe(0);

    stage = 'watcher create';
    fs.writeFileSync(path.join(manyDir, 'file-250.txt'), 'new\n', 'utf8');
    await expect.poll(() => page.evaluate(() => window.__workspaceScaleRenderCount), { timeout: 5000 }).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
    console.log('workspace scale final stage:', stage);
  }
});
