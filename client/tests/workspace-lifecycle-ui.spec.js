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

function uiEvidencePath(name) {
  const directory = process.env.BOBO_UI_EVIDENCE_DIR || os.tmpdir();
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

async function dragFileTab(page, sourceName, targetName, position, indicatorScreenshot) {
  const titles = page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title');
  const source = titles.filter({ hasText: sourceName }).first();
  const target = titles.filter({ hasText: targetName }).first().locator('..');
  const sourceBounds = await source.boundingBox();
  const targetBounds = await target.boundingBox();
  if (!sourceBounds || !targetBounds) throw new Error('Tab drag fixture is not visible');

  const sourceX = sourceBounds.x + sourceBounds.width / 2;
  const sourceY = sourceBounds.y + sourceBounds.height / 2;
  const approachX = targetBounds.x + (position === 'after' ? targetBounds.width - 4 : 4);
  const approachY = targetBounds.y + targetBounds.height + 12;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX + 8, sourceY, { steps: 2 });
  await page.mouse.move(sourceX + 8, approachY, { steps: 4 });
  await page.mouse.move(approachX, approachY, { steps: 10 });
  await page.mouse.move(approachX, targetBounds.y + targetBounds.height / 2, { steps: 4 });
  await page.waitForTimeout(50);
  await expect(target).toHaveClass(position === 'after' ? /drop-after/ : /drop-before/);
  if (indicatorScreenshot) await page.screenshot({ path: indicatorScreenshot, fullPage: false });
  await page.mouse.up();
}

async function openAndEdit(page, workspaceDir, filePath, value) {
  await page.evaluate(async ({ workspaceDir, filePath, fileName, value }) => {
    const opened = await window.api.pickWorkspace(workspaceDir);
    await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
    await window.BOBO.workspace.openFile(filePath, fileName);
    window.BOBO.state.editor.getModel().setValue(value);
  }, { workspaceDir, filePath, fileName: path.basename(filePath), value });
  await expect.poll(() => page.evaluate(() => window.BOBO.state.tabs[0] && window.BOBO.state.tabs[0].dirty)).toBe(true);
}

