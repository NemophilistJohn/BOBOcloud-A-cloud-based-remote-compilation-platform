'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const SOURCE = path.join(__dirname, '..', 'renderer', 'terminal-input-policy.js');

function loadPolicy() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const transformed = esbuild.transformSync(source, {
    loader: 'js',
    format: 'cjs',
    target: 'node20'
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(transformed, { module, exports: module.exports }, { filename: SOURCE });
  return module.exports;
}

test('only pasted line breaks require direct-execution confirmation', () => {
  const policy = loadPolicy();
  assert.equal(policy.isMultilineTerminalPaste('echo one'), false);
  assert.equal(policy.isMultilineTerminalPaste(''), false);
  assert.equal(policy.isMultilineTerminalPaste('echo one\necho two'), true);
  assert.equal(policy.isMultilineTerminalPaste('echo one\recho two'), true);
  assert.equal(policy.isMultilineTerminalPaste('echo one\r\necho two'), true);
});

test('confirmed terminal paste preserves the exact clipboard payload', () => {
  const policy = loadPolicy();
  const paste = 'echo one\r\necho two\n';
  assert.equal(policy.terminalPasteText(paste), paste);
  assert.equal(policy.terminalPasteText(null), '');
});

test('pending terminal input is bounded using UTF-8 bytes rather than JavaScript characters', () => {
  const policy = loadPolicy();
  assert.equal(policy.MAX_PENDING_TERMINAL_INPUT_BYTES, 16 * 1024);
  assert.equal(policy.utf8ByteLength('abc'), 3);
  assert.equal(policy.utf8ByteLength('\u4e2d\u6587'), 6);
  assert.equal(policy.utf8ByteLength('\ud83d\ude80'), 4);
  assert.equal(policy.utf8ByteLength('\ud800'), 3);
});
