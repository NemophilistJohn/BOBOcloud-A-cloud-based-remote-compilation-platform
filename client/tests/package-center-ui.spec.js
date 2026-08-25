const { test, expect, _electron: electron } = require('playwright/test');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('project dependency center plans, applies, and rolls back project-scoped dependencies', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-package-center-ui-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'package-center-workspace');
  const firstManifest = path.join(workspace, 'requirements-a.txt');
  const secondManifest = path.join(workspace, 'requirements-b.txt');
  const initialContent = 'requests==2.31.0\nbrokenlib==1.0.0\n';
  const appliedContent = 'requests==2.31.0\nbrokenlib==1.0.0\nnumpy==2.3.1\n';
  const failedContent = appliedContent + 'pandas==2.3.1\n';
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
  fs.writeFileSync(firstManifest, initialContent, 'utf8');
  fs.writeFileSync(secondManifest, 'pytest==8.4.1\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'main.py'), 'import numpy\n', 'utf8');

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
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.waitForFunction(() => document.documentElement && document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    await page.evaluate(async ({ workspacePath, hashes, contents }) => {
      const selected = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(selected.rootPath, selected.tree);
      window.BOBO.state.serverSettings.ip = 'fixture.example';
      window.BOBO.state.serverSettings.user = 'fixture';
      window.BOBO.state.auth = { mode: 'multi', token: 'fixture-token-1', user: { id: 'alice', username: 'alice' } };
      window.BOBO.state.selectedRuntime = 'python:3.11';
      window.__packageFixture = {
        unsupported: true,
        applied: false,
        failLocalApplyOnce: true,
        failApply: false,
        failSearchOnce: false,
        failCommitCount: 1,
        failRefresh: true,
        lspRefreshResult: true,
        transportLossOnce: true,
        unavailableOnce: true,
        cacheMissingMode: false,
        rejectPlanRequests: false,
        switchIdentityOnApply: false,
        failSyncAt: 0,
        confirmResult: true,
        confirmation: null,
        calls: [],
        syncCount: 0,
        commitCount: 0,
        rollbackCount: 0,
        lspRefreshCount: 0,
        environmentRefreshes: [],
        cacheInvalidations: [],
        hashes,
        contents
      };
      window.BOBO.confirm = async options => {
        window.__packageFixture.confirmation = options;
        return window.__packageFixture.confirmResult;
      };
      window.BOBO.runner.manualSyncWithServer = async () => {
        window.__packageFixture.syncCount += 1;
        if (window.__packageFixture.syncCount === window.__packageFixture.failSyncAt) return false;
        return true;
      };
      window.BOBO.lsp.dependenciesChanged = () => {
        window.__packageFixture.lspRefreshCount += 1;
        if (window.__packageFixture.failRefresh) throw new Error('Fixture language refresh failed');
        window.__packageFixture.lspRefreshed = true;
        return window.__packageFixture.lspRefreshResult;
      };
      window.BOBO.lsp.getMode = () => 'standard';
      window.BOBO.environmentCenter.scheduleRefresh = (reason, delay) => {
        window.__packageFixture.environmentRefreshes.push({ reason, delay });
      };
      window.BOBO.cacheStore.invalidate = detail => {
        window.__packageFixture.cacheInvalidations.push(detail);
      };
      const nativeApi = window.api;
      window.BOBO.packageCenterLocalApi = {
        readFile: filePath => nativeApi.readFile(filePath),
        packageCenterApplyLocalChanges: payload => {
          if (window.__packageFixture.failLocalApplyOnce) {
            window.__packageFixture.failLocalApplyOnce = false;
            return Promise.resolve({ success: false, error: { code: 'fixture_local_apply_failed', message: 'Fixture local apply failed' } });
          }
          return nativeApi.packageCenterApplyLocalChanges(payload);
        },
        packageCenterRollbackLocalChanges: payload => {
          window.__packageFixture.rollbackCount += 1;
          return nativeApi.packageCenterRollbackLocalChanges(payload);
        },
        packageCenterCommitLocalChanges: payload => {
          window.__packageFixture.commitCount += 1;
          if (window.__packageFixture.failCommitCount > 0) {
            window.__packageFixture.failCommitCount -= 1;
            return Promise.resolve({ success: false, error: { code: 'fixture_commit_failed', message: 'Fixture commit failed' } });
          }
          return nativeApi.packageCenterCommitLocalChanges(payload);
        }
      };
      window.BOBO.sendToServer = async (action, data) => {
        const fixture = window.__packageFixture;
        fixture.calls.push({ action, data });
        if (action === 'getProjectEnvironment') return { success: false, error: 'not part of package fixture' };
        if (action === 'getPackageCenterContext') {
          const cacheMissing = fixture.cacheMissingMode;
          return { success: true, data: {
            schema: 'project-package-center/v1',
            revision: cacheMissing ? 'environment-cache-missing' : (fixture.applied ? 'environment-2' : 'environment-1'),
            workspace: { kind: 'personal', id: 'alice\u0000' + data.folderKey, key: data.folderKey, name: 'package-center-workspace' },
            language: { id: 'python', displayName: 'Python' },
            runtime: { id: 'python:3.11', displayName: 'Python 3.11', version: '3.11', interpreterVersion: '3.11.13' },
            sources: [
              { id: 'pypi-official', name: 'PyPI', kind: 'official', official: true },
              { id: 'pypi-tuna', name: 'TUNA', kind: 'mirror' }
            ],
            defaultSource: 'pypi-tuna',
            defaultManifestPath: 'requirements-a.txt',
            searchMode: 'exact',
            manifests: [
              { path: 'requirements-a.txt', manager: 'pip', kind: 'requirements', language: 'python' },
              { path: 'requirements-b.txt', manager: 'pip', kind: 'requirements', language: 'python' }
            ],
            packages: {
              declared: cacheMissing ? [
                { name: 'brokenlib', constraint: '==1.0.0', source: 'requirements-a.txt' }
              ] : [
                { name: 'requests', constraint: '==2.31.0', source: 'requirements-a.txt' },
                { name: 'brokenlib', constraint: '==1.0.0', source: 'requirements-a.txt' }
              ],
              installed: cacheMissing ? [] : [
                { name: 'requests', version: '2.31.0', relationship: 'direct', trust: 'exact' },
                { name: 'urllib3', version: '2.5.0', relationship: 'transitive', trust: 'exact' },
                ...(fixture.applied ? [{ name: 'numpy', version: '2.3.1', relationship: 'direct', trust: 'exact' }] : [])
              ],
              missing: cacheMissing ? [] : [
                { name: 'numpy', reason: 'Import could not be resolved' },
                { name: 'brokenlib', constraint: '==1.0.0', source: 'requirements-a.txt', reason: 'Missing from exact inventory' }
              ],
              unknown: cacheMissing ? [
                { name: 'brokenlib', constraint: '==1.0.0', source: 'requirements-a.txt', reason: 'Project dependency cache is missing' }
              ] : []
            },
            inventory: cacheMissing ? {
              status: 'missing',
              exact: false,
              dependencyDigest: 'dependency-digest-cache-missing'
            } : {
              status: 'ready',
              exact: true,
              cacheEntryId: fixture.applied ? 'cache-environment-2' : 'cache-environment-1',
              generation: fixture.applied ? 'generation-2' : 'generation-1',
              dependencyDigest: fixture.applied ? 'dependency-digest-2' : 'dependency-digest-1'
            },
            canPlanChanges: { supported: !fixture.unsupported, reason: fixture.unsupported ? 'Fixture policy blocks changes' : '' }
          } };
        }
        if (action === 'searchPackageCatalog') {
          if (fixture.failSearchOnce) {
            fixture.failSearchOnce = false;
            return { success: false, error: { message: 'Fixture install failed' } };
          }
          const name = String(data.query || '').toLowerCase();
          const version = name === 'urllib3' ? '2.5.0' : (name === 'brokenlib' ? '1.0.0' : '2.3.1');
          return { success: true, data: { searchMode: 'exact', query: name, items: name ? [{
            name,
            latestVersion: name === 'numpy' ? '2.4.0' : version,
            recommendedVersion: version,
            description: name === 'numpy' ? 'Array computing' : 'Data analysis',
            compatibility: 'metadata-compatible',
            catalogAuthority: 'pypi.tuna.tsinghua.edu.cn',
            projectCached: name === 'numpy'
          }] : [] } };
        }
        if (action === 'getPackageCatalogItem') {
          const packageName = String(data.packageName || '').toLowerCase();
          const version = packageName === 'urllib3' ? '2.5.0' : (packageName === 'brokenlib' ? '1.0.0' : '2.3.1');
          return { success: true, data: {
            name: data.packageName,
            latestVersion: packageName === 'numpy' ? '2.4.0' : version,
            recommendedVersion: version,
            description: 'Fixture package',
            catalogAuthority: 'pypi.tuna.tsinghua.edu.cn',
            compatibility: 'metadata-compatible',
            versions: [
              ...(packageName === 'numpy' ? [{ version: '2.4.0', compatibility: 'incompatible', reason: 'Requires Python >=3.12' }] : []),
              { version: '2.4.0rc1', compatibility: 'metadata-compatible' },
              { version, compatibility: 'metadata-compatible' },
              { version: '2.2.0', compatibility: 'metadata-compatible' }
            ]
          } };
        }
        if (action === 'planProjectPackageChanges') {
          if (fixture.rejectPlanRequests) {
            return {
              success: false,
              errorCode: 'package_manifest_change_invalid',
              error: 'Fixture plan captured before execution'
            };
          }
          const initialInstall = !fixture.applied;
          const packageName = data.changes[0] && data.changes[0].name || 'package';
          const oldContent = initialInstall ? fixture.contents.initial : fixture.contents.applied;
          const newContent = initialInstall ? fixture.contents.applied : fixture.contents.failed;
          return { success: true, data: {
            schema: 'project-package-change-plan/v1',
            supported: true,
            requiresConfirmation: true,
            planId: 'plan-' + packageName,
            revision: fixture.applied ? 'environment-2' : 'environment-1',
            changes: data.changes,
            localChanges: [{
              path: data.manifestPath,
              oldExists: true,
              oldSha256: initialInstall ? fixture.hashes.initial : fixture.hashes.applied,
              newContent,
              newSha256: initialInstall ? fixture.hashes.applied : fixture.hashes.failed
            }],
            manifestBindings: [{
              path: data.manifestPath,
              sha256: initialInstall ? fixture.hashes.applied : fixture.hashes.failed
            }],
            warnings: []
          } };
        }
        if (action === 'applyProjectPackageChanges') {
          if (fixture.transportLossOnce) {
            fixture.transportLossOnce = false;
            return { success: false, error: 'Fixture connection lost' };
          }
          if (fixture.unavailableOnce) {
            fixture.unavailableOnce = false;
            return { success: false, status: 409, errorCode: 'package_plan_unavailable', error: 'Fixture durable plan record unavailable' };
          }
          if (fixture.failApply) return { success: false, status: 409, errorCode: 'package_install_failed', error: { code: 'package_install_failed', message: 'Fixture install failed' } };
          fixture.applied = true;
          if (fixture.switchIdentityOnApply) {
            window.BOBO.state.runIdentityEpoch += 1;
            window.BOBO.state.serverSettings = Object.assign({}, window.BOBO.state.serverSettings, { ip: 'other.example' });
            window.BOBO.state.auth = { mode: 'multi', token: 'fixture-bob', user: { id: 'bob', username: 'bob' } };
          }
          return { success: true, data: { applied: true, planId: data.packagePlanId } };
        }
        return { success: false, error: 'unexpected fixture action: ' + action };
      };
    }, {
      workspacePath: workspace,
      hashes: { initial: sha256(initialContent), applied: sha256(appliedContent), failed: sha256(failedContent) },
      contents: { initial: initialContent, applied: appliedContent, failed: failedContent }
    });

    await page.locator('#activity-environment').click();
    await page.locator('#environment-tab-packages').click();
    await expect(page.locator('#package-center-view')).toBeVisible();
    await expect(page.locator('#package-search-input')).toHaveAttribute('placeholder', 'Search exact package name');
    await expect(page.locator('#package-center-state')).toContainText('Fixture policy blocks changes');
    expect(await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'searchPackageCatalog').length)).toBe(0);

    await page.evaluate(async () => {
      window.__packageFixture.unsupported = false;
      await window.BOBO.packageCenter.refresh({ force: true, search: true });
    });
    await expect(page.locator('#package-center-state')).toHaveText('Enter an exact package name to search.');
    await expect(page.locator('#package-context-runtime')).toHaveText('Python 3.11.13');
    await expect(page.locator('#package-context-runtime')).toHaveAttribute('title', 'Dependencies automatically match Python 3.11.13.');
    await expect(page.locator('#package-manifest-select')).toHaveValue('requirements-a.txt');
    await expect(page.locator('#package-manifest-select option')).toHaveCount(2);
    await expect(page.locator('#package-center-review')).toHaveCount(0);
    await expect(page.locator('#package-apply-changes')).toHaveCount(0);

    await page.evaluate(async () => {
      window.__packageFixture.cacheMissingMode = true;
      window.__packageFixture.rejectPlanRequests = true;
      await window.BOBO.packageCenter.refresh({ force: true, search: false });
    });
    await page.locator('#package-search-input').fill('brokenlib');
    const declaredResult = page.locator('#package-results-list .package-row[data-package-name="brokenlib"]');
    await expect(declaredResult).toBeVisible();
    let plansBeforeContractCheck = await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length);
    await declaredResult.locator('.package-install').click();
    await expect.poll(() => page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length)).toBe(plansBeforeContractCheck + 1);
    let capturedPlanChange = await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').at(-1).data.changes[0]);
    expect(capturedPlanChange).toMatchObject({ operation: 'update', name: 'brokenlib', version: '1.0.0', scope: 'runtime' });

    await declaredResult.locator('.package-row-main').click();
    await expect(page.locator('#package-center-detail')).toBeVisible();
    await expect(page.locator('#package-version-select')).toHaveValue('1.0.0');
    plansBeforeContractCheck += 1;
    await page.locator('#package-stage-change').click();
    await expect.poll(() => page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length)).toBe(plansBeforeContractCheck + 1);
    capturedPlanChange = await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').at(-1).data.changes[0]);
    expect(capturedPlanChange).toMatchObject({ operation: 'update', name: 'brokenlib', version: '1.0.0', scope: 'runtime' });

    await page.locator('#package-detail-back').click();
    await page.locator('#package-search-input').fill('freshlib');
    const undeclaredResult = page.locator('#package-results-list .package-row[data-package-name="freshlib"]');
    await expect(undeclaredResult).toBeVisible();
    plansBeforeContractCheck += 1;
    await undeclaredResult.locator('.package-install').click();
    await expect.poll(() => page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length)).toBe(plansBeforeContractCheck + 1);
    capturedPlanChange = await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').at(-1).data.changes[0]);
    expect(capturedPlanChange).toMatchObject({ operation: 'add', name: 'freshlib', version: '2.3.1', scope: 'runtime' });

    await page.evaluate(async () => {
      window.__packageFixture.cacheMissingMode = false;
      window.__packageFixture.rejectPlanRequests = false;
      document.getElementById('package-search-input').value = '';
      await window.BOBO.packageCenter.refresh({ force: true, search: true });
    });
    await expect(page.locator('#package-center-state')).toHaveText('Enter an exact package name to search.');

    await page.locator('#package-mode-installed').click();
    const declaredMissingRow = page.locator('#package-results-list .package-row[data-package-name="brokenlib"]');
    await expect(declaredMissingRow).toHaveCount(0);
    await expect(page.locator('#package-results-list .package-row')).toHaveCount(2);
    await page.locator('#package-mode-discover').click();

    const declaredMissingSuggestion = page.locator('#package-suggestions-list .package-row[data-package-name="brokenlib"]');
    await expect(declaredMissingSuggestion).toBeVisible();
    await expect(declaredMissingSuggestion.locator('.package-row-summary')).toHaveText('Missing from exact inventory');
    await expect(page.locator('#package-suggestions-list .package-row[data-package-name="numpy"]')).toBeVisible();
    await page.locator('#package-suggestions-list .package-row[data-package-name="numpy"] .package-row-action').click();
    await expect(page.locator('#package-search-input')).toHaveValue('numpy');
    await expect(page.locator('#package-center-detail')).toBeVisible();
    await expect(page.locator('#package-context-runtime')).toHaveText('Python 3.11.13');
    await expect(page.locator('#package-version-select')).toHaveValue('2.3.1');
    await expect(page.locator('#package-version-select option[value="2.4.0"]')).toHaveAttribute('disabled', '');
    await expect(page.locator('#package-detail-catalog')).toHaveText('TUNA · pypi.tuna.tsinghua.edu.cn');
    await page.locator('#package-source-select').selectOption('pypi-official');
    await expect(page.locator('#package-center-browser')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const calls = window.__packageFixture.calls.filter(call => call.action === 'searchPackageCatalog');
      return calls.at(-1) && calls.at(-1).data.sourceId;
    })).toBe('pypi-official');
    await page.locator('#package-source-select').selectOption('pypi-tuna');
    await expect.poll(() => page.evaluate(() => {
      const calls = window.__packageFixture.calls.filter(call => call.action === 'searchPackageCatalog');
      return calls.at(-1) && calls.at(-1).data.sourceId;
    })).toBe('pypi-tuna');

    const numpyRow = page.locator('#package-results-list .package-row[data-package-name="numpy"]');
    await expect(numpyRow.locator('.package-install')).toHaveAttribute('aria-label', 'Install numpy');
    const detailsBeforeInstall = await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'getPackageCatalogItem').length);
    const syncsBeforeInstall = await page.evaluate(() => window.__packageFixture.syncCount);
    await numpyRow.locator('.package-install').evaluate(button => { button.click(); button.click(); });
    await expect(page.locator('#package-operation-status')).toContainText('Fixture local apply failed');
    expect(await page.evaluate(() => ({
      rollbackCount: window.__packageFixture.rollbackCount,
      applyCount: window.__packageFixture.calls.filter(call => call.action === 'applyProjectPackageChanges').length
    }))).toEqual({ rollbackCount: 0, applyCount: 0 });
    await expect(page.locator('#package-center-view')).toHaveAttribute('aria-busy', 'false');
    await numpyRow.locator('.package-install').click();
    await expect(page.locator('#package-operation-status')).toContainText('still uncertain');
    expect(await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'getPackageCatalogItem').length)).toBe(detailsBeforeInstall + 2);
    const firstPlan = await page.evaluate(() => window.__packageFixture.calls.find(call =>
      call.action === 'planProjectPackageChanges' && call.data.changes[0] && call.data.changes[0].name === 'numpy'
    ));
    expect(firstPlan.data.manifestPath).toBe('requirements-a.txt');
    expect(firstPlan.data.changes).toHaveLength(1);
    expect(firstPlan.data.changes[0]).toMatchObject({ operation: 'add', name: 'numpy', version: '2.3.1', scope: 'runtime' });
    expect(await page.evaluate(() => window.__packageFixture.confirmation)).toBeNull();
    expect(await page.evaluate(() => ({
      rollbackCount: window.__packageFixture.rollbackCount,
      recovery: window.BOBO.packageCenter.getState().recovery
    }))).toEqual({ rollbackCount: 0, recovery: 'apply' });

    await page.locator('#package-operation-retry').click();
    await expect(page.locator('#package-operation-status')).toContainText('local finalization is pending');
    await expect.poll(() => fs.readFileSync(firstManifest, 'utf8')).toBe(appliedContent);
    expect(await page.evaluate(() => window.BOBO.packageCenter.getState().recovery)).toBe('commit');

    await page.locator('#package-operation-retry').click();
    await expect(page.locator('#package-operation-status')).toContainText('analysis service still needs a refresh');
    expect(await page.evaluate(() => window.BOBO.packageCenter.getState().recovery)).toBe('refresh');
    await page.locator('#package-mode-installed').click();
    await expect(page.locator('#package-results-list .package-remove').first()).toBeEnabled();
    await page.evaluate(() => {
      window.__packageFixture.failRefresh = false;
      window.__packageFixture.lspRefreshResult = true;
      window.__packageFixture.contextCallsBeforeVerifiedRefresh = window.__packageFixture.calls.filter(call => call.action === 'getPackageCenterContext').length;
    });
    await page.locator('#package-operation-retry').click();
    await expect(page.locator('#package-operation-status')).toContainText('Language service refreshed');
    const refreshedNumpy = page.locator('#package-results-list .package-row[data-package-name="numpy"]');
    await expect(refreshedNumpy).toBeVisible();
    await expect(refreshedNumpy.locator('.package-remove')).toBeEnabled();
    await page.locator('#package-mode-discover').click();
    expect(await page.evaluate(() => ({
      syncCount: window.__packageFixture.syncCount,
      applyCount: window.__packageFixture.calls.filter(call => call.action === 'applyProjectPackageChanges').length,
      lspRefreshed: window.__packageFixture.lspRefreshed,
      environmentRefreshes: window.__packageFixture.environmentRefreshes,
      cacheInvalidations: window.__packageFixture.cacheInvalidations,
      verifiedContextRefreshes: window.__packageFixture.calls.filter(call => call.action === 'getPackageCenterContext').length - window.__packageFixture.contextCallsBeforeVerifiedRefresh,
      confirmation: window.__packageFixture.confirmation,
      recovery: window.BOBO.packageCenter.getState().recovery
    }))).toEqual({
      syncCount: syncsBeforeInstall + 3,
      applyCount: 3,
      lspRefreshed: true,
      environmentRefreshes: [{ reason: 'package-change', delay: 0 }],
      cacheInvalidations: [{ reason: 'package-recovery-applied', revision: '' }],
      verifiedContextRefreshes: 1,
      confirmation: null,
      recovery: ''
    });
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'package-center-one-click-wide.png'), fullPage: false });

    await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('en');
      window.__packageFixture.failSearchOnce = true;
    });
    await page.locator('#package-search-input').fill('fixture-error-en');
    await expect(page.locator('#package-center-state')).toContainText('Fixture install failed');
    const japaneseSearchFallback = await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('ja');
      window.__packageFixture.failSearchOnce = true;
      return window.BOBO.i18n.t('The library request failed.');
    });
    await page.locator('#package-search-input').fill('fixture-error-ja');
    await expect(page.locator('#package-center-state')).toContainText(japaneseSearchFallback);
    await expect(page.locator('#package-center-state')).not.toContainText('Fixture install failed');
    await page.evaluate(async () => window.BOBO.i18n.setLocale('en'));

    await page.locator('#package-search-input').fill('pandas');
    await expect(page.locator('#package-results-list .package-row[data-package-name="pandas"]')).toBeVisible();
    await page.locator('#package-results-list .package-row[data-package-name="pandas"] .package-row-main').click();
    await expect(page.locator('#package-center-detail')).toBeVisible();
    await page.locator('#package-version-select').selectOption('2.2.0');
    await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('en');
      window.__packageFixture.failApply = true;
      window.__packageFixture.failSyncAt = window.__packageFixture.syncCount + 3;
      window.__packageFixture.refreshCountsBeforeFailedApply = {
        lsp: window.__packageFixture.lspRefreshCount,
        environment: window.__packageFixture.environmentRefreshes.length,
        cache: window.__packageFixture.cacheInvalidations.length
      };
    });
    await page.locator('#package-stage-change').click();
    await expect(page.locator('#package-operation-status')).toContainText('Library update failed.');
    await expect(page.locator('#package-operation-status')).toContainText('restored dependency file could not be synchronized');
    await expect.poll(() => fs.readFileSync(firstManifest, 'utf8')).toBe(appliedContent);
    expect(await page.evaluate(() => ({
      rollbackCount: window.__packageFixture.rollbackCount,
      recovery: window.BOBO.packageCenter.getState().recovery,
      plannedVersion: window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').at(-1).data.changes[0].version,
      refreshCounts: {
        lsp: window.__packageFixture.lspRefreshCount,
        environment: window.__packageFixture.environmentRefreshes.length,
        cache: window.__packageFixture.cacheInvalidations.length
      },
      installedPandas: window.BOBO.packageCenter.getState().context.installed.some(item => item.name === 'pandas')
    }))).toEqual({
      rollbackCount: 1,
      recovery: 'sync',
      plannedVersion: '2.2.0',
      refreshCounts: await page.evaluate(() => window.__packageFixture.refreshCountsBeforeFailedApply),
      installedPandas: false
    });

    const resizer = page.locator('#sidebar-resizer');
    await resizer.focus();
    await resizer.press('Home');
    await expect(resizer).toHaveAttribute('aria-valuenow', '180');
    await expect.poll(async () => Math.round(await page.locator('#package-center-view').evaluate(element => element.getBoundingClientRect().width))).toBe(179);
    const fit = await page.locator('#package-center-view').evaluate(element => ({
      width: element.getBoundingClientRect().width,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1
    }));
    expect(Math.round(fit.width)).toBe(179);
    expect(fit.noHorizontalOverflow).toBe(true);
    const errorAccess = await page.locator('#package-operation-status').evaluate(element => {
      const label = element.querySelector('#package-operation-label');
      const style = getComputedStyle(label);
      return {
        text: label.textContent,
        statusTitle: element.title,
        labelTitle: label.title,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1
      };
    });
    expect(errorAccess.statusTitle).toBe(errorAccess.text);
    expect(errorAccess.labelTitle).toBe(errorAccess.text);
    expect(errorAccess.whiteSpace).toBe('normal');
    expect(errorAccess.textOverflow).toBe('clip');
    expect(errorAccess.noHorizontalOverflow).toBe(true);
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'package-center-one-click-compact.png'), fullPage: false });

    await page.evaluate(() => {
      window.BOBO.state.runIdentityEpoch += 1;
      window.BOBO.state.auth.token = 'fixture-token-2';
    });
    await page.locator('#package-operation-retry').click();
    await expect(page.locator('#package-operation-status')).toContainText('Dependency file recovery completed');
    expect(await page.evaluate(() => window.BOBO.packageCenter.getState().recovery)).toBe('');
    await page.evaluate(async () => {
      window.__packageFixture.failApply = false;
      window.__packageFixture.confirmResult = false;
      window.__packageFixture.confirmation = null;
      await window.BOBO.packageCenter.refresh({ force: true, search: false });
    });
    await page.locator('#package-mode-installed').click();
    const installedNumpy = page.locator('#package-results-list .package-row[data-package-name="numpy"]');
    await expect(installedNumpy).toBeVisible();
    const plansBeforeRemove = await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length);
    await installedNumpy.locator('.package-remove').click();
    expect(await page.evaluate(() => window.__packageFixture.confirmation && window.__packageFixture.confirmation.title)).toBe('Remove numpy?');
    expect(await page.evaluate(() => window.__packageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length)).toBe(plansBeforeRemove);

    await page.locator('#package-mode-discover').focus();
    await page.locator('#package-mode-discover').press('ArrowRight');
    await expect(page.locator('#package-mode-installed')).toBeFocused();
    await page.locator('#package-mode-installed').press('ArrowLeft');
    await expect(page.locator('#package-mode-discover')).toBeFocused();

    await page.locator('#environment-tab-packages').focus();
    await page.locator('#environment-tab-packages').press('ArrowLeft');
    await expect(page.locator('#environment-tab-overview')).toBeFocused();
    await page.locator('#environment-tab-overview').press('ArrowRight');
    await expect(page.locator('#environment-tab-packages')).toBeFocused();

    for (const locale of ['zh-CN', 'ja', 'en']) {
      const values = await page.evaluate(async nextLocale => {
        await window.BOBO.i18n.setLocale(nextLocale);
        return {
          expected: window.BOBO.i18n.t('Dependencies'),
          actual: document.getElementById('environment-tab-packages').textContent
        };
      }, locale);
      expect(values.actual).toBe(values.expected);
    }
    expect(errors).toEqual([]);
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('JavaScript editor normalizes npm package requests to the Node ecosystem', async () => {
  test.setTimeout(45000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-node-language-alias-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'npm-project');
  const sourceFile = path.join(workspace, 'index.js');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"npm-project","packageManager":"npm@10.9.2","dependencies":{}}\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'package-lock.json'), '{"name":"npm-project","lockfileVersion":3,"packages":{}}\n', 'utf8');
  fs.writeFileSync(sourceFile, "const lodash = require('lodash');\n", 'utf8');

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
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.waitForFunction(() => document.documentElement && document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    const editorLanguage = await page.evaluate(async ({ workspacePath, filePath }) => {
      const selected = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(selected.rootPath, selected.tree);
      await window.BOBO.workspace.openFile(filePath, 'index.js');
      window.BOBO.state.serverSettings.ip = 'fixture.example';
      window.BOBO.state.auth = { mode: 'multi', token: 'npm-fixture-token', user: { id: 'npm-user', username: 'npm-user' } };
      window.BOBO.state.selectedRuntime = 'node:22';
      window.__npmLanguageAliasFixture = { calls: [], contextMismatch: false };
      window.BOBO.sendToServer = async (action, data) => {
        const fixture = window.__npmLanguageAliasFixture;
        fixture.calls.push({ action, data });
        if (action === 'getProjectEnvironment') return { success: false, error: 'not part of npm language alias fixture' };
        if (action === 'getPackageCenterContext') return { success: true, data: {
          schema: 'project-package-center/v1',
          revision: 'npm-environment-1',
          workspace: {
            kind: 'personal',
            id: 'npm-user\\0' + (fixture.contextMismatch ? 'stale-folder' : data.folderKey),
            key: fixture.contextMismatch ? 'stale-folder' : data.folderKey,
            name: 'npm-project'
          },
          language: { id: 'node', displayName: 'Node.js' },
          runtime: { id: 'node:22', displayName: 'Node.js 22', version: '22', interpreterVersion: '22.14.0' },
          manager: {
            id: 'npm', name: 'npm', manifestPath: 'package.json', lockfilePath: 'package-lock.json',
            lockfilePresent: true, detectedBy: 'packageManager', scopes: ['runtime', 'dev', 'optional']
          },
          capabilities: { browse: true, inspect: true, mutate: true, exactInventory: true, scopes: true },
          sources: [{ id: 'npm-official', name: 'npm', kind: 'official', ecosystem: 'node' }],
          defaultSource: 'npm-official',
          searchMode: 'catalog',
          defaultManifestPath: 'package.json',
          manifests: [
            { path: 'package.json', manager: 'npm', kind: 'package', language: 'node', editable: true },
            { path: 'package-lock.json', manager: 'npm', kind: 'npm-lock', language: 'node', lockfile: true }
          ],
          packages: { declared: [], installed: [], missing: [], unknown: [] },
          inventory: { exact: true, cacheId: 'npm-cache', generation: 'npm-generation', dependencyDigest: 'npm-digest' },
          canPlanChanges: { supported: true }
        } };
        return { success: false, error: 'unexpected fixture action: ' + action };
      };
      return window.BOBO.state.editor.getModel().getLanguageId();
    }, { workspacePath: workspace, filePath: sourceFile });

    expect(editorLanguage).toBe('javascript');
    await page.locator('#activity-environment').click();
    await page.locator('#environment-tab-packages').click();
    await expect(page.locator('#package-center-view')).toBeVisible();
    await expect(page.locator('#package-center-state')).not.toContainText('The project changed before the library plan could be created.');
    await expect(page.locator('#package-manager-label')).toHaveText('npm');
    await expect(page.locator('#package-search-input')).toBeEnabled();
    await expect(page.locator('#package-search-input')).toHaveAttribute('placeholder', 'Search npm packages');
    const requestLanguage = await page.evaluate(() => {
      const call = window.__npmLanguageAliasFixture.calls.find(item => item.action === 'getPackageCenterContext');
      return call && call.data.language;
    });
    expect(requestLanguage).toBe('node');

    const contextCallsBeforeMismatch = await page.evaluate(() => (
      window.__npmLanguageAliasFixture.calls.filter(item => item.action === 'getPackageCenterContext').length
    ));
    await page.evaluate(async () => {
      window.__npmLanguageAliasFixture.contextMismatch = true;
      await window.BOBO.packageCenter.refresh({ force: true, search: false });
    });
    await expect.poll(() => page.evaluate(() => (
      window.__npmLanguageAliasFixture.calls.filter(item => item.action === 'getPackageCenterContext').length
    ))).toBe(contextCallsBeforeMismatch + 2);
    await expect(page.locator('#package-center-state')).toHaveText('The project context could not be verified while dependencies were loading. Refresh and try again.');
    await expect(page.locator('#package-search-input')).toBeDisabled();

    await page.evaluate(() => { window.__npmLanguageAliasFixture.contextMismatch = false; });
    await page.locator('#package-refresh').click();
    await expect.poll(() => page.evaluate(() => (
      window.__npmLanguageAliasFixture.calls.filter(item => item.action === 'getPackageCenterContext').length
    ))).toBe(contextCallsBeforeMismatch + 3);
    await expect(page.locator('#package-center-state')).not.toContainText('The project context could not be verified while dependencies were loading.');
    await expect(page.locator('#package-manager-label')).toHaveText('npm');
    await expect(page.locator('#package-search-input')).toBeEnabled();
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('Node dependency center adapts npm metadata and pnpm project workflow', async () => {
  test.setTimeout(45000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-node-dependency-center-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'node-project');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"node-project","packageManager":"pnpm@10.0.0","dependencies":{"react":"19.1.0"}}\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'index.js'), "import React from 'react';\n", 'utf8');

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
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.waitForFunction(() => document.documentElement && document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    await page.evaluate(async workspacePath => {
      const selected = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(selected.rootPath, selected.tree);
      window.BOBO.state.serverSettings.ip = 'fixture.example';
      window.BOBO.state.auth = { mode: 'multi', token: 'node-fixture-token', user: { id: 'node-user', username: 'node-user' } };
      window.BOBO.state.selectedRuntime = 'node:22';
      window.__nodePackageFixture = { calls: [], confirmations: 0, syncCount: 0, events: [] };
      window.BOBO.confirm = async () => {
        window.__nodePackageFixture.confirmations += 1;
        return true;
      };
      window.BOBO.runner.manualSyncWithServer = async () => {
        window.__nodePackageFixture.syncCount += 1;
        window.__nodePackageFixture.events.push('sync');
        return true;
      };
      window.BOBO.sendToServer = async (action, data) => {
        window.__nodePackageFixture.calls.push({ action, data });
        window.__nodePackageFixture.events.push(action);
        if (action === 'getPackageCenterContext') return { success: true, data: {
          schema: 'project-package-center/v1', revision: 'node-environment-1',
          workspace: { kind: 'personal', id: 'node-user\\0' + data.folderKey, key: data.folderKey, name: 'node-project' },
          language: { id: 'node', displayName: 'Node.js' },
          runtime: { id: 'node:22', displayName: 'Node.js 22', version: '22', interpreterVersion: '22.14.0' },
          manager: {
            id: 'pnpm', name: 'pnpm', manifestPath: 'package.json', lockfilePath: 'pnpm-lock.yaml',
            lockfilePresent: true, detectedBy: 'packageManager', scopes: ['runtime', 'dev', 'optional']
          },
          capabilities: {
            browse: true, inspect: true, mutate: true, exactInventory: true,
            scopes: true, prereleases: true, transitivePackages: true
          },
          sources: [
            { id: 'npm-official', name: 'npm', kind: 'official', ecosystem: 'node' },
            { id: 'npm-npmmirror', name: 'npmmirror', kind: 'mirror', ecosystem: 'node' }
          ],
          defaultSource: 'npm-official', searchMode: 'catalog', defaultManifestPath: 'package.json',
          manifests: [
            { path: 'package.json', manager: 'pnpm', kind: 'package', language: 'node', editable: true },
            { path: 'pnpm-lock.yaml', manager: 'pnpm', kind: 'pnpm-lock', language: 'node', lockfile: true }
          ],
          packages: {
            declared: [{ name: 'react', constraint: '19.1.0', scope: 'runtime', source: 'package.json' }],
            installed: [
              { name: 'react', version: '19.1.0', relationship: 'direct', trust: 'exact' },
              { name: 'scheduler', version: '0.26.0', relationship: 'transitive', trust: 'exact' }
            ],
            missing: [], unknown: []
          },
          inventory: { exact: true, cacheId: 'node-cache', generation: 'node-generation', dependencyDigest: 'node-digest' },
          canPlanChanges: { supported: true }
        } };
        if (action === 'searchPackageCatalog') return { success: true, data: { searchMode: 'catalog', items: [{
          name: 'old-package', recommendedVersion: '2.1.0', latestVersion: '2.1.0',
          description: 'Deprecated fixture package', compatibility: 'compatible'
        }] } };
        if (action === 'getPackageCatalogItem') return { success: true, data: {
          name: 'old-package', recommendedVersion: '2.1.0', latestVersion: '2.1.0',
          description: 'Deprecated fixture package', compatibility: 'compatible', requiresLanguage: '>=20',
          deprecated: true, deprecationMessage: 'Use modern-package instead.',
          distTags: { latest: '2.1.0', next: '3.0.0-beta.1' },
          versions: [
            { version: '3.0.0-beta.1', compatibility: 'compatible' },
            { version: '2.1.0', compatibility: 'compatible', deprecated: true, deprecationMessage: 'Use modern-package instead.' }
          ]
        } };
        if (action === 'planProjectPackageChanges') return {
          success: false, errorCode: 'package_manifest_change_invalid', error: 'Fixture stopped after plan capture'
        };
        return { success: false, error: 'unexpected fixture action: ' + action };
      };
    }, workspace);

    await page.locator('#activity-environment').click();
    await page.locator('#environment-tab-packages').click();
    await expect(page.locator('#package-center-view')).toBeVisible();
    await expect(page.locator('#package-manager-label')).toHaveText('pnpm');
    await expect(page.locator('#package-lock-label')).toHaveText('Lock ready');
    await expect(page.locator('#package-lock-status')).toHaveAttribute('title', 'Lock file: pnpm-lock.yaml');
    await expect(page.locator('#package-manifest-select')).toHaveValue('package.json');
    await expect(page.locator('#package-search-input')).toHaveAttribute('placeholder', 'Search npm packages');
    await expect(page.locator('#package-center-state')).toHaveText('Search packages by name or keyword.');
    expect(await page.evaluate(() => window.__nodePackageFixture.calls.filter(call => call.action === 'searchPackageCatalog').length)).toBe(0);

    await page.locator('#package-mode-installed').click();
    await expect(page.locator('.package-installed-group')).toHaveCount(2);
    await expect(page.locator('.package-installed-group').nth(0)).toContainText('Direct dependencies');
    await expect(page.locator('.package-installed-group').nth(1)).toContainText('Transitive dependencies');
    const installedReact = page.locator('#package-results-list .package-row[data-package-name="react"]');
    const installedScheduler = page.locator('#package-results-list .package-row[data-package-name="scheduler"]');
    await expect(installedReact.locator('.package-remove')).toBeEnabled();
    await expect(installedScheduler.locator('.package-remove')).toHaveCount(0);
    await installedReact.locator('.package-remove').click();
    await expect.poll(() => page.evaluate(() => window.__nodePackageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length)).toBe(1);
    expect(await page.evaluate(() => window.__nodePackageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').at(-1).data.changes[0])).toEqual({
      operation: 'remove', name: 'react', version: '', scope: 'runtime'
    });

    await page.locator('#package-mode-discover').click();
    await page.locator('#package-search-input').fill('old-package');
    const result = page.locator('#package-results-list .package-row[data-package-name="old-package"]');
    await expect(result).toBeVisible();
    await result.locator('.package-row-main').click();
    await expect(page.locator('#package-center-detail')).toBeVisible();
    await expect(page.locator('#package-detail-engine')).toHaveText('>=20');
    await expect(page.locator('#package-detail-tags')).toContainText('latest 2.1.0');
    await expect(page.locator('#package-detail-warning')).toContainText('Use modern-package instead.');
    await expect(page.locator('#package-scope-field')).toBeVisible();
    await expect(page.locator('#package-scope-select option')).toHaveText([
      'Production dependency', 'Development dependency', 'Optional dependency'
    ]);
    expect(await page.locator('#package-center-view').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'project-dependency-center-node.png'), fullPage: false });
    await page.locator('#package-scope-select').selectOption('dev');
    const plansBeforeAdd = await page.evaluate(() => window.__nodePackageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length);
    await page.locator('#package-stage-change').click();
    await expect.poll(() => page.evaluate(() => window.__nodePackageFixture.calls.filter(call => call.action === 'planProjectPackageChanges').length)).toBe(plansBeforeAdd + 1);
    const captured = await page.evaluate(() => {
      const fixture = window.__nodePackageFixture;
      const plan = fixture.calls.filter(call => call.action === 'planProjectPackageChanges').at(-1);
      return {
        change: plan.data.changes[0], manifestPath: plan.data.manifestPath,
        confirmations: fixture.confirmations, syncCount: fixture.syncCount,
        planningOrder: fixture.events.slice(-3)
      };
    });
    expect(captured).toEqual({
      change: { operation: 'add', name: 'old-package', version: '2.1.0', scope: 'dev' },
      manifestPath: 'package.json',
      confirmations: 1,
      syncCount: 2,
      planningOrder: ['sync', 'getPackageCenterContext', 'planProjectPackageChanges']
    });
    expect(errors).toEqual([]);
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
