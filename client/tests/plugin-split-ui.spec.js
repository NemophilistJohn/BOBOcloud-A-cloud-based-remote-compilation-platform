'use strict';

const { test, expect, _electron: electron } = require('playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginId = 'example.split-documents';
const permissions = ['documentViews.register', 'documents.read', 'documents.write', 'sourceControl.register'];

function installFixture(userData) {
  const files = {
    'dist/extension.js': `export async function activate(context) {
      context.subscriptions.add(await context.documentViews.register({ id: '${pluginId}.viewer', title: 'Split Document Fixture' }));
      const sidebar = await context.sourceControl.register({ id: '${pluginId}.sidebar', title: 'Split Notes', icon: 'notebook', order: 30 });
      context.subscriptions.add(sidebar);
      await sidebar.setState({ phase: 'ready', title: 'Split Notes', summary: { items: [{ label: 'Format', value: '.panedoc' }] } });
    }`,
    'dist/view.js': `export async function activate(context) {
      const name = context.document.name;
      const article = document.createElement('article');
      article.dataset.mount = Math.random().toString(36).slice(2);
      article.style.cssText = 'height:100%;box-sizing:border-box;padding:24px;color:white;background:#20242a';
      const heading = document.createElement('h1'); heading.textContent = name;
      const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Draft ' + name);
      input.style.cssText = 'width:100%;height:160px'; input.value = await context.readText();
      const status = document.createElement('output'); status.setAttribute('aria-label', 'Navigation ' + name); status.textContent = 'No navigation';
      const saved = document.createElement('output'); saved.setAttribute('aria-label', 'Save ' + name); saved.textContent = 'Unchanged';
      article.append(heading, input, status, saved); context.root.replaceChildren(article);
      input.addEventListener('input', () => context.setDirty(true));
      context.onSave(async () => { const result = await context.writeText(input.value); if (result.ok) { context.setDirty(false); saved.textContent = 'Saved ' + name; } return result.ok; });
      context.setNavigation({ providerId: '${pluginId}.sidebar', activeMode: 'preview',
        modes: [{ id: 'preview', label: 'Preview ' + name }, { id: 'source', label: 'Source ' + name }],
        outlineLabel: 'Outline ' + name, rows: [{ id: 'row-one', label: 'Row ' + name, number: 1, tone: 'teal' }] });
      context.onNavigate(id => { status.textContent = name + ':' + id; });
      return () => context.root.replaceChildren();
    }`
  };
  const digest = content => crypto.createHash('sha256').update(content).digest('hex');
  const manifest = JSON.stringify({
    schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Split Documents Fixture',
    engines: { bobocloud: '>=2.8.1', pluginApi: '^1.10.0' }, main: 'dist/extension.js', activationEvents: ['onStartupFinished'],
    permissions, contributes: { documentViewers: [{ id: pluginId + '.viewer', extensions: ['.panedoc'], entry: 'dist/view.js' }] },
    integrity: { algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])) }
  });
  const root = path.join(userData, 'plugins', pluginId);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(root, '.bobocloud-install.json'), JSON.stringify({ schemaVersion: 1, id: pluginId,
    version: '1.0.0', manifestSha256: digest(manifest), installedAt: new Date().toISOString() }));
}

