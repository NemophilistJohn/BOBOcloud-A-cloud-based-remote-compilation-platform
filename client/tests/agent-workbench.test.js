'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..');

class FakeNode {
  constructor(tagName = '', nodeType = 1) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.className = '';
    this._text = '';
    this.offsetTop = 0;
    this.offsetHeight = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.replaceChildrenCalls = 0;
  }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] || null;
  }
  get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(value) {
    this.childNodes.forEach((node) => { node.parentNode = null; });
    this.childNodes = [];
    this._text = String(value || '');
  }
  get classList() {
    const node = this;
    const values = () => new Set(node.className.split(/\s+/).filter(Boolean));
    const write = (set) => { node.className = Array.from(set).join(' '); };
    return {
      add(...names) { const set = values(); names.forEach((name) => set.add(name)); write(set); },
      remove(...names) { const set = values(); names.forEach((name) => set.delete(name)); write(set); },
      contains(name) { return values().has(name); },
      toggle(name, enabled) { const set = values(); enabled ? set.add(name) : set.delete(name); write(set); }
    };
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  insertBefore(node, reference) {
    if (node === reference) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference == null ? this.childNodes.length : this.childNodes.indexOf(reference);
    if (index < 0) throw new Error('Reference node is not a child.');
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }
  replaceChild(node, previous) {
    const index = this.childNodes.indexOf(previous);
    if (index < 0) throw new Error('Previous node is not a child.');
    if (node.parentNode) node.parentNode.removeChild(node);
    previous.parentNode = null;
    node.parentNode = this;
    this.childNodes[index] = node;
    return previous;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('Node is not a child.');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    this.replaceChildrenCalls += 1;
    this.childNodes.forEach((node) => { node.parentNode = null; });
    this.childNodes = [];
    nodes.forEach((node) => this.appendChild(node));
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  addEventListener() {}
}

function fakeDocument() {
  const nodes = new Map();
  return {
    nodes,
    documentElement: { getAttribute: () => '' },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) { return nodes.get(id) || null; },
    querySelector() { return null; },
    createElement(tagName) { return new FakeNode(tagName); },
    createElementNS(_namespace, tagName) { return new FakeNode(tagName); },
    createTextNode(value) {
      const node = new FakeNode('', 3);
      node.textContent = value;
      return node;
    }
  };
}

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
  const record = { id: descriptor.id, owner: 'acme.agent', descriptor, state: options.state || null, version: options.version || 0 };
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
    document: options.document || {
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
  if (options.exposeRenderInternals === true) {
    source = source.replace(/\}\)\(window\);\s*$/, [
      '  BOBO.__agentRenderTest = Object.freeze({',
      '    feedItemNode: feedItemNode,',
      '    renderStatePatch: renderStatePatch,',
      '    setRenderedWorkspace: function(value) { renderedWorkspace = value; }',
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

test('Agent feed patches update keyed nodes without rebuilding the composer', () => {
  const document = fakeDocument();
  const runtime = loadWorkbench({ document, exposeRenderInternals: true, version: 2 });
  const internals = runtime.sandbox.BOBO.__agentRenderTest;
  const root = new FakeNode('section');
  const scroll = new FakeNode('div');
  const content = new FakeNode('main');
  const feed = new FakeNode('div');
  const composer = new FakeNode('form');
  const firstMessage = {
    id: 'message-1',
    role: 'assistant',
    content: 'Before',
    reasoning: '',
    createdAt: '2026-09-01T00:00:00.000Z'
  };
  const timeline = {
    id: 'timeline-1',
    kind: 'tool',
    status: 'running',
    title: 'Read workspace',
    detail: '',
    createdAt: '2026-09-01T00:00:01.000Z'
  };
  const session = {
    id: 'session-1',
    messages: [firstMessage],
    timeline: [timeline]
  };
  runtime.record.state = { activeSessionId: session.id, activeSession: session };
  runtime.sandbox.BOBO.state.activeTabPath = `agent-workbench:${runtime.record.id}`;
  document.nodes.set('agent-workbench-view', root);
  root.append(scroll, composer);
  scroll.appendChild(content);
  content.appendChild(feed);

  const oldMessageNode = internals.feedItemNode({ type: 'message', value: firstMessage });
  const oldTimelineNode = internals.feedItemNode({ type: 'timeline', value: timeline });
  oldMessageNode.offsetTop = 0;
  oldMessageNode.offsetHeight = 80;
  oldTimelineNode.offsetTop = 100;
  oldTimelineNode.offsetHeight = 40;
  feed.append(oldMessageNode, oldTimelineNode);
  scroll.scrollTop = 100;
  scroll.scrollHeight = 1000;
  scroll.clientHeight = 200;
  internals.setRenderedWorkspace({
    providerId: runtime.record.id,
    sessionId: session.id,
    version: 2,
    root,
    scroll,
    content,
    feed,
    nodes: new Map([
      ['message:message-1', oldMessageNode],
      ['timeline:timeline-1', oldTimelineNode]
    ])
  });

  const updatedMessage = { ...firstMessage, content: '**After**\n\n<script>alert(1)</script>' };
  session.messages = [updatedMessage];
  runtime.record.version = 3;
  assert.equal(internals.renderStatePatch({
    type: 'state',
    record: runtime.record,
    patch: { baseVersion: 2, operations: [{ type: 'message.upsert', value: updatedMessage }] }
  }), true);

  const renderedMessage = feed.childNodes[0];
  assert.notEqual(renderedMessage, oldMessageNode);
  assert.equal(feed.childNodes[1], oldTimelineNode);
  assert.equal(root.childNodes[1], composer);
  assert.match(renderedMessage.textContent, /After/);
  assert.match(renderedMessage.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(feed.replaceChildrenCalls, 0);
  assert.equal(root.replaceChildrenCalls, 0);
  assert.equal(scroll.scrollTop, 100);

  const appendedMessage = {
    id: 'message-2',
    role: 'assistant',
    content: 'Done',
    reasoning: '',
    createdAt: '2026-09-01T00:00:02.000Z'
  };
  session.messages = [updatedMessage, appendedMessage];
  runtime.record.version = 4;
  assert.equal(internals.renderStatePatch({
    type: 'state',
    record: runtime.record,
    patch: { baseVersion: 3, operations: [{ type: 'message.upsert', value: appendedMessage }] }
  }), true);
  assert.equal(feed.childNodes[0], renderedMessage);
  assert.equal(feed.childNodes[1], oldTimelineNode);
  assert.equal(feed.childNodes[2].dataset.feedKey, 'message:message-2');
  assert.equal(root.childNodes[1], composer);

  assert.equal(internals.renderStatePatch({ type: 'state', record: runtime.record, patch: null }), false);
  assert.equal(internals.renderStatePatch({
    type: 'state',
    record: runtime.record,
    patch: { baseVersion: 4, operations: [{ type: 'session.merge', value: { status: 'running' } }] }
  }), false);

  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8');
  assert.match(source, /function sync\(change\)\s*\{\s*if \(renderStatePatch\(change\)\) return;/);
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
