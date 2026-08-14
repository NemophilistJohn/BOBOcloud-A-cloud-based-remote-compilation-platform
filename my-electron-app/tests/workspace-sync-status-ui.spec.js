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

test('workspace tree cloud rail tracks local, queued, syncing, success, error and conflict states', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-sync-rail-'));
  const workspace = path.join(sandbox, 'workspace');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'alpha.js'), 'export const alpha = 1;\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'src', 'beta.js'), 'export const beta = 1;\n', 'utf8');

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
    page.on('pageerror', error => issues.push(error.stack || error.message));
    page.on('console', message => {
      if (message.type() === 'error') issues.push(message.text());
    });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    expect(await page.evaluate(() => {
      function cancellation(stack) {
        const reason = new Error('Canceled');
        reason.name = 'Canceled';
        reason.stack = stack;
        const event = new Event('unhandledrejection', { cancelable: true });
        Object.defineProperty(event, 'reason', { value: reason });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }
      return {
        monaco: cancellation('Canceled: Canceled\n at /node_modules/monaco-editor/min/vs/editor.api-test.js'),
        unrelated: cancellation('Canceled: Canceled\n at /src/project-tasks.js')
      };
    })).toEqual({ monaco: true, unrelated: false });
    await page.setViewportSize({ width: 680, height: 480 });
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

    const root = page.locator('.tree-row[data-name="workspace"]');
    const alpha = page.locator('.tree-row[data-name="alpha.js"]');
    const source = page.locator('.tree-row[data-name="src"]');
    await expect(root.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'local-only');
    await expect(alpha.locator('.tree-sync-rail')).toHaveAttribute('data-decoration-kind', 'cloud-sync');
    await expect(alpha.locator('.tree-sync-rail')).toHaveAttribute('title', 'Cloud sync: Local only - not uploaded yet');
    expect(await page.evaluate(() => window.BOBO.platform.contributions.describe('fileDecorations.sync'))).toEqual([
      { point: 'fileDecorations.sync', id: 'core.sync-status', owner: 'core.sync' }
    ]);

    await alpha.click();
    await page.evaluate(() => window.BOBO.state.editor.getModel().setValue('export const alpha = 2;\n'));
    await expect(alpha.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'queued');
    await expect(root.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'queued');

    // Discarding an unsaved buffer must remove only the editor overlay. It did
    // not change the file on disk and therefore must not leave a queued badge.
    await page.evaluate(async filePath => {
      await window.BOBO.workspace.closeTab(filePath, { force: true });
    }, path.join(workspace, 'alpha.js'));
    await expect(alpha.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'local-only');
    await alpha.click();
    await page.evaluate(() => window.BOBO.state.editor.getModel().setValue('export const alpha = 3;\n'));
    await expect(alpha.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'queued');

    await page.evaluate(() => {
      window.__syncRailContext = window.BOBO.workspaceSyncStatus.beginSync({ force: true });
    });
    // rclone uploads the on-disk snapshot, not the newer unsaved buffer.
    await expect(alpha.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'queued');
    await expect(root.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'syncing');

    await source.click();
    const beta = page.locator('.tree-row[data-name="beta.js"]');
    await beta.click();
    await page.evaluate(() => window.BOBO.state.editor.getModel().setValue('export const beta = 2;\n'));
    await expect(beta.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'queued');
    await page.evaluate(() => window.BOBO.workspaceSyncStatus.finishSync(window.__syncRailContext, { success: true }));
    await expect(alpha.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'queued');
    await expect(beta.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'queued');

    // Saving one file still leaves it queued until the subsequent cloud sync.
    await page.evaluate(async () => {
      await window.BOBO.workspace.saveActiveTab();
      window.__syncRailContext = window.BOBO.workspaceSyncStatus.beginSync();
    });
    await expect(beta.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'syncing');
    await page.evaluate(() => window.BOBO.workspaceSyncStatus.finishSync(window.__syncRailContext, {
      success: false,
      error: { message: 'fixture upload failed' }
    }));
    await expect(beta.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'error');
    await expect(beta.locator('.tree-sync-rail')).toHaveAttribute('title', /fixture upload failed/);

    await page.evaluate(() => window.BOBO.workspaceSyncStatus.setConflicts(['src/beta.js']));
    await expect(beta.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'conflict');
    await expect(source.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'conflict');
    await expect(root.locator('.tree-sync-rail')).toHaveAttribute('data-sync-state', 'conflict');

    const geometry = await root.evaluate(row => {
      const name = row.querySelector('.tree-name').getBoundingClientRect();
      const rail = row.querySelector('.tree-sync-rail').getBoundingClientRect();
      return { nameRight: name.right, railLeft: rail.left, railRight: rail.right, rowRight: row.getBoundingClientRect().right };
    });
    expect(geometry.nameRight).toBeLessThanOrEqual(geometry.railLeft);
    expect(geometry.railRight).toBeLessThanOrEqual(geometry.rowRight + 0.5);
    await page.screenshot({ path: evidencePath('workspace-sync-rail-conflict.png'), fullPage: false });
    expect(issues).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});
