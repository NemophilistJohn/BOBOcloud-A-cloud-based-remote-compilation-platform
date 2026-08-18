const { test, expect, _electron: electron } = require('playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function electronExecutablePath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

test('configured LSP address, strategy settings and status bar work in all built-in locales', async ({}, testInfo) => {
  test.setTimeout(60000);
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-lsp-ui-'));
  const appDataDir = path.join(sandboxDir, 'appdata');
  const homeDir = path.join(sandboxDir, 'home');
  const workspaceDir = path.join(sandboxDir, 'workspace');
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const targetFile = path.join(workspaceDir, 'target.rs');
  const pythonFile = path.join(workspaceDir, 'numpy_test.py');
  const typescriptFile = path.join(workspaceDir, 'format.ts');
  const htmlFile = path.join(workspaceDir, 'index.html');
  const outsideFile = path.join(path.dirname(workspaceDir), 'outside.rs');
  fs.writeFileSync(targetFile, 'fn target() {}\n', 'utf8');
  fs.writeFileSync(pythonFile, 'import nu\n', 'utf8');
  fs.writeFileSync(typescriptFile, 'const value = 1\n', 'utf8');
  fs.writeFileSync(htmlFile, '<!doctype html>\n<html><body><di</body></html>\n', 'utf8');
  let app;
  try {
    app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: ['.', '--user-data-dir=' + path.join(sandboxDir, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: appDataDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: homeDir,
        USERPROFILE: homeDir,
        XDG_CONFIG_HOME: path.join(sandboxDir, 'xdg-config')
      })
    });
    expect(await app.evaluate(() => typeof WebSocket)).toBe('function');
    await app.evaluate(() => {
      globalThis.__boboLspProbe = {
        starts: [],
        dependencyRefreshes: 0,
        dependencyRefreshDelayMs: 0,
        dependencyRefreshChanged: false,
        completionRequests: 0,
        completionContexts: [],
        completionDelayMs: 900,
        dependencyIndexRequests: 0
      };
      globalThis.WebSocket = class TestWebSocket {
        constructor(url) {
          this.url = String(url);
          this.readyState = 0;
          this.listeners = new Map();
          setTimeout(() => {
            this.readyState = 1;
            this.emit('open', {});
          }, 0);
        }

        addEventListener(name, listener) {
          const listeners = this.listeners.get(name) || [];
          listeners.push(listener);
          this.listeners.set(name, listeners);
        }

        emit(name, event) {
          (this.listeners.get(name) || []).forEach((listener) => listener(event));
        }

        respond(message, delay = 0) {
          setTimeout(() => this.emit('message', { data: JSON.stringify(message) }), delay);
        }

        send(encoded) {
          const message = JSON.parse(encoded);
          if (message.type === 'lsp.start') {
            this.startMessage = message;
            globalThis.__boboLspProbe.starts.push({ url: this.url, message });
            this.respond({
              type: 'lsp.ready',
              sessionId: 'ui-address-' + globalThis.__boboLspProbe.starts.length,
              capabilities: {
                mode: message.mode,
                remote: true,
                virtualRootUri: 'bobocloud-lsp:///',
                dependencyApiIndex: {
                  enabled: message.languageId === 'python',
                  schema: 'dependency-api-index-v1',
                  languages: ['python'],
                  maxPageBytes: 194560
                }
              },
              cache: { sizeBytes: 128 },
              dependency: {
                status: 'ready',
                revision: 'deps-' + globalThis.__boboLspProbe.starts.length,
                languageId: message.languageId,
                runtimeId: message.runtimeId,
                source: 'user',
                configuration: {}
              }
            });
          } else if (message.type === 'lsp.dependency.refresh') {
            globalThis.__boboLspProbe.dependencyRefreshes += 1;
            const start = this.startMessage || {};
            const changed = globalThis.__boboLspProbe.dependencyRefreshChanged === true;
            this.respond({
              type: 'lsp.dependency',
              success: true,
              changed,
              restartRequired: false,
              dependency: {
                status: 'ready',
                revision: 'deps-refreshed',
                languageId: start.languageId,
                runtimeId: start.runtimeId,
                source: 'user',
                configuration: {}
              }
            }, globalThis.__boboLspProbe.dependencyRefreshDelayMs || 0);
          } else if (message.type === 'lsp.dependency.index.request') {
            globalThis.__boboLspProbe.dependencyIndexRequests += 1;
            const start = this.startMessage || {};
            this.respond({
              type: 'lsp.dependency.index',
              requestId: message.requestId,
              success: true,
              page: {
                schema: 'dependency-api-index-v1',
                languageId: 'python',
                runtimeId: start.runtimeId,
                revision: 'deps-' + globalThis.__boboLspProbe.starts.length,
                roots: ['numpy'],
                entries: [{
                  module: 'numpy',
                  kind: 'package',
                  symbols: [
                    { name: 'array', kind: 'function' },
                    { name: 'ndarray', kind: 'class' }
                  ]
                }],
                complete: true
              }
            });
          } else if (message.method === 'initialize') {
            this.respond({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                capabilities: {
                  completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
                  hoverProvider: true
                }
              }
            });
          } else if (message.method === 'textDocument/completion') {
            globalThis.__boboLspProbe.completionRequests += 1;
            globalThis.__boboLspProbe.completionContexts.push(message.params && message.params.context);
            this.respond({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                isIncomplete: false,
                items: [{ label: 'alpha_remote_value', kind: 6, insertText: 'alpha_remote_value', detail: 'Remote semantic result' }]
              }
            }, globalThis.__boboLspProbe.completionDelayMs);
          } else if (message.method === 'shutdown') {
            this.respond({ jsonrpc: '2.0', id: message.id, result: null });
          }
        }

        close(code = 1000, reason = '') {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.emit('close', { code, reason });
        }
      };
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    const consoleIssues = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(message.text());
    });
    await page.waitForFunction(() => document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true', null, { timeout: 20000 });
    const openerResult = await page.evaluate(async ({ workspaceDir, targetFile, outsideFile }) => {
      const workspace = await window.api.pickWorkspace(workspaceDir);
      await window.BOBO.workspace.applyWorkspace(workspace.rootPath, workspace.tree);
      const opened = await window.BOBO.lsp._helpers.openWorkspaceResource(
        window.BOBO.state.editor,
        window.monaco.Uri.file(targetFile),
        { lineNumber: 1, column: 4 }
      );
      const outside = await window.BOBO.lsp._helpers.openWorkspaceResource(
        window.BOBO.state.editor,
        window.monaco.Uri.file(outsideFile),
        { lineNumber: 1, column: 1 }
      );
      return {
        opened,
        outside,
        active: window.BOBO.state.activeTabPath,
        position: window.BOBO.state.editor.getPosition()
      };
    }, { workspaceDir, targetFile, outsideFile });
    expect(openerResult.opened).toBe(true);
    expect(openerResult.outside).toBe(false);
    expect(openerResult.active.toLowerCase()).toBe(targetFile.toLowerCase());
    expect(openerResult.position).toEqual({ lineNumber: 1, column: 4 });
    const renameResult = await page.evaluate(async () => {
      const mapped = await window.BOBO.lsp._helpers.mapWorkspaceEdit({
        documentChanges: [{
          kind: 'rename',
          oldUri: 'bobocloud-lsp:///target.rs',
          newUri: 'bobocloud-lsp:///renamed.rs',
          options: { overwrite: false }
        }]
      });
      const unsupported = await window.BOBO.lsp._helpers.mapWorkspaceEdit({
        documentChanges: [{ kind: 'future-operation', uri: 'bobocloud-lsp:///target.rs' }]
      });
      return {
        count: mapped.edits.length,
        oldPath: mapped.edits[0] && mapped.edits[0].oldResource.fsPath,
        newPath: mapped.edits[0] && mapped.edits[0].newResource.fsPath,
        unsupportedCount: unsupported.edits.length,
        unsupportedReason: unsupported.rejectReason
      };
    });
    expect(renameResult.count).toBe(1);
    expect(renameResult.oldPath.toLowerCase()).toBe(targetFile.toLowerCase());
    expect(renameResult.newPath.toLowerCase()).toBe(path.join(workspaceDir, 'renamed.rs').toLowerCase());
    expect(renameResult.unsupportedCount).toBe(0);
    expect(renameResult.unsupportedReason).toBeTruthy();
    const remoteDiagnosticCount = await page.evaluate(() => {
      const model = window.BOBO.state.editor.getModel();
      window.monaco.editor.setModelMarkers(model, 'remote-lsp', [{
        startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3,
        severity: window.monaco.MarkerSeverity.Error, message: 'remote test'
      }]);
      window.BOBO.editorCore.refreshDiagnosticsForModel(model);
      const count = window.BOBO.state.currentDiagnostics.errors;
      window.monaco.editor.setModelMarkers(model, 'remote-lsp', []);
      window.BOBO.editorCore.refreshDiagnosticsForModel(model);
      return count;
    });
    expect(remoteDiagnosticCount).toBe(1);
    await page.evaluate(async () => {
      const serverSettings = {
        ip: 'compiler.example.test',
        user: '',
        pass: '',
        apiKey: 'ui-test-api-key',
        rclonePath: '',
        syncInterval: 30000
      };
      await window.api.writeServerSettings(serverSettings);
      window.BOBO.state.serverSettings = serverSettings;
      window.BOBO.sendToServer = async function(action) {
        if (action === 'getLSPInfo') {
          return { success: true, data: { enabled: true, languages: ['rust', 'python', 'html', 'css', 'scss', 'less', 'json', 'jsonc', 'yaml', 'shell'] } };
        }
        return { success: true };
      };
      await window.BOBO.lsp.credentialsChanged();
      window.BOBO.lsp.workspaceChanged();
    });
    await page.evaluate(() => window.BOBO.settings.open('lsp'));

    await expect(page.locator('.settings-tab[data-stab="lsp"]')).toHaveClass(/active/);
    await expect(page.locator('input[name="lsp-mode"]')).toHaveCount(3);
    await expect(page.locator('input[name="lsp-client-cache-mode"][value="lazy"]')).toBeChecked();
    await expect(page.locator('#lsp-client-cache-size-mib')).toHaveValue('32');
    await expect(page.locator('#lsp-client-cache-size-mib')).toHaveAttribute('min', '1');
    await expect(page.locator('#lsp-client-cache-size-mib')).toHaveAttribute('max', '1024');
    await expect(page.locator('#lsp-client-cache-size-output')).toHaveText('32 MB');
    await expect(page.locator('#lsp-client-cache-clear-workspace')).toBeEnabled();
    await expect(page.locator('#lsp-client-cache-clear-all')).toBeEnabled();
    await page.locator('.lsp-mode-option').filter({ has: page.locator('input[value="standard"]') }).click();
    await expect(page.locator('input[name="lsp-mode"][value="standard"]')).toBeChecked();
    await expect(page.locator('#status-lsp')).toContainText('LSP: Remote');
    await expect(page.locator('#lsp-settings-state')).toHaveText('Remote analysis ready');
    await expect(page.locator('#lsp-settings-detail')).toBeHidden();
    await expect(page.locator('#lsp-metric-dependency')).toHaveText('Ready');
    await expect(page.locator('#lsp-metric-dependency-revision')).toHaveText('deps-1');
    await expect(page.locator('#lsp-metric-dependency-language')).toHaveText('Rust');
    await expect(page.locator('#lsp-metric-dependency-runtime')).toHaveText('Local');
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.starts.length))).toBe(1);
    let probe = await app.evaluate(() => globalThis.__boboLspProbe);
    expect(probe.starts[0].url).toBe('ws://compiler.example.test:3100/lsp');
    expect(probe.starts[0].message.token).toBe('ui-test-api-key');
    expect(probe.starts[0].message.mode).toBe('standard');

    await page.locator('.lsp-client-cache-mode-option').filter({ has: page.locator('input[value="active"]') }).click();
    await expect(page.locator('input[name="lsp-client-cache-mode"][value="active"]')).toBeChecked();
    await expect(page.locator('#lsp-client-cache-dependency-index')).toBeVisible();
    await expect(page.locator('#lsp-client-cache-dependency-index-toggle')).toBeDisabled();
    await expect(page.locator('#lsp-client-cache-dependency-index-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#lsp-client-cache-dependency-index-state')).toHaveText('Library API cache is unavailable for the current analysis.');
    await expect(page.locator('#lsp-client-cache-dependency-index-hint')).toHaveText('A compatible Python dependency view is required.');
    await expect(page.locator('#lsp-client-cache-size')).toHaveText('0 B / 32.0 MB');
    const cacheCapacity = page.locator('#lsp-client-cache-size-mib');
    await cacheCapacity.focus();
    await cacheCapacity.press('ArrowRight');
    await expect(cacheCapacity).toHaveValue('33');
    await expect(cacheCapacity).toHaveAttribute('aria-valuetext', '33 MB');
    await expect(page.locator('#lsp-client-cache-size-output')).toHaveText('33 MB');
    await expect(page.locator('#lsp-client-cache-size')).toHaveText('0 B / 33.0 MB');
    await expect(page.locator('#lsp-client-cache-clear-workspace')).toBeEnabled();
    await expect(page.locator('#lsp-client-cache-clear-all')).toBeEnabled();

    const clientCacheProbe = await page.evaluate(async () => {
      const current = window.BOBO.lsp.getClientCacheScope();
      if (!current) throw new Error('Expected a local cache scope after LSP initialization');
      const other = Object.assign({}, current, {
        workspace: { kind: 'personal', folderKey: 'ui-cache-other-workspace' }
      });
      const value = {
        items: [{
          label: 'cached_ui_candidate',
          kind: 6,
          insertText: 'cached_ui_candidate',
          detail: 'Persistent cache UI probe'
        }]
      };
      const currentStored = await window.api.lspClientCachePut(current, 'ui-cache-current-entry', value);
      const otherStored = await window.api.lspClientCachePut(other, 'ui-cache-other-entry', value);
      return { current, other, currentStored, otherStored };
    });
    expect(clientCacheProbe.currentStored.stored).toBe(true);
    expect(clientCacheProbe.otherStored.stored).toBe(true);

    await page.locator('#lsp-client-cache-clear-workspace').click();
    await expect(page.locator('#lsp-client-cache-state')).toHaveText('No local cache data');
    const afterWorkspaceClear = await page.evaluate(async ({ current, other }) => ({
      current: await window.api.lspClientCacheGet(current, 'ui-cache-current-entry'),
      other: await window.api.lspClientCacheGet(other, 'ui-cache-other-entry')
    }), clientCacheProbe);
    expect(afterWorkspaceClear.current).toBeNull();
    expect(afterWorkspaceClear.other.items[0].label).toBe('cached_ui_candidate');

    await page.locator('#lsp-client-cache-clear-all').click();
    await expect(page.locator('#lsp-client-cache-state')).toHaveText('No local cache data');
    const afterAllClear = await page.evaluate(async ({ other }) => (
      window.api.lspClientCacheGet(other, 'ui-cache-other-entry')
    ), clientCacheProbe);
    expect(afterAllClear).toBeNull();

    await page.locator('#settings-close-lsp').click();
    await page.evaluate(() => {
      const editor = window.BOBO.state.editor;
      editor.updateOptions({ quickSuggestions: false });
      editor.getModel().setValue('fn main() {\n    let alpha_value = 1;\n    alp\n}\n');
      editor.setPosition({ lineNumber: 3, column: 8 });
      editor.focus();
      editor.trigger('lsp-ui-test', 'editor.action.triggerSuggest', {});
    });
    await expect(page.locator('.suggest-widget.visible')).toBeVisible({ timeout: 500 });
    await expect(page.locator('.suggest-widget.visible')).toContainText('alpha_value', { timeout: 500 });
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.completionRequests))).toBe(1);
    expect((await app.evaluate(() => globalThis.__boboLspProbe.completionContexts[0])).triggerKind).toBe(1);
    await expect(page.locator('.suggest-widget.visible')).toContainText('alpha_remote_value', { timeout: 2500 });
    await page.waitForTimeout(100);
    expect(await app.evaluate(() => globalThis.__boboLspProbe.completionRequests)).toBe(1);

    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const editor = window.BOBO.state.editor;
      editor.getModel().setValue('fn main() {\n    let value: String = String::new();\n    value\n}\n');
      editor.setPosition({ lineNumber: 3, column: 10 });
      editor.focus();
    });
    await page.keyboard.type('.');
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.completionRequests))).toBe(2);
    const triggerContext = await app.evaluate(() => globalThis.__boboLspProbe.completionContexts.at(-1));
    expect(triggerContext).toEqual({ triggerKind: 2, triggerCharacter: '.' });
    await page.waitForTimeout(1000);
    expect(await app.evaluate(() => globalThis.__boboLspProbe.completionRequests)).toBe(2);

    await app.evaluate(() => { globalThis.__boboLspProbe.dependencyRefreshChanged = true; });
    expect(await page.evaluate(() => window.BOBO.lsp.dependenciesChanged())).toBe(true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const editor = window.BOBO.state.editor;
      editor.focus();
      editor.trigger('lsp-ui-test', 'editor.action.triggerSuggest', {});
    });
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.completionRequests))).toBe(3);
    await page.waitForTimeout(1000);
    expect(await app.evaluate(() => globalThis.__boboLspProbe.completionRequests)).toBe(3);
    await app.evaluate(() => { globalThis.__boboLspProbe.dependencyRefreshChanged = false; });
    await page.evaluate(() => window.BOBO.settings.open('lsp'));

    const formattingProbe = await page.evaluate(({ typescriptFile }) => {
      const uri = window.monaco.Uri.file(typescriptFile);
      const existing = window.monaco.editor.getModel(uri);
      const model = existing || window.monaco.editor.createModel('const value = 1\n', 'typescript', uri);
      model.updateOptions({ tabSize: 3, insertSpaces: false });
      const params = window.BOBO.lsp._helpers.formattingParamsForModel(model, {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 6
      }, {});
      const result = {
        params,
        localPath: model.uri.fsPath,
        serialized: JSON.stringify(params)
      };
      if (!existing) model.dispose();
      return result;
    }, { typescriptFile });
    expect(formattingProbe.params).toEqual({
      textDocument: { uri: 'bobocloud-lsp:///format.ts' },
      options: { tabSize: 3, insertSpaces: false },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 }
      }
    });
    expect(formattingProbe.serialized).not.toContain(formattingProbe.localPath);

    for (const locale of ['en', 'zh-CN', 'ja']) {
      const dependencyCopy = await page.evaluate(async (nextLocale) => {
        await window.BOBO.i18n.setLocale(nextLocale);
        window.BOBO.lsp.renderStatus();
        return {
          expectedReady: window.BOBO.i18n.t('Ready'),
          actualReady: document.getElementById('lsp-metric-dependency').textContent,
          expectedState: window.BOBO.i18n.t('Remote analysis ready'),
          actualState: document.getElementById('lsp-settings-state').textContent,
          expectedCacheHeading: window.BOBO.i18n.t('Local completion cache'),
          actualCacheHeading: document.getElementById('lsp-client-cache-heading').textContent,
          expectedCapacity: window.BOBO.i18n.t('Cache capacity'),
          actualCapacity: document.getElementById('lsp-client-cache-capacity-label').textContent,
          expectedLazy: window.BOBO.i18n.t('Lazy cache'),
          actualLazy: document.querySelector('input[name="lsp-client-cache-mode"][value="lazy"]').nextElementSibling.querySelector('strong').textContent,
          expectedLibraryApiCache: window.BOBO.i18n.t('Library API cache'),
          actualLibraryApiCache: document.getElementById('lsp-client-cache-dependency-index-heading').textContent,
          expectedLibraryApiHint: window.BOBO.i18n.t('A compatible Python dependency view is required.'),
          actualLibraryApiHint: document.getElementById('lsp-client-cache-dependency-index-hint').textContent
        };
      }, locale);
      expect(dependencyCopy.expectedReady).toBeTruthy();
      expect(dependencyCopy.actualReady).toBe(dependencyCopy.expectedReady);
      expect(dependencyCopy.actualState).toBe(dependencyCopy.expectedState);
      expect(dependencyCopy.actualCacheHeading).toBe(dependencyCopy.expectedCacheHeading);
      expect(dependencyCopy.actualCapacity).toBe(dependencyCopy.expectedCapacity);
      expect(dependencyCopy.actualLazy).toBe(dependencyCopy.expectedLazy);
      expect(dependencyCopy.actualLibraryApiCache).toBe(dependencyCopy.expectedLibraryApiCache);
      expect(dependencyCopy.actualLibraryApiHint).toBe(dependencyCopy.expectedLibraryApiHint);
      if (locale === 'ja') {
        await page.locator('.lsp-client-cache-section').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('lsp-dependency-ja-ready.png'), fullPage: true });
      }
    }
    await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('en');
      window.BOBO.lsp.renderStatus();
    });

    await page.locator('.lsp-client-cache-mode-option').filter({ has: page.locator('input[value="off"]') }).click();
    await expect(page.locator('input[name="lsp-client-cache-mode"][value="off"]')).toBeChecked();
    await expect(page.locator('#lsp-client-cache-dependency-index')).toBeHidden();
    await expect(cacheCapacity).toBeDisabled();

    const dependencyHookState = await page.evaluate(() => ({
      mode: window.BOBO.lsp.getMode(),
      status: window.BOBO.lsp.getStatus(),
      hasControl: typeof window.api.lspControl,
      hasHook: typeof window.BOBO.lsp.dependenciesChanged
    }));
    expect(dependencyHookState.mode).toBe('standard');
    expect(dependencyHookState.status.state).toBe('ready');
    expect(dependencyHookState.hasControl).toBe('function');
    expect(dependencyHookState.hasHook).toBe('function');
    await app.evaluate(() => { globalThis.__boboLspProbe.dependencyRefreshDelayMs = 120; });
    await page.evaluate(() => {
      window.__boboDependencyRefreshFirst = window.BOBO.lsp.dependenciesChanged();
    });
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.dependencyRefreshes))).toBe(2);
    await page.waitForTimeout(30);
    const refreshWasCoalesced = await page.evaluate(() => {
      window.__boboDependencyRefreshSecond = window.BOBO.lsp.dependenciesChanged();
      return window.__boboDependencyRefreshFirst === window.__boboDependencyRefreshSecond;
    });
    expect(refreshWasCoalesced).toBe(true);
    expect(await page.evaluate(() => Promise.all([
      window.__boboDependencyRefreshFirst,
      window.__boboDependencyRefreshSecond
    ]))).toEqual([true, true]);
    expect(await app.evaluate(() => globalThis.__boboLspProbe.dependencyRefreshes)).toBe(2);
    await expect(page.locator('#lsp-metric-dependency-revision')).toHaveText('deps-refreshed');
    await app.evaluate(() => { globalThis.__boboLspProbe.dependencyRefreshDelayMs = 0; });

    await page.locator('.lsp-mode-option').filter({ has: page.locator('input[value="full"]') }).click();
    await expect(page.locator('input[name="lsp-mode"][value="full"]')).toBeChecked();
    await expect(page.locator('#status-lsp')).toContainText('LSP: Remote');
    await expect(page.locator('#lsp-settings-detail')).toBeHidden();
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.starts.length))).toBe(2);
    probe = await app.evaluate(() => globalThis.__boboLspProbe);
    expect(probe.starts[1].url).toBe('ws://compiler.example.test:3100/lsp');
    expect(probe.starts[1].message.token).toBe('ui-test-api-key');
    expect(probe.starts[1].message.mode).toBe('full');

    await page.locator('.lsp-mode-option').filter({ has: page.locator('input[value="standard"]') }).click();
    await page.evaluate(async ({ htmlFile }) => {
      window.BOBO.state.selectedRuntime = 'rust:1.82';
      await window.BOBO.workspace.openFile(htmlFile, 'index.html');
    }, { htmlFile });
    await expect(page.locator('#status-lsp')).toContainText('LSP: Remote');
    await expect(page.locator('#lsp-settings-state')).toHaveText('Remote analysis ready');
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.starts.length))).toBeGreaterThanOrEqual(3);
    probe = await app.evaluate(() => globalThis.__boboLspProbe);
    const htmlStart = probe.starts.at(-1);
    expect(htmlStart.message.languageId).toBe('html');
    expect(htmlStart.message.runtimeId).toBe('local');
    await page.screenshot({ path: path.join(os.tmpdir(), 'bobo-lsp-address-fixed.png'), fullPage: true });

    await page.locator('.lsp-mode-option').filter({ has: page.locator('input[value="local"]') }).click();
    await expect(page.locator('input[name="lsp-mode"][value="local"]')).toBeChecked();
    await expect(page.locator('#status-lsp')).toContainText('LSP: Local');
    await expect(page.locator('#lsp-settings-actions')).toBeHidden();

    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('zh-CN'); window.BOBO.lsp.renderStatus(); });
    await expect(page.locator('.settings-tab[data-stab="lsp"]')).toHaveText('代码智能');
    await expect(page.locator('.lsp-mode-option').nth(1).locator('strong')).toHaveText('标准');
    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('ja'); window.BOBO.lsp.renderStatus(); });
    await expect(page.locator('.settings-tab[data-stab="lsp"]')).toHaveText('コードインテリジェンス');

    await page.evaluate(async ({ pythonFile }) => {
      await window.BOBO.i18n.setLocale('en');
      window.BOBO.state.selectedRuntime = 'python:3.10';
      await window.BOBO.workspace.openFile(pythonFile, 'numpy_test.py');
      // Use the same public setting path as the UI. A label click here can
      // race the preceding local-mode teardown and leave the HTML session as
      // the most recent probe entry.
      await window.BOBO.lsp.setMode('standard');
    }, { pythonFile });
    await expect.poll(async () => app.evaluate(() => {
      return globalThis.__boboLspProbe.starts.some((entry) => entry.message.languageId === 'python' && entry.message.runtimeId === 'python:3.10');
    })).toBe(true);
    await page.locator('.lsp-client-cache-mode-option').filter({ has: page.locator('input[value="active"]') }).click();
    await expect(page.locator('#lsp-client-cache-dependency-index-toggle')).toBeEnabled();
    await page.locator('#lsp-client-cache-dependency-index-toggle').click();
    await expect.poll(async () => (await app.evaluate(() => globalThis.__boboLspProbe.dependencyIndexRequests))).toBeGreaterThan(0);
    await expect(page.locator('#lsp-client-cache-dependency-index-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#lsp-client-cache-dependency-index-state')).toHaveText('Library API cache is enabled');
    await page.locator('#settings-close-lsp').click();
    await app.evaluate(() => { globalThis.__boboLspProbe.completionDelayMs = 1200; });
    await page.evaluate(() => {
      const editor = window.BOBO.state.editor;
      editor.updateOptions({ quickSuggestions: true, suggestOnTriggerCharacters: true });
      editor.getModel().setValue('import nu');
      editor.setPosition({ lineNumber: 1, column: 10 });
      editor.focus();
      editor.trigger('dependency-api-index-test', 'editor.action.triggerSuggest', {});
    });
    await expect(page.locator('.suggest-widget.visible')).toContainText('numpy', { timeout: 700 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const editor = window.BOBO.state.editor;
      editor.getModel().setValue('numpy.');
      editor.setPosition({ lineNumber: 1, column: 7 });
      editor.focus();
      editor.trigger('dependency-api-index-test', 'editor.action.triggerSuggest', {});
    });
    await expect(page.locator('.suggest-widget.visible')).toContainText('array', { timeout: 700 });
    await app.evaluate(() => { globalThis.__boboLspProbe.completionDelayMs = 900; });

    await page.screenshot({ path: testInfo.outputPath('lsp-settings-ja.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
    expect(consoleIssues).toEqual([]);
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.promises.rm(sandboxDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
