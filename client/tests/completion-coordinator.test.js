'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const esbuild = require('esbuild');
const path = require('node:path');
const vm = require('node:vm');
const compiled = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/completion-coordinator.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text;
const moduleScope = { exports: {} };
vm.runInNewContext(compiled, { module: moduleScope, exports: moduleScope.exports, Map, Set, Date, Promise });
const { createCompletionCoordinator, completionImportContext, mergeCompletionCandidates } = moduleScope.exports;
const { sanitizeDependencyIndex } = require('../client-analysis-cache');

function model(source, language = 'python') {
  return {
    getValue: () => source, getLanguageId: () => language, getVersionId: () => 1,
    getLineContent: line => source.split('\n')[line - 1] || '',
    getWordUntilPosition(position) {
      const text = this.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const word = /[\w$]*$/.exec(text)[0];
      return { word, startColumn: position.column - word.length, endColumn: position.column };
    }
  };
}
function fixture(strategy = 'on-demand') {
  let clock = 0; let serial = 0;
  const timers = new Map(); const calls = []; const writes = []; const changes = [];
  const context = { identity: 'a', language: 'python', revision: 'deps1', runtimeId: 'python:3.12', strategy, capacityMiB: 1, persistent: true };
  const service = createCompletionCoordinator({
    now: () => clock,
    setTimer(callback, delay) { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id)
  });
  const ports = {
    async query(query) {
      calls.push(query);
      return { schema: 'dependency-api-index-v1', languageId: 'python', runtimeId: context.runtimeId, revision: context.revision,
        roots: query.queryKind === 'catalog' ? ['numpy'] : [],
        entries: query.queryKind === 'catalog' ? [] : [{ module: 'numpy', kind: 'package', symbols: [{ name: 'array', kind: 'function' }] }], complete: true };
    },
    hydrate: async () => null,
    async persist(key, value) { writes.push({ key, value }); },
    changed: value => changes.push(value), isBusy: () => false
  };
  async function advance(ms = 0) {
    clock += ms;
    for (let count = 0; count < 20; count++) {
      const ready = [...timers].filter(([, value]) => value.at <= clock);
      for (const [id, value] of ready) { timers.delete(id); value.callback(); }
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      if (!ready.length && ![...timers.values()].some(value => value.at <= clock)) break;
    }
  }
  return { service, context, ports, calls, writes, changes, advance };
}

test('durable summaries with omitted empty arrays remain usable after the real cache sanitizer', async () => {
  const f = fixture();
  const policy = { mode: 'lazy', sizeMiB: 32, dependencyIndexEnabled: true };
  const record = sanitizeDependencyIndex({ schema: 'dependency-api-index-v1', roots: [
    { name: 'statistics', kind: 'module', members: [{ name: 'mean', kind: 'function' }], modules: [] },
    { name: 'statistics.empty', kind: 'module', members: [], modules: [] }
  ] }, policy);
  assert.equal(record.roots[0].modules, undefined);
  assert.equal(record.roots[1].members, undefined);
  f.ports.hydrate = async key => key === 'catalog' ? null : record;
  f.service.configure(f.context, f.ports); await f.advance();
  const source = model('import statistics as stats\nstats.m');
  const position = { lineNumber: 2, column: 8 };
  f.service.suggestions(source, position); await f.advance();
  assert.deepEqual(Array.from(f.service.suggestions(source, position).items, item => item.label), ['mean']);
  const empty = model('import statistics.empty as empty\nempty.');
  const emptyPosition = { lineNumber: 2, column: 7 };
  f.service.suggestions(empty, emptyPosition); await f.advance();
  assert.deepEqual(Array.from(f.service.suggestions(empty, emptyPosition).items), []);
  f.service.dispose();
});