test('document plugin panes retain iframe drafts, focus routes save and navigation, and text remains usable after close', async ({}, testInfo) => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-plugin-split-'));
  const workspace = path.join(sandbox, 'workspace');
  const first = path.join(workspace, 'first.panedoc'), second = path.join(workspace, 'second.panedoc'), textFile = path.join(workspace, 'main.js');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(first, 'first original'); fs.writeFileSync(second, 'second original'); fs.writeFileSync(textFile, 'const text = true;\n');
  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: { ...process.env, APPDATA: path.join(sandbox, 'appdata'), HOME: path.join(sandbox, 'home'), USERPROFILE: path.join(sandbox, 'home'),
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg'), BOBO_FORCE_FIRST_RUN: '0', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const page = await app.firstWindow();
    const issues = [];
    page.on('pageerror', error => issues.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true');
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    installFixture(userData);
    await page.evaluate(async ({ workspace, first, pluginId, permissions }) => {
      await window.api.plugins.refresh();
      for (const permission of permissions) await window.api.plugins.grant(pluginId, permission);
      await window.api.plugins.enable(pluginId);
      const opened = await window.api.pickWorkspace(workspace);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
    }, { workspace, first, pluginId, permissions });
    await expect.poll(() => page.evaluate(() => window.BOBO.documentViews.find('first.panedoc')?.pluginId)).toBe(pluginId);
    await page.evaluate(async first => window.BOBO.workspace.openFile(first, 'first.panedoc'), first);
    await expect(page.locator('iframe.document-view-frame')).toHaveCount(1);
    const originalFrame = page.frameLocator('iframe.document-view-frame');
    const originalDraft = originalFrame.getByRole('textbox', { name: 'Draft first.panedoc' });
    await originalDraft.fill('draft from the original view');
    const originalMount = await originalFrame.locator('article').getAttribute('data-mount');
    await originalDraft.press('ControlOrMeta+\\');
    const preview = page.locator('#split-right-pane .split-surface-preview');
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(100);
    await expect(page.locator('iframe.document-view-frame')).toHaveCount(1);
    await expect(page.locator('#split-left-label')).toHaveText('first.panedoc');
    await expect(page.locator('#split-right-label')).toHaveText('first.panedoc');
    await preview.click();
    await expect(page.locator('iframe.document-view-frame.workbench-split-right')).toBeVisible();
    await expect(originalDraft).toHaveValue('draft from the original view');
    await expect(originalFrame.locator('article')).toHaveAttribute('data-mount', originalMount);
    expect(fs.readFileSync(first, 'utf8')).toBe('first original');
    await page.evaluate(async second => window.BOBO.workspace.openFile(second, 'second.panedoc'), second);
    const leftFrame = page.locator('iframe.document-view-frame.workbench-split-left');
    const rightFrame = page.locator('iframe.document-view-frame.workbench-split-right');
    await expect(leftFrame).toBeVisible(); await expect(rightFrame).toBeVisible();
    const left = leftFrame.contentFrame(), right = rightFrame.contentFrame();
    await expect(left.getByRole('heading', { name: 'first.panedoc', exact: true })).toBeVisible();
    await expect(right.getByRole('heading', { name: 'second.panedoc', exact: true })).toBeVisible();
    await expect(left.getByRole('textbox', { name: 'Draft first.panedoc' })).toHaveValue('draft from the original view');
    await expect(page.locator('.split-surface-preview')).toHaveCount(0);
    const bounds = await Promise.all([leftFrame.boundingBox(), rightFrame.boundingBox()]);
    expect(bounds[0].width).toBeGreaterThan(150); expect(bounds[1].width).toBeGreaterThan(150);
    expect(bounds[0].x + bounds[0].width).toBeLessThanOrEqual(bounds[1].x + 1);
    for (const [index, pane] of ['left', 'right'].entries()) {
      const paneBounds = await page.locator('#split-' + pane + '-pane').boundingBox();
      const headerBounds = await page.locator('#split-' + pane + '-pane .split-pane-header').boundingBox();
      expect(Math.abs(bounds[index].width - paneBounds.width), 'the iframe must fill its pane instead of keeping its intrinsic width').toBeLessThanOrEqual(2);
      expect(Math.abs(bounds[index].height - (paneBounds.height - headerBounds.height)), 'the iframe must fill the space below the pane header').toBeLessThanOrEqual(2);
    }
    await expect(page.locator('#split-left-label')).toHaveText('first.panedoc');
    await expect(page.locator('#split-right-label')).toHaveText('second.panedoc');
    await page.evaluate(() => { window.__paneFrames = Array.from(document.querySelectorAll('iframe.document-view-frame')); });
    const mounts = await Promise.all([left.locator('article').getAttribute('data-mount'), right.locator('article').getAttribute('data-mount')]);
    await left.getByRole('textbox', { name: 'Draft first.panedoc' }).fill('first unsaved draft');
    await right.getByRole('textbox', { name: 'Draft second.panedoc' }).fill('second unsaved draft');
    await expect.poll(() => page.evaluate(() => window.BOBO.state.tabs.every(tab => tab.dirty))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('plugin-document-split.png'), fullPage: false });

    await left.getByRole('textbox', { name: 'Draft first.panedoc' }).click();
    await expect.poll(() => page.evaluate(() => window.BOBO.state.activeTabPath)).toBe(first);
    await page.evaluate(() => window.BOBO.workspace.saveActiveTab());
    expect(fs.readFileSync(first, 'utf8')).toBe('first unsaved draft');
    expect(fs.readFileSync(second, 'utf8')).toBe('second original');
    await page.locator('.document-navigation').getByRole('button', { name: 'Row first.panedoc', exact: false }).click();
    await expect(left.getByLabel('Navigation first.panedoc')).toHaveText('first.panedoc:row-one');
    await expect(right.getByLabel('Navigation second.panedoc')).toHaveText('No navigation');
    await right.getByRole('textbox', { name: 'Draft second.panedoc' }).click();
    await expect.poll(() => page.evaluate(() => window.BOBO.state.activeTabPath)).toBe(second);
    await page.evaluate(() => window.BOBO.workspace.saveActiveTab());
    expect(fs.readFileSync(second, 'utf8')).toBe('second unsaved draft');
    await page.locator('.document-navigation').getByRole('button', { name: 'Row second.panedoc', exact: false }).click();
    await expect(right.getByLabel('Navigation second.panedoc')).toHaveText('second.panedoc:row-one');
    await expect(left.getByLabel('Navigation first.panedoc')).toHaveText('first.panedoc:row-one');

    // A text tab replaces only the active pane. Returning reuses the exact iframe and draft.
    await right.getByRole('textbox', { name: 'Draft second.panedoc' }).fill('second draft kept across text switch');
    await page.evaluate(async textFile => window.BOBO.workspace.openFile(textFile, 'main.js'), textFile);
    await expect(leftFrame).toBeVisible();
    await expect(page.locator('#split-right .monaco-editor')).toBeVisible();
    expect(await page.evaluate(() => window.BOBO.views.getVisibleEditors().map(editor => editor.getModel().getLanguageId()))).toEqual(['javascript']);
    await page.locator('#tabbar .tab-title', { hasText: 'second.panedoc' }).click();
    await expect(rightFrame).toBeVisible();
    await expect(right.getByRole('textbox', { name: 'Draft second.panedoc' })).toHaveValue('second draft kept across text switch');
    expect(await page.evaluate(() => window.__paneFrames.every(frame => frame.isConnected && Array.from(document.querySelectorAll('iframe.document-view-frame')).includes(frame)))).toBe(true);
    expect(await Promise.all([left.locator('article').getAttribute('data-mount'), right.locator('article').getAttribute('data-mount')])).toEqual(mounts);
    await page.evaluate(() => window.BOBO.workspace.saveActiveTab());

    await page.evaluate(async second => window.BOBO.workspace.closeTab(second), second);
    await expect(page.locator('iframe.document-view-frame')).toHaveCount(1);
    await page.evaluate(async first => window.BOBO.workspace.closeTab(first), first);
    await expect(page.locator('iframe.document-view-frame')).toHaveCount(0);
    await expect(page.locator('#document-view-host')).toBeHidden();
    await expect(page.locator('#plugin-details-view.active')).toHaveCount(0);
    await expect(page.locator('#split-right .monaco-editor')).toBeVisible();
    await page.locator('#split-right .view-lines').click({ position: { x: 30, y: 10 } });
    await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.type('// no overlay\n');
    await expect.poll(() => page.evaluate(() => window.BOBO.views.getActiveEditor().getModel().getValue())).toContain('// no overlay');
    expect(issues).toEqual([]);
  } finally {
    if (app) { try { await app.evaluate(({ app }) => app.exit(0)); } catch (_) {} }
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
