'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(CLIENT_ROOT, '..');
const SCREENSHOT_DIR = path.join(REPOSITORY_ROOT, 'docs', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const SCREENSHOTS = [
  { name: 'workbench.png', locale: 'en', capture: captureWorkbench },
  { name: 'project-dependencies.png', locale: 'en', capture: captureProjectDependencies },
  { name: 'environment-center.png', locale: 'en', capture: captureEnvironmentCenter },
  { name: 'ai-control-center.png', locale: 'en', capture: captureAiControlCenter },
  { name: 'workbench.zh-CN.png', locale: 'zh-CN', capture: captureWorkbench },
  { name: 'project-dependencies.zh-CN.png', locale: 'zh-CN', capture: captureProjectDependencies },
  { name: 'environment-center.zh-CN.png', locale: 'zh-CN', capture: captureEnvironmentCenter },
  { name: 'ai-control-center.zh-CN.png', locale: 'zh-CN', capture: captureAiControlCenter }
];

const FIXTURE_COPY = Object.freeze({
  en: Object.freeze({
    lspReady: 'LSP Ready',
    noProblems: 'No problems',
    output: [
      '[setup] Workspace synchronized',
      '[docker] Reusing Go 1.23 runtime',
      '[run:go] go run .',
      'BOBOCLOUD build ready',
      'Processed 1,024 jobs in 38 ms',
      'Artifacts  1 file saved',
      'Process exited with code 0'
    ],
    dependencyIndexCurrent: 'Remote dependency index is current',
    runtimeMatches: 'Python matches the selected runtime',
    dependencyMissing: 'One declared package is missing',
    notInstalled: 'Not installed',
    packageSummary: 'Composable utility functions for modern JavaScript projects.',
    modelName: 'Team coding model',
    globalInstructions: 'Prefer focused changes and explain observable tradeoffs.',
    chatInstructions: 'Act as a project-aware coding partner.',
    inlineInstructions: 'Complete only the code at the cursor.'
  }),
  'zh-CN': Object.freeze({
    lspReady: 'LSP 已就绪',
    noProblems: '没有问题',
    output: [
      '[准备] 工作区已同步',
      '[容器] 复用 Go 1.23 运行环境',
      '[运行:go] go run .',
      'BOBOCLOUD 构建就绪',
      '已在 38 毫秒内处理 1,024 个任务',
      '产物  已保存 1 个文件',
      '进程退出代码为 0'
    ],
    dependencyIndexCurrent: '远程依赖索引已是最新状态',
    runtimeMatches: 'Python 与所选运行环境一致',
    dependencyMissing: '缺少一个已声明的软件包',
    notInstalled: '尚未安装',
    packageSummary: '适用于现代 JavaScript 项目的模块化工具函数库。',
    modelName: '团队编程模型',
    globalInstructions: '优先进行聚焦修改，并解释可观察到的取舍。',
    chatInstructions: '作为了解当前项目上下文的编程伙伴。',
    inlineInstructions: '仅补全光标所在位置的代码。'
  })
});

function fixtureCopy(locale) {
  return FIXTURE_COPY[locale] || FIXTURE_COPY.en;
}

function electronExecutablePath() {
  const dist = path.join(CLIENT_ROOT, 'node_modules', 'electron', 'dist');
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

async function screenshotFixture(name, locale, files, targetPath, render, workspaceDirectoryName) {
  let app;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-readme-' + name + '-'));
  const workspace = path.join(fixtureRoot, workspaceDirectoryName || 'workspace');
  const appData = path.join(fixtureRoot, 'appdata');
  const home = path.join(fixtureRoot, 'home');
  writeFixtureFiles(workspace, files || {});
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  try {
    app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: [CLIENT_ROOT, '--user-data-dir=' + path.join(fixtureRoot, 'chromium')],
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
    await page.evaluate(async (activeLocale) => {
      if (window.themeManager) window.themeManager.applyTheme('cloud-forge');
      if (window.BOBO && window.BOBO.i18n && window.BOBO.i18n.getSnapshot().activeId !== activeLocale) {
        await window.BOBO.i18n.setLocale(activeLocale);
      }
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    }, locale);
    await render(page, workspace, fixtureCopy(locale));
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

async function captureWorkbench(targetPath, locale) {
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
  await screenshotFixture('workbench-' + locale, locale, files, targetPath, async (page, workspace, copy) => {
    await openWorkspace(page, workspace, 'main.go');
    await page.evaluate((fixtureText) => {
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
      document.getElementById('status-lsp').textContent = fixtureText.lspReady;
      document.getElementById('status-lsp').dataset.state = 'ready';
      document.getElementById('status-errors').textContent = fixtureText.noProblems;
      window.BOBO.clearRunOutput();
      S.showTimestampNextLine = false;
      fixtureText.output.forEach((line) => window.BOBO.updateRunOutput(line));
      if (S.editor) {
        S.editor.setPosition({ lineNumber: 11, column: 5 });
        S.editor.revealLineInCenter(8);
      }
    }, copy);
    await page.waitForFunction(() => document.querySelectorAll('#run-log .run-output-line').length === 7);
    const geometry = await page.evaluate(() => {
      const editor = document.getElementById('editor').getBoundingClientRect();
      const panel = document.getElementById('bottom-panel').getBoundingClientRect();
      return { editorWidth: editor.width, editorHeight: editor.height, panelHeight: panel.height };
    });
    if (geometry.editorWidth < 800 || geometry.editorHeight < 350 || geometry.panelHeight < 180) {
      throw new Error('workbench regions are not presentation-ready: ' + JSON.stringify(geometry));
    }
  }, 'cloud-build-demo');
}

async function captureEnvironmentCenter(targetPath, locale) {
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
  await screenshotFixture('environment-' + locale, locale, files, targetPath, async (page, workspace, copy) => {
    await page.evaluate((fixtureText) => {
      window.BOBO.lsp.getStatus = () => ({
        state: 'ready',
        dependency: { status: 'ready', detail: fixtureText.dependencyIndexCurrent }
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
                { name: 'uvicorn', constraint: '==0.35.0', source: 'requirements.txt', reason: fixtureText.notInstalled }
              ],
              unknown: []
            },
            consistency: {
              status: 'missing',
              languageRuntime: { status: 'ready', detail: fixtureText.runtimeMatches },
              dependencyRuntime: { status: 'missing', detail: fixtureText.dependencyMissing },
              lspDependencies: { status: 'ready', detail: fixtureText.dependencyIndexCurrent }
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
    }, copy);
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
  }, 'analytics-service');
}

async function captureProjectDependencies(targetPath, locale) {
  const files = {
    'index.js': [
      "import _ from 'lodash';",
      '',
      'const builds = [',
      "  { runtime: 'node:22', durationMs: 184 },",
      "  { runtime: 'python:3.12', durationMs: 72 },",
      "  { runtime: 'go:1.23', durationMs: 143 }",
      '];',
      '',
      "console.log(_.minBy(builds, 'durationMs'));",
      ''
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'build-dashboard',
      private: true,
      packageManager: 'pnpm@10.32.1',
      dependencies: { lodash: '4.17.21' }
    }, null, 2) + '\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n"
  };
  await screenshotFixture('project-dependencies-' + locale, locale, files, targetPath, async (page, workspace, copy) => {
    await page.evaluate((fixtureText) => {
      window.BOBO.state.serverSettings.ip = 'docs-fixture.invalid';
      window.BOBO.state.serverSettings.user = 'docs-user';
      window.BOBO.state.auth = {
        mode: 'multi', token: 'documentation-fixture-token',
        user: { id: 'docs-user', username: 'docs-user' }
      };
      window.BOBO.state.selectedRuntime = 'node:22';
      window.BOBO.state.availableRuntimes = [{
        runtimeId: 'node:22', language: 'node', version: '22',
        dockerImage: 'node:22-slim', displayName: 'Node.js 22'
      }];
      window.BOBO.sendToServer = async (action, data) => {
        if (action === 'getProjectEnvironment') {
          return { success: false, error: 'not required by the documentation fixture' };
        }
        if (action === 'getPackageCenterContext') {
          return {
            success: true,
            data: {
              schema: 'project-package-center/v1',
              revision: 'docs-node-environment-1',
              workspace: {
                kind: 'personal', id: 'docs-user\\0' + data.folderKey,
                key: data.folderKey, name: 'build-dashboard'
              },
              language: { id: 'node', displayName: 'Node.js' },
              runtime: {
                id: 'node:22', displayName: 'Node.js 22', version: '22',
                interpreterVersion: '22.18.0', status: 'ready'
              },
              manager: {
                id: 'pnpm', name: 'pnpm', manifestPath: 'package.json',
                lockfilePath: 'pnpm-lock.yaml', lockfilePresent: true,
                detectedBy: 'packageManager', scopes: ['runtime', 'dev', 'optional']
              },
              capabilities: {
                browse: true, inspect: true, mutate: true, exactInventory: true,
                scopes: true, prereleases: true, transitivePackages: true
              },
              sources: [
                { id: 'npm-official', name: 'npm', kind: 'official', ecosystem: 'node', official: true },
                { id: 'npm-npmmirror', name: 'npmmirror', kind: 'mirror', ecosystem: 'node' }
              ],
              defaultSource: 'npm-official',
              searchMode: 'catalog',
              defaultManifestPath: 'package.json',
              manifests: [
                { path: 'package.json', manager: 'pnpm', kind: 'package', language: 'node', editable: true },
                { path: 'pnpm-lock.yaml', manager: 'pnpm', kind: 'pnpm-lock', language: 'node', lockfile: true }
              ],
              packages: {
                declared: [
                  { name: 'lodash', constraint: '4.17.21', scope: 'runtime', source: 'package.json' }
                ],
                installed: [
                  { name: 'lodash', version: '4.17.21', scope: 'runtime', relationship: 'direct', trust: 'exact' },
                  { name: '@types/node', version: '22.17.2', scope: 'dev', relationship: 'transitive', trust: 'exact' }
                ],
                missing: [],
                unknown: []
              },
              inventory: {
                status: 'ready', exact: true, cacheEntryId: 'docs-node-cache',
                generation: 'docs-node-generation', dependencyDigest: 'docs-node-digest'
              },
              canPlanChanges: { supported: true },
              catalogTimeoutSeconds: 20,
              operationTimeoutSeconds: 600
            }
          };
        }
        if (action === 'searchPackageCatalog') {
          return {
            success: true,
            data: {
              searchMode: 'catalog',
              query: String(data.query || ''),
              items: [{
                name: 'lodash', recommendedVersion: '4.17.21', latestVersion: '4.17.21',
                description: fixtureText.packageSummary,
                compatibility: 'metadata-compatible', projectCached: true,
                catalogAuthority: 'registry.npmjs.org'
              }]
            }
          };
        }
        if (action === 'getPackageCatalogItem') {
          return {
            success: true,
            data: {
              name: 'lodash', recommendedVersion: '4.17.21', latestVersion: '4.17.21',
              description: fixtureText.packageSummary,
              compatibility: 'metadata-compatible', requiresLanguage: '>=18',
              distTags: { latest: '4.17.21' },
              versions: [{ version: '4.17.21', compatibility: 'metadata-compatible' }]
            }
          };
        }
        throw new Error('unexpected documentation action: ' + action);
      };
    }, copy);
    await openWorkspace(page, workspace, 'index.js');
    await page.evaluate(() => {
      const S = window.BOBO.state;
      S.workbench.sidebarWidth = 510;
      S.workbench.panelVisible = false;
      window.BOBO.workbench.setPrimaryView('environment');
      window.BOBO.workbench.apply({ immediate: true });
      document.getElementById('workspace-label').textContent = 'build-dashboard';
      document.getElementById('sidebar-workspace-name').textContent = 'BUILD-DASHBOARD';
      document.querySelector('.runtime-label').textContent = 'Node.js 22';
      window.BOBO.packageCenter.open({ mode: 'discover', query: 'lodash' });
    });
    try {
      await page.waitForFunction(() => {
        const view = document.getElementById('package-center-view');
        const manager = document.getElementById('package-manager-label');
        const rows = document.querySelectorAll('#package-results-list .package-row');
        return view && !view.hidden && manager && manager.textContent === 'pnpm' && rows.length === 1;
      }, null, { timeout: 15000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        packageState: window.BOBO.packageCenter.getState(),
        stateLabel: document.getElementById('package-center-state-label')?.textContent || '',
        manager: document.getElementById('package-manager-label')?.textContent || '',
        query: document.getElementById('package-search-input')?.value || '',
        rows: document.querySelectorAll('#package-results-list .package-row').length
      }));
      throw new Error('project dependency center did not settle: ' + JSON.stringify(state), { cause: error });
    }
    const geometry = await page.evaluate(() => {
      const view = document.getElementById('package-center-view');
      const sidebar = document.getElementById('sidebar');
      const input = document.getElementById('package-search-input').getBoundingClientRect();
      return {
        width: view.getBoundingClientRect().width,
        inputWidth: input.width,
        noHorizontalOverflow: sidebar.scrollWidth <= sidebar.clientWidth + 1,
        rowCount: document.querySelectorAll('#package-results-list .package-row').length,
        ariaBusy: view.getAttribute('aria-busy'),
        operationBusy: window.BOBO.packageCenter.getState().busy,
        stableInstalledAction: Boolean(document.querySelector('#package-results-list .package-row-action:disabled'))
      };
    });
    if (geometry.width < 460 || geometry.inputWidth < 260 || !geometry.noHorizontalOverflow || geometry.rowCount !== 1 ||
        geometry.ariaBusy !== 'false' || geometry.operationBusy || !geometry.stableInstalledAction) {
      throw new Error('project dependency center is not presentation-ready: ' + JSON.stringify(geometry));
    }
  }, 'build-dashboard');
}

async function captureAiControlCenter(targetPath, locale) {
  await screenshotFixture('ai-control-' + locale, locale, {}, targetPath, async (page, workspace, copy) => {
    await page.evaluate((fixtureText) => {
      const settings = {
        schemaVersion: 3,
        chatProfiles: [{
          id: 'docs-chat-connection',
          name: fixtureText.modelName,
          provider: 'openai-compatible',
          apiKey: 'local-documentation-fixture',
          endpoint: 'https://api.example.invalid/v1/chat/completions',
          modelId: 'bobo-code-chat',
          mode: 'chat',
          options: {}
        }],
        inlineProfiles: [{
          id: 'docs-inline-connection',
          name: fixtureText.modelName,
          provider: 'openai-compatible',
          apiKey: 'local-documentation-fixture',
          endpoint: 'https://api.example.invalid/v1/completions',
          modelId: 'bobo-code-fim',
          mode: 'fim',
          options: {}
        }],
        chatProfileId: 'docs-chat-connection',
        inlineProfileId: 'docs-inline-connection',
        globalInstructions: fixtureText.globalInstructions,
        chat: {
          instructions: fixtureText.chatInstructions,
          parameters: { maxTokens: 4096, temperature: 0.2, topP: 1, stop: [] },
          context: {
            maxInputChars: 48000, currentFileChars: 20000, selectionChars: 6000,
            projectChars: 4000, referencedFileChars: 5000, maxReferencedFiles: 4,
            historyMessages: 12, historyMessageChars: 6000
          }
        },
        inline: {
          enabled: true,
          instructions: fixtureText.inlineInstructions,
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
      window.BOBO.aiService.getModelStatus = () => ({ state: 'ready', code: 'ai.status.connected' });
      window.BOBO.aiService.updateStatus('idle');
      window.BOBO.aiSettingsCenter.open('overview');
    }, copy);
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
  process.chdir(CLIENT_ROOT);
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
      await screenshot.capture(stagedPath, screenshot.locale);
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