test('catalog discovery precedes module parsing and missing imports are never invented', async () => {
  const f = fixture(); f.service.configure(f.context, f.ports); await f.advance();
  const code = model('import n');
  assert.deepEqual(Array.from(f.service.suggestions(code, { lineNumber: 1, column: 9 }).items, item => item.label), ['numpy']);
  assert.equal(f.calls.length, 1);
  const missing = model('import imaginary');
  assert.equal(f.service.suggestions(missing, { lineNumber: 1, column: 17 }).items.length, 0);
  const member = model('import numpy as np\nnp.a');
  assert.equal(f.service.suggestions(member, { lineNumber: 2, column: 5 }), null);
  await f.advance();
  assert.equal(f.calls[1].module, 'numpy');
  assert.equal(f.service.suggestions(member, { lineNumber: 2, column: 5 }).items[0].label, 'array');
  f.service.dispose();
});

test('durable catalog hydration avoids remote work and late reads cannot cross sessions', async () => {
  const f = fixture(); let release;
  f.ports.hydrate = () => new Promise(resolve => { release = resolve; });
  f.service.configure(f.context, f.ports); await f.advance();
  f.service.configure(null);
  release({ schema: 'dependency-api-index-v1', roots: [{ name: 'stale', kind: 'module', members: [], modules: [] }] });
  await f.advance();
  assert.equal(f.calls.length, 0);
  f.ports.hydrate = async () => ({ schema: 'dependency-api-index-v1', roots: [{ name: 'numpy', kind: 'module', members: [], modules: [] }] });
  f.service.configure({ ...f.context, identity: 'b' }, f.ports); await f.advance();
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.suggestions(model('import n'), { lineNumber: 1, column: 9 }).items[0].label, 'numpy');
  f.service.dispose();
});

test('project warmup yields to activity and busy work then resumes progressive module pages', async () => {
  const f = fixture('project'); let busy = true;
  f.ports.isBusy = () => busy;
  f.service.configure(f.context, f.ports); await f.advance();
  f.service.activity(model('import numpy as np'));
  await f.advance(1000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.progress().state, 'paused');
  busy = false; await f.advance(1000);
  assert.equal(f.calls[1].queryKind, 'module');
  await f.advance(20);
  assert.equal(f.calls.at(-1).queryKind, 'project');
  assert.equal(f.service.progress().state, 'complete');
  assert.ok(f.writes.some(value => value.key === 'module:numpy'));
  f.service.dispose();
});

test('source merge preserves incomplete state and ranks before the display limit', () => {
  const list = mergeCompletionCandidates([
    { items: Array.from({ length: 150 }, (_, index) => ({ label: 'item' + index, sortText: '9' + index })), isIncomplete: true },
    { items: [{ label: 'preferred', sortText: '000' }] }
  ], 10);
  assert.equal(list.items[0].label, 'preferred');
  assert.equal(list.isIncomplete, true);
});

test('import adapters resolve actual module aliases across Python, Node, Go and Rust', () => {
  const cases = [
    ['python', 'import numpy as np\nnp.a', 'numpy'],
    ['typescript', "import * as fs from 'node:fs'\nfs.re", 'node:fs'],
    ['go', 'import "net/http"\nhttp.Ne', 'net/http'],
    ['go', 'import (\n "net/http"\n)\nhttp.Ne', 'net/http'],
    ['rust', 'use serde as ser;\nser::Se', 'serde'],
    ['rust', 'use std::collections::HashMap;\nHashMap::ne', 'std::collections::HashMap'],
    ['rust', 'use std::collections::{HashMap as Map, HashSet};\nMap::ne', 'std::collections::HashMap'],
    ['java', 'import java.util.Arrays;\nArrays.a', 'java.util.Arrays'],
    ['python', 'from numpy import linalg as la\nla.no', 'numpy.linalg'],
    ['python', 'import os, numpy as np\nnp.a', 'numpy']
  ];
  for (const [language, source, expected] of cases) {
    const lines = source.split('\n');
    assert.equal(completionImportContext(model(source, language), { lineNumber: lines.length, column: lines.at(-1).length + 1 }).module, expected);
  }
});

