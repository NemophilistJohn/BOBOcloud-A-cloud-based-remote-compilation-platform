'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'completion-history.js'), 'utf8');

function fixture(initialStorage) {
  const values = new Map(Object.entries(initialStorage || {}));
  const timers = new Map();
  let nextTimer = 1;
  let writes = 0;
  const sandbox = {
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); writes += 1; },
      removeItem(key) { values.delete(key); }
    },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'completion-history.js' });
  const history = sandbox.completionHistory;
  history.configureContext({ accountKey: 'server-a/user-1', workspaceKey: '/private/project-a' });
  return { history, values, timers, get writes() { return writes; } };
}

function model(language, value, name = 'source') {
  let text = value;
  let version = 1;
  return {
    uri: { toString() { return 'file:///private/project-a/' + name; } },
    getValue() { return text; },
    getLanguageId() { return language; },
    getVersionId() { return version; },
    getLineContent(line) { return text.split('\n')[line - 1] || ''; },
    getWordUntilPosition(position) {
      const prefix = this.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const word = /[\w$]*$/.exec(prefix)[0];
      return { word, startColumn: position.column - word.length, endColumn: position.column };
    },
    setValue(next) { text = next; version += 1; }
  };
}

function atEnd(target) {
  const lines = target.getValue().split('\n');
  return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
}

function rankedLabels(history, context, items) {
  return Array.from(history.rank(items || [{ label: 'all' }, { label: 'array' }], context), item => typeof item.label === 'string' ? item.label : item.label.label);
}

test('accepted choices normalize aliases, preserve label objects and rank before a limit', () => {
  const { history } = fixture();
  const target = model('python', 'import numpy as np\nnp.a');
  const context = history.contextFor(target, atEnd(target));
  assert.equal(context.receiver, 'numpy');
  let accept;
  history.install({ registerCommand(id, callback) { accept = callback; return { dispose() {} }; } });
  const command = history.command(context, { label: { label: 'array', detail: '(...)' } });
  accept(null, ...command.arguments);
  const large = Array.from({ length: 180 }, (_, index) => ({ label: 'a' + String(index).padStart(3, '0') }));
  large.push({ label: 'array' });
  assert.deepEqual(rankedLabels(history, context, large).slice(0, 1), ['array']);
  assert.equal(history.rank(large, context, 20).length, 20);
});

test('stable manual member calls teach preferences without counting repeated scans', () => {
  const { history, values } = fixture();
  const target = model('python', 'import numpy as np\n');
  history.observeModel(target, { reason: 'open' });
  target.setValue('import numpy as np\nnp.array([1])\nnp.a');
  history.observeModel(target, { reason: 'change', changes: [{ text: 'np.array([1])\nnp.a' }] });
  history.flush();
  const context = history.contextFor(target, atEnd(target));
  assert.deepEqual(rankedLabels(history, context), ['array', 'all']);
  const learned = history.score({ label: 'array' }, context);
  history.observeModel(target, { reason: 'save' });
  history.flush();
  assert.ok(Math.abs(history.score({ label: 'array' }, context) - learned) < 0.000001);
  const stored = values.get('bobocloud.completionHistory.v2');
  assert.ok(stored);
  assert.ok(!stored.includes('/private/project-a'));
  assert.ok(!stored.includes('np.array([1])'));
});

test('native analyzer command stays intact while its accepted insertion is recorded', () => {
  const { history } = fixture();
  const target = model('python', 'import numpy as np\nnp.a');
  history.observeModel(target, { reason: 'open' });
  const context = history.contextFor(target, atEnd(target));
  const original = { id: 'analyzer.commit', arguments: [{ keep: true }] };
  const item = { label: 'array', insertText: 'array', command: original };
  assert.equal(history.command(context, item), original);
  history.rememberSuggestions(context, [item]);
  target.setValue('import numpy as np\nnp.array');
  history.observeModel(target, { reason: 'change', changes: [{ text: 'array', range: context.range }] });
  assert.ok(history.score(item, context) > 10);
});

test('receiver and account boundaries prevent another library from borrowing a preference', () => {
  const { history } = fixture();
  const numpy = model('python', 'import numpy as np\nnp.a');
  const context = history.contextFor(numpy, atEnd(numpy));
  history.recordAccepted(context, 'array');
  assert.ok(history.score('array', context) > 0);
  const other = model('python', 'import other as np\nnp.a', 'other.py');
  const otherContext = history.contextFor(other, atEnd(other));
  assert.equal(history.score('array', otherContext), 0);
  history.configureContext({ accountKey: 'server-a/user-2', workspaceKey: '/private/project-a' });
  assert.equal(history.score('array', history.contextFor(numpy, atEnd(numpy))), 0);
});

test('import preferences keep scoped package paths distinct', () => {
  const { history } = fixture();
  const context = { language: 'typescript', kind: 'import', word: 'util' };
  history.recordAccepted(context, '@first/utilities');
  assert.ok(history.score('@first/utilities', context) > 0);
  assert.equal(history.score('@second/utilities', context), 0);
});

