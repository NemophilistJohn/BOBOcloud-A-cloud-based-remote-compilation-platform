'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('source-control view adapter registers one host-only service and owns ready listeners', async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "import { rendererPlatform } from './renderer/core/bootstrap.ts';",
        "import './renderer/compat/source-control-view-adapter.ts';",
        'window.__sourceControlViewPlatform = rendererPlatform;'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'source-control-view-adapter-test-entry.ts'
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });

  const listeners = new Map();
  let languageSubscriptions = 0;
  let languageDisposals = 0;
  const window = {
    BOBO: {
      i18n: {
        t: (key) => key,
        onChange() {
          languageSubscriptions += 1;
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            languageDisposals += 1;
          };
        }
      },
      workbench: {
        registerPrimaryView: () => ({ dispose() {} }),
        setPrimaryVisible() {},
        setPrimaryView() {}
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
  const document = {
    documentElement: { getAttribute: () => null },
    querySelector: () => null,
    getElementById: () => null
  };
  vm.runInNewContext(build.outputFiles[0].text, { console, document, window });

  const platform = window.__sourceControlViewPlatform;
  const service = platform.services.require('workbench.sourceControlView');
  assert.equal(service, window.BOBO.sourceControlView);
  assert.deepEqual(
    JSON.parse(JSON.stringify(platform.services.describe())),
    [{
      id: 'workbench.sourceControlView',
      owner: 'core.source-control-view',
      exposeToPlugins: false
    }]
  );
  assert.throws(
    () => platform.services.getForPlugin('workbench.sourceControlView'),
    /not exposed to plugins/
  );
  assert.equal(listeners.get('bobo:ready').size, 1);

  service.init();
  service.init();
  assert.equal(languageSubscriptions, 1);
  service.dispose();
  service.dispose();
  assert.equal(languageDisposals, 1);
  assert.equal(listeners.get('bobo:ready').size, 0);

  await platform.dispose();
  assert.equal(platform.services.has('workbench.sourceControlView'), false);
  assert.equal(languageDisposals, 1);
});