test('source adapters ignore strings, comments, unresolved instances and rebound import names', () => {
  const cases = [
    ['python', 'import numpy as np\n# np.a'],
    ['python', 'import numpy as np\n"np.a'],
    ['python', '"""\nimport numpy as np\nnp.a'],
    ['python', 'import numpy as np\nnp = thing()\nnp.a'],
    ['python', 'something.a'],
    ['typescript', "/*\nimport * as fs from 'node:fs'\nfs.re"],
    ['typescript', "import * as fs from 'node:fs'\n// fs.re"],
    ['typescript', 'const fs = require("fs"); // import "nu'],
    ['go', 'const text = "net/http"\nhttp.Ne']
  ];
  for (const [language, source] of cases) {
    const lines = source.split('\n');
    assert.equal(completionImportContext(model(source, language), { lineNumber: lines.length, column: lines.at(-1).length + 1 }), null, source);
  }
});

function page(f, query, entries, extra = {}) {
  return { schema: 'dependency-api-index-v1', languageId: 'python', runtimeId: f.context.runtimeId, revision: f.context.revision,
    queryKind: query.queryKind, module: query.module, roots: query.queryKind === 'catalog' ? ['numpy'] : [], entries, complete: true, ...extra };
}

test('partial module pages remain visible, union symbols and retry the failed cursor without persisting partial data', async () => {
  const f = fixture(); let requests = 0; let release;
  f.ports.query = async query => {
    f.calls.push(query);
    if (query.queryKind === 'catalog') return page(f, query, []);
    requests++;
    if (requests === 1) return page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'all', kind: 'function' }] }], { nextCursor: 'second', complete: false });
    if (requests === 2) return new Promise(resolve => { release = () => resolve(Promise.reject(new Error('temporary'))); });
    return page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'array', kind: 'function' }] }]);
  };
  f.service.configure(f.context, f.ports); await f.advance();
  const source = model('import numpy as np\nnp.a'); const position = { lineNumber: 2, column: 5 };
  f.service.suggestions(source, position); await f.advance(); await f.advance();
  assert.deepEqual(Array.from(f.service.suggestions(source, position).items, item => item.label), ['all']);
  assert.equal(f.service.suggestions(source, position).isIncomplete, true);
  assert.equal(f.writes.some(write => write.key === 'module:numpy'), false);
  release(); await f.advance();
  f.service.suggestions(source, position); await f.advance(); assert.equal(requests, 2);
  await f.advance(5000); f.service.suggestions(source, position); await f.advance();
  assert.equal(f.calls.at(-1).cursor, 'second');
  assert.deepEqual(Array.from(f.service.suggestions(source, position).items, item => item.label).sort(), ['all', 'array']);
  assert.equal(f.service.suggestions(source, position).isIncomplete, false);
  assert.equal(f.writes.filter(write => write.key === 'module:numpy').length, 1);
  f.service.dispose();
});

test('failed catalog discovery retries after backoff in on-demand mode', async () => {
  const f = fixture();
  f.ports.query = async query => { f.calls.push(query); if (f.calls.length === 1) throw new Error('runtime_discovery_busy'); return page(f, query, []); };
  f.service.configure(f.context, f.ports); await f.advance();
  assert.equal(f.calls.length, 1); await f.advance(4999); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  assert.equal(f.service.suggestions(model('import n'), { lineNumber: 1, column: 9 }).items[0].label, 'numpy');
  f.service.dispose();
});

test('catalog retry respects the server rate-limit delay', async () => {
  const f = fixture();
  f.ports.query = async query => {
    f.calls.push(query);
    if (f.calls.length === 1) throw Object.assign(new Error('rate_limited'), { retryAfterMs: 12000 });
    return page(f, query, []);
  };
  f.service.configure(f.context, f.ports); await f.advance();
  await f.advance(11999); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  f.service.dispose();
});

