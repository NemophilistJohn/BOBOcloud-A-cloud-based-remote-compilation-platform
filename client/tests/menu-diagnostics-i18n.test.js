'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ja', 'zh-CN'];

const MENU_ROLE_LABELS = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteAndMatchStyle: 'Paste and Match Style',
  delete: 'Delete',
  selectAll: 'Select All',
  startSpeaking: 'Start Speaking',
  stopSpeaking: 'Stop Speaking',
  reload: 'Reload',
  forceReload: 'Force Reload',
  toggleDevTools: 'Toggle Developer Tools',
  resetZoom: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  togglefullscreen: 'Toggle Full Screen'
};

const DIAGNOSTICS_KEYS = [
  'Diagnostics Settings', 'Reset to Defaults', 'Cancel', 'Save & Re-check', 'Close',
  'General', 'Enable diagnostics', 'Check on', 'While typing (debounced)',
  'On save only', 'Debounce (ms)', 'Checks', 'Max line length',
  'Missing semicolon',
  'Statements without a terminating ; (C / C++ / Java). Uses a real tokenizer, so for/if/while headers are not flagged.',
  'Stray / unexpected tokens',
  'Invalid tokens at file scope (bare numbers, operators, unknown chars) and stray characters.',
  'Unmatched brackets', 'Mismatched or unclosed ( ) [ ] { }.',
  'Unclosed strings', 'String / char literals not closed on the same line.',
  'Assignment in condition', '= used inside an if / while condition (likely meant ==).',
  'Unsafe functions', 'gets(), scanf("%s") without field width, and similar.',
  'Trailing whitespace', 'Spaces or tabs at the end of a line.',
  'Mixed tabs & spaces', 'File mixes tab and space indentation.',
  'Long lines', 'Lines exceeding the length limit.',
  'TODO / FIXME / HACK', 'Highlight task markers in comments.',
  'C++ modernization', 'NULL → nullptr, C-style casts → static_cast.',
  'Language style hints',
  'Python / Java / Rust / Go best-practice nits (bare except, unwrap, raw types...).',
  'Error', 'Warning', 'Info', 'Hint'
];

function loadDiagnosticsModule() {
  const result = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, 'src', 'diagnostics-settings.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const loadedModule = { exports: {} };
  Function('module', 'exports', 'require', result.outputFiles[0].text)(
    loadedModule,
    loadedModule.exports,
    require
  );
  return loadedModule.exports;
}

const { createDiagnosticsSettings, DIAGNOSTICS_CHECK_CATALOG } = loadDiagnosticsModule();

function readPacks() {
  return Object.fromEntries(LOCALES.map((locale) => [
    locale,
    JSON.parse(fs.readFileSync(path.join(ROOT, 'language-packs', locale, 'messages.json'), 'utf8'))
  ]));
}

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

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, id) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.id = id || '';
    this.className = '';
    this.childNodes = [];
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
    this._innerHTML = '';
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentElement = this;
    if (this.tagName === 'SELECT' && child.selected) this.value = child.value;
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this._innerHTML = String(value);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
}

function descendants(root) {
  const result = [];
  for (const child of root.childNodes) {
    result.push(child, ...descendants(child));
  }
  return result;
}

function createDiagnosticsRuntime(options = {}) {
  const elements = new Map();
  const modal = new FakeElement('div', 'diag-modal');
  modal.style.display = 'none';
  const title = new FakeElement('div');
  title.className = 'ss-title';
  modal.appendChild(title);
  const body = new FakeElement('div', 'diag-body');
  modal.appendChild(body);
  for (const id of ['diag-close-x', 'diag-reset', 'diag-close', 'diag-save']) {
    modal.appendChild(new FakeElement('button', id));
  }
  for (const element of [modal, body, ...descendants(modal)]) {
    if (element.id) elements.set(element.id, element);
  }

  function matchingDynamic(selector) {
    return descendants(body).filter((element) => {
      if (selector === '.diag-toggle input[data-check-id]') {
        return element.tagName === 'INPUT' && Object.hasOwn(element.dataset, 'checkId');
      }
      if (selector === '.diag-sev-select[data-check-id]') {
        return element.tagName === 'SELECT' && element.className.includes('diag-sev-select') &&
          Object.hasOwn(element.dataset, 'checkId');
      }
      return false;
    });
  }

  const document = {
    createElement(tagName) { return new FakeElement(tagName); },
    getElementById(id) { return elements.get(id) || null; },
    querySelector(selector) { return selector === '#diag-modal .ss-title' ? title : null; },
    querySelectorAll(selector) { return matchingDynamic(selector); }
  };
  let locale = 'en';
  const translations = { ja: { General: '全般', 'Missing semicolon': 'セミコロンの欠落' } };
  const bindText = (element, source) => { element.textContent = translations[locale]?.[source] || source; };
  const state = { diagnosticsSettings: null };
  const languageEvents = new FakeEventTarget();
  const editorRuleRegistry = {
    DEFAULT_DIAGNOSTICS_SETTINGS: {
      enabled: true,
      checkOn: 'type',
      debounceMs: 300,
      checks: { missingSemicolon: { enabled: true, severity: 'warning' } }
    },
    setDiagnosticsSettings() {}
  };
  let openListener = null;
  const notifications = [];
  const service = createDiagnosticsSettings({
    host: {
      readSettings() { return Promise.resolve(null); },
      writeSettings() { return Promise.resolve(options.writeResult ?? true); },
      onOpen(listener) {
        openListener = listener;
        return { dispose() { if (openListener === listener) openListener = null; } };
      }
    },
    document,
    languageEvents,
    getState: () => state,
    getI18n: () => ({
      t(source) { return translations[locale]?.[source] || source; },
      bindText,
      bindAttribute(element, attribute, source) {
        element.setAttribute(attribute, translations[locale]?.[source] || source);
      }
    }),
    getRuleRegistry: () => editorRuleRegistry,
    getEditorCore: () => ({ recheckAll() {} }),
    getToast: () => ({ error: (message) => notifications.push(message) })
  });

  return {
    service,
    state,
    body,
    modal,
    notifications,
    setLocale(nextLocale) { locale = nextLocale; },
    fireLanguageChange() { languageEvents.dispatchEvent({ type: 'bobo:language-changed' }); }
  };
}

