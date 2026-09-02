'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('server runtime adapters register one host-only service instance and preserve BOBO projections', async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "import { rendererPlatform } from './renderer/core/bootstrap.js';",
        "import './renderer/compat/server-transport-adapter.ts';",
        "import './renderer/compat/server-capabilities-adapter.ts';",
        "import './renderer/compat/cloud-feature-policy-adapter.ts';",
        'window.__serverRuntimePlatform = rendererPlatform;'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'server-runtime-adapters-test-entry.js'
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });

  const events = [];
  function CustomEvent(type, options) {
    this.type = type;
    this.detail = options && options.detail;
  }
  const context = {
    console,
    CustomEvent,
    window: {
      dispatchEvent: event => events.push(event)
    }
  };
  vm.runInNewContext(build.outputFiles[0].text, context);

  const BOBO = context.window.BOBO;
  const platform = context.window.__serverRuntimePlatform;
  assert.equal(platform.services.require('workbench.serverTransport'), BOBO.serverTransport);
  assert.equal(platform.services.require('workbench.serverCapabilities'), BOBO.serverCapabilities);
  assert.equal(platform.services.require('workbench.cloudFeaturePolicy'), BOBO.cloudFeaturePolicy);

  const descriptions = platform.services.describe()
    .filter(service => service.owner === 'core.serverRuntime');
  assert.deepEqual(JSON.parse(JSON.stringify(descriptions)), [
    { id: 'workbench.serverTransport', owner: 'core.serverRuntime', exposeToPlugins: false },
    { id: 'workbench.serverCapabilities', owner: 'core.serverRuntime', exposeToPlugins: false },
    { id: 'workbench.cloudFeaturePolicy', owner: 'core.serverRuntime', exposeToPlugins: false }
  ]);
  assert.throws(
    () => platform.services.getForPlugin('workbench.serverCapabilities'),
    /not exposed to plugins/
  );

  BOBO.state = { serverCapabilities: null };
  const changes = [];
  const subscription = BOBO.serverCapabilities.onDidChange(change => changes.push(change));
  BOBO.serverCapabilities.applyServerInfo({ success: true, data: {} }, 'adapter-test');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'adapter-test');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'bobo:server-capabilities-changed');
  subscription.dispose();

  BOBO.state.serverSettings = { ip: 'server-a', secureTransport: false };
  let senderReceiver = null;
  BOBO.sendToServer = function() {
    senderReceiver = this;
    return { success: true, data: {} };
  };
  const refreshResult = await BOBO.serverCapabilities.refresh({ reason: 'receiver-test' });
  assert.equal(refreshResult.success, true);
  assert.equal(senderReceiver, BOBO);

  await platform.dispose();
  BOBO.serverCapabilities.notify('after-dispose');
  assert.equal(events.length, 2);
  assert.equal(platform.services.has('workbench.serverCapabilities'), false);
});
