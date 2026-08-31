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

async function launchFixture(prefix) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'workspace');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'alpha.txt'), 'alpha\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'src', 'existing.js'), 'export default true;\n', 'utf8');
  for (let index = 0; index < 36; index += 1) {
    fs.writeFileSync(path.join(workspace, `scroll-${String(index).padStart(2, '0')}.txt`), `${index}\n`, 'utf8');
  }

  const packagedExe = process.env.BOBO_PACKAGED_EXE || '';
  const app = await electron.launch({
    executablePath: packagedExe || electronExecutablePath(),
    args: (packagedExe ? [] : ['.']).concat(['--user-data-dir=' + path.join(sandbox, 'chromium')]),
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
  await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
  await page.setViewportSize({ width: 760, height: 520 });
  await page.evaluate(async workspacePath => {
    window.BOBO.state.serverSettings.ip = '';
    window.BOBO.state.serverSettings.user = '';
    if (window.BOBO.state.autoSyncInterval) {
      clearInterval(window.BOBO.state.autoSyncInterval);
      window.BOBO.state.autoSyncInterval = null;
    }
    const opened = await window.api.pickWorkspace(workspacePath);
    await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
  }, workspace);
  await page.waitForTimeout(750);
  return { app, page, sandbox, workspace, issues };
}

async function closeFixture(fixture) {
  if (!fixture) return;
  let child = null;
  try { child = fixture.app.process(); } catch {}
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch {}
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') {
      require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

function evidencePath(name) {
  const root = process.env.BOBO_UI_EVIDENCE_DIR || path.join(os.tmpdir(), 'bobo-ui-evidence');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, name);
}

function treeRow(page, name) {
  return page.locator(`.tree-row[data-name="${name}"]`).first();
}

async function waitForTreeToSettle(page, quietMs = 500, timeoutMs = 3000) {
  await page.locator('#file-tree').evaluate((tree, options) => new Promise((resolve, reject) => {
    let quietTimer;
    let timeoutTimer;
    const observer = new MutationObserver(() => scheduleQuietPeriod());
    const finish = (error) => {
      clearTimeout(quietTimer);
      clearTimeout(timeoutTimer);
      observer.disconnect();
      if (error) reject(error);
      else resolve();
    };
    const scheduleQuietPeriod = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), options.quietMs);
    };
    observer.observe(tree, { attributes: true, childList: true, subtree: true });
    timeoutTimer = setTimeout(() => finish(new Error('Workspace tree did not settle.')), options.timeoutMs);
    scheduleQuietPeriod();
  }), { quietMs, timeoutMs });
}