test('workspace switch supports cancel and save-all without losing edits', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-life-'));
  const firstDir = path.join(sandbox, 'first');
  const secondDir = path.join(sandbox, 'second');
  const firstFile = path.join(firstDir, 'main.txt');
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(firstFile, 'original\n', 'utf8');
  fs.writeFileSync(path.join(secondDir, 'other.txt'), 'other\n', 'utf8');
  let app;
  let stage = 'launch';
  try {
    app = await launchFixture(sandbox);
    const page = await app.firstWindow();
    stage = 'ready';
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true', null, { timeout: 20000 });
    stage = 'edit first';
    await openAndEdit(page, firstDir, firstFile, 'edited once\n');

    stage = 'stub choices';
    await app.evaluate(({ dialog }) => {
      globalThis.__workspaceLeaveResponses = [2, 0];
      globalThis.__originalWorkspaceMessageBox = dialog.showMessageBox;
      dialog.showMessageBox = async () => ({ response: globalThis.__workspaceLeaveResponses.shift() });
    });

    stage = 'cancel switch';
    const cancelled = await page.evaluate(second => window.api.pickWorkspace(second), secondDir);
    expect(cancelled).toBeNull();
    expect(await page.evaluate(() => window.BOBO.state.workspaceRoot)).toBe(firstDir);
    expect(await page.evaluate(() => window.BOBO.state.tabs[0].dirty)).toBe(true);
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('original\n');

    stage = 'save switch';
    const switched = await page.evaluate(async second => {
      const result = await window.api.pickWorkspace(second);
      if (result) await window.BOBO.workspace.applyWorkspace(result.rootPath, result.tree, result.workspaceIdentity, result.leaveToken);
      return result && result.rootPath;
    }, secondDir);
    expect(switched).toBe(secondDir);
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('edited once\n');
    expect(await page.evaluate(() => window.BOBO.state.workspaceRoot)).toBe(secondDir);

    stage = 'artifact run identity';
    const artifactResult = await page.evaluate(async () => {
      const identity = await window.api.getWorkspaceIdentity();
      const base = {
        workspaceRoot: identity.rootPath,
        workspaceIdentity: identity.workspaceIdentity
      };
      await window.api.setArtifactRunContext(Object.assign({}, base, { runNonce: 1001 }));
      await window.api.setArtifactRunContext(Object.assign({}, base, { runNonce: 1002 }));
      let staleRejected = false;
      try {
        await window.api.saveArtifact(Object.assign({}, base, {
          runNonce: 1001,
          relativePath: 'stale-artifact.txt',
          content: 'stale',
          binary: false
        }));
      } catch (error) {
        staleRejected = /Stale artifact run/.test(error.message);
      }
      const saved = await window.api.saveArtifact(Object.assign({}, base, {
        runNonce: 1002,
        relativePath: 'current-artifact.txt',
        content: 'current',
        binary: false
      }));
      return { staleRejected, saved: saved && saved.success };
    });
    expect(artifactResult).toEqual({ staleRejected: true, saved: true });
    expect(fs.existsSync(path.join(secondDir, 'stale-artifact.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(secondDir, 'current-artifact.txt'), 'utf8')).toBe('current');
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
    console.log('workspace lifecycle final stage:', stage);
  }
});

test('production leave token consumes discard approval without prompting twice', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-token-'));
  const firstDir = path.join(sandbox, 'first');
  const secondDir = path.join(sandbox, 'second');
  const firstFile = path.join(firstDir, 'main.txt');
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(firstFile, 'original\n', 'utf8');
  fs.writeFileSync(path.join(secondDir, 'other.txt'), 'other\n', 'utf8');
  let app;
  try {
    app = await launchFixture(sandbox);
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true', null, { timeout: 20000 });
    await openAndEdit(page, firstDir, firstFile, 'discard me\n');

    await app.evaluate(({ dialog }) => {
      globalThis.__workspaceLeavePromptCount = 0;
      dialog.showMessageBox = async () => {
        globalThis.__workspaceLeavePromptCount += 1;
        return { response: 1 };
      };
    });

    const result = await page.evaluate(async second => {
      const opened = await window.api.pickWorkspace(second);
      const applied = opened && await window.BOBO.workspace.applyWorkspace(
        opened.rootPath,
        opened.tree,
        opened.workspaceIdentity,
        opened.leaveToken
      );
      return {
        applied,
        leaveToken: opened && opened.leaveToken,
        rootPath: window.BOBO.state.workspaceRoot,
        tabCount: window.BOBO.state.tabs.length,
        transitionLocked: window.BOBO.state.workspaceTransitionLocked
      };
    }, secondDir);

    expect(result.applied).toBe(true);
    expect(result.leaveToken).toMatch(/^workspace-leave-/);
    expect(result.rootPath).toBe(secondDir);
    expect(result.tabCount).toBe(0);
    expect(result.transitionLocked).toBe(false);
    expect(await app.evaluate(() => globalThis.__workspaceLeavePromptCount)).toBe(1);
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('original\n');
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
  }
});

test('stale workspace payloads do not dispose or replace current tabs', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-stale-'));
  const firstDir = path.join(sandbox, 'first');
  const staleDir = path.join(sandbox, 'stale');
  const firstFile = path.join(firstDir, 'main.txt');
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(firstFile, 'original\n', 'utf8');
  let app;
  try {
    app = await launchFixture(sandbox);
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true', null, { timeout: 20000 });
    await openAndEdit(page, firstDir, firstFile, 'keep this dirty edit\n');

    const result = await page.evaluate(async staleRoot => {
      const state = window.BOBO.state;
      const identity = await window.api.getWorkspaceIdentity();
      const model = state.tabs[0].model;
      const staleTree = { name: 'stale', path: staleRoot, type: 'folder', children: [] };
      const staleRootApplied = await window.BOBO.workspace.applyWorkspace(
        staleRoot,
        staleTree,
        identity.workspaceIdentity,
        null
      );
      const staleIdentityApplied = await window.BOBO.workspace.applyWorkspace(
        identity.rootPath,
        state.workspaceTree,
        identity.workspaceIdentity - 1,
        null
      );
      return {
        staleRootApplied,
        staleIdentityApplied,
        rootPath: state.workspaceRoot,
        tabCount: state.tabs.length,
        sameModel: state.tabs[0] && state.tabs[0].model === model,
        disposed: typeof model.isDisposed === 'function' ? model.isDisposed() : false,
        value: model.getValue(),
        dirty: state.tabs[0] && state.tabs[0].dirty
      };
    }, staleDir);

    expect(result).toEqual({
      staleRootApplied: false,
      staleIdentityApplied: false,
      rootPath: firstDir,
      tabCount: 1,
      sameModel: true,
      disposed: false,
      value: 'keep this dirty edit\n',
      dirty: true
    });
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
  }
});

