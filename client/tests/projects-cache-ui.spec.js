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

test('project cache view separates dependency writes from analysis leases', async () => {
  test.setTimeout(45000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-project-cache-ui-'));
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
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('en');
      window.__deletedCaches = [];
      window.__cacheConfirms = [];
      window.BOBO.confirm = async (options) => {
        window.__cacheConfirms.push(options);
        return true;
      };
      window.BOBO.sendToServer = async (action, data) => {
        if (action === 'listProjects') {
          return { success: true, storageInfo: { total_used_bytes: 8704, quota_bytes: 1048576, persist_bytes: 8704, projects_total_bytes: 0, projects: [] } };
        }
        if (action === 'listCacheModules') {
          const pythonModules = [
            { name: 'Fixture project', path: 'project-dependencies/workspace/runtime/python/digest-a', size_bytes: 4096, files: 12, kind: 'project-dependency', project_name: 'Fixture project', runtime_id: 'python:3.10', digest: '0123456789abcdef', digest_source: 'lock', last_used: Date.now() },
            { name: 'Active project', path: 'project-dependencies/workspace/runtime/python/digest-active', size_bytes: 1024, files: 4, kind: 'project-dependency', project_name: 'Active project', runtime_id: 'python:3.11', digest: 'fedcba9876543210', digest_source: 'manifest', last_used: Date.now(), active: true },
            { name: 'Active project', path: 'project-dependencies/workspace/runtime/python/digest-writing', size_bytes: 512, files: 2, kind: 'project-dependency', project_name: 'Active project', runtime_id: 'python:3.13', digest: '1122334455667788', digest_source: 'manifest', last_used: Date.now(), active: true, writing: true },
            { name: 'pip-cache', path: 'pip-cache', size_bytes: 1024, files: 2, kind: 'legacy-cache' }
          ].filter((item) => !window.__deletedCaches.includes(item.path));
          const nodeModules = [
            { name: 'Fixture project', path: 'project-dependencies/workspace/runtime/node/digest-node', size_bytes: 2048, files: 9, kind: 'project-dependency', project_name: 'Fixture project', runtime_id: 'node:22', digest: 'aabbccddeeff0011', digest_source: 'manifest', last_used: Date.now() - 1000 }
          ].filter((item) => !window.__deletedCaches.includes(item.path));
          return { success: true, cacheGroups: [
            { language: 'python', label: 'Python', modules: pythonModules },
            { language: 'node', label: 'Node.js', modules: nodeModules }
          ] };
        }
        if (action === 'deleteCacheModule') {
          window.__deletedCaches.push(data.cachePath);
          return { success: true };
        }
        throw new Error('unexpected storage action: ' + action);
      };
      window.BOBO.projects.open();
    });

    await expect(page.locator('#projects-modal')).toHaveClass(/open/);
    await page.locator('.projects-tab[data-ptab="cache"]').click();
    const activeGroup = page.locator('.cache-project-group').filter({ hasText: 'Active project' });
    const fixtureGroup = page.locator('.cache-project-group').filter({ hasText: 'Fixture project' });
    await expect(activeGroup).toContainText('Updating');
    await expect(activeGroup).toContainText('Service in use');
    await expect(fixtureGroup).toHaveCount(1);
    await expect(fixtureGroup).toContainText('2 snapshots');
    await fixtureGroup.locator('.cache-project-header').click();
    await expect(fixtureGroup).toContainText('python:3.10');
    await expect(fixtureGroup).toContainText('node:22');

    const analysisCache = page.locator('.cache-del[data-path="project-dependencies/workspace/runtime/python/digest-active"]');
    const writingCache = page.locator('.cache-del[data-path="project-dependencies/workspace/runtime/python/digest-writing"]');
    const idleCache = page.locator('.cache-del[data-path="project-dependencies/workspace/runtime/python/digest-a"]');
    await expect(analysisCache).toBeEnabled();
    await expect(analysisCache).toHaveAttribute('title', 'Delete cache and stop service');
    await expect(writingCache).toBeDisabled();
    await expect(writingCache).toHaveAttribute('title', 'Cache is being updated');
    await expect.poll(async () => page.evaluate(() => [...document.querySelectorAll('.cache-snapshot-row')].every((row) => {
      const state = row.querySelector('.cache-snapshot-state').getBoundingClientRect();
      const used = row.querySelector('.cache-snapshot-used').getBoundingClientRect();
      return state.right <= used.left + 0.5;
    }))).toBe(true);

    for (const locale of ['zh-CN', 'ja', 'en']) {
      const expected = await page.evaluate(async (nextLocale) => {
        await window.BOBO.i18n.setLocale(nextLocale);
        return {
          updating: window.BOBO.i18n.t('Updating'),
          analysis: window.BOBO.i18n.t('Service in use')
        };
      }, locale);
      await expect(activeGroup).toContainText(expected.updating);
      await expect(activeGroup).toContainText(expected.analysis);
    }

    await page.evaluate(() => {
      const toastContainer = document.getElementById('toast-container');
      if (toastContainer) toastContainer.replaceChildren();
    });
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-project-cache-by-project.png'), fullPage: false });

    await page.setViewportSize({ width: 640, height: 720 });
    await expect.poll(async () => page.evaluate(() => {
      const cache = document.getElementById('cache-tree');
      const rows = [...cache.querySelectorAll('.cache-snapshot-row')];
      return cache.scrollWidth <= cache.clientWidth + 1 && rows.every((row) => row.scrollWidth <= row.clientWidth + 1);
    })).toBe(true);
    await page.evaluate(() => {
      document.getElementById('cache-tree').scrollTop = 145;
      const toastContainer = document.getElementById('toast-container');
      if (toastContainer) toastContainer.replaceChildren();
    });
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-project-cache-narrow.png'), fullPage: false });
    await page.setViewportSize({ width: 1024, height: 720 });

    await analysisCache.click();
    await expect.poll(() => page.evaluate(() => window.__deletedCaches)).toContain('project-dependencies/workspace/runtime/python/digest-active');
    await expect(analysisCache).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__cacheConfirms.at(-1).message)).toContain('Deleting this cache will stop the service that is using it.');
    await expect(writingCache).toBeDisabled();
    await idleCache.click();
    await expect.poll(() => page.evaluate(() => window.__deletedCaches)).toContain('project-dependencies/workspace/runtime/python/digest-a');
    await expect(idleCache).toHaveCount(0);
    await expect(fixtureGroup).toContainText('node:22');
    expect(errors).toEqual([]);
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
