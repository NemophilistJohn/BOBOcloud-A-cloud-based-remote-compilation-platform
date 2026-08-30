const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

class FakeNode {
  constructor(type) {
    this.nodeType = type;
    this.parentNode = null;
    this.parentElement = null;
    this.childNodes = [];
  }

  appendChild(child) {
    child.parentNode = this;
    child.parentElement = this.nodeType === 1 ? this : null;
    this.childNodes.push(child);
    return child;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.childNodes.some((child) => child.contains(candidate));
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

  closest(selector) {
    let current = this;
    while (current && current.nodeType === 1) {
      const id = current.getAttribute('id');
      if (id && selector.includes(`#${id}`)) return current;
      if (current.hasAttribute('data-i18n-skip') && selector.includes('[data-i18n-skip]')) return current;
      current = current.parentElement;
    }
    return null;
  }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  get textContent() {
    return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new FakeText(String(value)));
  }
}

function waitForMutationFlush() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function createRuntime() {
  const traversalRoots = [];
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  documentElement.lang = '';
  documentElement.dir = '';

  const document = {
    body,
    documentElement,
    createTreeWalker(root, _whatToShow, filter) {
      traversalRoots.push(root);
      const nodes = [];
      const collect = (node) => {
        node.childNodes.forEach((child) => {
          const decision = filter && filter.acceptNode ? filter.acceptNode(child) : 1;
          if (decision === 2) return;
          nodes.push(child);
          collect(child);
        });
      };
      collect(root);
      let index = 0;
      return {
        currentNode: root,
        nextNode() { return nodes[index++] || null; }
      };
    }
  };

  let mutationObserver;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutationObserver = this;
    }
    observe() {}
    disconnect() {}
  }

  const packs = {
    'zh-CN': { manifest: { id: 'zh-CN', locale: 'zh-CN', direction: 'ltr' }, messages: { Hello: '你好', Added: '新增', Changed: '改变', Working: '处理中', '{count} messages': 'ZH {count}' } },
    ja: { manifest: { id: 'ja', locale: 'ja', direction: 'ltr' }, messages: { Hello: 'こんにちは', Added: '追加', Changed: '変更', Working: '処理中', '{count} messages': 'JA {count}' } }
  };
  let activeId = 'zh-CN';
  const startup = () => ({ activeId, pack: packs[activeId], packs: Object.values(packs), errors: [] });

  const sandbox = {
    api: {
      languagePacksStartup: async () => startup(),
      languagePackLoad: async (id) => packs[id],
      languagePackSetActive: async (id) => { activeId = id; return startup(); }
    },
    console,
    CustomEvent: function CustomEvent(type, options) { this.type = type; this.detail = options.detail; },
    dispatchEvent() {},
    document,
    MutationObserver: FakeMutationObserver,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'i18n.js'), 'utf8'), sandbox, { filename: 'src/i18n.js' });

  return { sandbox, body, documentElement, traversalRoots, getObserver: () => mutationObserver };
}

test('DOM mutations translate only added or changed roots while locale changes scan the document', async () => {
  const runtime = createRuntime();
  const original = runtime.body.appendChild(new FakeText('Hello'));

  await runtime.sandbox.BOBO.i18n.init();
  assert.equal(original.nodeValue, '你好');
  assert.equal(runtime.traversalRoots.at(-1), runtime.body);

  runtime.traversalRoots.length = 0;
  const added = runtime.body.appendChild(new FakeElement('section'));
  const addedText = added.appendChild(new FakeText('Added'));
  runtime.getObserver().callback([
    { type: 'childList', addedNodes: [added] },
    { type: 'characterData', target: addedText }
  ]);
  await waitForMutationFlush();

  assert.equal(addedText.nodeValue, '新增');
  assert.deepEqual(runtime.traversalRoots, [added]);
  assert.ok(!runtime.traversalRoots.includes(runtime.body));

  original.nodeValue = 'Changed';
  runtime.getObserver().callback([{ type: 'characterData', target: original }]);
  await waitForMutationFlush();
  assert.equal(original.nodeValue, '改变');
  assert.ok(!runtime.traversalRoots.includes(runtime.body));

  runtime.traversalRoots.length = 0;
  await runtime.sandbox.BOBO.i18n.setLocale('ja');
  assert.equal(runtime.documentElement.lang, 'ja');
  assert.equal(original.nodeValue, '変更');
  assert.equal(addedText.nodeValue, '追加');
  assert.ok(runtime.traversalRoots.includes(runtime.body));
});

