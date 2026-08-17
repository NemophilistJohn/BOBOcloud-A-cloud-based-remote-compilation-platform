'use strict';

// The marketplace is a main-process-only trust boundary. The renderer can
// select an id/version, but cannot choose registries, URLs, download paths, or
// installation destinations.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { PLUGIN_API_VERSION, PluginPermission, satisfiesVersionRange } = require('./plugins');

const OFFICIAL_OWNER = 'NemophilistJohn';
const OFFICIAL_REPOSITORY = 'BOBOCloud-Marketplace-Registry';
const OFFICIAL_REF = 'main';
const OFFICIAL_API_URL = 'https://api.github.com/repos/' + OFFICIAL_OWNER + '/' + OFFICIAL_REPOSITORY + '/commits/' + OFFICIAL_REF;
const OFFICIAL_RAW_ORIGIN = 'https://raw.githubusercontent.com';
const OFFICIAL_RAW_PREFIX = '/' + OFFICIAL_OWNER + '/' + OFFICIAL_REPOSITORY + '/';
const CACHE_SCHEMA_VERSION = 1;
const CACHE_DIRECTORY = 'plugin-marketplace';
const CACHE_FILE = 'official-catalog.json';
const DOWNLOAD_DIRECTORY = '.marketplace-downloads';
const REQUEST_TIMEOUT_MS = 12_000;
const CATALOG_TIMEOUT_MS = 30_000;
const CATALOG_CONCURRENCY = 6;
const MEMORY_CACHE_MS = 30_000;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_SHARDS = 32;
const MAX_PACKAGES = 2_048;
const MAX_VERSIONS_PER_PACKAGE = 64;
const MAX_TOTAL_VERSIONS = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const KNOWN_MARKETPLACE_PERMISSIONS = new Set(Object.values(PluginPermission));

function marketplaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isMarketplaceError(error) {
  return Boolean(error && typeof error.code === 'string' && error.code.startsWith('plugins.marketplace.'));
}

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isNonEmptyString(value, maximum = 4096) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function assertString(value, label, maximum = 4096) {
  if (!isNonEmptyString(value, maximum)) throw marketplaceError('plugins.marketplace.registry', label + ' is invalid.');
  return value;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw marketplaceError('plugins.marketplace.registry', label + ' is invalid.');
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw marketplaceError('plugins.marketplace.registry', label + ' has an invalid digest.');
  }
  return value;
}

function assertPluginId(value, code = 'plugins.marketplace.notFound') {
  if (typeof value !== 'string' || value.length > 120 || !PLUGIN_ID_PATTERN.test(value)) {
    throw marketplaceError(code, 'Marketplace plugin id is invalid.');
  }
  return value;
}

function assertSemver(value, code = 'plugins.marketplace.version') {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
    throw marketplaceError(code, 'Marketplace plugin version is invalid.');
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!isNonEmptyString(value, 96) || Number.isNaN(Date.parse(value))) {
    throw marketplaceError('plugins.marketplace.registry', label + ' is invalid.');
  }
  return value;
}

function safeRelativePath(value, label) {
  if (!isNonEmptyString(value, 360) || value.includes('\\') || value.includes('\0')) {
    throw marketplaceError('plugins.marketplace.registry', label + ' is not a safe relative path.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw marketplaceError('plugins.marketplace.registry', label + ' is not a safe relative path.');
  }
  return normalized;
}

function expectedPackagePath(id) {
  const [publisher, name] = id.split('.');
  return 'packages/' + publisher + '/' + name + '/index.json';
}

function expectedVersionPath(id, version) {
  const [publisher, name] = id.split('.');
  return 'packages/' + publisher + '/' + name + '/versions/' + version + '.json';
}

function canonicalMetadata(bytes, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    throw marketplaceError('plugins.marketplace.registry', label + ' is not valid UTF-8 JSON.');
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw marketplaceError('plugins.marketplace.registry', label + ' must not contain a byte-order mark.');
  }
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
}

