'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_GRANTS = 256;
const DEFAULT_MAX_GRANTS_PER_SENDER = 64;

function createLocalDirectoryAuthority(options) {
  const now = options.now || Date.now;
  const randomId = options.randomId || (() => crypto.randomUUID());
  const assertSafeLocalRoot = options.assertSafeLocalRoot || ((value) => path.resolve(value));
  const grantTtlMs = options.grantTtlMs || DEFAULT_GRANT_TTL_MS;
  const maxGrants = options.maxGrants || DEFAULT_MAX_GRANTS;
  const maxGrantsPerSender = options.maxGrantsPerSender || DEFAULT_MAX_GRANTS_PER_SENDER;
  const grants = new Map();

  function prune() {
    const current = now();
    for (const [id, grant] of grants) {
      if (grant.expiresAt <= current) grants.delete(id);
    }
  }

  function enforceCapacity(senderId) {
    let senderCount = 0;
    for (const grant of grants.values()) if (grant.senderId === senderId) senderCount += 1;
    for (const [id, grant] of grants) {
      if (grants.size < maxGrants && senderCount < maxGrantsPerSender) break;
      if (grant.senderId !== senderId && grants.size < maxGrants) continue;
      grants.delete(id);
      if (grant.senderId === senderId) senderCount -= 1;
    }
  }

  function inspectDirectory(candidate) {
    const safePath = assertSafeLocalRoot(candidate);
    const canonical = fs.realpathSync(safePath);
    const stat = fs.statSync(canonical);
    if (!stat.isDirectory()) throw new Error('Local mapping directory does not exist');
    return canonical;
  }

  function grant(senderId, candidate, purpose) {
    prune();
    const directory = inspectDirectory(candidate);
    enforceCapacity(senderId);
    const id = randomId();
    grants.set(id, {
      senderId,
      directory,
      purpose: String(purpose || 'mapping'),
      expiresAt: now() + grantTtlMs
    });
    return { grantId: id, path: directory };
  }

  function resolve(senderId, grantId, expectedPath) {
    prune();
    if (typeof grantId !== 'string' || !grantId) throw new Error('A local directory grant is required');
    const value = grants.get(grantId);
    if (!value || value.senderId !== senderId) throw new Error('The local directory grant is missing or expired');
    const directory = inspectDirectory(value.directory);
    if (expectedPath && path.resolve(expectedPath) !== path.resolve(directory)) {
      throw new Error('The local directory grant does not match this path');
    }
    value.expiresAt = now() + grantTtlMs;
    grants.delete(grantId);
    grants.set(grantId, value);
    return directory;
  }

  function revokeSender(senderId) {
    for (const [id, grant] of grants) {
      if (grant.senderId === senderId) grants.delete(id);
    }
  }

  return { grant, resolve, revokeSender, inspectDirectory };
}

module.exports = {
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_MAX_GRANTS,
  DEFAULT_MAX_GRANTS_PER_SENDER,
  createLocalDirectoryAuthority
};
