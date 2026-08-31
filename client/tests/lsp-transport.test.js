'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  LspTransport,
  normalizeLspUrl,
  normalizeConfig,
  resolveConfigurationSection
} = require('../lsp-transport');
const { nonFatalLspRequestResult } = require('../main/lsp');
const uriHelpers = require('../src/lsp-client');

class MockSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  fire(name, data) {
    if (name === 'open') this.readyState = 1;
    const listener = this.listeners.get(name);
    if (listener) listener(name === 'message' ? { data: JSON.stringify(data) } : data || {});
  }
}

function teamConfig(mode = 'standard') {
  return {
    mode,
    serverHost: 'compiler.example.com:3100',
    languageId: 'rust',
    runtimeId: 'rust:1.87',
    workspace: { kind: 'team', teamId: 'team-1', projectId: 'project-1', branch: 'main' }
  };
}

function completeInitialize(socket, ready = {}) {
  socket.fire('message', Object.assign({ type: 'lsp.ready', sessionId: 's1' }, ready));
  const initialize = socket.sent.find((item) => item.method === 'initialize');
  assert.ok(initialize, 'initialize request is sent after gateway ready');
  socket.fire('message', { jsonrpc: '2.0', id: initialize.id, result: { capabilities: { hoverProvider: true } } });
  return initialize;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('classifies superseded and timed-out LSP calls as normal IPC outcomes', () => {
  assert.deepEqual(nonFatalLspRequestResult(new Error('LSP request cancelled')), {
    __bobocloudLspRequestState: 'cancelled'
  });
  assert.deepEqual(nonFatalLspRequestResult(new Error('LSP request timed out')), {
    __bobocloudLspRequestState: 'timedOut'
  });
  assert.equal(nonFatalLspRequestResult(new Error('gateway rejected request')), null);
});

test('normalizes the dedicated LSP WebSocket endpoint', () => {
  assert.equal(normalizeLspUrl('compiler.example.com:3100'), 'ws://compiler.example.com:3100/lsp');
  assert.equal(normalizeLspUrl('https://compiler.example.com/api'), 'wss://compiler.example.com:3100/lsp');
  assert.equal(normalizeLspUrl('https://compiler.example.com:8443/api'), 'wss://compiler.example.com:8443/lsp');
});

test('workspace identity never accepts a client absolute path', () => {
  assert.throws(() => normalizeConfig({
    mode: 'standard', serverHost: 'x', languageId: 'go',
    workspace: { kind: 'personal', folderName: 'C:\\work\\secret', folderKey: 'key' }
  }), /Invalid personal workspace identity/);
  assert.deepEqual(normalizeConfig({
    mode: 'standard', serverHost: 'x', languageId: 'go',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'abc123' }
  }).workspace, { kind: 'personal', folderName: 'demo', folderKey: 'abc123' });
});

test('normalizes bounded setup commands into the LSP dependency scope', () => {
  const config = normalizeConfig({
    mode: 'standard', serverHost: 'x', languageId: 'python', runtimeId: 'python:3.10',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'abc123' },
    setupCommands: ['  pip install numpy==2.1.0  ']
  });
  assert.deepEqual(config.setupCommands, ['pip install numpy==2.1.0']);
  assert.throws(() => normalizeConfig(Object.assign({}, config, { setupCommands: [''] })), /setup commands/);
  assert.throws(() => normalizeConfig(Object.assign({}, config, { setupCommands: new Array(65).fill('pip install x') })), /setup commands/);
});

test('resolves dependency configuration sections with literal dotted keys before nested values', () => {
  const configuration = {
    gopls: { buildFlags: ['-tags=integration'] },
    typescript: { formattingOptions: { semicolons: 'insert' } },
    python: { analysis: { typeCheckingMode: 'basic' } },
    'python.analysis': { typeCheckingMode: 'strict' }
  };

  assert.deepEqual(resolveConfigurationSection(configuration, 'gopls'), {
    buildFlags: ['-tags=integration']
  });
  assert.deepEqual(resolveConfigurationSection(configuration, 'typescript.formattingOptions'), {
    semicolons: 'insert'
  });
  assert.deepEqual(resolveConfigurationSection(configuration, 'python.analysis'), {
    typeCheckingMode: 'strict'
  });
  assert.equal(resolveConfigurationSection(configuration, 'typescript.unknown'), null);
  assert.equal(resolveConfigurationSection(configuration, '__proto__.polluted'), null);
  assert.equal(resolveConfigurationSection(configuration, ''), null);
});

test('builds formatting options from the editor model without forwarding arbitrary client data', () => {
  const localPath = 'C:\\Users\\alice\\private-workspace\\main.ts';
  const model = {
    uri: { fsPath: localPath },
    getOptions: () => ({ tabSize: 2, insertSpaces: false })
  };

  assert.deepEqual(uriHelpers.formattingOptionsForModel(model), {
    tabSize: 2,
    insertSpaces: false
  });
  const overridden = uriHelpers.formattingOptionsForModel(model, {
    tabSize: 6,
    insertSpaces: true,
    trimTrailingWhitespace: true,
    localPath,
    workspace: { root: localPath }
  });
  assert.deepEqual(overridden, {
    tabSize: 6,
    insertSpaces: true,
    trimTrailingWhitespace: true
  });
  assert.equal(JSON.stringify(overridden).includes(localPath), false);
});

