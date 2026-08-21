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

function evidencePath(name) {
  const directory = process.env.BOBO_UI_EVIDENCE_DIR || path.join(os.tmpdir(), 'bobo-ui-evidence');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

async function closeFixture(fixture) {
  if (!fixture) return;
  let child = null;
  try { child = fixture.app.process(); } catch {}
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch {}
  if (child && child.exitCode === null) {
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  }
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('cloud DAP supports gutter breakpoints, paused inspection and debug controls', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-dap-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const sourceFile = path.join(workspace, 'main.py');
  fs.writeFileSync(sourceFile, 'value = 7\nmarker = True\nprint(value)\nprint("done")\n', 'utf8');
  fs.writeFileSync(path.join(workspace, '.vscode', 'launch.json'), `{
    // VS Code JSONC
    "version": "0.2.0",
    "configurations": [
      {
        "name": "Debug project", "type": "python", "request": "launch",
        "program": "${'${workspaceFolder}'}/main.py",
        "preLaunchTask": "Build before debug",
        "postDebugTask": "Clean after debug"
      },
    ]
  }`, 'utf8');

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
    await app.evaluate(() => {
      globalThis.__boboDapProbe = { starts: [], requests: [], breakpoints: [], exceptionBreakpoints: [], advancedMoveApplied: false };
      globalThis.WebSocket = class TestDapSocket {
        constructor(url) {
          this.url = String(url);
          this.readyState = 0;
          this.listeners = new Map();
          globalThis.__boboDapSocket = this;
          setTimeout(() => { this.readyState = 1; this.emit('open', {}); }, 0);
        }
        addEventListener(name, listener) {
          const values = this.listeners.get(name) || [];
          values.push(listener);
          this.listeners.set(name, values);
        }
        emit(name, event) { (this.listeners.get(name) || []).forEach(listener => listener(event)); }
        respond(message, delay = 0) { setTimeout(() => this.emit('message', { data: JSON.stringify(message) }), delay); }
        response(request, body = {}) {
          this.respond({ seq: 900 + request.seq, type: 'response', request_seq: request.seq, command: request.command, success: true, body });
        }
        send(encoded) {
          const message = JSON.parse(encoded);
          if (message.type === 'dap.start') {
            globalThis.__boboDapProbe.starts.push({ url: this.url, message });
            this.respond({
              type: 'dap.ready', sessionId: 'dap-ui-1',
              adapter: { id: 'python-debugpy', label: 'Python Debugger', languageId: 'python', runtimeId: 'python:3.11' },
              capabilities: { supportsLaunch: true }
            });
            return;
          }
          globalThis.__boboDapProbe.requests.push(message);
          if (message.command === 'initialize') {
            const capabilities = globalThis.__boboDapProbe.starts.length >= 3 ? {
              supportsConfigurationDoneRequest: false
            } : {
              supportsConfigurationDoneRequest: true,
              supportsRestartRequest: true,
              supportsConditionalBreakpoints: true,
              supportsHitConditionalBreakpoints: true,
              supportsLogPoints: true,
              supportsExceptionFilterOptions: true,
              exceptionBreakpointFilters: [
                {
                  filter: 'caught', label: 'Caught Exceptions', default: false, supportsCondition: true,
                  description: 'Break on caught exceptions', conditionDescription: 'Exception expression'
                },
                { filter: 'uncaught', label: 'Uncaught Exceptions', default: true, supportsCondition: false }
              ]
            };
            this.response(message, capabilities);
          } else if (message.command === 'launch') {
            this.response(message, {});
            // Exercise the renderer race where initialized follows the response immediately.
            this.respond({ seq: 40, type: 'event', event: 'initialized', body: {} });
          } else if (message.command === 'setBreakpoints') {
            globalThis.__boboDapProbe.breakpoints.push(message.arguments);
            const advanced = (message.arguments.breakpoints || []).some(item => item.condition || item.hitCondition || item.logMessage);
            const moveSimple = globalThis.__boboDapProbe.breakpoints.length === 1;
            const moveAdvanced = advanced && !globalThis.__boboDapProbe.advancedMoveApplied;
            this.response(message, {
              breakpoints: (message.arguments.breakpoints || []).map((item, index) => ({
                id: index + 1,
                verified: !moveAdvanced,
                message: moveAdvanced ? 'Condition is being validated' : '',
                line: item.line + (moveSimple || moveAdvanced ? 1 : 0),
                column: item.column ? item.column + (moveAdvanced ? 1 : 0) : undefined
              }))
            });
            if (moveAdvanced) globalThis.__boboDapProbe.advancedMoveApplied = true;
          } else if (message.command === 'setExceptionBreakpoints') {
            globalThis.__boboDapProbe.exceptionBreakpoints.push(message.arguments);
            this.response(message, {
              breakpoints: [...(message.arguments.filters || []), ...(message.arguments.filterOptions || [])]
                .map((_, index) => ({ id: 100 + index, verified: true }))
            });
          } else if (message.command === 'configurationDone') {
            this.response(message, {});
            this.respond({ seq: 41, type: 'event', event: 'output', body: { category: 'stdout', output: 'ready\n' } }, 5);
            this.respond({ seq: 42, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } }, 10);
          } else if (message.command === 'threads') {
            this.response(message, { threads: [{ id: 1, name: 'Main Thread' }] });
          } else if (message.command === 'stackTrace') {
            this.response(message, { stackFrames: [{ id: 11, name: 'main', line: 3, column: 1, source: { name: 'main.py', path: 'bobocloud-dap:///main.py' } }] });
          } else if (message.command === 'scopes') {
            this.response(message, { scopes: [{ name: 'Locals', variablesReference: 20, expensive: false }] });
          } else if (message.command === 'variables') {
            const nested = Number(message.arguments.variablesReference) === 21;
            this.response(message, { variables: Array.from({ length: nested ? 200 : 10000 }, (_, index) => ({
              name: index ? 'value' + index : 'value',
              value: String(index ? index : 7),
              type: 'int',
              variablesReference: !nested && index === 0 ? 21 : 0
            })) });
          } else if (message.command === 'evaluate') {
            this.response(message, { result: '7', type: 'int', variablesReference: 0 });
          } else if (message.command === 'continue') {
            this.response(message, { allThreadsContinued: true });
            this.respond({ seq: 43, type: 'event', event: 'continued', body: { threadId: 1, allThreadsContinued: true } });
          } else if (message.command === 'pause') {
            this.response(message, {});
            this.respond({ seq: 44, type: 'event', event: 'stopped', body: { reason: 'pause', threadId: 1 } });
          } else if (message.command === 'restart') {
            this.response(message, {});
          } else if (message.command === 'disconnect') {
            this.response(message, {});
            this.respond({ seq: 45, type: 'event', event: 'terminated', body: {} });
          } else {
            this.response(message, {});
          }
        }
        close() {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.emit('close', {});
        }
      };
    });

    const page = await app.firstWindow();
    const issues = [];
    page.on('pageerror', error => issues.push(error.message));
    page.on('console', message => { if (message.type() === 'error') issues.push(message.text()); });
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await page.setViewportSize({ width: 1180, height: 760 });
    await page.evaluate(async ({ workspacePath, filePath }) => {
      await window.api.writeServerSettings({ ip: 'cloud.test', user: 'root', pass: 'test', setupCompleted: true });
      window.BOBO.state.serverSettings = { ip: 'cloud.test', user: 'root', pass: 'test' };
      window.BOBO.state.serverCapabilities = window.BOBO.serverCapabilities.inspectServerInfo({ success: true, data: {} });
      window.BOBO.state.selectedRuntime = 'python:3.11';
      window.__boboDapCatalogCalls = 0;
      window.__boboDebugLifecycleTasks = [];
      window.__boboDebugLifecycleTaskRequests = [];
      window.BOBO.sendToServer = async action => action === 'getDAPInfo' ? (() => {
        window.__boboDapCatalogCalls += 1;
        return {
        success: true,
        data: {
          enabled: true,
          protocol: 'dap',
          transport: 'websocket',
          wsPath: '/dap',
          catalogVersion: '1.0',
          virtualRootUri: 'bobocloud-dap:///',
          adapters: [{
            id: 'python-debugpy', label: 'Python Debugger', languageId: 'python', runtimeId: 'python:3.11',
            available: true, supportsLaunch: true, supportsAttach: false
          }]
        }
        };
      })() : { success: false };
      window.BOBO.runner.ensureWorkspaceSyncedForRun = async () => true;
      window.BOBO.runner.startProjectTaskExecution = request => {
        window.__boboDebugLifecycleTasks.push(request.label);
        window.__boboDebugLifecycleTaskRequests.push(request);
        return {
          completion: Promise.resolve({ success: true, returnCode: 0, cancelled: false, code: 'completed', message: '', runId: request.label, label: request.label }),
          cancel: async () => true,
          getState: () => ({ state: 'completed', runId: request.label, cancelled: false })
        };
      };
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await window.BOBO.workspace.openFile(filePath, 'main.py');
      await window.BOBO.dap.refreshConfigurations();
    }, { workspacePath: workspace, filePath: sourceFile });

    await page.locator('#debug-config-button').click();
    await expect(page.locator('#debug-config-menu')).toBeVisible();
    const configBackground = await page.locator('#debug-config-menu').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(configBackground).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.locator('.debug-config-name')).toHaveText(['Current File', 'Debug project']);
    await expect(page.locator('.debug-config-item').first()).toBeEnabled();
    await page.locator('.debug-config-item', { hasText: 'Debug project' }).click();

    const editorBox = await page.locator('#container .monaco-editor').boundingBox();
    const linePosition = await page.evaluate(() => window.BOBO.state.editor.getScrolledVisiblePosition({ lineNumber: 2, column: 1 }));
    const unsupportedLinePosition = await page.evaluate(() => window.BOBO.state.editor.getScrolledVisiblePosition({ lineNumber: 3, column: 1 }));
    await page.mouse.click(editorBox.x + 8, editorBox.y + unsupportedLinePosition.top + 10, { button: 'right' });
    await expect(page.locator('.debug-breakpoint-menu-item')).toHaveText(['Add Breakpoint']);
    await page.keyboard.press('Escape');
    await page.mouse.click(editorBox.x + 8, editorBox.y + linePosition.top + 10);
    await expect(page.locator('.dap-breakpoint')).toHaveCount(1);
    expect(await page.evaluate(() => window.BOBO.dap.getBreakpoints())).toEqual([{ path: 'main.py', breakpoints: [{
      line: 2, enabled: true, verified: null, message: '', id: 0, condition: '', hitCondition: '', logMessage: ''
    }] }]);

    await page.locator('#debug-start').click();
    expect(await page.evaluate(() => window.BOBO.dap.start())).toBe(true);
    await expect(page.locator('#debug-toolbar')).toBeVisible();
    await expect(page.locator('#debug-toolbar-status')).toContainText('Paused');
    await expect(page.locator('#panel-debug')).toHaveClass(/active/);
    const debugPanelHeight = await page.locator('#bottom-panel').evaluate((element) => element.getBoundingClientRect().height);
    const debugConsoleHeight = await page.locator('#debug-console-output').evaluate((element) => element.getBoundingClientRect().height);
    expect(debugPanelHeight).toBeGreaterThanOrEqual(280);
    expect(debugConsoleHeight).toBeGreaterThanOrEqual(120);
    await page.setViewportSize({ width: 720, height: 480 });
    await expect(page.locator('.debug-inspector-tabs')).toBeVisible();
    await expect(page.locator('#debug-section-stack')).toBeVisible();
    await page.locator('#debug-inspector-tab-variables').click();
    await expect(page.locator('#debug-section-variables')).toBeVisible();
    await expect(page.locator('#debug-section-stack')).toBeHidden();
    await page.locator('#debug-inspector-tab-console').click();
    await expect(page.locator('#debug-section-console')).toBeVisible();
    const compactConsoleHeight = await page.locator('#debug-console-output').evaluate((element) => element.getBoundingClientRect().height);
    expect(compactConsoleHeight).toBeGreaterThanOrEqual(130);
    await page.screenshot({ path: evidencePath('cloud-dap-compact-inspector.png'), fullPage: false });
    await page.locator('#debug-inspector-tab-watch').focus();
    await page.locator('#debug-inspector-tab-watch').press('ArrowLeft');
    await expect(page.locator('#debug-inspector-tab-variables')).toBeFocused();
    await expect(page.locator('#debug-section-variables')).toBeVisible();
    await page.setViewportSize({ width: 1180, height: 760 });
    await expect(page.locator('#debug-call-stack')).toContainText('main');
    await expect(page.locator('#debug-variables')).toContainText('value');
    await expect(page.locator('#debug-variables')).toContainText('7');
    await expect(page.locator('#debug-variables .debug-variable-scope > div > .debug-tree-row')).toHaveCount(200);
    await expect(page.locator('.debug-variable-truncated')).toContainText('does not support paging');
    await expect(page.locator('#debug-variables .debug-load-more')).toHaveCount(0);
    const firstVariable = page.locator('#debug-variables .debug-variable-scope > div').first();
    await firstVariable.locator(':scope > button.debug-tree-row').click();
    const nestedVariables = firstVariable.locator(':scope > .debug-variable-children');
    await expect(nestedVariables.locator('.debug-load-more')).toHaveCount(1);
    await nestedVariables.locator('.debug-load-more').click();
    await expect(nestedVariables.locator(':scope > div > button.debug-tree-row')).toHaveCount(200);
    await expect(nestedVariables.locator('.debug-variable-truncated')).toHaveCount(1);
    await expect(nestedVariables.locator('.debug-load-more')).toHaveCount(0);
    await expect(page.locator('.dap-breakpoint')).toHaveCount(1);
    expect(await page.evaluate(() => window.BOBO.dap.getBreakpoints())).toEqual([{ path: 'main.py', breakpoints: [{
      line: 2, enabled: true, verified: true, message: '', id: 1, stale: false, actualLine: 3,
      condition: '', hitCondition: '', logMessage: ''
    }] }]);
    await expect(page.locator('#run-code')).toBeDisabled();

    const sourceBreakpointRow = page.locator('.debug-breakpoint-row[data-path="main.py"]');
    await expect(sourceBreakpointRow).toHaveCount(1);
    await expect(sourceBreakpointRow.locator('.debug-breakpoint-location')).toContainText('actual: main.py:3:1');
    await expect(page.locator('.debug-exception-breakpoint-row')).toHaveCount(2);
    await expect(page.locator('.debug-exception-breakpoint-row[data-filter="caught"] .debug-exception-enabled')).not.toBeChecked();
    await expect(page.locator('.debug-exception-breakpoint-row[data-filter="uncaught"] .debug-exception-enabled')).toBeChecked();
    expect(await app.evaluate(() => globalThis.__boboDapProbe.exceptionBreakpoints[0])).toEqual({
      filters: [], filterOptions: [{ filterId: 'uncaught' }]
    });

    await sourceBreakpointRow.locator('.debug-breakpoint-edit').click();
    await page.locator('.debug-breakpoint-column').fill('5');
    await page.locator('.debug-breakpoint-condition').fill('value > 3');
    await page.locator('.debug-breakpoint-hit-condition').fill('2');
    await page.locator('.debug-breakpoint-log-message').fill('  value={value}  ');
    await page.locator('.debug-breakpoint-editor button.primary').click();
    await expect.poll(() => app.evaluate(() => globalThis.__boboDapProbe.breakpoints.length)).toBeGreaterThanOrEqual(2);
    expect(await app.evaluate(() => globalThis.__boboDapProbe.breakpoints.at(-1).breakpoints[0])).toEqual({
      line: 2, column: 5, condition: 'value > 3', hitCondition: '2', logMessage: '  value={value}  '
    });
    await expect(page.locator('.dap-breakpoint-rejected.dap-breakpoint-conditional')).toHaveCount(1);
    expect(await page.evaluate(() => window.BOBO.dap.getBreakpoints()[0].breakpoints[0])).toMatchObject({
      line: 2, column: 5, actualLine: 3, actualColumn: 6,
      enabled: true, verified: false, message: 'Condition is being validated',
      condition: 'value > 3', hitCondition: '2', logMessage: '  value={value}  '
    });

    await sourceBreakpointRow.locator('.debug-breakpoint-enabled').uncheck();
    await expect.poll(() => app.evaluate(() => globalThis.__boboDapProbe.breakpoints.at(-1)?.breakpoints.length)).toBe(0);
    await expect(page.locator('.dap-breakpoint-disabled')).toHaveCount(1);
    expect(await page.evaluate(() => window.BOBO.dap.getBreakpoints()[0].breakpoints[0].enabled)).toBe(false);
    await sourceBreakpointRow.locator('.debug-breakpoint-enabled').check();
    await expect.poll(() => app.evaluate(() => globalThis.__boboDapProbe.breakpoints.at(-1)?.breakpoints[0]?.logMessage)).toBe('  value={value}  ');
    expect(await app.evaluate(() => globalThis.__boboDapProbe.breakpoints.at(-1).breakpoints[0])).toMatchObject({ line: 2, column: 5 });
    await expect(page.locator('.dap-logpoint.dap-breakpoint-conditional')).toHaveCount(1);

    await app.evaluate(() => globalThis.__boboDapSocket.emit('message', { data: JSON.stringify({
      seq: 46, type: 'event', event: 'breakpoint', body: {
        reason: 'changed',
        breakpoint: {
          id: 1, verified: false, message: 'Adapter moved the breakpoint', line: 4, column: 2,
          source: { name: 'main.py', path: 'bobocloud-dap:///main.py' }
        }
      }
    }) }));
    await expect.poll(() => page.evaluate(() => window.BOBO.dap.getBreakpoints()[0].breakpoints[0].actualLine)).toBe(4);
    expect(await page.evaluate(() => window.BOBO.dap.getBreakpoints()[0].breakpoints[0])).toMatchObject({
      line: 2, column: 5, actualLine: 4, actualColumn: 2,
      verified: false, message: 'Adapter moved the breakpoint'
    });
    await app.evaluate(() => globalThis.__boboDapSocket.emit('message', { data: JSON.stringify({
      seq: 47, type: 'event', event: 'breakpoint', body: {
        reason: 'changed',
        breakpoint: {
          id: 1, verified: true, line: 2, column: 5,
          source: { name: 'main.py', path: 'bobocloud-dap:///main.py' }
        }
      }
    }) }));
    await expect.poll(() => page.evaluate(() => window.BOBO.dap.getBreakpoints()[0].breakpoints[0].actualLine)).toBe(2);

    const caughtExceptionRow = page.locator('.debug-exception-breakpoint-row[data-filter="caught"]');
    await caughtExceptionRow.locator('.debug-breakpoint-edit').click();
    await page.locator('.debug-exception-condition').fill('error.name === "Expected"');
    await page.locator('.debug-breakpoint-editor button.primary').click();
    await expect.poll(() => app.evaluate(() => globalThis.__boboDapProbe.exceptionBreakpoints.length)).toBeGreaterThanOrEqual(2);
    expect(await app.evaluate(() => globalThis.__boboDapProbe.exceptionBreakpoints.at(-1))).toEqual({
      filters: [],
      filterOptions: [
        { filterId: 'caught', condition: 'error.name === "Expected"' },
        { filterId: 'uncaught' }
      ]
    });
    await page.locator('.debug-exception-breakpoint-row[data-filter="uncaught"] .debug-exception-enabled').uncheck();
    await expect.poll(() => app.evaluate(() => globalThis.__boboDapProbe.exceptionBreakpoints.at(-1)?.filters.length)).toBe(0);
    expect(await app.evaluate(() => globalThis.__boboDapProbe.exceptionBreakpoints.at(-1))).toEqual({
      filters: [],
      filterOptions: [{ filterId: 'caught', condition: 'error.name === "Expected"' }]
    });

    await sourceBreakpointRow.locator('.debug-breakpoint-remove').click();
    await expect(page.locator('.debug-breakpoint-row[data-path="main.py"]')).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => globalThis.__boboDapProbe.breakpoints.at(-1)?.breakpoints.length)).toBe(0);
    const replacementEditorBox = await page.locator('#container .monaco-editor').boundingBox();
    const replacementLinePosition = await page.evaluate(() => window.BOBO.state.editor.getScrolledVisiblePosition({ lineNumber: 2, column: 1 }));
    await page.mouse.click(replacementEditorBox.x + 8, replacementEditorBox.y + replacementLinePosition.top + 10, { button: 'right' });
    await expect(page.locator('.debug-breakpoint-menu')).toBeVisible();
    await expect(page.locator('.debug-breakpoint-menu-item')).toHaveText([
      'Add Breakpoint', 'Add Conditional Breakpoint', 'Add Logpoint'
    ]);
    await page.locator('.debug-breakpoint-menu-item', { hasText: 'Add Conditional Breakpoint' }).click();
    await page.locator('.debug-breakpoint-condition').fill('marker');
    await page.locator('.debug-breakpoint-editor button.primary').click();
    await expect(page.locator('.debug-breakpoint-row[data-path="main.py"]')).toHaveCount(1);
    await expect.poll(() => app.evaluate(() => globalThis.__boboDapProbe.breakpoints.at(-1)?.breakpoints[0]?.condition)).toBe('marker');
    expect(await page.evaluate(() => window.BOBO.dap.getBreakpoints()[0].breakpoints[0])).toMatchObject({
      line: 2, column: 1, enabled: true, condition: 'marker', verified: true
    });

    await page.locator('#debug-add-watch').click();
    await page.locator('.debug-watch-input input').fill('value');
    await page.locator('.debug-watch-input input').press('Enter');
    await expect(page.locator('#debug-watch-list')).toContainText('value');
    await expect(page.locator('#debug-watch-list')).toContainText('7');
    const breakpointRequestsBeforeEdit = await app.evaluate(() => globalThis.__boboDapProbe.breakpoints.length);
    await page.evaluate(() => window.BOBO.state.editor.executeEdits('dap-ui-test', [{
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: '# edited during debug\n',
      forceMoveMarkers: true
    }]));
    await expect(page.locator('.dap-breakpoint-unverified')).toHaveCount(1);
    await expect(page.locator('#debug-console-output')).toContainText('restart debugging');
    expect(await page.evaluate(() => window.BOBO.dap.getBreakpoints())).toEqual([{ path: 'main.py', breakpoints: [{
      line: 3, column: 1, enabled: true, verified: false,
      message: 'Source changed; restart debugging to apply updated breakpoints.', id: 1, stale: true,
      condition: 'marker', hitCondition: '', logMessage: '', actualLine: 3, actualColumn: 1
    }] }]);
    await page.waitForTimeout(250);
    expect(await app.evaluate(() => globalThis.__boboDapProbe.breakpoints.length)).toBe(breakpointRequestsBeforeEdit);
    await page.screenshot({ path: evidencePath('cloud-dap-paused-workbench.png'), fullPage: false });

    const consoleStatsBeforeBurst = await page.evaluate(() => window.BOBO.dap.getConsoleStats());
    await app.evaluate(() => {
      for (let index = 0; index < 500; index += 1) {
        globalThis.__boboDapSocket.emit('message', { data: JSON.stringify({
          seq: 1000 + index,
          type: 'event',
          event: 'output',
          body: { category: 'stdout', output: 'burst-' + index + '\n' }
        }) });
      }
    });
    await page.waitForTimeout(250);
    const consoleStatsAfterBurst = await page.evaluate(() => window.BOBO.dap.getConsoleStats());
    expect(consoleStatsAfterBurst.lines).toBeLessThanOrEqual(2000);
    expect(consoleStatsAfterBurst.lines).toBeGreaterThanOrEqual(500);
    expect(consoleStatsAfterBurst.renderPasses - consoleStatsBeforeBurst.renderPasses).toBeLessThanOrEqual(10);

    await page.locator('[data-debug-command="continue"]').click();
    await expect(page.locator('#debug-toolbar-status')).toContainText('running');
    await page.locator('[data-debug-command="pause"]').click();
    await expect(page.locator('#debug-toolbar-status')).toContainText('Paused');
    await page.locator('[data-debug-command="stop"]').click();
    await expect(page.locator('#debug-toolbar')).toBeHidden();
    await expect(page.locator('#run-code')).toBeEnabled();
    expect(await page.evaluate(() => window.__boboDebugLifecycleTasks)).toEqual(['Build before debug', 'Clean after debug']);
    expect(await page.evaluate(() => window.__boboDapCatalogCalls)).toBe(1);

    expect(await page.evaluate(() => window.BOBO.dap.start())).toBe(true);
    await app.evaluate(() => globalThis.__boboDapSocket.close());
    await expect(page.locator('#debug-toolbar')).toBeHidden();
    await page.waitForFunction(() => window.__boboDebugLifecycleTasks.length === 4);
    expect(await page.evaluate(() => window.__boboDebugLifecycleTasks)).toEqual([
      'Build before debug', 'Clean after debug', 'Build before debug', 'Clean after debug'
    ]);

    expect(await page.evaluate(async () => {
      if (!await window.BOBO.dap.start()) return false;
      const normalStop = window.BOBO.dap.stop('normal-stop');
      const identityAbort = window.BOBO.dap.abort('workspace-change');
      await Promise.all([normalStop, identityAbort]);
      return true;
    })).toBe(true);
    await expect(page.locator('#debug-toolbar')).toBeHidden();
    expect(await page.evaluate(() => window.__boboDebugLifecycleTasks)).toEqual([
      'Build before debug', 'Clean after debug',
      'Build before debug', 'Clean after debug',
      'Build before debug'
    ]);
    expect(await page.evaluate(() => window.__boboDapCatalogCalls)).toBe(1);
    expect(await page.evaluate(() => window.__boboDebugLifecycleTaskRequests.every(request =>
      Number.isInteger(request.context.columnNumber) && request.context.columnNumber >= 1
    ))).toBe(true);

    const probe = await app.evaluate(() => globalThis.__boboDapProbe);
    expect(probe.starts[0].url).toBe('ws://cloud.test:3100/dap');
    expect(probe.starts).toHaveLength(3);
    expect(probe.starts[0].message).toMatchObject({ type: 'dap.start', runtimeId: 'python:3.11', languageId: 'python' });
    const launchRequest = probe.requests.find(item => item.command === 'launch');
    expect(launchRequest.arguments).not.toHaveProperty('preLaunchTask');
    expect(launchRequest.arguments).not.toHaveProperty('postDebugTask');
    expect(probe.requests.map(item => item.command)).toEqual(expect.arrayContaining([
      'initialize', 'launch', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone', 'threads', 'stackTrace', 'scopes', 'variables', 'continue', 'pause', 'disconnect'
    ]));
    const firstSetBreakpoints = probe.requests.findIndex(item => item.command === 'setBreakpoints');
    const firstSetExceptions = probe.requests.findIndex(item => item.command === 'setExceptionBreakpoints');
    const firstConfigurationDone = probe.requests.findIndex(item => item.command === 'configurationDone');
    expect(firstSetBreakpoints).toBeGreaterThan(-1);
    expect(firstSetExceptions).toBeGreaterThan(firstSetBreakpoints);
    expect(firstConfigurationDone).toBeGreaterThan(firstSetExceptions);
    const initializeIndexes = probe.requests.reduce((indexes, item, index) => {
      if (item.command === 'initialize') indexes.push(index);
      return indexes;
    }, []);
    const thirdSessionRequests = probe.requests.slice(initializeIndexes[2]);
    const thirdSessionExceptions = thirdSessionRequests.find(item => item.command === 'setExceptionBreakpoints');
    expect(thirdSessionExceptions.arguments).toEqual({ filters: [] });
    expect(thirdSessionRequests.some(item => item.command === 'configurationDone')).toBe(false);
    expect(probe.breakpoints[0].source.path).toBe('bobocloud-dap:///main.py');
    const variablesRequest = probe.requests.find(item => item.command === 'variables');
    expect(variablesRequest.arguments).toMatchObject({ variablesReference: 20, start: 0, count: 200 });
    const pauseRequest = probe.requests.find(item => item.command === 'pause');
    expect(pauseRequest.arguments.threadId).toBe(1);
    expect(issues).toEqual([]);
  } finally {
    await closeFixture(fixture);
  }
});
