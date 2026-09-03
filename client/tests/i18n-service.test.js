'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadI18nModule() {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/i18n.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    write: false,
    logLevel: 'silent'
  });
  const loaded = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', build.outputFiles[0].text);
  evaluate(require, loaded, loaded.exports);
  return loaded.exports;
}

const { createI18nService, normalizeLanguagePacksStartup } = loadI18nModule();

function pack(id, messages = {}, options = {}) {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name: options.name || id,
      nativeName: options.nativeName || id,
      locale: options.locale || (id === 'zh-CN' ? 'zh-CN' : id === 'ja' ? 'ja' : 'en'),
      version: '1.0.0',
      direction: options.direction || 'ltr',
      monacoLocale: options.monacoLocale || '',
      fallback: options.fallback || ''
    },
    source: options.source || 'builtin',
    removable: options.removable || false,
    byteSize: options.byteSize || 1,
    stale: options.stale || false,
    messages
  };
}

function summaryOf(value) {
  return {
    manifest: { ...value.manifest },
    source: value.source,
    removable: value.removable,
    byteSize: value.byteSize,
    stale: value.stale
  };
}

function startupFor(activePack, available = [activePack], errors = []) {
  return {
    activeId: activePack.manifest.id,
    packs: available.map(summaryOf),
    pack: activePack,
    errors
  };
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

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

function createHost(options = {}) {
  const listeners = new Set();
  let startupCalls = 0;
  let setActiveCalls = 0;
  let subscriptions = 0;
  let disposals = 0;
  const defaultPack = pack('en', { Hello: 'Hello' });
  const defaultStartup = startupFor(defaultPack);
  const host = {
    startup() {
      startupCalls += 1;
      return options.startup ? options.startup(startupCalls) : Promise.resolve(defaultStartup);
    },
    list: () => Promise.resolve(defaultStartup),
    load: (id) => options.load ? options.load(id) : Promise.resolve(defaultPack),
    setActive(id) {
      setActiveCalls += 1;
      return options.setActive
        ? options.setActive(id, setActiveCalls)
        : Promise.resolve(defaultStartup);
    },
    install: () => Promise.resolve(null),
    remove: () => Promise.resolve(defaultStartup),
    openFolder: () => Promise.resolve({ success: true, path: 'language-packs' }),
    refresh: () => Promise.resolve(defaultStartup),
    onDidChange(listener) {
      subscriptions += 1;
      listeners.add(listener);
      let active = true;
      return {
        dispose() {
          if (!active) return;
          active = false;
          disposals += 1;
          if (options.throwOnDispose) throw new Error('subscription dispose failed');
          listeners.delete(listener);
        }
      };
    }
  };
  return {
    host,
    emit(hint = {}) {
      for (const listener of [...listeners]) listener(hint);
    },
    get startupCalls() { return startupCalls; },
    get setActiveCalls() { return setActiveCalls; },
    get subscriptions() { return subscriptions; },
    get disposals() { return disposals; },
    get listenerCount() { return listeners.size; }
  };
}

function minimalDocument() {
  return {
    body: null,
    documentElement: { lang: '', dir: '' },
    createTreeWalker() { throw new Error('unexpected DOM traversal'); }
  };
}

function createHarness(hostFixture, options = {}) {
  const changes = [];
  const dispatched = [];
  const logs = [];
  const notifications = [];
  const service = createI18nService({
    host: hostFixture.host,
    document: options.document || minimalDocument(),
    eventTarget: {
      dispatchEvent(event) {
        dispatched.push(event);
        return true;
      }
    },
    createMutationObserver: options.createMutationObserver,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    getToast: () => ({ info: (message) => notifications.push(message) }),
    logger: { error: (...values) => logs.push(values) }
  });
  service.onChange((event) => changes.push(event));
  return { service, changes, dispatched, logs, notifications };
}

test('init is single-flight, subscribes once, and disposal is idempotent', async () => {
  const pending = deferred();
  const initial = pack('zh-CN', { Hello: 'Ni hao' });
  const hostFixture = createHost({ startup: () => pending.promise });
  const harness = createHarness(hostFixture);

  const first = harness.service.init();
  const second = harness.service.init();
  assert.equal(first, second);
  assert.equal(hostFixture.startupCalls, 1);
  pending.resolve(startupFor(initial));

  const snapshot = await first;
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.activeId, 'zh-CN');
  assert.equal(hostFixture.subscriptions, 1);
  assert.equal(harness.changes.length, 1);

  harness.service.dispose();
  harness.service.dispose();
  assert.equal(hostFixture.disposals, 1);
  assert.equal(hostFixture.listenerCount, 0);
});