function parseMetadata(bytes, label) {
  const canonical = canonicalMetadata(bytes, label);
  let value;
  try {
    value = JSON.parse(canonical.toString('utf8'));
  } catch (_) {
    throw marketplaceError('plugins.marketplace.registry', label + ' is not valid JSON.');
  }
  if (!isPlainObject(value)) throw marketplaceError('plugins.marketplace.registry', label + ' must be a JSON object.');
  return { value, canonical, sha256: digest(canonical) };
}

function responseLength(response) {
  const value = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

async function readResponseBytes(response, maximum) {
  const length = responseLength(response);
  if (length !== null && length > maximum) {
    throw marketplaceError('plugins.marketplace.body', 'Marketplace response exceeds the supported size.');
  }
  if (response && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maximum) {
          try { await reader.cancel(); } catch (_) {}
          throw marketplaceError('plugins.marketplace.body', 'Marketplace response exceeds the supported size.');
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
    return Buffer.concat(chunks, total);
  }
  if (!response || typeof response.arrayBuffer !== 'function') {
    throw marketplaceError('plugins.marketplace.network', 'Marketplace response is unavailable.');
  }
  let source;
  try {
    source = Buffer.from(await response.arrayBuffer());
  } catch (_) {
    throw marketplaceError('plugins.marketplace.network', 'Marketplace response could not be read.');
  }
  if (source.length > maximum) {
    throw marketplaceError('plugins.marketplace.body', 'Marketplace response exceeds the supported size.');
  }
  return source;
}

function isSuccessfulResponse(response) {
  if (!response) return false;
  if (typeof response.ok === 'boolean') return response.ok;
  const status = Number.isInteger(response.status) ? response.status : 200;
  return status >= 200 && status < 300;
}

async function fetchBytes(fetchImpl, url, maximum, headers, timeoutMs = REQUEST_TIMEOUT_MS) {
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (abortController) abortController.abort();
  }, timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        headers,
        signal: abortController ? abortController.signal : undefined
      });
    } catch (error) {
      if (timedOut || (error && error.name === 'AbortError')) {
        throw marketplaceError('plugins.marketplace.timeout', 'Marketplace request timed out.');
      }
      throw marketplaceError('plugins.marketplace.network', 'Marketplace request failed.');
    }
    if (response.redirected === true) {
      throw marketplaceError('plugins.marketplace.redirect', 'Marketplace redirects are not allowed.');
    }
    if (!isSuccessfulResponse(response)) {
      throw marketplaceError('plugins.marketplace.http', 'Marketplace request was rejected.');
    }
    return await readResponseBytes(response, maximum);
  } catch (error) {
    if (isMarketplaceError(error)) throw error;
    if (timedOut || (error && error.name === 'AbortError')) {
      throw marketplaceError('plugins.marketplace.timeout', 'Marketplace request timed out.');
    }
    throw marketplaceError('plugins.marketplace.network', 'Marketplace request failed.');
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLocalizedMap(value, label, maximumLength) {
  assertPlainObject(value, label);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 16) {
    throw marketplaceError('plugins.marketplace.registry', label + ' is invalid.');
  }
  const result = {};
  for (const [locale, message] of entries) {
    if (!/^[A-Za-z0-9-]{2,32}$/.test(locale) || !isNonEmptyString(message, maximumLength)) {
      throw marketplaceError('plugins.marketplace.registry', label + ' is invalid.');
    }
    result[locale] = message.trim();
  }
  return result;
}

function normalizeStringList(value, label, maximumEntries, maximumLength, pattern) {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw marketplaceError('plugins.marketplace.registry', label + ' is invalid.');
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (!isNonEmptyString(item, maximumLength) || (pattern && !pattern.test(item)) || seen.has(item)) {
      throw marketplaceError('plugins.marketplace.registry', label + ' is invalid.');
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeEngines(value) {
  assertPlainObject(value, 'Marketplace engines');
  if (!isNonEmptyString(value.bobocloud, 160) || !isNonEmptyString(value.pluginApi, 160)) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace engines are invalid.');
  }
  return { bobocloud: value.bobocloud.trim(), pluginApi: value.pluginApi.trim() };
}

function normalizePermissions(value) {
  const permissions = normalizeStringList(value, 'Marketplace permissions', 32, 120, /^[A-Za-z0-9.-]+$/);
  if (permissions.some((permission) => !KNOWN_MARKETPLACE_PERMISSIONS.has(permission))) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace permissions are invalid.');
  }
  return permissions;
}

