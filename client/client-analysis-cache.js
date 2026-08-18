'use strict';

// A deliberately small, local-only cache for remote completion candidates and
// sanitized dependency API summaries. It is not a source index: paths,
// diagnostics, edits, resolve payloads and arbitrary source text never enter
// this store. The renderer supplies an opaque key while the main process
// derives the user/server namespace before reaching here.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const CACHE_VERSION = 1;
const CACHE_ACCOUNTING_VERSION = 2;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_KEY_LENGTH = 160;
const RECORD_FILE_EXTENSION = '.json';
const MANIFEST_ENTRY_OVERHEAD_BYTES = 2;
const MEBIBYTE = 1024 * 1024;
const MIN_CACHE_SIZE_MIB = 1;
const MAX_CACHE_SIZE_MIB = 1024;
const DEFAULT_CACHE_SIZE_MIB = 32;
const COMPLETION_RECORD_TYPE = 'completion';
const DEPENDENCY_INDEX_RECORD_TYPE = 'dependency-index';
const DEPENDENCY_INDEX_SCHEMA = 'dependency-api-index-v1';
const MIN_DEPENDENCY_INDEX_SIZE_MIB = 30;
const DEPENDENCY_INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEPENDENCY_INDEX_BYTES = 64 * MEBIBYTE;
const DEPENDENCY_INDEX_QUOTA_RATIO = 0.75;
const MAX_DEPENDENCY_INDEX_ROOTS = 64;
const MAX_DEPENDENCY_INDEX_MODULES = 2048;
const MAX_DEPENDENCY_INDEX_MEMBERS = 16384;
const MAX_DEPENDENCY_INDEX_DEPTH = 8;
const MAX_DEPENDENCY_INDEX_NAME_LENGTH = 160;
const MAX_DEPENDENCY_INDEX_DETAIL_LENGTH = 480;

function normalizeRecordType(value, allowLegacy) {
  if ((allowLegacy && !value) || value === COMPLETION_RECORD_TYPE) return COMPLETION_RECORD_TYPE;
  if (value === DEPENDENCY_INDEX_RECORD_TYPE) return DEPENDENCY_INDEX_RECORD_TYPE;
  return null;
}

function isDependencyIndexRecordType(value) {
  return normalizeRecordType(value, false) === DEPENDENCY_INDEX_RECORD_TYPE;
}

function recordTypePriority(value) {
  // Dependency summaries are derived performance data. When cache pressure
  // occurs, release those larger snapshots before normal completion hints.
  return isDependencyIndexRecordType(value) ? 0 : 1;
}

function normalizeCacheMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  // Settings written by the previous cache UI keep their intent: session was
  // conservative/cache-first, while persistent used SWR remote validation.
  if (mode === 'session') return 'lazy';
  if (mode === 'persistent') return 'active';
  return ['off', 'lazy', 'active'].includes(mode) ? mode : 'lazy';
}

function normalizeCacheSizeMiB(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return DEFAULT_CACHE_SIZE_MIB;
  return Math.min(MAX_CACHE_SIZE_MIB, Math.max(MIN_CACHE_SIZE_MIB, Math.round(size)));
}

function createCachePolicy(mode, sizeMiB) {
  const normalizedMode = normalizeCacheMode(mode);
  const normalizedSizeMiB = normalizeCacheSizeMiB(sizeMiB);
  if (normalizedMode === 'off') {
    return {
      mode: 'off',
      sizeMiB: normalizedSizeMiB,
      persistent: false,
      quotaBytes: 0,
      scopeQuotaBytes: 0,
      maxEntries: 0,
      maxScopeEntries: 0,
      maxRecordBytes: 0,
      maxItems: 0,
      ttlMs: 0,
      cleanup: 'immediate',
      refreshStrategy: 'disabled'
    };
  }

  const quotaBytes = normalizedSizeMiB * MEBIBYTE;
  // The slider is a real usable cache limit for the current project. A
  // per-workspace cap below this value would make a 1024 MiB choice silently
  // behave like a much smaller cache for users who primarily work in one
  // repository. The global LRU remains the shared cap across workspaces.
  const scopeQuotaBytes = quotaBytes;
  const maxEntries = Math.min(100000, Math.max(128, Math.floor(quotaBytes / (4 * 1024))));
  const maxScopeEntries = maxEntries;
  const isLazy = normalizedMode === 'lazy';
  return {
    mode: normalizedMode,
    sizeMiB: normalizedSizeMiB,
    persistent: true,
    quotaBytes: quotaBytes,
    scopeQuotaBytes: scopeQuotaBytes,
    maxEntries: maxEntries,
    maxScopeEntries: maxScopeEntries,
    maxRecordBytes: isLazy ? 12 * 1024 : 24 * 1024,
    maxItems: isLazy ? 24 : 50,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    cleanup: 'ttl-lru',
    // The renderer decides when it is safe to issue a remote request. Lazy
    // hits are cache-first and only refresh on a miss or an explicit analysis
    // invalidation; they are never made stale merely because time elapsed.
    refreshStrategy: isLazy ? 'on-miss-or-invalidation' : 'stale-while-revalidate'
  };
}

function createDependencyIndexPolicy(policy) {
  const raw = policy && typeof policy === 'object' ? policy : {};
  // Public sanitizers can be used directly with a settings-shaped policy,
  // whereas cache internals pass a fully calculated policy with overrides.
  const source = Number.isFinite(Number(raw.quotaBytes))
    ? raw
    : Object.assign(createCachePolicy(raw.mode || 'off', raw.sizeMiB), raw);
  const quotaBytes = Math.max(0, Number(source.quotaBytes) || 0);
  const enabled = source.mode === 'active' && source.dependencyIndexEnabled === true &&
    Number(source.sizeMiB) >= MIN_DEPENDENCY_INDEX_SIZE_MIB && quotaBytes > 0;
  const indexQuotaBytes = enabled
    ? Math.min(MAX_DEPENDENCY_INDEX_BYTES, Math.floor(quotaBytes * DEPENDENCY_INDEX_QUOTA_RATIO))
    : 0;
  return {
    enabled: enabled,
    quotaBytes: indexQuotaBytes,
    // Individual trees remain bounded even when the user allocates a large
    // cache. This prevents one library from consuming the whole API snapshot
    // allowance and keeps an index response cheap to rehydrate.
    maxRecordBytes: Math.min(indexQuotaBytes, 8 * MEBIBYTE),
    ttlMs: DEPENDENCY_INDEX_TTL_MS
  };
}

