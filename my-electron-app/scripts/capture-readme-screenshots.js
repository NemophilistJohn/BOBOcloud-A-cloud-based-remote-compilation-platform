'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(PROJECT_ROOT, 'docs', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const SCREENSHOTS = [
  { name: 'workbench.png', capture: captureWorkbench },
  { name: 'environment-center.png', capture: captureEnvironmentCenter },
  { name: 'ai-control-center.png', capture: captureAiControlCenter }
];

function electronExecutablePath() {
  const dist = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function writeFixtureFiles(directory, files) {
  fs.mkdirSync(directory, { recursive: true });
  Object.entries(files).forEach(([relativePath, content]) => {
    const target = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  });
}

function fixtureEnvironment(appData, home) {
  const environment = {};
  Object.entries(process.env).forEach(([key, value]) => {
    if (/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) return;
    environment[key] = value;
  });
  return Object.assign(environment, {
    APPDATA: appData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg-config')
  });
}

async function closeElectron(app) {
  if (!app) return;
  let child = null;
  try { child = app.process(); } catch (_) {}
  const exited = new Promise((resolve) => {
    if (!child || child.exitCode !== null) resolve();
    else child.once('exit', resolve);
  });
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch (_) {}
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  }
}

async function removeDirectory(directory) {
  await fs.promises.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 200
  });
}

async function screenshotFixture(name, files, targetPath, render) {
  let app;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-readme-' + name + '-'));
  const workspace = path.join(fixtureRoot, 'workspace');
  const appData = path.join(fixtureRoot, 'appdata');
  const home = path.join(fixtureRoot, 'home');
  writeFixtureFiles(workspace, files || {});
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  try {
    app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: [PROJECT_ROOT, '--user-data-dir=' + path.join(fixtureRoot, 'chromium')],
      env: fixtureEnvironment(appData, home)
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize(VIEWPORT);
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-bobo-ready') === 'true',
      null,
      { timeout: 30000 }
    );
    await page.addStyleTag({
      content: [
        '*, *::before, *::after { animation: none !important; transition: none !important; }',
        'html { scroll-behavior: auto !important; }',
        '.monaco-editor textarea { caret-color: transparent !important; }'
      ].join('\n')
    });
    await page.evaluate(async () => {
      if (window.themeManager) window.themeManager.applyTheme('cloud-forge');
      if (window.BOBO && window.BOBO.i18n && window.BOBO.i18n.getSnapshot().activeId !== 'en') {
        await window.BOBO.i18n.setLocale('en');
      }
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });
    await render(page, workspace);
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !document.querySelector('#toast-container .toast'), null, { timeout: 5000 });
    const untranslatedKeys = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
      .filter((element) => {
        if (element.children.length > 0 || !/^ai\.control\./.test(String(element.textContent || '').trim())) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .map((element) => String(element.textContent || '').trim())
      .slice(0, 8));
    if (untranslatedKeys.length) {
      throw new Error(name + ' contains untranslated UI keys: ' + untranslatedKeys.join(', '));
    }
    const fit = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }));
    if (fit.width > fit.viewportWidth + 1 || fit.height > fit.viewportHeight + 1) {
      throw new Error(name + ' overflows viewport: ' + JSON.stringify(fit));
    }
    if (errors.length) throw new Error(name + ' renderer errors: ' + errors.join(' | '));
    await page.screenshot({ path: targetPath, fullPage: false, animations: 'disabled' });
  } finally {
    if (app) await closeElectron(app);
    await removeDirectory(fixtureRoot);
  }
}

async function openWorkspace(page, workspace, fileName) {
  await page.evaluate(async ({ workspacePath, activeFile }) => {
    const opened = await window.api.pickWorkspace(workspacePath);
    const applied = await window.BOBO.workspace.applyWorkspace(
      opened.rootPath,
      opened.tree,
      opened.workspaceIdentity,
      opened.leaveToken
    );
    if (!applied) throw new Error('documentation workspace was not applied');
    const separator = workspacePath.indexOf('\\') >= 0 ? '\\' : '/';
    await window.BOBO.workspace.openFile(workspacePath + separator + activeFile, activeFile);
  }, { workspacePath: workspace, activeFile: fileName });
}

