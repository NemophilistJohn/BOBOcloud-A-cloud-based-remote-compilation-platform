'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAgentPlatformBroker, ALLOWED_COMMANDS } = require('../main/agent-platform');

async function createHarness(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-agent-platform-'));
  const workspace = path.join(root, 'workspace');
  const userData = path.join(root, 'user-data');
  const home = path.join(root, 'home');
  await Promise.all([
    fsp.mkdir(workspace, { recursive: true }),
    fsp.mkdir(userData, { recursive: true }),
    fsp.mkdir(home, { recursive: true })
  ]);
  const workspaceState = { rootPath: workspace, workspaceIdentity: 1 };
  const modelRequests = [];
  const cancellations = [];
  const notifications = [];
  const brokerOptions = {
    app: {
      getPath(name) {
        if (name === 'userData') return userData;
        if (name === 'home') return home;
        throw new Error('Unexpected app path: ' + name);
      }
    },
    settings: {
      async readAiSettings() {
        return {
          chatProfiles: [{
            id: 'chat-local',
            name: 'Local Chat',
            provider: 'openai-compatible',
            endpoint: 'https://example.invalid/v1/chat/completions',
            apiKey: 'host-secret-key',
            modelId: 'model-local'
          }],
          inlineProfiles: []
        };
      }
    },
    getWorkspaceIdentity: () => ({ ...workspaceState }),
    requestModel: async (request) => {
      modelRequests.push(request);
      return {
        success: true,
        data: {
          choices: [{
            message: {
              content: 'Done',
              reasoning_content: 'Checked the workspace.',
              tool_calls: [{ id: 'call-1', function: { name: 'workspace_read', arguments: '{"path":"src/app.js"}' } }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { total_tokens: 12 }
        }
      };
    },
    cancelModel: (requestId) => {
      cancellations.push(requestId);
      return { success: true, cancelled: true };
    }
  };
  if (options.notifyWorkspaceFiles === true) {
    brokerOptions.notifyWorkspaceFiles = (events) => notifications.push(...events);
  }
  const broker = createAgentPlatformBroker(brokerOptions);
  t.after(async () => {
    broker.dispose();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, workspace, userData, home, workspaceState, modelRequests, cancellations, notifications, broker };
}

test('Agent model broker exposes opaque refs, retains credentials, and scopes cancellation', async (t) => {
  const harness = await createHarness(t);
  const listed = await harness.broker.request('acme.agent', 'models.list', {});
  assert.deepEqual(listed, {
    models: [{
      ref: 'chat:chat-local',
      purpose: 'chat',
      name: 'Local Chat',
      provider: 'openai-compatible',
      modelId: 'model-local',
      configured: true
    }]
  });
  assert.equal(JSON.stringify(listed).includes('host-secret-key'), false);
  assert.equal(JSON.stringify(listed).includes('example.invalid'), false);

  const generated = await harness.broker.request('acme.agent', 'models.generate', {
    modelRef: 'chat:chat-local',
    requestId: 'turn-1',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: 'Inspect the project.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'workspace_read',
        description: 'Read a workspace file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      }
    }]
  });
  assert.equal(generated.content, 'Done');
  assert.equal(generated.reasoning, 'Checked the workspace.');
  assert.deepEqual(generated.toolCalls, [{
    id: 'call-1',
    name: 'workspace_read',
    arguments: '{"path":"src/app.js"}'
  }]);
  assert.equal(harness.modelRequests.length, 1);
  assert.equal(harness.modelRequests[0].modelConfig.apiKey, 'host-secret-key');
  assert.match(harness.modelRequests[0].requestId, /^agent-[a-f0-9]{16}-turn-1$/);

  await harness.broker.request('acme.agent', 'models.generate', {
    modelRef: 'chat:chat-local',
    requestId: 'turn-xhigh',
    reasoningEffort: 'xhigh',
    messages: [{ role: 'user', content: 'Inspect more deeply.' }]
  });
  assert.equal(harness.modelRequests[1].reasoningEffort, 'xhigh');
  assert.equal(harness.modelRequests[1].maxTokens, 12288);

  assert.deepEqual(await harness.broker.request('acme.agent', 'models.cancel', { requestId: 'turn-1' }), {
    success: true,
    cancelled: true
  });
  assert.equal(harness.cancellations[0], harness.modelRequests[0].requestId);
  await harness.broker.request('other.agent', 'models.cancel', { requestId: 'turn-1' });
  assert.notEqual(harness.cancellations[1], harness.cancellations[0]);
});

test('Agent workspace, Skill, and storage brokers keep paths and state scoped', async (t) => {
  const harness = await createHarness(t);
  await fsp.mkdir(path.join(harness.workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(harness.workspace, 'src', 'app.js'), 'const value = 42;\n', 'utf8');
  const skillDirectory = path.join(harness.workspace, '.agents', 'skills', 'review');
  await fsp.mkdir(skillDirectory, { recursive: true });
  await fsp.writeFile(path.join(skillDirectory, 'SKILL.md'), [
    '---',
    'name: Workspace Review',
    'description: Review local source safely.',
    '---',
    '',
    '# Review',
    ''
  ].join('\n'), 'utf8');

  const listed = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_list',
    input: { path: '.', depth: 2, limit: 50 }
  });
  assert.ok(listed.entries.some((entry) => entry.path === 'src/app.js'));
  assert.equal(JSON.stringify(listed).includes(harness.workspace), false);

  const read = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_read', input: { path: 'src/app.js' }
  });
  assert.equal(read.content, 'const value = 42;\n');
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  const searched = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_search', input: { query: 'value = 42' }
  });
  assert.deepEqual(searched.results.map((entry) => [entry.path, entry.line]), [['src/app.js', 1]]);
  await assert.rejects(
    () => harness.broker.request('acme.agent', 'agent.tools.invoke', {
      tool: 'workspace_read', input: { path: '../outside.txt' }
    }),
    { code: 'AGENT_INVALID_PATH' }
  );

  const skills = await harness.broker.request('acme.agent', 'agent.skills.list', {});
  const skill = skills.skills.find((entry) => entry.name === 'Workspace Review');
  assert.ok(skill);
  assert.match(skill.id, /^skill-[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(skill).includes('SKILL.md'), false);
  assert.equal(JSON.stringify(skill).includes(harness.workspace), false);
  const document = await harness.broker.request('acme.agent', 'agent.skills.read', { skillId: skill.id });
  assert.match(document.content, /# Review/);
  assert.equal(JSON.stringify(document).includes(harness.workspace), false);

  assert.deepEqual(await harness.broker.request('acme.agent', 'agent.storage.read', {}), { value: {} });
  assert.equal((await harness.broker.request('acme.agent', 'agent.storage.write', {
    value: { sessions: [{ id: 'session-1' }], preferences: { effort: 'high' } }
  })).saved, true);
  assert.deepEqual((await harness.broker.request('acme.agent', 'agent.storage.read', {})).value.preferences, { effort: 'high' });
  assert.deepEqual(await harness.broker.request('other.agent', 'agent.storage.read', {}), { value: {} });

  const silentWrite = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write', input: { path: 'src/generated.txt', content: 'created without an optional notifier\n' }
  });
  assert.equal((await harness.broker.decideApproval('acme.agent', silentWrite.approval.id, true)).approved, true);
  assert.equal(await fsp.readFile(path.join(harness.workspace, 'src', 'generated.txt'), 'utf8'), 'created without an optional notifier\n');
});

