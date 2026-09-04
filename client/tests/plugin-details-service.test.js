'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadPluginDetailsModule() {
  const build = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/plugin-details.ts'],
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

const { createPluginDetailsService } = loadPluginDetailsModule();

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

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(ownerDocument, tagName, id = '') {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this._id = '';
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.innerHTML = '';
    this.scrollTop = 0;
    this.classList = {
      add: (...names) => this.updateClasses(names, true),
      remove: (...names) => this.updateClasses(names, false),
      contains: (name) => this.classTokens().has(name)
    };
    this.id = id;
  }

  get id() {
    return this._id;
  }

  set id(value) {
    if (this._id && this.ownerDocument.elements.get(this._id) === this) {
      this.ownerDocument.elements.delete(this._id);
    }
    this._id = String(value || '');
    if (this._id) this.ownerDocument.elements.set(this._id, this);
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

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  appendChild(child) {
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

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
      this.parentNode = null;
    }
    if (this.id && this.ownerDocument.elements.get(this.id) === this) {
      this.ownerDocument.elements.delete(this.id);
    }
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.documentElement = { lang: 'en' };
    this.editor = new FakeElement(this, 'main', 'editor');
    this.container = new FakeElement(this, 'section', 'container');
    this.split = new FakeElement(this, 'section', 'split-container');
    this.diff = new FakeElement(this, 'section', 'diff-container');
    this.image = new FakeElement(this, 'section', 'image-preview');
    this.split.classList.add('active');
    this.image.classList.add('hidden');
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }
}

function pluginStatus() {
  return {
    id: 'acme.details',
    displayName: 'Details',
    description: 'Detail test plugin',
    version: '1.0.0',
    enabled: true,
    status: 'enabled',
    requestedPermissions: ['commands.register'],
    grantedPermissions: ['commands.register'],
    manifest: {
      id: 'acme.details',
      displayName: 'Details',
      description: 'Detail test plugin',
      version: '1.0.0',
      engines: { bobocloud: '*', pluginApi: '^1.0.0' },
      activationEvents: ['onStartup'],
      permissions: ['commands.register'],
      contributes: {}
    },
    integrity: { valid: true, reason: '' },
    installedAt: '2026-09-04T00:00:00.000Z'
  };
}

function createHarness() {
  const document = new FakeDocument();
  const window = new FakeEventTarget();
  const fileModel = { id: 'original-model' };
  const fileTab = { path: 'C:\\workspace\\main.ts', model: fileModel };
  const state = {
    tabs: [fileTab],
    pluginDetailTabs: [],
    activeTabPath: fileTab.path,
    currentViewMode: 'split',
    diffOriginalPath: '',
    diffModifiedPath: ''
  };
  const hostListeners = new Set();
  let hostDisposals = 0;
  let provider = null;
  let providerDisposals = 0;
  let splitRestores = 0;
  const activatedPaths = [];

  const host = {
    get: async () => pluginStatus(),
    onDidChange(listener) {
      hostListeners.add(listener);
      let active = true;
      return {
        dispose() {
          if (!active) return;
          active = false;
          hostDisposals += 1;
          hostListeners.delete(listener);
        }
      };
    }
  };
  const workspace = {
    registerWorkbenchTabProvider(id, candidate) {
      assert.equal(id, 'plugin-details');
      provider = candidate;
      let active = true;
      return {
        dispose() {
          if (!active) return;
          active = false;
          providerDisposals += 1;
          provider = null;
        }
      };
    },
    activateTab(filePath) {
      assert.ok(provider, 'the provider must remain registered while the underlying view is restored');
      activatedPaths.push(filePath);
      provider.deactivate();
      state.activeTabPath = filePath;
      state.currentViewMode = 'single';
      provider.afterFileActivation(fileTab);
    },
    updateTabbar() {},
    updateTitlebar() {},
    updateEmptyState() {}
  };
  const views = {
    openSplit() {
      splitRestores += 1;
      document.split.classList.add('active');
      document.container.style.display = 'none';
      state.currentViewMode = 'split';
    },
    openDiff() {
      throw new Error('the split snapshot must not restore as diff');
    }
  };
  const service = createPluginDetailsService({
    document,
    window,
    host,
    state,
    getI18n: () => ({ t: (key) => key }),
    getWorkspace: () => workspace,
    getViews: () => views,
    getDocumentViews: () => ({ hideAll() {} }),
    getConfirm: () => undefined,
    nativeConfirm: () => false
  });

  return {
    service,
    document,
    window,
    state,
    fileTab,
    activatedPaths,
    get hostListenerCount() { return hostListeners.size; },
    get hostDisposals() { return hostDisposals; },
    get provider() { return provider; },
    get providerDisposals() { return providerDisposals; },
    get splitRestores() { return splitRestores; }
  };
}

test('dispose restores the underlying workbench view and releases every owned resource', async () => {
  const harness = createHarness();
  harness.service.init();

  const detailsRoot = harness.document.getElementById('plugin-details-view');
  assert.ok(detailsRoot);
  assert.equal(detailsRoot.listenerCount('click'), 1);
  assert.equal(harness.hostListenerCount, 1);
  assert.ok(harness.provider);
  assert.equal(harness.window.listenerCount('bobo:language-changed'), 1);
  assert.equal(harness.window.listenerCount('bobo:open-plugin-details'), 1);

  assert.equal(await harness.service.open('acme.details'), true);
  assert.equal(harness.state.currentViewMode, 'plugin-details');
  assert.equal(harness.state.pluginDetailTabs.length, 1);
  assert.equal(harness.document.container.style.display, 'none');

  harness.service.dispose();

  assert.equal(harness.service.disposed, true);
  assert.deepEqual(harness.activatedPaths, [harness.fileTab.path]);
  assert.equal(harness.state.activeTabPath, harness.fileTab.path);
  assert.equal(harness.state.currentViewMode, 'split');
  assert.equal(harness.splitRestores, 1);
  assert.equal(harness.document.split.classList.contains('active'), true);
  assert.deepEqual(harness.state.pluginDetailTabs, []);
  assert.equal(harness.document.getElementById('plugin-details-view'), null);
  assert.equal(detailsRoot.listenerCount('click'), 0);
  assert.equal(harness.hostListenerCount, 0);
  assert.equal(harness.hostDisposals, 1);
  assert.equal(harness.provider, null);
  assert.equal(harness.providerDisposals, 1);
  assert.equal(harness.window.listenerCount('bobo:language-changed'), 0);
  assert.equal(harness.window.listenerCount('bobo:open-plugin-details'), 0);

  harness.service.dispose();
  assert.equal(harness.hostDisposals, 1);
  assert.equal(harness.providerDisposals, 1);
});
