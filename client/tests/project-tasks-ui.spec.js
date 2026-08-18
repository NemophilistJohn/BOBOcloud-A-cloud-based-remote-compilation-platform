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

function evidencePath(name) {
  const directory = process.env.BOBO_UI_EVIDENCE_DIR || path.join(os.tmpdir(), 'bobo-ui-evidence');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
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
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('Run target menu merges project tasks and remains keyboard-accessible and workspace-scoped', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-project-tasks-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.bobocloud'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'console.log("app");\n', 'utf8');
  fs.writeFileSync(path.join(workspace, '.vscode', 'tasks.json'), `{
    // VS Code JSONC remains accepted.
    "version": "2.0.0",
    "tasks": [
      { "label": "Build shared", "type": "process", "command": "npm", "args": ["run", "old-build"], "group": "build" },
      { "label": "Test project", "type": "process", "command": "npm", "args": ["test"], "group": "test" },
      { "label": "Unsupported npm", "type": "npm", "script": "test" },
    ]
  }`, 'utf8');
  fs.writeFileSync(path.join(workspace, '.bobocloud', 'tasks.json'), `{
    "version": "2.0.0",
    "tasks": [
      { "label": "Build shared", "type": "process", "command": "npm", "args": ["run", "build"], "group": "build" },
      { "label": "Run app", "type": "shell", "command": "node", "args": ["src/app.js"], "bobocloud": { "kind": "run" } },
      { "label": "Custom cleanup", "type": "process", "command": "npm", "args": ["run", "clean"], "bobocloud": { "kind": "custom" } }
    ]
  }`, 'utf8');

  let fixture;
  try {
    const app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: path.join(sandbox, 'appdata'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
      })
    });
    fixture = { app, sandbox };
    const page = await app.firstWindow();
    const issues = [];
    page.on('pageerror', error => issues.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') issues.push(message.text());
    });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await page.setViewportSize({ width: 720, height: 500 });
    await page.evaluate(async workspacePath => {
      window.BOBO.state.serverSettings.ip = '';
      window.BOBO.state.serverSettings.user = '';
      if (window.BOBO.state.autoSyncInterval) {
        clearInterval(window.BOBO.state.autoSyncInterval);
        window.BOBO.state.autoSyncInterval = null;
      }
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.projectTasks.refresh();
    }, workspace);

    const trigger = page.locator('#run-target-btn');
    const menu = page.locator('#run-target-menu');
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(menu.locator('.run-target-section')).toHaveText(['Single File', 'Build Tasks', 'Test Tasks', 'Run Tasks', 'Custom Tasks']);
    await expect(menu.locator('.run-target-label')).toHaveText([
      'Current File', 'Build shared', 'Test project', 'Run app', 'Unsupported npm', 'Custom cleanup'
    ]);
    await expect(menu.locator('.run-target-item').first()).toBeFocused();
    await expect(menu.locator('.run-target-item', { hasText: 'Build shared' }).locator('.run-target-source')).toHaveText('BOBO');
    const unsupported = menu.locator('.run-target-item', { hasText: 'Unsupported npm' });
    await expect(unsupported).toBeDisabled();
    await expect(unsupported).toHaveAttribute('title', /unsupported type/i);
    await expect(menu.locator('.run-target-warning')).toHaveAttribute('title', /\.bobocloud\/tasks\.json.*overrides.*\.vscode\/tasks\.json/i);

    await page.keyboard.press('End');
    await expect(menu.locator('.run-target-item', { hasText: 'Custom cleanup' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.locator('.run-target-item').first()).toBeFocused();
    await page.screenshot({ path: evidencePath('project-task-run-targets.png'), fullPage: false });

    await menu.locator('.run-target-item', { hasText: 'Build shared' }).click();
    await expect(menu).toBeHidden();
    await expect(page.locator('#run-code')).toHaveAttribute('aria-label', 'Run Build shared');
    await expect(page.locator('#run-config-btn')).toBeDisabled();
    expect(await page.evaluate(() => window.BOBO.projectTasks.getSelected())).toEqual({ type: 'task', label: 'Build shared' });

    await trigger.click();
    await page.locator('#titlebar').dispatchEvent('contextmenu');
    await expect(menu).toBeHidden();
    await trigger.click();
    await page.evaluate(() => document.body.dispatchEvent(new Event('scroll', { bubbles: true })));
    await expect(menu).toBeHidden();
    await trigger.click();
    await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();

    await page.setViewportSize({ width: 430, height: 360 });
    await trigger.click();
    const geometry = await menu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(7);
    expect(geometry.top).toBeGreaterThanOrEqual(7);
    expect(geometry.right).toBeLessThanOrEqual(423);
    expect(geometry.bottom).toBeLessThanOrEqual(353);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    await page.evaluate(() => window.BOBO.workspace.closeWorkspace({ approved: true }));
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => ({
      tasks: window.BOBO.projectTasks.getConfiguration().tasks.length,
      selected: window.BOBO.projectTasks.getSelected()
    }))).toEqual({ tasks: 0, selected: { type: 'file', label: '' } });
    expect(issues).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});
