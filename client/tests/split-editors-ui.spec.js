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

async function launchFixture(sandbox) {
  const appDataDir = path.join(sandbox, 'appdata');
  const homeDir = path.join(sandbox, 'home');
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return electron.launch({
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

test('two independently editable split panes preserve files, focus, saves, run targets and model ownership', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-split-editors-'));
  const workspace = path.join(sandbox, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const leftFile = path.join(workspace, 'left.ts').replace(/\\/g, '/');
  const rightFile = path.join(workspace, 'right.py').replace(/\\/g, '/');
  fs.writeFileSync(leftFile, 'const left = 1;\n');
  fs.writeFileSync(rightFile, 'right = 2\n');
  let app;
  try {
    app = await launchFixture(sandbox);
    const page = await app.firstWindow();
    const issues = [];
    page.on('pageerror', error => issues.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await page.evaluate(async ({ workspace, leftFile }) => {
      window.BOBO.state.serverSettings.ip = '';
      const opened = await window.api.pickWorkspace(workspace);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.workspace.openFile(leftFile, 'left.ts');
      if (window.BOBO.state.autoSyncInterval) clearInterval(window.BOBO.state.autoSyncInterval);
    }, { workspace, leftFile });
    await page.locator('#editor-split-action').click();
    await expect(page.locator('#split-container')).toHaveClass('active');
    expect(await page.evaluate(() => {
      const [left, right] = window.BOBO.views.getVisibleEditors();
      return left.getModel() === right.getModel() && !left.getOption(monaco.editor.EditorOption.readOnly) && !right.getOption(monaco.editor.EditorOption.readOnly);
    })).toBe(true);
    await page.evaluate(async rightFile => window.BOBO.workspace.openFile(rightFile, 'right.py'), rightFile);
    expect(await page.evaluate(() => window.BOBO.views.getVisibleEditors().map(editor => editor.getModel().getLanguageId()))).toEqual(['typescript', 'python']);
    await page.locator('#split-left .view-lines').click({ position: { x: 35, y: 10 } });
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('// left edit\n');
    await expect.poll(() => page.evaluate(() => window.BOBO.state.activeTabPath)).toBe(leftFile);
    expect(await page.evaluate(() => window.BOBO.state.tabs.map(tab => tab.dirty))).toEqual([true, false]);
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => fs.readFileSync(leftFile, 'utf8')).toContain('// left edit\n');
    expect(fs.readFileSync(rightFile, 'utf8')).toBe('right = 2\n');
    await page.locator('#split-right .view-lines').click({ position: { x: 35, y: 10 } });
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('# right edit\n');
    await expect.poll(() => page.evaluate(() => window.BOBO.state.activeTabPath)).toBe(rightFile);
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => fs.readFileSync(rightFile, 'utf8')).toContain('# right edit\n');
    expect(await page.evaluate(() => {
      const bobo = window.BOBO;
      bobo.projectTasks.runSelected = () => { window.__splitRunTarget = bobo.state.activeTabPath; };
      return bobo.views.getVisibleEditors().every(editor => bobo.state.tabs.some(tab => tab.model === editor.getModel())) && !monaco.editor.getModels().some(model => model.uri.toString().endsWith('-split'));
    })).toBe(true);
    await page.keyboard.press('ControlOrMeta+F5');
    await expect.poll(() => page.evaluate(() => window.__splitRunTarget)).toBe(rightFile);
    await page.locator('#split-left .view-lines').click({ position: { x: 35, y: 10 } });
    await page.locator('#tabbar .tab-title').filter({ hasText: 'right.py' }).click();
    expect(await page.evaluate(() => {
      const [left, right] = window.BOBO.views.getVisibleEditors();
      return left.getModel() === right.getModel();
    })).toBe(true);
    await page.locator('#tabbar .tab-title').filter({ hasText: 'left.ts' }).click();
    expect(await page.evaluate(() => window.BOBO.views.getVisibleEditors().map(editor => editor.getModel().getLanguageId()))).toEqual(['typescript', 'python']);
    await page.locator('#split-right .view-lines').click({ position: { x: 35, y: 10 } });
    await page.locator('#close-split').click();
    expect(await page.evaluate(() => window.BOBO.state.editor.getModel().getLanguageId())).toBe('python');
    expect(await page.evaluate(() => window.BOBO.state.tabs.every(tab => !tab.dirty && !tab.model.isDisposed()))).toBe(true);
    await page.keyboard.press('ControlOrMeta+\\');
    await expect(page.locator('#split-container')).toHaveClass('active');
    await page.setViewportSize({ width: 720, height: 800 });
    expect(await page.locator('#split-container').evaluate(node => getComputedStyle(node).flexDirection)).toBe('column');
    const closed = await page.evaluate(async path => {
      const model = window.BOBO.state.tabs.find(tab => tab.path === path).model;
      await window.BOBO.workspace.closeTab(path);
      return { disposed: model.isDisposed(), detached: window.BOBO.views.getVisibleEditors().every(editor => editor.getModel() !== model) };
    }, rightFile);
    expect(closed).toEqual({ disposed: true, detached: true });
    expect(issues).toEqual([]);
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
  }
});
