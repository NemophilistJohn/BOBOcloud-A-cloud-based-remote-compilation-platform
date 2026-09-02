'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { directBridgeAccessCount } = require('./support/renderer-bridge-access');

const ROOT = path.resolve(__dirname, '..');
const NATIVE_HOST_ADAPTER = 'renderer/core/native-host-adapter.ts';
const DIAGNOSTICS_SLICE = Object.freeze([
  'renderer/core/typed-platform.ts',
  'renderer/compat/diagnostics-settings-adapter.ts',
  'src/diagnostics-settings.ts',
  'src/editor-core.js',
  'src/settings.js'
]);

test('diagnostics adapters share one host-only platform service and dispose preload subscriptions once', async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "import { rendererPlatform } from './renderer/core/bootstrap.js';",
        "import './renderer/core/native-host-adapter.ts';",
        "import './renderer/compat/diagnostics-settings-adapter.ts';",
        'window.__diagnosticsAdapterPlatform = rendererPlatform;'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'diagnostics-settings-adapter-test-entry.js'
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });

  let openSubscriptionCount = 0;
  let openUnsubscribeCount = 0;
  let openListener = null;
  const languageListeners = new Map();
  const window = {
    BOBO: { state: { diagnosticsSettings: null } },
    api: {
      readDiagnosticsSettings: async () => ({}),
      writeDiagnosticsSettings: async () => true,
      onOpenDiagnosticsSettings(listener) {
        openSubscriptionCount += 1;
        openListener = listener;
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          openUnsubscribeCount += 1;
        };
      }
    },
    addEventListener(type, listener) {
      languageListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (languageListeners.get(type) === listener) languageListeners.delete(type);
    }
  };
  const document = {
    getElementById() { return null; },
    querySelector() { return null; }
  };
  const context = { console, document, window };
  vm.runInNewContext(build.outputFiles[0].text, context);

  const platform = window.__diagnosticsAdapterPlatform;
  const controller = platform.services.require('workbench.diagnosticsSettings');
  const host = platform.services.require('host.diagnostics');
  assert.equal(controller, window.BOBO.diagnosticsSettings);
  assert.notEqual(host, window.api);

  const descriptions = platform.services.describe().filter(({ id }) => (
    id === 'host.diagnostics' || id === 'workbench.diagnosticsSettings'
  ));
  assert.deepEqual(JSON.parse(JSON.stringify(descriptions)), [
    { id: 'host.diagnostics', owner: 'core', exposeToPlugins: false },
    {
      id: 'workbench.diagnosticsSettings',
      owner: 'core.diagnostics',
      exposeToPlugins: false
    }
  ]);
  assert.equal(descriptions.filter(({ id }) => id === 'host.diagnostics').length, 1);
  assert.equal(descriptions.filter(({ id }) => id === 'workbench.diagnosticsSettings').length, 1);
  assert.throws(() => platform.services.getForPlugin('host.diagnostics'), /not exposed to plugins/);
  assert.throws(
    () => platform.services.getForPlugin('workbench.diagnosticsSettings'),
    /not exposed to plugins/
  );

  controller.init();
  controller.init();
  assert.equal(openSubscriptionCount, 1);
  assert.equal(typeof openListener, 'function');
  assert.equal(languageListeners.has('bobo:language-changed'), true);

  controller.dispose();
  controller.dispose();
  assert.equal(openUnsubscribeCount, 1);
  assert.equal(languageListeners.has('bobo:language-changed'), false);

  await platform.dispose();
  assert.equal(openUnsubscribeCount, 1);
  assert.equal(platform.services.has('host.diagnostics'), false);
  assert.equal(platform.services.has('workbench.diagnosticsSettings'), false);
});

test('diagnostics adapters reuse the bootstrap registry and only the native adapter reads the bridge', () => {
  const nativeSource = fs.readFileSync(path.join(ROOT, NATIVE_HOST_ADAPTER), 'utf8');
  assert.equal(directBridgeAccessCount(NATIVE_HOST_ADAPTER, nativeSource), 1);
  assert.doesNotMatch(nativeSource, /\bglobal\s*(?:\.|\[)\s*['"]?api/);

  for (const file of DIAGNOSTICS_SLICE) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(directBridgeAccessCount(file, source), 0,
      `Diagnostics module bypasses the native host adapter: ${file}`);
    assert.doesNotMatch(source, /\bcreateRendererPlatform\s*\(/,
      `Diagnostics module creates a second renderer platform: ${file}`);
    assert.doesNotMatch(source, /\bnew\s+ServiceRegistry\s*\(/,
      `Diagnostics module creates a second service registry: ${file}`);
  }
});