test('Agent workspace searches stop at plugin and workspace lifecycle boundaries', async (t) => {
  const harness = await createHarness(t);
  await fsp.writeFile(path.join(harness.workspace, 'one.txt'), 'searchable text\n', 'utf8');

  const disabledSearch = harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_search', input: { query: 'not-present', limit: 500 }
  });
  harness.broker.disposePlugin('acme.agent');
  await assert.rejects(disabledSearch, { code: 'AGENT_CANCELLED' });

  const switchedSearch = harness.broker.request('other.agent', 'agent.tools.invoke', {
    tool: 'workspace_search', input: { query: 'not-present', limit: 500 }
  });
  harness.broker.workspaceChanged();
  await assert.rejects(switchedSearch, { code: 'AGENT_CANCELLED' });
});

test('trusted Agent access modes apply the host risk matrix without accepting Worker escalation', async (t) => {
  const harness = await createHarness(t);
  await fsp.mkdir(path.join(harness.workspace, 'src'), { recursive: true });
  const identity = { providerId: 'acme.agent.main', sessionId: 'session-one' };

  assert.deepEqual(harness.broker.getAccessMode('acme.agent', identity), {
    pluginId: 'acme.agent',
    providerId: 'acme.agent.main',
    sessionId: 'session-one',
    accessMode: 'ask'
  });
  const forged = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write',
    accessMode: 'full',
    sessionId: 'forged-session',
    input: { path: 'src/forged.txt', content: 'must ask\n', accessMode: 'full' }
  });
  assert.equal(forged.approvalRequired, true);
  assert.equal(forged.approval.accessMode, 'ask');
  assert.equal(forged.approval.riskLevel, 'medium');
  await harness.broker.decideApproval('acme.agent', forged.approval.id, false);

  assert.deepEqual(harness.broker.setAccessMode('acme.agent', { ...identity, accessMode: 'auto' }), {
    pluginId: 'acme.agent',
    providerId: 'acme.agent.main',
    sessionId: 'session-one',
    accessMode: 'auto'
  });
  const automaticWrite = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write', input: { path: 'src/automatic.txt', content: 'automatic\n' }
  });
  assert.equal(automaticWrite.approved, true);
  assert.equal(automaticWrite.autoApproved, true);
  assert.equal(automaticWrite.accessMode, 'auto');
  assert.equal(automaticWrite.riskLevel, 'medium');

  const sensitiveAuto = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write', input: { path: '.env.local', content: 'SECRET=value\n' }
  });
  assert.equal(sensitiveAuto.approvalRequired, true);
  assert.equal(sensitiveAuto.approval.riskLevel, 'high');
  assert.equal(sensitiveAuto.approval.accessMode, 'auto');
  assert.equal(harness.broker.describeApproval('acme.agent', sensitiveAuto.approval.id).riskLevel, 'high');
  await harness.broker.decideApproval('acme.agent', sensitiveAuto.approval.id, false);

  const inspection = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'process_run', input: { command: 'node', args: ['--version'], cwd: '.' }
  });
  assert.equal(inspection.autoApproved, true);
  assert.equal(inspection.riskLevel, 'low');
  const executableAuto = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'process_run', input: { command: 'node', args: ['-e', 'process.stdout.write("unsafe")'], cwd: '.' }
  });
  assert.equal(executableAuto.approvalRequired, true);
  assert.equal(executableAuto.approval.riskLevel, 'high');
  await harness.broker.decideApproval('acme.agent', executableAuto.approval.id, false);

  assert.throws(
    () => harness.broker.setAccessMode('acme.agent', { ...identity, accessMode: 'full' }),
    { code: 'AGENT_FULL_ACCESS_CONFIRMATION_REQUIRED' }
  );
  harness.broker.setAccessMode('acme.agent', { ...identity, accessMode: 'full', confirmed: true });
  const fullWrite = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write', input: { path: '.env.local', content: 'SECRET=value\n' }
  });
  assert.equal(fullWrite.autoApproved, true);
  assert.equal(fullWrite.accessMode, 'full');
  assert.equal(fullWrite.riskLevel, 'high');

  assert.equal(harness.broker._test.classifyWorkspaceWriteRisk({ path: 'src/app.js' }), 'medium');
  assert.equal(harness.broker._test.classifyWorkspaceWriteRisk({ path: '.github/workflows/ci.yml' }), 'high');
  assert.equal(harness.broker._test.classifyProcessRisk({ command: 'git', args: ['status'] }), 'low');
  assert.equal(harness.broker._test.classifyProcessRisk({ command: 'git', args: ['push'] }), 'high');

  harness.broker.setAccessMode('acme.agent', { ...identity, accessMode: 'full', confirmed: true });
  const downgradeRace = harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'process_run', input: { command: 'node', args: ['--version'], cwd: '.' }
  });
  harness.broker.setAccessMode('acme.agent', { ...identity, accessMode: 'ask' });
  const downgraded = await downgradeRace;
  assert.equal(downgraded.approvalRequired, true);
  assert.equal(downgraded.approval.accessMode, 'ask');
  await harness.broker.decideApproval('acme.agent', downgraded.approval.id, false);

  harness.broker.setAccessMode('acme.agent', { ...identity, accessMode: 'full', confirmed: true });
  assert.deepEqual(harness.broker.clearAccessMode('acme.agent', identity), {
    pluginId: 'acme.agent',
    ...identity,
    accessMode: 'ask'
  });
  assert.equal(harness.broker.getAccessMode('acme.agent', identity).accessMode, 'ask');
  const cleared = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write', input: { path: '.env.cleared', content: 'TOKEN=cleared\n' }
  });
  assert.equal(cleared.approvalRequired, true);
  assert.equal(cleared.approval.accessMode, 'ask');
  await harness.broker.decideApproval('acme.agent', cleared.approval.id, false);

  harness.broker.disposePlugin('acme.agent');
  assert.equal(harness.broker.getAccessMode('acme.agent', identity).accessMode, 'ask');
  harness.broker.setAccessMode('acme.agent', { ...identity, accessMode: 'auto' });
  harness.broker.workspaceChanged();
  assert.equal(harness.broker.getAccessMode('acme.agent', identity).accessMode, 'ask');
});

