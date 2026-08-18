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

async function closeFixture(fixture) {
  if (!fixture) return;
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch (_) {}
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('Docker runtimes follow the active source language without overriding Local or manual versions', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-runtime-auto-selection-'));
  const workspace = path.join(sandbox, 'workspace');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.py'), 'print("python")\n');
  fs.writeFileSync(path.join(workspace, 'main.go'), 'package main\nfunc main() {}\n');
  fs.writeFileSync(path.join(workspace, 'main.ts'), 'const message: string = "typescript";\n');

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
    page.on('pageerror', error => issues.push(error.message));
    page.on('console', message => { if (message.type() === 'error') issues.push(message.text()); });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });

    const result = await page.evaluate(async workspacePath => {
      const runtimes = [
        { language: 'python', version: '3.10', runtimeId: 'python:3.10', displayName: 'Python 3.10' },
        { language: 'python', version: '3.13', runtimeId: 'python:3.13', displayName: 'Python 3.13' },
        { language: 'go', version: '1.21', runtimeId: 'go:1.21', displayName: 'Go 1.21' },
        { language: 'go', version: '1.23', runtimeId: 'go:1.23', displayName: 'Go 1.23' },
        { language: 'node', version: '20', runtimeId: 'node:20', displayName: 'Node.js 20' },
        { language: 'node', version: '22', runtimeId: 'node:22', displayName: 'Node.js 22' }
      ];
      const state = window.BOBO.state;
      state.serverSettings.ip = '';
      state.availableRuntimes = runtimes;
      state.groupedRuntimes = runtimes.reduce((groups, runtime) => {
        (groups[runtime.language] = groups[runtime.language] || []).push(runtime);
        return groups;
      }, {});
      localStorage.removeItem('bobocloud.runtime');
      localStorage.removeItem('bobocloud.runtime.language-preferences.v1');
      localStorage.removeItem('bobocloud.runtime.auto-used-languages.v1');
      if (state.autoSyncInterval) clearInterval(state.autoSyncInterval);
      window.BOBO.lsp.runtimeChanged = function() {};

      window.BOBO.runtime.selectRuntime('python:3.10');
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/main.py', 'main.py');
      const pythonRuntime = state.selectedRuntime;
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/main.go', 'main.go');
      const automaticGo = state.selectedRuntime;
      const firstToast = document.querySelector('#toast-container .toast-msg')?.textContent || '';
      const firstToastExpected = window.BOBO.i18n.t('Using the latest {language} runtime for this file: {runtime}', {
        language: 'Go', runtime: 'Go 1.23'
      });
      const preferencesAfterAutomaticGo = JSON.parse(localStorage.getItem('bobocloud.runtime.language-preferences.v1') || '{}');

      window.BOBO.runtime.selectRuntime('go:1.21');
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/main.py', 'main.py');
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/main.go', 'main.go');
      const rememberedGo = state.selectedRuntime;

      window.BOBO.runtime.selectRuntime('');
      await window.BOBO.workspace.openFile(workspacePath.replace(/\\/g, '/') + '/main.ts', 'main.ts');
      return {
        pythonRuntime,
        automaticGo,
        firstToast,
        firstToastExpected,
        preferencesAfterAutomaticGo,
        rememberedGo,
        localAfterTypeScript: state.selectedRuntime,
        activeLanguage: state.tabs.find(tab => tab.path.endsWith('/main.ts')).language
      };
    }, workspace);

    expect(result.pythonRuntime).toBe('python:3.10');
    expect(result.automaticGo).toBe('go:1.23');
    expect(result.firstToast).toBe(result.firstToastExpected);
    expect(result.preferencesAfterAutomaticGo).toEqual({ python: 'python:3.10' });
    expect(result.rememberedGo).toBe('go:1.21');
    expect(result.localAfterTypeScript).toBe('');
    expect(result.activeLanguage).toBe('typescript');
    expect(issues).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});
