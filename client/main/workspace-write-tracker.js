'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_TTL_MS = 15000;

function normalizedPathKey(filePath, platform) {
  const resolved = path.resolve(String(filePath || ''));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fileFingerprint(fileSystem, filePath) {
  try {
    const stat = fileSystem.statSync(filePath, { bigint: true });
    if (!stat.isFile()) return null;
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs]
      .map((value) => String(value))
      .join(':');
  } catch (_) {
    return null;
  }
}

function contentDigest(content, encoding) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), encoding || 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function trackerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createWorkspaceWriteTracker(options = {}) {
  const fileSystem = options.fs || fs;
  const platform = options.platform || process.platform;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : DEFAULT_TTL_MS;
  const namespace = options.namespace || crypto.randomBytes(8).toString('hex');
  const records = new Map();
  let sequence = 0;

  function pathKey(filePath) {
    return normalizedPathKey(filePath, platform);
  }

  function removeExpired(timestamp) {
    records.forEach((record, key) => {
      if (!record.pending && timestamp - record.completedAt > ttlMs) records.delete(key);
    });
  }

  function makeRoom() {
    removeExpired(now());
    while (records.size >= maxEntries) {
      let candidate = null;
      for (const [key, record] of records) {
        if (!record.pending) {
          candidate = key;
          break;
        }
      }
      if (candidate == null) return false;
      records.delete(candidate);
    }
    return true;
  }

  function begin(filePath, workspaceIdentity, requestedMutationId, content, encoding) {
    const key = pathKey(filePath);
    const existing = records.get(key);
    if (existing && existing.pending) {
      throw trackerError('WORKSPACE_WRITE_IN_PROGRESS', 'A workspace write is already in progress for this path');
    }
    if (existing) records.delete(key);
    if (!makeRoom()) throw trackerError('WORKSPACE_WRITE_LIMIT', 'Too many workspace writes are in progress');
    const mutationId = typeof requestedMutationId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestedMutationId)
      ? requestedMutationId
      : 'workspace-write-' + namespace + '-' + (++sequence);
    const record = {
      id: mutationId,
      key,
      filePath: path.resolve(filePath),
      workspaceIdentity,
      expectedDigest: contentDigest(content, encoding),
      pending: true,
      completedAt: 0,
      fingerprint: null,
      observed: false
    };
    records.set(key, record);
    return record;
  }

  async function complete(record) {
    if (!record || records.get(record.key) !== record) return false;
    const fingerprintBefore = fileFingerprint(fileSystem, record.filePath);
    if (!fingerprintBefore) {
      records.delete(record.key);
      return false;
    }
    let content;
    try {
      content = await fileSystem.promises.readFile(record.filePath);
    } catch (_) {
      records.delete(record.key);
      return false;
    }
    const fingerprintAfter = fileFingerprint(fileSystem, record.filePath);
    if (records.get(record.key) !== record || !fingerprintAfter || fingerprintBefore !== fingerprintAfter ||
        contentDigest(content) !== record.expectedDigest) {
      if (records.get(record.key) === record) records.delete(record.key);
      return false;
    }
    record.pending = false;
    record.completedAt = now();
    record.fingerprint = fingerprintAfter;
    record.expectedDigest = '';
    return true;
  }

  function fail(record) {
    if (!record || records.get(record.key) !== record) return false;
    records.delete(record.key);
    return record.observed;
  }

  function classify(filePath, workspaceIdentity) {
    const key = pathKey(filePath);
    const record = records.get(key);
    if (!record || record.workspaceIdentity !== workspaceIdentity) return null;
    if (record.pending) {
      record.observed = true;
      return { state: 'pending', mutationId: record.id };
    }
    if (now() - record.completedAt > ttlMs) {
      records.delete(key);
      return null;
    }
    try {
      if (fileFingerprint(fileSystem, record.filePath) !== record.fingerprint) {
        records.delete(key);
        return null;
      }
    } catch (_) {
      records.delete(key);
      return null;
    }
    record.observed = true;
    return { state: 'echo', mutationId: record.id };
  }

  function clear() {
    records.clear();
  }

  return Object.freeze({ begin, complete, fail, classify, clear });
}

function createWorkspaceWriteQueue() {
  let tail = Promise.resolve();

  function run(_scopePath, operation) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Workspace write operation is required'));
    const current = tail.catch(() => undefined).then(operation);
    tail = current;
    return current.finally(() => {
      if (tail === current) tail = Promise.resolve();
    });
  }

  return Object.freeze({ run });
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  createWorkspaceWriteQueue,
  createWorkspaceWriteTracker
};
