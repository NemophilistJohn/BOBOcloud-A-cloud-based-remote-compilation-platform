'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadRcloneSettingsModule() {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/rclone-settings.ts'],
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

const { createRcloneSettings } = loadRcloneSettingsModule();

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

  dispatch(type, init = {}) {
    const event = Object.assign({
      type,
      target: this,
      key: '',
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      }
    }, init);
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
    return event;
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
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.innerHTML = '';
    this.rect = { top: 100, bottom: 140 };
    this.styleProperties = new Map();
    this.style = {
      setProperty: (name, value) => this.styleProperties.set(name, String(value))
    };
    this.classList = {
      add: (...names) => this.updateClasses(names, true),
      remove: (...names) => this.updateClasses(names, false),
      contains: (name) => this.classTokens().has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classTokens().has(name) : Boolean(force);
        this.updateClasses([name], enabled);
        return enabled;
      }
    };
    if (id) ownerDocument.elements.set(id, this);
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

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  matches(selector) {
    if (selector === '.settings-body') return this.classTokens().has('settings-body');
    if (selector === '[data-candidate-id]') return typeof this.dataset.candidateId === 'string';
    return false;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return Object.assign({ left: 0, right: 300, width: 300, height: this.rect.bottom - this.rect.top }, this.rect);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.elements = new Map();
    this.activeElement = null;
    this.settingsBody = new FakeElement(this, 'div');
    this.settingsBody.className = 'settings-body';
    this.settingsBody.rect = { top: 20, bottom: 300 };
    const root = new FakeElement(this, 'div', 'rclone-selector');
    const trigger = new FakeElement(this, 'button', 'rclone-path');
    const title = new FakeElement(this, 'span', 'rclone-select-title');
    const meta = new FakeElement(this, 'span', 'rclone-select-meta');
    const options = new FakeElement(this, 'div', 'rclone-options');
    const status = new FakeElement(this, 'div', 'rclone-status');
    options.hidden = true;
    this.settingsBody.appendChild(root);
    root.appendChild(trigger);
    trigger.appendChild(title);
    trigger.appendChild(meta);
    root.appendChild(options);
    this.settingsBody.appendChild(status);
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

class FakeWindow extends FakeEventTarget {
  constructor() {
    super();
    this.innerHeight = 600;
    this.nextFrame = 1;
    this.frames = new Map();
  }

  requestAnimationFrame(callback) {
    const id = this.nextFrame++;
    this.frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id) {
    this.frames.delete(id);
  }

  flushFrames() {
    const frames = [...this.frames.values()];
    this.frames.clear();
    frames.forEach((callback) => callback(0));
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

function translate(source, replacements) {
  return String(source).replace(/\{([^}]+)\}/g, (match, key) => (
    replacements?.[key] === undefined ? match : String(replacements[key])
  ));
}

function bundledSelection() {
  return { source: 'bundled', path: null, version: null };
}

function bundledVersion() {
  return {
    available: true,
    source: 'bundled',
    path: null,
    version: 'rclone v1.64.0',
    revision: 'bundled:digest'
  };
}

function scanResult() {
  return {
    scanId: 'scan-1',
    selection: bundledSelection(),
    candidates: [
      { id: 'bundled-1', source: 'bundled', path: null, selected: true },
      { id: 'system-1', source: 'system', path: '/usr/bin/rclone', selected: false }
    ]
  };
}

function createFixture(overrides = {}) {
  const document = new FakeDocument();
  const window = new FakeWindow();
  let changeListener = null;
  let unsubscribeCalls = 0;
  const i18n = {
    t: translate,
    onChange(listener) {
      changeListener = listener;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribeCalls += 1;
        changeListener = null;
      };
    }
  };
  const client = Object.assign({
    async listBinaries() {
      return scanResult();
    },
    async getSelection() {
      return bundledSelection();
    },
    async selectBinary() {
      return { cancelled: true, selection: bundledSelection() };
    },
    async checkVersion() {
      return bundledVersion();
    }
  }, overrides);
  const service = createRcloneSettings({
    document,
    window,
    client,
    getI18n: () => i18n
  });
  return {
    document,
    window,
    client,
    service,
    get changeListener() {
      return changeListener;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    }
  };
}

test('rclone settings initializes once, preserves UI semantics, and releases owned listeners', async () => {
  const fixture = createFixture();
  const { document, window, service } = fixture;
  const trigger = document.getElementById('rclone-path');
  const options = document.getElementById('rclone-options');
  const title = document.getElementById('rclone-select-title');
  const status = document.getElementById('rclone-status');

  assert.equal(Object.isFrozen(service), true);
  service.initialize();
  service.initialize();
  assert.equal(trigger.listenerCount('click'), 1);
  assert.equal(trigger.listenerCount('keydown'), 1);
  assert.equal(options.listenerCount('click'), 1);
  assert.equal(options.listenerCount('keydown'), 1);
  assert.equal(document.listenerCount('pointerdown'), 1);
  assert.equal(window.listenerCount('resize'), 1);
  assert.equal(document.settingsBody.listenerCount('scroll'), 1);
  assert.equal(typeof fixture.changeListener, 'function');

  await service.open();
  assert.equal(title.textContent, 'App bundled rclone (Recommended)');
  assert.match(status.textContent, /Bundled rclone available/);
  trigger.dispatch('click');
  await nextTurn();
  assert.equal(options.hidden, false);
  assert.equal(options.children.length, 2);
  assert.equal(options.children[0].getAttribute('role'), 'option');

  window.dispatch('resize');
  window.dispatch('resize');
  assert.equal(window.frames.size, 1, 'resize positioning must be frame-coalesced');
  window.flushFrames();
  assert.equal(window.frames.size, 0);

  service.dispose();
  service.dispose();
  assert.equal(service.disposed, true);
  assert.equal(fixture.unsubscribeCalls, 1);
  assert.equal(trigger.listenerCount('click'), 0);
  assert.equal(trigger.listenerCount('keydown'), 0);
  assert.equal(options.listenerCount('click'), 0);
  assert.equal(options.listenerCount('keydown'), 0);
  assert.equal(document.listenerCount('pointerdown'), 0);
  assert.equal(window.listenerCount('resize'), 0);
  assert.equal(document.settingsBody.listenerCount('scroll'), 0);
});

test('a completed selection mutation stays authoritative over a concurrent status read', async () => {
  const selectionGate = deferred();
  const fixture = createFixture({
    async selectBinary() {
      return selectionGate.promise;
    }
  });
  const { document, service } = fixture;
  const trigger = document.getElementById('rclone-path');
  const options = document.getElementById('rclone-options');
  service.initialize();
  trigger.dispatch('click');
  await nextTurn();
  const candidate = options.children[1];
  options.dispatch('click', { target: candidate });
  assert.equal(options.children.every((option) => option.disabled), true);

  await service.refreshStatus();
  selectionGate.resolve({
    cancelled: false,
    selection: {
      source: 'system',
      path: '/usr/bin/rclone',
      version: 'rclone v1.64.0',
      confirmedAt: 123
    },
    version: {
      available: true,
      source: 'system',
      path: '/usr/bin/rclone',
      version: 'rclone v1.64.0',
      revision: 'external:digest'
    }
  });
  await nextTurn();
  assert.equal(options.hidden, true);
  assert.equal(document.getElementById('rclone-select-title').textContent, 'System PATH rclone');
  assert.match(document.getElementById('rclone-status').textContent, /System PATH rclone available/);
  assert.equal(document.activeElement, trigger);
  assert.equal(trigger.getAttribute('aria-busy'), null);
  service.dispose();
});

test('a pending selection remains single-flight after its menu closes', async () => {
  const selectionGate = deferred();
  let listCalls = 0;
  let selectCalls = 0;
  const fixture = createFixture({
    async listBinaries() {
      listCalls += 1;
      return scanResult();
    },
    async selectBinary() {
      selectCalls += 1;
      return selectionGate.promise;
    }
  });
  const { document, service } = fixture;
  const trigger = document.getElementById('rclone-path');
  const options = document.getElementById('rclone-options');
  const status = document.getElementById('rclone-status');
  service.initialize();
  await service.open();
  trigger.dispatch('click');
  await nextTurn();
  options.dispatch('click', { target: options.children[1] });
  assert.equal(selectCalls, 1);

  trigger.dispatch('click');
  assert.equal(options.hidden, true);
  trigger.dispatch('click');
  trigger.focus();
  trigger.dispatch('keydown', { key: 'ArrowDown' });
  options.dispatch('click', { target: options.children[0] });
  assert.equal(options.hidden, true);
  assert.equal(document.activeElement, trigger);
  assert.equal(listCalls, 1);
  assert.equal(selectCalls, 1);

  selectionGate.reject(new Error('candidate validation failed'));
  await nextTurn();
  assert.match(status.textContent, /Could not select rclone: candidate validation failed/);
  trigger.dispatch('click');
  await nextTurn();
  assert.equal(options.hidden, false);
  assert.equal(listCalls, 2);
  service.dispose();
});

test('late scans cannot commit after disposal', async () => {
  const scanGate = deferred();
  const fixture = createFixture({
    async listBinaries() {
      return scanGate.promise;
    }
  });
  const { document, service } = fixture;
  const trigger = document.getElementById('rclone-path');
  const options = document.getElementById('rclone-options');
  service.initialize();
  trigger.dispatch('click');
  assert.equal(options.children[0].className, 'rclone-options-loading');
  service.dispose();
  scanGate.resolve(scanResult());
  await nextTurn();
  assert.equal(options.children.length, 1);
  assert.equal(options.children[0].className, 'rclone-options-loading');
});