test('a failed first init returns the English fallback and the next init retries', async () => {
  const recovered = pack('ja', { Hello: 'Konnichiwa' });
  const hostFixture = createHost({
    startup(call) {
      return call === 1
        ? Promise.reject(new Error('startup failed'))
        : Promise.resolve(startupFor(recovered));
    }
  });
  const harness = createHarness(hostFixture);

  const fallback = await harness.service.init();
  assert.equal(fallback.initialized, false);
  assert.equal(fallback.activeId, 'en');
  assert.equal(fallback.pack.manifest.id, 'en');
  assert.equal(hostFixture.subscriptions, 1);
  assert.equal(hostFixture.disposals, 1);
  await Promise.resolve();

  const snapshot = await harness.service.init();
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.activeId, 'ja');
  assert.equal(hostFixture.startupCalls, 2);
  assert.equal(hostFixture.subscriptions, 2);
  assert.equal(harness.logs.length, 1);
  harness.service.dispose();
});

test('two locale selections are latest-wins and never inspect the superseded payload', async () => {
  const firstSelection = deferred();
  const secondSelection = deferred();
  const english = pack('en', { Status: 'English' });
  const chinese = pack('zh-CN', { Status: 'Chinese' });
  const hostFixture = createHost({
    startup: () => Promise.resolve(startupFor(english)),
    setActive(id) {
      return id === 'ja' ? firstSelection.promise : secondSelection.promise;
    }
  });
  const harness = createHarness(hostFixture);
  await harness.service.init();

  const first = harness.service.setLocale('ja');
  const second = harness.service.setLocale('zh-CN');
  await waitFor(() => hostFixture.setActiveCalls === 2);
  secondSelection.resolve(startupFor(chinese, [english, chinese]));
  const secondResult = await second;
  assert.equal(secondResult.snapshot.activeId, 'zh-CN');

  let staleReads = 0;
  const stale = {};
  Object.defineProperty(stale, 'activeId', {
    get() {
      staleReads += 1;
      throw new Error('superseded selection was inspected');
    }
  });
  firstSelection.resolve(stale);
  const firstResult = await first;
  assert.equal(firstResult.snapshot.activeId, 'zh-CN');
  assert.equal(staleReads, 0);
  assert.deepEqual(harness.changes.map((change) => change.reason), ['startup', 'selection']);
  harness.service.dispose();
});

test('an event during setActive waits for a final host reconciliation before returning', async () => {
  const selection = deferred();
  const reconciliation = deferred();
  const english = pack('en', { Status: 'English' });
  const japanese = pack('ja', { Status: 'Japanese' });
  const chinese = pack('zh-CN', { Status: 'Chinese' });
  const hostFixture = createHost({
    startup(call) {
      if (call === 1) return Promise.resolve(startupFor(english));
      if (call === 2) return reconciliation.promise;
      throw new Error('unexpected startup request');
    },
    setActive: () => selection.promise
  });
  const harness = createHarness(hostFixture);
  await harness.service.init();

  let settled = false;
  const resultPromise = harness.service.setLocale('ja').then((result) => {
    settled = true;
    return result;
  });
  await waitFor(() => hostFixture.setActiveCalls === 1);
  hostFixture.emit({ reason: 'filesystem' });
  assert.equal(hostFixture.startupCalls, 1, 'a local mutation only marks the host event dirty');

  selection.resolve(startupFor(japanese, [english, japanese, chinese]));
  await waitFor(() => hostFixture.startupCalls === 2);
  assert.equal(settled, false, 'selection cannot return before the dirty host state is reconciled');
  reconciliation.resolve(startupFor(chinese, [english, japanese, chinese]));

  const result = await resultPromise;
  assert.equal(result.snapshot.activeId, 'zh-CN');
  assert.equal(harness.service.getActive(), 'zh-CN');
  assert.deepEqual(harness.changes.map((change) => change.reason), [
    'startup', 'selection', 'hot-reload'
  ]);
  assert.equal(harness.notifications.length, 1);
  harness.service.dispose();
});

