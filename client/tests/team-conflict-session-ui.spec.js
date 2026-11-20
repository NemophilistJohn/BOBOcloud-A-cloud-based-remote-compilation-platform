const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('team conflicts open a main-area diff session and publish an explicit resolution', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-team-conflict-'));
  let app;
  try {
    const workspace = path.join(sandbox, 'workspace');
    const source = path.join(workspace, 'main.py');
    fs.mkdirSync(workspace);
    fs.writeFileSync(source, 'print("team conflict")\n');
    app = await electron.launch({
      executablePath: require('electron'),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: { ...process.env, APPDATA: sandbox, USERPROFILE: sandbox, HOME: sandbox, XDG_CONFIG_HOME: sandbox }
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await page.evaluate(async ({ workspace, source }) => {
      const host = window.BOBO;
      const opened = await window.api.pickWorkspace(workspace);
      await host.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await host.workspace.openFile(source, 'main.py');
      host.state.auth.mode = 'multi';
      host.state.auth.token = 'fixture-session';
      host.state.auth.user = { id: 'me', uid: 'fixture-1', username: 'fixture' };
      const conflicts = [{
        path: 'src/solver.py',
        base: 'value = 1\n',
        ours: 'value = 2\n',
        theirs: 'value = 3\n'
      }, {
        path: 'assets/icon.bin',
        base: '\u0000base',
        ours: '\u0000current',
        theirs: '\u0000incoming'
      }];
      const resolved = new Set();
      window.__teamConflictCalls = [];
      host.sendToServer = async (action, payload) => {
        window.__teamConflictCalls.push({ action, payload });
        if (action === 'listTeamBranches') return { success: true, data: [{ name: 'main' }] };
        if (action === 'listTeamConflicts') return { success: true, data: conflicts.filter(file => !resolved.has(file.path)) };
        if (action === 'resolveTeamConflict') {
          resolved.add(payload.filePath);
          return { success: true, data: { resolved: payload.filePath } };
        }
        if (action === 'completeTeamMerge') return { success: true, data: { id: 'merge-commit' } };
        if (action === 'teamProjectHistory') return { success: true, data: Array.from({ length: 10 }, (_, i) => ({
          id: 'commit-' + i, parents: [], author: 'Admin', author_uid: 'fixture-1', message: 'Change ' + i, created_at: new Date().toISOString()
        })) };
        if (action === 'listTeamFileLocks') return { success: true, data: [{
          team_id: 'team-1', project_id: 'project-1', branch: 'main', path: 'src/active.py',
          user_id: 'teammate', user_uid: 'u-teammate', user_name: 'Teammate',
          expires_at: new Date(Date.now() + 80000).toISOString()
        }] };
        if (action === 'getTeamCacheInfo') return { success: true, data: null };
        return { success: true, data: [] };
      };
      host.collaboration.restoreMapping({
        teamId: 'team-1', teamName: 'Physics', projectId: 'project-1', projectName: 'Solver', branch: 'main'
      }, workspace);
      host.switchToPanel('team');
    }, { workspace, source });

    await expect(page.locator('#team-workbench .team-workbench-grid')).toBeVisible();
    await expect(page.locator('#team-workbench .team-workbench-grid > .team-workbench-section .commit-row')).toHaveCount(10);
    await expect(page.locator('#team-lock-list .team-lock-broadcast')).toHaveCount(1);
    await expect(page.locator('#team-lock-list [data-lock-countdown]')).toContainText('remaining');
    await expect(page.locator('#team-cache-compact')).toHaveCount(0);
    const workbenchColumns = await page.locator('#team-workbench .team-workbench-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(workbenchColumns).toBe(2);
    const resizer = page.locator('#output-resizer');
    await resizer.press('Home');
    const scrolls = await page.locator('.team-workbench-grid').evaluate(grid => {
      const [left, right] = grid.children;
      right.scrollTop = right.scrollHeight;
      const rightScroll = right.scrollTop;
      left.scrollTop = left.scrollHeight;
      const locks = right.querySelector('#team-lock-list').getBoundingClientRect();
      const viewport = right.getBoundingClientRect();
      return left.scrollTop > 0 && rightScroll > 0 && right.scrollTop === rightScroll &&
        locks.bottom > viewport.top && locks.top < viewport.bottom;
    });
    expect(scrolls).toBe(true);
    await resizer.press('End');

    await page.locator('.team-open-conflict').first().click();
    await expect(page.locator('#collab-conflict-page')).toBeVisible();
    await expect(page.locator('#collab-conflict-session')).toContainText('src/solver.py');
    await expect(page.locator('#team-conflict-diff .monaco-diff-editor')).toBeVisible();
    await expect(page.locator('#team-complete-merge')).toBeDisabled();
    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('zh-CN'); });
    await expect(page.locator('#collab-conflict-session')).toContainText('冲突解决');
    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('en'); });
    await page.locator('#team-conflict-use-incoming').click();
    await page.locator('#team-save-resolution').click();
    await expect.poll(() => page.evaluate(() => window.__teamConflictCalls.some(call =>
      call.action === 'resolveTeamConflict' && call.payload.content === 'value = 3\n'
    ))).toBe(true);
    await expect(page.locator('#team-conflict-progress')).toHaveText('1 of 2 resolved');
    await page.locator('[data-conflict-session-path="assets/icon.bin"]').click();
    await expect(page.locator('.conflict-limitation')).toContainText('Binary conflict');
    await page.locator('#team-conflict-use-incoming').click();
    await page.locator('#team-save-resolution').click();
    await expect.poll(() => page.evaluate(() => window.__teamConflictCalls.some(call =>
      call.action === 'resolveTeamConflict' && call.payload.filePath === 'assets/icon.bin' && call.payload.resolution === 'incoming' && call.payload.content === ''
    ))).toBe(true);
    await expect(page.locator('#team-conflict-progress')).toHaveText('2 of 2 resolved');
    await expect(page.locator('#team-save-resolution')).toBeDisabled();
    await expect(page.locator('#team-complete-merge')).toBeEnabled();
    await page.locator('#team-complete-merge').click();
    await page.locator('#collab-action-confirm').click();
    await expect.poll(() => page.evaluate(() => window.__teamConflictCalls.some(call => call.action === 'completeTeamMerge'))).toBe(true);
    await expect(page.locator('#collab-conflict-page')).toBeHidden();
  } finally {
    try { if (app) await app.evaluate(({ app }) => app.exit(0)); } catch {}
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
