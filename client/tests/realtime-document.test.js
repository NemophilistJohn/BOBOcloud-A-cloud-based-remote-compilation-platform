'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');
const result = esbuild.buildSync({ entryPoints: ['src/realtime-document.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const moduleValue = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module: moduleValue, exports: moduleValue.exports, require });
const { SharedDocument } = moduleValue.exports;
function initial(text) {
  let after = '';
  return Array.from(text, (value, i) => {
    const id = '0000000000000000:base:' + String(i).padStart(8, '0');
    const node = { id, after, value }; after = id; return node;
  });
}
test('concurrent same-position inserts converge, late edits precede known successors, and retries are idempotent', () => {
  const a = new SharedDocument('alice', initial('ab')), b = new SharedDocument('bob', initial('ab'));
  const one = a.change([{ rangeOffset: 1, rangeLength: 0, text: '甲' }]);
  const two = b.change([{ rangeOffset: 1, rangeLength: 0, text: '乙' }]);
  a.apply(one); b.apply(two); a.apply(two); b.apply(one);
  assert.equal(a.text(), b.text());
  const late = a.change([{ rangeOffset: 1, rangeLength: 0, text: 'later' }]);
  a.apply(late); b.apply(late); b.apply(late);
  assert.equal(a.text(), b.text());
  assert.ok(a.text().startsWith('alater'));
});
test('personal undo preserves a remote insert and redo generates fresh unique nodes', () => {
  const a = new SharedDocument('alice', initial('abc')), b = new SharedDocument('bob', initial('abc'));
  const edit = a.change([{ rangeOffset: 1, rangeLength: 1, text: 'A' }]);
  const inverse = a.inverse(edit); a.apply(edit); b.apply(edit);
  const remote = b.change([{ rangeOffset: 2, rangeLength: 0, text: 'B' }]);
  a.apply(remote); b.apply(remote);
  const undo = a.reidentify(inverse), redo = a.inverse(undo);
  a.apply(undo); b.apply(undo);
  assert.equal(a.text(), b.text()); assert.ok(a.text().includes('B')); assert.ok(a.text().includes('b'));
  const replay = a.reidentify(redo); a.apply(replay); b.apply(replay);
  assert.equal(a.text(), b.text()); assert.ok(a.text().includes('B')); assert.ok(a.text().includes('A'));
});
test('Unicode offsets follow Monaco UTF16 while nodes and cursor anchors use whole characters', () => {
  const a = new SharedDocument('alice', initial('A😀中B'));
  assert.equal(a.anchor(3), a.visible()[1].id);
  const anchor = a.anchor(4);
  const edit = a.change([{ rangeOffset: 1, rangeLength: 2, text: '🦊' }]);
  a.apply(edit); assert.equal(a.text(), 'A🦊中B'); assert.equal(a.offset(anchor), 4);
  assert.throws(() => a.change([{ rangeOffset: 2, rangeLength: 1, text: '' }]), /Unicode/);
});
test('reconnection merges server tombstones into a locally retained document', () => {
  const a = new SharedDocument('alice', initial('abc')), b = new SharedDocument('bob', initial('abc'));
  b.apply(b.change([{ rangeOffset: 1, rangeLength: 1, text: '' }]));
  a.apply({ insert: b.snapshot(), delete: [] }); assert.equal(a.text(), 'ac');
});
