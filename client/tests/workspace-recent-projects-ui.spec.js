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
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const app = await electron.launch({
    executablePath: electronExecutablePath(),
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      BOBO_FORCE_FIRST_RUN: '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
    })
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
  return { app, page };
}

async function closeFixture(app) {
  if (!app) return;
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
  await new Promise(resolve => setTimeout(resolve, 300));
}

test('empty state keeps five recent projects and supports open, remove, localization, and compact layout', async () => {
  test.setTimeout(90000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-recent-projects-'));
  const longParent = path.join(sandbox, 'client-workspaces', 'department-platform-engineering', 'quarterly-deliverables', 'cloud-compiler-products');
  const projects = Array.from({ length: 6 }, (_, index) => path.join(longParent, `project-${index + 1}`));
  projects.forEach((project, index) => {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'main.txt'), `project ${index + 1}\n`, 'utf8');
  });
  const evidenceDirectory = process.env.BOBO_UI_EVIDENCE_DIR || os.tmpdir();
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const desktopScreenshot = path.join(evidenceDirectory, 'recent-projects-desktop.png');
  const compactScreenshot = path.join(evidenceDirectory, 'recent-projects-compact-zh.png');
  const errors = [];
  let fixture;
  try {
    fixture = await launchFixture(sandbox);
    const { page } = fixture;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 1200, height: 800 });

    expect(page.url()).toMatch(/^file:.*\/index\.html$/i);
    await expect(page).toHaveTitle('BOBOCLOUD Editor');
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#empty-state-open')).toBeVisible();
    await expect(page.locator('#recent-projects')).toBeHidden();
    await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay, nextjs-portal')).toHaveCount(0);

    await page.evaluate(async recentPaths => {
      window.BOBO.runner.syncWithServer = function() {};
      for (const recentPath of recentPaths) {
        if (!(await window.BOBO.workspaceLaunch.requestOpen(recentPath))) throw new Error('Recent project fixture did not open');
        if (!(await window.BOBO.workspace.closeWorkspace({ approved: true }))) throw new Error('Recent project fixture did not close');
      }
    }, projects);

    const section = page.locator('#recent-projects');
    const rows = page.locator('.recent-project-row');
    await expect(section).toBeVisible();
    await expect(page.locator('#recent-projects-title')).toHaveText('Recent projects');
    await expect(rows).toHaveCount(5);
    await expect(rows.first().locator('.recent-project-name')).toHaveText('project-6');
    await expect(rows.last().locator('.recent-project-name')).toHaveText('project-2');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bobocloud.recentProjects.v1')))).toEqual(projects.slice(1).reverse());

    const surface = await section.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderTopWidth };
    });
    expect(surface).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px' });

    const longPath = rows.first().locator('.recent-project-path');
    await expect(longPath).toHaveText(/^\.\.\..*project-6$/);
    expect((await longPath.textContent()).length).toBeLessThanOrEqual(44);

    const scrollLayout = await page.evaluate(() => {
      const emptyState = document.querySelector('#empty-state');
      const list = document.querySelector('#recent-project-list');
      const icon = document.querySelector('.empty-state-icon');
      const openButton = document.querySelector('#empty-state-open');
      const firstRow = document.querySelector('.recent-project-row');
      return {
        emptyOverflowY: getComputedStyle(emptyState).overflowY,
        listOverflowY: getComputedStyle(list).overflowY,
        listClientHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        rowHeight: firstRow.getBoundingClientRect().height,
        iconTop: icon.getBoundingClientRect().top,
        buttonTop: openButton.getBoundingClientRect().top
      };
    });
    expect(scrollLayout.emptyOverflowY).toBe('hidden');
    expect(scrollLayout.listOverflowY).toBe('auto');
    expect(scrollLayout.listScrollHeight).toBeGreaterThan(scrollLayout.listClientHeight);
    expect(scrollLayout.rowHeight).toBeLessThanOrEqual(36.5);

    const recentList = page.locator('#recent-project-list');
    await recentList.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => recentList.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const afterListScroll = await page.evaluate(() => ({
      emptyScrollTop: document.querySelector('#empty-state').scrollTop,
      iconTop: document.querySelector('.empty-state-icon').getBoundingClientRect().top,
      buttonTop: document.querySelector('#empty-state-open').getBoundingClientRect().top
    }));
    expect(afterListScroll.emptyScrollTop).toBe(0);
    expect(afterListScroll.iconTop).toBeCloseTo(scrollLayout.iconTop, 1);
    expect(afterListScroll.buttonTop).toBeCloseTo(scrollLayout.buttonTop, 1);
    await recentList.evaluate(element => { element.scrollTop = 0; });

    const firstRemove = rows.first().locator('.recent-project-remove');
    await rows.first().locator('.recent-project-name').hover();
    await expect.poll(() => firstRemove.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.95);
    await firstRemove.hover();
    await page.waitForTimeout(150);
    await expect(firstRemove).toHaveCSS('opacity', '1');
    await expect(firstRemove).toHaveAttribute('aria-label', 'Remove project-6 from recent projects');
    await page.screenshot({ path: desktopScreenshot, fullPage: false });
    await firstRemove.click();
    await expect(rows).toHaveCount(4);
    await expect(rows.first().locator('.recent-project-name')).toHaveText('project-5');

    const directOpenPath = projects[1];
    await rows.last().locator('.recent-project-open').click();
    await expect.poll(() => page.evaluate(() => window.BOBO.state.workspaceRoot)).toBe(directOpenPath);
    await expect(section).toBeHidden();
    await page.evaluate(() => window.BOBO.workspace.closeWorkspace({ approved: true }));
    await expect(section).toBeVisible();
    await expect(rows.first().locator('.recent-project-name')).toHaveText('project-2');

    await page.evaluate(() => window.BOBO.i18n.setLocale('ja'));
    await expect(page.locator('#recent-projects-title')).toHaveText('最近のプロジェクト');
    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await expect(page.locator('#recent-projects-title')).toHaveText('最近项目');
    await rows.first().hover();
    await expect(rows.first().locator('.recent-project-remove')).toHaveAttribute('aria-label', '从最近项目中移除 project-2');

    await page.setViewportSize({ width: 650, height: 640 });
    await recentList.evaluate(element => { element.scrollTop = 0; });
    const compact = await page.locator('#editor').evaluate(element => {
      const emptyState = document.querySelector('#empty-state');
      const list = document.querySelector('#recent-project-list');
      const icon = document.querySelector('.empty-state-icon');
      const openButton = document.querySelector('#empty-state-open');
      return {
        fits: element.scrollWidth <= element.clientWidth + 1,
        columns: getComputedStyle(document.querySelector('.recent-project-open')).gridTemplateColumns,
        emptyOverflowY: getComputedStyle(emptyState).overflowY,
        emptyScrollTop: emptyState.scrollTop,
        listOverflowY: getComputedStyle(list).overflowY,
        listClientHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        iconVisible: icon.getBoundingClientRect().height > 0,
        buttonVisible: openButton.getBoundingClientRect().height > 0,
        iconTop: icon.getBoundingClientRect().top,
        buttonTop: openButton.getBoundingClientRect().top
      };
    });
    expect(compact.fits).toBe(true);
    expect(compact.columns.split(' ').length).toBe(2);
    expect(compact.emptyOverflowY).toBe('hidden');
    expect(compact.emptyScrollTop).toBe(0);
    expect(compact.listOverflowY).toBe('auto');
    expect(compact.listScrollHeight).toBeGreaterThan(compact.listClientHeight);
    expect(compact.iconVisible).toBe(true);
    expect(compact.buttonVisible).toBe(true);

    await recentList.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => recentList.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const compactAfterScroll = await page.evaluate(() => ({
      emptyScrollTop: document.querySelector('#empty-state').scrollTop,
      iconTop: document.querySelector('.empty-state-icon').getBoundingClientRect().top,
      buttonTop: document.querySelector('#empty-state-open').getBoundingClientRect().top
    }));
    expect(compactAfterScroll.emptyScrollTop).toBe(0);
    expect(compactAfterScroll.iconTop).toBeCloseTo(compact.iconTop, 1);
    expect(compactAfterScroll.buttonTop).toBeCloseTo(compact.buttonTop, 1);
    await page.screenshot({ path: compactScreenshot, fullPage: false });

    expect(errors).toEqual([]);
  } finally {
    if (fixture) await closeFixture(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
