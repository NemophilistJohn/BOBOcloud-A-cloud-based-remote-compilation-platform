'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function createRcloneService(options) {
  const rclone = options.rclone;
  const binaryManager = options.binaryManager;
  const settings = options.settings;
  const configPath = options.configPath || binaryManager.paths.config;
  let configuredKey = '';
  let configuredFingerprint = '';
  let configureTail = Promise.resolve();

  function configurationKey(serverSettings, revision) {
    return crypto.createHash('sha256').update(JSON.stringify([
      revision,
      serverSettings.ip || '',
      serverSettings.user || '',
      serverSettings.pass || ''
    ])).digest('hex');
  }

  function configFingerprint() {
    try {
      const stat = fs.statSync(configPath);
      if (!stat.isFile()) return '';
      return crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
    } catch (_) {
      return '';
    }
  }

  async function inConfigurationQueue(task) {
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

  async function ensureConfigured(serverSettings, force) {
    if (!serverSettings || !serverSettings.ip || !serverSettings.user) {
      return { success: false, error: 'missing ip or user in settings' };
    }
    return inConfigurationQueue(async () => {
      let forceWrite = force === true;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const execution = await binaryManager.getExecutionDescriptor();
        const key = configurationKey(serverSettings, execution.revision);
        const actualFingerprint = configFingerprint();
        if (!forceWrite && configuredKey === key && configuredFingerprint && configuredFingerprint === actualFingerprint) {
          return { success: true, cached: true, execution, configPath };
        }

        const result = await rclone.ensureConfig(serverSettings, execution.path, configPath);
        forceWrite = false;
        if (!binaryManager.isSelectionCurrent(execution)) continue;
        if (result.success) {
          configuredKey = key;
          configuredFingerprint = configFingerprint();
          if (!configuredFingerprint) return { success: false, error: 'rclone configuration was not created' };
        }
        return Object.assign({}, result, { execution, configPath });
      }
      return { success: false, error: 'rclone selection changed too frequently' };
    });
  }

  async function run(kind, payload) {
    const serverSettings = await settings.readServerSettings();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const configured = await ensureConfigured(serverSettings, false);
      if (!configured.success) {
        return {
          success: false,
          error: { type: 'CONFIG_FAILED', message: configured.error || 'rclone configuration failed' },
          stats: { durationMs: 0 }
        };
      }
      if (!binaryManager.isSelectionCurrent(configured.execution)) continue;
      const optionsForCore = Object.assign({}, payload, {
        executablePath: configured.execution.path,
        configPath
      });
      delete optionsForCore.rclonePath;
      return kind === 'pull' ? rclone.pull(optionsForCore) : rclone.sync(optionsForCore);
    }
    return {
      success: false,
      error: { type: 'SELECTION_CHANGED', message: 'rclone selection changed too frequently' },
      stats: { durationMs: 0 }
    };
  }

  async function selectBinary(senderId, payload, confirmExternal) {
    const result = await binaryManager.selectCandidate(senderId, payload, confirmExternal);
    if (!result.cancelled) {
      invalidateConfiguration();
      const serverSettings = await settings.readServerSettings();
      if (serverSettings.ip && serverSettings.user) {
        const configured = await ensureConfigured(serverSettings, true);
        if (!configured.success) result.configurationError = configured.error;
      }
    }
    return result;
  }

  function configureInBackground(serverSettings) {
    invalidateConfiguration();
    void ensureConfigured(serverSettings, false).then((result) => {
      if (!result.success && result.error !== 'missing ip or user in settings') {
        console.error('[rclone] ensureConfig failed:', result.error);
      }
    }).catch((error) => console.error('[rclone] ensureConfig failed:', error.message));
  }

  function invalidateConfiguration() {
    configuredKey = '';
    configuredFingerprint = '';
  }

  return {
    listBinaries: (senderId) => binaryManager.listCandidates(senderId),
    selectBinary,
    getSelection: () => binaryManager.getSelection(),
    checkVersion: () => binaryManager.checkActiveVersion(),
    sync: (payload) => run('sync', payload),
    pull: (payload) => run('pull', payload),
    ensureConfigured,
    configureInBackground,
    invalidateConfiguration
  };
}

module.exports = { createRcloneService };
