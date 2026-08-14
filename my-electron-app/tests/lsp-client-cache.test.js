'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCompletionHintCache,
  createDependencyApiIndexCache,
  normalizeCacheableCompletionResult,
  dependencyCanBackLocalCache,
  dependencyApiIndexInsertPage,
  dependencyApiIndexResult,
  dependencyApiIndexCompletions,
  mergeLocalCompletionResults
} = require('../src/lsp-client');
const { sanitizeDependencyIndex } = require('../client-analysis-cache');

function modelForWord(startColumn, endColumn) {
  return {
    getWordUntilPosition() {
      return { startColumn, endColumn };
    }
  };
}

test('normalizes only a simple LSP text edit that exactly matches the current word', () => {
  const model = modelForWord(8, 10);
  const position = { lineNumber: 3, column: 10 };
  const normalized = normalizeCacheableCompletionResult({
    items: [{
      label: 'stdio',
      kind: 9,
      textEdit: {
        range: {
          start: { line: 2, character: 7 },
          end: { line: 2, character: 9 }
        },
        newText: 'stdio'
      }
    }]
  }, model, position);

  assert.deepEqual(normalized, {
    items: [{ label: 'stdio', kind: 9, insertText: 'stdio' }]
  });
  const hints = createCompletionHintCache();
  assert.equal(hints.prime('c-scope', 'stdio-key', normalized, 'live'), true);
  assert.equal(hints.peek('c-scope', 'stdio-key').items[0].insertText, 'stdio');
});

test('rejects LSP completion edits that cannot be replayed at the current word range', () => {
  const model = modelForWord(8, 10);
  const position = { lineNumber: 3, column: 10 };
  const unsafe = normalizeCacheableCompletionResult({
    items: [{
      label: 'unsafe',
      textEdit: {
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 9 }
        },
        newText: 'unsafe'
      }
    }, {
      label: 'multiline',
      textEdit: {
        range: {
          start: { line: 2, character: 7 },
          end: { line: 2, character: 9 }
        },
        newText: 'line one\nline two'
      }
    }, {
      label: 'side-effect',
      insertText: 'sideEffect',
      command: { command: 'not-cacheable' }
    }]
  }, model, position);

  assert.equal(unsafe, null);
});

test('renderer hint cache remains bounded after a configured capacity change', () => {
  const hints = createCompletionHintCache();
  hints.configure({ mode: 'lazy', sizeMiB: 1 });
  for (let index = 0; index < 400; index += 1) {
    hints.prime('scope', 'key-' + index, {
      items: [{ label: 'candidate-' + index, insertText: 'candidate-' + index }]
    }, 'live');
  }
  assert.ok(hints.size() <= 128);
  hints.configure({ mode: 'off', sizeMiB: 32 });
  assert.equal(hints.size(), 0);
});

test('a stable empty dependency view can cache clangd hints, while mixed Python views cannot', () => {
  assert.equal(dependencyCanBackLocalCache({ status: 'empty', revision: 'clangd-toolchain' }), true);
  assert.equal(dependencyCanBackLocalCache({ status: 'ready', revision: 'python-runtime' }), true);
  assert.equal(dependencyCanBackLocalCache({ status: 'mixed', revision: 'legacy-pip' }), false);
  assert.equal(dependencyCanBackLocalCache({ status: 'empty' }), false);
});

test('dependency API summaries provide import and member completions without an LSP round trip', () => {
  const build = {
    roots: Object.create(null),
    modules: Object.create(null),
    rootCount: 0,
    moduleCount: 0,
    memberCount: 0
  };
  assert.equal(dependencyApiIndexInsertPage(build, {
    schema: 'dependency-api-index-v1',
    roots: ['numpy'],
    entries: [{
      module: 'numpy',
      kind: 'package',
      symbols: [
        { name: 'array', kind: 'function' },
        { name: 'ndarray', kind: 'class' },
        { name: '_private', kind: 'function' }
      ]
    }]
  }), true);
  const index = dependencyApiIndexResult(build);
  assert.deepEqual(
    dependencyApiIndexCompletions(index, { prefix: 'import nu' }).items.map((item) => item.label),
    ['numpy']
  );
  assert.deepEqual(
    dependencyApiIndexCompletions(index, { prefix: 'numpy.' }).items.map((item) => item.label),
    ['array', 'ndarray']
  );

  const cache = createDependencyApiIndexCache();
  cache.configure({ enabled: true, sizeMiB: 30 });
  assert.equal(cache.prime('scope', 'numpy', index), true);
  assert.deepEqual(cache.peek('scope', 'numpy'), index);
});

test('a fresh remote completion does not hide a matching dependency API summary', () => {
  const publicApi = {
    items: [{ label: 'array', kind: 3, insertText: 'array' }]
  };
  const merged = mergeLocalCompletionResults({
    items: [
      { label: 'zeros', kind: 3, insertText: 'zeros' },
      { label: 'array', kind: 3, insertText: 'array' }
    ]
  }, publicApi);
  assert.deepEqual(merged.items.map((item) => item.label), ['zeros', 'array']);
});

