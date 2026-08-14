'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { parseFallbackFlags, writeFlagFile } = require('./clangd-flags');

test('accepts only server-issued native dependency flags', () => {
  const input = JSON.stringify([
    '--sysroot=/analysis-deps/native/sysroot',
    '-I/analysis-deps/native/include',
    '-I/analysis-deps/native/include'
  ]);
  assert.deepStrictEqual(parseFallbackFlags(input), [
    '--sysroot=/analysis-deps/native/sysroot',
    '-I/analysis-deps/native/include'
  ]);
  assert.throws(() => parseFallbackFlags('["-I/workspace/untrusted"]'), /not server-issued/);
  assert.throws(() => parseFallbackFlags('{"flag":"-I/tmp"}'), /must be an array/);
  assert.throws(() => parseFallbackFlags('not-json'), /invalid fallback flags JSON/);
});

test('bounds flag count and encoded size', () => {
  const allowed = '-I/analysis-deps/native/include';
  assert.throws(() => parseFallbackFlags(JSON.stringify(new Array(9).fill(allowed))), /at most 8/);
  assert.throws(() => parseFallbackFlags(JSON.stringify([`${allowed}${'x'.repeat(600)}`])), /size limit|not server-issued/);
});

test('writes a shell-readable argument file atomically', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-clangd-flags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'cache', 'fallback-flags');
  writeFlagFile(destination, ['--sysroot=/analysis-deps/native/sysroot', '-I/analysis-deps/native/include']);
  assert.strictEqual(fs.readFileSync(destination, 'utf8'), '--sysroot=/analysis-deps/native/sysroot\n-I/analysis-deps/native/include\n');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(destination)), ['fallback-flags']);
});