test('Edit and View roles use explicit translated labels and View has no chat entry', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main', 'menu.js'), 'utf8');
  const menuSource = source.slice(source.indexOf('function buildTemplate()'), source.indexOf('function rebuild()'));

  for (const [role, label] of Object.entries(MENU_ROLE_LABELS)) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedRole = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(menuSource, new RegExp(`label: t\\('${escapedLabel}'\\), role: '${escapedRole}'`));
  }
  assert.doesNotMatch(menuSource, /Toggle AI Chat|toggle-ai-chat/);
  const compositionSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(compositionSource, /onDidChange:[\s\S]*?menu\.rebuild\(\)/);
});

test('Diagnostics Settings translates dynamic content and preserves its open draft on locale changes', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'diagnostics-settings.ts'), 'utf8');
  assert.match(source, /export const DIAGNOSTICS_CHECK_CATALOG = Object\.freeze\(/);
  assert.match(source, /option\.textContent = t\(label\)/);
  assert.match(source, /label\.textContent = t\(catalogEntry\.label\)/);
  assert.match(source, /description\.textContent = t\(catalogEntry\.desc\)/);
  assert.match(source, /bindStaticText\(\)/);
  assert.match(source, /addListener\(languageEvents, 'bobo:language-changed'/);
  assert.match(source, /render\(collect\(\)\)/);
});

test('an open Diagnostics Settings form keeps unsaved values when the locale changes', () => {
  const runtime = createDiagnosticsRuntime();
  runtime.service.init();
  runtime.service.open();

  const form = runtime.state._diagForm;
  form.enabled.checked = false;
  form.debounceMs.value = '0';
  assert.equal(descendants(runtime.body).find((element) => element.textContent === 'General').textContent, 'General');

  runtime.setLocale('ja');
  runtime.fireLanguageChange();

  const translatedText = descendants(runtime.body).map((element) => element.textContent);
  assert.ok(translatedText.includes('全般'));
  assert.ok(translatedText.includes('セミコロンの欠落'));
  assert.equal(runtime.state._diagForm.enabled.checked, false);
  assert.equal(runtime.state._diagForm.debounceMs.value, '0');
  runtime.service.dispose();
});

test('a failed Diagnostics save keeps its draft open and the unified settings waits for confirmation', async () => {
  const runtime = createDiagnosticsRuntime({ writeResult: false });
  runtime.service.init();
  runtime.service.open();
  runtime.state._diagForm.enabled.checked = false;
  const save = runtime.modal.childNodes.find((element) => element.id === 'diag-save');
  save.dispatchEvent({ type: 'click', target: save });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.modal.style.display, 'flex');
  assert.equal(runtime.state._diagForm.enabled.checked, false);
  assert.deepEqual(runtime.notifications, ['Failed to save diagnostics settings']);
  const settingsSource = fs.readFileSync(path.join(ROOT, 'src', 'settings.js'), 'utf8');
  assert.match(settingsSource, /diagnosticsSave\.then\(function\(saved\)/);
  assert.match(settingsSource, /if \(saved === true\) close\(\)/);
  runtime.service.dispose();
});

test('menu and Diagnostics Settings keys exist in every built-in language pack', () => {
  const packs = readPacks();
  const mainSource = fs.readFileSync(path.join(ROOT, 'main', 'menu.js'), 'utf8');
  const menuSource = mainSource.slice(mainSource.indexOf('function buildTemplate()'), mainSource.indexOf('function rebuild()'));
  const diagnosticsSource = fs.readFileSync(path.join(ROOT, 'src', 'diagnostics-settings.ts'), 'utf8');
  const literalCalls = (source, pattern) => Array.from(source.matchAll(pattern), (match) => Function(`return ${match[1]}`)());
  const required = new Set([
    'Edit', 'View', 'Speech', 'Theme...',
    ...Object.values(MENU_ROLE_LABELS),
    ...DIAGNOSTICS_KEYS,
    ...literalCalls(menuSource, /\bt\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g),
    ...literalCalls(diagnosticsSource, /\bt\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g),
    ...literalCalls(diagnosticsSource, /\bbind(?:Text|Attribute)\(\s*[^,]+,\s*(?:[^,]+,\s*)?((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g),
    ...DIAGNOSTICS_CHECK_CATALOG.flatMap(({ label, desc }) => [label, desc])
  ]);

  for (const locale of LOCALES) {
    for (const key of required) {
      assert.ok(Object.hasOwn(packs[locale], key), `${locale}: missing translation key ${key}`);
      assert.notEqual(packs[locale][key], '', `${locale}: empty translation for ${key}`);
    }
  }
});
