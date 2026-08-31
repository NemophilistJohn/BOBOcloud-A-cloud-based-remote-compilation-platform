'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..');

function loadWorkbench(options = {}) {
  const calls = [];
  const eventListeners = new Map();
  const descriptor = {
    id: 'acme.agent.main',
    title: 'Test Agent',
    commands: {
      configure: 'acme.agent.configure',
      approve: 'acme.agent.approve',
      reject: 'acme.agent.reject'
    },
    capabilities: { modes: ['chat'], reasoningEfforts: ['medium'], skills: false, localTools: false }
  };
  const record = { id: descriptor.id, owner: 'acme.agent', descriptor, state: options.state || null };
  const addEventListener = (type, listener) => {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type).add(listener);
  };
  const removeEventListener = (type, listener) => {
    const listeners = eventListeners.get(type);
    if (listeners) listeners.delete(listener);
  };
  const sandbox = {
    console,
    Promise,
    Map,
    Set,
    TextEncoder,
    setTimeout,
    clearTimeout,
    marked,
    api: options.api || {},
    window: null,
    document: {
      documentElement: { getAttribute: () => '' },
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; }
    },
    BOBO: {
      state: { tabs: [], activeTabPath: null, currentViewMode: 'single' },
      aiSettingsCenter: {
        open(section) { calls.push({ type: 'settings', section }); }
      },
      platform: {
        agents: {
          list: () => [record],
          get: (id) => id === record.id ? record : null,
          onDidChange: () => ({ dispose() {} }),
          createCommandPayload: (providerId, action, values) => ({ providerId, action, values })
        },
        commands: {
          async executeIsolated(command, payload) {
            calls.push({ type: 'command', command, payload });
            if (typeof options.executeIsolated === 'function') return options.executeIsolated(command, payload, calls);
            return { ok: true, value: null };
          }
        }
      }
    },
    addEventListener,
    removeEventListener,
    dispatchEvent(event) {
      const listeners = eventListeners.get(event && event.type);
      if (listeners) Array.from(listeners).forEach((listener) => listener(event));
    }
  };
  sandbox.__skipAgentRender = options.exposeApprovalInternals === true;
  sandbox.window = sandbox;
  let source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8')
    .replace(/^import \{ marked \} from 'marked';\s*/, '');
  if (options.exposeApprovalInternals === true) {
    source = source
      .replace('  function renderAll() {\n', '  function renderAll() {\n    if (global.__skipAgentRender === true) return;\n')
      .replace('    page();\n    if (BOBO.workspace && BOBO.workspace.registerWorkbenchTabProvider) {', '    if (global.__skipAgentRender !== true) page();\n    if (BOBO.workspace && BOBO.workspace.registerWorkbenchTabProvider) {')
      .replace(/\}\)\(window\);\s*$/, [
        '  BOBO.__agentApprovalTest = Object.freeze({',
        '    approvalKey: approvalKey,',
        '    approvalDetails: approvalDetails,',
        '    approvalDecisions: approvalDecisions,',
        '    approvalExpiryTimers: approvalExpiryTimers,',
        '    deliverApprovalDecision: deliverApprovalDecision',
        '  });',
        '})(window);',
        ''
      ].join('\n'));
  }
  vm.runInNewContext(source, sandbox, { filename: 'src/agent-workbench.js' });
  return { sandbox, calls, record, eventListeners };
}

function pendingApprovalState(approvalId) {
  return {
    activeSessionId: 'session-1',
    activeSession: {
      id: 'session-1',
      approval: { id: approvalId }
    }
  };
}

function approvalDetail(approvalId, expiresAt) {
  return {
    approvalId,
    tool: 'process_run',
    summary: 'Run node --version',
    expiresAt,
    details: {
      command: 'node',
      resolvedExecutable: 'node',
      args: ['--version'],
      cwd: '.',
      timeoutMs: 10_000
    }
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for Agent approval lifecycle state.');
}

test('Agent configuration opens host AI Connections and refreshes the provider catalog', async () => {
  const runtime = loadWorkbench();
  await runtime.sandbox.BOBO.agentWorkbench.openConfiguration(runtime.record.id);

  assert.deepEqual(runtime.calls[0], { type: 'settings', section: 'connections' });
  assert.equal(runtime.calls[1].type, 'command');
  assert.equal(runtime.calls[1].command, 'acme.agent.configure');
  assert.equal(runtime.calls[1].payload.providerId, runtime.record.id);
  assert.equal(runtime.calls[1].payload.action, 'configure');
});

test('refreshModels asks every registered provider to reload model references', async () => {
  const runtime = loadWorkbench();
  const result = await runtime.sandbox.BOBO.agentWorkbench.refreshModels();

  assert.deepEqual(Array.from(result), [true]);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].command, 'acme.agent.configure');
});