test('all built-in locales define dependency status labels', () => {
  const requiredKeys = [
    'Ready',
    'Empty',
    'Unavailable',
    'Dependency status',
    'Dependency revision',
    'Analysis language',
    'Analysis runtime'
  ];
  for (const locale of ['en', 'zh-CN', 'ja']) {
    const messages = JSON.parse(fs.readFileSync(`language-packs/${locale}/messages.json`, 'utf8'));
    for (const key of requiredKeys) {
      assert.equal(typeof messages[key], 'string', `${locale} is missing ${key}`);
      assert.ok(messages[key].trim(), `${locale} has an empty ${key}`);
    }
  }
});

test('sends credential only in the main-process start frame', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: async () => 'secret-token'
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.url, 'ws://compiler.example.com:3100/lsp');
  assert.deepEqual(socket.sent[0], {
    type: 'lsp.start', token: 'secret-token', mode: 'standard', languageId: 'rust', runtimeId: 'rust:1.87',
    workspace: { kind: 'team', teamId: 'team-1', projectId: 'project-1', branch: 'main' }
  });
  assert.equal(JSON.stringify(socket.sent[0]).includes('C:\\'), false);
  transport.dispose();
});

test('sends setup commands only as dependency fingerprint input on LSP start', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: async () => 'secret-token'
  });
  await transport.configure({
    mode: 'standard', serverHost: 'compiler.example.com', languageId: 'python', runtimeId: 'python:3.10',
    workspace: { kind: 'personal', folderName: 'demo', folderKey: 'abc123' },
    setupCommands: ['pip install numpy==2.1.0']
  });
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent[0].setupCommands, ['pip install numpy==2.1.0']);
  transport.dispose();
});

test('tracks ready state, JSON-RPC responses, traffic and latency', async () => {
  let socket;
  let clock = 100;
  const statuses = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token',
    emit: (channel, payload) => { if (channel === 'status') statuses.push(payload); },
    now: () => clock
  });
  await transport.configure(teamConfig('full'));
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = completeInitialize(socket, { cache: { bytes: 4096, indexStatus: 'warm' } });
  assert.ok(initialize.params.capabilities.textDocument.rename);
  assert.ok(initialize.params.capabilities.workspace.symbol);
  assert.equal(transport.snapshot().state, 'ready');
  const pending = transport.request('textDocument/hover', { value: 1 }, 'hover-1');
  const request = socket.sent.at(-1);
  clock = 145;
  socket.fire('message', { jsonrpc: '2.0', id: request.id, result: { contents: 'ok' } });
  assert.deepEqual(await pending, { contents: 'ok' });
  assert.equal(transport.snapshot().latencyMs, 45);
  assert.ok(transport.snapshot().bytesSent > 0);
  assert.ok(transport.snapshot().bytesReceived > 0);
  assert.ok(statuses.some((item) => item.state === 'ready'));
  transport.dispose();
});

test('preserves mixed dependency status reported by the remote gateway', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await nextTurn();
  completeInitialize(socket, {
    dependency: {
      status: 'mixed',
      revision: 'pip-packages-42',
      languageId: 'python',
      runtimeId: 'python:3.10',
      source: 'mixed',
      configuration: {}
    }
  });
  assert.equal(transport.snapshot().dependency.status, 'mixed');
  transport.dispose();
});

test('cancels superseded keyed requests using standard LSP cancellation', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  completeInitialize(socket);
  const first = transport.request('textDocument/completion', {}, 'completion').catch((error) => error.message);
  const second = transport.request('textDocument/completion', {}, 'completion');
  assert.equal(await first, 'LSP request cancelled');
  assert.equal(socket.sent.some((item) => item.method === '$/cancelRequest'), true);
  const request = socket.sent.filter((item) => item.method === 'textDocument/completion').at(-1);
  socket.fire('message', { jsonrpc: '2.0', id: request.id, result: [] });
  assert.deepEqual(await second, []);
  transport.dispose();
});

test('persists analyzer completion capabilities across later status snapshots', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await nextTurn();
  socket.fire('message', { type: 'lsp.ready', sessionId: 'capabilities' });
  const initialize = socket.sent.find((item) => item.method === 'initialize');
  const capabilities = {
    completionProvider: { triggerCharacters: ['.', ':'], resolveProvider: true },
    hoverProvider: true
  };
  socket.fire('message', { jsonrpc: '2.0', id: initialize.id, result: { capabilities } });
  assert.deepEqual(transport.snapshot().capabilities, capabilities);

  const hover = transport.request('textDocument/hover', {}, 'hover-capabilities');
  const hoverRequest = socket.sent.at(-1);
  socket.fire('message', { jsonrpc: '2.0', id: hoverRequest.id, result: null });
  await hover;
  assert.deepEqual(transport.snapshot().capabilities, capabilities);
  transport.dispose();
});

test('ignores late messages and errors from a replaced WebSocket generation', async () => {
  const sockets = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  const first = sockets[0];
  first.fire('open');
  await nextTurn();
  completeInitialize(first, { sessionId: 'first' });

  await transport._connect();
  const second = sockets[1];
  second.fire('open');
  await nextTurn();
  completeInitialize(second, { sessionId: 'fresh' });
  const sentBeforeLateMessage = second.sent.length;

  first.fire('message', { type: 'lsp.ready', sessionId: 'stale' });
  first.fire('error', { message: 'late socket failure' });
  assert.equal(transport.snapshot().state, 'ready');
  assert.equal(transport.snapshot().sessionId, 'fresh');
  assert.equal(second.sent.length, sentBeforeLateMessage, 'a stale ready event must not initialize the replacement socket');
  transport.dispose();
});

