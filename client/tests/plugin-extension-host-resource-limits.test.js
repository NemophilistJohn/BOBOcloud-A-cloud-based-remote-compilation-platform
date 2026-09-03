'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const MIB = 1024 * 1024;
const RESOURCE_TEST_OPTIONS = Object.freeze({ timeout: 60_000 });
let temporaryDirectory;
let core;

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

function settle(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

function createExtensionSandboxHarness(options, harnessOptions = {}) {
  const sent = [];
  const responseWaiters = new Map();
  let disposed = false;
  let nextIncomingId = 1;
  let failedModelDeliveries = Number(harnessOptions.failModelDeliveries) || 0;
  const autoAcknowledgeDeactivate = harnessOptions.autoAcknowledgeDeactivate !== false;
  const emit = (message) => options.onMessage({ protocolVersion: 1, ...message });

  const sandbox = {
    ready: Promise.resolve(),
    sent,
    get disposed() { return disposed; },
    postMessage(message) {
      sent.push(message);
      if (message.type === 'response') {
        const waiter = responseWaiters.get(message.id);
        if (waiter) {
          responseWaiters.delete(message.id);
          waiter(message);
        }
        return;
      }
      if (message.type === 'initialize') {
        queueMicrotask(() => emit({ type: 'activated' }));
        return;
      }
      if (message.type !== 'request') return;
      if (message.method === 'models.event' && failedModelDeliveries > 0) {
        failedModelDeliveries -= 1;
        throw new Error('simulated model event delivery failure');
      }
      if (message.method === 'extension.deactivate' && autoAcknowledgeDeactivate) {
        queueMicrotask(() => sandbox.respond(message));
      }
    },
    beginRequest(method, args) {
      const id = nextIncomingId++;
      const response = new Promise((resolve) => responseWaiters.set(id, resolve));
      emit({ type: 'request', id, method, args });
      return { id, response };
    },
    request(method, args) {
      return this.beginRequest(method, args).response;
    },
    respond(request, value = null) {
      emit({ type: 'response', id: request.id, ok: true, value });
    },
    reject(request, code = 'EXTENSION_UNAVAILABLE', message = 'Request failed.') {
      emit({ type: 'response', id: request.id, ok: false, error: { code, message } });
    },
    hostRequests(method) {
      return sent.filter((message) => message.type === 'request' &&
        (method === undefined || message.method === method));
    },
    dispose() { disposed = true; }
  };
  return sandbox;
}

function createModelBroker() {
  const calls = [];
  const streams = new Map();
  return {
    calls,
    broker(_pluginId, method, args) {
      calls.push({ method, args });
      if (method === 'models.generateStream') {
        const pending = deferred();
        streams.set(args.requestId, pending);
        return pending.promise;
      }
      if (method === 'models.cancel') {
        const pending = streams.get(args.requestId);
        if (pending) {
          streams.delete(args.requestId);
          pending.resolve({ cancelled: true });
        }
        return { success: true, cancelled: true };
      }
      return { authorized: true };
    },
    resolveStream(requestId, value) {
      const pending = streams.get(requestId);
      assert.ok(pending, 'expected an active broker stream');
      streams.delete(requestId);
      pending.resolve(value);
    }
  };
}

function extensionDescriptor(id, permissions) {
  return {
    id,
    revision: 'revision-1',
    manifest: {
      id,
      version: '1.0.0',
      engines: { pluginApi: '^1.6.0' },
      permissions
    },
    grantedPermissions: permissions
  };
}

async function activateHost({
  id,
  permissions = [],
  broker = async () => ({ authorized: true }),
  harnessOptions
}) {
  const platform = core.createRendererPlatform();
  let sandbox;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    agents: platform.agents,
    loadEntry: async (pluginId) => ({ id: pluginId, source: 'export function activate() {}' }),
    broker,
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options, harnessOptions)),
    invocationTimeoutMs: 30_000,
    deactivationTimeoutMs: 1_000
  });
  const activated = await host.activate(extensionDescriptor(id, permissions));
  assert.equal(activated.ok, true, activated.error && activated.error.message);
  return { host, platform, sandbox };
}

function commandRegistration(pluginId, suffix) {
  return {
    id: pluginId + '.command' + suffix,
    handlerId: 'handler-' + suffix,
    metadata: { title: 'Command ' + suffix, category: 'Tests' }
  };
}

function modelEnvelope(pluginId, requestId, sequence, event) {
  return { pluginId, revision: 'revision-1', requestId, sequence, event };
}

function activeRecord(host, pluginId) {
  // These focused resource tests inspect TypeScript-private collections after
  // bundling so leaked handles, subscriptions, queues, and bytes are observable.
  const record = host._records.get(pluginId);
  assert.ok(record, 'expected an active extension record');
  return record;
}

