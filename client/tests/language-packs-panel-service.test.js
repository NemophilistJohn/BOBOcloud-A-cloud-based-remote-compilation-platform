'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadLanguagePacksPanelModule() {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/language-packs-panel.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const loaded = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', build.outputFiles[0].text);
  evaluate(require, loaded, loaded.exports);
  return loaded.exports;
}

const {
  createLanguagePacksPanel,
  normalizeLanguagePackPanelEntries
} = loadLanguagePacksPanelModule();

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, target = this) {
    const event = { type, target, preventDefault() {} };
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(ownerDocument, tagName, id = '', fragment = false) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.fragment = fragment;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.disabled = false;
    this.innerHTML = '';
    this.classList = {
      add: (...names) => this.updateClasses(names, true),
      remove: (...names) => this.updateClasses(names, false),
      contains: (name) => this.classTokens().has(name)
    };
    if (id) ownerDocument.elements.set(id, this);
  }

  get childNodes() {
    return this.children;
  }

  classTokens() {
    return new Set(String(this.className).split(/\s+/).filter(Boolean));
  }

  updateClasses(names, add) {
    const tokens = this.classTokens();
    for (const name of names) {
      if (add) tokens.add(name);
      else tokens.delete(name);
    }
    this.className = [...tokens].join(' ');
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    if (child.fragment) {
      for (const nested of [...child.children]) this.appendChild(nested);
      child.children = [];
      return child;
    }
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.classTokens().has(selector.slice(1));
    if (selector === '[data-pack-id]') return typeof this.dataset.packId === 'string';
    if (selector === '[data-remove-pack]') return typeof this.dataset.removePack === 'string';
    return false;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    for (const [id, tag] of [
      ['language-pack-current', 'select'],
      ['language-pack-list', 'div'],
      ['language-pack-install', 'button'],
      ['language-pack-open-folder', 'button'],
      ['language-pack-refresh', 'button'],
      ['language-pack-status', 'div'],
      ['language-pack-active-meta', 'div']
    ]) {
      new FakeElement(this, tag, id);
    }
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createDocumentFragment() {
    return new FakeElement(this, '#fragment', '', true);
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }
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

function translate(source, params) {
  return String(source).replace(/\{([\w.-]+)\}/g, (match, key) => (
    params?.[key] == null ? match : String(params[key])
  ));
}

function pack(id, nativeName = id, source = 'builtin') {
  return {
    manifest: {
      id,
      locale: id,
      name: nativeName,
      nativeName,
      version: '1.0.0'
    },
    source,
    removable: source !== 'builtin'
  };
}

test('normalization remains first-wins and forces built-in packs to be non-removable', () => {
  const first = pack('en', 'English');
  first.removable = true;
  const values = normalizeLanguagePackPanelEntries({
    packs: [first, { id: 'en', nativeName: 'Duplicate' }, { locale: 'ja', name: 'Japanese' }]
  });

  assert.deepEqual(values.map(({ id }) => id), ['en', 'ja']);
  assert.equal(values[0].raw, first);
  assert.equal(values[0].nativeName, 'English');
  assert.equal(values[0].builtIn, true);
  assert.equal(values[0].removable, false);
  assert.equal(values[1].nativeName, 'Japanese');
});

test('panel initialization is single-flight, renders latest-wins, and disposes owned listeners', async () => {
  const document = new FakeDocument();
  const initialPacks = [pack('en', 'English'), pack('ja', 'Japanese', 'user')];
  const initGate = deferred();
  let initCalls = 0;
  let listCalls = 0;
  let activeId = 'en';
  let changeListener = null;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const i18n = {
    init() {
      initCalls += 1;
      return initGate.promise;
    },
    t: translate,
    async listPacks() {
      listCalls += 1;
      return initialPacks;
    },
    getActive: () => activeId,
    getErrors: () => [],
    async setLocale(id) {
      activeId = id;
      return { editorReloadRecommended: false };
    },
    async install() {
      return null;
    },
    async remove() {},
    async openFolder() {},
    async refresh() {},
    onChange(listener) {
      subscriptions += 1;
      changeListener = listener;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscriptions += 1;
        changeListener = null;
      };
    }
  };
  const service = createLanguagePacksPanel({
    document,
    getI18n: () => i18n,
    getTrashIcon: () => '<trusted-icon>',
    confirm: () => true
  });
  assert.equal(Object.isFrozen(service), true);

  const firstInit = service.init();
  const secondInit = service.init();
  assert.equal(firstInit, secondInit);
  assert.equal(initCalls, 1);
  initGate.resolve();
  assert.equal(await firstInit, true);
  assert.equal(subscriptions, 1);
  assert.equal(typeof changeListener, 'function');
  assert.equal(listCalls, 1);

  const current = document.getElementById('language-pack-current');
  const list = document.getElementById('language-pack-list');
  const install = document.getElementById('language-pack-install');
  const openFolder = document.getElementById('language-pack-open-folder');
  const refresh = document.getElementById('language-pack-refresh');
  assert.equal(current.listenerCount('change'), 1);
  assert.equal(list.listenerCount('click'), 1);
  assert.equal(install.listenerCount('click'), 1);
  assert.equal(openFolder.listenerCount('click'), 1);
  assert.equal(refresh.listenerCount('click'), 1);
  assert.equal(list.children.length, 2);
  assert.equal((await service.render(null)).length, 2);

  const staleGate = deferred();
  const latestGate = deferred();
  const pendingLists = [staleGate.promise, latestGate.promise];
  i18n.listPacks = async () => pendingLists.shift();
  activeId = 'ja';
  const staleRender = service.render();
  const latestRender = service.render();
  latestGate.resolve([pack('ja', 'Latest Japanese', 'user')]);
  const latest = await latestRender;
  assert.deepEqual(latest.map(({ id }) => id), ['ja']);
  assert.equal(list.children[0].dataset.packId, 'ja');
  staleGate.resolve([pack('en', 'Stale English')]);
  assert.deepEqual(await staleRender, []);
  assert.equal(list.children[0].dataset.packId, 'ja');

  i18n.listPacks = async () => initialPacks;
  const installGate = deferred();
  const refreshGate = deferred();
  i18n.install = async () => installGate.promise;
  i18n.refresh = async () => refreshGate.promise;
  install.dispatch('click');
  const refreshOperation = service.refresh();
  assert.equal(install.disabled, true);
  assert.equal(refresh.disabled, true);
  installGate.resolve(null);
  await nextTurn();
  assert.equal(install.disabled, true, 'one completed action must not clear another action\'s busy state');
  refreshGate.resolve();
  await refreshOperation;
  assert.equal(install.disabled, false);
  assert.equal(refresh.disabled, false);

  const removableRow = list.children.find(({ dataset }) => dataset.packId === 'ja');
  const removeButton = removableRow.querySelector('[data-remove-pack]');
  const removeGate = deferred();
  i18n.remove = async () => removeGate.promise;
  list.dispatch('click', removeButton);
  assert.equal(removableRow.getAttribute('aria-busy'), 'true');

  service.dispose();
  service.dispose();
  removeGate.reject(new Error('late remove failure'));
  await nextTurn();
  assert.equal(service.disposed, true);
  assert.equal(unsubscriptions, 1);
  assert.equal(changeListener, null);
  assert.equal(current.listenerCount('change'), 0);
  assert.equal(list.listenerCount('click'), 0);
  assert.equal(install.listenerCount('click'), 0);
  assert.equal(openFolder.listenerCount('click'), 0);
  assert.equal(refresh.listenerCount('click'), 0);
  assert.equal(removableRow.getAttribute('aria-busy'), 'true', 'disposed actions must not write stale DOM');
  assert.deepEqual(await service.render(), []);
});