test('concurrent configuration is serialized and the latest request wins', async () => {
  const sockets = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  const first = sockets[0];
  first.fire('open');
  await nextTurn();
  completeInitialize(first, { sessionId: 'initial' });

  const older = transport.configure(teamConfig('full'));
  await nextTurn();
  const shutdown = first.sent.find((item) => item.method === 'shutdown');
  assert.ok(shutdown, 'the active lifecycle operation begins an orderly shutdown');
  const latestConfig = Object.assign({}, teamConfig('standard'), {
    languageId: 'python',
    runtimeId: 'python:3.12'
  });
  const latest = transport.configure(latestConfig);
  first.fire('message', { jsonrpc: '2.0', id: shutdown.id, result: null });

  await Promise.all([older, latest]);
  assert.equal(transport.config.languageId, 'python');
  assert.equal(transport.config.runtimeId, 'python:3.12');
  assert.equal(sockets.length, 2, 'the superseded configuration must not create an intermediate socket');
  transport.dispose();
});

test('returning to the current config reconnects when a superseded switch closed its socket', async () => {
  const sockets = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token'
  });
  const original = teamConfig('standard');
  await transport.configure(original);
  const first = sockets[0];
  first.fire('open');
  await nextTurn();
  completeInitialize(first, { sessionId: 'initial' });

  const superseded = transport.configure(teamConfig('full'));
  await nextTurn();
  const shutdown = first.sent.find((item) => item.method === 'shutdown');
  const latest = transport.configure(original);
  first.fire('message', { jsonrpc: '2.0', id: shutdown.id, result: null });
  await Promise.all([superseded, latest]);

  assert.equal(transport.config.mode, 'standard');
  assert.equal(transport.snapshot().state, 'connecting');
  assert.equal(sockets.length, 2);
  assert.equal(transport.socket, sockets[1]);
  transport.dispose();
});

test('leaving initialization for local mode does not schedule a ghost reconnect', async () => {
  const sockets = [];
  const timers = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token',
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; }
  });
  await transport.configure(teamConfig());
  sockets[0].fire('open');
  await nextTurn();
  sockets[0].fire('message', { type: 'lsp.ready', sessionId: 'initializing' });
  assert.equal(transport.snapshot().state, 'initializing');

  await transport.configure({ mode: 'local' });
  assert.equal(transport.snapshot().state, 'local');
  assert.equal(transport.reconnectTimer, null);
  assert.equal(timers.some((timer) => !timer.cleared), false);
  assert.equal(sockets.length, 1);
  transport.dispose();
});

test('restarting during initialization creates only the requested replacement connection', async () => {
  const sockets = [];
  const timers = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token',
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; }
  });
  await transport.configure(teamConfig());
  sockets[0].fire('open');
  await nextTurn();
  sockets[0].fire('message', { type: 'lsp.ready', sessionId: 'initializing' });

  assert.equal(await transport.restart(), true);
  assert.equal(sockets.length, 2);
  assert.equal(transport.snapshot().state, 'connecting');
  assert.equal(transport.reconnectTimer, null);
  assert.equal(timers.some((timer) => !timer.cleared), false);
  transport.dispose();
});

test('uses only valid analyzer-advertised completion trigger characters', () => {
  const capabilities = {
    completionProvider: {
      triggerCharacters: ['.', ':', '.', '::', '\n', '', null, '🧭'],
      resolveProvider: true
    }
  };
  assert.deepEqual(uriHelpers.completionTriggerCharacters(capabilities), ['.', ':', '🧭']);
  assert.equal(uriHelpers.completionProviderCapability(capabilities).resolveProvider, true);
  assert.deepEqual(uriHelpers.completionProviderCapability({ completionProvider: true }), {});
  assert.equal(uriHelpers.completionProviderCapability({}), null);
});

test('maps Monaco completion trigger kinds to the LSP protocol', () => {
  assert.deepEqual(uriHelpers.lspCompletionContext({ triggerKind: 0 }), { triggerKind: 1 });
  assert.deepEqual(uriHelpers.lspCompletionContext({ triggerKind: 1, triggerCharacter: '.' }), {
    triggerKind: 2,
    triggerCharacter: '.'
  });
  assert.deepEqual(uriHelpers.lspCompletionContext({ triggerKind: 2, triggerCharacter: '.' }), { triggerKind: 3 });
  assert.deepEqual(uriHelpers.lspCompletionContext({ triggerKind: 99, triggerCharacter: '.' }), { triggerKind: 1 });
  assert.deepEqual(uriHelpers.lspCompletionContext(), { triggerKind: 1 });
});

test('renderer completion hints retain only rehydratable single-line insertions', () => {
  const cache = uriHelpers.createCompletionHintCache();
  const scope = 'scope-a';

  assert.equal(cache.prime(scope, 'multiline', {
    items: [{ label: 'multiline', insertText: 'one\ntwo' }]
  }, 'live'), false);
  assert.equal(cache.prime(scope, 'text-edit', {
    items: [{ label: 'replace-range', insertText: 'safe', textEdit: { newText: 'safe' } }]
  }, 'live'), false);
  assert.equal(cache.prime(scope, 'safe', {
    items: [{ label: 'safe', insertText: 'safe', detail: 'safe candidate' }]
  }, 'live'), true);
  assert.equal(cache.peek(scope, 'safe').items[0].insertText, 'safe');

  for (let index = 0; index < 540; index += 1) {
    cache.prime(scope, `bounded-${index}`, { items: [{ label: `item${index}`, insertText: `item${index}` }] }, 'live');
  }
  assert.ok(cache.size() <= 512, 'the renderer mirror must stay bounded');
});