test('foreign module responses and repeated pagination cursors cannot poison or spin the index', async () => {
  for (const scenario of ['foreign', 'loop']) {
    const f = fixture();
    f.ports.query = async query => {
      f.calls.push(query);
      if (query.queryKind === 'catalog') return page(f, query, []);
      return page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'array', kind: 'function' }] }],
        scenario === 'foreign' ? { module: 'other' } : { nextCursor: 'same', complete: false });
    };
    f.service.configure(f.context, f.ports); await f.advance();
    const source = model('import numpy as np\nnp.a'); f.service.suggestions(source, { lineNumber: 2, column: 5 }); await f.advance(); await f.advance();
    assert.equal(f.service.progress().state, 'error');
    assert.equal(f.calls.length, scenario === 'foreign' ? 2 : 3);
    assert.equal(f.writes.some(write => write.key === 'module:numpy'), false);
    f.service.dispose();
  }
});

test('project child placeholders stay queryable and background pages yield to foreground requests and user activity', async () => {
  const f = fixture('project'); let release;
  f.ports.query = async query => {
    f.calls.push(query);
    if (query.queryKind === 'catalog') return page(f, query, []);
    if (query.queryKind === 'project' && !query.cursor) return new Promise(resolve => { release = () => resolve(page(f, query,
      [{ module: 'numpy', kind: 'module', symbols: [] }, { module: 'numpy.linalg', kind: 'module' }], { module: 'numpy', nextCursor: 'next', complete: false })); });
    if (query.queryKind === 'project') return page(f, query, [{ module: 'numpy.linalg', kind: 'module', symbols: [{ name: 'norm', kind: 'function' }] }], { module: 'numpy.linalg' });
    return page(f, query, [{ module: query.module, kind: 'module', symbols: [{ name: 'norm', kind: 'function' }] }]);
  };
  f.service.configure(f.context, f.ports); await f.advance(); await f.advance(1000);
  assert.equal(f.calls.at(-1).queryKind, 'project');
  const source = model('import numpy.linalg as la\nla.no');
  f.service.suggestions(source, { lineNumber: 2, column: 6 }); f.service.activity(source);
  release(); await f.advance();
  assert.equal(f.calls.at(-1).queryKind, 'module'); assert.equal(f.calls.at(-1).module, 'numpy.linalg');
  await f.advance(10); assert.equal(f.calls.filter(call => call.queryKind === 'project').length, 1);
  await f.advance(1000); assert.equal(f.calls.at(-1).queryKind, 'project');
  f.service.dispose();
});

test('session replacement waits for old request settlement and does not warm the previous workspace model', async () => {
  const f = fixture('smart'); let release;
  f.ports.query = query => { f.calls.push(query); if (f.calls.length === 1) return new Promise(resolve => { release = () => resolve(page(f, query, [])); }); return Promise.resolve(page(f, query, [])); };
  f.service.configure(f.context, f.ports); await f.advance(); f.service.activity(model('import numpy as np'));
  f.service.configure({ ...f.context, identity: 'b' }, f.ports); await f.advance(1000);
  assert.equal(f.calls.length, 1);
  release(); await f.advance(); assert.equal(f.calls.length, 2);
  await f.advance(1000); assert.equal(f.calls.length, 2);
  assert.equal(f.service.progress().state, 'ready');
  f.service.configure(null); assert.equal(f.service.progress().state, 'disabled');
  f.service.dispose();
});

test('file switches and a paused transport retain verified in-memory modules without new requests', async () => {
  const f = fixture(); f.context.persistent = false;
  f.service.configure(f.context, f.ports); await f.advance();
  const first = model('import numpy as np\nnp.a'); const position = { lineNumber: 2, column: 5 };
  f.service.suggestions(first, position); await f.advance();
  assert.equal(f.service.suggestions(first, position).items[0].label, 'array');
  const requests = f.calls.length;
  f.service.pause();
  assert.equal(f.service.progress().state, 'paused');
  const second = model('import numpy as np\nnp.a');
  assert.equal(f.service.suggestions(second, position).items[0].label, 'array');
  f.service.suggestions(model('import other as x\nx.a'), { lineNumber: 2, column: 4 });
  f.service.activity(second); await f.advance(2000); assert.equal(f.calls.length, requests);
  f.service.configure(f.context, f.ports); await f.advance();
  assert.equal(f.service.suggestions(second, position).items[0].label, 'array');
  assert.equal(f.calls.length, requests);
  f.service.dispose();
});