test('a hanging superseded mutation cannot starve a newer dirty reconciliation', async () => {
  const olderSelection = deferred();
  const newerSelection = deferred();
  const reconciliation = deferred();
  const english = pack('en', { Status: 'English' });
  const japanese = pack('ja', { Status: 'Japanese' });
  const chinese = pack('zh-CN', { Status: 'Chinese' });
  const hostFixture = createHost({
    startup(call) {
      if (call === 1) return Promise.resolve(startupFor(english));
      if (call === 2) return reconciliation.promise;
      throw new Error('unexpected startup request');
    },
    setActive(id) {
      return id === 'ja' ? olderSelection.promise : newerSelection.promise;
    }
  });
  const harness = createHarness(hostFixture);
  await harness.service.init();

  const older = harness.service.setLocale('ja');
  await waitFor(() => hostFixture.setActiveCalls === 1);
  let newerSettled = false;
  const newer = harness.service.setLocale('zh-CN').then((result) => {
    newerSettled = true;
    return result;
  });
  await waitFor(() => hostFixture.setActiveCalls === 2);
  hostFixture.emit({ reason: 'filesystem' });
  newerSelection.resolve(startupFor(chinese, [english, japanese, chinese]));

  await waitFor(() => hostFixture.startupCalls === 2);
  assert.equal(newerSettled, false, 'the current mutation must await its dirty reconciliation');
  reconciliation.resolve(startupFor(chinese, [english, japanese, chinese]));
  const newerResult = await newer;
  assert.equal(newerResult.snapshot.activeId, 'zh-CN');
  assert.equal(hostFixture.startupCalls, 2);
  assert.equal(harness.notifications.length, 1);

  let staleReads = 0;
  const stale = {};
  Object.defineProperty(stale, 'activeId', {
    get() {
      staleReads += 1;
      throw new Error('superseded selection was inspected');
    }
  });
  olderSelection.resolve(stale);
  const olderResult = await older;
  assert.equal(olderResult.snapshot.activeId, 'zh-CN');
  assert.equal(staleReads, 0);
  assert.deepEqual(harness.changes.map((change) => change.reason), [
    'startup', 'selection', 'hot-reload'
  ]);
  harness.service.dispose();
});

test('host refresh invalidations discard an in-flight value before DTO inspection', async () => {
  const stale = deferred();
  const latest = deferred();
  const english = pack('en', { Status: 'English' });
  const japanese = pack('ja', { Status: 'Japanese' });
  let staleReads = 0;
  const staleValue = {};
  Object.defineProperty(staleValue, 'activeId', {
    get() {
      staleReads += 1;
      throw new Error('stale payload was inspected');
    }
  });
  const hostFixture = createHost({
    startup(call) {
      if (call === 1) return Promise.resolve(startupFor(english));
      if (call === 2) return stale.promise;
      if (call === 3) return latest.promise;
      throw new Error('refresh loop did not coalesce');
    }
  });
  const harness = createHarness(hostFixture);
  await harness.service.init();

  hostFixture.emit({ reason: 'filesystem' });
  assert.equal(hostFixture.startupCalls, 2);
  hostFixture.emit({});
  stale.resolve(staleValue);
  await waitFor(() => hostFixture.startupCalls === 3);
  assert.equal(staleReads, 0);

  latest.resolve(startupFor(japanese, [english, japanese]));
  await waitFor(() => harness.service.getActive() === 'ja');
  assert.deepEqual(harness.changes.map((change) => change.reason), ['startup', 'hot-reload']);
  assert.equal(hostFixture.startupCalls, 3);
  assert.equal(harness.notifications.length, 1);
  harness.service.dispose();
});