test('local completion cache keys include bounded semantic context', () => {
  const model = { getLanguageId: () => 'python' };
  const context = { triggerKind: 2, triggerCharacter: '.' };
  const first = { uri: 'bobocloud-lsp:///main.py', model, lineNumber: 3, column: 8, prefix: 'client.' };
  const differentLine = { uri: 'bobocloud-lsp:///main.py', model, lineNumber: 4, column: 8, prefix: 'client.' };
  const differentPrefix = { uri: 'bobocloud-lsp:///main.py', model, lineNumber: 3, column: 8, prefix: 'server.' };

  assert.notEqual(uriHelpers.clientCompletionCacheKey(first, context), uriHelpers.clientCompletionCacheKey(differentLine, context));
  assert.notEqual(uriHelpers.clientCompletionCacheKey(first, context), uriHelpers.clientCompletionCacheKey(differentPrefix, context));
});

test('remote completion returns immediately, caches the result and retriggers only once', async () => {
  const pending = deferred();
  let loads = 0;
  let retriggers = 0;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator();
  const args = {
    uri: 'bobocloud-lsp:///main.rs',
    key: 'v1:1:5:foo.',
    isValid: () => true,
    hasFocus: () => true,
    hasResults: (result) => result.items.length > 0,
    load: () => { loads += 1; return pending.promise; },
    retrigger: () => { retriggers += 1; }
  };

  assert.equal(coordinator.readOrRefresh(args), null, 'the first provider call must not await the network');
  assert.equal(loads, 0, 'the network starts only after the provider has returned');
  await nextTurn();
  assert.equal(loads, 1);
  pending.resolve({ items: [{ label: 'remoteValue' }] });
  await nextTurn();
  assert.equal(retriggers, 1);

  assert.deepEqual(coordinator.readOrRefresh(args), { items: [{ label: 'remoteValue' }] });
  await nextTurn();
  assert.equal(loads, 1, 'the cache-backed retrigger must not issue another request');
  assert.equal(retriggers, 1, 'the cache-backed retrigger must not recursively retrigger');
});

test('remote completion skips a second popup when the local hint already matches', async () => {
  let retriggers = 0;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator();
  const args = {
    uri: 'bobocloud-lsp:///main.py',
    key: 'v1:1:4:np.',
    isValid: () => true,
    hasFocus: () => true,
    hasResults: (result) => result.items.length > 0,
    shouldRetrigger: () => false,
    load: () => ({ items: [{ label: 'numpy' }] }),
    retrigger: () => { retriggers += 1; }
  };

  assert.equal(coordinator.readOrRefresh(args), null);
  await nextTurn();
  assert.equal(retriggers, 0);
  assert.deepEqual(coordinator.readOrRefresh(args), { items: [{ label: 'numpy' }] });
});

test('remote completion clears a local hint when the authoritative answer is empty', async () => {
  let retriggers = 0;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator();
  const args = {
    uri: 'bobocloud-lsp:///main.py',
    key: 'v1:1:4:np.',
    isValid: () => true,
    hasFocus: () => true,
    hasResults: (result) => result.items.length > 0,
    retriggerOnEmpty: true,
    shouldRetrigger: () => true,
    load: () => ({ items: [] }),
    retrigger: () => { retriggers += 1; }
  };

  assert.equal(coordinator.readOrRefresh(args), null);
  await nextTurn();
  assert.equal(retriggers, 1, 'the local hint must be replaced by the authoritative empty result');
  assert.deepEqual(coordinator.readOrRefresh(args), { items: [] });
  await nextTurn();
  assert.equal(retriggers, 1, 'the empty result must not cause a retrigger loop');
});

test('clearing the completion coordinator drops a late response across an identity boundary', async () => {
  const pending = deferred();
  const cancelled = [];
  let retriggers = 0;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator({ cancel: (requestKey) => cancelled.push(requestKey) });
  const args = {
    uri: 'bobocloud-lsp:///main.py',
    key: 'v1:1:4:np.',
    isValid: () => true,
    hasFocus: () => true,
    hasResults: (result) => result.items.length > 0,
    load: () => pending.promise,
    retrigger: () => { retriggers += 1; }
  };

  coordinator.readOrRefresh(args);
  await nextTurn();
  coordinator.clear();
  pending.resolve({ items: [{ label: 'numpy' }] });
  await nextTurn();

  assert.deepEqual(cancelled, ['textDocument/completion:1']);
  assert.equal(retriggers, 0);
  assert.equal(coordinator.peek(args.uri), null);
});

test('credential changes invalidate in-flight renderer completions', () => {
  const source = fs.readFileSync(require.resolve('../src/lsp-client'), 'utf8');
  const start = source.indexOf('function credentialsChanged()');
  const end = source.indexOf('\n  async function mapLocations', start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /invalidateCompletionContext\(\)/);
});

