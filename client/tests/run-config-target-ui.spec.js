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

async function closeFixture(fixture) {
  if (!fixture) return;
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch (_) {}
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('compiled files retain a target preset while interpreted files do not expose it', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-build-target-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.c'), 'int main(void) { return 0; }\n');
  fs.writeFileSync(path.join(workspace, 'main.go'), 'package main\nfunc main() {}\n');
  fs.writeFileSync(path.join(workspace, 'tool.py'), 'print("ok")\n');

  let fixture;
  try {
    const app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: path.join(sandbox, 'appdata'), HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      })
    });
    fixture = { app, sandbox };
    const page = await app.firstWindow();
    const issues = [];
    page.on('pageerror', error => issues.push(error.message));
    page.on('console', message => { if (message.type() === 'error') issues.push(message.text()); });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await page.setViewportSize({ width: 720, height: 520 });
    await page.evaluate(async workspacePath => {
      window.BOBO.state.serverSettings.ip = '';
      window.BOBO.state.selectedRuntime = 'c:13';
      window.BOBO.sendToServer = async action => {
        if (action !== 'listBuildTargets') return { success: true };
        return { success: true, buildTargets: [
          { id: 'linux-x86_64', os: 'linux', architecture: 'x86_64', environment: 'hosted', outputPath: '.bobocloud/output', runnable: true },
          { id: 'linux-arm64', os: 'linux', architecture: 'arm64', environment: 'hosted', outputPath: 'artifacts/app_linux_arm64', runnable: false },
          { id: 'windows-x86_64', os: 'windows', architecture: 'x86_64', environment: 'hosted', outputPath: 'artifacts/app_windows_x86_64.exe', runnable: false },
          { id: 'cortex-m4', os: 'none', architecture: 'armv7e-m', environment: 'bare-metal-rtos', outputPath: 'artifacts/app_cortex_m4.elf', runnable: false }
        ] };
      };
      if (window.BOBO.state.autoSyncInterval) clearInterval(window.BOBO.state.autoSyncInterval);
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      window.BOBO.serverCapabilities.applyServerInfo(
        { success: true, data: {} },
        'run-config-target-ui-legacy'
      );
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/main.c', 'main.c');
    }, workspace);

    const configButton = page.locator('#run-config-btn');
    await expect(configButton).toBeVisible();
    await configButton.click();
    const popover = page.locator('#run-config-pop');
    await expect(popover).toBeVisible();
    await expect(page.locator('#rc-target-field')).toBeVisible();
    await expect(page.locator('#rc-target-system')).toHaveValue('linux');
    await page.locator('#rc-target-arch').selectOption('linux-arm64');
    await expect(page.locator('#rc-target-output')).toHaveText('artifacts/app_linux_arm64');
    await expect(page.locator('#rc-target-mode')).toHaveText('Build only - returned as an artifact');
    expect(await page.evaluate(() => window.BOBO.runConfig.getArgs('c').buildTarget)).toBe('linux-arm64');
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-ui-evidence', 'run-config-cross-target.png'), fullPage: false });

    await page.evaluate(async workspacePath => {
      window.BOBO.state.selectedRuntime = 'go:1.23';
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/main.go', 'main.go');
    }, workspace);
    await expect(configButton).toBeVisible();
    await configButton.click();
    await expect(page.locator('#rc-target-field')).toBeVisible();
    await expect(page.locator('#rc-lang')).toHaveText('- Go');
    await page.locator('#rc-target-system').selectOption('windows');
    await expect(page.locator('#rc-target-arch option[value="windows-x86_64"]')).toHaveCount(1);
    await page.locator('#rc-target-arch').selectOption('windows-x86_64');
    await expect(page.locator('#rc-target-toolchain')).toContainText('GOOS=windows');
    expect(await page.evaluate(() => window.BOBO.runConfig.getArgs('go').buildTarget)).toBe('windows-x86_64');

    await page.evaluate(async workspacePath => {
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/tool.py', 'tool.py');
    }, workspace);
    await expect(configButton).toBeHidden();
    expect(issues).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});