test.before(async () => {
  temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-extension-limits-'));
  const output = path.join(temporaryDirectory, 'core.cjs');
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['renderer/core/index.ts'],
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

test('host publishes one disposal promise before lifecycle reentry and finishes cleanup after a synchronous broker failure', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.dispose-reentry';
  const platform = core.createRendererPlatform();
  let sandbox;
  let reentrantDisposal = null;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    agents: platform.agents,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    broker(_id, method) {
      if (method === 'agent.lifecycle.dispose') throw new Error('simulated synchronous broker failure');
      return { authorized: true };
    },
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options))
  });
  t.after(async () => {
    await host.dispose();
    await platform.dispose();
  });
  host.onDidChange((event) => {
    if (event.status === 'deactivating') reentrantDisposal = host.dispose();
  });
  assert.equal((await host.activate(extensionDescriptor(pluginId, []))).ok, true);

  const disposal = host.dispose();
  assert.equal(reentrantDisposal, disposal);
  await disposal;
  assert.equal(sandbox.disposed, true);
  assert.deepEqual(host.list(), []);
});

test('locale refresh publishes its in-flight promise before a synchronous locale invalidation', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.locale-reentry';
  const platform = core.createRendererPlatform();
  const gates = [];
  let sandbox;
  let localeListener = null;
  let activeLocale = 'en';
  let refreshMode = false;
  let reentered = false;
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  const host = new core.PluginExtensionHost({
    services: platform.services,
    commands: platform.commands,
    contributions: platform.contributions,
    loadEntry: async (id) => ({ id, source: 'export function activate() {}' }),
    loadLocalization: (_id, locale) => {
      if (!refreshMode) return { locale, messages: {} };
      activeLoads += 1;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      if (!reentered) {
        reentered = true;
        localeListener();
      }
      const gate = deferred();
      gates.push(gate);
      return gate.promise.finally(() => { activeLoads -= 1; });
    },
    getLocale: () => activeLocale,
    onLocaleChange: (listener) => {
      localeListener = listener;
      return () => { localeListener = null; };
    },
    sandboxFactory: (options) => (sandbox = createExtensionSandboxHarness(options)),
    invocationTimeoutMs: 30_000
  });
  t.after(async () => {
    await host.dispose();
    await platform.dispose();
  });
  assert.equal((await host.activate(extensionDescriptor(pluginId, []))).ok, true);

  activeLocale = 'ja';
  refreshMode = true;
  localeListener();
  const refresh = host._localizationRefreshPromise;
  assert.ok(refresh);
  assert.equal(gates.length, 1);
  assert.equal(maximumActiveLoads, 1);

  gates[0].resolve({ locale: 'ja', messages: { title: 'Title' } });
  await nextTurn();
  assert.equal(gates.length, 2);
  assert.equal(maximumActiveLoads, 1);
  gates[1].resolve({ locale: 'ja', messages: { title: 'Title' } });
  await nextTurn();
  const localeUpdate = sandbox.hostRequests('i18n.changed').at(-1);
  assert.ok(localeUpdate);
  sandbox.respond(localeUpdate);
  await refresh;
  assert.equal(activeLoads, 0);
  assert.equal(maximumActiveLoads, 1);
});

test('host reserves the thirty-second pending sandbox slot for deactivation', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.pending';
  const { host, platform, sandbox } = await activateHost({
    id: pluginId,
    permissions: [core.PluginPermission.COMMANDS_REGISTER],
    harnessOptions: { autoAcknowledgeDeactivate: false }
  });
  t.after(async () => {
    const disposal = host.dispose();
    await nextTurn();
    for (const request of sandbox.hostRequests('extension.deactivate')) sandbox.respond(request);
    await disposal;
    await platform.dispose();
  });

  const commandId = pluginId + '.command';
  const registration = await sandbox.request('commands.register', {
    id: commandId,
    handlerId: 'pending-handler',
    metadata: { title: 'Pending command' }
  });
  assert.equal(registration.ok, true);

  const invocations = [];
  for (let index = 0; index < 31; index += 1) {
    invocations.push(settle(platform.commands.executeDynamic(commandId, index)));
  }
  const overflow = await settle(platform.commands.executeDynamic(commandId, 32));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error.code, core.ExtensionErrorCode.UNAVAILABLE);
  assert.equal(sandbox.hostRequests('command.invoke').length, 31);

  const deactivation = host.deactivate(pluginId);
  const deactivationRequest = sandbox.hostRequests('extension.deactivate').at(-1);
  assert.ok(deactivationRequest, 'deactivation must occupy the reserved pending slot');
  assert.equal(sandbox.hostRequests().length, 32);
  sandbox.respond(deactivationRequest);
  assert.equal((await deactivation).ok, true);

  const settledInvocations = await Promise.all(invocations);
  assert.equal(settledInvocations.every((result) => !result.ok &&
    result.error.code === core.ExtensionErrorCode.CANCELLED), true);
  assert.equal(sandbox.disposed, true);
});