const DEFAULT_POLICIES = Object.freeze({
  off: Object.freeze(createCachePolicy('off', DEFAULT_CACHE_SIZE_MIB)),
  lazy: Object.freeze(createCachePolicy('lazy', DEFAULT_CACHE_SIZE_MIB)),
  active: Object.freeze(createCachePolicy('active', DEFAULT_CACHE_SIZE_MIB)),
  // Exported aliases retain compatibility for integrations that imported the
  // old policy constants, without exposing legacy modes through settings.
  session: Object.freeze(createCachePolicy('lazy', DEFAULT_CACHE_SIZE_MIB)),
  persistent: Object.freeze(createCachePolicy('active', DEFAULT_CACHE_SIZE_MIB))
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(function(key) {
    return JSON.stringify(key) + ':' + stableJson(value[key]);
  }).join(',') + '}';
}

function safeOpaqueValue(value, name, options) {
  const config = options || {};
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const maxLength = Number(config.maxLength) || MAX_IDENTIFIER_LENGTH;
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw new Error('Invalid ' + name);
  }
  if (config.identifier && !/^[A-Za-z0-9][A-Za-z0-9._:@+\-]*$/.test(text)) {
    throw new Error('Invalid ' + name);
  }
  return text;
}

function normalizeLanguageId(value) {
  return safeOpaqueValue(String(value || '').toLowerCase(), 'language identity', { identifier: true, maxLength: 64 });
}

function normalizeRuntimeId(value) {
  return safeOpaqueValue(value || 'local', 'runtime identity', { identifier: true, maxLength: 128 });
}

function normalizeScope(rawScope) {
  const raw = rawScope && typeof rawScope === 'object' ? rawScope : {};
  const workspace = raw.workspace && typeof raw.workspace === 'object' ? raw.workspace : {};
  const serverId = safeOpaqueValue(raw.serverId || 'local-profile', 'server identity', { maxLength: MAX_IDENTIFIER_LENGTH });
  const userId = safeOpaqueValue(raw.userId || 'local-profile', 'user identity', { maxLength: MAX_IDENTIFIER_LENGTH });
  const kind = String(workspace.kind || '').toLowerCase();
  let normalizedWorkspace;
  let teamHash = '';
  if (kind === 'team') {
    normalizedWorkspace = {
      kind: 'team',
      teamId: safeOpaqueValue(workspace.teamId, 'team identity', { identifier: true }),
      projectId: safeOpaqueValue(workspace.projectId, 'project identity', { identifier: true }),
      // Git branch names may legitimately contain '/', but they remain data
      // inside a hash and are never used as a filesystem path.
      branch: safeOpaqueValue(workspace.branch, 'branch identity')
    };
    teamHash = sha256(stableJson({ serverId: serverId, userId: userId, kind: 'team', teamId: normalizedWorkspace.teamId }));
  } else if (kind === 'personal') {
    normalizedWorkspace = {
      kind: 'personal',
      folderKey: safeOpaqueValue(workspace.folderKey, 'workspace identity', { identifier: true })
    };
  } else {
    throw new Error('Invalid workspace cache identity');
  }
  const normalized = {
    version: CACHE_VERSION,
    serverId: serverId,
    userId: userId,
    workspace: normalizedWorkspace,
    languageId: normalizeLanguageId(raw.languageId),
    runtimeId: normalizeRuntimeId(raw.runtimeId),
    dependencyRevision: safeOpaqueValue(raw.dependencyRevision || 'unknown', 'dependency revision', { maxLength: MAX_IDENTIFIER_LENGTH })
  };
  const workspaceHash = sha256(stableJson({
    version: CACHE_VERSION,
    serverId: serverId,
    userId: userId,
    workspace: normalizedWorkspace
  }));
  return Object.freeze({
    value: Object.freeze(normalized),
    scopeHash: sha256(stableJson(normalized)),
    workspaceHash: workspaceHash,
    teamHash: teamHash
  });
}

function normalizeCacheKey(rawKey) {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  // Renderer keys must be opaque digests, never source text, URIs or file paths.
  if (!key || key.length > MAX_KEY_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._:@+\-]*$/.test(key)) {
    throw new Error('Invalid local analysis cache key');
  }
  return sha256(key);
}

function truncateText(value, limit) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/[\0\r\n]/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function singleLineText(value, limit) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  // A cached completion is rehydrated into the active word range. Multiline
  // edits cannot be safely replayed that way, and should stay authoritative
  // on the remote LSP instead of being flattened into a different edit.
  if (/[\0\r\n]/.test(text)) return null;
  return truncateText(text, limit);
}

function sanitizeCommitCharacters(value) {
  if (!Array.isArray(value)) return undefined;
  const result = [];
  value.forEach(function(character) {
    const clean = truncateText(character, 2);
    if (clean.length === 1 && result.indexOf(clean) < 0 && result.length < 16) result.push(clean);
  });
  return result.length ? result : undefined;
}

function sanitizeCompletionItem(item) {
  if (!item || typeof item !== 'object') return null;
  // Any edit-bearing candidate must remain authoritative on the remote LSP.
  // A cache hint is always rehydrated into the current word range, so even a
  // seemingly simple textEdit could be wrong after the document changes.
  if (item.textEdit || item.additionalTextEdits || item.command || item.data) return null;
  const label = truncateText(item.label, 320);
  if (!label) return null;
  const rawInsertText = typeof item.insertText === 'string' ? item.insertText : label;
  const insertText = singleLineText(rawInsertText, 1200);
  if (!insertText) return null;
  const candidate = {
    label: label,
    kind: Math.max(1, Math.min(25, Math.floor(Number(item.kind) || 1))),
    insertText: insertText,
    detail: truncateText(item.detail, 500),
    filterText: truncateText(item.filterText || label, 320),
    sortText: truncateText(item.sortText || label, 320)
  };
  if (!candidate.insertText) candidate.insertText = label;
  if (Number(item.insertTextFormat) === 2) candidate.insertTextFormat = 2;
  const commitCharacters = sanitizeCommitCharacters(item.commitCharacters);
  if (commitCharacters) candidate.commitCharacters = commitCharacters;
  // Do not retain documentation, edit ranges, tags or resolve payloads.
  return candidate;
}

