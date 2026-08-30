'use strict';

const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

async function launch(sandbox) {
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath(),
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'),
      BOBO_FORCE_FIRST_RUN: '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    })
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
  return { app, page };
}

async function stop(app) {
  try { await app.evaluate(({ app }) => app.exit(0)); } catch (_) {}
  await new Promise(resolve => setTimeout(resolve, 200));
}

test('run output separates program output from collapsible infrastructure details', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-run-output-ui-'));
  const collapsedShot = path.join(os.tmpdir(), 'bobocloud-run-output-compact.png');
  const expandedShot = path.join(os.tmpdir(), 'bobocloud-run-output-details.png');
  const rightDockShot = path.join(os.tmpdir(), 'bobocloud-run-output-right.png');
  const longCommand = '[run:python] [docker] sh -c project_root=$PWD; inherited_pythonpath=${PYTHONPATH:-}; package_root=/project-deps/python; export PYTHONPATH="$package_root:$project_root"; exec python3 "$@" python-runtime gd_descent_animation.py';
  let fixture;

  try {
    fixture = await launch(sandbox);
    const { app, page } = fixture;
    const consoleErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 620));
    await page.evaluate(command => {
      window.BOBO.switchToPanel('output');
      window.BOBO.clearRunOutput();
      window.BOBO.runOutput.begin({ target: 'gd_descent_animation.py', runtime: 'Python 3.10' });
      window.BOBO.runOutput.handleStatus({ type: 'status', stage: 'setup', message: '[setup] Using Docker runtime: Python 3.10' });
      window.BOBO.runOutput.handleStatus({ type: 'status', stage: 'cache', message: '[cache] Project dependency cache hit' });
      window.BOBO.runOutput.handleStatus({ type: 'status', stage: 'docker', message: '[docker] Container reused (team cache pool): 45f4d984b073' });
      window.BOBO.runOutput.handleStatus({ type: 'status', stage: 'run:python', message: command });
      window.BOBO.updateRunOutput('user output remains readable');
      window.BOBO.runOutput.finish({ success: false, returnCode: 137 });
    }, longCommand);

    const summary = page.locator('#run-summary');
    const details = page.locator('.run-output-detail');
    const commandDetail = page.locator('.run-output-detail[data-output-stage="run:python"]');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('data-state', 'failed');
    await expect(page.locator('#run-summary-title')).toHaveText('gd_descent_animation.py');
    await expect(page.locator('#run-summary-phase')).toContainText('forcibly terminated');
    await expect(page.locator('#run-summary-meta')).toContainText('Exit code 137');
    await expect(page.locator('#run-log')).toContainText('user output remains readable');
    await expect(details.first()).toBeHidden();
    await expect(page.locator('#run-log')).not.toContainText('PYTHONPATH');
    await expect(commandDetail).toHaveAttribute('title', longCommand);

    const compactGeometry = await page.evaluate(() => {
      const panel = document.getElementById('panel-output');
      const summary = document.getElementById('run-summary').getBoundingClientRect();
      const log = document.getElementById('run-log').getBoundingClientRect();
      return {
        panelOverflow: panel.scrollWidth - panel.clientWidth,
        summaryBottom: summary.bottom,
        logTop: log.top
      };
    });
    expect(compactGeometry.panelOverflow).toBeLessThanOrEqual(1);
    expect(compactGeometry.summaryBottom).toBeLessThanOrEqual(compactGeometry.logTop + 1);
    await page.screenshot({ path: collapsedShot });

    await page.locator('#run-details-toggle').click();
    await expect(page.locator('#run-details-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(details.first()).toBeVisible();
    await expect(commandDetail).toContainText('Program process started');
    await expect(commandDetail).toHaveAttribute('aria-label', longCommand);
    await expect(commandDetail).toHaveAttribute('tabindex', '0');
    await commandDetail.focus();
    await expect(commandDetail).toBeFocused();
    await page.screenshot({ path: expandedShot });

    await page.evaluate(() => {
      window.BOBO.workbench.setPanelPosition('right');
      document.getElementById('layout').style.setProperty('--workbench-right-panel-size', '280px');
    });
    await page.waitForTimeout(350);
    const rightDockGeometry = await page.evaluate(() => {
      const tabs = document.getElementById('panel-tabs');
      const panel = document.getElementById('bottom-panel');
      const output = document.getElementById('panel-output');
      const summaryRect = document.getElementById('run-summary').getBoundingClientRect();
      const logRect = document.getElementById('run-log').getBoundingClientRect();
      const actions = tabs.querySelector('.panel-actions');
      const panelRect = panel.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      return {
        panelWidth: panelRect.width,
        outputOverflow: output.scrollWidth - output.clientWidth,
        summaryBottom: summaryRect.bottom,
        logTop: logRect.top,
        tabsOverflow: tabs.scrollWidth - tabs.clientWidth,
        actionsLeft: actionsRect.left,
        actionsRight: actionsRect.right,
        panelLeft: panelRect.left,
        panelRight: panelRect.right
      };
    });
    expect(rightDockGeometry.panelWidth).toBeGreaterThanOrEqual(279);
    expect(rightDockGeometry.outputOverflow).toBeLessThanOrEqual(1);
    expect(rightDockGeometry.summaryBottom).toBeLessThanOrEqual(rightDockGeometry.logTop + 1);
    expect(rightDockGeometry.tabsOverflow).toBeLessThanOrEqual(1);
    expect(rightDockGeometry.actionsLeft).toBeGreaterThanOrEqual(rightDockGeometry.panelLeft - 1);
    expect(rightDockGeometry.actionsRight).toBeLessThanOrEqual(rightDockGeometry.panelRight + 1);
    await page.screenshot({ path: rightDockShot });

    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await expect(page.locator('#run-summary-phase')).toContainText('进程被强制终止');
    await expect(page.locator('#run-details-toggle')).toHaveAttribute('title', '隐藏运行详情');
    await expect(page.locator('#run-log')).toContainText('user output remains readable');
    await page.evaluate(() => {
      const row = document.getElementById('stdin-input-row');
      row.style.display = 'flex';
      document.getElementById('stdin-input').focus();
    });
    await expect(page.locator('#stdin-input-row')).toBeVisible();
    await expect(page.locator('#stdin-input')).toBeFocused();
    await page.evaluate(() => { document.getElementById('stdin-input-row').style.display = 'none'; });
    await page.locator('#panel-clear').click();
    await expect(summary).toBeHidden();
    await expect(page.locator('#run-log')).toHaveText('');
    expect(consoleErrors).toEqual([]);
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('stream fragments preserve long lines and carriage-return progress in the rendered output', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-run-fragments-ui-'));
  const screenshot = path.join(os.tmpdir(), 'bobocloud-run-output-fragments.png');
  let fixture;

  try {
    fixture = await launch(sandbox);
    const { app, page } = fixture;
    const consoleErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 620));
    await page.evaluate(() => {
      window.BOBO.switchToPanel('output');
      window.BOBO.clearRunOutput();
      window.BOBO.updateRunOutput('a'.repeat(4096), {
        streamFragment: true, streamKey: 'stdout:run'
      });
      window.BOBO.updateRunOutput('b'.repeat(4904), {
        streamFragment: true, streamKey: 'stdout:run', append: true
      });
      window.BOBO.updateRunOutput('', {
        streamFragment: true, streamKey: 'stdout:run', append: true, newline: true
      });
      window.BOBO.updateRunOutput('download 1%', {
        streamFragment: true, streamKey: 'stderr:setup', outputPrefix: '[stderr] '
      });
      window.BOBO.updateRunOutput('download 100%', {
        streamFragment: true, streamKey: 'stderr:setup', outputPrefix: '[stderr] ', replace: true, newline: true
      });
      window.BOBO.updateRunOutput('Traceback: File "src/ma', {
        streamFragment: true, streamKey: 'stderr:run', outputPrefix: '[stderr] '
      });
      window.BOBO.updateRunOutput('in.py", line 10', {
        streamFragment: true, streamKey: 'stderr:run', append: true, newline: true
      });
    });

    const lines = page.locator('#run-log .run-output-line');
    await expect(lines).toHaveCount(3);
    const longLine = await lines.nth(0).textContent();
    expect(longLine.replace(/^\[[^\]]+\] /, '').replace(/\n$/, '')).toBe('a'.repeat(4096) + 'b'.repeat(4904));
    await expect(lines.nth(1)).toContainText('[stderr] download 100%');
    await expect(lines.nth(1)).not.toContainText('download 1%');
    await expect(lines.nth(2).locator('.err-link')).toHaveAttribute('data-file', 'src/main.py');
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById('panel-output');
      const log = document.getElementById('run-log');
      return { panelOverflow: panel.scrollWidth - panel.clientWidth, lineCount: log.children.length };
    });
    expect(geometry.panelOverflow).toBeLessThanOrEqual(1);
    expect(geometry.lineCount).toBe(3);
    await page.screenshot({ path: screenshot });
    await page.locator('#panel-clear').click();
    await expect(page.locator('#run-log')).toHaveText('');
    expect(consoleErrors).toEqual([]);
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
