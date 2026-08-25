'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  capturePluginRpcResult,
  pluginRpcFailure,
  pluginRpcSuccess
} = require('../main/plugin-rpc-transport');

test('plugin RPC transport preserves data results including undefined', async () => {
  const values = [undefined, null, false, { repositories: [] }];
  for (const value of values) {
    const result = await capturePluginRpcResult(async () => value);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, value);
  }
});

test('plugin RPC transport serializes stable bounded errors without stacks', async () => {
  const source = new Error('Open a local workspace before using source control.');
  source.code = 'SCM_GIT_NO_WORKSPACE';
  source.stack = 'sensitive stack';
  const result = await capturePluginRpcResult(async () => { throw source; });

  assert.deepEqual(Object.keys(result.error).sort(), ['code', 'message']);
  assert.equal(result.error.code, 'SCM_GIT_NO_WORKSPACE');
  assert.equal(result.error.message, source.message);
  const fallback = pluginRpcFailure({
    code: 'not a stable code',
    message: 'x'.repeat(20 * 1024),
    stack: 'must not cross the bridge'
  });
  assert.equal(fallback.error.code, 'EXTENSION_UNAVAILABLE');
  assert.equal(fallback.error.message.length, 8 * 1024);
  assert.equal(Object.prototype.hasOwnProperty.call(fallback.error, 'stack'), false);
});

test('plugin RPC transport marks success envelopes', () => {
  const result = pluginRpcSuccess('ok');
  assert.equal(result.__bobocloudPluginRpcResult, 1);
  assert.equal(result.ok, true);
  assert.equal(result.value, 'ok');
});