test('expired authentication clears renderer completion state without scheduling a reconnect', () => {
  const lspSource = fs.readFileSync(require.resolve('../src/lsp-client'), 'utf8');
  const authSource = fs.readFileSync(require.resolve('../src/auth'), 'utf8');
  const identityStart = lspSource.indexOf('function identityChanged()');
  const identityEnd = lspSource.indexOf('\n  async function mapLocations', identityStart);
  const expiredStart = authSource.indexOf('function handleAuthExpired()');
  const expiredEnd = authSource.indexOf('\n  //', expiredStart + 1);

  assert.ok(identityStart >= 0 && identityEnd > identityStart);
  assert.match(lspSource.slice(identityStart, identityEnd), /invalidateCompletionContext\(\)/);
  assert.doesNotMatch(lspSource.slice(identityStart, identityEnd), /scheduleConfigure\(/);
  assert.ok(expiredStart >= 0 && expiredEnd > expiredStart);
  const expiredBody = authSource.slice(expiredStart, expiredEnd);
  assert.match(expiredBody, /dropCredential\(\);\s*if \(BOBO\.lsp.*identityChanged/);
  assert.match(expiredBody, /identityChanged.*\r?\n\s*if \(S\.serverSettings\.ip\) clearCredential/);
});

test('completion cache crosses context only for its programmatic retrigger', async () => {
  let loads = 0;
  let retriggers = 0;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator();
  function args(requestContextKey) {
    return {
      uri: 'bobocloud-lsp:///main.rs',
      key: 'v1:1:7:value.',
      requestContextKey,
      isValid: () => true,
      hasFocus: () => true,
      hasResults: () => true,
      load: () => {
        loads += 1;
        return { items: [{ label: requestContextKey }] };
      },
      retrigger: () => { retriggers += 1; }
    };
  }

  coordinator.readOrRefresh(args('trigger:.'));
  await nextTurn();
  assert.equal(retriggers, 1);
  assert.deepEqual(coordinator.readOrRefresh(args('invoked')), { items: [{ label: 'trigger:.' }] });
  assert.equal(coordinator.readOrRefresh(args('invoked')), null, 'a later manual invoke must refresh the broader context');
  await nextTurn();
  assert.equal(loads, 2);
});

test('remote completion is latest-wins and discards stale or unfocused results', async () => {
  const pending = new Map();
  const cancelled = [];
  const retriggered = [];
  let focused = true;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator({
    cancel: (requestKey) => cancelled.push(requestKey)
  });
  function args(key) {
    return {
      uri: 'bobocloud-lsp:///main.py',
      key,
      isValid: () => true,
      hasFocus: () => focused,
      hasResults: (result) => result.items.length > 0,
      load: (requestKey) => {
        const waiter = deferred();
        pending.set(key, { requestKey, waiter });
        return waiter.promise;
      },
      retrigger: () => retriggered.push(key)
    };
  }

  coordinator.readOrRefresh(args('v1:np'));
  await nextTurn();
  const first = pending.get('v1:np');
  coordinator.readOrRefresh(args('v2:npu'));
  assert.deepEqual(cancelled, [first.requestKey]);
  await nextTurn();
  first.waiter.resolve({ items: [{ label: 'stale' }] });
  pending.get('v2:npu').waiter.resolve({ items: [{ label: 'numpy' }] });
  await nextTurn();
  assert.deepEqual(retriggered, ['v2:npu']);
  assert.deepEqual(coordinator.readOrRefresh(args('v2:npu')), { items: [{ label: 'numpy' }] });

  coordinator.readOrRefresh(args('v3:numpy'));
  await nextTurn();
  focused = false;
  pending.get('v3:numpy').waiter.resolve({ items: [{ label: 'numpy.array' }] });
  await nextTurn();
  assert.deepEqual(retriggered, ['v2:npu'], 'background results must not steal focus');
});

test('same-key completion adopts the latest valid Monaco consumer', async () => {
  const pending = deferred();
  const retriggered = [];
  let oldTokenValid = true;
  let loads = 0;
  let latestValid;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator();
  const base = {
    uri: 'bobocloud-lsp:///main.ts',
    key: 'v4:2:8:value.',
    requestContextKey: 'trigger:dot',
    hasFocus: () => true,
    hasResults: () => true,
    load: (_requestKey, isCurrentValid) => {
      loads += 1;
      latestValid = isCurrentValid;
      return pending.promise;
    }
  };

  coordinator.readOrRefresh(Object.assign({}, base, {
    isValid: () => oldTokenValid,
    retrigger: () => retriggered.push('old')
  }));
  await nextTurn();
  oldTokenValid = false;
  coordinator.readOrRefresh(Object.assign({}, base, {
    isValid: () => true,
    retrigger: () => retriggered.push('new')
  }));
  assert.equal(latestValid(), true, 'the running loader must consult the newest consumer token');
  pending.resolve({ items: [{ label: 'valueOf' }] });
  await nextTurn();

  assert.equal(loads, 1, 'the same request context should share the network request');
  assert.deepEqual(retriggered, ['new']);
  assert.deepEqual(coordinator.readOrRefresh(Object.assign({}, base, { isValid: () => true })), {
    items: [{ label: 'valueOf' }]
  });
});

test('failed completion loads are not cached and can retry the same key', async () => {
  let loads = 0;
  const coordinator = uriHelpers.createRemoteCompletionCoordinator();
  const args = {
    uri: 'bobocloud-lsp:///main.py',
    key: 'v3:1:3:np',
    isValid: () => true,
    hasFocus: () => false,
    hasResults: () => false,
    load: () => { loads += 1; return undefined; }
  };

  coordinator.readOrRefresh(args);
  await nextTurn();
  assert.equal(coordinator.peek(args.uri).cache, null);
  coordinator.readOrRefresh(args);
  await nextTurn();
  assert.equal(loads, 2);
});

test('same position with a different completion context cancels and restarts', async () => {
  const pending = [];
  const cancelled = [];
  const coordinator = uriHelpers.createRemoteCompletionCoordinator({
    cancel: (requestKey) => cancelled.push(requestKey)
  });
  function args(requestContextKey) {
    return {
      uri: 'bobocloud-lsp:///main.ts',
      key: 'v4:2:8:value.',
      requestContextKey,
      isValid: () => true,
      hasFocus: () => false,
      hasResults: () => true,
      load: (requestKey) => {
        const waiter = deferred();
        pending.push({ requestKey, waiter });
        return waiter.promise;
      }
    };
  }

  coordinator.readOrRefresh(args('invoked'));
  await nextTurn();
  coordinator.readOrRefresh(args('trigger:.'));
  await nextTurn();
  assert.deepEqual(cancelled, [pending[0].requestKey]);
  assert.equal(pending.length, 2);
  pending[0].waiter.resolve({ items: [{ label: 'stale' }] });
  pending[1].waiter.resolve({ items: [{ label: 'fresh' }] });
  await nextTurn();
  assert.deepEqual(coordinator.readOrRefresh(args('trigger:.')), { items: [{ label: 'fresh' }] });
});

test('completion request waits for ordered didOpen and didChange synchronization', async () => {
  const sync = uriHelpers.createDocumentSyncQueue();
  const open = deferred();
  const order = [];
  sync.enqueue('bobocloud-lsp:///main.go', () => {
    order.push('didOpen:start');
    return open.promise.then(() => { order.push('didOpen:end'); return true; });
  });
  sync.enqueue('bobocloud-lsp:///main.go', () => {
    order.push('didChange');
    return true;
  });
  const coordinator = uriHelpers.createRemoteCompletionCoordinator();
  coordinator.readOrRefresh({
    uri: 'bobocloud-lsp:///main.go',
    key: 'v2:fmt.',
    isValid: () => true,
    hasFocus: () => false,
    hasResults: () => true,
    load: async () => {
      await sync.wait('bobocloud-lsp:///main.go');
      order.push('completion');
      return { items: [] };
    }
  });
  await nextTurn();
  assert.deepEqual(order, ['didOpen:start']);
  open.resolve(true);
  await nextTurn();
  assert.deepEqual(order, ['didOpen:start', 'didOpen:end', 'didChange', 'completion']);
});

test('document synchronization stops after failure and permits a full retry', async () => {
  const sync = uriHelpers.createDocumentSyncQueue();
  const order = [];
  const first = sync.enqueue('bobocloud-lsp:///main.go', () => {
    order.push('didOpen:failed');
    return false;
  });
  const skippedChange = sync.enqueue('bobocloud-lsp:///main.go', () => {
    order.push('didChange:must-not-run');
    return true;
  });
  assert.equal(await first, false);
  assert.equal(await skippedChange, false);
  assert.deepEqual(order, ['didOpen:failed']);

  assert.equal(await sync.enqueue('bobocloud-lsp:///main.go', () => {
    order.push('didOpen:retry');
    return true;
  }), true);
  assert.deepEqual(order, ['didOpen:failed', 'didOpen:retry']);
});

test('wire URI helper round-trips safe workspace-relative paths', () => {
  const wire = uriHelpers.encodeWireUri('src/a file.rs');
  assert.equal(wire, 'bobocloud-lsp:///src/a%20file.rs');
  assert.equal(uriHelpers.decodeWireUri(wire), 'src/a file.rs');
  assert.equal(uriHelpers.encodeWireUri('../secret'), '');
  assert.equal(uriHelpers.decodeWireUri('bobocloud-lsp:///src/%2E%2E/secret'), '');
  assert.equal(uriHelpers.pathInsideRoot('C:\\work\\demo\\src\\main.rs', 'C:\\work\\demo'), true);
  assert.equal(uriHelpers.pathInsideRoot('C:\\work\\demo2\\main.rs', 'C:\\work\\demo'), false);
});

test('protocol language mapping covers every cloud language and node runtime language', () => {
  ['c', 'cpp', 'python', 'go', 'rust', 'java', 'javascript', 'typescript'].forEach((language) => {
    assert.equal(uriHelpers.protocolLanguageId(language), language);
  });
  assert.equal(uriHelpers.protocolLanguageId('plaintext'), '');
});

test('client accepts server-advertised language capabilities without hard-coded parsing', () => {
  assert.deepEqual(
    uriHelpers.normalizeCapabilities({ success: true, data: { languages: ['HTML', 'css', 'scss', 'html', '', null] } }),
    ['html', 'css', 'scss']
  );
  assert.deepEqual(uriHelpers.normalizeCapabilities({ success: true, data: {} }), []);
});

test('dependency refresh coordinator waits for status and coalesces concurrent requests', async () => {
  const timers = [];
  let sendCount = 0;
  let resolveSend;
  const coordinator = uriHelpers.createDependencyRefreshCoordinator({
    timeoutMs: 250,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; }
  });
  const send = () => {
    sendCount += 1;
    return new Promise((resolve) => { resolveSend = resolve; });
  };

  const first = coordinator.request(send);
  const second = coordinator.request(send);
  assert.strictEqual(first, second);
  assert.equal(sendCount, 1);
  resolveSend(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.isPending(), true, 'IPC completion must not settle the server refresh');

  assert.equal(coordinator.settle(true), true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(timers[0].cleared, true);

  const failed = coordinator.request(() => { sendCount += 1; return Promise.resolve(true); });
  coordinator.settle(false);
  assert.equal(await failed, false);

  const timedOut = coordinator.request(() => { sendCount += 1; return Promise.resolve(true); });
  const timeout = timers.at(-1);
  assert.equal(timeout.delay, 250);
  timeout.fn();
  assert.equal(await timedOut, false);
  assert.equal(coordinator.isPending(), false);
  assert.equal(sendCount, 3);
});

test('dependency refresh coordinator waits for a ready session and retries a closed transport', async () => {
  const timers = [];
  let ready = false;
  let sendCount = 0;
  const coordinator = uriHelpers.createDependencyRefreshCoordinator({
    timeoutMs: 1000,
    retryDelayMs: 25,
    canSend: () => ready,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; }
  });

  const pending = coordinator.request(() => {
    sendCount += 1;
    if (sendCount === 1) return Promise.reject(new Error('socket closed'));
    return Promise.resolve(true);
  }, 'project-a');
  assert.equal(sendCount, 0, 'a disconnected LSP must not receive the control frame');

  ready = true;
  assert.equal(coordinator.notifyReady('project-a'), true);
  await nextTurn();
  assert.equal(sendCount, 1);
  const retry = timers.find((timer) => timer.delay === 25 && !timer.cleared);
  assert.ok(retry, 'a transient send failure schedules a bounded retry');
  retry.fn();
  await nextTurn();
  assert.equal(sendCount, 2);
  assert.equal(coordinator.settle(true), true);
  assert.equal(await pending, true);

  ready = false;
  const stale = coordinator.request(() => Promise.resolve(true), 'project-a');
  assert.equal(coordinator.notifyReady('project-b'), true, 'identity changes cancel the old refresh');
  assert.equal(await stale, false);
});

test('LSP runtime selection keeps compatible compilers and isolates editor-only languages', () => {
  assert.equal(uriHelpers.runtimeForLanguage('typescript', 'node:22'), 'node:22');
  assert.equal(uriHelpers.runtimeForLanguage('cpp', 'c:13'), 'c:13');
  assert.equal(uriHelpers.runtimeForLanguage('html', 'node:22'), 'local');
  assert.equal(uriHelpers.runtimeForLanguage('yaml', 'rust:1.82'), 'local');
  assert.equal(uriHelpers.runtimeForLanguage('shell', ''), 'local');
});

test('answers common language-server client requests without exposing local paths', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', {
    type: 'lsp.ready',
    sessionId: 's1',
    dependency: {
      status: 'ready',
      revision: 'go-sum-42',
      languageId: 'go',
      runtimeId: 'go:1.24',
      source: 'team',
      configuration: {
        gopls: { buildFlags: ['-tags=integration'] },
        typescript: { formattingOptions: { semicolons: 'insert' } },
        python: { analysis: { typeCheckingMode: 'basic' } },
        'python.analysis': { typeCheckingMode: 'strict' }
      }
    }
  });
  assert.equal(transport.snapshot().state, 'initializing');

  socket.fire('message', {
    jsonrpc: '2.0',
    id: 40,
    method: 'workspace/configuration',
    params: {
      items: [
        { section: 'gopls' },
        { section: 'typescript.formattingOptions' },
        { section: 'python.analysis' },
        { section: 'python.missing' },
        {}
      ]
    }
  });
  socket.fire('message', { jsonrpc: '2.0', id: 41, method: 'workspace/workspaceFolders', params: {} });
  socket.fire('message', { jsonrpc: '2.0', id: 42, method: 'client/registerCapability', params: { registrations: [] } });
  socket.fire('message', { jsonrpc: '2.0', id: 43, method: 'window/workDoneProgress/create', params: { token: 'index' } });
  socket.fire('message', { jsonrpc: '2.0', id: 44, method: 'workspace/applyEdit', params: { edit: {} } });
  socket.fire('message', { jsonrpc: '2.0', id: 45, method: 'workspace/unknownRequest', params: {} });

  const responses = new Map(socket.sent.filter((item) => item.id >= 40).map((item) => [item.id, item]));
  assert.deepEqual(responses.get(40).result, [
    { buildFlags: ['-tags=integration'] },
    { semicolons: 'insert' },
    { typeCheckingMode: 'strict' },
    null,
    null
  ]);
  assert.deepEqual(responses.get(41).result, [{ uri: 'bobocloud-lsp:///', name: 'project-1' }]);
  assert.equal(JSON.stringify(responses.get(41)).includes('C:\\'), false);
  assert.equal(responses.get(42).result, null);
  assert.equal(responses.get(43).result, null);
  assert.deepEqual(responses.get(44).result, {
    applied: false,
    failureReason: 'Server-initiated workspace edits require explicit client review'
  });
  assert.deepEqual(responses.get(45).error, {
    code: -32601,
    message: 'Client method is not supported'
  });
  const initialize = socket.sent.find((item) => item.method === 'initialize');
  socket.fire('message', { jsonrpc: '2.0', id: initialize.id, result: { capabilities: {} } });
  assert.equal(transport.snapshot().state, 'ready');
  transport.dispose();
});

