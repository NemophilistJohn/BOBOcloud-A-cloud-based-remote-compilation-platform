const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('team sidebar orders roles, bounds expanded projects, and confirms project opens', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-team-sidebar-'));
  let app;
  try {
    const workspace = path.join(sandbox, 'workspace');
    const source = path.join(workspace, 'main.py');
    fs.mkdirSync(workspace);
    fs.writeFileSync(source, 'print("team sidebar")\n');
    app = await electron.launch({
      executablePath: require('electron'),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: { ...process.env, APPDATA: sandbox, USERPROFILE: sandbox, HOME: sandbox, XDG_CONFIG_HOME: sandbox }
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.evaluate(async ({ workspace, source }) => {
      const host = window.BOBO;
      const opened = await window.api.pickWorkspace(workspace);
      await host.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      await host.workspace.openFile(source, 'main.py');
      host.state.auth.mode = 'multi';
      host.state.auth.token = 'fixture-session';
      host.state.auth.user = { id: 'me', uid: 'fixture-1', username: 'fixture', avatar: 'forest' };
      const teams = [
        { id: 'member', name: 'A member team', is_admin: false, admin_user_id: 'other', project_count: 0, member_count: 1 },
        { id: 'admin', name: 'Z admin team', is_admin: true, admin_user_id: 'me', project_count: 8, member_count: 1 }
      ];
      const projects = Array.from({ length: 8 }, (_, i) => ({ id: `p-${i}`, team_id: 'admin', name: `Project ${i}`, default_branch: 'main' }));
      const daily = Array.from({ length: 200 }, (_, i) => i === 199 ? 2 : 0);
      const secondDaily = Array.from({ length: 200 }, (_, i) => i === 199 ? 3 : 0);
      let bouncedInvite = false;
      window.__teamSidebarCalls = [];
      host.sendToServer = async (action, payload) => {
        window.__teamSidebarCalls.push({ action, payload });
        if (action === 'listTeams') return { success: true, data: teams };
        if (action === 'listTeamProjects') return { success: true, data: projects };
        if (action === 'getTeam') return { success: true, data: {
          team: teams.find(team => team.id === payload.teamId),
          projects: payload.teamId === 'admin' ? projects : [],
          members: payload.teamId === 'admin' ? [
            { user_id: 'member-1', uid: 'member-uid-1', username: 'member1', name: 'Member One', avatar: 'ocean', is_admin: false },
            { user_id: 'me', uid: 'fixture-1', username: 'fixture', name: 'Admin', avatar: 'forest', is_admin: true }
          ] : [{ user_id: 'me', uid: 'fixture-1', username: 'fixture', name: 'Fixture', is_admin: false }]
        } };
        if (action === 'teamActivity') return { success: true, data: {
          start_date: new Date(Date.now() - 199 * 86400000).toISOString().slice(0, 10), days: 200,
          members: [
            { user_id: 'me', uid: 'fixture-1', name: 'Admin', is_admin: true, total: 12, daily },
            { user_id: 'member-1', uid: 'member-uid-1', name: 'Member One', is_admin: false, total: 4, daily }
          ],
          projects: projects.map((project, i) => ({ project_id: project.id, daily: i === 0 ? daily : i === 1 ? secondDaily : Array(200).fill(0) }))
        } };
        if (action === 'getTeamCacheInfo') return { success: true, data: {
          quota_bytes: 10000000, total_bytes: 2000000, shared_bytes: 250000, target_bytes: 750000, dependency_bytes: 1000000, scratch_bytes: 0,
          namespaces: [
            { project_id: 'p-0', branch: 'main', runtime: 'python:3.12', language: 'python', size_bytes: 500000, key: 'ns-p0', active: false },
            { project_id: 'p-1', branch: 'main', runtime: 'python:3.12', language: 'python', size_bytes: 250000, key: 'ns-p1', active: false }
          ],
          dependencies: [{ project_id: 'p-0', branch: 'main', runtime: 'python:3.12', language: 'python', size_bytes: 1000000, key: 'dep-p0', active: false }],
          project_usage: [{ project_id: 'p-0', size_bytes: 1500000 }, { project_id: 'p-1', size_bytes: 250000 }]
        } };
        if (action === 'listFriends') return { success: true, data: [
          { uid: 'member-uid-1', name: 'Already in team', avatar: 'ocean' },
          { uid: 'candidate-a', name: 'Candidate A', avatar: 'forest' },
          { uid: 'candidate-b', name: 'Candidate B', avatar: 'sunset' }
        ] };
        if (action === 'sendInbox' && payload.recipientId === 'candidate-b' && !bouncedInvite) {
          bouncedInvite = true;
          return { success: false, error: 'Temporary failure' };
        }
        if (action === 'sendInbox') return { success: true, data: { id: 'invite-' + payload.recipientId, kind: 'invite', status: 'pending', createdAt: new Date().toISOString() } };
        if (action === 'listTeamBranches') return { success: true, data: [{ name: 'main' }] };
        return { success: true, data: [] };
      };
      window.__friendVisibility = [];
      addEventListener('bobo:social-friends-visible', () => window.__friendVisibility.push('visible'));
      addEventListener('bobo:social-friends-hidden', () => window.__friendVisibility.push('hidden'));
    }, { workspace, source });
    await page.locator('#activity-team').click();
    await expect(page.locator('#collab-friends')).toBeVisible();
    await page.locator('#collab-mode-teams').click();
    expect(await page.evaluate(() => window.__friendVisibility)).toEqual(['visible', 'hidden']);
    const rows = page.locator('#collab-team-list [data-team-id]');
    await expect(rows.first()).toContainText('Z admin team');
    const admin = page.locator('[data-team-row="admin"]');
    await expect(admin.locator('[data-team-expand]')).toHaveAttribute('aria-expanded', 'false');
    await admin.locator('[data-team-expand]').click();
    await expect(admin.locator('[data-expanded-project]')).toHaveCount(8);
    const scroll = await admin.locator('.collab-expanded-projects').evaluate(el => ({ viewport: el.clientHeight, total: el.scrollHeight, row: el.firstElementChild.clientHeight }));
    expect(scroll.viewport).toBe(scroll.row * 5);
    expect(scroll.total).toBeGreaterThan(scroll.viewport);

    await admin.locator('[data-expanded-project]').first().click();
    await expect(page.locator('#collab-action-title')).toContainText('Project 0');
    await expect(page.locator('#collab-action-title')).toContainText('Z admin team');
    await page.locator('#collab-action-cancel').click();
    await expect(page.locator('#collab-action-modal')).toBeHidden();
    expect(await page.evaluate(() => window.__teamSidebarCalls.filter(x => x.action === 'listTeamBranches'))).toEqual([]);
    await admin.locator('[data-expanded-project]').first().click();
    await page.locator('#collab-action-confirm').click();
    await expect(page.locator('#action-open-branch')).toHaveValue('main');
    await page.locator('#collab-action-cancel').click();

    await rows.first().click();
    await expect(page.locator('#editor > #collab-team-page')).toBeVisible();
    await expect(page.locator('[data-sidebar-view="team"] #collab-team-detail')).toHaveCount(0);
    await expect(page.locator('#collab-team-settings')).toBeVisible();
    const headerStyle = await page.evaluate(() => {
      const title = document.querySelector('#collab-team-name').getBoundingClientRect();
      const role = document.querySelector('#collab-admin-badge').getBoundingClientRect();
      const page = document.querySelector('#collab-team-page');
      const avatar = document.querySelector('.team-member-avatar');
      const chart = document.querySelector('.team-activity-chart');
      return {
        titleRoleRowDelta: Math.abs(title.top - role.top),
        pageColor: getComputedStyle(page).backgroundColor,
        avatarColor: getComputedStyle(avatar).backgroundColor,
        chartColor: getComputedStyle(chart).backgroundColor
      };
    });
    expect(headerStyle.titleRoleRowDelta).toBeLessThan(8);
    expect(headerStyle.avatarColor).not.toBe(headerStyle.pageColor);
    expect(headerStyle.chartColor).not.toBe(headerStyle.pageColor);
    const memberCards = page.locator('#collab-member-list .team-member-card:not(.team-add-member-card)');
    await expect(memberCards).toHaveCount(2);
    await expect(memberCards.first()).toContainText('fixture-1');
    await memberCards.last().hover();
    await expect(memberCards.last().locator('.team-member-tooltip')).toContainText('4 commits');
    await expect(page.locator('#team-member-activity .team-activity-series')).toHaveCount(2);
    await page.locator('#team-add-member').click();
    await expect(page.locator('.team-invite-option')).toHaveCount(2);
    await page.locator('.team-invite-option input').first().check();
    await page.locator('.team-invite-option input').last().check();
    await page.locator('#collab-action-confirm').click();
    await expect(page.locator('#collab-action-status')).toContainText('1 invitations delivered · 1 failed');
    await expect(page.locator('.team-invite-option input')).toHaveCount(1);
    await expect(page.locator('.team-invite-option input')).toBeChecked();
    await page.locator('#collab-action-confirm').click();
    await expect(page.locator('#collab-action-modal')).toBeHidden();
    expect(await page.evaluate(() => window.__teamSidebarCalls.filter(call => call.action === 'sendInbox').map(call => call.payload.recipientId))).toEqual(['candidate-a', 'candidate-b', 'candidate-b']);
    const adminTab = page.locator('#tabbar [data-tab-path="team-page:admin"]');
    const memberTab = page.locator('#tabbar [data-tab-path="team-page:member"]');
    const fileTab = page.locator('#tabbar .tab').filter({ hasText: 'main.py' });
    await expect(adminTab).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-collab-tab="projects"]').click();
    await expect(page.locator('#collab-new-project')).toHaveCount(0);
    await expect(page.locator('.team-cache-segment')).toHaveCount(2);
    await expect(page.locator('.team-project-card')).toHaveCount(8);
    await expect(page.locator('.team-project-add')).toBeVisible();
    await expect(page.locator('#team-project-activity [data-date]')).toHaveCount(200);
    const activeDay = page.locator('#team-project-activity [data-date]').last();
    await expect(activeDay).toHaveAttribute('title', /5 commits · Project 1 \(3\)/);
    const color = await page.locator('.team-project-card').nth(1).evaluate(card => card.style.getPropertyValue('--project-accent'));
    await expect(activeDay).toHaveAttribute('style', expect.stringContaining(color));
    await expect(page.locator('.team-cache-segment').nth(1)).toHaveAttribute('style', expect.stringContaining(color));
    await page.locator('.team-project-add').click();
    await expect(page.locator('#collab-action-title')).toContainText('Create cloud project');
    await page.locator('#collab-action-cancel').click();
    await rows.last().click();
    await expect(page.locator('#collab-team-name')).toHaveText('A member team');
    await expect(memberTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#collab-team-settings')).toBeHidden();
    await expect(page.locator('.team-project-add')).toHaveCount(0);
    const geometry = await page.locator('[data-sidebar-view="team"]').evaluate(el => ({
      width: el.clientWidth,
      contentWidth: el.scrollWidth,
      overflow: el.querySelector('#collab-teams').scrollWidth > el.clientWidth + 1
    }));
    expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.overflow).toBe(false);
    await page.locator('#collab-mode-friends').click();
    await page.locator('[data-workbench-view="explorer"]').click();
    expect(await page.evaluate(() => window.__friendVisibility)).toEqual(['visible', 'hidden', 'visible', 'hidden']);
    await expect(page.locator('#editor > #collab-team-page')).toBeVisible();
    await fileTab.click();
    await expect(page.locator('#collab-team-page')).toBeHidden();
    await adminTab.click();
    await expect(page.locator('#collab-team-name')).toHaveText('Z admin team');
    await expect(page.locator('#collab-pane-projects')).toBeVisible();
    await memberTab.locator('button').click();
    await expect(memberTab).toHaveCount(0);
    await expect(adminTab).toHaveAttribute('aria-selected', 'true');
    await adminTab.locator('button').click();
    await expect(adminTab).toHaveCount(0);
    await expect(fileTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#collab-team-page')).toBeHidden();
  } finally {
    try { if (app) await app.evaluate(({ app }) => app.exit(0)); } catch {}
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
