const { test, expect, _electron: electron } = require('playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

async function launch() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-ai-center-'));
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

test('standalone AI control center configures and toggles independent chat and completion agents', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launch();
    const { page } = fixture;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1100, height: 760 });

    await expect(page.locator('#activity-ai')).toHaveCount(0);
    expect(await page.evaluate(() => window.BOBO.aiUiLoader.isLoaded())).toBe(false);
    await expect(page.locator('script[data-bobo-ai-ui]')).toHaveCount(0);
    await page.evaluate(() => window.BOBO.settings.open('ai'));
    await expect(page.locator('#settings-modal')).toBeHidden();
    await expect(page.locator('#ai-settings-modal')).toBeVisible();
    expect(await page.evaluate(() => window.BOBO.aiUiLoader.isLoaded())).toBe(true);
    await expect(page.locator('script[data-bobo-ai-ui]')).toHaveCount(1);
    await expect(page.locator('#ai-control-title')).toHaveText('AI Control Center');
    await expect(page.locator('#ai-settings-modal')).not.toContainText(/ai\.control\./);

    await page.locator('[data-ai-tab="connections"]').click();
    await page.getByRole('button', { name: 'Add chat agent' }).click();
    const fields = page.locator('.ai-profile-editor');
    await fields.locator('[data-profile-field="name"]').fill('Local test');
    await fields.locator('[data-profile-field="apiKey"]').fill('mock-only');
    await fields.locator('[data-profile-field="endpoint"]').fill('http://127.0.0.1:18080/v1/chat/completions');
    await fields.locator('[data-profile-field="modelId"]').fill('chat-model');

    await page.evaluate(async () => window.BOBO.i18n.setLocale('ja'));
    await expect(fields.locator('[data-profile-field="name"]')).toHaveValue('Local test');
    await expect(page.locator('#ai-control-title')).toHaveText('AI コントロールセンター');
    await page.evaluate(async () => window.BOBO.i18n.setLocale('en'));
    await page.evaluate(() => window.BOBO.aiSettingsCenter.open('connections'));
    await expect(fields.locator('[data-profile-field="name"]')).toHaveValue('Local test');
    await expect.poll(() => page.evaluate(() => window.BOBO.aiSettingsCenter.isDirty())).toBe(true);

    await page.getByRole('button', { name: 'Apply profile' }).click();
    await expect(page.locator('#ai-control-save-status')).toHaveText('Changes saved');
    const stored = await page.evaluate(() => window.BOBO.aiService.getSettings());
    expect(stored.chatProfiles).toHaveLength(1);
    expect(stored.chatProfileId).toBe('');
    expect(stored.chatProfiles[0].modelId).toBe('chat-model');

    await page.getByRole('button', { name: 'Add completion agent' }).click();
    await fields.locator('[data-profile-field="name"]').fill('Inline local');
    await fields.locator('[data-profile-field="apiKey"]').fill('mock-only');
    await fields.locator('[data-profile-field="endpoint"]').fill('http://127.0.0.1:18081/beta/completions');
    await fields.locator('[data-profile-field="modelId"]').fill('completion-model');
    await fields.locator('[data-profile-field="mode"]').selectOption('fim');
    await page.getByRole('button', { name: 'Apply profile' }).click();
    await expect(page.locator('#ai-control-save-status')).toHaveText('Changes saved');
    await expect(page.locator('[data-purpose="chat"] .ai-profile-toggle')).toBeVisible();
    await page.locator('[data-purpose="chat"] .ai-profile-toggle').click();
    await page.locator('[data-purpose="inline"] .ai-profile-toggle').click();
    await expect(page.locator('#ai-control-save-status')).toHaveText('Changes saved');
    const enabled = await page.evaluate(() => window.BOBO.aiService.getSettings());
    expect(enabled.chatProfileId).toBe(enabled.chatProfiles[0].id);
    expect(enabled.inlineProfileId).toBe(enabled.inlineProfiles[0].id);
    expect(enabled.inline.enabled).toBe(true);

    await page.locator('[data-ai-tab="inline"]').click();
    await expect(page.locator('.ai-control-switch input')).toBeChecked();

    const fit = await page.evaluate(() => {
      const shell = document.querySelector('.ai-control-shell').getBoundingClientRect();
      const controls = [...document.querySelectorAll('#ai-settings-modal button, #ai-settings-modal input, #ai-settings-modal select, #ai-settings-modal textarea')]
        .filter(node => node.offsetParent !== null);
      return {
        shellInside: shell.left >= 0 && shell.right <= innerWidth + 1 && shell.top >= 0 && shell.bottom <= innerHeight + 1,
        horizontalOverflow: document.querySelector('.ai-control-content').scrollWidth > document.querySelector('.ai-control-content').clientWidth + 1,
        controlsInside: controls.every(node => {
          const rect = node.getBoundingClientRect();
          return rect.left >= shell.left - 1 && rect.right <= shell.right + 1;
        })
      };
    });
    expect(fit).toEqual({ shellInside: true, horizontalOverflow: false, controlsInside: true });
    await page.locator('[data-ai-tab="connections"]').click();
    fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'ai-settings-ui.png') });
    expect(errors).toEqual([]);
  } finally {
    await close(fixture);
  }
});

