'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadWorkbench() {
  const calls = [];
  const descriptor = {
    id: 'acme.agent.main',
    title: 'Test Agent',
    commands: { configure: 'acme.agent.configure' },
    capabilities: { modes: ['chat'], reasoningEfforts: ['medium'], skills: false, localTools: false }
  };
  const record = { id: descriptor.id, owner: 'acme.agent', descriptor, state: null };
  const sandbox = {
    console,
    Promise,
    Map,
    Set,
    window: null,
    document: {
      documentElement: { getAttribute: () => '' },
      addEventListener() {},
      removeEventListener() {}
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
          createCommandPayload: (providerId, action, values) => ({ providerId, action, values })
        },
        commands: {
          async executeIsolated(command, payload) {
            calls.push({ type: 'command', command, payload });
            return { ok: true, value: null };
          }
        }
      }
    },
    addEventListener() {},
    removeEventListener() {}
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'agent-workbench.js'), 'utf8'), sandbox, { filename: 'src/agent-workbench.js' });
  return { sandbox, calls, record };
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
  assert.match(source, /approvalResult: approvalResult/);
  assert.match(source, /approve\.disabled = !detail \|\| Boolean\(decision\)/);
  assert.match(source, /t\('Loading approval details'\)/);
  assert.match(source, /resolvedExecutable/);
  assert.match(source, /cancelled: true,[\s\S]*tool: cached/);
  assert.doesNotMatch(source, /approval\.(?:summary|risk|tool|expiresAt)/);
  assert.match(css, /\.agent-approval-details/);
  assert.match(css, /\.agent-approval-preview/);
});