function sanitizeCompletionItems(rawValue, policy) {
  const source = Array.isArray(rawValue) ? { items: rawValue } : rawValue;
  if (!source || typeof source !== 'object' || source.isIncomplete === true) return null;
  const items = Array.isArray(source.items) ? source.items : [];
  const result = { items: [] };
  const maxItems = Math.max(1, Number(policy && policy.maxItems) || DEFAULT_POLICIES.persistent.maxItems);
  const maxBytes = Math.max(1024, Number(policy && policy.maxRecordBytes) || DEFAULT_POLICIES.persistent.maxRecordBytes);
  for (let index = 0; index < items.length && result.items.length < maxItems; index += 1) {
    const sanitized = sanitizeCompletionItem(items[index]);
    if (!sanitized) continue;
    result.items.push(sanitized);
    if (byteLength(result) > maxBytes) {
      result.items.pop();
      break;
    }
  }
  return result.items.length ? result : null;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacters(value) {
  return /[\0-\x1f\x7f]/.test(value);
}

function isPathLikeValue(value) {
  // Details are summaries rather than documentation. Reject every path
  // separator instead of trying to recognize all platform-specific path
  // variants; callers can simply omit a detail that contains one.
  return /[\\/]/.test(value);
}

function sanitizeDependencyIndexName(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_DEPENDENCY_INDEX_NAME_LENGTH || hasControlCharacters(text) || /[\\/]/.test(text)) return null;
  // Store one public name per node. Its characters vary by language (for
  // example, C++ `operator[]` and C# `~Type`), so reject whitespace and paths
  // rather than imposing a Python-shaped identifier grammar.
  if (/\s/.test(text)) return null;
  return text;
}

function sanitizeDependencyIndexDetail(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (hasControlCharacters(text) || isPathLikeValue(text)) return null;
  return text.length > MAX_DEPENDENCY_INDEX_DETAIL_LENGTH ? text.slice(0, MAX_DEPENDENCY_INDEX_DETAIL_LENGTH) : text;
}

function sanitizeDependencyIndexKind(value, fallback) {
  if (value === undefined) return fallback || '';
  if (typeof value !== 'string') return null;
  const kind = value.trim().toLowerCase();
  return ['module', 'namespace', 'class', 'interface', 'function', 'method', 'property', 'field', 'variable', 'constant', 'type', 'enum', 'alias'].includes(kind)
    ? kind
    : null;
}

function rejectUnexpectedKeys(value, allowedKeys) {
  return Object.keys(value).every(function(key) { return allowedKeys.indexOf(key) >= 0; });
}

function sanitizeDependencyIndexMember(rawMember, counters) {
  if (!isPlainRecord(rawMember) || !rejectUnexpectedKeys(rawMember, ['name', 'kind', 'detail'])) return null;
  const name = sanitizeDependencyIndexName(rawMember.name);
  const kind = sanitizeDependencyIndexKind(rawMember.kind);
  const detail = sanitizeDependencyIndexDetail(rawMember.detail);
  if (!name || !kind || detail === null || counters.members >= MAX_DEPENDENCY_INDEX_MEMBERS) return null;
  counters.members += 1;
  const member = { name: name, kind: kind };
  if (detail) member.detail = detail;
  return member;
}

function sanitizeDependencyIndexNode(rawNode, counters, depth, isRoot) {
  if (!isPlainRecord(rawNode) || depth > MAX_DEPENDENCY_INDEX_DEPTH ||
      !rejectUnexpectedKeys(rawNode, ['name', 'kind', 'detail', 'members', 'modules'])) return null;
  const name = sanitizeDependencyIndexName(rawNode.name);
  const kind = sanitizeDependencyIndexKind(rawNode.kind, 'module');
  const detail = sanitizeDependencyIndexDetail(rawNode.detail);
  const members = rawNode.members === undefined ? [] : rawNode.members;
  const modules = rawNode.modules === undefined ? [] : rawNode.modules;
  if (!name || !kind || detail === null || !Array.isArray(members) || !Array.isArray(modules) ||
      members.length > MAX_DEPENDENCY_INDEX_MEMBERS || modules.length > MAX_DEPENDENCY_INDEX_MODULES ||
      (!isRoot && counters.modules >= MAX_DEPENDENCY_INDEX_MODULES)) return null;
  if (kind !== 'module' && kind !== 'namespace') return null;
  if (!isRoot) counters.modules += 1;
  const node = { name: name, kind: kind };
  if (detail) node.detail = detail;
  if (members.length) {
    node.members = [];
    for (let index = 0; index < members.length; index += 1) {
      const member = sanitizeDependencyIndexMember(members[index], counters);
      if (!member) return null;
      node.members.push(member);
    }
  }
  if (modules.length) {
    node.modules = [];
    for (let index = 0; index < modules.length; index += 1) {
      const child = sanitizeDependencyIndexNode(modules[index], counters, depth + 1, false);
      if (!child) return null;
      node.modules.push(child);
    }
  }
  return node;
}

