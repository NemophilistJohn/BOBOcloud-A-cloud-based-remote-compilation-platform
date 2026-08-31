'use strict';

const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createPluginController } = require('../main/plugins');
const { resolvePluginArtifact, shouldSkipMissingArtifact } = require('./support/plugin-artifact');

const PLUGIN_ID = 'bobocloud.ai-agent';
const PROVIDER_ID = 'bobocloud.ai-agent.workbench';
const PLUGIN_ROOT = process.env.BOBO_AI_AGENT_PLUGIN_DIR
  ? path.resolve(process.env.BOBO_AI_AGENT_PLUGIN_DIR)
  : path.resolve(__dirname, '..', '..', '..', 'BOBOCloud-AI-Agent-plugin-offical');
const ARTIFACT_INFO = resolvePluginArtifact({
  artifactEnv: 'BOBO_AI_AGENT_PLUGIN_ARTIFACT',
  pluginId: PLUGIN_ID,
  repositoryRoot: PLUGIN_ROOT,
  versionEnv: 'BOBO_AI_AGENT_PLUGIN_VERSION'
});
const ARTIFACT = ARTIFACT_INFO.artifactPath;

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

async function stop(app) {
  if (!app) return;
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function installPackage(userData, workspace) {
  const installer = createPluginController({
    app: { getPath: () => userData, getVersion: () => '2.8.0' },
    ipcMain: { handle() {} },
    getWindow: () => null,
    getWorkspaceIdentity: () => ({ rootPath: workspace, workspaceIdentity: 1 }),
    hostVersion: '2.8.0'
  });
  return installer.installArchiveFromPath(ARTIFACT);
}

function createWorkspace(root) {
  const skillRoot = path.join(root, '.agents', 'skills', 'ui-review');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.js'), 'export const ready = true;\n', 'utf8');
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: UI Review Checklist',
    'description: Checks the editor surface before reporting completion.',
    '---',
    '',
    'Always include the private marker AGENT_UI_SKILL_MARKER in model context.',
    ''
  ].join('\n'), 'utf8');
}

