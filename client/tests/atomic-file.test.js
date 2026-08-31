'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFileBounded, readJsonFileSync, writeFileAtomic, writeFileAtomicSync, writeJsonAtomicSync } = require('../main/atomic-file');

test('atomic file replacement publishes complete private data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-atomic-file-'));
  try {
    const target = path.join(root, 'settings.json');
    writeFileAtomicSync(target, 'old', { encoding: 'utf8', maxBytes: 16 });
    writeJsonAtomicSync(target, { value: 'new' }, { maxBytes: 64 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { value: 'new' });
    assert.deepEqual(fs.readdirSync(root), ['settings.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atomic file replacement rejects oversized data without changing the target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-atomic-file-limit-'));
  try {
    const target = path.join(root, 'settings.json');
    writeFileAtomicSync(target, 'preserved', { encoding: 'utf8' });
    assert.throws(() => writeFileAtomicSync(target, 'too-large', { encoding: 'utf8', maxBytes: 3 }), { code: 'DATA_TOO_LARGE' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('async atomic replacement revalidates immediately before publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-atomic-file-async-'));
  try {
    const target = path.join(root, 'artifact.bin');
    fs.writeFileSync(target, 'old');
    await assert.rejects(writeFileAtomic(target, Buffer.from('new'), {
      beforeReplace: async () => { throw new Error('stale'); }
    }), /stale/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    await writeFileAtomic(target, Buffer.from('new'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded JSON reads reject oversized and symbolic data files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-bounded-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'data.json');
  fs.writeFileSync(target, '{"value":true}');
  assert.deepEqual(readJsonFileSync(target, { maxBytes: 64 }), { value: true });
  assert.throws(() => readJsonFileSync(target, { maxBytes: 2 }), { code: 'DATA_TOO_LARGE' });
  const originalOpen = fs.openSync;
  let growBeforeOpen = true;
  fs.openSync = function(candidate, ...args) {
    if (candidate === target && growBeforeOpen) {
      growBeforeOpen = false;
      fs.appendFileSync(target, 'x'.repeat(128));
    }
    return originalOpen.call(fs, candidate, ...args);
  };
  try {
    assert.throws(() => readJsonFileSync(target, { maxBytes: 64 }), { code: 'DATA_TOO_LARGE' });
  } finally {
    fs.openSync = originalOpen;
  }
  const link = path.join(root, 'linked.json');
  try {
    fs.symlinkSync(target, link);
    assert.throws(() => readJsonFileSync(link, { maxBytes: 64 }), { code: 'UNSAFE_DATA_FILE' });
  } catch (error) {
    if (error && error.code !== 'EPERM') throw error;
  }
});

test('asynchronous bounded reads enforce the opened file limit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-bounded-async-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'data.txt');
  fs.writeFileSync(target, 'bounded');
  assert.equal(await readFileBounded(target, { maxBytes: 64, encoding: 'utf8' }), 'bounded');
  await assert.rejects(readFileBounded(target, { maxBytes: 2 }), { code: 'DATA_TOO_LARGE' });
});