async function captureWorkbench(targetPath) {
  const files = {
    'go.mod': 'module example.com/bobocloud-demo\n\ngo 1.23\n',
    'main.go': [
      'package main',
      '',
      'import (',
      '    "fmt"',
      '    "time"',
      ')',
      '',
      'func main() {',
      '    started := time.Now()',
      '    jobs := 1024',
      '    fmt.Println("BOBOCLOUD build ready")',
      '    fmt.Printf("Processed %d jobs in %s\\n", jobs, time.Since(started))',
      '}',
      ''
    ].join('\n')
  };
  await screenshotFixture('workbench', files, targetPath, async (page, workspace) => {
    await openWorkspace(page, workspace, 'main.go');
    await page.evaluate(() => {
      const S = window.BOBO.state;
      S.workbench.activity = 'explorer';
      S.workbench.sidebarWidth = 280;
      S.workbench.panelVisible = true;
      S.workbench.panelPosition = 'bottom';
      S.workbench.panelSize = 235;
      window.BOBO.workbench.apply({ immediate: true });
      window.BOBO.workbench.setPrimaryView('explorer');
      window.BOBO.switchToPanel('output');
      document.getElementById('workspace-label').textContent = 'cloud-build-demo';
      document.getElementById('sidebar-workspace-name').textContent = 'CLOUD-BUILD-DEMO';
      document.querySelector('.runtime-label').textContent = 'Go 1.23';
      document.getElementById('status-lsp').textContent = 'LSP Ready';
      document.getElementById('status-lsp').dataset.state = 'ready';
      document.getElementById('status-errors').textContent = 'No problems';
      window.BOBO.clearRunOutput();
      S.showTimestampNextLine = false;
      [
        '[setup] Workspace synchronized',
        '[docker] Reusing Go 1.23 runtime',
        '[run:go] go run .',
        'BOBOCLOUD build ready',
        'Processed 1,024 jobs in 38 ms',
        'Artifacts  1 file saved',
        'Process exited with code 0'
      ].forEach((line) => window.BOBO.updateRunOutput(line));
      if (S.editor) {
        S.editor.setPosition({ lineNumber: 11, column: 5 });
        S.editor.revealLineInCenter(8);
      }
    });
    await page.waitForFunction(() => document.querySelectorAll('#run-log .run-output-line').length === 7);
    const geometry = await page.evaluate(() => {
      const editor = document.getElementById('editor').getBoundingClientRect();
      const panel = document.getElementById('bottom-panel').getBoundingClientRect();
      return { editorWidth: editor.width, editorHeight: editor.height, panelHeight: panel.height };
    });
    if (geometry.editorWidth < 800 || geometry.editorHeight < 350 || geometry.panelHeight < 180) {
      throw new Error('workbench regions are not presentation-ready: ' + JSON.stringify(geometry));
    }
  });
}

