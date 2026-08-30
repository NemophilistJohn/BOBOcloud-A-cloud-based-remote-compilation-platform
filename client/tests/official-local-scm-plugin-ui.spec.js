const { test, expect, _electron: electron } = require('playwright/test');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginController } = require('../main/plugins');
const { resolvePluginArtifact, shouldSkipMissingArtifact } = require('./support/plugin-artifact');

const PLUGIN_ID = 'bobocloud.local-scm';
const PLUGIN_ROOT = process.env.BOBO_LOCAL_SCM_PLUGIN_DIR
  ? path.resolve(process.env.BOBO_LOCAL_SCM_PLUGIN_DIR)
  : path.resolve(__dirname, '..', '..', '..', 'official-local-scm-plugin');
const ARTIFACT_INFO = resolvePluginArtifact({
  artifactEnv: 'BOBO_LOCAL_SCM_PLUGIN_ARTIFACT',
  pluginId: PLUGIN_ID,
  repositoryRoot: PLUGIN_ROOT,
  versionEnv: 'BOBO_LOCAL_SCM_PLUGIN_VERSION'
});
const ARTIFACT = ARTIFACT_INFO.artifactPath;

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

function git(workspace, args) {
  return childProcess.execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function createRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.name', 'BOBOCloud UI Test']);
  git(root, ['config', 'user.email', 'ui-test@bobocloud.invalid']);
  fs.writeFileSync(path.join(root, 'main.py'), 'print("first")\n', 'utf8');
  git(root, ['add', 'main.py']);
  git(root, ['commit', '-m', 'Initial local commit']);
  git(root, ['branch', '-M', 'main']);
  fs.writeFileSync(path.join(root, 'main.py'), 'print("changed")\nprint("second")\n', 'utf8');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'untracked\n', 'utf8');
}

function createUnbornRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.name', 'BOBOCloud UI Test']);
  git(root, ['config', 'user.email', 'ui-test@bobocloud.invalid']);
  fs.writeFileSync(path.join(root, 'first.py'), 'print("first publish")\n', 'utf8');
}