function normalizeArtifact(value) {
  assertPlainObject(value, 'Marketplace artifact');
  if (value.format !== 'boboplugin') {
    throw marketplaceError('plugins.marketplace.artifact', 'Marketplace artifact format is unsupported.');
  }
  if (!isNonEmptyString(value.url, 2048)) {
    throw marketplaceError('plugins.marketplace.artifact', 'Marketplace artifact URL is invalid.');
  }
  const url = value.url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw marketplaceError('plugins.marketplace.artifact', 'Marketplace artifact URL is invalid.');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname !== 'raw.githubusercontent.com') {
    throw marketplaceError('plugins.marketplace.artifact-host', 'Marketplace artifact host is not approved.');
  }
  const reference = segments[2] || '';
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash ||
      segments.length < 4 || !parsed.pathname.endsWith('.boboplugin') ||
      !(COMMIT_PATTERN.test(reference) || /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(reference)) ||
      segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw marketplaceError('plugins.marketplace.artifact', 'Marketplace artifact URL is not an approved HTTPS package endpoint.');
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw marketplaceError('plugins.marketplace.artifact', 'Marketplace artifact digest is invalid.');
  }
  const sha256 = value.sha256;
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_ARTIFACT_BYTES) {
    throw marketplaceError('plugins.marketplace.artifact', 'Marketplace artifact size is invalid.');
  }
  return { format: 'boboplugin', url: parsed.toString(), sha256, size: value.size };
}

function normalizeSource(value) {
  assertPlainObject(value, 'Marketplace source');
  const repository = assertString(value.repository, 'Marketplace source repository', 2048);
  let parsed;
  try {
    parsed = new URL(repository);
  } catch (_) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace source repository is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace source repository is invalid.');
  }
  return { repository: parsed.toString(), ref: assertString(value.ref, 'Marketplace source reference', 160) };
}

function validateRegistryFormat(value) {
  assertPlainObject(value, 'Marketplace format');
  if (value.shardPath !== 'indexes/<shard>.json' || value.packagePath !== 'packages/<publisher>/<name>/index.json' ||
      value.versionPath !== 'packages/<publisher>/<name>/versions/<semver>.json') {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace format is unsupported.');
  }
}

function validateRegistryPolicy(value) {
  assertPlainObject(value, 'Marketplace policy');
  const hosts = value.artifactHosts;
  if (value.packageIdPattern !== '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' ||
      value.artifactProtocol !== 'https' || value.artifactDigest !== 'sha256' || value.immutableVersionDocuments !== true ||
      !Array.isArray(hosts) || hosts.length !== 1 || hosts[0] !== 'raw.githubusercontent.com') {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace policy is unsupported.');
  }
}

function normalizeVersionDescriptor(value, id, version) {
  assertPlainObject(value, 'Marketplace version descriptor');
  if (value.schemaVersion !== 1 || value.id !== id || value.version !== version) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace version descriptor identity does not match its index.');
  }
  return normalizeVersionDescriptorFields(value, version);
}

function normalizeVersionDescriptorFields(value, version) {
  assertPlainObject(value, 'Marketplace version descriptor');
  if (value.version !== version) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace version descriptor identity does not match its index.');
  }
  return {
    version,
    publishedAt: assertTimestamp(value.publishedAt, 'Marketplace published date'),
    engines: normalizeEngines(value.engines),
    artifact: normalizeArtifact(value.artifact),
    source: normalizeSource(value.source),
    permissions: normalizePermissions(value.permissions),
    locales: normalizeStringList(value.locales, 'Marketplace locales', 16, 32, /^[A-Za-z0-9-]+$/)
  };
}

function normalizeVersionReference(value, id) {
  assertPlainObject(value, 'Marketplace version entry');
  const version = assertSemver(value.version, 'plugins.marketplace.registry');
  const entryPath = safeRelativePath(value.path, 'Marketplace version path');
  if (entryPath !== expectedVersionPath(id, version)) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace version path is invalid.');
  }
  return { version, path: entryPath, sha256: assertDigest(value.sha256, 'Marketplace version') };
}

