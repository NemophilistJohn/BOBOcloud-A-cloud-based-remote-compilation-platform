'use strict';

const crypto = require('node:crypto');
const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const MAX_DOCUMENT_CHUNK_BYTES = 2 * 1024 * 1024;

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
  const boundSenders = new WeakSet();

  function forget(session) {
    if (!session || sessions.get(session.id) !== session) return false;
    sessions.delete(session.id);
    const owned = sessionsBySender.get(session.senderId);
    if (owned) {
      owned.delete(session.id);
      if (owned.size === 0) sessionsBySender.delete(session.senderId);
    }
    return true;
  }

  function closeSender(id) {
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
    if (!isPlainObject(payload)) {
      throw documentError('DOCUMENT_VIEW_INVALID_ARGUMENT', 'Document open request must be an object.');
    }
    const id = senderId(event);
    bindSender(event);
    const pluginId = boundedString(payload.pluginId, 'Plugin id', 120);
    const viewerId = boundedString(payload.viewerId, 'Viewer id', 180);
    const requestedPath = boundedString(payload.filePath, 'Document path', 32767);
    const viewer = await options.authorize(pluginId, viewerId);
    if (!viewer) throw documentError('DOCUMENT_VIEW_DENIED', 'Document viewer is not authorized.');

    const resolved = options.resolveWorkspaceFile(requestedPath);
    if (!resolved || typeof resolved.filePath !== 'string') {
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is outside the active workspace.');
    }
    const stat = await fs.lstat(resolved.filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is not an ordinary workspace file.');
    }
    if (!Number.isSafeInteger(stat.size) || stat.size > MAX_DOCUMENT_BYTES) {
      throw documentError('DOCUMENT_VIEW_TOO_LARGE', 'Document exceeds the 128 MiB host limit.');
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
      dev: stat.dev,
      ino: stat.ino
    };
    sessions.set(session.id, session);
    if (!sessionsBySender.has(id)) sessionsBySender.set(id, new Set());
    sessionsBySender.get(id).add(session.id);
    return Object.freeze({
      documentId: session.id,
      name: path.basename(session.filePath),
      extension: path.extname(session.filePath).toLowerCase(),
      size: session.size,
      lastModified: new Date(stat.mtimeMs).toISOString()
    });
  }

  async function requireSession(event, payload) {
    if (!isPlainObject(payload)) {
      throw documentError('DOCUMENT_VIEW_INVALID_ARGUMENT', 'Document request must be an object.');
    }
    const id = senderId(event);
    const documentId = boundedString(payload.documentId, 'Document id', 80);
    const session = sessions.get(documentId);
    if (!session || session.senderId !== id) {
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document handle is unavailable.');
    }
    await options.authorize(session.pluginId, session.viewerId);
    const identity = options.getWorkspaceIdentity();
    if (!identity || identity.workspaceIdentity !== session.workspaceIdentity) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_STALE', 'Document handle belongs to a previous workspace.');
    }
    const resolved = options.resolveWorkspaceFile(session.filePath);
    const stat = await fs.lstat(resolved.filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is no longer available.');
    }
    if (stat.size !== session.size || stat.mtimeMs !== session.mtimeMs) {
      forget(session);
      throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed after the preview was opened.');
    }
    return session;
  }

  async function read(event, payload) {
    const session = await requireSession(event, payload);
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
    let handle;
    try {
      handle = await fs.open(session.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== session.size || stat.mtimeMs !== session.mtimeMs ||
          stat.dev !== session.dev || stat.ino !== session.ino) {
        forget(session);
        throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed after the preview was opened.');
      }
      const data = Buffer.allocUnsafe(requested);
      const result = await handle.read(data, 0, requested, offset);
      return {
        data: result.bytesRead === requested ? data : data.subarray(0, result.bytesRead),
        offset,
        length: result.bytesRead,
        eof: offset + result.bytesRead >= session.size
      };
    } catch (error) {
      if (error && error.code === 'DOCUMENT_VIEW_CHANGED') throw error;
      forget(session);
      if (error && error.code === 'ENOENT') {
        throw documentError('DOCUMENT_VIEW_NOT_FOUND', 'Document is no longer available.');
      }
      throw documentError('DOCUMENT_VIEW_CHANGED', 'Document changed after the preview was opened.');
    } finally {
      if (handle) await handle.close().catch(() => {});
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
    for (const session of Array.from(sessions.values())) {
      if (session.pluginId === pluginId) forget(session);
    }
  }

  function dispose() {
    sessions.clear();
    sessionsBySender.clear();
  }

  return Object.freeze({ open, read, close, closePlugin, closeSender, dispose });
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_CHUNK_BYTES,
  createPluginDocumentBroker
};