test('dependency API candidates survive a full remote completion list', () => {
  const remote = {
    items: Array.from({ length: 100 }, (_, index) => ({
      label: 'remote_' + index,
      insertText: 'remote_' + index,
      kind: 6
    }))
  };
  const publicApi = {
    items: [
      { label: 'numpy', insertText: 'numpy', kind: 9 },
      { label: 'array', insertText: 'array', kind: 3 }
    ]
  };
  const merged = mergeLocalCompletionResults(remote, publicApi);
  assert.equal(merged.items.length, 100);
  assert.equal(merged.items.some((item) => item.label === 'numpy'), true);
  assert.equal(merged.items.some((item) => item.label === 'array'), true);
});

test('dependency API hydration pending work is keyed, coalesced, and released on invalidation', async () => {
  const cache = createDependencyApiIndexCache();
  cache.configure({ enabled: true, sizeMiB: 30 });
  let resolve;
  let calls = 0;
  const loader = () => {
    calls += 1;
    return new Promise((done) => { resolve = done; });
  };
  const first = cache.begin('scope-a', 'numpy', loader);
  const second = cache.begin('scope-a', 'numpy', loader);
  assert.strictEqual(first, second);
  assert.equal(calls, 0, 'loader begins after the pending entry is registered');
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(cache.hasPending('scope-a', 'numpy'), true);

  const beforeInvalidation = cache.epoch();
  cache.cancelPending();
  assert.equal(cache.hasPending('scope-a', 'numpy'), false);
  assert.equal(cache.epoch(), beforeInvalidation + 1);
  const replacement = cache.begin('scope-a', 'numpy', () => Promise.resolve('new scope'));
  assert.notStrictEqual(replacement, first);
  resolve('old scope');
  await Promise.all([first, replacement]);
  assert.equal(cache.hasPending('scope-a', 'numpy'), false);

  let resolveInvalidated;
  const invalidated = cache.begin('scope-b', 'numpy', () => new Promise((done) => { resolveInvalidated = done; }));
  await Promise.resolve();
  assert.equal(cache.hasPending('scope-b', 'numpy'), true);
  cache.clear();
  assert.equal(cache.hasPending('scope-b', 'numpy'), false);
  resolveInvalidated('cleared');
  await invalidated;
});

test('dependency API alias completions use only prior top-level imports from the current model version', () => {
  const index = {
    schema: 'dependency-api-index-v1',
    roots: [{ name: 'numpy', kind: 'module', members: [{ name: 'array', kind: 'function' }] }]
  };
  const lines = ['import numpy as np', '', 'np.'];
  const model = {
    getVersionId: () => 7,
    getLineCount: () => lines.length,
    getLineContent: (lineNumber) => lines[lineNumber - 1]
  };
  const snapshot = { model, version: 7, lineNumber: 3, prefix: 'np.' };
  assert.deepEqual(dependencyApiIndexCompletions(index, snapshot).items.map((item) => item.label), ['array']);
  assert.equal(dependencyApiIndexCompletions(index, Object.assign({}, snapshot, { version: 8 })), null);

  const scopedLines = ['    import numpy as np', '', 'np.'];
  const scopedModel = Object.assign({}, model, {
    getLineContent: (lineNumber) => scopedLines[lineNumber - 1]
  });
  assert.equal(dependencyApiIndexCompletions(index, Object.assign({}, snapshot, { model: scopedModel })), null);

  const futureLines = ['np.', 'import numpy as np'];
  const futureModel = Object.assign({}, model, {
    getLineCount: () => futureLines.length,
    getLineContent: (lineNumber) => futureLines[lineNumber - 1]
  });
  assert.equal(dependencyApiIndexCompletions(index, Object.assign({}, snapshot, { model: futureModel, lineNumber: 1 })), null);
});

test('truncated dependency pages remain memory-only and preserve the durable schema', () => {
  const build = {
    roots: Object.create(null),
    modules: Object.create(null),
    rootCount: 0,
    moduleCount: 0,
    memberCount: 0,
    truncated: false,
    preferredRootPrefixes: ['nu']
  };
  for (let index = 0; index < 64; index += 1) {
    assert.equal(dependencyApiIndexInsertPage(build, {
      schema: 'dependency-api-index-v1',
      roots: ['package' + index],
      entries: []
    }), true);
  }
  assert.equal(dependencyApiIndexInsertPage(build, {
    schema: 'dependency-api-index-v1',
    roots: ['numpy'],
    entries: [{ module: 'numpy', symbols: [{ name: 'array', kind: 'function' }] }],
    truncated: true
  }), true);
  assert.equal(build.truncated, true);
  const summary = dependencyApiIndexResult(build);
  assert.equal(summary.truncated, undefined);
  assert.equal(summary.roots.some((root) => root.name === 'numpy'), true);
  assert.deepEqual(sanitizeDependencyIndex(summary, {
    mode: 'active', sizeMiB: 30, dependencyIndexEnabled: true
  }), summary);
});
