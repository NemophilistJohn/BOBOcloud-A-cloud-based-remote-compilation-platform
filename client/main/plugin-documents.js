'use strict';

const crypto = require('node:crypto');
const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readFileBounded, writeFileAtomic } = require('./atomic-file');

const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const MAX_DOCUMENT_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_SESSION_READS = 4;
const MAX_DOCUMENT_SENDER_READS = 16;
const MAX_EDIT_BYTES = 24 * 1024 * 1024;
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sameFile = (left, right) => left.size === right.size && left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs && left.dev === right.dev && left.ino === right.ino;

function documentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw documentError('DOCUMENT_VIEW_INVALID_ARGUMENT', label + ' is invalid.');
  }
  return value;
}

function senderId(event) {
  const value = event && event.sender && event.sender.id;
  if (!Number.isInteger(value) || value < 0) {
    throw documentError('DOCUMENT_VIEW_DENIED', 'Document request has no trusted renderer sender.');
  }
  return value;
}

function createPluginDocumentBroker(options = {}) {
  if (typeof options.resolveWorkspaceFile !== 'function' ||
      typeof options.getWorkspaceIdentity !== 'function' ||
      typeof options.authorize !== 'function') {
    throw new TypeError('Plugin document broker requires workspace resolution, identity, and authorization callbacks.');
  }

  const sessions = new Map();
  const sessionsBySender = new Map();
  const activeReadsBySender = new Map();
  const senderRevisions = new Map();
  const pluginRevisions = new Map();
  const boundSenders = new WeakSet();
  const fileSystem = options.fileSystem || fs;
  let disposed = false;

  if (typeof fileSystem.lstat !== 'function' || typeof fileSystem.open !== 'function') {
    throw new TypeError('Plugin document broker requires lstat and open filesystem operations.');
  }

  function acquireSenderRead(id) {
    const senderReads = activeReadsBySender.get(id) || 0;
    if (senderReads >= MAX_DOCUMENT_SENDER_READS) {
      throw documentError('DOCUMENT_VIEW_BUSY', 'Document view has too many reads in progress.');
    }
    activeReadsBySender.set(id, senderReads + 1);
  }

  function releaseSenderRead(id) {
    const senderReads = activeReadsBySender.get(id) || 0;
    if (senderReads <= 1) activeReadsBySender.delete(id);
    else activeReadsBySender.set(id, senderReads - 1);
  }

  function acquireSessionRead(session) {
    if (session.activeReads >= MAX_DOCUMENT_SESSION_READS) {
      throw documentError('DOCUMENT_VIEW_BUSY', 'Document view has too many reads in progress.');
    }
    session.activeReads += 1;
  }

  function releaseSessionRead(session) {
    session.activeReads = Math.max(0, session.activeReads - 1);
  }

  function revisionOf(revisions, key) {
    return revisions.get(key) || 0;
  }

  function advanceRevision(revisions, key) {
    revisions.set(key, revisionOf(revisions, key) + 1);
  }

  function forget(session) {
    if (!session || sessions.get(session.id) !== session) return false;
    sessions.delete(session.id);
    options.kernels?.close(session.id);
    const owned = sessionsBySender.get(session.senderId);
    if (owned) {
      owned.delete(session.id);
      if (owned.size === 0) sessionsBySender.delete(session.senderId);
    }
    return true;
  }

  function closeSender(id) {
    advanceRevision(senderRevisions, id);
    const owned = sessionsBySender.get(id);
    if (!owned) return;
    for (const sessionId of Array.from(owned)) forget(sessions.get(sessionId));
  }

  function bindSender(event) {
    const sender = event && event.sender;
    if (!sender || boundSenders.has(sender) || typeof sender.once !== 'function') return;
    boundSenders.add(sender);
    const id = sender.id;
    sender.once('destroyed', () => closeSender(id));
  }

  async function open(event, payload) {
    if (disposed) throw documentError('DOCUMENT_VIEW_UNAVAILABLE', 'Document broker has been disposed.');
    if (!isPlainObject(payload)) {
      throw documentError('DOCUMENT_VIEW_INVALID_ARGUMENT', 'Document open request must be an object.');
    }
    const id = senderId(event);
    bindSender(event);
    const pluginId = boundedString(payload.pluginId, 'Plugin id', 120);
    const viewerId = boundedString(payload.viewerId, 'Viewer id', 180);
    const requestedPath = boundedString(payload.filePath, 'Document path', 32767);
    const senderRevision = revisionOf(senderRevisions, id);
    const pluginRevision = revisionOf(pluginRevisions, pluginId);
    const viewer = await options.authorize(pluginId, viewerId);
    if (!viewer) throw documentError('DOCUMENT_VIEW_DENIED', 'Document viewer is not authorized.');

    let resolved;
    try {
      resolved = options.resolveWorkspaceFile(requestedPath);
    } catch (_) {
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is outside the active workspace.');
    }
    if (!resolved || typeof resolved.filePath !== 'string') {
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is outside the active workspace.');
    }
    const initialIdentity = options.getWorkspaceIdentity();
    if (!initialIdentity || resolved.workspaceIdentity !== initialIdentity.workspaceIdentity) {
      throw documentError('DOCUMENT_VIEW_STALE', 'Document belongs to a previous workspace.');
    }
    const stat = await Promise.resolve().then(() => fileSystem.lstat(resolved.filePath)).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is not an ordinary workspace file.');
    }
    if (!Number.isSafeInteger(stat.size) || stat.size > MAX_DOCUMENT_BYTES) {
      throw documentError('DOCUMENT_VIEW_TOO_LARGE', 'Document exceeds the 128 MiB host limit.');
    }
    if (disposed || revisionOf(senderRevisions, id) !== senderRevision ||
        revisionOf(pluginRevisions, pluginId) !== pluginRevision) {
      throw documentError('DOCUMENT_VIEW_STALE', 'Document open request was revoked.');
    }
    const finalViewer = await options.authorize(pluginId, viewerId);
    if (!finalViewer) throw documentError('DOCUMENT_VIEW_DENIED', 'Document viewer is not authorized.');
    if (Array.isArray(finalViewer.extensions) &&
        !finalViewer.extensions.includes(path.extname(resolved.filePath).toLowerCase())) {
      throw documentError('DOCUMENT_VIEW_DENIED', 'Document extension is not registered by this viewer.');
    }
    let baseline;
    if (finalViewer.canWrite && options.runMutation && stat.size <= MAX_EDIT_BYTES) {
      baseline = digest(await readFileBounded(resolved.filePath, { maxBytes: MAX_EDIT_BYTES }));
      if (!sameFile(stat, await fileSystem.lstat(resolved.filePath))) {
        throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed while it was being opened.');
      }
    }
    const finalIdentity = options.getWorkspaceIdentity();
    if (disposed || revisionOf(senderRevisions, id) !== senderRevision ||
        revisionOf(pluginRevisions, pluginId) !== pluginRevision) {
      throw documentError('DOCUMENT_VIEW_STALE', 'Document open request was revoked.');
    }
    if (!finalIdentity || finalIdentity.workspaceIdentity !== resolved.workspaceIdentity) {
      throw documentError('DOCUMENT_VIEW_STALE', 'Document belongs to a previous workspace.');
    }

    const session = {
      id: crypto.randomUUID(),
      senderId: id,
      pluginId,
      viewerId,
      filePath: resolved.filePath,
      workspaceIdentity: resolved.workspaceIdentity,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      baseline,
      mode: stat.mode & 0o777,
      activeReads: 0
    };
    sessions.set(session.id, session);
    if (!sessionsBySender.has(id)) sessionsBySender.set(id, new Set());
    sessionsBySender.get(id).add(session.id);
    return Object.freeze({
      documentId: session.id,
      name: path.basename(session.filePath),
      extension: path.extname(session.filePath).toLowerCase(),
      size: session.size,
      lastModified: new Date(stat.mtimeMs).toISOString(),
      ...(baseline ? { writable: true } : {}),
      ...(finalViewer.canAnalyze ? { analyzable: true } : {}),
      ...(finalViewer.canExecute && options.kernels && path.extname(session.filePath).toLowerCase() === '.ipynb'
        ? { executable: true } : {})
    });
  }

  async function requireSession(event, payload, requireWrite = false, requireExecute = false) {
    if (disposed) throw documentError('DOCUMENT_VIEW_UNAVAILABLE', 'Document broker has been disposed.');
    if (!isPlainObject(payload)) {
      throw documentError('DOCUMENT_VIEW_INVALID_ARGUMENT', 'Document request must be an object.');
    }
    const id = senderId(event);
    const documentId = boundedString(payload.documentId, 'Document id', 80);
    const session = sessions.get(documentId);
    if (!session || session.senderId !== id) {
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document handle is unavailable.');
    }
    let viewer;
    try {
      viewer = await options.authorize(session.pluginId, session.viewerId);
    } catch (error) {
      forget(session);
      throw error;
    }
    if (!viewer || sessions.get(session.id) !== session) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_STALE', 'Document handle was revoked.');
    }
    if (requireWrite && (!viewer.canWrite || !session.baseline || !options.runMutation)) {
      throw documentError('DOCUMENT_VIEW_DENIED', 'Document writing is not permitted.');
    }
    if (requireExecute && (!viewer.canExecute || !options.kernels || path.extname(session.filePath).toLowerCase() !== '.ipynb')) {
      throw documentError('DOCUMENT_VIEW_DENIED', 'Document execution is not permitted.');
    }
    const identity = options.getWorkspaceIdentity();
    if (!identity || identity.workspaceIdentity !== session.workspaceIdentity) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_STALE', 'Document handle belongs to a previous workspace.');
    }
    let resolved;
    try {
      resolved = options.resolveWorkspaceFile(session.filePath);
    } catch (_) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is no longer available.');
    }
    if (!resolved || typeof resolved.filePath !== 'string' || resolved.workspaceIdentity !== session.workspaceIdentity) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_STALE', 'Document handle belongs to a previous workspace.');
    }
    const stat = await Promise.resolve().then(() => fileSystem.lstat(resolved.filePath)).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is no longer available.');
    }
    if (!sameFile(stat, session)) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed after the preview was opened.');
    }
    const finalIdentity = options.getWorkspaceIdentity();
    if (sessions.get(session.id) !== session || !finalIdentity ||
        finalIdentity.workspaceIdentity !== session.workspaceIdentity) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_STALE', 'Document handle was revoked.');
    }
    return session;
  }

  async function save(event, payload) {
    if (typeof payload?.text !== 'string' || Buffer.byteLength(payload.text) > MAX_EDIT_BYTES) {
      throw documentError('DOCUMENT_VIEW_INVALID_ARGUMENT', 'Document text exceeds the editing limit.');
    }
    const session = await requireSession(event, payload, true);
    if (session.saving) throw documentError('DOCUMENT_VIEW_BUSY', 'Document save already in progress.');
    session.saving = true;
    try {
      return await options.runMutation(session.filePath, async (mutation) => {
        const data = Buffer.from(payload.text, 'utf8');
        const check = async () => {
          await requireSession(event, payload, true);
          if (digest(await readFileBounded(session.filePath, { maxBytes: MAX_EDIT_BYTES })) !== session.baseline) {
            throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed after the preview was opened.');
          }
          await requireSession(event, payload, true);
          mutation.assertCurrent();
        };
        await check();
        await writeFileAtomic(session.filePath, data, { maxBytes: MAX_EDIT_BYTES, mode: session.mode, beforeReplace: check });
        const stat = await fileSystem.lstat(session.filePath);
        Object.assign(session, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev,
          ino: stat.ino, baseline: digest(data) });
        options.notifyFiles?.([{ path: session.filePath, event: 'file-changed' }], mutation);
        return { ok: true };
      });
    } finally {
      session.saving = false;
    }
  }

  async function execute(event, payload) {
    const session = await requireSession(event, payload, false, true);
    if (!isPlainObject(payload.request)) return { ok: false, code: 'invalid_cell' };
    return options.kernels.control(session, payload.request);
  }

  async function read(event, payload) {
    if (disposed) throw documentError('DOCUMENT_VIEW_UNAVAILABLE', 'Document broker has been disposed.');
    const id = senderId(event);
    acquireSenderRead(id);
    let session;
    let sessionReadAcquired = false;
    try {
      session = await requireSession(event, payload);
      const offset = payload.offset === undefined ? 0 : payload.offset;
      const length = payload.length === undefined ? MAX_DOCUMENT_CHUNK_BYTES : payload.length;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.size ||
          !Number.isSafeInteger(length) || length < 1 || length > MAX_DOCUMENT_CHUNK_BYTES) {
        throw documentError('DOCUMENT_VIEW_INVALID_ARGUMENT', 'Document read range is invalid.');
      }
      const requested = Math.min(length, session.size - offset);
      if (requested === 0) {
        return { data: Buffer.alloc(0), offset, length: 0, eof: true };
      }
      acquireSessionRead(session);
      sessionReadAcquired = true;
      let handle;
      let response;
      try {
        handle = await fileSystem.open(session.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== session.size || stat.mtimeMs !== session.mtimeMs ||
            stat.ctimeMs !== session.ctimeMs ||
            stat.dev !== session.dev || stat.ino !== session.ino) {
          forget(session);
          throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed after the preview was opened.');
        }
        const data = Buffer.allocUnsafe(requested);
        const result = await handle.read(data, 0, requested, offset);
        const finalStat = await handle.stat();
        if (!finalStat.isFile() || finalStat.size !== session.size ||
            finalStat.mtimeMs !== session.mtimeMs || finalStat.ctimeMs !== session.ctimeMs ||
            finalStat.dev !== session.dev || finalStat.ino !== session.ino) {
          forget(session);
          throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed while the preview was reading it.');
        }
        const identity = options.getWorkspaceIdentity();
        if (sessions.get(session.id) !== session || !identity || identity.workspaceIdentity !== session.workspaceIdentity) {
          forget(session);
          throw documentError('DOCUMENT_VIEW_STALE', 'Document handle was revoked while the read was in progress.');
        }
        response = {
          data: result.bytesRead === requested ? data : data.subarray(0, result.bytesRead),
          offset,
          length: result.bytesRead,
          eof: offset + result.bytesRead >= session.size
        };
      } catch (error) {
        if (error && (error.code === 'DOCUMENT_VIEW_CHANGED' || error.code === 'DOCUMENT_VIEW_STALE')) throw error;
        forget(session);
        if (error && error.code === 'ENOENT') {
          throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is no longer available.');
        }
        throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed after the preview was opened.');
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
      const finalIdentity = options.getWorkspaceIdentity();
      if (sessions.get(session.id) !== session || !finalIdentity ||
          finalIdentity.workspaceIdentity !== session.workspaceIdentity) {
        forget(session);
        throw documentError('DOCUMENT_VIEW_STALE', 'Document handle was revoked while the read was in progress.');
      }
      return response;
    } finally {
      if (sessionReadAcquired) releaseSessionRead(session);
      releaseSenderRead(id);
    }
  }

  function close(event, payload) {
    if (!isPlainObject(payload)) return { closed: false };
    const id = senderId(event);
    const documentId = typeof payload.documentId === 'string' ? payload.documentId : '';
    const session = sessions.get(documentId);
    if (!session || session.senderId !== id) return { closed: false };
    return { closed: forget(session) };
  }

  function closePlugin(pluginId) {
    advanceRevision(pluginRevisions, pluginId);
    for (const session of Array.from(sessions.values())) {
      if (session.pluginId === pluginId) forget(session);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const session of sessions.values()) forget(session);
    sessions.clear();
    sessionsBySender.clear();
    activeReadsBySender.clear();
  }

  return Object.freeze({ open, read, save, execute, close, closePlugin, closeSender, dispose });
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_CHUNK_BYTES,
  MAX_DOCUMENT_SESSION_READS,
  MAX_DOCUMENT_SENDER_READS,
  createPluginDocumentBroker
};
