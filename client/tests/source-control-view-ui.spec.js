const { test, expect, _electron: electron } = require('playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function stop(app) {
  if (!app) return;
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}

function installSourceControlPackage(userData) {
  const id = 'example.source-control-host';
  const root = path.join(userData, 'plugins', id);
  const source = `
function makeState(context, count, message) {
  const records = [{ id: 'first', title: context.i18n.t('Record one') }];
  if (count > 1) records.push({ id: 'second', title: context.i18n.t('Record two') });
  return {
    phase: 'ready',
    title: context.i18n.t('Workspace records'),
    message: message || context.i18n.t('Ready message'),
    summary: { items: [{ label: context.i18n.t('Selected'), value: String(count) }] },
    sections: [{
      id: 'records',
      title: context.i18n.t('Records'),
      items: records,
      loadMore: { command: 'example.source-control-host.loadMore', label: context.i18n.t('Load more') }
    }],
    actions: [{
      id: 'addNote',
      title: context.i18n.t('Add note'),
      command: 'example.source-control-host.addNote',
      kind: 'primary',
      form: {
        title: context.i18n.t('Add note'),
        submitLabel: context.i18n.t('Send'),
        fields: [{ id: 'note', label: context.i18n.t('Note'), type: 'textarea', required: true, maxLength: 160 }]
      }
    }, {
      id: 'refresh',
      title: context.i18n.t('Refresh'),
      command: 'example.source-control-host.refresh'
    }]
  };
}

export async function activate(context) {
  let count = 1;
  let view;
  const publish = (message) => view.setState(makeState(context, count, message));
  await context.commands.register('example.source-control-host.loadMore', () => {
    count = 2;
    return publish(context.i18n.t('Loaded more'));
  }, { title: 'Load more', category: 'Extensions' });
  await context.commands.register('example.source-control-host.addNote', (payload) => (
    publish(context.i18n.t('Note accepted: {note}', { note: payload.values.note }))
  ), { title: 'Add note', category: 'Extensions' });
  await context.commands.register('example.source-control-host.refresh', () => (
    publish(context.i18n.t('Refreshed'))
  ), { title: 'Refresh', category: 'Extensions' });
  view = await context.sourceControl.register({
    id: 'example.source-control-host.view',
    title: context.i18n.t('Workspace records'),
    icon: 'git-branch',
    order: 25
  });
  await publish();
  context.subscriptions.add(context.i18n.onDidChange(() => { void publish(); }));
}
`.trimStart();
  const english = JSON.stringify({
    'Workspace records': 'Workspace records',
    'Ready message': 'Ready for records',
    Selected: 'Selected',
    Records: 'Records',
    'Record one': 'Record one',
    'Record two': 'Record two',
    'Load more': 'Load more',
    'Loaded more': 'Loaded more',
    'Add note': 'Add note',
    Send: 'Send',
    Note: 'Note',
    'Note accepted: {note}': 'Note accepted: {note}',
    Refreshed: 'Refreshed'
  });
  const chinese = JSON.stringify({
    'Workspace records': '工作区记录',
    'Ready message': '记录已就绪',
    Selected: '已选择',
    Records: '记录',
    'Record one': '记录一',
    'Record two': '记录二',
    'Load more': '加载更多',
    'Loaded more': '已加载更多',
    'Add note': '添加备注',
    Send: '发送',
    Note: '备注',
    'Note accepted: {note}': '已接收备注：{note}',
    Refreshed: '已刷新'
  });
  const manifest = {
    schemaVersion: 1,
    id,
    displayName: 'Source Control Host Test',
    description: 'Playwright package for the bounded sidebar host.',
    version: '1.0.0',
    engines: { pluginApi: '^1.2.0', bobocloud: '>=2.6.0 <3.0.0' },
    main: 'dist/extension.js',
    activationEvents: ['onStartupFinished'],
    permissions: ['commands.register', 'sourceControl.register'],
    contributes: {},
    localization: {
      default: 'language-packs/en/messages.json',
      'zh-CN': 'language-packs/zh-CN/messages.json'
    },
    integrity: {
      algorithm: 'sha256',
      files: {
        'dist/extension.js': hash(source),
        'language-packs/en/messages.json': hash(english),
        'language-packs/zh-CN/messages.json': hash(chinese)
      }
    }
  };
  const manifestSource = JSON.stringify(manifest, null, 2) + '\n';
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'language-packs', 'en'), { recursive: true });
  fs.mkdirSync(path.join(root, 'language-packs', 'zh-CN'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'extension.js'), source, 'utf8');
  fs.writeFileSync(path.join(root, 'language-packs', 'en', 'messages.json'), english, 'utf8');
  fs.writeFileSync(path.join(root, 'language-packs', 'zh-CN', 'messages.json'), chinese, 'utf8');
  fs.writeFileSync(path.join(root, 'manifest.json'), manifestSource, 'utf8');
  fs.writeFileSync(path.join(root, '.bobocloud-install.json'), JSON.stringify({
    schemaVersion: 1,
    id,
    version: manifest.version,
    manifestSha256: hash(manifestSource),
    installedAt: new Date().toISOString()
  }, null, 2) + '\n');
}

test('installed source-control providers receive a host-rendered sidebar with forms and localizations', async () => {
  test.setTimeout(90000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-source-control-view-'));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  let app;

  try {
    app = await electron.launch({
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
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 25000 });
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    installSourceControlPackage(userData);
    await page.evaluate(async () => {
      await window.api.plugins.refresh();
      await window.api.plugins.grant('example.source-control-host', 'commands.register');
      await window.api.plugins.grant('example.source-control-host', 'sourceControl.register');
      await window.api.plugins.enable('example.source-control-host');
    });
    await page.waitForFunction(() => Boolean(window.BOBO.platform.sourceControl.get('example.source-control-host.view')), null, { timeout: 15000 });

    const activity = page.locator('.source-control-activity');
    await expect(activity).toBeVisible();
    await activity.click();
    const panel = page.locator('.source-control-sidebar.active');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.source-control-heading')).toHaveText('Workspace records');
    await expect(panel.locator('.source-control-summary-row')).toContainText('Selected');
    await expect(panel.locator('.source-control-list-item')).toHaveCount(1);

    await panel.locator('.source-control-load-more').click();
    await expect(panel.locator('.source-control-list-item')).toHaveCount(2);
    await expect(panel).toContainText('Loaded more');

    await panel.locator('.source-control-action', { hasText: 'Add note' }).click();
    const form = panel.locator('.source-control-form');
    await expect(form).toBeVisible();
    await form.locator('textarea[name="note"]').fill('<b>plain text</b>');
    await page.evaluate(() => window.BOBO.sourceControlView.refresh());
    await expect(form.locator('textarea[name="note"]')).toHaveValue('<b>plain text</b>');
    await form.locator('button[type="submit"]').click();
    await expect(panel).toContainText('Note accepted: <b>plain text</b>');
    await expect(panel.locator('b')).toHaveCount(0);

    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('zh-CN'); });
    await expect(panel.locator('.source-control-heading')).toHaveText('工作区记录');
    await expect(panel.locator('.source-control-load-more')).toHaveText('加载更多');

    await page.evaluate(async () => { await window.api.plugins.disable('example.source-control-host'); });
    await expect(activity).toHaveCount(0);
    await expect(page.locator('.source-control-sidebar')).toHaveCount(0);
    await expect(page.locator('[data-sidebar-view="explorer"]')).toHaveClass(/active/);
    expect(pageErrors).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
