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
