'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCapabilityReconnectCoordinator } = require('../src/lsp-client');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('ready disconnects share one capability probe and one controlled reconnect', async () => {
  const probe = deferred();
  let stops = 0;
  let probes = 0;
  let reconnects = 0;
  const coordinator = createCapabilityReconnectCoordinator({
    identity: () => 'server-a|user-a|workspace-a',
    stop: async () => { stops += 1; },
    refresh: () => { probes += 1; return probe.promise; },
    reconnect: async () => { reconnects += 1; return true; }
  });

  const first = coordinator.handle('ready', 'disconnected');
  const duplicate = coordinator.handle('ready', 'error');
  assert.equal(first, duplicate);
  await flushMicrotasks();
  assert.equal(stops, 1);
  assert.equal(probes, 1);
  assert.equal(reconnects, 0);

  probe.resolve({ success: true, snapshot: { catalogFingerprints: { lsp: 'revision-2' } } });
  const result = await first;
  assert.equal(result.handled, true);
  assert.equal(result.reconnected, true);
  assert.equal(reconnects, 1);
  assert.equal(coordinator.isActive(), false);
});

test('a reconnect cycle is abandoned when its server identity changes mid-probe', async () => {
  const probe = deferred();
  let identity = 'server-a|user-a|workspace-a';
  let reconnects = 0;
  const coordinator = createCapabilityReconnectCoordinator({
    identity: () => identity,
    stop: async () => true,
    refresh: () => probe.promise,
    reconnect: async () => { reconnects += 1; return true; }
  });

  const pending = coordinator.handle('ready', 'disconnected');
  await flushMicrotasks();
  identity = 'server-b|user-a|workspace-a';
  probe.resolve({ success: true });
  const result = await pending;

  assert.equal(result.stale, true);
  assert.equal(result.reconnected, false);
  assert.equal(reconnects, 0);
});

test('non-ready transport changes do not start a capability probe', async () => {
  let probes = 0;
  const coordinator = createCapabilityReconnectCoordinator({
    identity: () => 'server-a',
    refresh: async () => { probes += 1; },
    reconnect: async () => true
  });

  const result = await coordinator.handle('connecting', 'error');
  assert.equal(result.handled, false);
  assert.equal(probes, 0);
});