test('model version change after leave approval rejects switch without losing dirty content', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-version-'));
  const firstDir = path.join(sandbox, 'first');
  const secondDir = path.join(sandbox, 'second');
  const firstFile = path.join(firstDir, 'main.txt');
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(firstFile, 'original\n', 'utf8');
  fs.writeFileSync(path.join(secondDir, 'other.txt'), 'other\n', 'utf8');
  let app;
  try {
    app = await launchFixture(sandbox);
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true', null, { timeout: 20000 });
    await openAndEdit(page, firstDir, firstFile, 'dirty before approval\n');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });

    const result = await page.evaluate(async second => {
      const state = window.BOBO.state;
      const model = state.tabs[0].model;
      const opened = await window.api.pickWorkspace(second);
      const lockedAfterApproval = state.workspaceTransitionLocked;
      const approvedVersion = model.getVersionId();
      model.setValue('changed after approval\n');
      const changedVersion = model.getVersionId();
      const applied = await window.BOBO.workspace.applyWorkspace(
        opened.rootPath,
        opened.tree,
        opened.workspaceIdentity,
        opened.leaveToken
      );
      const mainIdentity = await window.api.getWorkspaceIdentity();
      return {
        applied,
        lockedAfterApproval,
        versionChanged: changedVersion !== approvedVersion,
        rendererRoot: state.workspaceRoot,
        mainRoot: mainIdentity.rootPath,
        identityMatches: state.workspaceIdentity === mainIdentity.workspaceIdentity,
        tabCount: state.tabs.length,
        sameModel: state.tabs[0] && state.tabs[0].model === model,
        disposed: typeof model.isDisposed === 'function' ? model.isDisposed() : false,
        value: model.getValue(),
        dirty: state.tabs[0] && state.tabs[0].dirty,
        transitionLocked: state.workspaceTransitionLocked
      };
    }, secondDir);

    expect(result).toEqual({
      applied: false,
      lockedAfterApproval: true,
      versionChanged: true,
      rendererRoot: firstDir,
      mainRoot: firstDir,
      identityMatches: true,
      tabCount: 1,
      sameModel: true,
      disposed: false,
      value: 'changed after approval\n',
      dirty: true,
      transitionLocked: false
    });
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('original\n');
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
  }
});

test('window close saves a dirty file before exiting', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-window-close-'));
  const workspaceDir = path.join(sandbox, 'workspace');
  const filePath = path.join(workspaceDir, 'close.txt');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(filePath, 'before\n', 'utf8');
  let app;
  let stage = 'launch';
  try {
    app = await launchFixture(sandbox);
    const page = await app.firstWindow();
    stage = 'ready';
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true', null, { timeout: 20000 });
    stage = 'edit';
    await openAndEdit(page, workspaceDir, filePath, 'saved on close\n');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    stage = 'close';
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => fs.readFileSync(filePath, 'utf8'), { timeout: 10000 }).toBe('saved on close\n');
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
    console.log('window close final stage:', stage);
  }
});

