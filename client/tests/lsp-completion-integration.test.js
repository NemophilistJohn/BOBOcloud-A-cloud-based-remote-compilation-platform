'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { completionAcceptanceCommand, createCompletionRequestGuard, createCompletionRefreshGate } = require('../src/lsp-client');

test('analyzer command metadata remains intact while Monaco receives only the local acceptance hook', () => {
  const raw = { label: 'array', command: { command: 'analyzer.applyCompletion', arguments: [{ uri: 'file:///project/main.py' }] } };
  const context = { language: 'python', receiver: 'numpy' };
  let learnedItem;
  const mapped = completionAcceptanceCommand(raw, context, {
    command(receivedContext, item) {
      assert.equal(receivedContext, context);
      learnedItem = item;
      return { id: 'bobo.completionHistory.accept', arguments: [receivedContext, item.label] };
    }
  });
  assert.equal(mapped.id, 'bobo.completionHistory.accept');
  assert.equal(learnedItem.command, undefined);
  assert.equal(raw.command.command, 'analyzer.applyCompletion');
  assert.deepEqual(raw.command.arguments, [{ uri: 'file:///project/main.py' }]);
  assert.equal(completionAcceptanceCommand(raw, context, null), undefined);
});

function lifecycleFixture() {
  const events = [];
  let state = 'ready';
  const service = {
    configure(context, ports) { events.push({ type: 'configure', context, ports }); state = context ? 'ready' : 'disabled'; },
    pause() { events.push({ type: 'pause' }); state = 'paused'; },
    progress: () => ({ state }),
    suggestions: () => ({ items: [{ label: 'numpy', insertText: 'numpy', kind: 9 }] })
  };
  const model = { uri: { scheme: 'file', fsPath: 'E:/project/main.py' }, getLanguageId: () => 'python', getVersionId: () => 1,
    getLineContent: () => 'import n', getWordUntilPosition: () => ({ word: 'n', startColumn: 8, endColumn: 9 }) };
  const position = { lineNumber: 1, column: 9 };
  const BOBO = { state: { workspaceRoot: 'E:/project', selectedRuntime: 'python:3.12', editor: { getModel: () => model,
    getPosition: () => position, hasTextFocus: () => true,
    getContribution: () => ({ widget: { value: { getFocusedItem: () => null } }, model: { trigger: () => events.push({ type: 'trigger' }) } }) } },
    platform: { services: { get: key => key === 'workbench.completion' ? service : {} } } };
  const window = { BOBO };
  const source = fs.readFileSync(path.join(__dirname, '../src/lsp-client.js'), 'utf8').replace('  BOBO.lsp = {', `
  global.__test = { configureDemandCompletion, invalidateCompletionContext, provideRemoteCompletion, completeWithLocal,
    setContext(next) { settings = next.settings || settings; status = next.status || status; activeLanguage = 'python';
      lastAnalysisContext = 'same-analysis'; monacoRef = { Range: class {}, languages: { CompletionItemKind: {}, CompletionItemInsertTextRule: {} } }; } };
  BOBO.lsp = {`);
  vm.runInNewContext(source, { window, globalThis: window, Map, Set, WeakMap, Promise, Date, console, setTimeout, clearTimeout,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] } });
  const status = { state: 'ready', sessionId: 'first', languageId: 'python', runtimeId: 'python:3.12',
    dependency: { status: 'ready', revision: 'deps1' }, gatewayCapabilities: { dependencyApiIndex: {
      enabled: true, schema: 'dependency-api-index-v1', languages: ['python'], queryKinds: ['catalog', 'module', 'project'], revision: 'combined-revision' } } };
  window.__test.setContext({ settings: { mode: 'standard', clientCacheMode: 'off' }, status });
  return { hooks: window.__test, events, status, model, service, position };
}

test('LSP lifecycle pauses demand summaries on a file switch or disconnect and resumes a stable identity', () => {
  const f = lifecycleFixture();
  f.hooks.configureDemandCompletion();
  const first = f.events.at(-1).context;
  f.hooks.invalidateCompletionContext(true); assert.equal(f.events.at(-1).type, 'pause');
  f.hooks.configureDemandCompletion(); assert.equal(f.events.at(-1).context.identity, first.identity);
  f.hooks.setContext({ status: { ...f.status, state: 'disconnected' } });
  f.hooks.configureDemandCompletion(); assert.equal(f.events.at(-1).type, 'pause');
  f.hooks.setContext({ status: { ...f.status, sessionId: 'second' } });
  f.hooks.configureDemandCompletion();
  assert.equal(f.events.at(-1).context.identity, first.identity);
  assert.equal(f.events.at(-1).context.transportIdentity, 'second');
  f.hooks.invalidateCompletionContext(); assert.equal(f.events.at(-1).context, null);
});

test('offline new-protocol completions use the paused summary without entering the legacy whole-tree cache', () => {
  const f = lifecycleFixture();
  f.hooks.configureDemandCompletion();
  f.hooks.setContext({ status: { ...f.status, state: 'disconnected' } });
  f.hooks.configureDemandCompletion();
  const result = f.hooks.provideRemoteCompletion(f.model, { lineNumber: 1, column: 9 }, {}, null);
  assert.deepEqual(Array.from(result.suggestions, item => item.label), ['numpy']);
  assert.equal(result.suggestions[0]._boboLsp, null);
  assert.equal(f.events.at(-1).type, 'pause');
});