test('tracks dependency revisions and reconnects quickly only when refresh requires it', async () => {
  const sockets = [];
  const timers = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token',
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true; }
  });
  await transport.configure(teamConfig());
  const first = sockets[0];
  first.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  completeInitialize(first, {
    dependency: {
      status: 'ready', revision: 'cargo-1', languageId: 'rust', runtimeId: 'rust:1.87', source: 'team',
      configuration: { 'rust-analyzer': { cargo: { allTargets: false } } }
    }
  });
  assert.equal(transport.snapshot().dependency.revision, 'cargo-1');

  transport.sendControl('lsp.dependency.refresh');
  assert.equal(first.sent.at(-1).type, 'lsp.dependency.refresh');
  first.fire('message', {
    type: 'lsp.dependency', success: true, changed: false, restartRequired: false,
    dependency: { status: 'ready', revision: 'cargo-1', languageId: 'rust', runtimeId: 'rust:1.87', source: 'team', configuration: {} }
  });
  assert.equal(sockets.length, 1);

  first.fire('message', {
    type: 'lsp.dependency', success: true, changed: true, restartRequired: false,
    dependency: {
      status: 'ready', revision: 'cargo-2', languageId: 'rust', runtimeId: 'rust:1.87', source: 'team',
      configuration: { 'rust-analyzer': { cargo: { allTargets: true } } }
    }
  });
  assert.equal(transport.snapshot().dependency.revision, 'cargo-2');
  assert.deepEqual(first.sent.at(-1), {
    jsonrpc: '2.0', method: 'workspace/didChangeConfiguration',
    params: { settings: { 'rust-analyzer': { cargo: { allTargets: true } } } }
  });

  first.fire('message', {
    type: 'lsp.dependency', success: true, changed: true, restartRequired: true,
    dependency: { status: 'ready', revision: 'cargo-3', languageId: 'rust', runtimeId: 'rust:1.87', source: 'team', configuration: {} }
  });
  first.fire('close');
  const reconnect = timers.find((timer) => !timer.cleared && timer.delay === 75);
  assert.ok(reconnect, 'dependency changes use the fast reconnect delay');
  reconnect.fn();
  assert.equal(sockets.length, 2);
  transport.dispose();
});

