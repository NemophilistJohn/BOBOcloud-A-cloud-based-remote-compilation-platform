const fs = require('fs');
const path = require('path');
const aiSettingsSchema = require('../src/ai-settings-schema');
const {
  normalizeCacheMode: normalizeClientCacheMode,
  normalizeCacheSizeMiB: normalizeClientCacheSizeMiB
} = require('../client-analysis-cache');
const {
  createBootstrapServerSettings,
  getBootstrapResourcePath
} = require('./server-settings-bootstrap');
const { readJsonFileSync, writeJsonAtomicSync } = require('./atomic-file');
const { createSecretCodec } = require('./secret-codec');

const STORAGE_LIMITS = Object.freeze({
  server: 128 * 1024,
  lsp: 64 * 1024,
  auth: 2 * 1024 * 1024,
  ai: 4 * 1024 * 1024,
  diagnostics: 256 * 1024,
  chatHistory: 16 * 1024 * 1024,
  projectNames: 2 * 1024 * 1024,
  recentWorkspaces: 128 * 1024
});

const DEFAULT_SERVER_SETTINGS = Object.freeze({
  ip: '',
  user: '',
  pass: '',
  apiKey: '',
	secureTransport: false,
	httpPort: 3100,
	wsPort: 3101,
	dapChildWsPort: 3102,
	certificateFingerprint: '',
	certificateFingerprints: [],
  syncInterval: 30000,
  setupCompleted: false
});

function normalizeClientCacheDependencyIndexEnabled(value, mode, sizeMiB) {
  return value === true && mode === 'active' && Number(sizeMiB) >= 30;
}

function defaultDiagnosticsSettings() {
  return {
    enabled: true,
    checkOn: 'type',
    debounceMs: 300,
    checks: {
      missingSemicolon: { enabled: true, severity: 'error' },
      strayTokens: { enabled: true, severity: 'error' },
      unmatchedBrackets: { enabled: true, severity: 'error' },
      unclosedStrings: { enabled: true, severity: 'error' },
      assignmentInCondition: { enabled: true, severity: 'warning' },
      unsafeFunctions: { enabled: true, severity: 'warning' },
      trailingWhitespace: { enabled: true, severity: 'warning' },
      mixedIndent: { enabled: true, severity: 'warning' },
      longLines: { enabled: true, severity: 'info', maxLineLength: 120 },
      todoComments: { enabled: true, severity: 'info' },
      cppModernize: { enabled: true, severity: 'info' },
      styleHints: { enabled: true, severity: 'warning' }
    }
  };
}

