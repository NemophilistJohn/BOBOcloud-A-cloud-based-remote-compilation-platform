'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readFileBoundedSync } = require('./atomic-file');

const DEFAULT_MAX_CONFIGURATIONS = 8;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createRcloneConfigStore(options) {
  const rclone = options.rclone;
  const binaryManager = options.binaryManager;
  const now = options.now || Date.now;
  const randomId = options.randomId || (() => crypto.randomUUID());
  const maxConfigurations = options.maxConfigurations || DEFAULT_MAX_CONFIGURATIONS;
  const baseConfigPath = options.baseConfigPath || binaryManager.paths.config;
  const privateRoot = options.privateRoot || path.join(path.dirname(baseConfigPath), 'scoped');
  const connectionRoot = path.join(privateRoot, 'connections');
  const operationRoot = path.join(privateRoot, 'operations');
  const configurations = new Map();
  const operationSnapshots = new Set();
  let configureTail = Promise.resolve();

  for (const directory of [path.dirname(baseConfigPath), privateRoot, connectionRoot, operationRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The app-managed rclone config directory is unsafe');
    }
  }

  // A main-process restart invalidates every prior operation. Remove only
  // regular snapshots from these exact app-owned directories.
  for (const directory of [connectionRoot, operationRoot]) {
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.join(directory, name);
      try {
        const stat = fs.lstatSync(candidate);
        if (name.endsWith('.conf') && stat.isFile() && !stat.isSymbolicLink()) fs.rmSync(candidate, { force: true });
      } catch (_) {}
    }
  }
  try {
    const legacy = fs.lstatSync(baseConfigPath);
    if (legacy.isFile() && !legacy.isSymbolicLink()) fs.rmSync(baseConfigPath, { force: true });
  } catch (_) {}

  function fingerprint(configPath) {
    try {
      const stat = fs.lstatSync(configPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return '';
      return crypto.createHash('sha256').update(readFileBoundedSync(configPath, { maxBytes: 128 * 1024 })).digest('hex');
    } catch (_) {
      return '';
    }
  }

  async function inQueue(task) {
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const previous = configureTail;
    configureTail = current;
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  function removeConfiguration(value) {
    if (!value) return;
    configurations.delete(value.key);
    try { fs.rmSync(value.path, { force: true }); } catch (_) {}
  }

  function prune(currentKey) {
    const values = [...configurations.values()].sort((left, right) => right.lastUsed - left.lastUsed);
    for (let index = maxConfigurations; index < values.length; index += 1) {
      if (values[index].key !== currentKey) removeConfiguration(values[index]);
    }
  }

  async function ensure(context, force, signal) {
    if (!context.serverSettings || !context.serverSettings.ip || !context.serverSettings.user) {
      return { success: false, error: 'missing ip or user in settings' };
    }
    return inQueue(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (signal && signal.aborted) return { success: false, error: 'rclone configuration was cancelled' };
        const execution = await binaryManager.getExecutionDescriptor();
        const key = digest([context.key, execution.revision]);
        const cached = configurations.get(key);
        if (!force && cached && cached.fingerprint && cached.fingerprint === fingerprint(cached.path)) {
          cached.lastUsed = now();
          return { success: true, cached: true, execution, configPath: cached.path, context };
        }
        if (cached) removeConfiguration(cached);

        const configPath = path.join(connectionRoot, key + '-' + randomId() + '.conf');
        const result = await rclone.ensureConfig(
          context.serverSettings,
          execution.path,
          configPath,
          { signal }
        );
        force = false;
        if (!binaryManager.isSelectionCurrent(execution)) {
          try { fs.rmSync(configPath, { force: true }); } catch (_) {}
          continue;
        }
        if (!result.success) {
          try { fs.rmSync(configPath, { force: true }); } catch (_) {}
          return Object.assign({}, result, { execution, configPath, context });
        }
        const configFingerprint = fingerprint(configPath);
        if (!configFingerprint) {
          try { fs.rmSync(configPath, { force: true }); } catch (_) {}
          return { success: false, error: 'rclone configuration was not created' };
        }
        try { fs.chmodSync(configPath, 0o600); } catch (_) {}
        const value = { key, path: configPath, fingerprint: configFingerprint, lastUsed: now() };
        configurations.set(key, value);
        prune(key);
        return { success: true, execution, configPath, context };
      }
      return { success: false, error: 'rclone selection changed too frequently' };
    });
  }

  function createOperationSnapshot(configPath, operationKey) {
    const sourceFingerprint = fingerprint(configPath);
    if (!sourceFingerprint) throw new Error('The scoped rclone configuration is unavailable');
    const destination = path.join(operationRoot, digest([operationKey, randomId()]) + '.conf');
    fs.copyFileSync(configPath, destination, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(destination, 0o600); } catch (_) {}
    if (fingerprint(destination) !== sourceFingerprint) {
      try { fs.rmSync(destination, { force: true }); } catch (_) {}
      throw new Error('The operation rclone configuration could not be verified');
    }
    operationSnapshots.add(destination);
    return destination;
  }

  function releaseOperationSnapshot(configPath) {
    if (!operationSnapshots.delete(configPath)) return false;
    try { fs.rmSync(configPath, { force: true }); } catch (_) {}
    return true;
  }

  function invalidate() {
    for (const value of [...configurations.values()]) removeConfiguration(value);
  }

  return { ensure, createOperationSnapshot, releaseOperationSnapshot, invalidate };
}

module.exports = { DEFAULT_MAX_CONFIGURATIONS, createRcloneConfigStore };
