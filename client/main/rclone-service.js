'use strict';

const crypto = require('node:crypto');
const { createRcloneConfigStore } = require('./rclone-config-store');
const {
  MAX_REMOTE_GRANTS,
  MAX_REMOTE_GRANTS_PER_SENDER,
  MAX_SERVER_RESPONSE_BYTES,
  REMOTE_GRANT_TTL_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  createRcloneRemoteAuthority,
  normalizeRemotePath,
  readBoundedResponse
} = require('./rclone-remote-authority');
const {
  credentialForServer,
  effectiveCredential,
  rcloneConnectionIdentity,
  serverAccountIdentity,
  serverTransportIdentity
} = require('./server-identity');

const MAX_ACTIVE_OPERATIONS_PER_SENDER = 8;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function failure(type, message, durationMs = 0) {
  return { success: false, error: { type, message }, stats: { durationMs } };
}

function createRcloneService(options) {
  const rclone = options.rclone;
  const binaryManager = options.binaryManager;
  const settings = options.settings;
  const now = options.now || Date.now;
  const randomId = options.randomId || (() => crypto.randomUUID());
  const configStore = options.configStore || createRcloneConfigStore({
    rclone,
    binaryManager,
    now,
    randomId,
    baseConfigPath: options.configPath,
    privateRoot: options.privateConfigRoot
  });
  const remoteAuthority = options.remoteAuthority || createRcloneRemoteAuthority({
    fetch: options.fetch,
    now,
    randomId,
    grantTtlMs: options.remoteGrantTtlMs
  });
  const active = new Map();
  let contextEpoch = 1;
  let activeContextKey = '';

  function currentCredential(serverSettings) {
    const auth = settings.readAuth ? settings.readAuth() : { servers: {} };
    return credentialForServer(auth, serverSettings).credential;
  }

  async function captureContext(suppliedSettings) {
    const serverSettings = suppliedSettings || await settings.readServerSettings();
    const currentTime = now();
    const credential = effectiveCredential(currentCredential(serverSettings), currentTime);
    const account = serverAccountIdentity(serverSettings, credential, currentTime);
    return {
      serverSettings,
      credential,
      account,
      key: digest([
        serverTransportIdentity(serverSettings),
        rcloneConnectionIdentity(serverSettings),
        account
      ])
    };
  }

  async function contextIsCurrent(snapshot) {
    try {
      return (await captureContext()).key === snapshot.key;
    } catch (_) {
      return false;
    }
  }

  async function adoptContext(context, reason) {
    if (activeContextKey && activeContextKey !== context.key) {
      await cancelAll(reason || 'server-context-changed');
    }
    activeContextKey = context.key;
  }

  function taskKey(senderId, operationId) {
    return String(senderId) + ':' + String(operationId);
  }

  function track(senderId, operationId, kind, executor) {
    const key = taskKey(senderId, operationId);
    if (active.has(key)) throw new Error('An rclone operation with this id is already active');
    let senderOperations = 0;
    for (const record of active.values()) if (record.senderId === senderId) senderOperations += 1;
    if (senderOperations >= MAX_ACTIVE_OPERATIONS_PER_SENDER) throw new Error('Too many rclone operations are active');
    const controller = new AbortController();
    const record = { key, senderId, operationId, kind, controller, promise: null };
    active.set(key, record);
    record.promise = Promise.resolve()
      .then(() => executor(controller.signal, record))
      .finally(() => {
        if (active.get(key) === record) active.delete(key);
      });
    return record.promise;
  }

  async function ensureConfigured(serverSettings, force, signal) {
    const context = await captureContext(serverSettings);
    if (!activeContextKey) activeContextKey = context.key;
    return configStore.ensure(context, force === true, signal);
  }

  async function prepareRemote(payload) {
    const context = await captureContext();
    await adoptContext(context, 'remote-preparation-context-changed');
    return track(payload.senderId, payload.operationId, 'prepare', async (signal) => {
      const epoch = contextEpoch;
      let prepared;
      try {
        let request = payload.request;
        if (typeof payload.measure === 'function') {
          if (payload.isCurrent && !payload.isCurrent()) throw new Error('The workspace synchronization scope is stale');
          const measured = await payload.measure(signal);
          if (!measured || !Number.isSafeInteger(measured.size) || measured.size < 0) {
            const error = new Error('Workspace measurement returned an invalid result');
            error.code = 'WORKSPACE_SCAN_FAILED';
            throw error;
          }
          request = Object.assign({}, request, { totalSize: measured.size });
        }
        prepared = await remoteAuthority.prepare(payload.kind, request, context, signal);
      } catch (error) {
        return { success: false, error: error.message, errorCode: error.code || 'remote_preparation_failed' };
      }
      if (!prepared.remotePath) return prepared.result;
      if (signal.aborted || epoch !== contextEpoch || !(await contextIsCurrent(context)) ||
          (payload.isCurrent && !payload.isCurrent())) {
        return { success: false, error: 'The synchronization context changed', errorCode: 'stale_context' };
      }
      const remoteGrantId = remoteAuthority.issue({
        senderId: payload.senderId,
        direction: prepared.direction,
        remotePath: prepared.remotePath,
        bindingKey: payload.bindingKey,
        contextKey: context.key,
        epoch
      });
      return Object.assign({}, prepared.result, { remoteGrantId });
    });
  }

  async function run(kind, payload) {
    const context = await captureContext();
    if (!activeContextKey) activeContextKey = context.key;
    if (activeContextKey !== context.key) return failure('STALE_CONTEXT', 'The synchronization context changed');
    return track(payload.senderId, payload.operationId, kind, async (signal, record) => {
      const started = now();
      let operationConfigPath = '';
      try {
        const grant = remoteAuthority.consume({
          senderId: payload.senderId,
          direction: kind,
          grantId: payload.remoteGrantId,
          bindingKey: payload.bindingKey,
          epoch: contextEpoch
        });
        if (context.key !== grant.contextKey || signal.aborted || (payload.isCurrent && !payload.isCurrent())) {
          return failure('STALE_CONTEXT', 'The synchronization context changed', now() - started);
        }
        const configured = await configStore.ensure(context, false, signal);
        if (!configured.success) {
          return failure(signal.aborted ? 'CANCELLED' : 'CONFIG_FAILED', configured.error || 'rclone configuration failed', now() - started);
        }
        if (!binaryManager.isSelectionCurrent(configured.execution)) {
          return failure('SELECTION_CHANGED', 'The rclone selection changed', now() - started);
        }
        operationConfigPath = configStore.createOperationSnapshot(configured.configPath, record.key);
        const corePayload = {
          executablePath: configured.execution.path,
          configPath: operationConfigPath,
          remotePath: grant.remotePath,
          signal,
          onProgress: payload.onProgress
        };
        if (kind === 'pull') corePayload.dest = payload.localPath;
        else corePayload.src = payload.localPath;
        const result = kind === 'pull' ? await rclone.pull(corePayload) : await rclone.sync(corePayload);
        if (grant.epoch !== contextEpoch || !(await contextIsCurrent(context)) ||
            (payload.isCurrent && !payload.isCurrent())) {
          return failure('STALE_CONTEXT', 'The synchronization context changed', now() - started);
        }
        return result;
      } catch (error) {
        return failure(signal.aborted ? 'CANCELLED' : 'OPERATION_REJECTED', error.message, now() - started);
      } finally {
        if (operationConfigPath) configStore.releaseOperationSnapshot(operationConfigPath);
      }
    });
  }

  async function cancelMatching(predicate, reason, invalidate) {
    const records = [...active.values()].filter(predicate);
    if (invalidate) contextEpoch += 1;
    for (const record of records) record.controller.abort(new Error(reason || 'rclone operation cancelled'));
    await Promise.allSettled(records.map((record) => record.promise));
    return { cancelled: records.length, reason: String(reason || 'cancelled') };
  }

  async function cancelOperation(senderId, operationId, reason) {
    return cancelMatching(
      (record) => record.senderId === senderId && record.operationId === operationId,
      reason || 'renderer-cancel',
      false
    );
  }

  async function cancelSender(senderId, reason) {
    remoteAuthority.revokeSender(senderId);
    return cancelMatching((record) => record.senderId === senderId, reason || 'sender-context-changed', true);
  }

  async function cancelAll(reason) {
    remoteAuthority.clear();
    return cancelMatching(() => true, reason || 'context-changed', true);
  }

  async function selectBinary(senderId, payload, confirmExternal) {
    const result = await binaryManager.selectCandidate(senderId, payload, confirmExternal);
    if (!result.cancelled) {
      await cancelAll('rclone-selection-changed');
      const serverSettings = await settings.readServerSettings();
      if (serverSettings.ip && serverSettings.user) {
        const configured = await ensureConfigured(serverSettings, true);
        if (!configured.success) result.configurationError = configured.error;
      }
    }
    return result;
  }

  async function validateConnection(senderId) {
    const context = await captureContext();
    await adoptContext(context, 'rclone-validation-context-changed');
    return track(senderId, 'validate-' + randomId(), 'validate', async (signal) => {
      const configured = await configStore.ensure(context, false, signal);
      if (!configured.success) {
        return failure(signal.aborted ? 'CANCELLED' : 'CONFIG_FAILED',
          configured.error || 'rclone configuration failed');
      }
      if (!binaryManager.isSelectionCurrent(configured.execution)) {
        return failure('SELECTION_CHANGED', 'The rclone selection changed');
      }
      const checked = await rclone.checkConnection({
        executablePath: configured.execution.path,
        configPath: configured.configPath,
        signal
      });
      if (signal.aborted) return failure('CANCELLED', 'rclone connection check was cancelled');
      return checked;
    });
  }

  async function reconfigure(serverSettings, reason) {
    const context = await captureContext(serverSettings);
    await adoptContext(context, reason || 'server-context-changed');
    const configured = await configStore.ensure(context, false);
    if (!configured.success && configured.error !== 'missing ip or user in settings') {
      console.error('[rclone] ensureConfig failed:', configured.error);
    }
    return configured;
  }

  function configureInBackground(serverSettings) {
    void reconfigure(serverSettings, 'server-context-changed').catch((error) => {
      console.error('[rclone] ensureConfig failed:', error.message);
    });
  }

  return {
    listBinaries: (senderId) => binaryManager.listCandidates(senderId),
    selectBinary,
    getSelection: () => binaryManager.getSelection(),
    checkVersion: () => binaryManager.checkActiveVersion(),
    validateConnection,
    prepareRemote,
    sync: (payload) => run('sync', payload),
    pull: (payload) => run('pull', payload),
    cancelOperation,
    cancelSender,
    cancelAll,
    ensureConfigured,
    reconfigure,
    configureInBackground,
    invalidateConfiguration: () => configStore.invalidate(),
    getContextEpoch: () => contextEpoch
  };
}

module.exports = {
  MAX_ACTIVE_OPERATIONS_PER_SENDER,
  MAX_REMOTE_GRANTS,
  MAX_REMOTE_GRANTS_PER_SENDER,
  MAX_SERVER_RESPONSE_BYTES,
  REMOTE_GRANT_TTL_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  createRcloneService,
  normalizeRemotePath,
  readBoundedResponse
};