test('Agent workbench is bundled and styled as an editor-peer page', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'renderer', 'entry.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'agent-workbench.css'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8');

  assert.match(entry, /import '\.\.\/src\/agent-workbench\.js';/);
  assert.match(html, /styles\/agent-workbench\.css/);
  assert.match(css, /\.agent-workbench-view\s*\{[\s\S]*position:\s*absolute/);
  assert.match(source, /data-workbench-view/);
  assert.match(source, /registerWorkbenchTabProvider/);
  assert.doesNotMatch(source, /window\.api|innerHTML\s*=/);
});

test('saving host AI connections refreshes Agent model catalogs', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'ai-settings-center.js'), 'utf8');
  assert.match(settings, /BOBO\.agentWorkbench\.refreshModels\(\)/);
});

test('Agent approvals render and execute only host-canonical details', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'agent-workbench.css'), 'utf8');

  assert.match(source, /api && api\.pluginsAgentApprovalDescribe/);
  assert.match(source, /describe\(\{ pluginId: record\.owner, approvalId: approval\.id \}\)/);
  assert.match(source, /pluginsAgentApprovalDecide\(\{ pluginId: record\.owner, approvalId: approvalId, approved: approved \}\)/);
  assert.match(source, /pluginsAgentApprovalCancel\(\{ pluginId: record\.owner, approvalId: approvalId \}\)/);
  assert.match(source, /approvalResult: decision\.approvalResult/);
  assert.match(source, /approved && decision\.approvalResult\.failed !== true \? 'approve' : 'reject'/);
  assert.match(source, /result\.failed === true[\s\S]*result\.rejected !== true/);
  assert.match(source, /value\.approvalUnavailable === true[\s\S]*AGENT_APPROVAL_EXPIRED[\s\S]*AGENT_APPROVAL_NOT_FOUND/);
  assert.match(source, /entry\.status = 'terminal'[\s\S]*action: 'reject'[\s\S]*canonicalApprovalResult\(value, entry, true\)/);
  assert.match(source, /allowMissingTool: true/);
  assert.match(source, /outcome: unknown \? 'unknown' : 'not-started'/);
  assert.match(source, /result\.value\.accepted !== true/);
  assert.match(source, /decision\.status = 'delivery-failed'/);
  assert.match(source, /deliverApprovalDecision\(record, key, decision\)/);
  const deliveryStart = source.indexOf('async function deliverApprovalDecision(');
  const deliveryEnd = source.indexOf('\n  async function ', deliveryStart + 1);
  assert.ok(deliveryStart >= 0 && deliveryEnd > deliveryStart);
  assert.doesNotMatch(source.slice(deliveryStart, deliveryEnd), /pluginsAgentApprovalDecide/);
  assert.match(source, /approve\.disabled = !detail \|\| Boolean\(decision\)/);
  assert.match(source, /reject\.disabled = !detail \|\| Boolean\(decision\)/);
  assert.match(source, /t\('Loading approval details'\)/);
  assert.match(source, /resolvedExecutable/);
  assert.match(source, /cancelled: true,[\s\S]*tool: cached/);
  assert.doesNotMatch(source, /approval\.(?:summary|risk|tool|expiresAt)/);
  assert.match(css, /\.agent-approval-details/);
  assert.match(css, /\.agent-approval-preview/);
});

test('ready Agent approvals terminate without a click after a workspace change', async (t) => {
  const approvalId = 'approval-workspace-change';
  let unavailable = false;
  let describeCalls = 0;
  const runtime = loadWorkbench({
    state: pendingApprovalState(approvalId),
    exposeApprovalInternals: true,
    api: {
      async pluginsAgentApprovalDescribe() {
        describeCalls += 1;
        return unavailable
          ? {
              approvalUnavailable: true,
              tool: 'process_run',
              errorCode: 'AGENT_APPROVAL_NOT_FOUND',
              errorMessage: 'The Agent approval is missing or no longer valid.'
            }
          : approvalDetail(approvalId, new Date(Date.now() + 60_000).toISOString());
      }
    },
    executeIsolated: async () => ({ ok: true, value: { accepted: true } })
  });
  t.after(() => runtime.sandbox.BOBO.agentWorkbench.dispose());
  runtime.sandbox.BOBO.agentWorkbench.init();
  const key = runtime.sandbox.BOBO.__agentApprovalTest.approvalKey(runtime.record, approvalId);
  await waitFor(() => runtime.sandbox.BOBO.__agentApprovalTest.approvalDetails.get(key)?.status === 'ready');

  unavailable = true;
  runtime.sandbox.dispatchEvent({ type: 'bobo:workspace-changed' });
  await waitFor(() => runtime.sandbox.BOBO.__agentApprovalTest.approvalDecisions.get(key)?.status === 'delivered');

  const deliveries = runtime.calls.filter((call) => call.type === 'command' && call.command === 'acme.agent.reject');
  assert.equal(describeCalls, 2);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(deliveries[0].payload.values.approvalResult)), {
    approved: false,
    rejected: true,
    failed: true,
    tool: 'process_run',
    errorCode: 'AGENT_APPROVAL_NOT_FOUND',
    errorMessage: 'The Agent approval is missing or no longer valid.',
    outcome: 'unknown',
    mayHaveExecuted: true
  });
});

