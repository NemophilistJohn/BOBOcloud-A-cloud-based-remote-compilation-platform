'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
let temporaryDirectory;
let core;

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function agentDescriptor(id = 'acme.agent.main') {
  const owner = id.split('.').slice(0, -1).join('.');
  return {
    id,
    title: 'Acme Agent',
    description: 'A local test Agent.',
    icon: 'sparkles',
    order: 20,
    commands: {
      create: owner + '.create',
      select: owner + '.select',
      delete: owner + '.delete',
      send: owner + '.send',
      cancel: owner + '.cancel',
      approve: owner + '.approve',
      reject: owner + '.reject',
      preferences: owner + '.preferences',
      configure: owner + '.configure'
    },
    capabilities: {
      modes: ['chat', 'goal'],
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      accessModes: ['ask', 'auto', 'full'],
      skills: true,
      localTools: true
    }
  };
}

function agentState() {
  return {
    phase: 'ready',
    message: '',
    activeSessionId: 'session-1',
    sessions: [{
      id: 'session-1',
      title: 'Inspect project',
      updatedAt: '2026-08-24T00:00:00.000Z',
      status: 'waiting-approval',
      mode: 'goal'
    }],
    models: [{
      ref: 'chat:local-model',
      name: 'Local model',
      provider: 'openai-compatible',
      modelId: 'model-1',
      purpose: 'chat',
      configured: true
    }],
    skills: [{
      id: 'skill-123',
      name: 'Review',
      description: 'Review the active workspace.',
      source: 'workspace',
      enabled: true
    }],
    activeSession: {
      id: 'session-1',
      title: 'Inspect project',
      status: 'waiting-approval',
      mode: 'goal',
      reasoningEffort: 'xhigh',
      accessMode: 'auto',
      modelRef: 'chat:local-model',
      messages: [{ id: 'message-1', role: 'user', content: 'Inspect this project.' }],
      timeline: [{ id: 'timeline-1', kind: 'tool', title: 'Write file', status: 'waiting' }],
      goal: {
        title: 'Inspect project',
        status: 'in-progress',
        steps: [{ id: 'step-1', title: 'Read source', status: 'completed' }]
      },
      approval: {
        id: 'approval-123'
      },
      compacting: false,
      compaction: {
        count: 1,
        compactedMessages: 8,
        estimatedTokensBefore: 12000,
        estimatedTokensAfter: 4000,
        compactedAt: '2026-08-25T00:00:00.000Z'
      }
    }
  };
}

function createExtensionSandboxHarness(options) {
  const sent = [];
  let disposed = false;
  const emit = (message) => options.onMessage({ protocolVersion: 1, ...message });
  return {
    ready: Promise.resolve(),
    sent,
    get disposed() { return disposed; },
    postMessage(message) {
      sent.push(message);
      if (message.type === 'initialize') queueMicrotask(() => emit({ type: 'activated' }));
      if (message.type === 'request' && message.method === 'extension.deactivate') {
        queueMicrotask(() => emit({ type: 'response', id: message.id, ok: true, value: null }));
      }
    },
    emit,
    dispose() { disposed = true; }
  };
}

function responseFor(sandbox, id) {
  return sandbox.sent.find((message) => message.type === 'response' && message.id === id);
}

test.before(async () => {
  temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-agent-api-'));
  const output = path.join(temporaryDirectory, 'core.cjs');
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['renderer/core/index.js'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'silent'
  });
  core = require(output);
});

test.after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('Plugin API 1.5 publishes the complete Agent permission set', () => {
  assert.equal(core.PLUGIN_API_VERSION, '1.5.0');
  assert.deepEqual([
    core.PluginPermission.AGENTS_REGISTER,
    core.PluginPermission.MODELS_GENERATE,
    core.PluginPermission.WORKSPACE_READ,
    core.PluginPermission.WORKSPACE_WRITE,
    core.PluginPermission.PROCESS_EXECUTE,
    core.PluginPermission.SKILLS_READ,
    core.PluginPermission.STORAGE_LOCAL
  ], [
    'agents.register',
    'models.generate',
    'workspace.read',
    'workspace.write',
    'process.execute',
    'skills.read',
    'storage.local'
  ]);

  const manifest = core.validatePluginManifest({
    id: 'acme.agent',
    version: '1.0.0',
    engines: { pluginApi: '^1.5.0' },
    permissions: Object.values(core.PluginPermission)
  });
  assert.equal(manifest.permissions.includes('agents.register'), true);
});