test('late local completion results are invalid after typing, cancellation, disposal or an identity boundary', async () => {
  for (const boundary of ['version', 'token', 'disposed', 'generation', 'session', 'model', 'position']) {
    let version = 1; let disposed = false;
    const model = { getVersionId: () => version, isDisposed: () => disposed };
    const token = { isCancellationRequested: false };
    const position = { lineNumber: 2, column: 8 };
    const identity = { generation: 1, sessionId: 'first', model, position };
    const guard = createCompletionRequestGuard(model, token, () => ({ ...identity }), position);
    let resolve;
    const pendingLocalResult = new Promise(done => { resolve = done; });
    const displayed = pendingLocalResult.then(items => guard() ? items : []);
    assert.equal(guard(), true);
    if (boundary === 'version') version++;
    if (boundary === 'token') token.isCancellationRequested = true;
    if (boundary === 'disposed') disposed = true;
    if (boundary === 'generation') identity.generation++;
    if (boundary === 'session') identity.sessionId = 'second';
    if (boundary === 'model') identity.model = {};
    if (boundary === 'position') identity.position = { lineNumber: 3, column: 8 };
    resolve([{ label: 'stale', range: { startColumn: 1, endColumn: 2 } }]);
    assert.deepEqual(await displayed, [], boundary);
  }
});

test('async refresh only fills an empty exact-context request once with matching names', () => {
  const gate = createCompletionRefreshGate();
  const snapshot = { uri: 'main.py', key: 'version1:np.a', prefix: 'np.a' };
  assert.equal(gate.consume(snapshot, { items: [{ label: 'array' }] }), false);
  gate.begin(snapshot); gate.observe(snapshot, { suggestions: [] });
  assert.equal(gate.consume(snapshot, { items: [{ label: 'zeros' }] }), false);
  assert.equal(gate.isWaiting(snapshot), true);
  assert.equal(gate.consume(snapshot, { items: [{ label: 'array' }] }), true);
  gate.begin(snapshot); gate.observe(snapshot, { suggestions: [] });
  assert.equal(gate.consume(snapshot, { items: [{ label: 'all' }] }), false);
  assert.equal(gate.consume({ ...snapshot, key: 'new-position' }, { items: [{ label: 'array' }] }), false);
});

test('background results do not replace a usable list or reopen a dismissed request', () => {
  const gate = createCompletionRefreshGate();
  const snapshot = { uri: 'main.py', key: 'version1:np.', prefix: 'np.' };
  gate.begin(snapshot); gate.observe(snapshot, [{ label: 'array' }, { label: 'ndarray' }]);
  assert.equal(gate.consume(snapshot, { items: [{ label: 'newApi' }] }), false);
  const next = { ...snapshot, key: 'version2:np.a', prefix: 'np.a' };
  gate.begin(next); gate.observe(next, []); gate.block(next);
  assert.equal(gate.consume(next, { items: [{ label: 'array' }] }), false);
  const typedAgain = { ...next, key: 'version3:np.ar', prefix: 'np.ar' };
  gate.begin(typedAgain); gate.observe(typedAgain, []);
  assert.equal(gate.consume(typedAgain, { items: [{ label: 'array' }] }), true);
});

test('the first requested semantic result may extend local symbols until the user navigates or cancels', () => {
  const snapshot = { uri: 'main.rs', key: 'version1:alp', prefix: 'alp' };
  const gate = createCompletionRefreshGate();
  gate.begin(snapshot); gate.expectRemote(snapshot); gate.observe(snapshot, [{ label: 'alpha_value' }]);
  assert.equal(gate.consume(snapshot, { items: [{ label: 'alpha_remote_value' }] }), false);
  assert.equal(gate.consume(snapshot, { items: [{ label: 'alpha_remote_value' }] }, 'semantic'), true);
  assert.equal(gate.consume(snapshot, { items: [{ label: 'alpha_second_remote' }] }, 'semantic'), false);
  const next = { ...snapshot, key: 'next-version' };
  gate.begin(next); gate.expectRemote(next); gate.observe(next, [{ label: 'alpha_value' }]); gate.block(next);
  assert.equal(gate.consume(next, { items: [{ label: 'alpha_remote_value' }] }, 'semantic'), false);
  const unchanged = { ...snapshot, key: 'same-names' };
  gate.begin(unchanged); gate.expectRemote(unchanged); gate.observe(unchanged, [{ label: 'alpha_value' }]);
  assert.equal(gate.consume(unchanged, { items: [{ label: 'alpha_value' }] }, 'semantic'), false);
});

test('successive project pages cannot retrigger populated completions and one pending request updates once', () => {
  const f = lifecycleFixture();
  f.hooks.configureDemandCompletion();
  const changed = f.events.at(-1).ports.changed;
  f.hooks.completeWithLocal({ provideCompletionItems: () => ({ suggestions: [{ label: 'numpy' }] }) }, f.model, f.position, {}, null);
  for (let dataRevision = 1; dataRevision <= 6; dataRevision++) changed({ state: 'ready', completedModules: dataRevision, totalModules: 6, dataRevision });
  assert.equal(f.events.filter(event => event.type === 'trigger').length, 0);
  f.hooks.invalidateCompletionContext(true);
  f.hooks.completeWithLocal({ provideCompletionItems: () => ({ suggestions: [] }) }, f.model, f.position, {}, null);
  f.service.suggestions = () => ({ items: [{ label: 'other' }] });
  changed({ state: 'ready', completedModules: 7 });
  assert.equal(f.events.filter(event => event.type === 'trigger').length, 0);
  f.service.suggestions = () => ({ items: [{ label: 'numpy' }] });
  changed({ state: 'ready', completedModules: 8 });
  changed({ state: 'ready', completedModules: 9 });
  assert.equal(f.events.filter(event => event.type === 'trigger').length, 1);
});