test('chat configuration failures recover and settings auto-save before closing', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launch();
    const { page } = fixture;
    await page.setViewportSize({ width: 760, height: 620 });
    await page.evaluate(() => {
      const profile = {
        id: 'missing-key', name: 'Missing key', provider: 'openai-compatible', apiKey: '',
        endpoint: 'http://127.0.0.1:1/v1/chat/completions', modelId: 'chat-model', mode: 'chat', options: {}
      };
      return window.BOBO.aiService.updateSettings({ chatProfiles: [profile], chatProfileId: profile.id });
    });
    await page.locator('[data-ai-btn="true"]').click();
    await page.locator('#ai-chat-input').fill('hello');
    await page.locator('#ai-chat-send').click();
    await expect.poll(() => page.evaluate(() => window.BOBO.state.ai.chatStreaming)).toBe(false);
    await expect(page.locator('#ai-chat-messages')).toContainText(/API key|key/i);

    await page.locator('#ai-chat-history').click();
    const history = page.locator('.ai-history-overlay');
    await expect(history).toHaveAttribute('role', 'dialog');
    await expect(history).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('.ai-history-item').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(history).toHaveCount(0);
    await expect(page.locator('#ai-chat-history')).toBeFocused();

    await page.evaluate(() => window.BOBO.aiSettingsCenter.open('instructions'));
    await page.locator('.ai-control-textarea').first().fill('Keep answers concise.');
    await expect(page.locator('#ai-control-save-status')).toContainText('Waiting to save');
    await expect(page.locator('#ai-control-save-status')).toContainText('Changes saved', { timeout: 10000 });
    await page.locator('#ai-control-close').click();
    await expect(page.locator('#ai-settings-modal')).toBeHidden();

    await page.evaluate(() => window.BOBO.aiSettingsCenter.open('instructions'));
    await expect(page.locator('.ai-control-textarea').first()).toHaveValue('Keep answers concise.');

    await page.evaluate(() => window.BOBO.aiSettingsCenter.switchTab('connections'));
    const fit = await page.evaluate(() => {
      const content = document.querySelector('.ai-control-content');
      const shell = document.querySelector('.ai-control-shell').getBoundingClientRect();
      return {
        overflow: content.scrollWidth > content.clientWidth + 1,
        actionsInside: [...document.querySelectorAll('.ai-control-profile-actions button')].every(button => button.getBoundingClientRect().right <= shell.right + 1)
      };
    });
    expect(fit).toEqual({ overflow: false, actionsInside: true });
  } finally {
    await close(fixture);
  }
});