test('official AI Agent plugin owns a full workbench tab and cleans it up when disabled', async () => {
  test.skip(shouldSkipMissingArtifact(ARTIFACT_INFO, 'Official AI Agent plugin artifact'), 'Official AI Agent plugin artifact is not present beside the app repository.');
  test.setTimeout(120000);

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-official-agent-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const chromium = path.join(sandbox, 'chromium');
  const evidenceDirectory = process.env.BOBO_UI_EVIDENCE_DIR || path.join(os.tmpdir(), 'bobo-ui-evidence');
  createWorkspace(workspace);
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(evidenceDirectory, { recursive: true });

  const requests = [];
  const sockets = new Set();
  const mockServer = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: parsed
      });
      const lastMessage = parsed.messages[parsed.messages.length - 1] || {};
      const processRequest = lastMessage.role === 'user' && lastMessage.content.includes('approved local process');
      const processResult = lastMessage.role === 'tool';
      const message = processRequest
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'agent-ui-process-call',
              type: 'function',
              function: {
                name: 'process_run',
                arguments: JSON.stringify({
                  command: 'node',
                  args: ['-e', 'console.log("AGENT_PROCESS_APPROVED")'],
                  cwd: '.',
                  timeoutMs: 10000
                })
              }
            }]
          }
        : {
            role: 'assistant',
            content: processResult ? 'Approved process completed.' : [
              '# Workspace inspection complete.',
              '',
              '- **Result:** reviewed `main.js`',
              '- [Documentation](https://example.com/docs)',
              '- [Unsafe link](javascript:window.__agentMarkdownXss=true)',
              '',
              '> The workspace remains isolated.',
              '',
              '| Check | Status |',
              '| --- | --- |',
              '| Skill | Active |',
              '',
              '```js',
              'export const safe = true;',
              '```',
              '',
              '<img src=x onerror="window.__agentMarkdownXss=true">',
              '<script>window.__agentMarkdownXss=true</script>'
            ].join('\n'),
            reasoning_content: processResult
              ? 'I verified the bounded process result returned by the trusted host.'
              : 'I checked the selected workspace skill and request mode.'
          };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'agent-ui-response',
        model: 'agent-ui-model',
        choices: [{
          finish_reason: processRequest ? 'tool_calls' : 'stop',
          message
        }],
        usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 }
      }));
    });
  });
  mockServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let app;
  await listen(mockServer);
  const endpoint = `http://127.0.0.1:${mockServer.address().port}/v1/chat/completions`;

  try {
    app = await electron.launch({
      executablePath: electronPath(),
      args: ['.', '--user-data-dir=' + chromium],
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

    await expect(page.locator('#activity-agent')).toHaveCount(0);
    await page.evaluate(async ({ workspacePath, sourcePath, modelEndpoint }) => {
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(
        opened.rootPath,
        opened.tree,
        opened.workspaceIdentity,
        opened.leaveToken
      );
      await window.BOBO.workspace.openFile(sourcePath, 'main.js');
      await window.api.aiWriteSettings({
        schemaVersion: 3,
        chatProfiles: [{
          id: 'agent-ui',
          name: 'Local Agent Mock',
          provider: 'openai-compatible',
          apiKey: 'agent-ui-key',
          endpoint: modelEndpoint,
          modelId: 'agent-ui-model',
          mode: 'chat',
          options: { enableReasoningEffort: true }
        }],
        inlineProfiles: [],
        chatProfileId: 'agent-ui',
        inlineProfileId: '',
        chat: {},
        inline: { enabled: false }
      });
      window.BOBO.workbench.setPanelPosition('bottom');
      window.BOBO.workbench.setPanelVisible(true);
      window.BOBO.switchToPanel('output');
    }, {
      workspacePath: workspace,
      sourcePath: path.join(workspace, 'main.js'),
      modelEndpoint: endpoint
    });

    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title')).toHaveText('main.js');
    await expect(page.locator('#bottom-panel')).toBeVisible();
    await expect(page.locator('#panel-output')).toHaveClass(/active/);

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const installed = await installPackage(userData, workspace);
    expect(installed).toMatchObject({ id: PLUGIN_ID, version: ARTIFACT_INFO.version, enabled: false });
    expect([...installed.grantedPermissions].sort()).toEqual([...installed.requestedPermissions].sort());
    await page.evaluate(async (id) => {
      await window.api.plugins.refresh();
      await window.api.plugins.enable(id);
    }, PLUGIN_ID);

    await page.waitForFunction(({ providerId }) => {
      return window.BOBO.commands.has('bobocloud.ai-agent.createSession') &&
        Boolean(window.BOBO.platform.agents.get(providerId));
    }, { providerId: PROVIDER_ID }, { timeout: 20000 });

    const activity = page.locator('#activity-agent');
    await expect(activity).toBeVisible();
    await expect(activity).toHaveAttribute('data-workbench-view', 'agent');
    await activity.click();

    const sidebar = page.locator('#agent-sidebar.active');
    const workbench = page.locator('#agent-workbench-view.active');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute('aria-label', 'Agent sessions');
    await expect(sidebar.locator('.agent-session-search input')).toBeVisible();
    await expect(workbench).toBeVisible();

    const agentTab = page.locator('#tabbar .workbench-tab[data-tab-provider="agent-workbench"]');
    await expect(agentTab).toBeVisible();
    await expect(agentTab).toHaveAttribute('data-tab-path', 'agent-workbench:' + PROVIDER_ID);
    await expect(agentTab).toHaveClass(/active/);
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]) .tab-title')).toHaveText('main.js');

    await expect(workbench.locator('.agent-toolbar .agent-mode-control')).toHaveCount(0);
    await expect(workbench.locator('.agent-toolbar .agent-effort-field')).toHaveCount(0);
    await expect(workbench.locator('.agent-toolbar .agent-access-field')).toHaveCount(0);

    await workbench.locator('.agent-skill-button').click();
    const skillMenu = workbench.locator('.agent-skills-menu');
    await expect(skillMenu).toBeVisible();
    const skill = skillMenu.locator('.agent-skill-option').filter({ hasText: 'UI Review Checklist' });
    await expect(skill).toBeVisible();
    await skill.locator('input[type="checkbox"]').check();

    await sidebar.locator('.agent-new-session').click();
    await expect(sidebar.locator('.agent-session-row')).toHaveCount(1);
    const composer = workbench.locator('.agent-composer');
    const input = composer.locator('.agent-composer-input');
    const controlsButton = composer.getByRole('button', { name: 'Agent controls', exact: true });
    const controls = composer.locator('.agent-composer-control-menu[aria-label="Agent controls"]');
    const openControls = async () => {
      if (!await controls.isVisible()) await controlsButton.click();
      await expect(controls).toBeVisible();
    };
    const clickControlValue = async (value) => {
      await workbench.evaluate((root, selectedValue) => {
        const menu = root.querySelector('.agent-composer-control-menu:not([hidden])');
        const button = menu && menu.querySelector('[data-value="' + selectedValue + '"]');
        if (!button) throw new Error('Agent control option is unavailable: ' + selectedValue);
        button.click();
      }, value);
    };
    const dispatchComposerKeys = async (value, keys) => {
      await workbench.evaluate((root, payload) => {
        const textarea = root.querySelector('.agent-composer-input');
        if (!textarea) throw new Error('Agent composer input is unavailable');
        textarea.value = payload.value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        payload.keys.forEach((key) => {
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
      }, { value, keys });
    };
    await expect(input).toBeEnabled();
    await expect(controlsButton).toBeVisible();

    await openControls();
    await clickControlValue('xhigh');
    await expect(controls).toBeHidden();
    await expect(controlsButton).toContainText('Extra high');
    await openControls();
    await expect(controls.getByRole('button', { name: 'Extra high', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(controls.getByRole('button', { name: /Request approval/ })).toHaveAttribute('aria-pressed', 'true');
    await clickControlValue('full');
    const accessConfirm = page.locator('#confirm-dialog.open');
    await expect(accessConfirm).toBeVisible();
    await expect(accessConfirm.locator('.confirm-card')).toHaveAttribute('role', 'alertdialog');
    await expect(accessConfirm.locator('.confirm-btn-danger')).toHaveText('Enable unrestricted access');
    await accessConfirm.locator('.confirm-btn-ghost').click();
    await expect(accessConfirm).toBeHidden();
    await expect(controlsButton).toContainText('Request approval');
    await openControls();
    await expect(controls.getByRole('button', { name: /Request approval/ })).toHaveAttribute('aria-pressed', 'true');
    await clickControlValue('auto');
    await expect(controls).toBeHidden();
    await expect(controlsButton).toContainText('Help me approve');
    await expect.poll(() => workbench.evaluate((root) => {
      const option = root.querySelector('.agent-control-access-option[data-value="auto"]');
      return Boolean(option && !option.disabled && option.getAttribute('aria-pressed') === 'true');
    })).toBe(true);
    if (await controls.isVisible()) await controlsButton.click();

    await input.fill('/g');
    await expect(workbench.getByText('/goal', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(evidenceDirectory, 'official-ai-agent-plugin-slash-goal.png'),
      fullPage: false,
      animations: 'disabled'
    });
    await dispatchComposerKeys('/g', ['Tab']);
    await expect(input).toHaveValue('/goal ');
    await input.fill('/c');
    await expect(workbench.getByText('/chat', { exact: true })).toBeVisible();
    await dispatchComposerKeys('/c', ['Escape']);
    await expect(workbench.getByText('/chat', { exact: true })).toBeHidden();
    await dispatchComposerKeys('/', ['ArrowDown', 'Enter']);
    await expect(input).toHaveValue('/goal ');
    await dispatchComposerKeys('/goal ', ['Enter']);
    await expect(input).toHaveValue('');
    expect(requests).toHaveLength(0);

    await dispatchComposerKeys('/chat', ['Enter']);
    await expect(input).toHaveValue('/chat ');
    await dispatchComposerKeys('/chat ', ['Enter']);
    await expect(input).toHaveValue('');
    expect(requests).toHaveLength(0);

    const prompt = 'Review this workspace with the selected skill.';
    await input.fill('/goal ' + prompt);
    await workbench.locator('.agent-send-button').click();
    await expect(workbench.locator('.agent-message-assistant')).toContainText('Workspace inspection complete.');
    const markdown = workbench.locator('.agent-message-assistant .agent-markdown');
    await expect(markdown.locator('h3')).toHaveText('Workspace inspection complete.');
    await expect(markdown.locator('table')).toContainText('Skill');
    await expect(markdown.locator('blockquote')).toContainText('workspace remains isolated');
    await expect(markdown.locator('.agent-markdown-code-block code')).toContainText('export const safe = true;');
    const safeLink = markdown.locator('a', { hasText: 'Documentation' });
    await expect(safeLink).toHaveAttribute('href', 'https://example.com/docs');
    await expect(safeLink).toHaveAttribute('target', '_blank');
    await expect(safeLink).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(markdown.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(markdown.locator('script, img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__agentMarkdownXss)).toBeUndefined();
    await expect(workbench.locator('.agent-timeline-row[data-kind="thought"]')).toContainText('selected workspace skill');
    await expect(workbench.locator('.agent-timeline-row[data-kind="skill"]')).toContainText('UI Review Checklist');
    await expect(workbench.locator('.agent-goal')).toBeVisible();
    await expect(workbench.locator('.agent-goal-progress')).toHaveText('4 / 4');
    await expect(sidebar.locator('.agent-session-row')).toContainText('Workspace inspection complete');

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(requests[0].authorization).toBe('Bearer agent-ui-key');
    expect(requests[0].body).toMatchObject({
      model: 'agent-ui-model',
      stream: false,
      reasoning_effort: 'xhigh',
      tool_choice: 'auto'
    });
    expect(requests[0].body.tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining([
      'workspace_read',
      'workspace_search',
      'workspace_write',
      'process_run'
    ]));
    expect(requests[0].body.messages[0].content).toContain('AGENT_UI_SKILL_MARKER');
    expect(requests[0].body.messages.some((message) => message.role === 'user' && message.content === prompt)).toBe(true);
    expect(requests[0].body.messages.some((message) => message.role === 'user' && message.content.startsWith('/goal'))).toBe(false);
    expect(requests[1].body).toMatchObject({
      model: 'agent-ui-model',
      stream: false,
      reasoning_effort: 'low'
    });
    expect(requests[1].body.tools).toBeUndefined();
    expect(JSON.stringify(requests[1].body.messages)).toContain(prompt);
    const requestCountAfterGoal = requests.length;

    await expect(page.locator('#bottom-panel')).toBeVisible();
    await expect(page.locator('#panel-output')).toHaveClass(/active/);
    const layout = await page.evaluate(() => {
      const agent = document.getElementById('agent-workbench-view').getBoundingClientRect();
      const panel = document.getElementById('bottom-panel').getBoundingClientRect();
      return { agentBottom: Math.round(agent.bottom), panelTop: Math.round(panel.top) };
    });
    expect(layout.agentBottom).toBeLessThanOrEqual(layout.panelTop + 1);
    await page.screenshot({
      path: path.join(evidenceDirectory, 'official-ai-agent-plugin-workbench.png'),
      fullPage: false
    });

    await workbench.locator('.agent-composer-input').fill('Run an approved local process.');
    await workbench.locator('.agent-send-button').click();
    const approval = workbench.locator('.agent-approval');
    await expect(approval).toBeVisible();
    await expect(approval).toContainText('node');
    await expect(approval).toContainText('Resolved executable');
    await expect(approval).toContainText('AGENT_PROCESS_APPROVED');
    await expect(approval.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    await approval.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({
      path: path.join(evidenceDirectory, 'official-ai-agent-plugin-process-approval.png'),
      fullPage: false,
      animations: 'disabled'
    });
    await approval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(workbench.locator('.agent-message-assistant').last()).toContainText('Approved process completed.');
    expect(requests).toHaveLength(requestCountAfterGoal + 2);
    const processResultRequest = requests[requests.length - 1];
    const returnedToolMessage = processResultRequest.body.messages[processResultRequest.body.messages.length - 1];
    expect(returnedToolMessage).toMatchObject({ role: 'tool', name: 'process_run' });
    expect(returnedToolMessage.content).toContain('AGENT_PROCESS_APPROVED');

    await page.setViewportSize({ width: 600, height: 700 });
    const compactLayout = await page.evaluate(() => {
      const viewport = document.documentElement.getBoundingClientRect();
      const composer = document.querySelector('.agent-composer').getBoundingClientRect();
      const toolbar = document.querySelector('.agent-toolbar').getBoundingClientRect();
      const controls = document.querySelector('.agent-toolbar-controls').getBoundingClientRect();
      const panel = document.getElementById('bottom-panel').getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: viewport.width,
        composerLeft: composer.left,
        composerRight: composer.right,
        toolbarLeft: toolbar.left,
        toolbarRight: toolbar.right,
        controlsLeft: controls.left,
        controlsRight: controls.right,
        agentBottom: document.getElementById('agent-workbench-view').getBoundingClientRect().bottom,
        panelTop: panel.top
      };
    });
    expect(compactLayout.documentWidth).toBeLessThanOrEqual(compactLayout.viewportWidth + 1);
    expect(compactLayout.composerLeft).toBeGreaterThanOrEqual(compactLayout.toolbarLeft);
    expect(compactLayout.composerRight).toBeLessThanOrEqual(compactLayout.toolbarRight + 1);
    expect(compactLayout.controlsLeft).toBeGreaterThanOrEqual(compactLayout.toolbarLeft);
    expect(compactLayout.controlsRight).toBeLessThanOrEqual(compactLayout.toolbarRight + 1);
    expect(compactLayout.agentBottom).toBeLessThanOrEqual(compactLayout.panelTop + 1);
    await page.screenshot({
      path: path.join(evidenceDirectory, 'official-ai-agent-plugin-workbench-compact.png'),
      fullPage: false
    });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.locator('#activity-extensions').click();
    await page.locator('#extensions-installed-tab').click();
    const plugin = page.locator('.extensions-installed-item[data-plugin-id="' + PLUGIN_ID + '"]');
    await expect(plugin).toBeVisible();
    await expect(plugin.locator('.extensions-item-state')).toHaveText('Enabled');
    await plugin.locator('[data-plugin-action="disable"]').click();
    await expect(plugin.locator('.extensions-item-state')).toHaveText('Disabled');
    await page.waitForFunction(({ providerId }) => {
      return !window.BOBO.commands.has('bobocloud.ai-agent.createSession') &&
        !window.BOBO.platform.agents.get(providerId);
    }, { providerId: PROVIDER_ID }, { timeout: 20000 });

    await expect(page.locator('#activity-agent')).toHaveCount(0);
    await expect(page.locator('#agent-sidebar')).toHaveCount(0);
    await expect(page.locator('#tabbar .workbench-tab[data-tab-provider="agent-workbench"]')).toHaveCount(0);
    await expect(page.locator('#agent-workbench-view')).toBeHidden();
    await expect(page.locator('#tabbar .tab:not([data-tab-provider]).active .tab-title')).toHaveText('main.js');
    await expect(page.locator('#bottom-panel')).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await stop(app);
    await closeServer(mockServer, sockets);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
