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
  const hash = crypto.createHash('sha256');
  if (Buffer.isBuffer(content)) hash.update(content);
  else hash.update(String(content ?? ''), encoding || 'utf8');
  return hash.digest('hex');
}

function contentBytes(content, encoding) {
  return Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content ?? ''), encoding || 'utf8');
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
      expectedBytes: contentBytes(content, encoding),
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
    let before;
    try { before = fileSystem.statSync(record.filePath, { bigint: true }); } catch (_) {}
    if (!before || !before.isFile() || before.size !== BigInt(record.expectedBytes)) {
      records.delete(record.key);
      return false;
    }
    const fingerprintBefore = [before.dev, before.ino, before.size, before.mode, before.mtimeNs, before.ctimeNs]
      .map((value) => String(value)).join(':');
    const noFollow = Number(fileSystem.constants && fileSystem.constants.O_NOFOLLOW) || 0;
    let handle;
    let actualDigest = '';
    let total = 0;
    try {
      handle = await fileSystem.promises.open(record.filePath, fileSystem.constants.O_RDONLY | noFollow);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        records.delete(record.key);
        return false;
      }
      const hash = crypto.createHash('sha256');
      while (total <= record.expectedBytes) {
        const capacity = Math.min(64 * 1024, record.expectedBytes + 1 - total);
        if (capacity <= 0) break;
        const chunk = Buffer.allocUnsafe(capacity);
        const read = await handle.read(chunk, 0, capacity, null);
        if (!read.bytesRead) break;
        total += read.bytesRead;
        hash.update(chunk.subarray(0, read.bytesRead));
      }
      actualDigest = hash.digest('hex');
    } catch (_) {
      records.delete(record.key);
      return false;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    const fingerprintAfter = fileFingerprint(fileSystem, record.filePath);
    if (records.get(record.key) !== record || !fingerprintAfter || fingerprintBefore !== fingerprintAfter ||
        total !== record.expectedBytes || actualDigest !== record.expectedDigest) {
      if (records.get(record.key) === record) records.delete(record.key);
      return false;
    }
    record.pending = false;
    record.completedAt = now();
    record.fingerprint = fingerprintAfter;
    record.expectedDigest = '';
    record.expectedBytes = 0;
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
  let transitionTail = Promise.resolve();
  let pendingTransitions = 0;

  function transitionError() {
    const error = new Error('Workspace transition is in progress');
    error.code = 'WORKSPACE_TRANSITION_IN_PROGRESS';
    return error;
  }

  function run(_scopePath, operation) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Workspace write operation is required'));
    if (pendingTransitions > 0) return Promise.reject(transitionError());
    const current = tail.then(operation);
    tail = current.catch(() => undefined);
    return current;
  }

  function transition(_reason, operation) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Workspace transition operation is required'));
    pendingTransitions += 1;
    const current = transitionTail.then(async () => {
      await tail;
      return operation();
    });
    const settled = current.finally(() => {
      pendingTransitions -= 1;
    });
    transitionTail = settled.catch(() => undefined);
    return settled;
  }

  return Object.freeze({ run, transition });
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  createWorkspaceWriteQueue,
  createWorkspaceWriteTracker
};