function createSettingsStore(options) {
  const app = options.app;
  const secretCodec = createSecretCodec(options.safeStorage);
  const userDataPath = app.getPath('userData');
  const paths = Object.freeze({
    server: path.join(userDataPath, 'server-settings.json'),
    ai: path.join(userDataPath, 'ai-settings.json'),
    diagnostics: path.join(userDataPath, 'diagnostics-settings.json'),
    windowState: path.join(userDataPath, 'window-state.json'),
    chatHistory: path.join(userDataPath, 'chat-history.json'),
    auth: path.join(userDataPath, 'auth.json'),
    lsp: path.join(userDataPath, 'lsp-settings.json'),
    projectNames: path.join(userDataPath, 'project-names.json'),
    recentWorkspaces: path.join(userDataPath, 'recent-workspaces.json'),
    clientAnalysisCache: path.join(userDataPath, 'client-analysis-cache')
  });

  function normalizeServerSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const normalized = Object.assign({}, DEFAULT_SERVER_SETTINGS, source);
    // Executable selection is privileged main-process state. Never preserve
    // the legacy renderer-writable path field while migrating old profiles.
    delete normalized.rclonePath;
    delete normalized.rcloneBinary;
		for (const [field, fallback] of [['httpPort', 3100], ['wsPort', 3101], ['dapChildWsPort', 3102]]) {
			const port = Number(normalized[field]);
			normalized[field] = Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
		}
		normalized.secureTransport = normalized.secureTransport === true;
		const fingerprints = [];
		if (normalized.certificateFingerprint) fingerprints.push(normalized.certificateFingerprint);
		if (Array.isArray(source.certificateFingerprints)) fingerprints.push(...source.certificateFingerprints);
		normalized.certificateFingerprints = [...new Set(fingerprints
			.map((fingerprint) => String(fingerprint || '').trim())
			.filter(Boolean))].slice(0, 4);
		normalized.certificateFingerprint = normalized.certificateFingerprints[0] || '';
    normalized.setupCompleted = source.setupCompleted === true ||
      (source.setupCompleted === undefined && Boolean(source.ip));
    normalized.firstRunRequired = !normalized.setupCompleted &&
      (app.isPackaged || process.env.BOBO_FORCE_FIRST_RUN === '1');
    return normalized;
  }

  function readBundledServerSettings() {
    const configuredPath = options.bundledServerSettingsPath;
    const resourcePath = configuredPath || (app.isPackaged
      ? getBootstrapResourcePath(options.resourcesPath || process.resourcesPath)
      : '');
    if (!resourcePath || !fs.existsSync(resourcePath)) return null;

    try {
      const bootstrap = createBootstrapServerSettings(readJsonFileSync(resourcePath, { maxBytes: STORAGE_LIMITS.server }));
      if (!bootstrap) {
        console.error('[server-settings] bundled bootstrap configuration is missing a server address or SSH account');
        return null;
      }
      return bootstrap;
    } catch (error) {
      console.error('[server-settings] could not read bundled bootstrap configuration:', error.message);
      return null;
    }
  }

  async function readServerSettings() {
    try {
      if (fs.existsSync(paths.server)) {
        const persisted = readJsonFileSync(paths.server, { maxBytes: STORAGE_LIMITS.server });
        const stored = secretCodec.open(persisted);
        const settings = normalizeServerSettings(stored);
        if (Object.prototype.hasOwnProperty.call(stored, 'rclonePath') ||
            Object.prototype.hasOwnProperty.call(stored, 'rcloneBinary') ||
            (secretCodec.available() && !secretCodec.isSealed(persisted))) {
          const migrated = Object.assign({}, settings);
          delete migrated.firstRunRequired;
          try {
            writeJsonAtomicSync(paths.server, secretCodec.seal(migrated), { maxBytes: STORAGE_LIMITS.server });
          } catch (error) {
            console.error('Error migrating server settings:', error);
          }
        }
        return settings;
      }
      const bundled = readBundledServerSettings();
      if (bundled) {
        const seeded = normalizeServerSettings(bundled);
        const saved = await writeServerSettings(seeded);
        if (!saved) console.error('[server-settings] could not persist bundled bootstrap configuration');
        return seeded;
      }
      const defaults = { ...DEFAULT_SERVER_SETTINGS };
      fs.mkdirSync(path.dirname(paths.server), { recursive: true });
      writeJsonAtomicSync(paths.server, defaults, { maxBytes: STORAGE_LIMITS.server });
      return normalizeServerSettings(defaults);
    } catch (error) {
      console.error('Error reading server settings:', error);
      return normalizeServerSettings(DEFAULT_SERVER_SETTINGS);
    }
  }

  async function writeServerSettings(settings) {
    try {
      const persisted = normalizeServerSettings(settings);
      delete persisted.firstRunRequired;
      persisted.setupCompleted = persisted.setupCompleted === true;
      fs.mkdirSync(path.dirname(paths.server), { recursive: true });
      writeJsonAtomicSync(paths.server, secretCodec.seal(persisted), { maxBytes: STORAGE_LIMITS.server });
      return true;
    } catch (error) {
      console.error('Error writing server settings:', error);
      return false;
    }
  }

  function readLspSettings() {
    try {
      const parsed = readJsonFileSync(paths.lsp, { maxBytes: STORAGE_LIMITS.lsp });
      if (parsed && typeof parsed === 'object') {
        const clientCacheMode = normalizeClientCacheMode(parsed.clientCacheMode);
        const clientCacheSizeMiB = normalizeClientCacheSizeMiB(parsed.clientCacheSizeMiB);
        return {
          mode: ['local', 'standard', 'full'].includes(parsed.mode) ? parsed.mode : 'local',
          clientCacheMode,
          clientCacheSizeMiB,
          clientCacheDependencyIndexEnabled: normalizeClientCacheDependencyIndexEnabled(
            parsed.clientCacheDependencyIndexEnabled,
            clientCacheMode,
            clientCacheSizeMiB
          )
        };
      }
    } catch (_) {}
    return { mode: 'local', clientCacheMode: 'lazy', clientCacheSizeMiB: 32, clientCacheDependencyIndexEnabled: false };
  }

  function writeLspSettings(settings) {
    const current = readLspSettings();
    const mode = settings && ['local', 'standard', 'full'].includes(settings.mode) ? settings.mode : current.mode;
    const clientCacheMode = normalizeClientCacheMode(settings && Object.prototype.hasOwnProperty.call(settings, 'clientCacheMode')
      ? settings.clientCacheMode
      : current.clientCacheMode);
    const clientCacheSizeMiB = normalizeClientCacheSizeMiB(settings && Object.prototype.hasOwnProperty.call(settings, 'clientCacheSizeMiB')
      ? settings.clientCacheSizeMiB
      : current.clientCacheSizeMiB);
    const clientCacheDependencyIndexEnabled = normalizeClientCacheDependencyIndexEnabled(
      settings && Object.prototype.hasOwnProperty.call(settings, 'clientCacheDependencyIndexEnabled')
        ? settings.clientCacheDependencyIndexEnabled
        : current.clientCacheDependencyIndexEnabled,
      clientCacheMode,
      clientCacheSizeMiB
    );
    const next = { mode, clientCacheMode, clientCacheSizeMiB, clientCacheDependencyIndexEnabled };
    writeJsonAtomicSync(paths.lsp, next, { maxBytes: STORAGE_LIMITS.lsp });
    return next;
  }

  function readAuth() {
    try {
      if (fs.existsSync(paths.auth)) {
        const persisted = readJsonFileSync(paths.auth, { maxBytes: STORAGE_LIMITS.auth });
        const data = secretCodec.open(persisted);
        if (data && typeof data === 'object') {
          if (!data.servers || typeof data.servers !== 'object') data.servers = {};
          if (secretCodec.available() && !secretCodec.isSealed(persisted)) {
            try {
              writeJsonAtomicSync(paths.auth, secretCodec.seal(data), { maxBytes: STORAGE_LIMITS.auth });
            } catch (error) {
              console.error('Error migrating auth file:', error);
            }
          }
          return data;
        }
      }
    } catch (error) {
      console.error('Error reading auth file:', error);
    }
    return { servers: {} };
  }

  function writeAuth(data) {
    try {
      writeJsonAtomicSync(paths.auth, secretCodec.seal(data), { maxBytes: STORAGE_LIMITS.auth });
      return true;
    } catch (error) {
      console.error('Error writing auth file:', error);
      return false;
    }
  }

  function readAiSettings() {
    let stored = {};
    let persisted = null;
    let readable = true;
    try {
      if (fs.existsSync(paths.ai)) {
        persisted = readJsonFileSync(paths.ai, { maxBytes: STORAGE_LIMITS.ai });
        stored = secretCodec.open(persisted);
      }
    } catch (error) {
      readable = false;
      console.error('Error reading AI settings:', error);
    }
    const settings = aiSettingsSchema.normalizeSettings(stored);
    if (readable && (!aiSettingsSchema.settingsEqual(stored, settings) ||
        stored.schemaVersion !== aiSettingsSchema.SCHEMA_VERSION ||
        (persisted && secretCodec.available() && !secretCodec.isSealed(persisted)))) {
      try {
        writeJsonAtomicSync(paths.ai, secretCodec.seal(settings), { maxBytes: STORAGE_LIMITS.ai });
      } catch (error) {
        console.error('Error migrating AI settings:', error);
      }
    }
    return settings;
  }

  function writeAiSettings(settings) {
    try {
      const normalized = aiSettingsSchema.normalizeSettings(settings);
      writeJsonAtomicSync(paths.ai, secretCodec.seal(normalized), { maxBytes: STORAGE_LIMITS.ai });
      return true;
    } catch (error) {
      console.error('Error writing AI settings:', error);
      return false;
    }
  }

  function readDiagnosticsSettings() {
    try {
      if (fs.existsSync(paths.diagnostics)) {
        const raw = readJsonFileSync(paths.diagnostics, { maxBytes: STORAGE_LIMITS.diagnostics });
        const merged = defaultDiagnosticsSettings();
        if (typeof raw.enabled === 'boolean') merged.enabled = raw.enabled;
        if (typeof raw.checkOn === 'string') merged.checkOn = raw.checkOn;
        if (typeof raw.debounceMs === 'number') merged.debounceMs = raw.debounceMs;
        if (raw.checks && typeof raw.checks === 'object') {
          for (const id in raw.checks) {
            if (!merged.checks[id] || !raw.checks[id]) continue;
            if (typeof raw.checks[id].enabled === 'boolean') merged.checks[id].enabled = raw.checks[id].enabled;
            if (typeof raw.checks[id].severity === 'string') merged.checks[id].severity = raw.checks[id].severity;
            if (typeof raw.checks[id].maxLineLength === 'number') merged.checks[id].maxLineLength = raw.checks[id].maxLineLength;
          }
        }
        return merged;
      }
    } catch (error) {
      console.error('Error reading diagnostics settings:', error);
    }
    return defaultDiagnosticsSettings();
  }

  function writeDiagnosticsSettings(settings) {
    try {
      writeJsonAtomicSync(paths.diagnostics, settings, { maxBytes: STORAGE_LIMITS.diagnostics });
      return true;
    } catch (error) {
      console.error('Error writing diagnostics settings:', error);
      return false;
    }
  }

  function readChatHistory(workspaceRoot) {
    if (!workspaceRoot) return { messages: [], referencedFiles: [] };
    try {
      if (fs.existsSync(paths.chatHistory)) {
        const all = readJsonFileSync(paths.chatHistory, { maxBytes: STORAGE_LIMITS.chatHistory });
        return all[workspaceRoot] || { messages: [], referencedFiles: [] };
      }
    } catch (error) {
      console.error('Error reading chat history:', error);
    }
    return { messages: [], referencedFiles: [] };
  }

  function writeChatHistory(workspaceRoot, data) {
    if (!workspaceRoot) return false;
    try {
      let all = {};
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 4 * 1024 * 1024) return false;
      if (fs.existsSync(paths.chatHistory)) all = readJsonFileSync(paths.chatHistory, { maxBytes: STORAGE_LIMITS.chatHistory });
      delete all[workspaceRoot];
      all[workspaceRoot] = data;
      const roots = Object.keys(all);
      while (roots.length > 32) delete all[roots.shift()];
      writeJsonAtomicSync(paths.chatHistory, all, { maxBytes: STORAGE_LIMITS.chatHistory });
      return true;
    } catch (error) {
      console.error('Error writing chat history:', error);
      return false;
    }
  }

  function readProjectNames() {
    try {
      if (fs.existsSync(paths.projectNames)) return readJsonFileSync(paths.projectNames, { maxBytes: STORAGE_LIMITS.projectNames });
    } catch (error) {
      console.error('read-project-names:', error);
    }
    return {};
  }

  function saveProjectName(key, name) {
    if (!key || !name) return false;
    try {
      const data = readProjectNames();
      data[key] = name;
      writeJsonAtomicSync(paths.projectNames, data, { maxBytes: STORAGE_LIMITS.projectNames });
      return true;
    } catch (error) {
      console.error('save-project-name:', error);
      return false;
    }
  }

  function readRecentWorkspaces() {
    try {
      const values = readJsonFileSync(paths.recentWorkspaces, { maxBytes: STORAGE_LIMITS.recentWorkspaces });
      if (!Array.isArray(values)) return [];
      return values.filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 4096).slice(0, 5);
    } catch (_) {
      return [];
    }
  }

  function rememberRecentWorkspace(workspacePath) {
    if (typeof workspacePath !== 'string' || !workspacePath || workspacePath.length > 4096) return false;
    const compare = process.platform === 'win32'
      ? (value) => value.toLowerCase()
      : (value) => value;
    const key = compare(workspacePath);
    const values = readRecentWorkspaces().filter((value) => compare(value) !== key);
    values.unshift(workspacePath);
    writeJsonAtomicSync(paths.recentWorkspaces, values.slice(0, 5), { maxBytes: STORAGE_LIMITS.recentWorkspaces });
    return true;
  }

  function forgetRecentWorkspace(workspacePath) {
    if (typeof workspacePath !== 'string' || !workspacePath) return false;
    const compare = process.platform === 'win32'
      ? (value) => value.toLowerCase()
      : (value) => value;
    const key = compare(workspacePath);
    const values = readRecentWorkspaces().filter((value) => compare(value) !== key);
    writeJsonAtomicSync(paths.recentWorkspaces, values, { maxBytes: STORAGE_LIMITS.recentWorkspaces });
    return true;
  }

  return {
    paths,
    readServerSettings,
    writeServerSettings,
    readLspSettings,
    writeLspSettings,
    readAuth,
    writeAuth,
    readAiSettings,
    writeAiSettings,
    readDiagnosticsSettings,
    writeDiagnosticsSettings,
    readChatHistory,
    writeChatHistory,
    readProjectNames,
    saveProjectName,
    readRecentWorkspaces,
    rememberRecentWorkspace,
    forgetRecentWorkspace
  };
}

module.exports = { createSettingsStore, defaultDiagnosticsSettings };