test('explicit disposal releases handles and subscriptions before enforcing the 1024 handle cap', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.handles';
  const { host, platform, sandbox } = await activateHost({
    id: pluginId,
    permissions: [core.PluginPermission.COMMANDS_REGISTER]
  });
  t.after(async () => {
    await host.dispose();
    await platform.dispose();
  });

  const record = activeRecord(host, pluginId);
  for (let index = 0; index < 8; index += 1) {
    const registration = await sandbox.request(
      'commands.register',
      commandRegistration(pluginId, 'reused')
    );
    assert.equal(registration.ok, true);
    assert.equal(platform.commands.has(pluginId + '.commandreused'), true);
    const disposal = await sandbox.request('commands.dispose', { handle: registration.value.handle });
    assert.equal(disposal.value.disposed, true);
    assert.equal(platform.commands.has(pluginId + '.commandreused'), false);
    assert.equal(record.handles.size, 0);
    assert.equal(record.subscriptions._items.size, 0);
  }

  let registered = 0;
  while (registered < 1024) {
    const batchSize = Math.min(31, 1024 - registered);
    const responses = await Promise.all(Array.from({ length: batchSize }, (_, offset) => (
      sandbox.request('commands.register', commandRegistration(pluginId, registered + offset))
    )));
    for (const response of responses) {
      assert.equal(response.ok, true, response.error && response.error.message);
    }
    registered += batchSize;
  }
  assert.equal(record.handles.size, 1024);
  assert.equal(record.subscriptions._items.size, 1024);
  assert.equal(platform.commands.describe().filter((item) => item.owner === pluginId).length, 1024);

  const overflow = await sandbox.request(
    'commands.register',
    commandRegistration(pluginId, 'overflow')
  );
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error.code, core.ExtensionErrorCode.UNAVAILABLE);
  assert.equal(record.handles.size, 1024);
  assert.equal(record.subscriptions._items.size, 1024);

  assert.equal((await host.deactivate(pluginId)).ok, true);
  assert.equal(platform.commands.describe().some((item) => item.owner === pluginId), false);
});

test('host rejects a third concurrently active model stream', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.stream-cap';
  const modelBroker = createModelBroker();
  const { host, platform, sandbox } = await activateHost({
    id: pluginId,
    permissions: [core.PluginPermission.MODELS_GENERATE],
    broker: modelBroker.broker
  });
  t.after(async () => {
    await host.dispose();
    await platform.dispose();
  });

  sandbox.beginRequest('agent.broker.request', {
    method: 'models.generateStream', args: { requestId: 'stream-1' }
  });
  sandbox.beginRequest('agent.broker.request', {
    method: 'models.generateStream', args: { requestId: 'stream-2' }
  });
  const third = await sandbox.request('agent.broker.request', {
    method: 'models.generateStream', args: { requestId: 'stream-3' }
  });

  assert.equal(third.ok, false);
  assert.equal(third.error.code, core.ExtensionErrorCode.UNAVAILABLE);
  assert.equal(activeRecord(host, pluginId).modelStreams.size, 2);
  assert.equal(modelBroker.calls.filter((call) => call.method === 'models.generateStream').length, 2);
  assert.equal((await host.deactivate(pluginId)).ok, true);
});

test('models.event outbound delivery accepts a payload above 2 MiB and below 8 MiB', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.large-event';
  const requestId = 'large-stream';
  const modelBroker = createModelBroker();
  const { host, platform, sandbox } = await activateHost({
    id: pluginId,
    permissions: [core.PluginPermission.MODELS_GENERATE],
    broker: modelBroker.broker
  });
  t.after(async () => {
    await host.dispose();
    await platform.dispose();
  });

  const generation = sandbox.beginRequest('agent.broker.request', {
    method: 'models.generateStream', args: { requestId }
  });
  await nextTurn();
  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 1, {
    type: 'response.started',
    requestedReasoningEffort: 'high',
    effectiveReasoningEffort: 'high'
  })), true);
  const started = sandbox.hostRequests('models.event').at(-1);
  assert.ok(started);
  sandbox.respond(started);
  await nextTurn();

  const result = {
    content: 'c'.repeat(1_100_000),
    reasoning: 'r'.repeat(1_100_000),
    toolCalls: [],
    finishReason: 'stop',
    usage: null
  };
  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 2, {
    type: 'response.completed', result
  })), true);
  const completed = sandbox.hostRequests('models.event').at(-1);
  assert.ok(completed);
  assert.equal(completed.args.event.result.content.length, result.content.length);
  assert.equal(completed.args.event.result.reasoning.length, result.reasoning.length);
  const outboundBytes = Buffer.byteLength(JSON.stringify(completed.args), 'utf8');
  assert.equal(outboundBytes > 2 * MIB, true);
  assert.equal(outboundBytes <= 8 * MIB, true);

  sandbox.respond(completed);
  modelBroker.resolveStream(requestId, result);
  const response = await generation.response;
  assert.equal(response.ok, true);
  assert.equal(activeRecord(host, pluginId).modelStreams.size, 0);
  assert.equal((await host.deactivate(pluginId)).ok, true);
});