test('skipped elements prune their complete subtree from full translation walks', async () => {
  const runtime = createRuntime();
  const skipped = runtime.body.appendChild(new FakeElement('div'));
  skipped.setAttribute('id', 'file-tree');
  const nested = skipped.appendChild(new FakeElement('span'));
  const text = nested.appendChild(new FakeText('Hello'));

  await runtime.sandbox.BOBO.i18n.init();

  assert.equal(text.nodeValue, 'Hello');
  assert.ok(!runtime.traversalRoots.includes(skipped));
});

test('bound dynamic text and attributes update from Chinese to Japanese', async () => {
  const runtime = createRuntime();
  await runtime.sandbox.BOBO.i18n.init();
  const button = runtime.body.appendChild(new FakeElement('button'));
  const counter = runtime.body.appendChild(new FakeElement('span'));

  button.setAttribute('data-i18n', 'Hello');
  runtime.sandbox.BOBO.i18n.bindText(button, 'Working', null, { prefix: '... ' });
  runtime.sandbox.BOBO.i18n.bindAttribute(button, 'title', 'Working');
  runtime.sandbox.BOBO.i18n.bindText(counter, '{count} messages', { count: 3 });
  assert.equal(button.textContent, '... 处理中');
  assert.equal(button.getAttribute('title'), '处理中');
  assert.equal(counter.textContent, 'ZH 3');

  await runtime.sandbox.BOBO.i18n.setLocale('ja');
  assert.equal(button.textContent, '... 処理中');
  assert.equal(button.getAttribute('title'), '処理中');
  assert.equal(counter.textContent, 'JA 3');
});

test('observer keeps the source key when its own translated attribute mutation is delivered', async () => {
  const runtime = createRuntime();
  const button = runtime.body.appendChild(new FakeElement('button'));
  const text = button.appendChild(new FakeText('Hello'));
  button.setAttribute('title', 'Hello');

  await runtime.sandbox.BOBO.i18n.init();
  const chinese = runtime.sandbox.BOBO.i18n.t('Hello');
  assert.equal(text.nodeValue, chinese);
  assert.equal(button.getAttribute('title'), chinese);

  runtime.getObserver().callback([
    { type: 'characterData', target: text },
    { type: 'attributes', target: button, attributeName: 'title' }
  ]);
  await waitForMutationFlush();
  await runtime.sandbox.BOBO.i18n.setLocale('ja');

  const japanese = runtime.sandbox.BOBO.i18n.t('Hello');
  assert.notEqual(japanese, chinese);
  assert.equal(text.nodeValue, japanese);
  assert.equal(button.getAttribute('title'), japanese);
});