async function captureEnvironmentCenter(targetPath) {
  const files = {
    'app.py': [
      'from fastapi import FastAPI',
      'import pandas as pd',
      '',
      'app = FastAPI(title="Analytics Service")',
      '',
      '@app.get("/health")',
      'def health():',
      '    return {"status": "ready", "rows": len(pd.DataFrame())}',
      ''
    ].join('\n'),
    'requirements.txt': 'fastapi==0.116.1\npandas==2.3.1\nuvicorn==0.35.0\n',
    'pyproject.toml': '[project]\nname = "analytics-service"\nversion = "0.1.0"\n'
  };
  await screenshotFixture('environment', files, targetPath, async (page, workspace) => {
    await page.evaluate(() => {
      window.BOBO.lsp.getStatus = () => ({
        state: 'ready',
        dependency: { status: 'ready', detail: 'Remote dependency index is current' }
      });
      window.BOBO.sendToServer = async (action, data) => {
        if (action !== 'getProjectEnvironment') throw new Error('unexpected documentation action: ' + action);
        return {
          success: true,
          data: {
            schema: 'project-environment/v1',
            revision: 'docs-environment-1',
            checkedAt: '2026-08-13T02:20:00.000Z',
            workspace: { kind: 'personal', id: 'docs-analytics', name: 'analytics-service', key: data.folderKey },
            language: { id: 'python', displayName: 'Python', source: 'editor' },
            runtime: {
              id: 'python:3.12', language: 'python', version: '3.12',
              image: 'python:3.12-slim', displayName: 'Python 3.12', status: 'ready'
            },
            manifests: [
              { path: 'pyproject.toml', kind: 'project', manager: 'python', language: 'python', parsed: true, status: 'parsed' },
              { path: 'requirements.txt', kind: 'requirements', manager: 'pip', language: 'python', parsed: true, status: 'parsed' }
            ],
            packages: {
              declared: [
                { name: 'fastapi', constraint: '==0.116.1', source: 'requirements.txt' },
                { name: 'pandas', constraint: '==2.3.1', source: 'requirements.txt' },
                { name: 'uvicorn', constraint: '==0.35.0', source: 'requirements.txt' }
              ],
              installed: [
                { name: 'fastapi', version: '0.116.1', source: 'runtime' },
                { name: 'pandas', version: '2.3.1', source: 'runtime' }
              ],
              missing: [
                { name: 'uvicorn', constraint: '==0.35.0', source: 'requirements.txt', reason: 'Not installed' }
              ],
              unknown: []
            },
            consistency: {
              status: 'missing',
              languageRuntime: { status: 'ready', detail: 'Python matches the selected runtime' },
              dependencyRuntime: { status: 'missing', detail: 'One declared package is missing' },
              lspDependencies: { status: 'ready', detail: 'Remote dependency index is current' }
            },
            activity: {
              lastIndexedAt: '2026-08-13T02:15:00.000Z',
              lastInstalledAt: '2026-08-13T01:45:00.000Z',
              lastCompiledAt: '2026-08-13T02:18:00.000Z'
            },
            actions: {
              repair: { supported: true, requiresConfirmation: true },
              rebuild: { supported: true, requiresConfirmation: true },
              refreshIndex: { supported: true },
              clearCache: { supported: true, scope: 'workspace', requiresConfirmation: true }
            }
          }
        };
      };
      window.BOBO.state.serverSettings.ip = 'docs-fixture.invalid';
      window.BOBO.state.selectedRuntime = 'python:3.12';
      window.BOBO.state.availableRuntimes = [{
        runtimeId: 'python:3.12', language: 'python', version: '3.12',
        dockerImage: 'python:3.12-slim', displayName: 'Python 3.12'
      }];
    });
    await openWorkspace(page, workspace, 'app.py');
    await page.evaluate(async () => {
      const S = window.BOBO.state;
      S.workbench.sidebarWidth = 455;
      S.workbench.panelVisible = false;
      window.BOBO.workbench.setPrimaryView('environment');
      window.BOBO.workbench.apply({ immediate: true });
      document.getElementById('workspace-label').textContent = 'analytics-service';
      document.getElementById('sidebar-workspace-name').textContent = 'ANALYTICS-SERVICE';
      document.querySelector('.runtime-label').textContent = 'Python 3.12';
      await window.BOBO.environmentCenter.refresh({ force: true });
      const scroll = document.querySelector('.environment-center-scroll');
      if (scroll) scroll.scrollTop = 0;
    });
    await page.waitForFunction(() => {
      const ready = document.getElementById('environment-center-ready');
      return ready && !ready.hidden && document.getElementById('environment-missing-count').textContent === '1';
    });
    const geometry = await page.evaluate(() => {
      const center = document.getElementById('environment-center');
      const ready = document.getElementById('environment-center-ready').getBoundingClientRect();
      const dock = document.querySelector('.environment-action-dock').getBoundingClientRect();
      return {
        width: ready.width,
        noHorizontalOverflow: center.scrollWidth <= center.clientWidth + 1,
        dockInside: dock.right <= ready.right + 1 && dock.bottom <= ready.bottom + 1
      };
    });
    if (geometry.width < 400 || !geometry.noHorizontalOverflow || !geometry.dockInside) {
      throw new Error('environment center is not presentation-ready: ' + JSON.stringify(geometry));
    }
  });
}