test('Agent descriptors, command payloads, and state snapshots are bounded data', () => {
  const descriptor = core.validateAgentDescriptor(agentDescriptor(), 'acme.agent');
  assert.equal(descriptor.id, 'acme.agent.main');
  assert.equal(descriptor.commands.send, 'acme.agent.send');
  assert.deepEqual(descriptor.capabilities.modes, ['chat', 'goal']);
  assert.deepEqual(descriptor.capabilities.accessModes, ['ask', 'auto', 'full']);
  assert.equal(Object.isFrozen(descriptor.commands), true);

  assert.throws(
    () => core.validateAgentDescriptor(agentDescriptor('other.agent.main'), 'acme.agent'),
    /extension namespace/
  );
  assert.throws(
    () => core.validateAgentDescriptor({ ...agentDescriptor(), html: '<button>unsafe</button>' }, 'acme.agent'),
    /unsupported field/
  );

  const state = core.validateAgentState(agentState());
  assert.equal(state.activeSession.goal.steps[0].status, 'completed');
  assert.deepEqual(state.activeSession.approval, { id: 'approval-123' });
  assert.equal(state.activeSession.accessMode, 'auto');
  assert.equal(state.activeSession.compaction.compactedMessages, 8);
  assert.equal(Object.isFrozen(state.activeSession.messages), true);
  assert.throws(
    () => core.validateAgentState({
      ...agentState(),
      activeSession: {
        ...agentState().activeSession,
        approval: { id: 'approval-123', summary: 'Plugin-controlled approval copy' }
      }
    }),
    /unsupported field/
  );
  assert.throws(
    () => core.validateAgentState({ ...agentState(), activeSessionId: 'another-session' }),
    /identity is inconsistent/
  );
  assert.throws(
    () => core.validateAgentState({ phase: 'ready', markup: '<p>unsafe</p>' }),
    /unsupported field/
  );

  assert.deepEqual(core.createAgentCommandPayload('acme.agent.main', 'send', {
    sessionId: 'session-1',
    text: 'Inspect this project.',
    mode: 'goal',
    reasoningEffort: 'xhigh',
    accessMode: 'auto',
    modelRef: 'chat:local-model',
    skillIds: ['skill-123'],
    ignored: 'not forwarded'
  }), {
    providerId: 'acme.agent.main',
    action: 'send',
    sessionId: 'session-1',
    text: 'Inspect this project.',
    mode: 'goal',
    reasoningEffort: 'xhigh',
    accessMode: 'auto',
    modelRef: 'chat:local-model',
    skillIds: ['skill-123']
  });

  const approvalResult = {
    approved: true,
    path: 'src/app.js',
    sha256: 'a'.repeat(64)
  };
  assert.deepEqual(core.createAgentCommandPayload('acme.agent.main', 'approve', {
    sessionId: 'session-1',
    approvalId: 'approval-123',
    approvalResult,
    ignored: 'not forwarded'
  }), {
    providerId: 'acme.agent.main',
    action: 'approve',
    sessionId: 'session-1',
    approvalId: 'approval-123',
    approvalResult
  });

  const boundedApproval = core.createAgentCommandPayload('acme.agent.main', 'approve', {
    approvalResult: {
      approved: true,
      tool: 'process_run',
      exitCode: 0,
      stdout: 'a'.repeat(96 * 1024),
      stderr: 'b'.repeat(96 * 1024),
      truncated: false,
      internalToken: 'must not be forwarded'
    }
  }).approvalResult;
  assert.equal(boundedApproval.internalToken, undefined);
  assert.equal(Buffer.byteLength(boundedApproval.stdout) + Buffer.byteLength(boundedApproval.stderr) <= 128 * 1024, true);
  assert.equal(boundedApproval.truncated, true);
  assert.deepEqual(core.createAgentCommandPayload('acme.agent.main', 'reject', {
    approvalId: 'approval-123',
    approvalResult: {
      approved: false,
      rejected: true,
      failed: true,
      tool: 'workspace_write',
      errorCode: 'AGENT_FILE_CHANGED',
      errorMessage: 'The file changed while approval was pending.',
      outcome: 'not-started',
      mayHaveExecuted: false,
      internalPath: 'must not be forwarded'
    }
  }).approvalResult, {
    approved: false,
    rejected: true,
    failed: true,
    tool: 'workspace_write',
    errorCode: 'AGENT_FILE_CHANGED',
    errorMessage: 'The file changed while approval was pending.',
    outcome: 'not-started',
    mayHaveExecuted: false
  });
  assert.deepEqual(core.createAgentCommandPayload('acme.agent.main', 'reject', {
    approvalId: 'approval-evicted',
    approvalResult: {
      approved: false,
      rejected: true,
      failed: true,
      errorCode: 'AGENT_APPROVAL_NOT_FOUND',
      errorMessage: 'The Agent approval is missing or no longer valid.',
      outcome: 'unknown',
      mayHaveExecuted: true
    }
  }).approvalResult, {
    approved: false,
    rejected: true,
    failed: true,
    errorCode: 'AGENT_APPROVAL_NOT_FOUND',
    errorMessage: 'The Agent approval is missing or no longer valid.',
    outcome: 'unknown',
    mayHaveExecuted: true
  });
  assert.throws(
    () => core.createAgentCommandPayload('acme.agent.main', 'reject', {
      approvalResult: {
        rejected: true,
        failed: true,
        errorCode: 'AGENT_OPERATION_FAILED',
        errorMessage: 'Operation failed.',
        outcome: 'unknown',
        mayHaveExecuted: true
      }
    }),
    /failure result is invalid/
  );
  assert.throws(
    () => core.createAgentCommandPayload('acme.agent.main', 'reject', {
      approvalResult: { rejected: true, failed: true, tool: 'workspace_write' }
    }),
    /failure result is invalid/
  );
  assert.throws(
    () => core.createAgentCommandPayload('acme.agent.main', 'reject', {
      approvalResult: {
        rejected: true,
        failed: true,
        tool: 'process_run',
        errorCode: 'AGENT_STALE_WORKSPACE',
        errorMessage: 'Workspace changed.',
        outcome: 'unknown',
        mayHaveExecuted: false
      }
    }),
    /failure result is invalid/
  );
  assert.throws(
    () => core.createAgentCommandPayload('acme.agent.main', 'approve', {
      approvalResult: { approved: true, sha256: 'not-a-sha256' }
    }),
    /sha256 is invalid/
  );
});

