'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

function readPacks() {
  return Object.fromEntries(LOCALES.map((locale) => [
    locale,
    JSON.parse(fs.readFileSync(path.join(ROOT, 'language-packs', locale, 'messages.json'), 'utf8'))
  ]));
}

class FakeElement {
  constructor(tagName, id) {
    this.tagName = String(tagName).toUpperCase();
    this.id = id || '';
    this.className = '';
    this.childNodes = [];
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentElement = this;
    if (this.tagName === 'SELECT' && child.selected) this.value = child.value;
    return child;
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
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

function createDiagnosticsRuntime() {
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
  let languageListener;
  let locale = 'en';
  const translations = { ja: { General: '全般', 'Missing semicolon': 'セミコロンの欠落' } };
  const bindText = (element, source) => { element.textContent = translations[locale]?.[source] || source; };
  const sandbox = {
    console,
    document,
    editorRuleRegistry: {
      DEFAULT_DIAGNOSTICS_SETTINGS: {
        enabled: true,
        checkOn: 'type',
        debounceMs: 300,
        checks: { missingSemicolon: { enabled: true, severity: 'warning' } }
      }
    },
    BOBO: {
      state: { diagnosticsSettings: null },
      i18n: {
        t(source) { return translations[locale]?.[source] || source; },
        bindText,
        bindAttribute(element, attribute, source) { element.setAttribute(attribute, translations[locale]?.[source] || source); }
      }
    },
    api: { onOpenDiagnosticsSettings() {}, writeDiagnosticsSettings() { return Promise.resolve(); } },
    addEventListener(type, listener) { if (type === 'bobo:language-changed') languageListener = listener; }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'src', 'diagnostics-settings.js'), 'utf8'),
    sandbox,
    { filename: 'src/diagnostics-settings.js' }
  );

  return {
    sandbox,
    body,
    modal,
    setLocale(nextLocale) { locale = nextLocale; },
    fireLanguageChange() { languageListener(); }
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
  const source = fs.readFileSync(path.join(ROOT, 'src', 'diagnostics-settings.js'), 'utf8');
  assert.match(source, /o\.textContent = t\(sv\.label\)/);
  assert.match(source, /lab\.textContent = t\(c\.label\)/);
  assert.match(source, /d\.textContent = t\(c\.desc\)/);
  assert.match(source, /bindStaticText\(\)/);
  assert.match(source, /addEventListener\('bobo:language-changed'/);
  assert.match(source, /render\(collect\(\)\)/);
});

test('an open Diagnostics Settings form keeps unsaved values when the locale changes', () => {
  const runtime = createDiagnosticsRuntime();
  runtime.sandbox.BOBO.diagnosticsSettings.init();
  runtime.sandbox.BOBO.diagnosticsSettings.open();

  const form = runtime.sandbox.BOBO.state._diagForm;
  form.enabled.checked = false;
  form.debounceMs.value = '0';
  assert.equal(descendants(runtime.body).find((element) => element.textContent === 'General').textContent, 'General');

  runtime.setLocale('ja');
  runtime.fireLanguageChange();

  const translatedText = descendants(runtime.body).map((element) => element.textContent);
  assert.ok(translatedText.includes('全般'));
  assert.ok(translatedText.includes('セミコロンの欠落'));
  assert.equal(runtime.sandbox.BOBO.state._diagForm.enabled.checked, false);
  assert.equal(runtime.sandbox.BOBO.state._diagForm.debounceMs.value, 0);
});

test('menu and Diagnostics Settings keys exist in every built-in language pack', () => {
  const packs = readPacks();
  const mainSource = fs.readFileSync(path.join(ROOT, 'main', 'menu.js'), 'utf8');
  const menuSource = mainSource.slice(mainSource.indexOf('function buildTemplate()'), mainSource.indexOf('function rebuild()'));
  const diagnosticsSource = fs.readFileSync(path.join(ROOT, 'src', 'diagnostics-settings.js'), 'utf8');
  const literalCalls = (source, pattern) => Array.from(source.matchAll(pattern), (match) => Function(`return ${match[1]}`)());
  const catalogBlock = diagnosticsSource.slice(
    diagnosticsSource.indexOf('var CHECK_CATALOG = ['),
    diagnosticsSource.indexOf('function defaults()')
  );
  const required = new Set([
    'Edit', 'View', 'Speech', 'Theme...',
    ...Object.values(MENU_ROLE_LABELS),
    ...DIAGNOSTICS_KEYS,
    ...literalCalls(menuSource, /\bt\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g),
    ...literalCalls(diagnosticsSource, /\bt\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g),
    ...literalCalls(diagnosticsSource, /\bbind(?:Text|Attribute)\(\s*[^,]+,\s*(?:[^,]+,\s*)?((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g),
    ...literalCalls(catalogBlock, /\b(?:label|desc):\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g)
  ]);

  for (const locale of LOCALES) {
    for (const key of required) {
      assert.ok(Object.hasOwn(packs[locale], key), `${locale}: missing translation key ${key}`);
      assert.notEqual(packs[locale][key], '', `${locale}: empty translation for ${key}`);
    }
  }
});