test('init subscribes before fallback loading and reconciles an event before returning', async () => {
  const oldFallback = deferred();
  const english = pack('en', { Status: 'English' }, { fallback: 'secondary' });
  const secondary = pack('secondary', { Fallback: 'Old fallback' });
  const japanese = pack('ja', { Status: 'Japanese' });
  const hostFixture = createHost({
    startup(call) {
      if (call === 1) return Promise.resolve(startupFor(english));
      if (call === 2) return Promise.resolve(startupFor(japanese, [english, japanese]));
      throw new Error('init reconciliation requested too many snapshots');
    },
    load(id) {
      assert.equal(id, 'secondary');
      return oldFallback.promise;
    }
  });
  const harness = createHarness(hostFixture);

  const pendingInit = harness.service.init();
  await waitFor(() => hostFixture.listenerCount === 1);
  hostFixture.emit({ reason: 'filesystem' });
  assert.equal(hostFixture.startupCalls, 1);
  oldFallback.resolve(secondary);

  const snapshot = await pendingInit;
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.activeId, 'ja');
  assert.equal(harness.service.t('Status'), 'Japanese');
  assert.deepEqual(harness.changes.map((change) => change.reason), ['startup', 'hot-reload']);
  assert.equal(hostFixture.startupCalls, 2);
  assert.equal(harness.notifications.length, 1);
  harness.service.dispose();
});

test('init reconciliation after a failed first read records the recovered Monaco baseline', async () => {
  const firstRead = deferred();
  const recovered = pack('ja', { Status: 'Japanese' }, { monacoLocale: 'ja' });
  const recoveredStartup = startupFor(recovered);
  const hostFixture = createHost({
    startup(call) {
      if (call === 1) return firstRead.promise;
      if (call === 2) return Promise.resolve(recoveredStartup);
      throw new Error('init recovery requested too many snapshots');
    },
    setActive: () => Promise.resolve(recoveredStartup)
  });
  const harness = createHarness(hostFixture);

  const pendingInit = harness.service.init();
  await waitFor(() => hostFixture.listenerCount === 1);
  hostFixture.emit({});
  firstRead.reject(new Error('first startup read failed'));

  const snapshot = await pendingInit;
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.activeId, 'ja');
  assert.equal(snapshot.monacoLocale, 'ja');
  const selection = await harness.service.setLocale('ja');
  assert.equal(selection.editorReloadRecommended, false);
  assert.equal(hostFixture.startupCalls, 2);
  harness.service.dispose();
});

test('a later init cannot replace the Monaco baseline captured after a true first failure', async () => {
  const japanese = pack('ja', { Status: 'Japanese' }, { monacoLocale: 'ja' });
  const japaneseStartup = startupFor(japanese);
  const hostFixture = createHost({
    startup(call) {
      if (call === 1) return Promise.reject(new Error('first startup read failed'));
      if (call === 2) return Promise.resolve(japaneseStartup);
      throw new Error('init retried too many times');
    },
    setActive: () => Promise.resolve(japaneseStartup)
  });
  const harness = createHarness(hostFixture);

  const fallback = await harness.service.init();
  assert.equal(fallback.initialized, false);
  assert.equal(fallback.monacoLocale, '');
  const recovered = await harness.service.init();
  assert.equal(recovered.initialized, true);
  assert.equal(recovered.monacoLocale, 'ja');

  const selection = await harness.service.setLocale('ja');
  assert.equal(selection.editorReloadRecommended, true);
  assert.equal(hostFixture.startupCalls, 2);
  harness.service.dispose();
});

test('fallback resolution validates ids, stops cycles, and caps chain depth', async (t) => {
  await t.test('manifest id mismatch', async () => {
    const primary = pack('primary', {}, { fallback: 'expected' });
    let loads = 0;
    const hostFixture = createHost({
      startup: () => Promise.resolve(startupFor(primary)),
      load: () => {
        loads += 1;
        return Promise.resolve(pack('wrong', { 'Fallback key': 'unsafe' }));
      }
    });
    const harness = createHarness(hostFixture);
    await harness.service.init();
    assert.equal(loads, 1);
    assert.equal(harness.service.t('Fallback key'), 'Fallback key');
    harness.service.dispose();
  });

  await t.test('cycle', async () => {
    const primary = pack('primary', {}, { fallback: 'secondary' });
    const secondary = pack('secondary', { 'Fallback key': 'safe' }, { fallback: 'primary' });
    let loads = 0;
    const hostFixture = createHost({
      startup: () => Promise.resolve(startupFor(primary)),
      load: () => {
        loads += 1;
        return Promise.resolve(secondary);
      }
    });
    const harness = createHarness(hostFixture);
    await harness.service.init();
    assert.equal(loads, 1);
    assert.equal(harness.service.t('Fallback key'), 'safe');
    harness.service.dispose();
  });

  await t.test('depth limit', async () => {
    const chain = Array.from({ length: 20 }, (_value, index) => (
      pack('lang' + index, { ['level' + index]: String(index) }, {
        fallback: index < 19 ? 'lang' + (index + 1) : ''
      })
    ));
    let loads = 0;
    const hostFixture = createHost({
      startup: () => Promise.resolve(startupFor(chain[0])),
      load(id) {
        loads += 1;
        return Promise.resolve(chain.find((value) => value.manifest.id === id));
      }
    });
    const harness = createHarness(hostFixture);
    await harness.service.init();
    assert.equal(loads, 16);
    assert.equal(harness.service.t('level16'), '16');
    assert.equal(harness.service.t('level17'), 'level17');
    harness.service.dispose();
  });
});

