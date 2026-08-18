const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronExecutablePath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

async function closeFixture(app, sandbox) {
  let child = null;
  try { child = app.process(); } catch {}
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

test('project task matcher creates clickable Problems entries and Monaco markers', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-task-problems-'));
  const workspace = path.join(sandbox, 'workspace');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const source = path.join(workspace, 'src', 'main.c');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'int main(void) {\n  return missing_symbol;\n}\n', 'utf8');
  let app;
  try {
    app = await electron.launch({
      executablePath: electronExecutablePath(), args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, { APPDATA: path.join(sandbox, 'appdata'), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(sandbox, 'xdg') })
    });
    const page = await app.firstWindow();
    const issues = [];
    page.on('pageerror', error => issues.push(error.message));
    page.on('console', message => { if (message.type() === 'error') issues.push(message.text()); });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true');
    await page.evaluate(async workspacePath => {
      window.BOBO.state.serverSettings.ip = '';
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/src/main.c', 'main.c');
      const session = window.BOBO.taskProblemMatcher.begin({ label: 'Build', problemMatcher: '$gcc' });
      session.consume('src/main.c:2:10: error: use of undeclared identifier \'missing_symbol\'', 'task:build:compile');
      session.finish();
      window.BOBO.switchToPanel('problems');
    }, workspace);
    const panel = page.locator('#panel-problems');
    await expect(panel.locator('.problem-row')).toHaveCount(1);
    await expect(panel.locator('.problem-row')).toContainText('use of undeclared identifier');
    const markerCount = await page.evaluate(() => {
      const model = window.BOBO.state.editor.getModel();
      return window.monaco.editor.getModelMarkers({ owner: 'task-problem-matcher', resource: model.uri }).length;
    });
    expect(markerCount).toBe(1);
    await panel.locator('.problem-row').click();
    await expect(page.locator('#tabbar .tab.active .tab-title')).toHaveText('main.c');
    await page.evaluate(() => {
      window.BOBO.taskProblemMatcher.clear();
      const model = window.BOBO.state.editor.getModel();
      window.monaco.editor.setModelMarkers(model, 'remote-lsp', [{
        startLineNumber: 2,
        startColumn: 10,
        endLineNumber: 2,
        endColumn: 24,
        severity: window.monaco.MarkerSeverity.Error,
        message: 'Cannot find name missing_symbol',
        source: 'LSP'
      }]);
      window.BOBO.editorCore.refreshDiagnosticsForModel(model);
      document.getElementById('status-errors').click();
    });
    await expect(panel.locator('.problem-row')).toHaveCount(1);
    await expect(panel.locator('.problem-row')).toContainText('Cannot find name missing_symbol');
    await expect(page.locator('#panel-problems')).toHaveClass(/active/);
    expect(issues).toEqual([]);
  } finally {
    if (app) await closeFixture(app, sandbox);
  }
});