test('ready Agent approvals recheck canonical expiry and deliver one terminal result', async (t) => {
  const approvalId = 'approval-expiry';
  let describeCalls = 0;
  const runtime = loadWorkbench({
    state: pendingApprovalState(approvalId),
    exposeApprovalInternals: true,
    api: {
      async pluginsAgentApprovalDescribe() {
        describeCalls += 1;
        return describeCalls === 1
          ? approvalDetail(approvalId, new Date(Date.now() + 40).toISOString())
          : {
              approvalUnavailable: true,
              tool: 'process_run',
              errorCode: 'AGENT_APPROVAL_EXPIRED',
              errorMessage: 'The Agent approval expired before the operation could start.'
            };
      }
    },
    executeIsolated: async () => ({ ok: true, value: { accepted: true } })
  });
  t.after(() => runtime.sandbox.BOBO.agentWorkbench.dispose());
  runtime.sandbox.BOBO.agentWorkbench.init();
  const key = runtime.sandbox.BOBO.__agentApprovalTest.approvalKey(runtime.record, approvalId);
  await waitFor(() => runtime.sandbox.BOBO.__agentApprovalTest.approvalDecisions.get(key)?.status === 'delivered');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const deliveries = runtime.calls.filter((call) => call.type === 'command' && call.command === 'acme.agent.reject');
  assert.equal(describeCalls, 2);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].payload.values.approvalResult.outcome, 'not-started');
  assert.equal(deliveries[0].payload.values.approvalResult.mayHaveExecuted, false);
});

test('reloaded workbench delivers a toolless evicted terminal result until accepted', async (t) => {
  const approvalId = 'approval-evicted';
  let unavailable = false;
  let deliveryAttempts = 0;
  const runtime = loadWorkbench({
    state: pendingApprovalState(approvalId),
    exposeApprovalInternals: true,
    api: {
      async pluginsAgentApprovalDescribe() {
        return unavailable
          ? {
              approvalUnavailable: true,
              errorCode: 'AGENT_APPROVAL_NOT_FOUND',
              errorMessage: 'The Agent approval is missing or no longer valid.'
            }
          : approvalDetail(approvalId, new Date(Date.now() + 60_000).toISOString());
      }
    },
    executeIsolated: async () => {
      deliveryAttempts += 1;
      return { ok: true, value: { accepted: deliveryAttempts > 1 } };
    }
  });
  t.after(() => runtime.sandbox.BOBO.agentWorkbench.dispose());
  runtime.sandbox.BOBO.agentWorkbench.init();
  const internals = runtime.sandbox.BOBO.__agentApprovalTest;
  const key = internals.approvalKey(runtime.record, approvalId);
  await waitFor(() => internals.approvalDetails.get(key)?.status === 'ready');

  runtime.sandbox.BOBO.agentWorkbench.dispose();
  assert.equal(internals.approvalDetails.size, 0);
  assert.equal(internals.approvalExpiryTimers.size, 0);
  unavailable = true;
  runtime.sandbox.BOBO.agentWorkbench.init();
  await waitFor(() => internals.approvalDecisions.get(key)?.status === 'delivery-failed');

  const first = runtime.calls.filter((call) => call.type === 'command' && call.command === 'acme.agent.reject')[0];
  assert.equal(Object.prototype.hasOwnProperty.call(first.payload.values.approvalResult, 'tool'), false);
  assert.equal(first.payload.values.approvalResult.errorCode, 'AGENT_APPROVAL_NOT_FOUND');
  const decision = internals.approvalDecisions.get(key);
  await internals.deliverApprovalDecision(runtime.record, key, decision);
  assert.equal(decision.status, 'delivered');
  assert.equal(deliveryAttempts, 2);
  const deliveries = runtime.calls.filter((call) => call.type === 'command' && call.command === 'acme.agent.reject');
  assert.deepEqual(deliveries[1].payload.values.approvalResult, deliveries[0].payload.values.approvalResult);
  assert.equal(runtime.eventListeners.get('bobo:workspace-changed').size, 1);
});

