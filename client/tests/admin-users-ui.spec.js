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
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-admin-users-'));
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

test('admin users opens on the users pane and keeps password and quota actions compact', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launch();
    const { page } = fixture;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(() => {
      window.__adminRequests = [];
      window.BOBO.state.auth.mode = 'multi';
      window.BOBO.state.auth.token = 'root-token';
      window.BOBO.state.auth.user = { id: 'root', username: 'root', email: 'root@example.com', role: 'root' };
      const users = [
        { id: 'root', username: 'root', email: 'root@example.com', role: 'root', container_limit: 10, rate_limit: 300, disk_quota_mb: 0, created_at: '2026-01-01T00:00:00Z' },
        { id: 'member-1', username: 'compiler', email: 'compiler@example.com', role: 'member', container_limit: 2, rate_limit: 60, disk_quota_mb: 2048, created_at: '2026-02-01T00:00:00Z' }
      ];
      window.BOBO.sendToServer = async (action, data) => {
        window.__adminRequests.push({ action, data: Object.assign({}, data) });
        if (action === 'listUsers') return { success: true, users };
        if (action === 'resetUserPassword') return { success: true, newPassword: data.newPassword || 'Generated123!' };
        return { success: true };
      };
      window.BOBO.auth.renderChip();
      document.querySelector('#auth-menu-admin').click();
    });

    await expect(page.locator('#admin-modal')).toBeVisible();
    await expect(page.locator('#admin-pane-users')).toHaveClass(/active/);
    await expect(page.locator('#admin-pane-users tbody tr')).toHaveCount(2);
    const geometry = await page.evaluate(() => {
      const card = document.querySelector('.admin-card').getBoundingClientRect();
      const table = document.querySelector('#admin-pane-users .admin-table').getBoundingClientRect();
      return {
        cardInside: card.left >= 0 && card.right <= innerWidth + 1,
        compact: card.width <= 790,
        tableInside: table.right <= card.right + 1,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    });
    expect(geometry).toEqual({ cardInside: true, compact: true, tableInside: true, pageOverflow: false });

    const rootActions = page.locator('.admin-row-actions[data-uid="root"]');
    await rootActions.locator('.admin-actions-trigger').click();
    await expect(rootActions.locator('[data-act="password"]')).toHaveCount(0);
    await rootActions.locator('[data-act="change-password"]').click();
    await expect(page.locator('#admin-modal')).not.toBeVisible();
    await expect(page.locator('#chpwd-modal')).toBeVisible();
    await page.locator('#chpwd-cancel').click();
    await page.evaluate(() => document.querySelector('#auth-menu-admin').click());

    const memberActions = page.locator('.admin-row-actions[data-uid="member-1"]');
    await memberActions.locator('.admin-actions-trigger').click();
    await expect(memberActions.locator('.admin-action-menu')).toBeVisible();
    await memberActions.locator('[data-act="password"]').click();
    await expect(page.locator('.admin-dialog-note')).toContainText('secure hash');
    await page.locator('#admin-password-input').fill('Changed123!');
    await page.locator('.admin-password-save').click();
    await expect(page.locator('#admin-pane-users .admin-new-invite code')).toHaveText('************');
    await page.locator('#admin-pane-users .admin-secret-reveal').click();
    await expect(page.locator('#admin-pane-users .admin-new-invite code')).toHaveText('Changed123!');

    await page.locator('.admin-row-actions[data-uid="member-1"] .admin-actions-trigger').click();
    await page.locator('.admin-row-actions[data-uid="member-1"] [data-act="password"]').click();
    await page.evaluate(() => {
      window.__passwordResetPending = true;
      const original = window.BOBO.sendToServer;
      window.BOBO.sendToServer = async (action, data, options) => {
        if (action !== 'resetUserPassword' || !window.__passwordResetPending) return original(action, data, options);
        window.__passwordResetPending = false;
        window.__adminRequests.push({ action, data: Object.assign({}, data) });
        return new Promise(resolve => { window.__resolvePasswordReset = resolve; });
      };
    });
    await page.locator('.admin-password-generate').click();
    await page.evaluate(() => {
      document.querySelector('#admin-password-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => window.__adminRequests.filter(request => request.action === 'resetUserPassword').length)).toBe(2);
    await page.evaluate(() => window.__resolvePasswordReset({ success: true, newPassword: 'Generated123!' }));
    await expect(page.locator('#admin-pane-users .admin-new-invite code')).toHaveText('************');

    await page.locator('.admin-row-actions[data-uid="member-1"] .admin-actions-trigger').click();
    await page.locator('.admin-row-actions[data-uid="member-1"] [data-act="quota"]').click();
    await page.locator('[data-field="containers"]').fill('4');
    await page.locator('[data-field="rate"]').fill('120');
    await page.locator('[data-field="disk"]').fill('4096');
    await page.locator('.admin-quota-save').click();
    await expect(page.locator('.admin-dialog-overlay')).toHaveCount(0);
    const requests = await page.evaluate(() => window.__adminRequests);
    expect(requests).toContainEqual({ action: 'resetUserPassword', data: { userId: 'member-1', newPassword: 'Changed123!' } });
    expect(requests).toContainEqual({ action: 'updateUserQuota', data: { userId: 'member-1', containerLimit: 4, rateLimit: 120, diskQuotaMB: 4096 } });

    await page.locator('.admin-tab[data-pane="invites"]').click();
    await page.locator('#admin-close-x').click();
    await page.evaluate(() => document.querySelector('#auth-menu-admin').click());
    await expect(page.locator('#admin-pane-users')).toHaveClass(/active/);
    await expect(page.locator('#admin-pane-invites')).not.toHaveClass(/active/);
    await expect(page.locator('#admin-pane-users tbody tr')).toHaveCount(2);

    await page.setViewportSize({ width: 760, height: 520 });
    const japaneseAccount = await page.evaluate(async () => {
      await window.BOBO.i18n.setLocale('ja');
      return window.BOBO.i18n.t('Account');
    });
    await expect(page.locator('#admin-pane-users th').first()).toHaveText(japaneseAccount);
    await expect.poll(() => page.evaluate(() => {
      const card = document.querySelector('.admin-card');
      const body = document.querySelector('.admin-body');
      return card.scrollWidth <= card.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1 &&
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
    })).toBe(true);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(() => window.BOBO.i18n.setLocale('en'));

    fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'admin-users-ui.png') });
    expect(errors).toEqual([]);
  } finally {
    await close(fixture);
  }
});