test('language packs have identical keys and placeholder contracts', () => {
  const locales = ['en', 'ja', 'zh-CN'];
  const sources = Object.fromEntries(locales.map((locale) => [
    locale,
    fs.readFileSync(path.join(ROOT, 'language-packs', locale, 'messages.json'), 'utf8')
  ]));
  const packs = Object.fromEntries(locales.map((locale) => [
    locale,
    JSON.parse(sources[locale])
  ]));
  const keys = Object.keys(packs.en).sort();
  const placeholders = (value) => Array.from(String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g), (match) => match[1]).sort();

  for (const locale of locales) {
    const rawKeys = Array.from(sources[locale].matchAll(/^\s*"((?:\\.|[^"\\])*)"\s*:/gm), (match) => JSON.parse('"' + match[1] + '"'));
    assert.equal(new Set(rawKeys).size, rawKeys.length, `${locale}: duplicate message key`);
  }
  for (const locale of locales.slice(1)) assert.deepEqual(Object.keys(packs[locale]).sort(), keys);
  for (const key of keys) {
    for (const locale of locales) assert.deepEqual(placeholders(packs[locale][key]), placeholders(key), `${locale}: ${key}`);
  }

  assert.equal(packs.en['Load {count} more items'], 'Load {count} more items');
  assert.equal(packs.ja['Load {count} more items'], 'さらに {count} 件を読み込む');
  assert.equal(packs['zh-CN']['Load {count} more items'], '再加载 {count} 项');
  assert.ok(keys.includes('No matching files'));
  assert.ok(keys.includes('Search files by name...'));
  assert.ok(keys.includes('Search files...'));
  for (const key of [
    'Recently opened', 'Suggested files', 'Search results', 'Search results: {count}',
    '{count} files available', 'Open a folder to search files.',
    'Start typing to search your workspace.', 'Clear search history',
    'Choose a file to start editing', 'Your workspace is ready in the Explorer',
    'Sync Workspace to Cloud', 'Run Code', 'Stop Running', 'Local Settings',
    'Project Environment', 'Change Theme', 'Toggle Split View', 'Close Tab',
    'Toggle AI Panel', 'Clear Output', 'Toggle Primary Sidebar',
    'Toggle Workbench Panel', 'Move Panel to Bottom or Right',
    'Toggle Focus Mode', 'Reset Workbench Layout'
  ]) assert.ok(keys.includes(key), `missing Quick Open translation key: ${key}`);
  for (const key of [
    'Source control: Added',
    'Source control: Modified',
    'Source control: Deleted',
    'Source control: Renamed',
    'Source control: Untracked',
    'Source control: Conflicted',
    'Source control: Ignored'
  ]) {
    assert.ok(keys.includes(key), `missing localized SCM decoration key: ${key}`);
    for (const locale of locales) assert.notEqual(packs[locale][key], '', `${locale}: ${key} must be translated`);
  }
  for (const key of [
    'The library plan contains an invalid dependency file change.',
    'The dependency file transaction is invalid.',
    'The dependency file transaction is no longer available.',
    'Package plan contains an invalid local file change',
    'Package transaction id is required'
  ]) {
    assert.ok(keys.includes(key), `missing package error translation key: ${key}`);
    assert.notEqual(packs['zh-CN'][key], key, `zh-CN package error is not translated: ${key}`);
    assert.notEqual(packs.ja[key], key, `ja package error is not translated: ${key}`);
  }
});

