const { test, expect, _electron: electron } = require('playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

async function launch() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-account-profile-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath(),
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
    })
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
  return { app, page, sandbox };
}

async function close(fixture) {
  if (!fixture) return;
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('account center previews profile drafts and renders a stable 53 week activity heatmap', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launch();
    const { page } = fixture;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.evaluate(() => {
      const today = new Date();
      const iso = offset => {
        const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
        return date.toISOString().slice(0, 10);
      };
      window.BOBO.state.auth.mode = 'multi';
      window.BOBO.state.auth.token = 'test-token';
      window.BOBO.state.auth.user = {
        id: 'user-1', uid: 'u_profile_fixture', username: 'compiler',
        email: 'compiler@example.com', name: 'Cloud Builder', role: 'member',
        avatar: 'forest', created_at: '2025-02-03T08:00:00Z'
      };
      window.BOBO.sendToServer = async (action, data) => {
        if (action === 'getCompileActivity') return { success: true, data: { timezone: 'UTC', days: [
          { date: iso(0), count: 9 }, { date: iso(-1), count: 4 }, { date: iso(-29), count: 2 }, { date: iso(-45), count: 1 }
        ] } };
        if (action === 'updateProfile') return { success: false, error: 'Mock save failure' };
        return { success: true };
      };
      window.BOBO.accountProfile.open('profile');
    });

    await expect(page.locator('#profile-modal')).toBeVisible();
    await expect(page.locator('#account-summary-name')).toHaveText('Cloud Builder');
    await expect(page.locator('#account-info-email')).toHaveText('compiler@example.com');
    await page.locator('#profile-name').fill('Unsaved Builder');
    await page.locator('[data-avatar="coral"]').click();
    await expect(page.locator('#account-summary-name')).toHaveText('Unsaved Builder');
    await expect(page.locator('#account-summary-avatar')).toHaveClass(/avatar-coral/);

    await page.locator('[data-account-tab="activity"]').click();
    await expect(page.locator('.account-heatmap-cell')).toHaveCount(371);
    await expect(page.locator('#account-activity-today')).toHaveText('9');
    await expect(page.locator('#account-activity-month')).toHaveText('15');
    await expect(page.locator('#account-activity-days')).toHaveText('4');
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector('.account-profile-shell').getBoundingClientRect();
      const header = document.querySelector('.account-profile-head').getBoundingClientRect();
      const footer = document.querySelector('.account-profile-foot').getBoundingClientRect();
      const pane = document.querySelector('[data-account-pane="activity"]').getBoundingClientRect();
      return {
        shellInside: shell.left >= 0 && shell.top >= 0 && shell.right <= innerWidth + 1 && shell.bottom <= innerHeight + 1,
        fixedFrame: Math.round(header.height) === 64 && Math.round(footer.height) === 58,
        paneInside: pane.top >= header.bottom - 1 && pane.bottom <= footer.top + 1,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    });
    expect(geometry).toEqual({ shellInside: true, fixedFrame: true, paneInside: true, pageOverflow: false });

    await page.locator('[data-account-tab="profile"]').click();
    await expect(page.locator('#profile-name')).toHaveValue('Unsaved Builder');
    await page.locator('#profile-save').click();
    await expect(page.locator('#profile-save-status')).toHaveText('Mock save failure');
    await expect(page.locator('#profile-modal')).toBeVisible();
    await expect(page.locator('#profile-name')).toHaveValue('Unsaved Builder');
    await expect(page.locator('#account-summary-avatar')).toHaveClass(/avatar-coral/);

    fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
    await page.locator('[data-account-tab="activity"]').click();
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'account-profile-ui.png') });
    await page.setViewportSize({ width: 760, height: 620 });
    const compactGeometry = await page.evaluate(() => {
      const shell = document.querySelector('.account-profile-shell').getBoundingClientRect();
      const footer = document.querySelector('.account-profile-foot').getBoundingClientRect();
      const cancel = document.querySelector('#profile-cancel').getBoundingClientRect();
      const heatmap = document.querySelector('.account-heatmap-scroll');
      return {
        shellInside: shell.left >= 0 && shell.top >= 0 && shell.right <= innerWidth + 1 && shell.bottom <= innerHeight + 1,
        footerInside: footer.bottom <= shell.bottom + 1 && cancel.right <= footer.right + 1,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        heatmapOwnsOverflow: heatmap.scrollWidth > heatmap.clientWidth
      };
    });
    expect(compactGeometry).toEqual({ shellInside: true, footerInside: true, pageOverflow: false, heatmapOwnsOverflow: true });
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'account-profile-ui-compact.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirm-dialog')).toHaveClass(/open/);
    await page.locator('#confirm-dialog .confirm-btn-ghost').click();
    await expect(page.locator('#profile-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirm-dialog')).toHaveClass(/open/);
    await page.locator('#confirm-dialog .confirm-btn-danger').click();
    await expect(page.locator('#profile-modal')).toBeHidden();

    await page.evaluate(() => {
      window.__accountActivityRequests = [];
      window.BOBO.sendToServer = (action) => {
        if (action !== 'getCompileActivity') return Promise.resolve({ success: true });
        return new Promise(resolve => window.__accountActivityRequests.push(resolve));
      };
      window.BOBO.accountProfile.open('activity');
    });
    await page.waitForFunction(() => window.__accountActivityRequests.length === 1);
    await page.evaluate(() => {
      window.BOBO.state.auth.token = 'second-token';
      window.BOBO.state.auth.user = {
        id: 'user-2', uid: 'u_second_fixture', username: 'second',
        email: 'second@example.com', name: 'Second Builder', role: 'member',
        avatar: 'ocean', created_at: '2026-01-03T08:00:00Z'
      };
      window.BOBO.accountProfile.open('activity');
    });
    await page.waitForFunction(() => window.__accountActivityRequests.length === 2);
    await expect(page.locator('#account-summary-name')).toHaveText('Second Builder');
    await expect(page.locator('#account-activity-today')).toHaveText('0');
    await page.evaluate(() => {
      const today = new Date().toISOString().slice(0, 10);
      window.__accountActivityRequests[1]({ success: true, data: { timezone: 'UTC', days: [{ date: today, count: 3 }] } });
    });
    await expect(page.locator('#account-activity-today')).toHaveText('3');
    await page.evaluate(() => {
      const today = new Date().toISOString().slice(0, 10);
      window.__accountActivityRequests[0]({ success: true, data: { timezone: 'UTC', days: [{ date: today, count: 99 }] } });
    });
    await page.waitForTimeout(100);
    await expect(page.locator('#account-activity-today')).toHaveText('3');

    await page.evaluate(() => {
      window.__accountProfileSaves = [];
      window.BOBO.sendToServer = (action) => {
        if (action === 'getCompileActivity') return Promise.resolve({ success: true, data: { timezone: 'UTC', days: [] } });
        if (action === 'updateProfile') return new Promise(resolve => window.__accountProfileSaves.push(resolve));
        return Promise.resolve({ success: true });
      };
      window.BOBO.accountProfile.open('profile');
    });
    await page.locator('#profile-name').fill('Second Pending');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => window.__accountProfileSaves.length === 1);
    await page.evaluate(() => {
      window.BOBO.state.auth.token = 'third-token';
      window.BOBO.state.auth.user = {
        id: 'user-3', uid: 'u_third_fixture', username: 'third',
        email: 'third@example.com', name: 'Third Builder', role: 'member',
        avatar: 'violet', created_at: '2026-04-03T08:00:00Z'
      };
      window.BOBO.accountProfile.open('profile');
    });
    await expect(page.locator('#account-summary-name')).toHaveText('Third Builder');
    await expect(page.locator('#profile-save')).toBeEnabled();
    await page.evaluate(() => {
      window.__accountProfileSaves[0]({
        success: true,
        user: {
          id: 'user-2', uid: 'u_second_fixture', username: 'second',
          email: 'second@example.com', name: 'Second Pending', role: 'member',
          avatar: 'ocean', created_at: '2026-01-03T08:00:00Z'
        }
      });
    });
    await page.waitForTimeout(100);
    await expect(page.locator('#account-summary-name')).toHaveText('Third Builder');
    await expect(page.locator('#profile-save')).toBeEnabled();
    expect(await page.evaluate(() => ({
      id: window.BOBO.state.auth.user.id,
      token: window.BOBO.state.auth.token
    }))).toEqual({ id: 'user-3', token: 'third-token' });

    await page.locator('#profile-name').fill('Third Pending');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => window.__accountProfileSaves.length === 2);
    await expect(page.locator('#profile-close-x')).toBeDisabled();
    await expect(page.locator('#profile-cancel')).toBeDisabled();
    await page.locator('#profile-name').fill('Third Newer Draft');
    await page.keyboard.press('Escape');
    await expect(page.locator('#profile-modal')).toBeVisible();
    await page.evaluate(() => {
      window.__accountProfileSaves[1]({
        success: true,
        user: Object.assign({}, window.BOBO.state.auth.user, { name: 'Third Pending' })
      });
    });
    await expect(page.locator('#profile-save')).toBeEnabled();
    await expect(page.locator('#profile-name')).toHaveValue('Third Newer Draft');
    await expect(page.locator('#account-summary-name')).toHaveText('Third Newer Draft');
    await expect(page.locator('#profile-save-status')).toHaveText('Unsaved changes');
    expect(await page.evaluate(() => ({
      persistedName: window.BOBO.state.auth.user.name,
      dirty: window.BOBO.accountProfile && document.querySelector('#profile-name').value !== window.BOBO.state.auth.user.name
    }))).toEqual({ persistedName: 'Third Pending', dirty: true });

    await page.evaluate(() => {
      window.__NativeProfileImage = window.Image;
      window.Image = class DeferredProfileImage {
        constructor() { this.naturalWidth = 1; this.naturalHeight = 1; }
        set src(value) { this._src = value; window.__deferredProfileImage = this; }
      };
    });
    await page.locator('#profile-avatar-file').setInputFiles({
      name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex')
    });
    await page.waitForFunction(() => Boolean(window.__deferredProfileImage));
    await page.evaluate(() => {
      window.BOBO.state.auth.token = 'fourth-token';
      window.BOBO.state.auth.user = {
        id: 'user-4', uid: 'u_fourth_fixture', username: 'fourth',
        email: 'fourth@example.com', name: 'Fourth Builder', role: 'member',
        avatar: 'amber', created_at: '2026-06-03T08:00:00Z'
      };
      window.BOBO.accountProfile.open('profile');
      window.__deferredProfileImage.onload();
      window.Image = window.__NativeProfileImage;
    });
    await expect(page.locator('#account-summary-name')).toHaveText('Fourth Builder');
    await expect(page.locator('#account-summary-avatar')).toHaveClass(/avatar-amber/);
    expect(errors).toEqual([]);
  } finally {
    await close(fixture);
  }
});
