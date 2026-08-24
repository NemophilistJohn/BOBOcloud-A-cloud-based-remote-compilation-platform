const { test, expect, _electron: electron } = require('playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

test('cache inventory v2 is project-first, type-first and lifecycle-safe', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-cache-v2-ui-'));
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
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
      })
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1120, height: 760 });
    await page.waitForFunction(() => document.documentElement && document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('en');
      const S = window.BOBO.state;
      S.workspaceRoot = 'C:\\fixture\\workspace-a';
      S.workspaceIdentity = 'local-workspace-identity';
      S.selectedRuntime = 'python:3.10';
      const folderKey = window.BOBO.projectKey(S.workspaceRoot);
      const currentWorkspaceId = 'root\u0000' + folderKey;
      window.__cacheRevision = 'revision-1';
      window.__cacheActions = [];
      window.__cacheConfirms = [];
      window.__packageCenterOpen = null;
      window.__primaryView = '';
      window.__cacheEntries = [
        {
          id: 'dep-current', category: 'dependencies', state: 'current', workspace_id: currentWorkspaceId,
          workspace_name: 'Fixture project', runtime_id: 'python:3.10', runtime_fingerprint: 'python-runtime',
          dependency_digest: '0123456789abcdef', generation: 'generation-a', size_bytes: 4096, files: 12,
          created_at: '2026-08-23T10:00:00Z', last_used_at: '2026-08-24T10:00:00Z', active_readers: 0, writing: false
        },
        {
          id: 'dep-history', category: 'dependencies', state: 'superseded', workspace_id: currentWorkspaceId,
          workspace_name: 'Fixture project', runtime_id: 'python:3.10', dependency_digest: 'fedcba9876543210',
          size_bytes: 1024, files: 5, created_at: '2026-08-20T10:00:00Z', last_used_at: '2026-08-21T10:00:00Z'
        },
        {
          id: 'incremental-current', category: 'incremental', state: 'current', workspace_id: currentWorkspaceId,
          workspace_name: 'Fixture project', runtime_id: 'python:3.10', build_target: 'src/main.py',
          content_digest: 'incremental-digest', size_bytes: 2048, files: 7, last_used_at: '2026-08-24T09:30:00Z'
        },
        {
          id: 'result-ready', category: 'results', state: 'ready', workspace_id: currentWorkspaceId,
          workspace_name: 'Fixture project', runtime_id: 'python:3.10', build_target: 'dist/main',
          content_digest: 'result-digest', size_bytes: 512, files: 1, last_used_at: '2026-08-24T09:00:00Z'
        },
        {
          id: 'dep-writing', category: 'dependencies', state: 'current', workspace_id: 'root\u0000other-project',
          workspace_name: 'Busy project', runtime_id: 'python:3.11', dependency_digest: 'writing-digest',
          size_bytes: 256, files: 2, active_readers: 1, writing: true
        },
        { id: 'shared-toolchain', category: 'toolchains', state: 'ready', runtime_id: 'go:1.24', size_bytes: 8192, files: 18 },
        { id: 'lsp-service', category: 'analysis-lsp', state: 'ready', runtime_id: 'python:3.10', size_bytes: 64, files: 1, active_readers: 1 },
        { id: 'dap-service', category: 'debug-dap', state: 'ready', runtime_id: 'python:3.10', size_bytes: 32, files: 1 }
      ];

      window.BOBO.confirm = async (options) => {
        window.__cacheConfirms.push(options);
        return true;
      };
      window.BOBO.packageCenter.open = (options) => { window.__packageCenterOpen = options; };
      window.BOBO.workbench.setPrimaryView = (view) => { window.__primaryView = view; };
      window.BOBO.sendToServer = async (action, data) => {
        window.__cacheActions.push({ action, data });
        if (action === 'listProjects') {
          return { success: true, storageInfo: { total_used_bytes: 16384, quota_bytes: 1048576, persist_bytes: 16384, projects_total_bytes: 0, projects: [] } };
        }
        if (action === 'getCacheInventory') {
          const used = window.__cacheEntries.reduce((sum, entry) => sum + (entry.size_bytes || 0), 0);
          return { success: true, data: { cacheInventory: {
            schema: 2, revision: window.__cacheRevision, owner_kind: 'user', owner_id: 'root',
            quota_bytes: 1048576, used_bytes: used + 65536, managed_bytes: used,
            managed_files: window.__cacheEntries.reduce((sum, entry) => sum + (entry.files || 0), 0),
            reclaimable_bytes: 1024, reserved_bytes: 4096,
            generated_at: '2026-08-24T12:00:00Z', entries: window.__cacheEntries
          } } };
        }
        if (action === 'getCacheEntry') {
          return { success: true, data: { cacheEntry: window.__cacheEntries.find((entry) => entry.id === data.cacheId) } };
        }
        if (action === 'deleteCacheEntry') {
          window.__cacheEntries = window.__cacheEntries.filter((entry) => entry.id !== data.cacheId);
          window.__cacheRevision = 'revision-2';
          return { success: true, data: { revision: window.__cacheRevision } };
        }
        if (action === 'clearCacheScope') {
          if (data.scope === 'shared') window.__cacheEntries = window.__cacheEntries.filter((entry) => entry.workspace_id || /(?:lsp|dap)/.test(entry.category));
          else if (data.scope === 'workspace') window.__cacheEntries = window.__cacheEntries.filter((entry) => entry.workspace_id !== data.workspaceId);
          else window.__cacheEntries = window.__cacheEntries.filter((entry) => /(?:lsp|dap)/.test(entry.category));
          window.__cacheRevision = 'revision-3';
          return { success: true, data: { revision: window.__cacheRevision } };
        }
        throw new Error('unexpected storage action: ' + action);
      };
      window.BOBO.cacheStore.reset();
      window.BOBO.projects.open({ tab: 'cache' });
    });

    await expect(page.locator('#projects-modal')).toHaveClass(/open/);
    await expect(page.locator('#projects-modal')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#projects-tab-cache')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.cache-v2-shell')).toBeVisible();
    await expect(page.locator('.cache-v2-usage > span strong')).not.toContainText('/');
    await expect(page.locator('.cache-v2-usage > small')).toContainText('Account storage');
    await expect(page.locator('.cache-v2-usage > small')).toContainText('reclaimable');

    const projects = page.locator('.cache-v2-project');
    await expect(projects).toHaveCount(2);
    await expect(projects.first()).toHaveClass(/is-current/);
    await expect(projects.first()).toContainText('Fixture project');
    await expect(projects.first().locator('.cache-v2-category')).toHaveCount(3);
    await expect(projects.first()).toContainText('Dependencies');
    await expect(projects.first()).toContainText('Incremental builds');
    await expect(projects.first()).toContainText('Build results');
    await expect(projects.first().locator('.cache-v2-entry[data-cache-entry="dep-current"]')).toContainText('Current');
    await expect(projects.first().locator('.cache-v2-entry[data-cache-entry="result-ready"]')).toContainText('Available');
    await expect(projects.first().locator('.cache-v2-history')).not.toHaveClass(/open/);
    await expect(projects.first().locator('.cache-v2-entry[data-cache-entry="dep-history"]')).not.toBeVisible();

    await expect(page.locator('.cache-v2-shared')).toContainText('Toolchains');
    await expect(page.locator('.cache-v2-services')).toContainText('analysis-lsp');
    await expect(page.locator('.cache-v2-services')).toContainText('debug-dap');
    await expect(page.locator('.cache-v2-services .cache-v2-icon-btn[data-cache-action="delete"]')).toHaveCount(0);
    await expect(page.locator('.cache-v2-shared')).not.toContainText('analysis-lsp');
    await expect(page.locator('.cache-v2-metrics').locator('span').first()).toContainText('6');

    const currentEntry = page.locator('.cache-v2-entry[data-cache-entry="dep-current"]');
    await currentEntry.locator('[data-cache-action="details"]').click();
    await expect(currentEntry.locator('.cache-v2-entry-detail')).toContainText('python-runtime');
    await expect.poll(() => page.evaluate(() => window.__cacheActions.some((item) => item.action === 'getCacheEntry' && item.data.cacheId === 'dep-current'))).toBe(true);

    const busyProject = projects.filter({ hasText: 'Busy project' });
    await busyProject.locator('.cache-v2-project-toggle').click();
    await expect(busyProject.locator('[data-cache-action="delete"]')).toBeDisabled();
    await expect(busyProject.locator('[data-cache-action="clear-project"]')).toBeDisabled();

    await projects.first().locator('[data-cache-action="history"]').click();
    const oldEntry = page.locator('.cache-v2-entry[data-cache-entry="dep-history"]');
    await expect(oldEntry).toBeVisible();
    await oldEntry.locator('[data-cache-action="delete"]').click();
    await expect(oldEntry).toHaveCount(0);
    const deleteRequest = await page.evaluate(() => window.__cacheActions.find((item) => item.action === 'deleteCacheEntry'));
    expect(deleteRequest.data).toEqual({ cacheId: 'dep-history', expectedRevision: 'revision-1' });

    await page.locator('#cache-v2-scope').selectOption('shared');
    await page.locator('[data-cache-action="clear"]').click();
    await expect(page.locator('.cache-v2-shared')).toHaveCount(0);
    const clearResult = await page.evaluate(() => ({
      confirms: window.__cacheConfirms.slice(-2).map((item) => item.title),
      request: window.__cacheActions.find((item) => item.action === 'clearCacheScope')
    }));
    expect(clearResult.confirms).toEqual(['Clear selected cache', 'Confirm permanent cache removal']);
    expect(clearResult.request.data).toEqual({ scope: 'shared', expectedRevision: 'revision-2' });

    await page.locator('#cache-v2-scope').selectOption('all');
    for (const locale of ['zh-CN', 'ja', 'en']) {
      const expected = await page.evaluate(async (nextLocale) => {
        await window.BOBO.i18n.setLocale(nextLocale);
        return window.BOBO.i18n.t('Project caches');
      }, locale);
      await expect(page.locator('.cache-v2-section').first()).toContainText(expected);
    }

    await page.evaluate(() => {
      const toastContainer = document.getElementById('toast-container');
      if (toastContainer) toastContainer.replaceChildren();
    });
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-cache-v2-projects.png'), fullPage: false });

    await page.setViewportSize({ width: 640, height: 720 });
    await expect.poll(async () => page.evaluate(() => {
      const cache = document.getElementById('cache-tree');
      const rows = [...cache.querySelectorAll('.cache-v2-entry-main,.cache-v2-project-head,.cache-v2-toolbar')];
      return cache.scrollWidth <= cache.clientWidth + 1 && rows.every((row) => row.scrollWidth <= row.clientWidth + 1);
    })).toBe(true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-cache-v2-narrow.png'), fullPage: false });
    await page.setViewportSize({ width: 1120, height: 760 });

    await page.locator('#cache-v2-scope').selectOption('all');
    await page.locator('.cache-v2-entry[data-cache-entry="dep-current"] [data-cache-action="packages"]').click();
    await expect(page.locator('#projects-modal')).not.toHaveClass(/open/);
    const packageRoute = await page.evaluate(() => ({ mode: window.__packageCenterOpen, view: window.__primaryView }));
    expect(packageRoute).toEqual({ mode: { mode: 'installed' }, view: 'environment' });
    expect(errors).toEqual([]);
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