test('Agent writes and processes require scoped approvals and structured execution', async (t) => {
  const harness = await createHarness(t, { notifyWorkspaceFiles: true });
  await fsp.mkdir(path.join(harness.workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(harness.workspace, 'src', 'app.js'), 'before\n', 'utf8');
  const current = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_read', input: { path: 'src/app.js' }
  });
  const pending = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write',
    input: { path: 'src/app.js', content: 'after\n', expectedSha256: current.sha256 }
  });
  assert.equal(pending.approvalRequired, true);
  const described = harness.broker.describeApproval('acme.agent', pending.approval.id);
  assert.equal(described.permission, 'workspace.write');
  assert.equal(described.details.path, 'src/app.js');
  assert.equal(described.details.expectedSha256, current.sha256);
  assert.equal(described.details.contentPreview, 'after\n');
  assert.throws(
    () => harness.broker.describeApproval('other.agent', pending.approval.id),
    { code: 'AGENT_APPROVAL_NOT_FOUND' }
  );
  assert.equal(harness.broker.describeApproval('acme.agent', pending.approval.id).approvalId, pending.approval.id);
  for (const method of ['agent.tools.approve', 'agent.tools.reject', 'agent.tools.cancel']) {
    await assert.rejects(
      () => harness.broker.request('acme.agent', method, { approvalId: pending.approval.id }),
      { code: 'AGENT_METHOD_DENIED' }
    );
  }
  const written = await harness.broker.decideApproval('acme.agent', pending.approval.id, true);
  assert.equal(written.approved, true);
  assert.equal(await fsp.readFile(path.join(harness.workspace, 'src', 'app.js'), 'utf8'), 'after\n');
  assert.equal(harness.notifications.length, 1);
  await assert.rejects(
    () => harness.broker.decideApproval('acme.agent', pending.approval.id, true),
    { code: 'AGENT_APPROVAL_NOT_FOUND' }
  );

  const conflict = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write',
    input: { path: 'src/app.js', content: 'agent\n', expectedSha256: written.sha256 }
  });
  await fsp.writeFile(path.join(harness.workspace, 'src', 'app.js'), 'user\n', 'utf8');
  await assert.rejects(
    () => harness.broker.decideApproval('acme.agent', conflict.approval.id, true),
    { code: 'AGENT_FILE_CHANGED' }
  );

  const userVersion = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_read', input: { path: 'src/app.js' }
  });
  const rejected = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'workspace_write', input: { path: 'src/app.js', content: 'rejected\n', expectedSha256: userVersion.sha256 }
  });
  assert.deepEqual(await harness.broker.decideApproval('acme.agent', rejected.approval.id, false), {
    rejected: true,
    tool: 'workspace_write'
  });
  assert.equal(await fsp.readFile(path.join(harness.workspace, 'src', 'app.js'), 'utf8'), 'user\n');

  const cancellable = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'process_run', input: { command: 'node', args: ['--version'], cwd: '.' }
  });
  assert.deepEqual(harness.broker.cancelApproval('other.agent', cancellable.approval.id), { cancelled: false });
  assert.equal(harness.broker.describeApproval('acme.agent', cancellable.approval.id).permission, 'process.execute');
  assert.deepEqual(harness.broker.cancelApproval('acme.agent', cancellable.approval.id), { cancelled: true });
  assert.throws(
    () => harness.broker.describeApproval('acme.agent', cancellable.approval.id),
    { code: 'AGENT_APPROVAL_NOT_FOUND' }
  );

  assert.equal(ALLOWED_COMMANDS.has('node'), true);
  await assert.rejects(
    () => harness.broker.request('acme.agent', 'agent.tools.invoke', {
      tool: 'process_run', input: { command: 'node && echo unsafe', args: [] }
    }),
    { code: 'AGENT_COMMAND_DENIED' }
  );
  const processApproval = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'process_run',
    input: {
      command: 'node',
      args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),secret:process.env.BOBO_AGENT_TEST_SECRET||""}))'],
      cwd: '.',
      timeoutMs: 10_000
    }
  });
  const describedProcess = harness.broker.describeApproval('acme.agent', processApproval.approval.id);
  assert.equal(describedProcess.permission, 'process.execute');
  assert.equal(describedProcess.details.command, 'node');
  assert.equal(describedProcess.details.cwd, '.');
  process.env.BOBO_AGENT_TEST_SECRET = 'must-not-leak';
  try {
    const processResult = await harness.broker.decideApproval('acme.agent', processApproval.approval.id, true);
    assert.equal(processResult.exitCode, 0);
    assert.deepEqual(JSON.parse(processResult.stdout), { cwd: harness.workspace, secret: '' });
    assert.equal(processResult.timedOut, false);
    assert.equal(processResult.cancelled, false);
  } finally {
    delete process.env.BOBO_AGENT_TEST_SECRET;
  }

  const staleProcess = await harness.broker.request('acme.agent', 'agent.tools.invoke', {
    tool: 'process_run', input: { command: 'node', args: ['--version'], cwd: '.' }
  });
  harness.workspaceState.workspaceIdentity += 1;
  await assert.rejects(
    () => harness.broker.decideApproval('acme.agent', staleProcess.approval.id, true),
    { code: 'AGENT_STALE_WORKSPACE' }
  );
});