test('file tabs reorder by drag position without changing active or dirty editor state', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-tab-order-'));
  const workspaceDir = path.join(sandbox, 'workspace');
  const files = ['alpha.js', 'beta.js', 'gamma.js'].map(name => ({ name, filePath: path.join(workspaceDir, name) }));
  fs.mkdirSync(workspaceDir, { recursive: true });
  files.forEach((file, index) => fs.writeFileSync(file.filePath, 'fixture ' + index + '\n', 'utf8'));
  const errors = [];
  let app;
  try {
    app = await launchFixture(sandbox);
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await page.setViewportSize({ width: 1200, height: 800 });
    expect(page.url()).toMatch(/^file:.*\/index\.html$/i);
    await expect(page).toHaveTitle('BOBOCLOUD Editor');
    await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay, nextjs-portal')).toHaveCount(0);

    await page.evaluate(async ({ workspaceDir: root, files: fixtureFiles }) => {
      const opened = await window.api.pickWorkspace(root);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      for (const file of fixtureFiles) await window.BOBO.workspace.openFile(file.filePath, file.name);
      const beta = window.BOBO.state.tabs.find(tab => tab.name === 'beta.js');
      beta.model.setValue('unsaved beta\n');
      window.BOBO.workspace.activateTab(fixtureFiles[2].filePath);
      window.__tabOrderIdentity = new Map(window.BOBO.state.tabs.map(tab => [tab.path, tab]));
    }, { workspaceDir, files });
    await expect.poll(() => page.evaluate(() => window.BOBO.state.tabs.find(tab => tab.name === 'beta.js').dirty)).toBe(true);
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title')).toHaveText(['alpha.js', 'beta.js *', 'gamma.js']);
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title').first()).toHaveAttribute('draggable', 'true');
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .close').first()).toHaveAttribute('draggable', 'false');

    await dragFileTab(page, 'alpha.js', 'gamma.js', 'after', uiEvidencePath('tab-drag-drop-indicator.png'));
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title')).toHaveText(['beta.js *', 'gamma.js', 'alpha.js']);
    const firstMove = await page.evaluate(() => ({
      stateOrder: window.BOBO.state.tabs.map(tab => tab.name),
      activeName: window.BOBO.state.tabs.find(tab => tab.path === window.BOBO.state.activeTabPath).name,
      dirtyName: window.BOBO.state.tabs.find(tab => tab.dirty).name,
      dirtyValue: window.BOBO.state.tabs.find(tab => tab.dirty).model.getValue(),
      identitiesPreserved: window.BOBO.state.tabs.every(tab => window.__tabOrderIdentity.get(tab.path) === tab),
      residualDragState: document.querySelectorAll('#tabbar .dragging, #tabbar .drop-before, #tabbar .drop-after').length
    }));
    expect(firstMove).toEqual({
      stateOrder: ['beta.js', 'gamma.js', 'alpha.js'],
      activeName: 'gamma.js',
      dirtyName: 'beta.js',
      dirtyValue: 'unsaved beta\n',
      identitiesPreserved: true,
      residualDragState: 0
    });
    await page.screenshot({ path: uiEvidencePath('tab-order-after.png'), fullPage: false });

    await dragFileTab(page, 'alpha.js', 'beta.js', 'before');
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title')).toHaveText(['alpha.js', 'beta.js *', 'gamma.js']);

    const orderBeforeCloseDrag = await page.evaluate(() => window.BOBO.state.tabs.map(tab => tab.name));
    const closeButton = page.locator('#tabbar .tab:not([data-tab-provider])', { hasText: 'beta.js' }).locator('.close');
    const closeBounds = await closeButton.boundingBox();
    const gammaBounds = await page.locator('#tabbar .tab:not([data-tab-provider])', { hasText: 'gamma.js' }).boundingBox();
    if (!closeBounds || !gammaBounds) throw new Error('Close drag fixture is not visible');
    await page.mouse.move(closeBounds.x + closeBounds.width / 2, closeBounds.y + closeBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(gammaBounds.x + gammaBounds.width * 0.85, gammaBounds.y + gammaBounds.height / 2, { steps: 12 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.BOBO.state.tabs.map(tab => tab.name))).toEqual(orderBeforeCloseDrag);
    await expect(page.locator('#tabbar .tab:not([data-tab-provider])')).toHaveCount(3);

    await page.locator('#tabbar .tab:not([data-tab-provider])', { hasText: 'gamma.js' }).locator('.close').click();
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title')).toHaveText(['alpha.js', 'beta.js *']);
    expect(await page.evaluate(() => ({
      active: window.BOBO.state.tabs.find(tab => tab.path === window.BOBO.state.activeTabPath).name,
      dirty: window.BOBO.state.tabs.find(tab => tab.name === 'beta.js').dirty
    }))).toEqual({ active: 'beta.js', dirty: true });
    expect(errors).toEqual([]);
  } finally {
    await closeFixture(app);
    await removeSandbox(sandbox);
  }
});