test('startup DTO normalization copies and freezes only bounded data properties', () => {
  const source = startupFor(pack('en', { 'Hello {user.name}': 'Hello {user.name}' }));
  source.extra = 'ignored';
  source.pack.extra = 'ignored';
  source.pack.manifest.extra = 'ignored';
  const normalized = normalizeLanguagePacksStartup(source);

  source.activeId = 'ja';
  source.pack.messages['Hello {user.name}'] = 'changed';
  assert.equal(normalized.activeId, 'en');
  assert.equal(normalized.pack.messages['Hello {user.name}'], 'Hello {user.name}');
  assert.equal(Object.hasOwn(normalized, 'extra'), false);
  assert.equal(Object.hasOwn(normalized.pack, 'extra'), false);
  assert.equal(Object.hasOwn(normalized.pack.manifest, 'extra'), false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.packs), true);
  assert.equal(Object.isFrozen(normalized.pack), true);
  assert.equal(Object.isFrozen(normalized.pack.manifest), true);
  assert.equal(Object.isFrozen(normalized.pack.messages), true);

  const crossRealm = vm.runInNewContext('(' + JSON.stringify(startupFor(pack('ja'))) + ')');
  assert.equal(normalizeLanguagePacksStartup(crossRealm).activeId, 'ja');
});

test('startup DTO normalization rejects prototype, descriptor, array, and size hazards', () => {
  const accessor = startupFor(pack('en'));
  Object.defineProperty(accessor, 'extra', { get: () => 'unsafe' });
  assert.throws(() => normalizeLanguagePacksStartup(accessor), /must be a data property/);

  const symbolRecord = startupFor(pack('en'));
  symbolRecord[Symbol('unsafe')] = true;
  assert.throws(() => normalizeLanguagePacksStartup(symbolRecord), /symbol keys/);

  const fakeRecordPrototype = Object.create(null);
  Object.defineProperty(fakeRecordPrototype, 'constructor', { value: Object });
  const forgedRecord = startupFor(pack('en'));
  Object.setPrototypeOf(forgedRecord, fakeRecordPrototype);
  assert.throws(() => normalizeLanguagePacksStartup(forgedRecord), /unsafe prototype/);

  const forgedArraySource = startupFor(pack('en'));
  const fakeArrayPrototype = Object.create(Object.prototype);
  Object.defineProperty(fakeArrayPrototype, 'constructor', { value: Array });
  Object.setPrototypeOf(forgedArraySource.packs, fakeArrayPrototype);
  assert.throws(() => normalizeLanguagePacksStartup(forgedArraySource), /unsafe array prototype/);

  const customArray = startupFor(pack('en'));
  customArray.packs.extra = true;
  assert.throws(() => normalizeLanguagePacksStartup(customArray), /custom array properties/);

  const symbolArray = startupFor(pack('en'));
  symbolArray.packs[Symbol('unsafe')] = true;
  assert.throws(() => normalizeLanguagePacksStartup(symbolArray), /symbol keys/);

  const tooManyExtras = startupFor(pack('en'));
  for (let index = 0; index < 9; index += 1) tooManyExtras['extra' + index] = index;
  assert.throws(() => normalizeLanguagePacksStartup(tooManyExtras), /too many fields/);

  const oversizedMessages = Object.fromEntries(
    Array.from({ length: 65 }, (_value, index) => ['message' + index, 'x'.repeat(8192)])
  );
  assert.throws(
    () => normalizeLanguagePacksStartup(startupFor(pack('en', oversizedMessages))),
    /exceeds the allowed size/
  );

  const mismatch = startupFor(pack('ja'));
  mismatch.activeId = 'en';
  assert.throws(() => normalizeLanguagePacksStartup(mismatch), /does not match/);
});

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.parentElement = null;
    this.childNodes = [];
    this.isConnected = true;
  }

  appendChild(child) {
    child.parentNode = this;
    child.parentElement = this.nodeType === 1 ? this : null;
    this.childNodes.push(child);
    return child;
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super(3);
    this.nodeValue = value;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
  }

  closest() { return null; }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelectorAll() { return []; }
  get textContent() { return this.childNodes.map((child) => child.nodeValue || child.textContent).join(''); }
  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new FakeText(String(value)));
  }
}