test('API summaries keep language-protocol symbol kinds instead of marking every public value as a function', async () => {
  const f = fixture();
  const kinds = { function: 3, method: 2, class: 7, property: 10, field: 5, value: 6, variable: 6, constant: 21, alias: 18, type: 25 };
  f.ports.query = async query => page(f, query, query.queryKind === 'catalog' ? [] : [{ module: 'numpy', kind: 'module',
    symbols: Object.keys(kinds).map(kind => ({ name: kind, kind })) }]);
  f.service.configure(f.context, f.ports); await f.advance();
  const source = model('import numpy as np\nnp.'); const position = { lineNumber: 2, column: 4 };
  f.service.suggestions(source, position); await f.advance();
  for (const item of f.service.suggestions(source, position).items) assert.equal(item.kind, kinds[item.label], item.label);
  f.service.dispose();
});

test('pause invalidates a late page, preserves partial candidates and resumes the same session cursor', async () => {
  const f = fixture(); let release; let moduleQueries = 0;
  f.ports.query = async query => {
    f.calls.push(query);
    if (query.queryKind === 'catalog') return page(f, query, []);
    moduleQueries++;
    if (moduleQueries === 1) return page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'all', kind: 'function' }] }], { nextCursor: 'second', complete: false });
    if (moduleQueries === 2) return new Promise(resolve => { release = () => resolve(page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'abandoned', kind: 'function' }] }])); });
    return page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'array', kind: 'function' }] }]);
  };
  f.service.configure(f.context, f.ports); await f.advance();
  const source = model('import numpy as np\nnp.a'); const position = { lineNumber: 2, column: 5 };
  f.service.suggestions(source, position); await f.advance(); await f.advance();
  f.service.pause(); release(); await f.advance();
  assert.deepEqual(Array.from(f.service.suggestions(source, position).items, item => item.label), ['all']);
  await f.advance(2000); assert.equal(moduleQueries, 2);
  f.service.configure(f.context, f.ports); f.service.suggestions(source, position); await f.advance();
  assert.equal(f.calls.at(-1).cursor, 'second');
  assert.deepEqual(Array.from(f.service.suggestions(source, position).items, item => item.label).sort(), ['all', 'array']);
  f.service.dispose();
});

test('reconnection reuses complete modules while restarting only unfinished session-bound cursors', async () => {
  const f = fixture(); f.context.transportIdentity = 'socket-one'; let moduleQueries = 0;
  f.ports.query = async query => {
    f.calls.push(query);
    if (query.queryKind === 'catalog') return page(f, query, []);
    moduleQueries++;
    if (moduleQueries === 1) return page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'all', kind: 'function' }] }], { nextCursor: 'socket-one:next', complete: false });
    throw new Error('disconnected');
  };
  f.service.configure(f.context, f.ports); await f.advance();
  const source = model('import numpy as np\nnp.a'); const position = { lineNumber: 2, column: 5 };
  f.service.suggestions(source, position); await f.advance(); await f.advance();
  f.service.pause();
  f.ports.query = async query => { f.calls.push(query); return page(f, query, [{ module: 'numpy', kind: 'module', symbols: [{ name: 'array', kind: 'function' }] }]); };
  f.service.configure({ ...f.context, transportIdentity: 'socket-two' }, f.ports);
  f.service.suggestions(source, position); await f.advance();
  assert.equal(f.calls.at(-1).cursor, undefined);
  assert.deepEqual(Array.from(f.service.suggestions(source, position).items, item => item.label).sort(), ['all', 'array']);
  const calls = f.calls.length;
  f.service.pause(); f.service.configure({ ...f.context, transportIdentity: 'socket-three' }, f.ports); await f.advance();
  assert.equal(f.calls.length, calls);
  assert.equal(f.service.suggestions(source, position).items.length, 2);
  f.service.configure({ ...f.context, revision: 'changed', transportIdentity: 'socket-four' }, f.ports);
  assert.equal(f.service.suggestions(source, position), null);
  f.service.dispose();
});