function normalizeCatalog(value) {
  assertPlainObject(value, 'Marketplace catalog');
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION || value.registryId !== 'bobocloud.marketplace' || !COMMIT_PATTERN.test(String(value.revision || ''))) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace catalog identity is invalid.');
  }
  const updatedAt = assertTimestamp(value.updatedAt, 'Marketplace updated date');
  if (!Array.isArray(value.packages) || value.packages.length > MAX_PACKAGES) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace packages are invalid.');
  }
  const ids = new Set();
  const packages = [];
  for (const record of value.packages) {
    assertPlainObject(record, 'Marketplace package');
    const id = assertPluginId(record.id, 'plugins.marketplace.registry');
    if (ids.has(id)) throw marketplaceError('plugins.marketplace.registry', 'Marketplace contains duplicate plugin ids.');
    ids.add(id);
    const [publisher, name] = id.split('.');
    if (record.publisher !== publisher || record.name !== name || !isPlainObject(record.summary)) {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace package identity is invalid.');
    }
    const latest = assertSemver(record.latest, 'plugins.marketplace.registry');
    if (!Array.isArray(record.versions) || record.versions.length === 0 || record.versions.length > MAX_VERSIONS_PER_PACKAGE) {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace package versions are invalid.');
    }
    const versions = [];
    const versionValues = new Set();
    for (const versionRecord of record.versions) {
      const reference = normalizeVersionReference(versionRecord, id);
      if (versionValues.has(reference.version)) {
        throw marketplaceError('plugins.marketplace.registry', 'Marketplace package contains duplicate versions.');
      }
      versionValues.add(reference.version);
      versions.push(reference);
    }
    if (!versionValues.has(latest)) throw marketplaceError('plugins.marketplace.registry', 'Marketplace latest version is missing.');
    const latestDescriptor = normalizeVersionDescriptorFields(record.latestDescriptor, latest);
    const summary = record.summary;
    packages.push({
      id,
      publisher,
      name,
      summary: {
        displayName: normalizeLocalizedMap(summary.displayName, 'Marketplace display name', 160),
        description: normalizeLocalizedMap(summary.description, 'Marketplace description', 1_200),
        categories: normalizeStringList(summary.categories, 'Marketplace categories', 16, 64, /^[a-z0-9-]+$/)
      },
      latest,
      versions,
      latestDescriptor
    });
  }
  const totalVersions = packages.reduce((total, record) => total + record.versions.length, 0);
  if (totalVersions > MAX_TOTAL_VERSIONS) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace contains too many package versions.');
  }
  packages.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: CACHE_SCHEMA_VERSION, registryId: 'bobocloud.marketplace', updatedAt, revision: value.revision, packages };
}

function compareSemver(left, right) {
  const leftMatch = SEMVER_PATTERN.exec(left);
  const rightMatch = SEMVER_PATTERN.exec(right);
  if (!leftMatch || !rightMatch) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference) return difference < 0 ? -1 : 1;
  }
  const leftPre = leftMatch[4] || '';
  const rightPre = rightMatch[4] || '';
  if (!leftPre || !rightPre) return leftPre === rightPre ? 0 : (leftPre ? -1 : 1);
  const leftParts = leftPre.split('.');
  const rightParts = rightPre.split('.');
  const maximum = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maximum; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compatibleWithHost(version, hostVersion) {
  try {
    return satisfiesVersionRange(hostVersion, version.engines.bobocloud) &&
      satisfiesVersionRange(PLUGIN_API_VERSION, version.engines.pluginApi);
  } catch (_) {
    return false;
  }
}

