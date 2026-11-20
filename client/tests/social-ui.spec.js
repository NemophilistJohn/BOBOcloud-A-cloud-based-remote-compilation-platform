const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('friends menus preserve cancelled confirmations and inbox handles notes and project destinations', async ({}, testInfo) => {
  test.setTimeout(90000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-social-ui-'));
  let app;
  try {
    app = await electron.launch({
      executablePath: require('electron'), args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: { ...process.env, APPDATA: sandbox, USERPROFILE: sandbox, HOME: sandbox, XDG_CONFIG_HOME: sandbox }
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 25000 });
    await page.setViewportSize({ width: 1180, height: 800 });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('inbox:download-project');
      ipcMain.handle('inbox:download-project', () => ({ archived: true }));
    });
    await page.evaluate(() => {
      const b = window.BOBO;
      b.state.auth.user = { id: 'me', uid: 'uid-me', username: 'Me' };
      b.state.auth.token = 'fixture-session';
      b.state.auth.mode = 'multi';
      window.__profileOpens = 0;
      b.accountProfile.open = () => { window.__profileOpens++; };
      const sender = { uid: 'uid-other', name: 'Other', avatar: 'forest' };
      const now = new Date().toISOString();
      const inbox = [
        { id: 'project-1', sender, kind: 'project', title: 'Python project', status: 'pending', createdAt: now, bytes: 1234 },
        { id: 'note-1', sender, kind: 'note', title: '', note: '<script>safe message</script>', status: 'pending', createdAt: now }
      ];
      window.__socialCalls = [];
      b.sendToServer = async (action, payload) => {
        window.__socialCalls.push({ action, payload });
        if (action === 'listFriends') return { success: true, data: [sender] };
        if (action === 'listInbox') return { success: true, data: {
          pending: inbox.filter(m => m.status === 'pending'), archived: inbox.filter(m => m.status !== 'pending'),
          unread: inbox.filter(m => m.status === 'pending' && !m.read).length
        } };
        if (action === 'listTeams') return { success: true, data: [
          { id: 'admin-team', name: 'Admin team', is_admin: true },
          { id: 'member-team', name: 'Member team', is_admin: false }
        ] };
        if (action === 'listProjects') return { success: true, storageInfo: { projects: [{ key: 'p1', name: 'Python project' }] } };
        if (action === 'respondInbox') {
          const item = inbox.find(m => m.id === payload.messageId);
          item.read = true;
          if (payload.decision !== 'read' || item.kind === 'note') item.status = payload.decision === 'read' ? 'read' : 'accepted';
          return { success: true, data: {} };
        }
        return { success: true, data: {} };
      };
      window.dispatchEvent(new Event('bobo:auth-changed'));
    });
    await page.locator('#activity-team').click();
    await expect(page.locator('.social-person')).toContainText('uid-other');
    await expect(page.locator('.social-unread')).toHaveText('2');
    await page.locator('[data-social="profile"]').click();
    expect(await page.evaluate(() => window.__profileOpens)).toBe(1);
    await page.locator('.social-friend-menu').hover();
    await page.locator('[data-sub="project"]').hover();
    await page.locator('[data-offer="p1"]').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog .confirm-btn-ghost').click();
    await expect(page.locator('.social-menu')).toBeVisible();
    await expect(page.locator('[data-offer="p1"]')).toBeVisible();
    expect(await page.evaluate(() => window.__socialCalls.filter(c => c.action === 'sendInbox').length)).toBe(0);
    await expect(page.locator('[data-offer="p1"]')).toBeEnabled();
    // A dialog temporarily moves the pointer outside both menu levels. Its
    // dismissal must not leave an old hover-close deadline armed.
    await page.waitForTimeout(650);
    await expect(page.locator('[data-offer="p1"]')).toBeVisible();
    await page.locator('[data-offer="p1"]').click();
    await page.locator('#confirm-dialog .confirm-btn:not(.confirm-btn-ghost)').click();
    await expect(page.locator('[data-offer="p1"]')).toBeDisabled();
    await expect(page.locator('[data-offer="p1"]')).toHaveText('Sent');
    await page.waitForTimeout(650);
    await expect(page.locator('.social-menu')).toBeVisible();
    await page.locator('[data-sub="invite"]').hover();
    await expect(page.locator('[data-offer="admin-team"]')).toBeVisible();
    await expect(page.locator('[data-offer="member-team"]')).toHaveCount(0);
    await page.locator('[data-sub="note"]').hover();
    await page.locator('#social-note').fill('A short note');
    await page.locator('[data-send-note]').click();
    await expect(page.locator('#social-note')).toHaveValue('');
    expect(await page.evaluate(() => window.__socialCalls.filter(c => c.action === 'sendInbox').length)).toBe(2);
    await page.keyboard.press('Escape');
    await page.locator('[data-social="inbox"]').click();
    await page.locator('[data-message="note-1"]').click();
    await expect(page.locator('.social-note-body')).toHaveText('<script>safe message</script>');
    await expect(page.locator('.social-note-body script')).toHaveCount(0);
    await expect(page.locator('.social-unread')).toHaveText('1');
    await page.locator('[data-message="project-1"]').click();
    await expect(page.locator('.social-unread')).toHaveCount(0);
    await expect(page.locator('[data-message="project-1"]')).toBeVisible();
    await expect(page.locator('[data-decision="cloud"]')).toBeVisible();
    await expect(page.locator('[data-decision="local"]')).toBeVisible();
    await page.locator('[data-decision="cloud"]').click();
    await expect(page.locator('.social-unread')).toHaveCount(0);
    await page.locator('[data-inbox-tab="archive"]').click();
    await expect(page.locator('.social-message-row')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('social-inbox.png') });
    await page.locator('[data-close]').click();
    await page.evaluate(() => {
      window.BOBO.state.auth.user = null;
      window.BOBO.state.auth.token = '';
      window.dispatchEvent(new Event('bobo:auth-changed'));
    });
    await expect(page.locator('.social-person')).toHaveCount(0);
    await expect(page.locator('.social-overlay')).toBeHidden();
  } finally {
    try { if (app) await app.evaluate(({ app }) => app.exit(0)); } catch {}
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