test('dynamic UI translation entry points reference defined English keys', () => {
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'language-packs', 'en', 'messages.json'), 'utf8'));
  const sourceFiles = [
    'ai-agent-button.js', 'ai-chat-panel.js', 'ai-markdown.js', 'ai-settings-center.js',
    'ai-prompts.js', 'collaboration.js', 'account-profile.js',
    'project-tasks.js', 'workspace-sync-status.js', 'task-problem-matcher.js', 'runner.js', 'run-config.js', 'runtime.js', 'dap-client.js', 'terminal.js', 'auth.js', 'plugin-manager-ui.js', 'plugin-details.js',
    'source-control-view.js', 'agent-workbench.js', 'command-palette.js', 'file-search.js', 'settings.js', 'workspace-launch.js', 'workspace.js', 'projects.js', 'cache-center.js', 'environment-center.js', 'package-center.js', 'rclone-settings.js'
  ];

  function assertLiteralCalls(source, fileName, pattern, keyGroup) {
    let match;
    while ((match = pattern.exec(source))) {
      const key = Function(`return ${match[keyGroup]}`)();
      assert.ok(Object.hasOwn(messages, key), `${fileName} references missing translation key: ${key}`);
    }
  }

  for (const fileName of sourceFiles) {
    const source = fs.readFileSync(path.join(ROOT, 'src', fileName), 'utf8');
    assertLiteralCalls(source, fileName, /\bt\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);
    assertLiteralCalls(source, fileName, /\b(?:tr|historyText|translate)\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);
    assertLiteralCalls(source, fileName, /\bbindText\(\s*[^,]+,\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);
    assertLiteralCalls(source, fileName, /\bbindAttribute\(\s*[^,]+,\s*[^,]+,\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);
    if (fileName !== 'collaboration.js') continue;
    assertLiteralCalls(source, fileName, /\b(?:notify|openAction)\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);
    assertLiteralCalls(source, fileName, /\b(?:inputField|textareaField|selectField)\(\s*[^,]+,\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);
  }

  for (const fileName of ['app.js', 'workbench-layout.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'src', fileName), 'utf8');
    for (const match of source.matchAll(/commands\.register\(\s*'[^']+'\s*,\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*'([^']+)'/g)) {
      assert.ok(Object.hasOwn(messages, match[1]), `${fileName} command label is not localized: ${match[1]}`);
      assert.ok(Object.hasOwn(messages, match[2]), `${fileName} command category is not localized: ${match[2]}`);
    }
  }

  const dapSource = fs.readFileSync(path.join(ROOT, 'src', 'dap-client.js'), 'utf8');
  function assertMapValues(scope, mapName) {
    const match = scope.match(new RegExp(`\\bvar\\s+${mapName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`));
    assert.ok(match, `dap-client.js is missing the ${mapName} translation map`);
    assertLiteralCalls(match[1], `dap-client.js ${mapName}`, /:\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);
  }

  assertMapValues(dapSource, 'statusKeys');
  assertMapValues(dapSource, 'stopReasonKeys');
  const warningScope = dapSource.slice(dapSource.indexOf('function warningText'), dapSource.indexOf('function adapterUnavailableReason'));
  assertMapValues(warningScope, 'keys');

  const compatFile = path.join(ROOT, 'renderer', 'compat', 'dap-adapter.js');
  const compatSource = fs.readFileSync(compatFile, 'utf8');
  assertLiteralCalls(compatSource, 'renderer/compat/dap-adapter.js', /\bt\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))/g, 1);

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  function fragmentBetween(startMarker, endMarker) {
    const start = html.indexOf(startMarker);
    const end = html.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `index.html is missing Debug fragment ${startMarker}`);
    return html.slice(start, end);
  }

  const debugTab = html.match(/<button\b[^>]*\bdata-panel="debug"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(debugTab, 'index.html is missing the Debug panel tab');
  const debugHtml = [
    fragmentBetween('<div class="debug-control-group">', '<button id="history-btn"'),
    fragmentBetween('<div id="debug-toolbar"', '<div id="container"'),
    debugTab[0],
    fragmentBetween('<div id="panel-debug"', '<div id="panel-team"')
  ].join('\n');
  const htmlKeys = new Set();
  for (const match of debugHtml.matchAll(/\b(?:title|aria-label|placeholder)="([^"]+)"/g)) htmlKeys.add(match[1]);
  for (const match of debugHtml.matchAll(/>\s*([^<>]+?)\s*</g)) {
    const key = match[1].replace(/\s+/g, ' ').trim();
    if (key && !/^(?:\+|&gt;)$/.test(key)) htmlKeys.add(key);
  }
  assert.ok(htmlKeys.has('Start Debugging (F5)'));
  assert.ok(htmlKeys.has('Continue (F5)'));
  assert.ok(htmlKeys.has('Call Stack'));
  assert.ok(htmlKeys.has('Evaluate expression'));
  for (const key of htmlKeys) assert.ok(Object.hasOwn(messages, key), `index.html references missing Debug translation key: ${key}`);
});