test('file-tree context menu is translated, keyboard accessible, bounded, and dismissible', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launchFixture('bobo-tree-menu-');
    const { page, workspace } = fixture;
    const root = treeRow(page, 'workspace');
    const menu = page.locator('.tree-context-menu');

    await root.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['New File', 'New Folder']);
    await expect(menu.locator('[data-action="rename"], [data-action="delete"]')).toHaveCount(0);
    expect(await menu.getByRole('menuitem').evaluateAll(items => items.every(item => item.tagName === 'BUTTON'))).toBe(true);
    await expect(menu.locator('[data-action="new-file"]')).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.locator('[data-action="new-folder"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.locator('[data-action="new-file"]')).toBeFocused();
    await page.screenshot({ path: evidencePath('file-tree-context-menu-en.png'), fullPage: false });

    await root.click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(root).toBeFocused();

    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.bringToFront();
    await page.waitForTimeout(50);
    await root.click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['新建文件', '新建文件夹']);
    await page.locator('.sidebar-view.active .sidebar-header').click();
    await expect(menu).toHaveCount(0);

    const firstFile = treeRow(page, 'scroll-00.txt');
    const secondFile = treeRow(page, 'scroll-01.txt');
    await page.evaluate(filePath => window.BOBO.workspace.openFile(filePath, 'scroll-00.txt'), path.join(workspace, 'scroll-00.txt'));
    await firstFile.click({ button: 'right' });
    await expect(menu).toHaveAttribute('data-target-path', path.join(workspace, 'scroll-00.txt'));
    await secondFile.click({ button: 'right' });
    await expect(menu).toHaveCount(1);
    await expect(menu).toHaveAttribute('data-target-path', path.join(workspace, 'scroll-01.txt'));
    await expect(menu.getByRole('menuitem')).toHaveText(['重命名', '删除', '与当前活动文件比较']);

    await page.locator('.sidebar-scroll').first().evaluate(element => {
      element.scrollTop = Math.max(1, element.scrollHeight - element.clientHeight);
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(menu).toHaveCount(0);

    await root.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
    await root.click({ button: 'right' });
    await page.setViewportSize({ width: 720, height: 500 });
    await expect(menu).toHaveCount(0);

    await root.click({ button: 'right' });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(menu).toHaveCount(0);

    await page.evaluate(() => window.BOBO.i18n.setLocale('ja'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.bringToFront();
    await page.waitForTimeout(50);
    await page.setViewportSize({ width: 430, height: 360 });
    await root.evaluate(element => {
      element.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth - 1,
        clientY: window.innerHeight - 1
      }));
    });
    await expect(menu.getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダー']);
    const geometry = await menu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(7);
    expect(geometry.top).toBeGreaterThanOrEqual(7);
    expect(geometry.right).toBeLessThanOrEqual(423);
    expect(geometry.bottom).toBeLessThanOrEqual(353);
    await page.screenshot({ path: evidencePath('file-tree-context-menu-ja-bounded.png'), fullPage: false });

    await root.evaluate(element => {
      element.focus({ preventScroll: true });
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-action="new-file"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('[data-action="new-folder"]')).toBeFocused();
    await page.evaluate(() => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect(menu).toHaveCount(0);
    expect(fixture.issues).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});

test('rename and create editors stay at their tree locations and preserve actionable errors', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launchFixture('bobo-tree-inline-');
    const { page, workspace } = fixture;
    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.bringToFront();
    await page.waitForTimeout(50);

    const alpha = treeRow(page, 'alpha.txt');
    await alpha.click({ button: 'right' });
    await page.locator('.tree-context-menu [data-action="rename"]').click();
    const renameInput = alpha.locator('.tree-inline-input');
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveAttribute('aria-label', '新名称');
    expect(await renameInput.evaluate((input, expectedPath) => input.closest('.tree-row').getAttribute('data-path') === expectedPath, path.join(workspace, 'alpha.txt'))).toBe(true);
    await expect(alpha.locator(':scope > .tree-name')).toHaveCount(0);

    await renameInput.fill('bad/name');
    await renameInput.press('Enter');
    await expect(alpha.locator('.tree-inline-error')).toHaveText('名称不能包含路径分隔符。');
    await expect(renameInput).toBeVisible();
    expect(fs.existsSync(path.join(workspace, 'alpha.txt'))).toBe(true);

    await renameInput.fill('beta.txt');
    await renameInput.press('Enter');
    await expect(treeRow(page, 'beta.txt')).toBeVisible();
    expect(fs.existsSync(path.join(workspace, 'beta.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'alpha.txt'))).toBe(false);
    await page.waitForTimeout(800);

    const sourceFolder = treeRow(page, 'src');
    await sourceFolder.click({ button: 'right' });
    await page.locator('.tree-context-menu [data-action="new-folder"]').click();
    const folderInput = page.locator('.tree-inline-create .tree-inline-input');
    await expect(folderInput).toHaveAttribute('aria-label', '文件夹名称');
    await expect(sourceFolder).toHaveAttribute('aria-expanded', 'true');
    expect(await folderInput.evaluate(input => {
      const editorItem = input.closest('li.tree-inline-editor');
      const folderItem = input.closest('ul.tree-children').parentElement;
      return editorItem.parentElement === folderItem.querySelector(':scope > ul.tree-children');
    })).toBe(true);
    await page.locator('.sidebar-view.active .sidebar-header').click();
    await expect(folderInput).toHaveCount(0);

    await sourceFolder.click({ button: 'right' });
    await page.locator('.tree-context-menu [data-action="new-file"]').click();
    const fileInput = page.locator('.tree-inline-create .tree-inline-input');
    await expect(fileInput).toHaveAttribute('aria-label', '文件名');
    await fileInput.fill('existing.js');
    await fileInput.press('Enter');
    await expect(page.locator('.tree-inline-create .tree-inline-error')).toHaveText('同名文件或文件夹已存在。');
    await expect(fileInput).toBeEnabled();
    await expect(fileInput).toBeVisible();

    await fileInput.fill('created.js');
    await fileInput.press('Enter');
    await expect(treeRow(page, 'created.js')).toBeVisible();
    expect(fs.existsSync(path.join(workspace, 'src', 'created.js'))).toBe(true);
    await waitForTreeToSettle(page);

    const beta = treeRow(page, 'beta.txt');
    await beta.click({ button: 'right' });
    await page.locator('.tree-context-menu [data-action="rename"]').click();
    await expect(beta.locator('.tree-inline-input')).toBeVisible();
    await page.evaluate(() => window.BOBO.workspace.renderTree(window.BOBO.state.workspaceTree));
    await expect(page.locator('.tree-inline-input')).toHaveCount(0);
    await expect(page.locator('.tree-context-menu')).toHaveCount(0);

    await treeRow(page, 'beta.txt').click({ button: 'right' });
    await expect(page.locator('.tree-context-menu')).toBeVisible();
    await page.evaluate(() => window.BOBO.workspace.closeWorkspace({ approved: true }));
    await expect(page.locator('.tree-context-menu')).toHaveCount(0);
    await expect(page.locator('.tree-inline-input')).toHaveCount(0);
    expect(fixture.issues).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});