function publicCatalog(catalog, installedRecords, provenance) {
  const installed = new Map((Array.isArray(installedRecords) ? installedRecords : []).map((record) => [record.id, record]));
  const packages = catalog.packages.map((record) => {
    const installedRecord = installed.get(record.id) || null;
    const latest = record.latestDescriptor;
    const versions = [immutable({
      version: latest.version,
      publishedAt: latest.publishedAt,
      engines: cloneJson(latest.engines),
      permissions: [...latest.permissions],
      locales: [...latest.locales],
      size: latest.artifact.size,
      source: cloneJson(latest.source),
      compatible: compatibleWithHost(latest, provenance.hostVersion),
      installed: Boolean(installedRecord && installedRecord.version === latest.version)
    })];
    const updateAvailable = Boolean(installedRecord && compatibleWithHost(latest, provenance.hostVersion) &&
      compareSemver(record.latest, installedRecord.version) > 0);
    return immutable({
      id: record.id,
      displayName: cloneJson(record.summary.displayName),
      description: cloneJson(record.summary.description),
      categories: [...record.summary.categories],
      latest: record.latest,
      installedVersion: installedRecord ? installedRecord.version : '',
      installedStatus: installedRecord ? installedRecord.status : 'not-installed',
      updateAvailable,
      versions
    });
  });
  return immutable({
    registryId: catalog.registryId,
    updatedAt: catalog.updatedAt,
    fetchedAt: provenance.fetchedAt,
    revision: catalog.revision,
    provenance: provenance.source,
    stale: provenance.stale === true,
    packages
  });
}

function rawBaseForRevision(revision) {
  return OFFICIAL_RAW_ORIGIN + OFFICIAL_RAW_PREFIX + revision + '/';
}

function rawMetadataUrl(revision, relativePath) {
  const safe = safeRelativePath(relativePath, 'Marketplace index path');
  const base = rawBaseForRevision(revision);
  const url = new URL(safe, base);
  if (url.origin !== OFFICIAL_RAW_ORIGIN || !url.pathname.startsWith(OFFICIAL_RAW_PREFIX + revision + '/')) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace index path is invalid.');
  }
  return url.toString();
}

function remainingCatalogTimeout(deadline) {
  if (!deadline) return REQUEST_TIMEOUT_MS;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw marketplaceError('plugins.marketplace.timeout', 'Marketplace catalog refresh timed out.');
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

async function readMetadata(fetchImpl, revision, relativePath, expectedDigest, deadline) {
  const bytes = await fetchBytes(fetchImpl, rawMetadataUrl(revision, relativePath), MAX_METADATA_BYTES, {
    Accept: 'application/json'
  }, remainingCatalogTimeout(deadline));
  const parsed = parseMetadata(bytes, 'Marketplace metadata');
  if (expectedDigest && parsed.sha256 !== expectedDigest) {
    throw marketplaceError('plugins.marketplace.integrity', 'Marketplace index integrity verification failed.');
  }
  return parsed.value;
}

async function resolveOfficialRevision(fetchImpl, deadline) {
  const bytes = await fetchBytes(fetchImpl, OFFICIAL_API_URL, 64 * 1024, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }, remainingCatalogTimeout(deadline));
  const parsed = parseMetadata(bytes, 'Marketplace revision');
  if (!COMMIT_PATTERN.test(String(parsed.value.sha || ''))) {
    throw marketplaceError('plugins.marketplace.registry', 'Official marketplace revision is invalid.');
  }
  return parsed.value.sha;
}