test('keeps workspace configuration compatible with gateways that omit dependency metadata', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', { type: 'lsp.ready', sessionId: 'legacy' });
  assert.equal(transport.snapshot().dependency, null);
  socket.fire('message', {
    jsonrpc: '2.0', id: 55, method: 'workspace/configuration',
    params: { items: [{ section: 'rust-analyzer' }, {}] }
  });
  const response = socket.sent.find((item) => item.id === 55);
  assert.deepEqual(response.result, [null, null]);
  transport.dispose();
});

test('performs initialize handshake before exposing ready state', async () => {
  let socket;
  const statuses = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token',
    emit: (channel, payload) => { if (channel === 'status') statuses.push(payload.state); }
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent[0].type, 'lsp.start');

  socket.fire('message', { type: 'lsp.ready', sessionId: 'gateway-session' });
  const initialize = socket.sent.at(-1);
  assert.equal(initialize.method, 'initialize');
  assert.equal(initialize.params.rootUri, 'bobocloud-lsp:///');
  assert.deepEqual(initialize.params.workspaceFolders, [{ uri: 'bobocloud-lsp:///', name: 'project-1' }]);
  assert.deepEqual(initialize.params.initializationOptions.cachePriming, { enable: false });
  assert.deepEqual(initialize.params.initializationOptions.cargo, { allTargets: false, buildScripts: { enable: false } });
  assert.deepEqual(initialize.params.initializationOptions.procMacro, { enable: false });
  assert.equal(initialize.params.initializationOptions.checkOnSave, false);
  assert.equal(initialize.params.capabilities.textDocument.rename, undefined);
  assert.equal(initialize.params.capabilities.workspace.symbol, undefined);
  assert.equal(transport.snapshot().state, 'initializing');
  assert.equal(socket.sent.some((item) => item.method === 'initialized'), false);

  socket.fire('message', { jsonrpc: '2.0', id: initialize.id, result: { capabilities: { completionProvider: {} } } });
  assert.equal(socket.sent.at(-1).method, 'initialized');
  assert.equal(transport.snapshot().state, 'ready');
  assert.ok(statuses.indexOf('initializing') < statuses.indexOf('ready'));
  transport.dispose();
});

