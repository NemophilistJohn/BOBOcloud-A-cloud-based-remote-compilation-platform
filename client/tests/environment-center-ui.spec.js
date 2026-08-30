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

test('environment view switches, persists, localizes, and fits at 180px', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-environment-ui-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'compact-environment-workspace-with-a-long-name');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'requirements-production-with-a-long-name.txt'), 'numpy==2.2.6\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'main.py'), 'import numpy\nimport matplotlib.pyplot as plt\n', 'utf8');
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

    const activity = page.locator('#activity-environment');
    const center = page.locator('#environment-center');
    await expect(activity).toBeVisible();
    await expect(activity).toHaveAttribute('data-workbench-view', 'environment');
    await expect(center).toHaveAttribute('data-sidebar-view', 'environment');
    await activity.click();
    await expect(activity).toHaveAttribute('aria-pressed', 'true');
    await expect(center).toHaveClass(/active/);
    expect(await page.evaluate(() => window.BOBO.workbench.getState().activity)).toBe('environment');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bobocloud.workbench.v1')).activity)).toBe('environment');

    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await expect(page.locator('#activity-environment')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#environment-center')).toHaveClass(/active/);

    await page.evaluate(async (workspacePath) => {
      window.BOBO.sendToServer = async () => { throw new Error('offline UI fixture'); };
      const selected = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(selected.rootPath, selected.tree);
      await window.BOBO.environmentCenter.refresh();
    }, workspace);
    await expect(page.locator('#environment-center-ready')).toBeVisible();
    await page.evaluate(() => {
      document.getElementById('environment-context-heading').textContent = 'compact-environment-workspace-with-a-long-name';
      document.getElementById('environment-context-image').textContent = 'ghcr.io/bobocloud/python-runtime:3.12-bookworm';
    });
    const manifestRow = page.locator('#environment-manifest-list button.environment-list-link');
    await expect(manifestRow).toHaveCount(1);
    await manifestRow.focus();
    const manifestStyle = await manifestRow.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: element.getBoundingClientRect().width, parentWidth: element.parentElement.getBoundingClientRect().width, appearance: style.appearance };
    });
    expect(Math.abs(manifestStyle.width - manifestStyle.parentWidth)).toBeLessThanOrEqual(1);
    expect(manifestStyle.appearance).toBe('none');

    await page.evaluate(async () => {
      window.__environmentCalls = [];
      window.__environmentRepaired = false;
      window.BOBO.confirm = async () => true;
      window.BOBO.sendToServer = async (action, data) => {
        window.__environmentCalls.push({ action, data });
        if (action === 'planProjectEnvironmentRepair') {
          return {
            success: true,
            data: {
              schema: 'project-environment-repair-plan/v1',
              supported: true,
              requiresConfirmation: true,
              steps: [{ id: 'install-python-requirements', description: 'Install requirements.txt' }]
            }
          };
        }
        if (action === 'applyProjectEnvironmentAction') {
          window.__environmentRepaired = true;
          return { success: true, data: { schema: 'project-environment-action/v1', action: 'repair', applied: true } };
        }
        if (action !== 'getProjectEnvironment') throw new Error('unexpected action: ' + action);
        const repaired = window.__environmentRepaired;
        return {
          success: true,
          data: {
            schema: 'project-environment/v1',
            revision: repaired ? 'verified-2' : 'missing-1',
            checkedAt: Date.now(),
            workspace: { kind: 'personal', id: 'fixture', name: 'compact-environment-workspace-with-a-long-name', key: data.folderKey },
            language: { id: 'python', source: 'editor' },
            runtime: { id: 'python:3.10', language: 'python', version: '3.10', image: 'python:3.10-slim', displayName: 'Python 3.10', status: 'ready' },
            dependencyCache: {
              scope: 'project-lock',
              status: repaired ? 'hit' : 'miss',
              digest: '0123456789abcdef0123456789abcdef',
              source: 'lock',
              sizeBytes: repaired ? 4096 : 0,
              lastUsedAt: repaired ? Date.now() : 0
            },
            manifests: [{ path: 'requirements-production-with-a-long-name.txt', kind: 'requirements', manager: 'pip', language: 'python', parsed: true, status: 'parsed' }],
            packages: {
              declared: [{ name: 'numpy', constraint: '==2.2.6', source: 'requirements-production-with-a-long-name.txt' }],
              installed: repaired ? [{ name: 'numpy', version: '2.2.6', source: 'runtime', trust: 'runtime-scoped' }] : [],
              missing: repaired ? [] : [{ name: 'numpy', constraint: '==2.2.6', source: 'requirements-production-with-a-long-name.txt', reason: 'Not installed' }],
              unknown: []
            },
            consistency: {
              status: repaired ? 'aligned' : 'missing',
              languageRuntime: { status: 'aligned', detail: 'Language and runtime agree' },
              dependencyRuntime: { status: repaired ? 'ready' : 'missing', detail: repaired ? 'Runtime dependencies match' : 'One dependency is missing' },
              lspDependencies: { status: 'ready', detail: 'Dependency view is current' }
            },
            activity: {},
            actions: {
              repair: { supported: !repaired, requiresConfirmation: true, reason: repaired ? 'No repairable dependency issues were found' : '' },
              rebuild: { supported: true, requiresConfirmation: true },
              refreshIndex: { supported: false, reason: 'Remote analysis is not ready' },
              clearCache: { supported: true, scope: 'workspace', requiresConfirmation: true }
            }
          }
        };
      };
      window.BOBO.state.serverSettings.ip = 'fixture.example';
      window.BOBO.state.selectedRuntime = 'python:3.10';
      await window.BOBO.environmentCenter.refresh({ force: true });
    });
    const repair = page.locator('#environment-action-repair');
    await expect(repair).toBeEnabled();
    await expect(page.locator('#environment-missing-count')).toHaveText('1');
    await expect(page.locator('#environment-context-dependency-scope')).toHaveText('Project and lock digest');
    await expect(page.locator('#environment-context-cache-status')).toHaveText('Not materialized');
    await expect(page.locator('#environment-context-dependency-digest')).toHaveText('lock / 0123456789abcdef');
    await expect(page.locator('#environment-context-dependency-digest')).toHaveAttribute('title', '0123456789abcdef0123456789abcdef');
    await repair.click();
    await expect.poll(async () => page.evaluate(() => window.__environmentCalls.map((entry) => entry.action))).toEqual(expect.arrayContaining([
      'planProjectEnvironmentRepair',
      'applyProjectEnvironmentAction',
      'getProjectEnvironment'
    ]));
    await expect(repair).toBeDisabled();
    await expect(page.locator('#environment-installed-count')).toHaveText('1');
    await expect(page.locator('#environment-missing-count')).toHaveText('0');
    await expect(page.locator('#environment-context-cache-status')).toHaveText('Cached');
    await expect(page.locator('#environment-center-busy')).toBeHidden();
    expect(await page.evaluate(() => window.__environmentCalls.filter((entry) => entry.action === 'getProjectEnvironment').every((entry) => Array.isArray(entry.data.setupCommands)))).toBe(true);

    await page.evaluate(async (filePath) => {
      await window.BOBO.workspace.openFile(filePath, 'main.py');
      const model = window.BOBO.state.editor.getModel();
      window.monaco.editor.setModelMarkers(model, 'environment-center-fixture', [
        {
          startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 13,
          severity: window.monaco.MarkerSeverity.Error,
          message: 'Import "numpy" could not be resolved', source: 'Pyright', code: 'reportMissingImports'
        },
        {
          startLineNumber: 2, startColumn: 8, endLineNumber: 2, endColumn: 25,
          severity: window.monaco.MarkerSeverity.Error,
          message: 'Import "matplotlib.pyplot" could not be resolved', source: 'Pyright', code: 'reportMissingImports'
        }
      ]);
    }, path.join(workspace, 'main.py'));
    await expect(page.locator('#environment-overall-status')).toHaveText('Issue detected');
    await expect(page.locator('#environment-health-dependencies-state')).toHaveText('Healthy');
    await expect(page.locator('#environment-health-dependencies-detail')).toHaveText('Runtime dependencies match');
    await expect(page.locator('#environment-health-lsp-state')).toHaveText('Needs attention');
    await expect(page.locator('#environment-health-lsp-detail')).toContainText('1 unresolved dependency import');
    await expect(page.locator('#environment-missing-count')).toHaveText('1');
    await expect(page.locator('#environment-missing-list')).not.toContainText('numpy');
    await expect(page.locator('#environment-missing-list')).toContainText('matplotlib');
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-environment-live-diagnostics.png'), fullPage: false });
    await page.evaluate(() => {
      window.monaco.editor.setModelMarkers(window.BOBO.state.editor.getModel(), 'environment-center-fixture', []);
    });
    await expect(page.locator('#environment-health-dependencies-state')).toHaveText('Healthy');
    await expect(page.locator('#environment-overall-status')).not.toHaveText('Issue detected');
    await expect(page.locator('#environment-missing-count')).toHaveText('0');

    await page.evaluate(() => window.BOBO.workbench.setPanelPosition('bottom'));
    await page.waitForTimeout(280);
    const editorHeightWithPanel = await page.locator('#container').evaluate((element) => element.getBoundingClientRect().height);
    await page.locator('#panel-close').click();
    await expect(page.locator('#bottom-panel')).toBeHidden();
    await expect.poll(async () => page.locator('#container').evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(editorHeightWithPanel + 100);
    await expect.poll(async () => page.evaluate(() => {
      const container = document.getElementById('container').getBoundingClientRect();
      const viewport = document.querySelector('#container .monaco-editor .overflow-guard').getBoundingClientRect();
      return Math.abs(Math.round(container.height - viewport.height));
    })).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-panel-closed-layout.png'), fullPage: false });

    const resizer = page.locator('#sidebar-resizer');
    await resizer.focus();
    await resizer.press('Home');
    await expect(resizer).toHaveAttribute('aria-valuenow', '180');
    await expect.poll(async () => Math.round(await page.locator('#environment-center-ready').evaluate((element) => element.getBoundingClientRect().width))).toBe(179);
    const fit = await page.evaluate(() => {
      const center = document.getElementById('environment-center');
      const ready = document.getElementById('environment-center-ready').getBoundingClientRect();
      const scroll = document.querySelector('.environment-center-scroll').getBoundingClientRect();
      const dock = document.querySelector('.environment-action-dock').getBoundingClientRect();
      const controls = [...document.querySelectorAll('.environment-action-dock button')].map((item) => item.getBoundingClientRect());
      return {
        width: ready.width,
        noHorizontalOverflow: center.scrollWidth <= center.clientWidth + 1,
        noOverlap: scroll.bottom <= dock.top + 0.5,
        dockInside: dock.left >= ready.left && dock.right <= ready.right + 0.5 && dock.bottom <= ready.bottom + 0.5,
        controlsInside: controls.every((item) => item.left >= dock.left && item.right <= dock.right + 0.5)
      };
    });
    expect(Math.round(fit.width)).toBe(179);
    expect(fit.noHorizontalOverflow).toBe(true);
    expect(fit.noOverlap).toBe(true);
    expect(fit.dockInside).toBe(true);
    expect(fit.controlsInside).toBe(true);

    await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('en');
      window.__cacheRevision = 'revision-1';
      window.__cacheEntries = [
        {
          id: 'dep-current', category: 'dependencies', state: 'current', workspace_id: 'root\u0000fixture-project',
          workspace_name: 'Fixture project', runtime_id: 'python:3.10', dependency_digest: '0123456789abcdef',
          generation: 'generation-a', size_bytes: 4096, files: 12, active_readers: 0, writing: false
        },
        {
          id: 'dep-history', category: 'dependencies', state: 'superseded', workspace_id: 'root\u0000fixture-project',
          workspace_name: 'Fixture project', runtime_id: 'node:22', dependency_digest: 'aabbccddeeff0011',
          generation: 'generation-old', size_bytes: 2048, files: 9, active_readers: 0, writing: false
        },
        {
          id: 'dep-writing', category: 'dependencies', state: 'current', workspace_id: 'root\u0000active-project',
          workspace_name: 'Active project', runtime_id: 'python:3.13', dependency_digest: '1122334455667788',
          size_bytes: 512, files: 2, active_readers: 1, writing: true
        },
        { id: 'shared-toolchain', category: 'toolchains', state: 'ready', runtime_id: 'go:1.24', size_bytes: 1024, files: 2 }
      ];
      window.__cacheActions = [];
      window.BOBO.sendToServer = async (action, data) => {
        window.__cacheActions.push({ action, data });
        if (action === 'listProjects') {
		  return { success: true, storageInfo: { total_used_bytes: 7680, quota_bytes: 1048576, persist_bytes: 7680, projects_total_bytes: 0, projects: [] } };
        }
        if (action === 'getCacheInventory') {
          const managedBytes = window.__cacheEntries.reduce((sum, entry) => sum + entry.size_bytes, 0);
          return { success: true, data: { cacheInventory: {
            schema: 2, revision: window.__cacheRevision, owner_kind: 'user', owner_id: 'root',
            quota_bytes: 1048576, used_bytes: managedBytes, managed_bytes: managedBytes,
            managed_files: window.__cacheEntries.reduce((sum, entry) => sum + entry.files, 0),
            reclaimable_bytes: 2048, reserved_bytes: 0, generated_at: '2026-08-30T12:00:00Z',
            entries: window.__cacheEntries
          } } };
        }
        throw new Error('unexpected storage action: ' + action);
      };
      window.BOBO.cacheStore.reset();
      window.BOBO.projects.open({ tab: 'cache' });
    });
    await expect(page.locator('#projects-modal')).toHaveClass(/open/);
    await expect(page.locator('#projects-tab-cache')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => page.evaluate(() => window.__cacheActions.some((entry) => entry.action === 'getCacheInventory'))).toBe(true);
    const fixtureGroup = page.locator('.cache-v2-project').filter({ hasText: 'Fixture project' });
    await expect(page.locator('.cache-v2-shell')).toContainText('Project caches');
    await expect(fixtureGroup).toHaveCount(1);
    await expect(fixtureGroup).toContainText('python:3.10');
    await expect(fixtureGroup).toContainText('0123456789ab');
    const removableCache = page.locator('.cache-v2-entry[data-cache-entry="dep-history"]');
    await expect(removableCache).toContainText('node:22');
    await expect(page.locator('.cache-v2-shared')).toContainText('Toolchains');
    const activeGroup = page.locator('.cache-v2-project').filter({ hasText: 'Active project' });
    await expect(activeGroup).toHaveCount(1);
    await expect(activeGroup.locator('[data-cache-action="delete"]')).toBeDisabled();
    await expect(activeGroup.locator('[data-cache-action="clear-project"]')).toBeDisabled();
    for (const locale of ['zh-CN', 'ja', 'en']) {
      const expectedProjectCaches = await page.evaluate(async (nextLocale) => {
        await window.BOBO.i18n.setLocale(nextLocale);
        return window.BOBO.i18n.t('Project caches');
      }, locale);
      await expect(page.locator('.cache-v2-section').first()).toContainText(expectedProjectCaches);
    }
    await page.evaluate(() => {
      const toastContainer = document.getElementById('toast-container');
      if (toastContainer) toastContainer.replaceChildren();
    });
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-project-cache-by-project.png'), fullPage: false });
    await page.setViewportSize({ width: 640, height: 720 });
    await expect.poll(async () => page.evaluate(() => {
      const cache = document.querySelector('.cache-v2-shell');
      const rows = [...cache.querySelectorAll('.cache-v2-entry')];
      return cache.scrollWidth <= cache.clientWidth + 1 && rows.every((row) => row.scrollWidth <= row.clientWidth + 1);
    })).toBe(true);
    await page.evaluate(() => {
      const toastContainer = document.getElementById('toast-container');
      if (toastContainer) toastContainer.replaceChildren();
    });
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-project-cache-narrow.png'), fullPage: false });
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-project-dependency-cache.png'), fullPage: false });
    await page.locator('#projects-close').click();

    await page.evaluate(() => {
      window.BOBO.sendToServer = async (action) => {
        if (action !== 'listRunHistory') throw new Error('unexpected history action: ' + action);
        return {
          success: true,
          history: [{
            run_id: 'truncated-fixture',
            file_path: 'main.py',
            runtime: 'python:3.10',
            status: 'completed',
            exit_code: 0,
            duration_ms: 12,
            output_summary: 'newest output',
            output_truncated: true,
            created_at: new Date().toISOString()
          }]
        };
      };
    });
    await page.locator('#history-btn').click();
    await expect(page.locator('#history-modal')).toBeVisible();
    await page.locator('.history-row').click();
    await expect(page.locator('#history-detail-output')).toHaveText('Earlier output was not retained.\n\nnewest output');
    await page.locator('#history-close').click();

    for (const locale of ['en', 'zh-CN', 'ja']) {
      const copy = await page.evaluate(async (nextLocale) => {
        await window.BOBO.i18n.setLocale(nextLocale);
        return {
          title: [window.BOBO.i18n.t('Environment Center'), document.querySelector('#environment-center .sidebar-header > span').textContent],
          health: [window.BOBO.i18n.t('Environment health'), document.getElementById('environment-health-heading').textContent],
          repair: [window.BOBO.i18n.t('Repair issues'), document.querySelector('#environment-action-repair span').textContent],
          refresh: [window.BOBO.i18n.t('Remote analysis is not ready'), document.getElementById('environment-action-refresh').title],
          activity: [window.BOBO.i18n.t('Project environment'), document.getElementById('activity-environment').getAttribute('aria-label')]
        };
      }, locale);
      Object.values(copy).forEach(([expected, actual]) => expect(actual).toBe(expected));
    }
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-environment-center-narrow-ja.png'), fullPage: false });
    expect(errors).toEqual([]);
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