function sanitizeDependencyIndex(rawValue, policy) {
  const indexPolicy = createDependencyIndexPolicy(policy);
  if (!indexPolicy.enabled || !isPlainRecord(rawValue) || !rejectUnexpectedKeys(rawValue, ['schema', 'roots']) ||
      rawValue.schema !== DEPENDENCY_INDEX_SCHEMA || !Array.isArray(rawValue.roots) ||
      !rawValue.roots.length || rawValue.roots.length > MAX_DEPENDENCY_INDEX_ROOTS) return null;
  const counters = { modules: 0, members: 0 };
  const value = { schema: DEPENDENCY_INDEX_SCHEMA, roots: [] };
  for (let index = 0; index < rawValue.roots.length; index += 1) {
    const root = sanitizeDependencyIndexNode(rawValue.roots[index], counters, 1, true);
    if (!root) return null;
    value.roots.push(root);
    if (byteLength(value) > indexPolicy.maxRecordBytes) return null;
  }
  return value;
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function defaultManifest() {
  return {
    version: CACHE_VERSION,
    accountingVersion: CACHE_ACCOUNTING_VERSION,
    updatedAt: 0,
    lastPrunedAt: 0,
    lastQuotaBytes: 0,
    entries: {}
  };
}

class ClientAnalysisCache {
  constructor(options) {
    const config = options || {};
    this.baseDir = path.resolve(config.baseDir || config.userDataPath || path.join(os.tmpdir(), 'bobocloud-client-analysis-cache'));
    this.recordsDir = path.join(this.baseDir, 'records');
    this.manifestPath = path.join(this.baseDir, 'manifest.json');
    this.now = typeof config.now === 'function' ? config.now : Date.now;
    // Policy overrides exist for tests and future product tiers. Runtime
    // quotas are derived from the current user-selected size, so defaults are
    // generated by policy() rather than copied into this map.
    this.policies = Object.assign({}, config.policies || {});
    this.sessionEntries = new Map();
    this.sessionBytes = 0;
    this.manifest = null;
    this.manifestLoaded = false;
    this.operation = Promise.resolve();
  }

  policy(request) {
    const options = request && typeof request === 'object' ? request : {};
    const requestedMode = typeof request === 'string' ? request : options.mode;
    const mode = normalizeCacheMode(requestedMode || 'lazy');
    const sizeMiB = normalizeCacheSizeMiB(options.sizeMiB);
    // A legacy override keyed by session/persistent still applies to its
    // migrated lazy/active policy. This preserves unit-test and extension
    // contracts while settings no longer expose the legacy names.
    const override = this.policies[mode] || this.policies[String(requestedMode || '').toLowerCase()] || {};
    const policy = Object.assign({}, createCachePolicy(mode, sizeMiB), override || {});
    policy.mode = mode;
    policy.sizeMiB = sizeMiB;
    policy.persistent = mode !== 'off';
    // The dependency API index is opt-in even inside active mode. Keep the
    // setting on the policy passed through IPC so the cache boundary cannot be
    // bypassed by a renderer-side mistake.
    policy.dependencyIndexEnabled = options.dependencyIndexEnabled === true;
    return policy;
  }

  _run(operation) {
    const next = this.operation.catch(function() {}).then(operation);
    this.operation = next.then(function() {}, function() {});
    return next;
  }

  _entryId(scopeHash, keyHash, rawType) {
    const type = normalizeRecordType(rawType, true);
    if (!type) throw new Error('Invalid cache record type');
    // Preserve completion IDs from the first cache version so existing
    // on-disk candidates remain readable after typed records are introduced.
    return type === COMPLETION_RECORD_TYPE
      ? scopeHash + ':' + keyHash
      : scopeHash + ':' + type + ':' + keyHash;
  }

  _recordPath(scopeHash, keyHash, rawType) {
    if (!/^[a-f0-9]{64}$/.test(scopeHash) || !/^[a-f0-9]{64}$/.test(keyHash)) throw new Error('Invalid cache record identity');
    const type = normalizeRecordType(rawType, true);
    if (!type) throw new Error('Invalid cache record type');
    const filename = type === COMPLETION_RECORD_TYPE
      ? keyHash + RECORD_FILE_EXTENSION
      : type + '-' + keyHash + RECORD_FILE_EXTENSION;
    return path.join(this.recordsDir, scopeHash, filename);
  }

  async _ensurePersistentStore() {
    await fsp.mkdir(this.recordsDir, { recursive: true });
  }

  async _readManifest() {
    if (this.manifestLoaded) return this.manifest;
    let manifest = defaultManifest();
    try {
      const raw = JSON.parse(await fsp.readFile(this.manifestPath, 'utf8'));
      if (raw && raw.version === CACHE_VERSION && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
        manifest = {
          version: CACHE_VERSION,
          accountingVersion: Number(raw.accountingVersion) || 1,
          updatedAt: Number(raw.updatedAt) || 0,
          lastPrunedAt: Number(raw.lastPrunedAt) || 0,
          lastQuotaBytes: Number(raw.lastQuotaBytes) || 0,
          entries: raw.entries
        };
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        // A corrupt cache should be recoverable. Do not let it affect editing.
        manifest = defaultManifest();
      }
    }
    this.manifest = manifest;
    this.manifestLoaded = true;
    return manifest;
  }

  async _atomicWriteJson(targetPath, value) {
    const parent = path.dirname(targetPath);
    await fsp.mkdir(parent, { recursive: true });
    const temp = path.join(parent, '.' + path.basename(targetPath) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
    try {
      await fsp.writeFile(temp, JSON.stringify(value), 'utf8');
      await fsp.rename(temp, targetPath);
    } finally {
      try { await fsp.unlink(temp); } catch (_) {}
    }
  }

  async _writeManifest() {
    if (!this.manifestLoaded || !this.manifest) return;
    this.manifest.updatedAt = this.now();
    await this._atomicWriteJson(this.manifestPath, this.manifest);
  }

  _entryStorageBytes(entryId, entry, recordFileBytes) {
    const metadata = Object.assign({}, entry, { bytes: 0 });
    let metadataBytes = Math.max(0, Number(recordFileBytes) || 0) + byteLength(entryId) + MANIFEST_ENTRY_OVERHEAD_BYTES;
    // `bytes` is represented in the serialized manifest entry too. Iterate to
    // a fixed point so a decimal digit boundary cannot undercount the budget.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      metadata.bytes = metadataBytes;
      const nextMetadataBytes = Math.max(0, Number(recordFileBytes) || 0) + byteLength(entryId) + byteLength(metadata) + MANIFEST_ENTRY_OVERHEAD_BYTES;
      if (nextMetadataBytes === metadataBytes) break;
      metadataBytes = nextMetadataBytes;
    }
    return metadataBytes;
  }

  async _upgradeManifestAccounting() {
    if (!this.manifest || Number(this.manifest.accountingVersion) >= CACHE_ACCOUNTING_VERSION) return false;
    for (const entryId of Object.keys(this.manifest.entries || {})) {
      const entry = this.manifest.entries[entryId];
      if (!entry || typeof entry !== 'object') continue;
      try {
        const stat = await fsp.stat(this._recordPath(entry.scopeHash, entry.keyHash, entry.type));
        const bytes = this._entryStorageBytes(entryId, entry, stat.size);
        entry.bytes = bytes;
      } catch (_) {
        delete this.manifest.entries[entryId];
      }
    }
    this.manifest.accountingVersion = CACHE_ACCOUNTING_VERSION;
    return true;
  }

  _sessionTotals(scopeHash) {
    let bytes = 0;
    let entries = 0;
    this.sessionEntries.forEach(function(entry) {
      if (entry.scopeHash === scopeHash) {
        bytes += entry.bytes;
        entries += 1;
      }
    });
    return { bytes: bytes, entries: entries };
  }

  _manifestTotals(scopeHash) {
    let bytes = 0;
    let entries = 0;
    if (!this.manifest || !this.manifest.entries) return { bytes: 0, entries: 0 };
    Object.keys(this.manifest.entries).forEach((entryId) => {
      const entry = this.manifest.entries[entryId];
      if (!scopeHash || entry.scopeHash === scopeHash) {
        bytes += Math.max(0, Number(entry.bytes) || 0);
        entries += 1;
      }
    });
    return { bytes: bytes, entries: entries };
  }

  _recordTypeTotals(scopeHash) {
    const totals = {
      completionEntries: 0,
      completionBytes: 0,
      dependencyIndexEntries: 0,
      dependencyIndexBytes: 0
    };
    const include = function(entry) { return !scopeHash || entry.scopeHash === scopeHash; };
    const add = function(entry) {
      if (!entry || !include(entry)) return;
      const bytes = Math.max(0, Number(entry.bytes) || 0);
      if (isDependencyIndexRecordType(entry.type)) {
        totals.dependencyIndexEntries += 1;
        totals.dependencyIndexBytes += bytes;
      } else {
        totals.completionEntries += 1;
        totals.completionBytes += bytes;
      }
    };
    if (this.manifest && this.manifest.entries) Object.keys(this.manifest.entries).forEach((entryId) => add(this.manifest.entries[entryId]));
    else this.sessionEntries.forEach(add);
    return totals;
  }

  _publicPolicy(policy) {
    const dependencyIndex = createDependencyIndexPolicy(policy);
    return {
      mode: policy.mode,
      quotaBytes: policy.quotaBytes,
      scopeQuotaBytes: policy.scopeQuotaBytes,
      maxEntries: policy.maxEntries,
      maxScopeEntries: policy.maxScopeEntries,
      maxRecordBytes: policy.maxRecordBytes,
      maxItems: policy.maxItems,
      ttlMs: policy.ttlMs,
      cleanup: policy.cleanup,
      sizeMiB: policy.sizeMiB,
      persistent: policy.persistent,
      refreshStrategy: policy.refreshStrategy,
      dependencyIndexEnabled: policy.dependencyIndexEnabled === true,
      dependencyIndex: dependencyIndex
    };
  }

  _publicStats(request, scope, totals, totalTotals) {
    const policy = this.policy(request);
    const typeTotals = policy.mode === 'off'
      ? { completionEntries: 0, completionBytes: 0, dependencyIndexEntries: 0, dependencyIndexBytes: 0 }
      : this._recordTypeTotals(scope ? scope.scopeHash : '');
    const allTypeTotals = policy.mode === 'off'
      ? typeTotals
      : this._recordTypeTotals();
    return {
      mode: policy.mode,
      scopeId: scope ? scope.scopeHash : '',
      entryCount: totals.entries,
      entries: totals.entries,
      sizeBytes: totals.bytes,
      bytes: totals.bytes,
      quotaBytes: policy.scopeQuotaBytes || policy.quotaBytes,
      totalEntries: totalTotals.entries,
      totalBytes: totalTotals.bytes,
      totalQuotaBytes: policy.quotaBytes,
      completionEntries: typeTotals.completionEntries,
      completionBytes: typeTotals.completionBytes,
      dependencyIndexEntries: typeTotals.dependencyIndexEntries,
      dependencyIndexBytes: typeTotals.dependencyIndexBytes,
      totalCompletionEntries: allTypeTotals.completionEntries,
      totalCompletionBytes: allTypeTotals.completionBytes,
      totalDependencyIndexEntries: allTypeTotals.dependencyIndexEntries,
      totalDependencyIndexBytes: allTypeTotals.dependencyIndexBytes,
      configuredSizeMiB: policy.sizeMiB,
      effectiveQuotaBytes: policy.quotaBytes,
      lastPrunedAt: this.manifest && this.manifest.lastPrunedAt ? this.manifest.lastPrunedAt : 0,
      policy: this._publicPolicy(policy)
    };
  }

  async _removePersistentEntry(entryId, entry) {
    if (!entry) return;
    try { await fsp.unlink(this._recordPath(entry.scopeHash, entry.keyHash, entry.type)); } catch (_) {}
    delete this.manifest.entries[entryId];
  }

  async _prunePersistent(policy, force) {
    await this._readManifest();
    const accountingUpgraded = await this._upgradeManifestAccounting();
    const now = this.now();
    const lastPrunedAt = Number(this.manifest.lastPrunedAt) || 0;
    const lastQuotaBytes = Number(this.manifest.lastQuotaBytes) || 0;
    const dependencyIndexPolicy = createDependencyIndexPolicy(policy);
    const hasDependencyIndexes = Object.keys(this.manifest.entries || {}).some((entryId) => {
      const entry = this.manifest.entries[entryId];
      return entry && isDependencyIndexRecordType(entry.type);
    });
    // Quota changes are semantic invalidations for eviction. They must not be
    // delayed by the normal hourly TTL cleanup throttle, including when a
    // profile was edited outside the UI between application launches.
    if (!force && !accountingUpgraded && lastQuotaBytes === policy.quotaBytes &&
        (!hasDependencyIndexes || dependencyIndexPolicy.enabled) && now - lastPrunedAt < 60 * 60 * 1000) return false;
    const entries = this.manifest.entries;
    const expired = [];
    Object.keys(entries).forEach((entryId) => {
      const entry = entries[entryId];
      if (!entry || !normalizeRecordType(entry.type, true) || !/^[a-f0-9]{64}$/.test(String(entry.scopeHash || '')) || !/^[a-f0-9]{64}$/.test(String(entry.keyHash || '')) ||
          !Number.isFinite(Number(entry.bytes)) || Number(entry.bytes) < 0 || (entry.expiresAt && Number(entry.expiresAt) <= now)) {
        expired.push([entryId, entry]);
      }
    });
    for (const pair of expired) await this._removePersistentEntry(pair[0], pair[1]);

    // An API index is allowed to use a meaningful share of the selected
    // capacity, but never more than its dedicated global allowance. This
    // applies after a restart and when users reduce the slider or leave active
    // mode, not only when a new index is written.
    const indexed = Object.keys(entries)
      .map((entryId) => [entryId, entries[entryId]])
      .filter(function(pair) { return pair[1] && isDependencyIndexRecordType(pair[1].type); })
      .sort(function(left, right) { return (Number(left[1].accessedAt) || 0) - (Number(right[1].accessedAt) || 0); });
    let indexBytes = indexed.reduce(function(total, pair) { return total + (Number(pair[1].bytes) || 0); }, 0);
    while (indexed.length && indexBytes > dependencyIndexPolicy.quotaBytes) {
      const pair = indexed.shift();
      indexBytes -= Number(pair[1].bytes) || 0;
      await this._removePersistentEntry(pair[0], pair[1]);
    }

    const byScope = new Map();
    Object.keys(entries).forEach((entryId) => {
      const entry = entries[entryId];
      if (!entry) return;
      const group = byScope.get(entry.scopeHash) || [];
      group.push([entryId, entry]);
      byScope.set(entry.scopeHash, group);
    });
    for (const group of byScope.values()) {
      group.sort(function(left, right) {
        const priority = recordTypePriority(left[1].type) - recordTypePriority(right[1].type);
        return priority || (Number(left[1].accessedAt) || 0) - (Number(right[1].accessedAt) || 0);
      });
      let bytes = group.reduce(function(total, pair) { return total + (Number(pair[1].bytes) || 0); }, 0);
      let count = group.length;
      while (group.length && (bytes > policy.scopeQuotaBytes || count > policy.maxScopeEntries)) {
        const pair = group.shift();
        bytes -= Number(pair[1].bytes) || 0;
        count -= 1;
        await this._removePersistentEntry(pair[0], pair[1]);
      }
    }

    const ordered = Object.keys(entries).map((entryId) => [entryId, entries[entryId]]).filter(function(pair) { return !!pair[1]; });
    ordered.sort(function(left, right) {
      const priority = recordTypePriority(left[1].type) - recordTypePriority(right[1].type);
      return priority || (Number(left[1].accessedAt) || 0) - (Number(right[1].accessedAt) || 0);
    });
    let total = ordered.reduce(function(sum, pair) { return sum + (Number(pair[1].bytes) || 0); }, 0);
    let count = ordered.length;
    while (ordered.length && (total > policy.quotaBytes || count > policy.maxEntries)) {
      const pair = ordered.shift();
      total -= Number(pair[1].bytes) || 0;
      count -= 1;
      await this._removePersistentEntry(pair[0], pair[1]);
    }
    this.manifest.lastPrunedAt = now;
    this.manifest.lastQuotaBytes = policy.quotaBytes;
    await this._writeManifest();
    return true;
  }

  _pruneSession(policy) {
    const ordered = Array.from(this.sessionEntries.entries()).sort(function(left, right) {
      const priority = recordTypePriority(left[1].type) - recordTypePriority(right[1].type);
      return priority || (Number(left[1].accessedAt) || 0) - (Number(right[1].accessedAt) || 0);
    });
    const scopeBuckets = new Map();
    ordered.forEach(function(pair) {
      const group = scopeBuckets.get(pair[1].scopeHash) || [];
      group.push(pair);
      scopeBuckets.set(pair[1].scopeHash, group);
    });
    scopeBuckets.forEach((group) => {
      let bytes = group.reduce(function(total, pair) { return total + pair[1].bytes; }, 0);
      let count = group.length;
      while (group.length && (bytes > policy.scopeQuotaBytes || count > policy.maxScopeEntries)) {
        const pair = group.shift();
        if (!this.sessionEntries.delete(pair[0])) continue;
        this.sessionBytes -= pair[1].bytes;
        bytes -= pair[1].bytes;
        count -= 1;
      }
    });
    const dependencyIndexPolicy = createDependencyIndexPolicy(policy);
    const indexed = Array.from(this.sessionEntries.entries())
      .filter(function(pair) { return isDependencyIndexRecordType(pair[1].type); })
      .sort(function(left, right) { return (Number(left[1].accessedAt) || 0) - (Number(right[1].accessedAt) || 0); });
    let indexBytes = indexed.reduce(function(total, pair) { return total + pair[1].bytes; }, 0);
    while (indexed.length && indexBytes > dependencyIndexPolicy.quotaBytes) {
      const pair = indexed.shift();
      if (!this.sessionEntries.delete(pair[0])) continue;
      this.sessionBytes -= pair[1].bytes;
      indexBytes -= pair[1].bytes;
    }
    while (this.sessionEntries.size > policy.maxEntries || this.sessionBytes > policy.quotaBytes) {
      const oldest = this.sessionEntries.entries().next().value;
      if (!oldest) break;
      this.sessionEntries.delete(oldest[0]);
      this.sessionBytes -= oldest[1].bytes;
    }
  }

  async _getTyped(rawScope, rawKey, mode, rawType, sanitizer, isEnabled) {
    const scope = normalizeScope(rawScope);
    const keyHash = normalizeCacheKey(rawKey);
    const policy = this.policy(mode);
    const type = normalizeRecordType(rawType, false);
    if (!type) throw new Error('Invalid cache record type');
    return this._run(async () => {
      if (policy.mode === 'off' || !isEnabled(policy)) return null;
      const entryId = this._entryId(scope.scopeHash, keyHash, type);
      if (!policy.persistent) {
        const entry = this.sessionEntries.get(entryId);
        if (!entry || normalizeRecordType(entry.type, true) !== type) return null;
        entry.accessedAt = this.now();
        this.sessionEntries.delete(entryId);
        this.sessionEntries.set(entryId, entry);
        return clone(entry.value);
      }
      await this._readManifest();
      const meta = this.manifest.entries[entryId];
      if (!meta || normalizeRecordType(meta.type, true) !== type) return null;
      if (meta.expiresAt && Number(meta.expiresAt) <= this.now()) {
        await this._removePersistentEntry(entryId, meta);
        await this._writeManifest();
        return null;
      }
      let record;
      try {
        record = JSON.parse(await fsp.readFile(this._recordPath(scope.scopeHash, keyHash, type), 'utf8'));
      } catch (_) {
        await this._removePersistentEntry(entryId, meta);
        await this._writeManifest();
        return null;
      }
      if (!record || record.version !== CACHE_VERSION || normalizeRecordType(record.type, true) !== type ||
          record.scopeHash !== scope.scopeHash || record.keyHash !== keyHash) {
        await this._removePersistentEntry(entryId, meta);
        await this._writeManifest();
        return null;
      }
      const value = sanitizer(record.value, policy);
      if (!value) {
        await this._removePersistentEntry(entryId, meta);
        await this._writeManifest();
        return null;
      }
      meta.accessedAt = this.now();
      return clone(value);
    });
  }

  async _putTyped(rawScope, rawKey, rawValue, mode, rawType, sanitizer, isEnabled, recordOptions) {
    const scope = normalizeScope(rawScope);
    const keyHash = normalizeCacheKey(rawKey);
    const policy = this.policy(mode);
    const type = normalizeRecordType(rawType, false);
    if (!type) throw new Error('Invalid cache record type');
    const options = recordOptions && typeof recordOptions === 'object' ? recordOptions : {};
    const enabled = policy.mode !== 'off' && isEnabled(policy);
    const value = enabled ? sanitizer(rawValue, policy) : null;
    return this._run(async () => {
      if (!enabled) return { stored: false, reason: 'disabled' };
      if (!value) return { stored: false, reason: 'invalid' };
      const now = this.now();
      const valueBytes = byteLength(value);
      const maxRecordBytes = Math.max(0, Number(options.maxRecordBytes) || Number(policy.maxRecordBytes) || 0);
      if (valueBytes > maxRecordBytes) return { stored: false, reason: 'too-large' };
      const ttlMs = Math.max(0, Number(options.ttlMs) || Number(policy.ttlMs) || 0);
      const entryId = this._entryId(scope.scopeHash, keyHash, type);
      if (!policy.persistent) {
        const previous = this.sessionEntries.get(entryId);
        if (previous) this.sessionBytes -= previous.bytes;
        this.sessionEntries.delete(entryId);
        this.sessionEntries.set(entryId, {
          type: type,
          scopeHash: scope.scopeHash,
          workspaceHash: scope.workspaceHash,
          teamHash: scope.teamHash,
          bytes: valueBytes,
          createdAt: now,
          accessedAt: now,
          value: value
        });
        this.sessionBytes += valueBytes;
        this._pruneSession(policy);
        return { stored: this.sessionEntries.has(entryId), bytes: valueBytes };
      }
      await this._ensurePersistentStore();
      await this._readManifest();
      const record = {
        version: CACHE_VERSION,
        type: type,
        scopeHash: scope.scopeHash,
        keyHash: keyHash,
        createdAt: now,
        accessedAt: now,
        expiresAt: now + ttlMs,
        value: value
      };
      // Account for the record itself and its manifest index entry. The
      // slider is a storage budget rather than merely a payload budget, so a
      // large number of small completion candidates cannot quietly exceed it.
      const recordFileBytes = byteLength(record);
      const metadata = {
        type: type,
        scopeHash: scope.scopeHash,
        workspaceHash: scope.workspaceHash,
        teamHash: scope.teamHash,
        keyHash: keyHash,
        bytes: 0,
        createdAt: now,
        accessedAt: now,
        expiresAt: record.expiresAt
      };
      metadata.bytes = this._entryStorageBytes(entryId, metadata, recordFileBytes);
      await this._atomicWriteJson(this._recordPath(scope.scopeHash, keyHash, type), record);
      this.manifest.entries[entryId] = metadata;
      await this._prunePersistent(policy, true);
      return { stored: !!this.manifest.entries[entryId], bytes: metadata.bytes };
    });
  }

  async get(rawScope, rawKey, mode) {
    return this._getTyped(rawScope, rawKey, mode, COMPLETION_RECORD_TYPE, sanitizeCompletionItems, function() { return true; });
  }

  async put(rawScope, rawKey, rawValue, mode) {
    return this._putTyped(rawScope, rawKey, rawValue, mode, COMPLETION_RECORD_TYPE, sanitizeCompletionItems, function() { return true; });
  }

  async getDependencyIndex(rawScope, rawKey, mode) {
    const policy = this.policy(mode);
    if (!createDependencyIndexPolicy(policy).enabled) {
      await this.clearDependencyIndexes({ scope: 'all' }, policy);
      return null;
    }
    return this._getTyped(rawScope, rawKey, mode, DEPENDENCY_INDEX_RECORD_TYPE, sanitizeDependencyIndex, function(policy) {
      return createDependencyIndexPolicy(policy).enabled;
    });
  }

  async putDependencyIndex(rawScope, rawKey, rawValue, mode) {
    const policy = this.policy(mode);
    const indexPolicy = createDependencyIndexPolicy(policy);
    if (!indexPolicy.enabled) {
      await this.clearDependencyIndexes({ scope: 'all' }, policy);
      return { stored: false, reason: 'disabled' };
    }
    return this._putTyped(rawScope, rawKey, rawValue, policy, DEPENDENCY_INDEX_RECORD_TYPE, sanitizeDependencyIndex, function(activePolicy) {
      return createDependencyIndexPolicy(activePolicy).enabled;
    }, indexPolicy);
  }

  async stats(rawScope, mode) {
    const policy = this.policy(mode);
    let scope = null;
    if (rawScope && typeof rawScope === 'object' && rawScope.workspace) scope = normalizeScope(rawScope);
    return this._run(async () => {
      if (policy.mode === 'off') return this._publicStats(policy, scope, { bytes: 0, entries: 0 }, { bytes: 0, entries: 0 });
      if (!policy.persistent) {
        const totals = scope ? this._sessionTotals(scope.scopeHash) : { bytes: this.sessionBytes, entries: this.sessionEntries.size };
        return this._publicStats(policy, scope, totals, { bytes: this.sessionBytes, entries: this.sessionEntries.size });
      }
      await this._readManifest();
      await this._prunePersistent(policy, false);
      const totals = scope ? this._manifestTotals(scope.scopeHash) : this._manifestTotals();
      const all = this._manifestTotals();
      return this._publicStats(policy, scope, totals, all);
    });
  }

  async _clearTyped(request, mode, rawType) {
    const policy = this.policy(mode);
    const type = rawType === undefined ? null : normalizeRecordType(rawType, false);
    if (rawType !== undefined && !type) throw new Error('Invalid cache record type');
    const raw = typeof request === 'string' ? { scope: request } : (request && typeof request === 'object' ? request : {});
    const clearScope = ['workspace', 'current', 'team', 'all'].includes(String(raw.scope || '').toLowerCase())
      ? String(raw.scope || '').toLowerCase()
      : 'workspace';
    const context = raw.context && typeof raw.context === 'object' ? normalizeScope(raw.context) : null;
    if (clearScope !== 'all' && !context) throw new Error('A cache scope is required');
    return this._run(async () => {
      let removedEntries = 0;
      let removedBytes = 0;
      const matches = function(entry) {
        if (type && normalizeRecordType(entry.type, true) !== type) return false;
        if (clearScope === 'all') return true;
        if (clearScope === 'team') return !!context.teamHash && entry.teamHash === context.teamHash;
        return entry.workspaceHash === context.workspaceHash;
      };
      for (const pair of Array.from(this.sessionEntries.entries())) {
        if (!matches(pair[1])) continue;
        this.sessionEntries.delete(pair[0]);
        this.sessionBytes -= pair[1].bytes;
        removedEntries += 1;
        removedBytes += pair[1].bytes;
      }
      if (this.sessionBytes < 0) this.sessionBytes = 0;
      await this._readManifest();
      const persistentEntries = Object.entries(this.manifest.entries).filter(function(pair) { return matches(pair[1]); });
      for (const pair of persistentEntries) {
        removedEntries += 1;
        removedBytes += Number(pair[1].bytes) || 0;
        await this._removePersistentEntry(pair[0], pair[1]);
      }
      if (persistentEntries.length) await this._writeManifest();
      const totals = policy.persistent
        ? (context ? this._manifestTotals(context.scopeHash) : this._manifestTotals())
        : (context ? this._sessionTotals(context.scopeHash) : { bytes: this.sessionBytes, entries: this.sessionEntries.size });
      const all = policy.persistent
        ? this._manifestTotals()
        : { bytes: this.sessionBytes, entries: this.sessionEntries.size };
      return Object.assign(this._publicStats(policy, context, totals, all), {
        removedEntries: removedEntries,
        removedBytes: removedBytes,
        scope: clearScope
      });
    });
  }

  async clear(request, mode) {
    return this._clearTyped(request, mode, undefined);
  }

  async clearDependencyIndexes(request, mode) {
    return this._clearTyped(request, mode, DEPENDENCY_INDEX_RECORD_TYPE);
  }

  async prune(mode, force) {
    const policy = this.policy(mode || 'active');
    if (!policy.persistent) return { pruned: false, mode: policy.mode, policy: this._publicPolicy(policy) };
    return this._run(async () => ({ pruned: await this._prunePersistent(policy, force === true), mode: policy.mode, policy: this._publicPolicy(policy) }));
  }

  async clearPersistent() {
    return this.clear({ scope: 'all' }, 'persistent');
  }

  async clearSession() {
    return this._run(async () => {
      const removedEntries = this.sessionEntries.size;
      const removedBytes = this.sessionBytes;
      this.sessionEntries.clear();
      this.sessionBytes = 0;
      return { removedEntries: removedEntries, removedBytes: removedBytes };
    });
  }
}

module.exports = {
  CACHE_VERSION,
  CACHE_ACCOUNTING_VERSION,
  MEBIBYTE,
  MIN_CACHE_SIZE_MIB,
  MAX_CACHE_SIZE_MIB,
  DEFAULT_CACHE_SIZE_MIB,
  COMPLETION_RECORD_TYPE,
  DEPENDENCY_INDEX_RECORD_TYPE,
  DEPENDENCY_INDEX_SCHEMA,
  MIN_DEPENDENCY_INDEX_SIZE_MIB,
  DEPENDENCY_INDEX_TTL_MS,
  MAX_DEPENDENCY_INDEX_BYTES,
  DEFAULT_POLICIES,
  ClientAnalysisCache,
  normalizeCacheMode,
  normalizeCacheSizeMiB,
  createCachePolicy,
  normalizeScope,
  normalizeCacheKey,
  sanitizeCompletionItems,
  sanitizeCompletionItem,
  sanitizeDependencyIndex,
  createDependencyIndexPolicy
};