test('initialize failures retain exponential reconnect backoff', async () => {
  let socket;
  const statuses = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token',
    random: () => 0.5,
    emit: (channel, payload) => { if (channel === 'status') statuses.push(payload); }
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  transport.reconnectAttempt = 2;
  socket.fire('message', { type: 'lsp.ready', sessionId: 'failed-init' });
  assert.equal(transport.reconnectAttempt, 2);
  const initialize = socket.sent.find((item) => item.method === 'initialize');
  socket.fire('message', { jsonrpc: '2.0', id: initialize.id, error: { code: -32000, message: 'index failed' } });
  assert.equal(transport.reconnectAttempt, 3);
  assert.equal(statuses.at(-1).retryInMs, 2000);
  transport.dispose();
});

test('restart performs shutdown and exit before reconnecting', async () => {
  const sockets = [];
  const transport = new LspTransport({
    webSocketFactory: (url) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  const first = sockets[0];
  first.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  completeInitialize(first);
  const restarting = transport.restart();
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = first.sent.find((item) => item.method === 'shutdown');
  assert.ok(shutdown);
  first.fire('message', { jsonrpc: '2.0', id: shutdown.id, result: null });
  assert.equal(await restarting, true);
  assert.equal(first.sent.some((item) => item.method === 'exit'), true);
  assert.equal(first.readyState, 3);
  assert.equal(sockets.length, 2);
  transport.dispose();
});

test('preserves gateway errors for UI detail and clears them in local mode', async () => {
  let socket;
  const transport = new LspTransport({
    webSocketFactory: (url) => (socket = new MockSocket(url)),
    getCredential: () => 'token'
  });
  await transport.configure(teamConfig());
  socket.fire('open');
  await new Promise((resolve) => setImmediate(resolve));
  socket.fire('message', { type: 'lsp.error', code: 'start_failed', message: 'rust-analyzer image is missing' });
  assert.equal(transport.snapshot().state, 'error');
  assert.equal(transport.snapshot().error, 'rust-analyzer image is missing');
  await transport.configure({ mode: 'local' });
  assert.equal(transport.snapshot().error, '');
  transport.dispose();
});

test('main process tears down authenticated LSP sessions on workspace boundaries', () => {
  const workspaceSource = fs.readFileSync(require.resolve('../main/workspace'), 'utf8');
  const closeStart = workspaceSource.indexOf("ipcMain.handle('close-workspace'");
  assert.notEqual(closeStart, -1, 'close-workspace handler exists');
  const closeBody = workspaceSource.slice(closeStart, workspaceSource.indexOf('\n    });', closeStart) + 7);
  assert.match(closeBody, /closeWorkspaceState\('workspace-close'/, 'close-workspace uses the shared transition');
  const sharedCloseStart = workspaceSource.indexOf('async function closeWorkspaceState');
  assert.notEqual(sharedCloseStart, -1, 'shared close transition exists');
  assert.match(workspaceSource.slice(sharedCloseStart, closeStart), /disposeLsp\(reason\)/, 'shared close transition closes the old LSP session');
});
