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
const I18N_ADAPTER = 'renderer/compat/i18n-adapter.ts';

function pack(id, messages) {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name: id,
      nativeName: id,
      locale: id,
      version: '1.0.0',
      direction: 'ltr',
      monacoLocale: '',
      fallback: ''
    },
    source: 'builtin',
    removable: false,
    byteSize: 1,
    stale: false,
    messages
  };
}

function summaryOf(value) {
  const { messages, ...summary } = value;
  return summary;
}

function startupFor(value, available) {
  return {
    activeId: value.manifest.id,
    pack: value,
    packs: available.map(summaryOf),
    errors: []
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

test('i18n adapters share private registry services and sanitize host invalidations', async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "import { rendererPlatform } from './renderer/core/bootstrap.ts';",
        "import './renderer/core/native-host-adapter.ts';",
        "import './renderer/compat/i18n-adapter.ts';",
        'window.__i18nAdapterPlatform = rendererPlatform;'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'i18n-adapter-test-entry.js'
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });

  const english = pack('en', { Hello: 'Hello' });
  const japanese = pack('ja', { Hello: 'Konnichiwa' });
  const available = [english, japanese];
  let active = english;
  let startupCalls = 0;
  let rawListener = null;
  let subscriptionCount = 0;
  let unsubscriptionCount = 0;
  const notifications = [];
  const dispatched = [];
  const api = {
    languagePacksStartup: async () => {
      startupCalls += 1;
      return startupFor(active, available);
    },
    languagePacksList: async () => startupFor(active, available),
    languagePackLoad: async (id) => available.find((value) => value.manifest.id === id),
    languagePackSetActive: async (id) => {
      active = available.find((value) => value.manifest.id === id);
      return startupFor(active, available);
    },
    languagePackInstall: async () => null,
    languagePackRemove: async () => startupFor(active, available),
    languagePacksOpenFolder: async () => ({ success: true, path: 'language-packs' }),
    languagePacksRefresh: async () => startupFor(active, available),
    onLanguagePacksChanged(listener) {
      subscriptionCount += 1;
      rawListener = listener;
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        unsubscriptionCount += 1;
        rawListener = null;
      };
    }
  };
  const window = {
    BOBO: { toast: { info: (message) => notifications.push(message) } },
    api,
    setTimeout,
    clearTimeout,
    dispatchEvent(event) {
      dispatched.push(event);
      return true;
    }
  };
  const document = {
    body: null,
    documentElement: { lang: '', dir: '' },
    createTreeWalker() { throw new Error('unexpected DOM traversal'); }
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  const context = {
    window,
    document,
    console,
    MutationObserver,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(build.outputFiles[0].text, context);

  const platform = window.__i18nAdapterPlatform;
  const service = platform.services.require('workbench.i18n');
  const host = platform.services.require('host.languagePacks');
  assert.equal(service, window.BOBO.i18n);
  assert.notEqual(host, api);
  assert.equal(Object.isFrozen(host), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(platform.services.describe().filter(({ id }) => (
      id === 'host.languagePacks' || id === 'workbench.i18n'
    )))),
    [
      { id: 'host.languagePacks', owner: 'core', exposeToPlugins: false },
      { id: 'workbench.i18n', owner: 'core.i18n', exposeToPlugins: false }
    ]
  );
  assert.throws(() => platform.services.getForPlugin('host.languagePacks'), /not exposed/);
  assert.throws(() => platform.services.getForPlugin('workbench.i18n'), /not exposed/);

  const changes = [];
  service.onChange((event) => changes.push(event));
  await service.init();
  assert.equal(subscriptionCount, 1);
  assert.equal(typeof rawListener, 'function');
  assert.equal(startupCalls, 1);

  let ignoredPayloadReads = 0;
  const genericPayload = { reason: 'manual' };
  Object.defineProperty(genericPayload, 'packs', {
    get() {
      ignoredPayloadReads += 1;
      throw new Error('event packs must not be trusted');
    }
  });
  Object.defineProperty(genericPayload, 'errors', {
    get() {
      ignoredPayloadReads += 1;
      throw new Error('event errors must not be trusted');
    }
  });
  rawListener(genericPayload);
  await waitFor(() => changes.length === 2);
  assert.equal(ignoredPayloadReads, 0);
  assert.equal(notifications.length, 0);

  active = japanese;
  rawListener({ reason: 'filesystem' });
  await waitFor(() => service.getActive() === 'ja');
  assert.equal(service.t('Hello'), 'Konnichiwa');
  assert.equal(notifications.length, 1);
  assert.equal(startupCalls, 3);

  await platform.dispose();
  await platform.dispose();
  assert.equal(unsubscriptionCount, 1);
  assert.equal(service.disposed, true);
  assert.equal(platform.services.has('host.languagePacks'), false);
  assert.equal(platform.services.has('workbench.i18n'), false);
  assert.equal(dispatched.length, changes.length);
});

test('the compatibility adapter is the only i18n legacy projection and never reads the bridge', () => {
  const nativeSource = fs.readFileSync(path.join(ROOT, NATIVE_HOST_ADAPTER), 'utf8');
  const adapterSource = fs.readFileSync(path.join(ROOT, I18N_ADAPTER), 'utf8');
  const serviceSource = fs.readFileSync(path.join(ROOT, 'src/i18n.ts'), 'utf8');

  assert.equal(directBridgeAccessCount(NATIVE_HOST_ADAPTER, nativeSource), 1);
  assert.equal(directBridgeAccessCount(I18N_ADAPTER, adapterSource), 0);
  assert.equal(directBridgeAccessCount('src/i18n.ts', serviceSource), 0);
  assert.equal((adapterSource.match(/BOBO\.i18n\s*=/g) || []).length, 1);
  assert.doesNotMatch(nativeSource, /BOBO\.i18n\s*=/);
  assert.doesNotMatch(serviceSource, /BOBO\.i18n\s*=/);
  assert.doesNotMatch(adapterSource, /\bnew\s+ServiceRegistry\s*\(/);
});