test('Agent access modes stay session-scoped and full access requires trusted confirmation', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8');
  const core = fs.readFileSync(path.join(ROOT, 'renderer', 'core', 'agent.js'), 'utf8');

  assert.match(source, /agentAccessGet\(identity\)/);
  assert.match(source, /agentAccessSet\(Object\.assign\(\{\}, identity, \{ accessMode: accessMode, confirmed: confirmed \}\)\)/);
  assert.match(source, /agentAccessClear\(identity\)/);
  assert.match(source, /pluginId: record\.owner, providerId: record\.id, sessionId: session\.id/);
  assert.match(source, /accessMode === 'full'[\s\S]*danger: true/);
  assert.match(source, /accessMode: normalizedAccessMode\(current\.accessMode\)/);
  assert.match(source, /session && !accessReady\(record\)/);
  assert.match(core, /const ACCESS_MODES = new Set\(\['ask', 'auto', 'full'\]\)/);
});

test('Agent mode, effort, and access controls live in the composer with keyboard slash commands', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8');
  const toolbarStart = source.indexOf('function appendToolbar(');
  const toolbarEnd = source.indexOf('\n  function ', toolbarStart + 1);
  const composerStart = source.indexOf('function composerNode(');
  const composerEnd = source.indexOf('\n  function ', composerStart + 1);
  const toolbar = source.slice(toolbarStart, toolbarEnd);
  const composer = source.slice(composerStart, composerEnd);

  assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart);
  assert.ok(composerStart >= 0 && composerEnd > composerStart);
  assert.doesNotMatch(toolbar, /agent-mode-control|agent-effort-field|agent-access-field/);
  assert.match(source, /agent-composer-control-trigger/);
  assert.match(source, /agent-composer-control-menu/);
  assert.match(source, /t\('Agent controls'\)/);
  assert.match(source, /button\.setAttribute\('aria-pressed', selected \? 'true' : 'false'\)/);
  assert.match(source, /mode === 'goal' \|\| mode === 'chat'/);
  assert.match(source, /function parseSlashCommand/);
  assert.match(composer, /ArrowDown/);
  assert.match(composer, /ArrowUp/);
  assert.match(composer, /event\.key === 'Tab'/);
  assert.match(composer, /event\.key === 'Escape'/);
  assert.match(composer, /parseSlashCommand[\s\S]*updatePreferences\(record, \{ mode: slash\.mode \}\)[\s\S]*invoke\(record, 'send'/);
});

test('assistant Markdown uses lexer tokens and never injects parser HTML', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'agent-workbench.css'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const tokens = marked.lexer('| Name | Value |\n| --- | --- |\n| safe | yes |\n\n<script>alert(1)</script>', { gfm: true });

  assert.equal(packageJson.dependencies.marked, '14.0.0');
  assert.equal(tokens.some((token) => token.type === 'table'), true);
  assert.equal(tokens.some((token) => token.type === 'html'), true);
  assert.match(source, /marked\.lexer\([\s\S]*\{ gfm: true, breaks: false \}/);
  assert.match(source, /token\.type === 'html'|Raw HTML and unsupported extensions are deliberately rendered as text/);
  assert.match(source, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
  assert.match(source, /link\.target = '_blank'/);
  assert.match(source, /link\.rel = 'noopener noreferrer'/);
  assert.match(source, /token\.type === 'image'[\s\S]*createTextNode/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
  assert.match(css, /\.agent-markdown-table-wrap/);
  assert.match(css, /\.agent-markdown-code-block/);
});

test('xhigh reasoning and compaction state are host-rendered workbench options', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8');
  const core = fs.readFileSync(path.join(ROOT, 'renderer', 'core', 'agent.js'), 'utf8');

  assert.match(source, /effort === 'xhigh'/);
  assert.match(source, /value\.kind === 'compaction'/);
  assert.match(source, /Context compacted \{count\} times/);
  assert.match(core, /'low', 'medium', 'high', 'xhigh', 'max'/);
  assert.match(core, /'thought', 'tool', 'status', 'skill', 'compaction', 'error'/);
});