test('model backlog overflow clears queued bytes and requests cancellation exactly once', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.queue-overflow';
  const requestId = 'overflow-stream';
  const modelBroker = createModelBroker();
  const { host, platform, sandbox } = await activateHost({
    id: pluginId,
    permissions: [core.PluginPermission.MODELS_GENERATE],
    broker(pluginId, method, args) {
      const result = modelBroker.broker(pluginId, method, args);
      if (method === 'models.cancel') throw new Error('simulated synchronous cancellation failure');
      return result;
    }
  });
  t.after(async () => {
    await host.dispose();
    await platform.dispose();
  });

  const generation = sandbox.beginRequest('agent.broker.request', {
    method: 'models.generateStream', args: { requestId }
  });
  await nextTurn();
  const record = activeRecord(host, pluginId);
  const stream = record.modelStreams.get(requestId);
  assert.ok(stream);

  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 1, {
    type: 'response.started'
  })), true);
  const pendingDelivery = sandbox.hostRequests('models.event').at(-1);
  assert.ok(pendingDelivery);
  const maximumDelta = 'x'.repeat(2 * MIB);
  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 2, {
    type: 'content.delta', delta: maximumDelta
  })), true);
  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 3, {
    type: 'content.delta', delta: maximumDelta
  })), false);

  assert.equal(record.modelStreams.has(requestId), false);
  assert.equal(stream.queue.length, 0);
  assert.equal(stream.head, 0);
  assert.equal(stream.queuedBytes, 0);
  assert.equal(record.pendingModelEventBytes, 0);
  await nextTurn();
  assert.equal(modelBroker.calls.filter((call) => call.method === 'models.cancel').length, 1);
  assert.equal(sandbox.hostRequests('models.event').length, 1);

  sandbox.respond(pendingDelivery);
  const response = await generation.response;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, core.ExtensionErrorCode.UNAVAILABLE);
  await nextTurn();
  assert.equal(sandbox.hostRequests('models.event').length, 1);
  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 4, {
    type: 'content.delta', delta: 'late'
  })), false);
  assert.equal(modelBroker.calls.filter((call) => call.method === 'models.cancel').length, 1);
  assert.equal((await host.deactivate(pluginId)).ok, true);
  await nextTurn();
  assert.equal(modelBroker.calls.filter((call) => call.method === 'models.cancel').length, 1);
});

test('model delivery failure drops the queue and requests cancellation exactly once', RESOURCE_TEST_OPTIONS, async (t) => {
  const pluginId = 'acme.delivery-failure';
  const requestId = 'failed-stream';
  const modelBroker = createModelBroker();
  const { host, platform, sandbox } = await activateHost({
    id: pluginId,
    permissions: [core.PluginPermission.MODELS_GENERATE],
    broker: modelBroker.broker,
    harnessOptions: { failModelDeliveries: 1 }
  });
  t.after(async () => {
    await host.dispose();
    await platform.dispose();
  });

  const generation = sandbox.beginRequest('agent.broker.request', {
    method: 'models.generateStream', args: { requestId }
  });
  await nextTurn();
  const record = activeRecord(host, pluginId);
  const stream = record.modelStreams.get(requestId);
  assert.ok(stream);

  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 1, {
    type: 'response.started'
  })), true);
  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 2, {
    type: 'content.delta', delta: 'queued'
  })), true);
  await nextTurn();

  assert.equal(record.modelStreams.has(requestId), false);
  assert.equal(stream.queue.length, 0);
  assert.equal(stream.head, 0);
  assert.equal(stream.queuedBytes, 0);
  assert.equal(record.pendingModelEventBytes, 0);
  assert.equal(sandbox.hostRequests('models.event').length, 1);
  assert.equal(modelBroker.calls.filter((call) => call.method === 'models.cancel').length, 1);
  assert.equal(host.handleAgentModelEvent(modelEnvelope(pluginId, requestId, 3, {
    type: 'content.delta', delta: 'late'
  })), false);

  const response = await generation.response;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, core.ExtensionErrorCode.UNAVAILABLE);
  assert.equal(modelBroker.calls.filter((call) => call.method === 'models.cancel').length, 1);
  assert.equal((await host.deactivate(pluginId)).ok, true);
  await nextTurn();
  assert.equal(modelBroker.calls.filter((call) => call.method === 'models.cancel').length, 1);
});