async function mapBounded(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchOfficialCatalog(fetchImpl) {
  const deadline = Date.now() + CATALOG_TIMEOUT_MS;
  const revision = await resolveOfficialRevision(fetchImpl, deadline);
  const root = await readMetadata(fetchImpl, revision, 'registry.json', null, deadline);
  if (root.schemaVersion !== 1 || root.registryId !== 'bobocloud.marketplace' || !Array.isArray(root.shards) ||
      root.shards.length === 0 || root.shards.length > MAX_SHARDS) {
    throw marketplaceError('plugins.marketplace.registry', 'Official marketplace registry is invalid.');
  }
  const updatedAt = assertTimestamp(root.updatedAt, 'Marketplace updated date');
  validateRegistryFormat(root.format);
  validateRegistryPolicy(root.policy);
  const seenShards = new Set();
  const seenPackages = new Set();
  const packageEntries = [];
  for (const shardRecord of root.shards) {
    assertPlainObject(shardRecord, 'Marketplace shard');
    const shardId = assertString(shardRecord.id, 'Marketplace shard id', 64);
    if (!/^[a-z0-9-]+$/.test(shardId) || seenShards.has(shardId)) {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace shard id is invalid.');
    }
    seenShards.add(shardId);
    const shardPath = safeRelativePath(shardRecord.path, 'Marketplace shard path');
    if (shardPath !== 'indexes/' + shardId + '.json') {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace shard path is invalid.');
    }
    const shardDigest = assertDigest(shardRecord.sha256, 'Marketplace shard');
    if (!Number.isSafeInteger(shardRecord.count) || shardRecord.count < 0 || shardRecord.count > MAX_PACKAGES) {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace shard count is invalid.');
    }
    const shard = await readMetadata(fetchImpl, revision, shardPath, shardDigest, deadline);
    if (shard.schemaVersion !== 1 || shard.id !== shardId || !Array.isArray(shard.packages) || shard.packages.length !== shardRecord.count) {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace shard is invalid.');
    }
    for (const packageRecord of shard.packages) {
      assertPlainObject(packageRecord, 'Marketplace package entry');
      const id = assertPluginId(packageRecord.id, 'plugins.marketplace.registry');
      if (seenPackages.has(id) || packageEntries.length >= MAX_PACKAGES) {
        throw marketplaceError('plugins.marketplace.registry', 'Marketplace package entry is invalid.');
      }
      seenPackages.add(id);
      const packagePath = safeRelativePath(packageRecord.path, 'Marketplace package path');
      if (packagePath !== expectedPackagePath(id)) {
        throw marketplaceError('plugins.marketplace.registry', 'Marketplace package path is invalid.');
      }
      const packageDigest = assertDigest(packageRecord.sha256, 'Marketplace package');
      packageEntries.push({ id, latest: assertSemver(packageRecord.latest, 'plugins.marketplace.registry'), path: packagePath, sha256: packageDigest });
    }
  }
  const packages = await mapBounded(packageEntries, CATALOG_CONCURRENCY, async (entry) => {
    const packageIndex = await readMetadata(fetchImpl, revision, entry.path, entry.sha256, deadline);
    const [publisher, name] = entry.id.split('.');
    if (packageIndex.schemaVersion !== 1 || packageIndex.id !== entry.id || packageIndex.publisher !== publisher || packageIndex.name !== name ||
        packageIndex.latest !== entry.latest || !isPlainObject(packageIndex.summary) || !isPlainObject(packageIndex.versions)) {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace package index is invalid.');
    }
    const versionEntries = Object.entries(packageIndex.versions);
    if (versionEntries.length === 0 || versionEntries.length > MAX_VERSIONS_PER_PACKAGE || !Object.hasOwn(packageIndex.versions, entry.latest)) {
      throw marketplaceError('plugins.marketplace.registry', 'Marketplace package versions are invalid.');
    }
    const versions = versionEntries.map(([version, versionRecord]) => {
      assertSemver(version, 'plugins.marketplace.registry');
      assertPlainObject(versionRecord, 'Marketplace version entry');
      const versionPath = safeRelativePath(versionRecord.path, 'Marketplace version path');
      if (versionPath !== expectedVersionPath(entry.id, version)) {
        throw marketplaceError('plugins.marketplace.registry', 'Marketplace version path is invalid.');
      }
      return { version, path: versionPath, sha256: assertDigest(versionRecord.sha256, 'Marketplace version') };
    });
    const latestReference = versions.find((record) => record.version === entry.latest);
    const latestRaw = await readMetadata(fetchImpl, revision, latestReference.path, latestReference.sha256, deadline);
    return {
      id: entry.id,
      publisher,
      name,
      summary: {
        displayName: normalizeLocalizedMap(packageIndex.summary.displayName, 'Marketplace display name', 160),
        description: normalizeLocalizedMap(packageIndex.summary.description, 'Marketplace description', 1_200),
        categories: normalizeStringList(packageIndex.summary.categories, 'Marketplace categories', 16, 64, /^[a-z0-9-]+$/)
      },
      latest: entry.latest,
      versions,
      latestDescriptor: normalizeVersionDescriptor(latestRaw, entry.id, entry.latest)
    };
  });
  if (packages.reduce((total, item) => total + item.versions.length, 0) > MAX_TOTAL_VERSIONS) {
    throw marketplaceError('plugins.marketplace.registry', 'Marketplace contains too many package versions.');
  }
  return normalizeCatalog({
    schemaVersion: CACHE_SCHEMA_VERSION,
    registryId: 'bobocloud.marketplace',
    updatedAt,
    revision,
    packages
  });
}

function isRecoverableNetworkFailure(error) {
  return Boolean(error && (error.code === 'plugins.marketplace.network' || error.code === 'plugins.marketplace.timeout'));
}

function createMarketplaceController(options) {
  if (!options || !options.app || !options.ipcMain || !options.getWindow || !options.pluginManager) {
    throw new TypeError('createMarketplaceController requires app, ipcMain, getWindow, and pluginManager.');
  }
  const app = options.app;
  const ipcMain = options.ipcMain;
  const getWindow = options.getWindow;
  const pluginManager = options.pluginManager;
  const hostVersion = String(options.hostVersion || (typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'));
  const fetchImpl = options.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (typeof fetchImpl !== 'function') throw new TypeError('Marketplace fetch is unavailable.');
  const cachePath = options.cachePath || path.join(app.getPath('userData'), CACHE_DIRECTORY, CACHE_FILE);
  const downloadRoot = options.downloadRoot || path.join(pluginManager.root, DOWNLOAD_DIRECTORY);
  let freshCatalog = null;
  let catalogRequest = null;
  let installQueue = Promise.resolve();

  function trustedSender(event) {
    if (!event || !event.sender) return;
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents !== event.sender) {
      throw marketplaceError('plugins.marketplace.sender', 'Marketplace IPC request did not come from the workbench window.');
    }
  }

  async function writeCache(catalog, fetchedAt) {
    const value = { schemaVersion: CACHE_SCHEMA_VERSION, fetchedAt, catalog };
    const source = Buffer.from(JSON.stringify(value), 'utf8');
    if (source.length > MAX_CACHE_BYTES) return;
    const directory = path.dirname(cachePath);
    const temporary = path.join(directory, '.' + path.basename(cachePath) + '.' + crypto.randomUUID() + '.tmp');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fsp.writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
      await fsp.rename(temporary, cachePath);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function readCache() {
    let source;
    try {
      const stat = await fsp.stat(cachePath);
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
      source = await fsp.readFile(cachePath);
    } catch (_) {
      return null;
    }
    try {
      const parsed = parseMetadata(source, 'Marketplace cache').value;
      if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || !isPlainObject(parsed.catalog)) return null;
      const fetchedAt = assertTimestamp(parsed.fetchedAt, 'Marketplace cache date');
      return { catalog: normalizeCatalog(parsed.catalog), fetchedAt };
    } catch (_) {
      return null;
    }
  }

  async function loadNetworkCatalog() {
    if (catalogRequest) return catalogRequest;
    catalogRequest = (async () => {
      const catalog = await fetchOfficialCatalog(fetchImpl);
      const fetchedAt = new Date().toISOString();
      freshCatalog = { catalog, fetchedAt, receivedAt: Date.now() };
      await writeCache(catalog, fetchedAt).catch(() => {});
      return freshCatalog;
    })().finally(() => { catalogRequest = null; });
    return catalogRequest;
  }

  async function loadCatalog(force) {
    if (!force && freshCatalog && Date.now() - freshCatalog.receivedAt < MEMORY_CACHE_MS) {
      return { ...freshCatalog, source: 'memory', stale: false };
    }
    try {
      const network = await loadNetworkCatalog();
      return { ...network, source: 'network', stale: false };
    } catch (error) {
      if (!isRecoverableNetworkFailure(error)) throw error;
      const cached = await readCache();
      if (!cached) throw error;
      return { ...cached, source: 'verified-cache', stale: true };
    }
  }

  async function list(force = false) {
    const loaded = await loadCatalog(force === true);
    await pluginManager.initialize();
    return publicCatalog(loaded.catalog, pluginManager.list(), {
      source: loaded.source,
      stale: loaded.stale,
      fetchedAt: loaded.fetchedAt,
      hostVersion
    });
  }

  function findLatestVersion(catalog, id, requestedVersion) {
    const packageRecord = catalog.packages.find((record) => record.id === id);
    if (!packageRecord) throw marketplaceError('plugins.marketplace.notFound', 'Marketplace plugin is not available.');
    if (requestedVersion !== undefined && requestedVersion !== null && requestedVersion !== '') {
      const version = assertSemver(requestedVersion);
      if (version !== packageRecord.latest) {
        throw marketplaceError('plugins.marketplace.version', 'Marketplace installs the latest plugin version only. Import an older .boboplugin package manually.');
      }
    }
    return { packageRecord, descriptor: packageRecord.latestDescriptor };
  }

  async function downloadArtifact(descriptor) {
    const bytes = await fetchBytes(fetchImpl, descriptor.artifact.url, descriptor.artifact.size, {
      Accept: 'application/octet-stream'
    });
    if (bytes.length !== descriptor.artifact.size || digest(bytes) !== descriptor.artifact.sha256) {
      throw marketplaceError('plugins.marketplace.artifact', 'Marketplace package integrity verification failed.');
    }
    await fsp.mkdir(downloadRoot, { recursive: true, mode: 0o700 });
    const temporary = path.join(downloadRoot, crypto.randomUUID() + '.boboplugin');
    try {
      await fsp.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      return temporary;
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw marketplaceError('plugins.marketplace.artifact', 'Marketplace package could not be prepared for installation.');
    }
  }

  async function installInternal(id, version) {
    const pluginId = assertPluginId(id);
    const loaded = await loadNetworkCatalog();
    const selected = findLatestVersion(loaded.catalog, pluginId, version);
    if (!compatibleWithHost(selected.descriptor, hostVersion)) {
      throw marketplaceError('plugins.marketplace.incompatible', 'Marketplace plugin is not compatible with this BOBOCloud version.');
    }
    await pluginManager.initialize();
    const installed = pluginManager.get(pluginId);
    if (installed && compareSemver(selected.descriptor.version, installed.version) < 0) {
      throw marketplaceError('plugins.marketplace.downgrade', 'Marketplace does not install an older plugin version over the installed version.');
    }
    const archivePath = await downloadArtifact(selected.descriptor);
    try {
      let installedRecord;
      try {
        installedRecord = await pluginManager.installArchiveFromPath(archivePath, {
          id: pluginId,
          version: selected.descriptor.version,
          expectedMinimumVersion: selected.descriptor.version
        });
      } catch (error) {
        if (error && error.code === 'plugins.install.identity') {
          throw marketplaceError('plugins.marketplace.identity', 'Marketplace package identity verification failed.');
        }
        if (error && error.code === 'plugins.install.downgrade') {
          throw marketplaceError('plugins.marketplace.downgrade', 'A newer plugin version was installed while this marketplace package was downloading.');
        }
        if (error && (error.code === 'plugins.manifest.api' || error.code === 'plugins.manifest.host')) {
          throw marketplaceError('plugins.marketplace.incompatible', 'Marketplace plugin is not compatible with this BOBOCloud version.');
        }
        throw error;
      }
      if (!installedRecord || installedRecord.id !== pluginId || installedRecord.version !== selected.descriptor.version) {
        throw marketplaceError('plugins.marketplace.identity', 'Marketplace package identity verification failed.');
      }
      return installedRecord;
    } finally {
      await fsp.rm(archivePath, { force: true }).catch(() => {});
    }
  }

  function install(id, version) {
    const pending = installQueue.then(() => installInternal(id, version), () => installInternal(id, version));
    installQueue = pending.catch(() => {});
    return pending;
  }

  function registerIpc() {
    ipcMain.handle('plugins:marketplace-list', async (event) => { trustedSender(event); return list(false); });
    ipcMain.handle('plugins:marketplace-refresh', async (event) => { trustedSender(event); return list(true); });
    ipcMain.handle('plugins:marketplace-install', async (event, payload) => {
      trustedSender(event);
      const request = isPlainObject(payload) ? payload : {};
      return install(request.id, request.version);
    });
  }

  return {
    registerIpc,
    list,
    refresh: () => list(true),
    install,
    get cachePath() { return cachePath; }
  };
}

module.exports = {
  OFFICIAL_API_URL,
  OFFICIAL_RAW_ORIGIN,
  createMarketplaceController,
  compareSemver,
  fetchOfficialCatalog,
  marketplaceError
};