async function stop(app) {
  if (!app) return;
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function installEnabledPluginBeforeLaunch(userData, workspace) {
  const installer = createPluginController({
    app: { getPath: () => userData, getVersion: () => '2.6.1' },
    ipcMain: { handle() {} },
    getWindow: () => null,
    getWorkspaceIdentity: () => ({ rootPath: workspace, workspaceIdentity: 1 }),
    hostVersion: '2.6.1'
  });
  await installer.installArchiveFromPath(ARTIFACT);
  await installer.setEnabled(PLUGIN_ID, true);
}

test('official local SCM plugin accepts cross-realm broker data and controls file-tree status', async () => {
  test.skip(shouldSkipMissingArtifact(ARTIFACT_INFO, 'Official local SCM plugin artifact'), 'Official plugin checkout/artifact is not present beside the app repository.');
  test.setTimeout(120000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-official-scm-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const evidenceDirectory = path.join(os.tmpdir(), 'bobo-ui-evidence');
  createRepository(workspace);
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(evidenceDirectory, { recursive: true });
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
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 25000 });
    await page.evaluate(async (workspacePath) => {
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(
        opened.rootPath,
        opened.tree,
        opened.workspaceIdentity,
        opened.leaveToken
      );
    }, workspace);

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const installer = createPluginController({
      app: { getPath: () => userData, getVersion: () => '2.6.0' },
      ipcMain: { handle() {} },
      getWindow: () => null,
      getWorkspaceIdentity: () => ({ rootPath: workspace, workspaceIdentity: 1 }),
      hostVersion: '2.6.0'
    });
    await installer.installArchiveFromPath(ARTIFACT);

    const installed = await page.evaluate(async (id) => {
      await window.api.plugins.refresh();
      const record = await window.api.plugins.get(id);
      await window.api.plugins.enable(id);
      return record;
    }, PLUGIN_ID);
    expect(installed.version).toBe('1.2.1');
    expect([...installed.grantedPermissions].sort()).toEqual([...installed.requestedPermissions].sort());

    await page.waitForFunction(() => window.BOBO.commands.has('bobocloud.local-scm.refresh'), null, { timeout: 20000 });
    await page.waitForFunction(() => {
      const record = window.BOBO.platform.sourceControl.get('bobocloud.local-scm.view');
      return record && record.state && record.state.phase === 'ready';
    }, null, { timeout: 20000 });

    // A dynamically registered source-control view must never prevent the
    // built-in workbench activities from switching their own sidebar content.
    for (const view of ['explorer', 'environment', 'extensions']) {
      await page.locator('[data-workbench-view="' + view + '"]').click();
      await expect(page.locator('[data-sidebar-view="' + view + '"]')).toHaveClass(/active/);
    }

    const activity = page.locator('.source-control-activity');
    await expect(activity).toBeVisible();
    await activity.click();
    const panel = page.locator('.source-control-sidebar.active');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Initial local commit');
    await expect(panel).toContainText('main.py');
    await expect(panel).toContainText('notes.txt');
    await expect(panel).not.toContainText('Extension payload must contain plain objects only.');
    await expect(panel.locator('.source-control-tool-button[aria-label="Push"]')).toBeVisible();

    const modified = page.locator('.tree-row[data-name="main.py"]');
    const untracked = page.locator('.tree-row[data-name="notes.txt"]');
    await expect(modified.locator('.tree-scm-rail[data-decoration-status="modified"]')).toHaveCount(1);
    await expect(untracked.locator('.tree-scm-rail[data-decoration-status="untracked"]')).toHaveCount(1);

    const untrackedSection = panel.locator('.source-control-section').filter({ hasText: 'Untracked Changes' });
    await untrackedSection.locator('.source-control-list-item-action', { hasText: 'notes.txt' }).click();
    await expect.poll(() => git(workspace, ['diff', '--cached', '--name-only'])).toContain('notes.txt');
    const stagedSection = panel.locator('.source-control-section').filter({ hasText: 'Staged Changes' });
    await stagedSection.locator('.source-control-list-item-action', { hasText: 'notes.txt' }).click();
    await expect.poll(() => git(workspace, ['diff', '--cached', '--name-only'])).not.toContain('notes.txt');

    const changedStats = panel.locator('.source-control-line-stats').first();
    await expect(changedStats.locator('.source-control-line-stat-added')).toHaveCSS('color', 'rgb(86, 184, 122)');
    await expect(changedStats.locator('.source-control-line-stat-removed')).toHaveCSS('color', 'rgb(228, 93, 93)');

    await panel.locator('.source-control-more-button').click();
    const overflow = page.locator('.source-control-overflow-menu');
    await expect(overflow).toBeVisible();
    await expect(overflow).toContainText('Pull');
    await expect.poll(() => overflow.locator('.source-control-overflow-item').first().evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(33);
    await expect.poll(() => overflow.evaluate((menu) => menu.getBoundingClientRect().left)).toBeGreaterThanOrEqual(7);
    await expect.poll(() => overflow.evaluate((menu) => {
      const label = menu.querySelector('.source-control-overflow-label');
      return Boolean(label && label.getBoundingClientRect().left >= menu.getBoundingClientRect().left + 24);
    })).toBe(true);
    await expect.poll(() => overflow.evaluate((menu) => {
      const activityBar = document.getElementById('activitybar');
      return Boolean(activityBar && menu.getBoundingClientRect().left >= activityBar.getBoundingClientRect().right + 7);
    })).toBe(true);
    // The portal menu must dismiss on every covered activity-rail click rather
    // than absorbing it. This is the real regression path for built-in views.
    for (const view of ['cloud', 'environment', 'extensions']) {
      await page.locator('[data-workbench-view="' + view + '"]').click();
      await expect(page.locator('[data-sidebar-view="' + view + '"]')).toHaveClass(/active/);
      await expect(page.locator('.source-control-overflow-menu')).toHaveCount(0);
      await page.locator('.source-control-activity').click();
      await expect(panel).toBeVisible();
      await panel.locator('.source-control-more-button').click();
    }
    await page.screenshot({
      path: path.join(evidenceDirectory, 'official-local-scm-plugin-menu.png'),
      fullPage: true
    });
    await page.locator('.source-control-overflow-item', { hasText: 'Hide file tree status' }).click();
    await expect(modified.locator('.tree-scm-rail')).toHaveCount(0);
    await panel.locator('.source-control-more-button').click();
    await page.locator('.source-control-overflow-item', { hasText: 'Show file tree status' }).click();
    await expect(modified.locator('.tree-scm-rail[data-decoration-status="modified"]')).toHaveCount(1);

    // A real Git failure must cross the Worker boundary through the protocol's
    // serialized error channel. The old plugin returned an Error as a fulfilled
    // command value, which the host correctly rejected as a non-plain payload.
    await panel.locator('.source-control-tool-button[aria-label="Push"]').click();
    await panel.locator('.source-control-form button[type="submit"]').click();
    await expect(panel).toContainText('The operation could not be completed in the local workspace.');
    await expect(panel.locator('.source-control-host-error')).toHaveCount(0);
    await expect(panel).not.toContainText('Extension payload must contain plain objects only.');

    await page.screenshot({
      path: path.join(evidenceDirectory, 'official-local-scm-plugin-ready.png'),
      fullPage: true
    });
    expect(pageErrors).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('official local SCM treats an unborn repository as a first-publish workflow', async () => {
  test.skip(shouldSkipMissingArtifact(ARTIFACT_INFO, 'Official local SCM plugin artifact'), 'Official plugin checkout/artifact is not present beside the app repository.');
  test.setTimeout(120000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-official-scm-unborn-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const evidenceDirectory = path.join(os.tmpdir(), 'bobo-ui-evidence');
  createUnbornRepository(workspace);
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(evidenceDirectory, { recursive: true });
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
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 25000 });
    await page.evaluate(async (workspacePath) => {
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
    }, workspace);
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const installer = createPluginController({
      app: { getPath: () => userData, getVersion: () => '2.6.0' },
      ipcMain: { handle() {} },
      getWindow: () => null,
      getWorkspaceIdentity: () => ({ rootPath: workspace, workspaceIdentity: 1 }),
      hostVersion: '2.6.0'
    });
    await installer.installArchiveFromPath(ARTIFACT);
    await page.evaluate(async (id) => {
      await window.api.plugins.refresh();
      await window.api.plugins.enable(id);
    }, PLUGIN_ID);
    await page.waitForFunction(() => {
      const record = window.BOBO.platform.sourceControl.get('bobocloud.local-scm.view');
      return record && record.state && record.state.phase === 'ready';
    }, null, { timeout: 20000 });

    await page.locator('.source-control-activity').click();
    const panel = page.locator('.source-control-sidebar.active');
    await expect(panel).toContainText('no commits yet');
    await expect(panel.locator('.source-control-section').filter({ hasText: 'History' })).toContainText('No data available');
    await panel.locator('.source-control-action', { hasText: 'Initialize and publish' }).click();
    await expect(panel.locator('.source-control-form')).toBeVisible();
    await expect(panel.locator('input[name="remote"]')).toBeVisible();
    await expect(panel.locator('input[name="branch"]')).toHaveValue('master');
    await expect(panel.locator('textarea[name="message"]')).toHaveValue('Initial commit');
    await expect(panel.locator('.source-control-tool-button[aria-label="Stage all changes"]')).toBeVisible();
    await expect(panel).not.toContainText('Extension payload must contain plain objects only.');
    await page.screenshot({ path: path.join(evidenceDirectory, 'official-local-scm-plugin-unborn.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('a preinstalled source-control plugin cannot block built-in sidebars after opening a workspace', async () => {
  test.skip(shouldSkipMissingArtifact(ARTIFACT_INFO, 'Official local SCM plugin artifact'), 'Official plugin checkout/artifact is not present beside the app repository.');
  test.setTimeout(120000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-official-scm-preinstalled-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  createRepository(workspace);
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // --user-data-dir is the Electron userData root in this isolated test.
  await installEnabledPluginBeforeLaunch(path.join(sandbox, 'chromium'), workspace);
  let app;
  const stderr = [];

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
    const appProcess = app.process();
    if (appProcess.stderr) appProcess.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 25000 });
    await page.waitForFunction(() => Boolean(document.querySelector('.source-control-activity')), null, { timeout: 20000 });
    await page.waitForFunction(() => {
      const record = window.BOBO.platform.sourceControl.get('bobocloud.local-scm.view');
      return record && record.state && ['empty', 'error'].includes(record.state.phase);
    }, null, { timeout: 20000 });
    const initialState = await page.evaluate(() => {
      const record = window.BOBO.platform.sourceControl.get('bobocloud.local-scm.view');
      return record && record.state;
    });
    expect(initialState.phase, JSON.stringify({ initialState, stderr, pageErrors }, null, 2)).toBe('empty');
    expect(initialState.actions || []).toEqual([]);
    expect(stderr.join('')).not.toContain("Error occurred in handler for 'plugins:rpc'");
    expect(stderr.join('')).not.toContain('SCM_GIT_NO_WORKSPACE');
    await page.evaluate(async (workspacePath) => {
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.platform.commands.execute('bobocloud.local-scm.refresh');
    }, workspace);
    await page.waitForFunction(() => {
      const record = window.BOBO.platform.sourceControl.get('bobocloud.local-scm.view');
      return record && record.state && record.state.phase === 'ready';
    }, null, { timeout: 20000 });

    await page.locator('.source-control-activity').click();
    await expect(page.locator('.source-control-sidebar.active')).toBeVisible();
    for (const view of ['explorer', 'cloud', 'environment', 'extensions']) {
      await page.locator('[data-workbench-view="' + view + '"]').click();
      await expect(page.locator('[data-sidebar-view="' + view + '"]')).toHaveClass(/active/);
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