test('Agent state store isolates listener failures and disposes owner state', () => {
  const errors = [];
  const events = [];
  const store = new core.AgentStateStore({ onError: (event) => errors.push(event) });
  store.onDidChange((event) => events.push(event.type));
  store.onDidChange(() => { throw new Error('listener failed'); });
  const provider = store.register(agentDescriptor(), { owner: 'acme.agent' });

  assert.deepEqual(provider.setState(agentState()), { version: 1 });
  assert.equal(store.get(provider.id).state.activeSession.id, 'session-1');
  assert.deepEqual(provider.clearState(), { version: 2 });
  store.disposeOwner('acme.agent');

  assert.deepEqual(events, ['added', 'state', 'state', 'removed']);
  assert.equal(errors.length, 4);
  assert.equal(store.list().length, 0);
  assert.throws(() => provider.setState(agentState()), /disposed/);
  store.dispose();
});

test('trusted plugin runtime requires dedicated Agent registration and cleans it on deactivate', async () => {
  const platform = core.createRendererPlatform({ onError() {} });
  const manifest = {
    id: 'acme.agent',
    version: '1.0.0',
    engines: { pluginApi: '^1.5.0' },
    permissions: [core.PluginPermission.AGENTS_REGISTER]
  };
  const activated = await platform.plugins.activate(manifest, {
    activate(context) {
      const provider = context.agents.register(agentDescriptor());
      provider.setState(agentState());
    }
  });
  assert.equal(activated.ok, true);
  assert.equal(platform.agents.list().length, 1);
  assert.equal(platform.contributions.list(core.ContributionPoint.AGENTS).length, 1);
  assert.equal((await platform.plugins.deactivate('acme.agent')).ok, true);
  assert.equal(platform.agents.list().length, 0);
  assert.equal(platform.contributions.list(core.ContributionPoint.AGENTS).length, 0);

  const generic = await platform.plugins.activate({
    ...manifest,
    id: 'acme.generic-agent',
    permissions: [core.PluginPermission.CONTRIBUTIONS_REGISTER]
  }, {
    activate(context) {
      context.contributions.register(core.ContributionPoint.AGENTS, agentDescriptor('acme.generic-agent.main'));
    }
  });
  assert.equal(generic.ok, false);
  assert.equal(platform.agents.list().length, 0);
  await platform.dispose();
});