async function captureAiControlCenter(targetPath) {
  await screenshotFixture('ai-control', {}, targetPath, async (page) => {
    await page.evaluate(() => {
      const settings = {
        schemaVersion: 2,
        profiles: [{
          id: 'docs-openai-compatible',
          name: 'Team coding model',
          provider: 'openai-compatible',
          apiKey: 'local-documentation-fixture',
          chat: {
            endpoint: 'https://api.example.invalid/v1/chat/completions',
            modelId: 'bobo-code-chat',
            mode: 'chat',
            options: {}
          },
          inline: {
            endpoint: 'https://api.example.invalid/v1/completions',
            modelId: 'bobo-code-fim',
            mode: 'fim',
            options: {}
          }
        }],
        chatProfileId: 'docs-openai-compatible',
        inlineProfileId: 'docs-openai-compatible',
        globalInstructions: 'Prefer focused changes and explain observable tradeoffs.',
        chat: {
          instructions: 'Act as a project-aware coding partner.',
          parameters: { maxTokens: 4096, temperature: 0.2, topP: 1, stop: [] },
          context: {
            maxInputChars: 48000, currentFileChars: 20000, selectionChars: 6000,
            projectChars: 4000, referencedFileChars: 5000, maxReferencedFiles: 4,
            historyMessages: 12, historyMessageChars: 6000
          }
        },
        inline: {
          enabled: true,
          instructions: 'Complete only the code at the cursor.',
          debounceMs: 450,
          parameters: { maxTokens: 160, temperature: 0, topP: 1, stop: [] },
          context: { prefixChars: 6000, suffixChars: 2500 }
        },
        chatOpen: false
      };
      if (!window.BOBO.aiService || !window.BOBO.aiSettingsCenter) {
        throw new Error('AI control center public API is unavailable');
      }
      window.BOBO.aiService.applySettings(settings);
      window.BOBO.aiSettingsCenter.open('overview');
    });
    await page.waitForFunction(() => {
      const modal = document.getElementById('ai-settings-modal');
      const pane = document.querySelector('[data-ai-pane="overview"]');
      return modal && modal.classList.contains('open') && pane && !pane.hidden;
    });
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector('.ai-control-shell').getBoundingClientRect();
      const modal = document.getElementById('ai-settings-modal');
      return {
        width: shell.width,
        height: shell.height,
        inside: shell.left >= 0 && shell.top >= 0 && shell.right <= innerWidth && shell.bottom <= innerHeight,
        status: document.getElementById('ai-control-status').dataset.state,
        open: modal.getAttribute('aria-hidden') === 'false'
      };
    });
    if (geometry.width < 900 || geometry.height < 600 || !geometry.inside || !geometry.open || geometry.status !== 'ready') {
      throw new Error('AI control center is not presentation-ready: ' + JSON.stringify(geometry));
    }
  });
}

function validatePng(filePath) {
  const buffer = fs.readFileSync(filePath);
  const pngSignature = '89504e470d0a1a0a';
  if (buffer.length < 10000 || buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error(path.basename(filePath) + ' is blank, truncated, or not a PNG (' + buffer.length + ' bytes)');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== VIEWPORT.width || height !== VIEWPORT.height) {
    throw new Error(path.basename(filePath) + ' has unexpected dimensions ' + width + 'x' + height);
  }
  return { width, height, bytes: buffer.length };
}

function publishScreenshots(staging) {
  const parent = path.dirname(SCREENSHOT_DIR);
  const nextDirectory = fs.mkdtempSync(path.join(parent, '.screenshots-next-'));
  const previousDirectory = SCREENSHOT_DIR + '.previous';
  let movedPrevious = false;
  try {
    for (const screenshot of SCREENSHOTS) {
      fs.copyFileSync(path.join(staging, screenshot.name), path.join(nextDirectory, screenshot.name));
    }
    fs.rmSync(previousDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.renameSync(SCREENSHOT_DIR, previousDirectory);
      movedPrevious = true;
    }
    try {
      fs.renameSync(nextDirectory, SCREENSHOT_DIR);
    } catch (error) {
      if (movedPrevious && !fs.existsSync(SCREENSHOT_DIR)) {
        fs.renameSync(previousDirectory, SCREENSHOT_DIR);
      }
      throw error;
    }
    fs.rmSync(previousDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } finally {
    fs.rmSync(nextDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  process.chdir(PROJECT_ROOT);
  const executable = electronExecutablePath();
  if (!fs.existsSync(executable)) throw new Error('Electron is not installed; run npm ci first');
  fs.mkdirSync(path.dirname(SCREENSHOT_DIR), { recursive: true });
  const previousDirectory = SCREENSHOT_DIR + '.previous';
  if (!fs.existsSync(SCREENSHOT_DIR) && fs.existsSync(previousDirectory)) {
    fs.renameSync(previousDirectory, SCREENSHOT_DIR);
  } else {
    fs.rmSync(previousDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-readme-images-'));
  const results = [];
  try {
    for (const screenshot of SCREENSHOTS) {
      const stagedPath = path.join(staging, screenshot.name);
      await screenshot.capture(stagedPath);
      results.push({ name: screenshot.name, ...validatePng(stagedPath) });
    }
    publishScreenshots(staging);
  } finally {
    await removeDirectory(staging);
  }
  results.forEach((result) => {
    console.log('[docs:screenshots] ' + result.name + ' ' + result.width + 'x' + result.height + ' ' + result.bytes + ' bytes');
  });
}

main().catch((error) => {
  console.error('[docs:screenshots] FAILED: ' + (error && error.stack || error));
  process.exitCode = 1;
});
