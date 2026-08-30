const { test, expect, _electron: electron } = require('playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe')
    : process.platform === 'darwin' ? path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : path.join(dist, 'electron');
}

async function launch(sandbox, firstRun) {
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const packagedExe = process.env.BOBO_INTERNAL_PACKAGED_EXE || process.env.BOBO_PACKAGED_EXE || '';
  const app = await electron.launch({
    executablePath: packagedExe || electronPath(),
    args: (packagedExe ? [] : ['.']).concat(['--user-data-dir=' + path.join(sandbox, 'chromium')]),
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'),
      BOBO_FORCE_FIRST_RUN: firstRun ? '1' : '0'
    })
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
  return { app, page };
}

async function stop(app) {
  try { await app.evaluate(({ app }) => app.exit(0)); } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}

test('first download guides server setup once and keeps legacy credentials out of the primary flow', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-onboarding-'));
  let fixture;
  try {
    fixture = await launch(sandbox, true);
    const { page } = fixture;
    await page.setViewportSize({ width: 1100, height: 760 });
    await expect(page.locator('#settings-modal')).toBeVisible();
    await expect(page.locator('#server-first-run-intro')).toBeVisible();
    await expect(page.locator('.settings-tabs')).toBeHidden();
    await expect(page.locator('#server-apikey')).toBeHidden();
    await page.waitForTimeout(250);
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-modal')).toBeVisible();
    const layout = await page.evaluate(() => {
      const card = document.querySelector('#settings-modal .settings-card').getBoundingClientRect();
      return {
        inside: card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    });
    expect(layout).toEqual({ inside: true, overflow: false });
    fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'server-onboarding-ui.png') });
    await page.getByRole('button', { name: 'Use local editor only' }).click();
    await expect(page.locator('#settings-modal')).toBeHidden();
    const persisted = await page.evaluate(() => window.api.readServerSettings());
    expect(persisted.setupCompleted).toBe(true);
    expect(persisted.firstRunRequired).toBe(false);
    await stop(fixture.app);

    fixture = await launch(sandbox, true);
    await expect(fixture.page.locator('#settings-modal')).toBeHidden();
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('a first-run guide that cannot render releases the workbench interaction lock', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-onboarding-fallback-'));
  let fixture;
  try {
    fixture = await launch(sandbox, true);
    const { page } = fixture;
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('#settings-modal .settings-card').style.display = 'none';
      window.BOBO.settings.openFirstRun();
    });
    await expect(page.locator('#settings-modal')).toBeHidden();
    await page.locator('[data-workbench-view="explorer"]').click();
    await expect(page.locator('[data-sidebar-view="explorer"]')).toHaveClass(/active/);
    expect(await page.evaluate(() => window.BOBO.settings.isFirstRunOpen())).toBe(false);
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('AI answers render safe Markdown, copyable code, and native MathML', async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-ai-render-'));
  let fixture;
  try {
    fixture = await launch(sandbox, false);
    const { page } = fixture;
    await page.setViewportSize({ width: 1180, height: 780 });
    if (await page.locator('#settings-modal').isVisible()) {
      await page.getByRole('button', { name: 'Use local editor only' }).click();
      await expect(page.locator('#settings-modal')).toBeHidden();
    }
    expect(await page.evaluate(() => ({
      loaded: window.BOBO.aiUiLoader.isLoaded(),
      scriptPresent: Boolean(document.querySelector('script[data-bobo-ai-ui]'))
    }))).toEqual({ loaded: false, scriptPresent: false });
    await page.evaluate(async () => {
      window.BOBO.state.ai.chatMessages = [{
        id: 'render-demo', role: 'assistant',
        content: '# Result\n\nUse **energy** $E = mc^2$.\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n\n```js\nconst answer = 42;\n```\n\n<script>window.__aiInjected = true</script>'
      }];
      await window.BOBO.aiChatPanel.setVisible(true);
      document.getElementById('layout').classList.add('chat-open');
    });
    expect(await page.evaluate(() => ({
      loaded: window.BOBO.aiUiLoader.isLoaded(),
      scriptPresent: Boolean(document.querySelector('script[data-bobo-ai-ui]'))
    }))).toEqual({ loaded: true, scriptPresent: true });
    const message = page.locator('[data-msg-id="render-demo"] .ai-msg-content');
    await expect(message.locator('h3')).toHaveText('Result');
    await expect(message.locator('math')).toHaveCount(2);
    await expect(message.locator('.ai-code-copy')).toHaveText('Copy code');
    await expect(message.locator('pre code')).toHaveText('const answer = 42;');
    await expect(message.locator('script')).toHaveCount(0);
    await expect(message).toContainText('<script>window.__aiInjected = true</script>');
    expect(await page.evaluate(() => window.__aiInjected)).toBeUndefined();
    await message.locator('.ai-code-copy').click();
    await expect(message.locator('.ai-code-copy')).toHaveText('Copied');
    const evidence = path.join(os.tmpdir(), 'bobo-ai-markdown.png');
    await page.screenshot({ path: evidence });
    expect(fs.statSync(evidence).size).toBeGreaterThan(10000);
  } finally {
    if (fixture) await stop(fixture.app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