test('comments, strings, generated source and bulk pastes do not create preferences', () => {
  const { history } = fixture();
  const target = model('python', 'import numpy as np\n');
  history.observeModel(target, { reason: 'open' });
  target.setValue('import numpy as np\n# np.array([1])\ntext = "np.array([2])"\nnp.a');
  history.observeModel(target, { reason: 'change', changes: [{ text: 'comment' }] });
  history.flush();
  let context = history.contextFor(target, atEnd(target));
  assert.equal(history.score('array', context), 0);
  target.setValue('import numpy as np\n' + 'np.array([1])\n'.repeat(30) + 'np.a');
  history.observeModel(target, { reason: 'change', changes: [{ text: target.getValue() }] });
  history.flush();
  context = history.contextFor(target, atEnd(target));
  // Existing file usage may influence this document, while no durable signal
  // crosses into another document after a bulk insertion.
  const fresh = model('python', 'import numpy as np\nnp.a', 'fresh.py');
  assert.equal(history.score('array', history.contextFor(fresh, atEnd(fresh))), 0);
  const generated = model('python', '# @generated\nimport numpy as np\nnp.array([1])\nnp.a', 'generated.py');
  history.observeModel(generated, { reason: 'open' });
  generated.setValue(generated.getValue() + '\nnp.array([2])');
  history.observeModel(generated, { reason: 'save' });
  history.flush();
  assert.equal(history.score('array', history.contextFor(fresh, atEnd(fresh))), 0);
});

test('import aliases are normalized across JavaScript, Go, Rust, Java and C++', () => {
  const { history } = fixture();
  const cases = [
    ['typescript', "import * as tools from '@acme/tools';\ntools.a", '@acme/tools'],
    ['javascript', "const tools = require('tools');\ntools.a", 'tools'],
    ['go', 'import json "encoding/json"\njson.M', 'encoding/json'],
    ['rust', 'use std::collections as collections;\ncollections.H', 'std.collections'],
    ['java', 'import java.util.Arrays;\nArrays.a', 'java.util.Arrays'],
    ['cpp', 'namespace fs = std::filesystem;\nfs.e', 'std.filesystem']
  ];
  for (const [language, source, expected] of cases) {
    const target = model(language, source, language);
    assert.equal(history.contextFor(target, atEnd(target)).receiver, expected, language);
  }
});

test('future imports cannot change an earlier member context', () => {
  const { history } = fixture();
  const target = model('python', 'np.a\nimport numpy as np');
  assert.equal(history.contextFor(target, { lineNumber: 1, column: 5 }).receiver, 'np');
});

test('typing a member prefix reuses alias analysis and edits to earlier imports invalidate it', () => {
  const { history } = fixture();
  const target = model('python', 'import numpy as np\nnp.a');
  let sourceReads = 0;
  const read = target.getValue;
  target.getValue = () => { sourceReads += 1; return read(); };
  const first = history.contextFor(target, { lineNumber: 2, column: 5 });
  assert.equal(first.receiver, 'numpy');
  target.setValue('import numpy as np\nnp.ar');
  history.observeModel(target, { reason: 'change', changes: [{ text: 'r', range: { startLineNumber: 2 } }] });
  assert.equal(history.contextFor(target, { lineNumber: 2, column: 6 }).receiver, 'numpy');
  assert.equal(sourceReads, 0);
  target.setValue('import other as np\nnp.ar');
  history.observeModel(target, { reason: 'change', changes: [{ text: 'other', range: { startLineNumber: 1 } }] });
  assert.equal(history.contextFor(target, { lineNumber: 2, column: 6 }).receiver, 'other');
});

test('clearing preferences cancels pending observations that could repopulate storage', () => {
  const { history, values } = fixture();
  const target = model('python', 'import numpy as np\n');
  history.observeModel(target, { reason: 'open' });
  target.setValue('import numpy as np\nnp.array([1])\n');
  history.observeModel(target, { reason: 'change', changes: [{ text: 'np.array([1])\n' }] });
  history.clear();
  history.flush();
  assert.equal(values.has('bobocloud.completionHistory.v2'), false);
});

test('persistence is batched, migration is bounded and disabling learning preserves candidate commands', () => {
  const legacy = JSON.stringify([{ key: 'python|member|array', label: 'array', count: 3, updatedAt: Date.now() }]);
  const f = fixture({ 'bobocloud.completionHistory.v1': legacy });
  const context = { language: 'python', prefix: 'np.a' };
  f.history.recordAccepted(context, 'array');
  f.history.recordAccepted(context, 'array');
  assert.equal(f.writes, 0);
  f.history.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.values.has('bobocloud.completionHistory.v1'), false);
  f.history.setEnabled(false);
  const original = { id: 'native' };
  assert.equal(f.history.command(context, { label: 'array', command: original }), original);
  assert.equal(f.history.command(context, { label: 'array' }), undefined);
  f.history.clear();
  assert.equal(f.values.has('bobocloud.completionHistory.v2'), false);
  f.history.dispose();
});