test('installed extension host gates Agent brokers and tears down Agent state', async () => {
  const platform = core.createRendererPlatform();
  const brokerCalls = [];
  let sandbox;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    agents: platform.agents,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker: async (id, method, args) => {
      brokerCalls.push({ id, method, args });
      if (method === 'agents.register') return { authorized: true };
      if (method === 'models.list') return { models: [] };
      if (method === 'models.cancel') return { success: true, cancelled: true };
      if (method === 'agent.tools.invoke') return { entries: [], truncated: false, workspaceIdentity: 1 };
      return { authorized: true };
    },
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options))
  });
  const descriptor = {
    id: 'acme.agent',
    revision: 'first',
    manifest: {
      id: 'acme.agent',
      version: '1.0.0',
      engines: { pluginApi: '^1.5.0' },
      permissions: [
        core.PluginPermission.AGENTS_REGISTER,
        core.PluginPermission.MODELS_GENERATE,
        core.PluginPermission.WORKSPACE_READ,
        core.PluginPermission.WORKSPACE_WRITE,
        core.PluginPermission.PROCESS_EXECUTE,
        core.PluginPermission.CONTRIBUTIONS_REGISTER
      ]
    },
    grantedPermissions: [
      core.PluginPermission.AGENTS_REGISTER,
      core.PluginPermission.MODELS_GENERATE,
      core.PluginPermission.WORKSPACE_READ,
      core.PluginPermission.WORKSPACE_WRITE,
      core.PluginPermission.PROCESS_EXECUTE,
      core.PluginPermission.CONTRIBUTIONS_REGISTER
    ]
  };
  assert.equal((await host.activate(descriptor)).ok, true);

  sandbox.emit({ type: 'request', id: 1, method: 'agents.register', args: agentDescriptor() });
  await nextTurn();
  const registration = responseFor(sandbox, 1);
  assert.equal(registration.ok, true);
  assert.equal(platform.agents.list().length, 1);

  sandbox.emit({
    type: 'request',
    id: 2,
    method: 'agents.setState',
    args: { handle: registration.value.handle, state: agentState() }
  });
  sandbox.emit({
    type: 'request',
    id: 3,
    method: 'agent.broker.request',
    args: { method: 'models.list', args: {} }
  });
  sandbox.emit({
    type: 'request',
    id: 4,
    method: 'agent.broker.request',
    args: { method: 'models.cancel', args: { requestId: 'turn-1' } }
  });
  sandbox.emit({
    type: 'request',
    id: 5,
    method: 'agent.broker.request',
    args: { method: 'agent.tools.invoke', args: { tool: 'workspace_list', input: { path: '.' } } }
  });
  sandbox.emit({
    type: 'request',
    id: 6,
    method: 'agent.broker.request',
    args: { method: 'agent.tools.invoke', args: { tool: 'process_run', input: { command: 'node', args: ['--version'] } } }
  });
  sandbox.emit({
    type: 'request',
    id: 7,
    method: 'contributions.register',
    args: { point: 'agents', contribution: agentDescriptor(), options: { id: 'acme.agent.main' } }
  });
  sandbox.emit({
    type: 'request',
    id: 8,
    method: 'agent.broker.request',
    args: { method: 'agent.tools.approve', args: { approvalId: 'approval-process' } }
  });
  sandbox.emit({
    type: 'request',
    id: 9,
    method: 'agent.broker.request',
    args: { method: 'agent.tools.reject', args: { approvalId: 'approval-process' } }
  });
  sandbox.emit({
    type: 'request',
    id: 10,
    method: 'agent.broker.request',
    args: { method: 'agent.tools.cancel', args: { approvalId: 'approval-process' } }
  });
  await nextTurn();
  await nextTurn();

  assert.equal(responseFor(sandbox, 2).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(responseFor(sandbox, 3).value)), { models: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(responseFor(sandbox, 4).value)), { success: true, cancelled: true });
  assert.equal(responseFor(sandbox, 5).ok, true);
  assert.equal(responseFor(sandbox, 6).ok, true);
  assert.equal(responseFor(sandbox, 7).error.code, core.ExtensionErrorCode.DENIED);
  assert.equal(responseFor(sandbox, 8).error.code, core.ExtensionErrorCode.DENIED);
  assert.equal(responseFor(sandbox, 9).error.code, core.ExtensionErrorCode.DENIED);
  assert.equal(responseFor(sandbox, 10).error.code, core.ExtensionErrorCode.DENIED);
  assert.deepEqual(brokerCalls.filter((call) => call.method.startsWith('models.')).map((call) => call.method), [
    'models.list',
    'models.cancel'
  ]);

  assert.equal((await host.deactivate('acme.agent')).ok, true);
  assert.equal(platform.agents.list().length, 0);
  assert.equal(sandbox.disposed, true);
  await platform.dispose();
});

test('extension sandbox exposes only dedicated Agent data APIs', () => {
  const source = core.buildExtensionSandboxDocument();
  assert.match(source, /agents: freeze/);
  assert.match(source, /const safeFreeze = Object\.freeze/);
  assert.match(source, /models\.cancel/);
  assert.match(source, /agent\.tools\.invoke/);
  assert.doesNotMatch(source, /agent\.tools\.(?:approve|reject|cancel)/);
  assert.match(source, /agent\.skills\.read/);
  assert.match(source, /agent\.storage\.write/);
  assert.doesNotMatch(source, /window\.api/);
  assert.doesNotMatch(source, /child_process/);
});
