'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalDirectoryAuthority } = require('../main/local-directory-authority');

test('local directory grants are bounded per sender and revoked with their renderer', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-local-grants-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  let sequence = 0;
  const authority = createLocalDirectoryAuthority({
    randomId: () => 'grant-' + (++sequence),
    maxGrants: 2,
    maxGrantsPerSender: 1
  });
  const old = authority.grant(1, first, 'test');
  const current = authority.grant(1, second, 'test');
  assert.throws(() => authority.resolve(1, old.grantId), /missing or expired/);
  assert.equal(authority.resolve(1, current.grantId), fs.realpathSync(second));
  authority.revokeSender(1);
  assert.throws(() => authority.resolve(1, current.grantId), /missing or expired/);
});

test('local directory grants are sender-bound, expire, and survive rejected grant attempts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-local-grant-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'mapping');
  fs.mkdirSync(directory);
  let currentTime = 100;
  let sequence = 0;
  const authority = createLocalDirectoryAuthority({
    now: () => currentTime,
    randomId: () => 'grant-' + (++sequence),
    grantTtlMs: 10,
    maxGrants: 1,
    maxGrantsPerSender: 1
  });
  const grant = authority.grant(1, directory, 'test');
  assert.throws(() => authority.resolve(2, grant.grantId), /missing or expired/);
  assert.throws(() => authority.grant(1, path.join(root, 'missing'), 'test'));
  assert.equal(authority.resolve(1, grant.grantId), fs.realpathSync(directory),
    'an invalid replacement must not evict an existing grant');
  currentTime += 11;
  assert.throws(() => authority.resolve(1, grant.grantId), /missing or expired/);
});
