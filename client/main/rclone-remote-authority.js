'use strict';

const crypto = require('node:crypto');
const { endpoint } = require('./server-transport');

const REMOTE_GRANT_TTL_MS = 2 * 60 * 1000;
const SERVER_REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_SERVER_RESPONSE_BYTES = 1024 * 1024;
const MAX_REMOTE_GRANTS = 128;
const MAX_REMOTE_GRANTS_PER_SENDER = 32;

function normalizeRemotePath(candidate) {
  if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.length > 4096 ||
      /[\0-\x1f\\:]/.test(candidate)) {
    throw new Error('Invalid remote workspace path');
  }
  const segments = candidate.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Invalid remote workspace path');
  }
  return '/' + segments.join('/');
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('Server response exceeded the rclone preparation limit');
  }
  if (response && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value || []);
        total += chunk.length;
        if (total > maxBytes) {
          try { await reader.cancel('response limit exceeded'); } catch (_) {}
          throw new Error('Server response exceeded the rclone preparation limit');
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total).toString('utf8');
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('Server response exceeded the rclone preparation limit');
  }
  return text;
}

function preparationPayload(kind, request) {
  const value = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  if (kind === 'workspace') {
    return {
      action: 'checkFolder',
      folderName: String(value.folderName || '').slice(0, 255),
      folderKey: String(value.folderKey || '').slice(0, 255),
      totalSize: Number.isSafeInteger(value.totalSize) && value.totalSize >= 0 ? value.totalSize : 0,
      teamId: String(value.teamId || '').slice(0, 160) || undefined,
      projectId: String(value.projectId || '').slice(0, 160) || undefined,
      branch: String(value.branch || '').slice(0, 255) || undefined
    };
  }
  if (kind === 'team-pull') {
    return {
      action: 'prepareTeamProject',
      teamId: String(value.teamId || '').slice(0, 160),
      projectId: String(value.projectId || '').slice(0, 160),
      branch: String(value.branch || '').slice(0, 255),
      reset: value.reset === true,
      pull: value.pull === true
    };
  }
  throw new Error('Unsupported rclone remote preparation kind');
}

function createRcloneRemoteAuthority(options) {
  const fetchImpl = options.fetch;
  const now = options.now || Date.now;
  const randomId = options.randomId || (() => crypto.randomUUID());
  const grantTtlMs = options.grantTtlMs || REMOTE_GRANT_TTL_MS;
  const maxGrants = options.maxGrants || MAX_REMOTE_GRANTS;
  const maxGrantsPerSender = options.maxGrantsPerSender || MAX_REMOTE_GRANTS_PER_SENDER;
  const grants = new Map();

  function prune(epoch) {
    const current = now();
    for (const [id, grant] of grants) {
      if (grant.expiresAt <= current || (epoch !== undefined && grant.epoch !== epoch)) grants.delete(id);
    }
  }

  function issue(payload) {
    prune(payload.epoch);
    let senderGrants = 0;
    for (const grant of grants.values()) if (grant.senderId === payload.senderId) senderGrants += 1;
    for (const [id, grant] of grants) {
      if (grants.size < maxGrants && senderGrants < maxGrantsPerSender) break;
      if (grant.senderId !== payload.senderId && grants.size < maxGrants) continue;
      grants.delete(id);
      if (grant.senderId === payload.senderId) senderGrants -= 1;
    }
    const grantId = randomId();
    grants.set(grantId, {
      senderId: payload.senderId,
      direction: payload.direction,
      remotePath: normalizeRemotePath(payload.remotePath),
      bindingKey: payload.bindingKey,
      contextKey: payload.contextKey,
      epoch: payload.epoch,
      expiresAt: now() + grantTtlMs
    });
    return grantId;
  }

  function consume(payload) {
    prune(payload.epoch);
    const grant = typeof payload.grantId === 'string' ? grants.get(payload.grantId) : null;
    if (!grant || grant.senderId !== payload.senderId) {
      throw new Error('The remote synchronization grant is missing or expired');
    }
    grants.delete(payload.grantId);
    if (grant.direction !== payload.direction || grant.bindingKey !== payload.bindingKey || grant.epoch !== payload.epoch) {
      throw new Error('The remote synchronization grant does not match this operation');
    }
    return grant;
  }

  function revokeSender(senderId) {
    for (const [id, grant] of grants) if (grant.senderId === senderId) grants.delete(id);
  }

  function clear() {
    grants.clear();
  }

  async function requestServerAction(context, payload, signal) {
    if (typeof fetchImpl !== 'function') throw new Error('The main-process server transport is unavailable');
    const url = endpoint(context.serverSettings, 'http');
    if (!url) return { success: false, error: 'Server IP not configured' };
    const controller = new AbortController();
    const abort = () => controller.abort(signal && signal.reason);
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', abort, { once: true });
    if (signal && signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error('server request timed out')), SERVER_REQUEST_TIMEOUT_MS);
    const headers = { 'Content-Type': 'application/json' };
    const credential = context.credential;
    if (credential && credential.token && (!credential.expiresAt || credential.expiresAt > now())) {
      headers.Authorization = 'Bearer ' + credential.token;
    } else if (context.serverSettings.apiKey) {
      headers.Authorization = 'Bearer ' + context.serverSettings.apiKey;
    }
    try {
      const response = await fetchImpl(url, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
        redirect: 'error', cache: 'no-store', credentials: 'omit'
      });
      const body = await readBoundedResponse(response, MAX_SERVER_RESPONSE_BYTES);
      let result;
      try {
        result = JSON.parse(body);
      } catch (_) {
        return { success: false, error: 'Server returned an invalid rclone preparation response', status: response.status };
      }
      if (!response.ok) return Object.assign({}, result, { success: false, status: response.status });
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        return { success: false, error: signal && signal.aborted ? 'rclone preparation was cancelled' : 'rclone preparation timed out' };
      }
      return { success: false, error: error.message };
    } finally {
      clearTimeout(timeout);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abort);
    }
  }

  async function prepare(kind, request, context, signal) {
    const payload = preparationPayload(kind, request);
    if (kind === 'workspace' && !payload.folderName) return { success: false, error: 'folderName is required' };
    if (kind === 'team-pull' && (!payload.teamId || !payload.projectId || !payload.branch)) {
      return { success: false, error: 'teamId, projectId and branch are required' };
    }
    const result = await requestServerAction(context, payload, signal);
    if (!result || !result.success) return { result: result || { success: false, error: 'Empty rclone preparation response' } };
    const remotePath = kind === 'workspace' ? result.folderPath : result.data && result.data.remote_path;
    const safeResult = Object.assign({}, result);
    if (kind === 'workspace') {
      delete safeResult.folderPath;
    } else {
      safeResult.data = Object.assign({}, result.data || {});
      delete safeResult.data.remote_path;
    }
    return { result: safeResult, remotePath: normalizeRemotePath(remotePath), direction: kind === 'workspace' ? 'sync' : 'pull' };
  }

  return { prepare, issue, consume, revokeSender, clear };
}

module.exports = {
  MAX_REMOTE_GRANTS,
  MAX_REMOTE_GRANTS_PER_SENDER,
  MAX_SERVER_RESPONSE_BYTES,
  REMOTE_GRANT_TTL_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  createRcloneRemoteAuthority,
  normalizeRemotePath,
  readBoundedResponse
};
