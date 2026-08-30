'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('tracked hello plugin example contains every integrity-bound runtime file', () => {
  const root = path.resolve(__dirname, '..', 'examples', 'plugins', 'hello-plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = manifest.integrity && manifest.integrity.files;
  assert.equal(manifest.integrity && manifest.integrity.algorithm, 'sha256');
  assert.ok(files && typeof files === 'object' && !Array.isArray(files));
  assert.ok(Object.keys(files).length > 0);

  for (const [relativePath, expectedDigest] of Object.entries(files)) {
    const normalized = path.posix.normalize(relativePath);
    assert.equal(normalized, relativePath);
    assert.equal(path.posix.isAbsolute(relativePath), false);
    assert.equal(relativePath.split('/').includes('..'), false);
    const filePath = path.join(root, ...relativePath.split('/'));
    assert.equal(fs.statSync(filePath).isFile(), true, relativePath + ' must be a tracked regular file');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    assert.equal(digest, expectedDigest, relativePath + ' does not match the manifest integrity digest');
  }
});