function lifecycleDom() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  documentElement.lang = '';
  documentElement.dir = '';
  return {
    body,
    documentElement,
    createTreeWalker(root, _mask, filter) {
      const nodes = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (!filter || filter.acceptNode(child) !== 2) {
            nodes.push(child);
            visit(child);
          }
        }
      };
      visit(root);
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    }
  };
}

test('throwing subscription cleanup cannot block observer, timer, or late-result disposal', async () => {
  const refresh = deferred();
  const english = pack('en', { Added: 'Translated' });
  const hostFixture = createHost({
    throwOnDispose: true,
    startup(call) {
      return call === 1 ? Promise.resolve(startupFor(english)) : refresh.promise;
    }
  });
  const document = lifecycleDom();
  let observerCallback = null;
  let disconnects = 0;
  let nextTimer = 0;
  const timers = new Map();
  const harness = createHarness(hostFixture, {
    document,
    createMutationObserver(callback) {
      observerCallback = callback;
      return {
        observe() {},
        disconnect() { disconnects += 1; }
      };
    },
    setTimer(callback) {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    }
  });
  await harness.service.init();
  const initialChanges = harness.changes.length;

  const added = document.body.appendChild(new FakeElement('section'));
  observerCallback([{ type: 'childList', addedNodes: [added], removedNodes: [] }]);
  assert.equal(timers.size, 1);
  hostFixture.emit({ reason: 'filesystem' });
  assert.equal(hostFixture.startupCalls, 2);

  assert.doesNotThrow(() => harness.service.dispose());
  assert.equal(hostFixture.disposals, 1);
  assert.equal(disconnects, 1);
  assert.equal(timers.size, 0);
  assert.equal(harness.service.disposed, true);

  let lateReads = 0;
  const late = {};
  Object.defineProperty(late, 'activeId', { get() { lateReads += 1; return 'ja'; } });
  refresh.resolve(late);
  await nextTurn();
  await nextTurn();
  hostFixture.emit({ reason: 'filesystem' });
  assert.equal(lateReads, 0);
  assert.equal(harness.changes.length, initialChanges);
  assert.equal(harness.dispatched.length, initialChanges);
  assert.equal(harness.notifications.length, 0);
  assert.ok(harness.logs.some((entry) => String(entry[0]).includes('subscription disposal')));
});

test('throwing log observers cannot create unhandled init or refresh rejections', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const logger = { error() { throw new Error('logger failed'); } };
  try {
    const failingHost = createHost({
      startup: () => Promise.reject(new Error('startup failed'))
    });
    const failingDocument = { documentElement: { lang: '', dir: '' } };
    Object.defineProperty(failingDocument, 'body', {
      get() { throw new Error('fallback DOM failed'); }
    });
    const failingService = createI18nService({
      host: failingHost.host,
      document: failingDocument,
      eventTarget: { dispatchEvent: () => true },
      logger
    });
    await assert.rejects(failingService.init(), /fallback DOM failed/);
    await nextTurn();
    await nextTurn();
    assert.deepEqual(unhandled, []);
    failingService.dispose();

    const english = pack('en');
    const refreshHost = createHost({
      startup(call) {
        return call === 1
          ? Promise.resolve(startupFor(english))
          : Promise.reject(new Error('refresh failed'));
      }
    });
    const refreshService = createI18nService({
      host: refreshHost.host,
      document: minimalDocument(),
      eventTarget: { dispatchEvent: () => true },
      logger
    });
    await refreshService.init();
    refreshHost.emit({ reason: 'filesystem' });
    await waitFor(() => refreshHost.startupCalls === 2);
    await nextTurn();
    await nextTurn();
    assert.deepEqual(unhandled, []);
    refreshService.dispose();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