test('chat starters disappear on first message and current file context can be excluded', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launch();
    const { page } = fixture;
    await page.evaluate(async () => {
      const profile = {
        id: 'local-chat', name: 'Local chat', provider: 'openai-compatible', apiKey: 'mock',
        endpoint: 'http://127.0.0.1:1/v1/chat/completions', modelId: 'chat', mode: 'chat', options: {}
      };
      await window.BOBO.aiService.updateSettings({ chatProfiles: [profile], chatProfileId: profile.id });
      window.BOBO.state.tabs = [{
        path: '/workspace/main.js', name: 'main.js', language: 'javascript',
        model: { getValue: () => 'const secretContext = true;', getLineCount: () => 1 }
      }];
      window.BOBO.state.activeTabPath = '/workspace/main.js';
      window.BOBO.aiChatPanel.updateContextBar();
    });
    await page.locator('[data-ai-btn="true"]').click();
    await expect(page.locator('.ai-chat-starters')).toBeVisible();
    await expect(page.locator('.ai-pill-current')).toBeVisible();
    await page.locator('.ai-pill-current .ai-pill-remove').click();
    await expect(page.locator('.ai-pill-current')).toHaveCount(0);
    const context = await page.evaluate(() => window.BOBO.aiContext.buildFullContext());
    expect(context.currentFile).toBeNull();
    expect(context.selection).toBeNull();
    expect(context.projectStructure).toBeNull();
    expect(context.openTabs).toEqual([]);
    expect(context.referencedFiles).toEqual([]);
    const prompt = await page.evaluate(() => window.BOBO.aiService.buildChatPayload(
      window.BOBO.aiService.getProfileFor('chat'),
      'hello without files',
      window.BOBO.aiContext.buildFullContext(),
      'no-files', false
    ).messages[0].content);
    expect(prompt).not.toContain('secretContext');
    expect(prompt).not.toContain('/workspace/main.js');
    expect(prompt).not.toContain('Workspace:');

    await page.locator('#ai-chat-input').fill('hello without files');
    await page.locator('#ai-chat-send').click();
    await expect(page.locator('.ai-chat-starters')).toHaveCount(0);
    await expect(page.locator('.ai-msg-user')).toContainText('hello without files');
  } finally {
    await close(fixture);
  }
});

test('only a real parseable connection test can light the ready LED', async () => {
  test.setTimeout(60000);
  let fixture;
  let requests = 0;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await listen(server);
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  try {
    fixture = await launch();
    const { page } = fixture;
    const healthy = await page.evaluate(async endpointValue => {
      const profile = { id: 'verified', name: 'Verified', provider: 'openai-compatible', apiKey: 'local-only', endpoint: endpointValue, modelId: 'mock-chat', mode: 'chat', options: {} };
      await window.BOBO.aiService.updateSettings({ chatProfiles: [profile], chatProfileId: profile.id });
      return window.BOBO.aiService.getModelStatus(window.BOBO.aiService.getProfileFor('chat'), 'chat');
    }, endpoint);
    expect(healthy.state).toBe('ready');
    expect(requests).toBe(1);
    await expect(page.locator('.ai-led-green')).toHaveClass(/ai-led-active/);

    const failed = await page.evaluate(async () => {
      const current = window.BOBO.aiService.getProfileFor('chat');
      await window.BOBO.aiService.updateSettings({ chatProfiles: [Object.assign({}, current, { endpoint: 'http://127.0.0.1:1/v1/chat/completions' })] });
      return window.BOBO.aiService.getModelStatus(window.BOBO.aiService.getProfileFor('chat'), 'chat');
    });
    expect(failed.state).toBe('error');
    await expect(page.locator('.ai-led-red')).toHaveClass(/ai-led-error/);
    await expect(page.locator('.ai-led-green')).not.toHaveClass(/ai-led-active/);
  } finally {
    await close(fixture);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('edits made while AI settings are auto-saving remain pending for the next save', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launch();
    const { page } = fixture;
    await page.evaluate(() => {
      window.__aiSettingsSaves = [];
      window.BOBO.aiService.updateSettings = () => new Promise(resolve => {
        window.__aiSettingsSaves.push(resolve);
      });
      window.BOBO.aiSettingsCenter.open('instructions');
    });
    const globalInstructions = page.locator('[data-ai-pane="instructions"] textarea').first();
    await globalInstructions.fill('Snapshot being saved');
    await page.waitForFunction(() => window.__aiSettingsSaves.length === 1);
    await globalInstructions.fill('Draft typed while saving');
    await expect(page.locator('#ai-control-close')).toBeDisabled();
    await expect(page.locator('#ai-control-cancel')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('#ai-settings-modal')).toBeVisible();
    await expect(page.locator('#confirm-dialog')).toHaveCount(0);
    await page.evaluate(() => window.__aiSettingsSaves.shift()({ success: true }));
    await expect(page.locator('#ai-control-close')).toBeEnabled();
    await expect(page.locator('#ai-control-cancel')).toBeEnabled();
    await expect(globalInstructions).toHaveValue('Draft typed while saving');
    await page.waitForFunction(() => window.__aiSettingsSaves.length === 1);
    await expect(page.locator('#ai-control-save-status')).toHaveText('Saving...');
    expect(await page.evaluate(() => window.BOBO.aiSettingsCenter.isDirty())).toBe(true);
    await page.evaluate(() => window.__aiSettingsSaves.shift()({ success: true }));
    await expect(page.locator('#ai-control-save-status')).toHaveText('Changes saved');
  } finally {
    await close(fixture);
  }
});
