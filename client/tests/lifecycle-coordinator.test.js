'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycleCoordinator } = require('../main/lifecycle-coordinator');

test('lifecycle coordinator coalesces transitions and isolates cleanup failures', async () => {
  const calls = [];
  const errors = [];
  const coordinator = createLifecycleCoordinator({ onError: (name) => errors.push(name) });
  coordinator.register('first', async (reason) => { calls.push(['first', reason]); });
  coordinator.register('broken', async () => { throw new Error('expected'); });
  const first = coordinator.run('renderer-gone');
  assert.equal(coordinator.run('ignored-duplicate'), first);
  const result = await first;
  assert.equal(result.timedOut, false);
  assert.deepEqual(calls, [['first', 'renderer-gone']]);
  assert.deepEqual(errors, ['broken']);
});

test('lifecycle coordinator bounds a hung cleanup without blocking later runs', async () => {
  let invocations = 0;
  const coordinator = createLifecycleCoordinator({ timeoutMs: 10 });
  coordinator.register('hung', async () => { invocations += 1; await new Promise(() => {}); });
  assert.equal((await coordinator.run('first')).timedOut, true);
  assert.equal((await coordinator.run('second')).timedOut, true);
  assert.equal(invocations, 2);
});
