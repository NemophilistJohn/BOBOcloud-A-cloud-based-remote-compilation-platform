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

async function closeFixture(app) {
  if (!app) return;
  let child = null;
  try { child = app.process(); } catch {}
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
}

test('workspace editor settings apply on open and refresh after settings.json changes', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-workspace-settings-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const vscode = path.join(workspace, '.vscode');
  const sourceFile = path.join(workspace, 'view.templ');
  const hiddenDirectory = path.join(workspace, 'hidden');
  fs.mkdirSync(vscode, { recursive: true });
  fs.mkdirSync(hiddenDirectory, { recursive: true });
  fs.writeFileSync(sourceFile, '<main></main>\n', 'utf8');
  fs.writeFileSync(path.join(hiddenDirectory, 'private.js'), 'secret\n', 'utf8');
  fs.writeFileSync(path.join(vscode, 'settings.json'), JSON.stringify({
    'editor.tabSize': 2,
    'editor.insertSpaces': false,
    'editor.wordWrap': 'bounded',
    'editor.wordWrapColumn': 108,
    'editor.rulers': [80, 108],
    'editor.renderWhitespace': 'all',
    'editor.minimap.enabled': false,
    'editor.bracketPairColorization.enabled': true,
    'files.associations': { '*.templ': 'html' },
    'files.exclude': { '**/hidden': true },
    'terminal.integrated.cwd': 'C:/must-not-cross-the-bridge'
  }), 'utf8');

  let app;
  try {
    const userData = path.join(sandbox, 'chromium');
    app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: ['.', '--user-data-dir=' + userData],
      env: Object.assign({}, process.env, {
        APPDATA: path.join(sandbox, 'appdata'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: path.join(sandbox, 'home'),
        USERPROFILE: path.join(sandbox, 'home'),
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
      })
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true');
    await page.evaluate(async ({ workspace, sourceFile }) => {
      const opened = await window.api.pickWorkspace(workspace);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.workspace.openFile(sourceFile, 'view.templ');
    }, { workspace, sourceFile });

    await expect.poll(() => page.evaluate(() => {
      const model = window.BOBO.state.editor.getModel();
      const options = model.getOptions();
      return {
        language: model.getLanguageId(),
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
        wordWrap: window.BOBO.state.editor.getRawOptions().wordWrap,
        wordWrapColumn: window.BOBO.state.editor.getRawOptions().wordWrapColumn,
        rulers: window.BOBO.state.editor.getRawOptions().rulers.map(item => typeof item === 'number' ? item : item.column),
        renderWhitespace: window.BOBO.state.editor.getRawOptions().renderWhitespace,
        minimap: window.BOBO.state.editor.getRawOptions().minimap.enabled,
        bracketPairs: window.BOBO.state.editor.getRawOptions().bracketPairColorization.enabled,
        hiddenVisible: Boolean(document.querySelector('#file-tree .tree-row[data-name="hidden"]')),
        leaked: JSON.stringify(window.BOBO.state.workspaceSettings).includes('must-not-cross-the-bridge')
      };
    })).toEqual({
      language: 'html', tabSize: 2, insertSpaces: false, wordWrap: 'bounded', wordWrapColumn: 108,
      rulers: [80, 108], renderWhitespace: 'all', minimap: false, bracketPairs: true,
      hiddenVisible: false, leaked: false
    });

    fs.writeFileSync(path.join(vscode, 'settings.json'), JSON.stringify({
      'editor.tabSize': 6,
      'editor.insertSpaces': true,
      'editor.wordWrap': 'on',
      'editor.wordWrapColumn': 120,
      'editor.rulers': [120],
      'editor.renderWhitespace': 'trailing',
      'editor.minimap.enabled': true,
      'editor.bracketPairColorization.enabled': false,
      'files.associations': { '*.templ': 'javascript' }
    }), 'utf8');

    await expect.poll(() => page.evaluate(() => {
      const model = window.BOBO.state.editor.getModel();
      const options = model.getOptions();
      return {
        language: model.getLanguageId(),
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
        wordWrap: window.BOBO.state.editor.getRawOptions().wordWrap,
        wordWrapColumn: window.BOBO.state.editor.getRawOptions().wordWrapColumn,
        rulers: window.BOBO.state.editor.getRawOptions().rulers.map(item => typeof item === 'number' ? item : item.column),
        renderWhitespace: window.BOBO.state.editor.getRawOptions().renderWhitespace,
        minimap: window.BOBO.state.editor.getRawOptions().minimap.enabled,
        bracketPairs: window.BOBO.state.editor.getRawOptions().bracketPairColorization.enabled,
        hiddenVisible: Boolean(document.querySelector('#file-tree .tree-row[data-name="hidden"]'))
      };
    }), { timeout: 10000 }).toEqual({
      language: 'javascript', tabSize: 6, insertSpaces: true, wordWrap: 'on', wordWrapColumn: 120,
      rulers: [120], renderWhitespace: 'trailing', minimap: true, bracketPairs: false, hiddenVisible: true
    });
  } finally {
    await closeFixture(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
