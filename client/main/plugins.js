'use strict';

// The package manager intentionally has no dependency on the renderer plugin
// runtime. Downloaded code is data here; it is only ever exposed as the
// verified single entry bundle to the isolated renderer extension host.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { SCM_GIT_METHODS, createScmGitBroker } = require('./scm-git');
const { createPluginDocumentBroker } = require('./plugin-documents');
const { capturePluginRpcResult } = require('./plugin-rpc-transport');
const { compareSemver, isValidSemver, satisfiesVersionRange } = require('../shared/plugin-semver');

const PLUGIN_API_VERSION = '1.6.0';
const PACKAGE_SCHEMA_VERSIONS = new Set([1, 2]);
const STATE_SCHEMA_VERSION = 1;
const PERMISSIONS_SCHEMA_VERSION = 2;
const INSTALL_RECEIPT = '.bobocloud-install.json';
const REGISTRY_FILE = '.registry.json';
const PERMISSIONS_FILE = '.permissions.json';
const INSTALL_DIALOG_STATE_FILE = '.install-dialog.json';
const INSTALL_IMPORT_DIRECTORY = '.imports';
const STAGING_DIRECTORY = '.staging';
const TRASH_DIRECTORY = '.trash';
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_COUNT = 128;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_VIEW_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_VIEW_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_VIEW_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_LOCALIZATION_BYTES = 128 * 1024;
const MAX_LOCALIZATION_ENTRIES = 1024;
const MAX_LOCALIZATION_KEY_LENGTH = 160;
const MAX_LOCALIZATION_VALUE_LENGTH = 8192;
const MAX_RPC_ARGUMENT_BYTES = 64 * 1024;
const MAX_AGENT_RPC_ARGUMENT_BYTES = 1024 * 1024;

const PluginPermission = Object.freeze({
  COMMANDS_REGISTER: 'commands.register',
  COMMANDS_EXECUTE: 'commands.execute',
  CONTRIBUTIONS_REGISTER: 'contributions.register',
  SERVICES_READ: 'services.read',
  SOURCE_CONTROL_REGISTER: 'sourceControl.register',
  SCM_GIT_READ: 'scm.git.read',
  SCM_GIT_WRITE: 'scm.git.write',
  FILE_DECORATIONS_SCM: 'fileDecorations.scm',
  DOCUMENT_VIEWS_REGISTER: 'documentViews.register',
  DOCUMENTS_READ: 'documents.read',
  AGENTS_REGISTER: 'agents.register',
  MODELS_GENERATE: 'models.generate',
  WORKSPACE_READ: 'workspace.read',
  WORKSPACE_WRITE: 'workspace.write',
  PROCESS_EXECUTE: 'process.execute',
  SKILLS_READ: 'skills.read',
  STORAGE_LOCAL: 'storage.local'
});

const KNOWN_PERMISSIONS = new Set(Object.values(PluginPermission));
const KNOWN_CONTRIBUTION_POINTS = new Set([
  'menus',
  'fileDecorations.sync',
  'fileDecorations.scm',
  'fileDecorations.diagnostic',
  'tasks',
  'debug.configurationProviders',
  'sourceControl',
  'documentViews',
  'settings',
  'languages',
  'ai.tools',
  'mcp.providers',
  'skills.providers',
  'agents'
]);
const ALLOWED_FILE_EXTENSIONS = new Set([
  '.js', '.mjs', '.json', '.md', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.css'
]);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);
const DOCUMENT_VIEW_RESOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.txt']);
const RESERVED_PACKAGE_FILES = new Set([INSTALL_RECEIPT, REGISTRY_FILE, PERMISSIONS_FILE]);
const ALLOWED_MANIFEST_FIELDS = new Set([
  'schemaVersion', 'id', 'displayName', 'description', 'version', 'engines', 'main',
  'activationEvents', 'permissions', 'contributes', 'localization', 'integrity'
]);

function pluginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.once('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value, maxLength = 4096) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function normalizeRelativePath(value, label = 'Package path') {
  if (!isNonEmptyString(value, 240) || value.includes('\0') || value.includes('\\')) {
    throw pluginError('plugins.package.path', label + ' must use a short relative POSIX path.');
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/') || normalized.includes('/../')) {
    throw pluginError('plugins.package.path', label + ' escapes the plugin package.');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment.startsWith('.'))) {
    throw pluginError('plugins.package.path', label + ' contains a reserved path segment.');
  }
  if (RESERVED_PACKAGE_FILES.has(normalized)) {
    throw pluginError('plugins.package.path', label + ' uses a host-reserved file name.');
  }
  return normalized;
}

function assertAllowedPackageFile(relativePath) {
  if (relativePath === 'manifest.json') return;
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    throw pluginError('plugins.package.fileType', 'Plugin packages cannot contain executable or unsupported file types: ' + relativePath);
  }
}

function isSafePluginId(value) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(String(value || ''));
}

function assertSafePluginId(value) {
  if (!isSafePluginId(value) || String(value).length > 120) {
    throw pluginError('plugins.manifest.id', 'Plugin id must be a lowercase namespaced identifier.');
  }
  return String(value);
}

function assertNoUnknownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw pluginError('plugins.manifest.field', label + ' contains unsupported field: ' + field);
  }
}

function validateManifest(manifest, files, hostVersion) {
  if (!isPlainObject(manifest)) throw pluginError('plugins.manifest.invalid', 'Plugin manifest must be a JSON object.');
  assertNoUnknownFields(manifest, ALLOWED_MANIFEST_FIELDS, 'Plugin manifest');
  if (!PACKAGE_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
    throw pluginError('plugins.manifest.schema', 'Plugin manifest schemaVersion must be 1 or 2.');
  }
  const id = assertSafePluginId(manifest.id);
  if (!isValidSemver(manifest.version)) throw pluginError('plugins.manifest.version', 'Plugin version must be valid semver.');
  if (!isPlainObject(manifest.engines) || !isNonEmptyString(manifest.engines.pluginApi, 160) || !isNonEmptyString(manifest.engines.bobocloud, 160)) {
    throw pluginError('plugins.manifest.engines', 'Plugin manifest must declare engines.pluginApi and engines.bobocloud.');
  }
  if (!satisfiesVersionRange(PLUGIN_API_VERSION, manifest.engines.pluginApi)) {
    throw pluginError('plugins.manifest.api', 'Plugin requires an incompatible plugin API version.');
  }
  if (!satisfiesVersionRange(hostVersion, manifest.engines.bobocloud)) {
    throw pluginError('plugins.manifest.host', 'Plugin requires an incompatible BOBOCloud version.');
  }
  const main = normalizeRelativePath(manifest.main, 'Plugin main entry');
  if (!SCRIPT_EXTENSIONS.has(path.posix.extname(main).toLowerCase())) {
    throw pluginError('plugins.manifest.main', 'Plugin main entry must be a bundled .js or .mjs file.');
  }
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : null;
  if (!permissions || permissions.length > 32 || permissions.some((permission) => !KNOWN_PERMISSIONS.has(permission))) {
    throw pluginError('plugins.manifest.permissions', 'Plugin manifest requests an unknown or invalid permission.');
  }
  if (new Set(permissions).size !== permissions.length) {
    throw pluginError('plugins.manifest.permissions', 'Plugin manifest must not repeat permissions.');
  }
  const activationEvents = manifest.activationEvents;
  if (!Array.isArray(activationEvents) || activationEvents.length > 64 || activationEvents.some((event) => !isNonEmptyString(event, 160))) {
    throw pluginError('plugins.manifest.activation', 'Plugin activation events are invalid.');
  }
  if (manifest.contributes !== undefined && (!isPlainObject(manifest.contributes) || Buffer.byteLength(stableJson(manifest.contributes), 'utf8') > MAX_MANIFEST_BYTES)) {
    throw pluginError('plugins.manifest.contributes', 'Plugin contributions must be a bounded JSON object.');
  }
  const documentViewers = validateDocumentViewers(manifest.contributes || {}, files, id, manifest.schemaVersion);
  if (manifest.localization !== undefined) validateLocalization(manifest.localization, files);
  const integrity = validateIntegrity(manifest.integrity, files, main, {
    schemaVersion: manifest.schemaVersion,
    executableFiles: documentViewers.executableFiles
  });
  const normalized = {
    schemaVersion: manifest.schemaVersion,
    id,
    displayName: isNonEmptyString(manifest.displayName, 120) ? manifest.displayName.trim() : id,
    description: isNonEmptyString(manifest.description, 500) ? manifest.description.trim() : '',
    version: manifest.version,
    engines: { pluginApi: manifest.engines.pluginApi.trim(), bobocloud: manifest.engines.bobocloud.trim() },
    main,
    activationEvents: [...activationEvents],
    permissions: [...permissions],
    contributes: documentViewers.contributes,
    localization: manifest.localization ? cloneJson(manifest.localization) : {},
    integrity
  };
  return immutable(normalized);
}

function validateDocumentViewers(contributes, files, pluginId, schemaVersion) {
  const normalized = cloneJson(contributes || {});
  const executableFiles = new Set();
  if (normalized.documentViewers === undefined) return { contributes: normalized, executableFiles };
  if (schemaVersion !== 2) {
    throw pluginError('plugins.manifest.documentViews', 'Document viewers require package schemaVersion 2.');
  }
  if (!Array.isArray(normalized.documentViewers) || normalized.documentViewers.length < 1 || normalized.documentViewers.length > 16) {
    throw pluginError('plugins.manifest.documentViews', 'Document viewers must be a non-empty array with at most 16 entries.');
  }
  const seenIds = new Set();
  normalized.documentViewers = normalized.documentViewers.map((viewer) => {
    if (!isPlainObject(viewer)) throw pluginError('plugins.manifest.documentViews', 'Document viewer descriptor must be an object.');
    const allowed = new Set(['id', 'extensions', 'entry', 'resources', 'priority']);
    assertNoUnknownFields(viewer, allowed, 'Document viewer descriptor');
    const viewerId = String(viewer.id || '');
    if (!isNonEmptyString(viewerId, 180) || !viewerId.startsWith(pluginId + '.') || seenIds.has(viewerId)) {
      throw pluginError('plugins.manifest.documentViews', 'Document viewer ids must be unique and use the plugin namespace.');
    }
    seenIds.add(viewerId);
    if (!Array.isArray(viewer.extensions) || viewer.extensions.length < 1 || viewer.extensions.length > 32) {
      throw pluginError('plugins.manifest.documentViews', 'Document viewer extensions must be a non-empty bounded array.');
    }
    const extensions = viewer.extensions.map((extension) => String(extension || '').toLowerCase());
    if (new Set(extensions).size !== extensions.length || extensions.some((extension) => !/^\.[a-z0-9][a-z0-9+_-]{0,15}$/.test(extension))) {
      throw pluginError('plugins.manifest.documentViews', 'Document viewer extensions must be unique lowercase file extensions.');
    }
    const entry = normalizeRelativePath(viewer.entry, 'Document viewer entry');
    if (!SCRIPT_EXTENSIONS.has(path.posix.extname(entry).toLowerCase()) || !files.has(entry)) {
      throw pluginError('plugins.manifest.documentViews', 'Document viewer entry must reference an included JavaScript file.');
    }
    executableFiles.add(entry);
    const resources = viewer.resources === undefined ? [] : viewer.resources;
    if (!Array.isArray(resources) || resources.length > 16) {
      throw pluginError('plugins.manifest.documentViews', 'Document viewer resources must be a bounded array.');
    }
    const normalizedResources = resources.map((resource) => normalizeRelativePath(resource, 'Document viewer resource'));
    if (new Set(normalizedResources).size !== normalizedResources.length || normalizedResources.some((resource) => (
      !files.has(resource) || !DOCUMENT_VIEW_RESOURCE_EXTENSIONS.has(path.posix.extname(resource).toLowerCase())
    ))) {
      throw pluginError('plugins.manifest.documentViews', 'Document viewer resources must reference unique included text resources.');
    }
    normalizedResources.forEach((resource) => {
      if (SCRIPT_EXTENSIONS.has(path.posix.extname(resource).toLowerCase())) executableFiles.add(resource);
    });
    const priority = viewer.priority === undefined ? 0 : viewer.priority;
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
      throw pluginError('plugins.manifest.documentViews', 'Document viewer priority must be an integer from -1000 to 1000.');
    }
    return { id: viewerId, extensions, entry, resources: normalizedResources, priority };
  });
  return { contributes: normalized, executableFiles };
}

function validateLocalization(localization, files) {
  if (!isPlainObject(localization)) throw pluginError('plugins.manifest.localization', 'Plugin localization must be an object.');
  for (const [locale, filePath] of Object.entries(localization)) {
    if (!/^(default|en|zh-CN|ja)$/.test(locale)) {
      throw pluginError('plugins.manifest.localization', 'Plugin localization uses an unsupported locale: ' + locale);
    }
    const normalized = normalizeRelativePath(filePath, 'Localization path');
    if (!files.has(normalized) || path.posix.extname(normalized) !== '.json') {
      throw pluginError('plugins.manifest.localization', 'Plugin localization must reference a declared JSON file.');
    }
  }
}

function normalizePluginLocale(value) {
  return value === 'zh-CN' || value === 'ja' || value === 'en' ? value : 'en';
}

function selectLocalizationPath(localization, locale) {
  const values = localization && typeof localization === 'object' ? localization : {};
  const requested = normalizePluginLocale(locale);
  return values[requested] || values.default || values.en || null;
}

function parseLocalizationMessages(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (_) {
    throw pluginError('plugins.localization.json', 'Plugin localization JSON is invalid.');
  }
  if (!isPlainObject(value)) {
    throw pluginError('plugins.localization.invalid', 'Plugin localization must be a flat JSON object.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_LOCALIZATION_ENTRIES) {
    throw pluginError('plugins.localization.size', 'Plugin localization contains too many messages.');
  }
  const messages = Object.create(null);
  for (const [key, message] of entries) {
    if (!isNonEmptyString(key, MAX_LOCALIZATION_KEY_LENGTH) || key.includes('\0') ||
        typeof message !== 'string' || message.length > MAX_LOCALIZATION_VALUE_LENGTH) {
      throw pluginError('plugins.localization.invalid', 'Plugin localization contains an invalid message.');
    }
    messages[key] = message;
  }
  return immutable(messages);
}

function validateIntegrity(value, files, main, options = {}) {
  if (!isPlainObject(value) || value.algorithm !== 'sha256' || !isPlainObject(value.files)) {
    throw pluginError('plugins.manifest.integrity', 'Plugin manifest must contain a SHA-256 integrity.files map.');
  }
  const hashes = {};
  const keys = Object.keys(value.files);
  if (keys.length === 0 || keys.length > MAX_FILE_COUNT) {
    throw pluginError('plugins.manifest.integrity', 'Plugin integrity.files is invalid.');
  }
  for (const key of keys) {
    const normalized = normalizeRelativePath(key, 'Integrity file path');
    if (normalized !== key || normalized === 'manifest.json' || !/^[a-f0-9]{64}$/.test(String(value.files[key] || ''))) {
      throw pluginError('plugins.manifest.integrity', 'Plugin integrity.files contains an invalid SHA-256 entry.');
    }
    hashes[normalized] = String(value.files[key]);
  }
  const actual = Array.from(files).filter((file) => file !== 'manifest.json').sort();
  const declared = Object.keys(hashes).sort();
  if (actual.length !== declared.length || actual.some((file, index) => file !== declared[index])) {
    throw pluginError('plugins.manifest.integrity', 'Plugin integrity.files must cover every package file exactly once.');
  }
  if (!Object.hasOwn(hashes, main)) throw pluginError('plugins.manifest.integrity', 'Plugin main entry must have an integrity hash.');
  const scripts = actual.filter((file) => SCRIPT_EXTENSIONS.has(path.posix.extname(file).toLowerCase()));
  if (options.schemaVersion === 1 && (scripts.length !== 1 || scripts[0] !== main)) {
    throw pluginError('plugins.manifest.main', 'Plugin v1 packages must contain one bundled JavaScript entry and no relative code modules.');
  }
  if (options.schemaVersion === 2) {
    const allowedScripts = new Set([main, ...Array.from(options.executableFiles || [])]);
    if (scripts.length !== allowedScripts.size || scripts.some((script) => !allowedScripts.has(script))) {
      throw pluginError('plugins.manifest.main', 'Plugin v2 scripts must be declared as the main entry or a document-view resource.');
    }
  }
  return immutable({ algorithm: 'sha256', files: hashes });
}

function directoryInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

async function listPackageFiles(root, options = {}) {
  const result = [];
  let totalBytes = 0;
  const allowReceipt = options.allowReceipt === true;

  async function walk(absolute, relative) {
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? relative + '/' + entry.name : entry.name;
      if (childRelative === INSTALL_RECEIPT) {
        const receiptStat = await fsp.lstat(path.join(absolute, entry.name));
        if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > MAX_MANIFEST_BYTES || (receiptStat.mode & 0o111) !== 0) {
          throw pluginError('plugins.package.receipt', 'Plugin installation receipt must be a regular file.');
        }
        if (allowReceipt) continue;
        throw pluginError('plugins.package.reserved', 'Plugin package contains a host-reserved file.');
      }
      if (childRelative === REGISTRY_FILE || childRelative === PERMISSIONS_FILE) {
        throw pluginError('plugins.package.reserved', 'Plugin package contains a host-reserved file.');
      }
      const normalized = normalizeRelativePath(childRelative, 'Package path');
      const child = path.join(absolute, entry.name);
      const stat = await fsp.lstat(child);
      if (stat.isSymbolicLink()) throw pluginError('plugins.package.symlink', 'Plugin packages cannot contain symbolic links.');
      if (stat.isDirectory()) {
        await walk(child, normalized);
        continue;
      }
      if (!stat.isFile()) throw pluginError('plugins.package.special', 'Plugin packages cannot contain special files.');
      if ((stat.mode & 0o111) !== 0) throw pluginError('plugins.package.executable', 'Plugin packages cannot contain executable files.');
      assertAllowedPackageFile(normalized);
      if (stat.size > MAX_FILE_BYTES) throw pluginError('plugins.package.fileSize', 'Plugin file exceeds the size limit: ' + normalized);
      totalBytes += stat.size;
      if (totalBytes > MAX_PACKAGE_BYTES) throw pluginError('plugins.package.size', 'Plugin package exceeds the size limit.');
      result.push(normalized);
      if (result.length > MAX_FILE_COUNT) throw pluginError('plugins.package.fileCount', 'Plugin package contains too many files.');
    }
  }

  await walk(root, '');
  return result.sort();
}

async function copyPackageDirectory(source, destination) {
  const sourceRoot = path.resolve(source);
  const stat = await fsp.lstat(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw pluginError('plugins.install.source', 'Plugin source must be a regular directory.');
  let copiedBytes = 0;
  let copiedFiles = 0;
  async function copyDirectory(from, to, relative) {
    await fsp.mkdir(to, { recursive: true, mode: 0o700 });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? relative + '/' + entry.name : entry.name;
      if (childRelative === INSTALL_RECEIPT || childRelative === REGISTRY_FILE || childRelative === PERMISSIONS_FILE) {
        throw pluginError('plugins.package.reserved', 'Plugin package contains a host-reserved file.');
      }
      const normalized = normalizeRelativePath(childRelative, 'Package path');
      const fromChild = path.join(from, entry.name);
      const toChild = path.join(to, entry.name);
      const childStat = await fsp.lstat(fromChild);
      if (childStat.isSymbolicLink()) throw pluginError('plugins.package.symlink', 'Plugin packages cannot contain symbolic links.');
      if (childStat.isDirectory()) {
        await copyDirectory(fromChild, toChild, normalized);
        continue;
      }
      if (!childStat.isFile()) throw pluginError('plugins.package.special', 'Plugin packages cannot contain special files.');
      if ((childStat.mode & 0o111) !== 0) throw pluginError('plugins.package.executable', 'Plugin packages cannot contain executable files.');
      assertAllowedPackageFile(normalized);
      if (childStat.size > MAX_FILE_BYTES) throw pluginError('plugins.package.fileSize', 'Plugin file exceeds the size limit: ' + normalized);
      copiedBytes += childStat.size;
      copiedFiles += 1;
      if (copiedBytes > MAX_PACKAGE_BYTES || copiedFiles > MAX_FILE_COUNT) {
        throw pluginError('plugins.package.size', 'Plugin package exceeds the supported limits.');
      }
      await fsp.copyFile(fromChild, toChild, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(toChild, 0o600);
    }
  }
  await copyDirectory(sourceRoot, destination, '');
}

function findZipEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0x10000 - 22);
  for (let index = buffer.length - 22; index >= start; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw pluginError('plugins.zip.invalid', 'Plugin archive has no ZIP central directory.');
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ARCHIVE_BYTES) {
    throw pluginError('plugins.zip.size', 'Plugin archive exceeds the supported size limit.');
  }
  const end = findZipEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw pluginError('plugins.zip.format', 'Plugin archives must be a single-disk non-ZIP64 ZIP file.');
  }
  if (count === 0 || count > MAX_FILE_COUNT || centralOffset + centralSize > end) {
    throw pluginError('plugins.zip.format', 'Plugin archive central directory is invalid.');
  }
  let offset = centralOffset;
  let totalBytes = 0;
  const entryKinds = new Map();
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw pluginError('plugins.zip.format', 'Plugin archive central directory entry is invalid.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > buffer.length || diskStart !== 0 || (flags & 0x1) !== 0 || ![0, 8].includes(method)) {
      throw pluginError('plugins.zip.format', 'Plugin archive contains an unsupported ZIP entry.');
    }
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (rawName.includes('\uFFFD')) throw pluginError('plugins.zip.path', 'Plugin archive contains an invalid UTF-8 path.');
    const isDirectory = rawName.endsWith('/');
    const name = isDirectory ? rawName.slice(0, -1) : rawName;
    if (!name) {
      offset = recordEnd;
      continue;
    }
    const normalized = normalizeRelativePath(name, 'Archive path');
    if (entryKinds.has(normalized)) throw pluginError('plugins.zip.path', 'Plugin archive contains duplicate paths.');
    entryKinds.set(normalized, isDirectory ? 'directory' : 'file');
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000 || (!isDirectory && (unixMode & 0o111) !== 0)) {
      throw pluginError('plugins.zip.executable', 'Plugin archive contains a symbolic link or executable file.');
    }
    if (!isDirectory) {
      assertAllowedPackageFile(normalized);
      if (uncompressedSize > MAX_FILE_BYTES) throw pluginError('plugins.zip.fileSize', 'Plugin archive file exceeds the size limit: ' + normalized);
      totalBytes += uncompressedSize;
      if (totalBytes > MAX_PACKAGE_BYTES) throw pluginError('plugins.zip.size', 'Plugin archive expands beyond the size limit.');
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw pluginError('plugins.zip.format', 'Plugin archive local file entry is invalid.');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw pluginError('plugins.zip.format', 'Plugin archive data range is invalid.');
    entries.push({ name: normalized, isDirectory, method, compressedSize, uncompressedSize, dataStart, dataEnd });
    offset = recordEnd;
  }
  for (const entry of entries) {
    const pieces = entry.name.split('/');
    for (let index = 1; index < pieces.length; index += 1) {
      const parent = pieces.slice(0, index).join('/');
      if (entryKinds.get(parent) === 'file') {
        throw pluginError('plugins.zip.path', 'Plugin archive has a file-directory path collision.');
      }
    }
  }
  return entries;
}

async function extractPluginZip(zipPath, destination) {
  const buffer = await fsp.readFile(zipPath);
  const entries = readZipEntries(buffer);
  for (const entry of entries) {
    const target = path.join(destination, ...entry.name.split('/'));
    if (!directoryInside(destination, target)) throw pluginError('plugins.zip.path', 'Plugin archive path escapes its staging directory.');
    if (entry.isDirectory) {
      await fsp.mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    const compressed = buffer.subarray(entry.dataStart, entry.dataEnd);
    let content;
    try {
      content = entry.method === 0
        ? compressed
        : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES });
    } catch (error) {
      throw pluginError('plugins.zip.inflate', 'Plugin archive entry could not be decompressed: ' + entry.name);
    }
    if (content.length !== entry.uncompressedSize || content.length > MAX_FILE_BYTES) {
      throw pluginError('plugins.zip.inflate', 'Plugin archive entry size is invalid: ' + entry.name);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.writeFile(target, content, { mode: 0o600, flag: 'wx' });
  }
}

async function readManifest(root) {
  const manifestPath = path.join(root, 'manifest.json');
  const stat = await fsp.lstat(manifestPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw pluginError('plugins.manifest.missing', 'Plugin package must contain a bounded root manifest.json file.');
  }
  const source = await fsp.readFile(manifestPath, 'utf8');
  try {
    return { manifest: JSON.parse(source), source };
  } catch (_) {
    throw pluginError('plugins.manifest.json', 'Plugin manifest.json is not valid JSON.');
  }
}

async function validatePackageDirectory(root, hostVersion, options = {}) {
  const files = new Set(await listPackageFiles(root, { allowReceipt: options.requireReceipt === true }));
  if (!files.has('manifest.json')) throw pluginError('plugins.manifest.missing', 'Plugin package must contain root manifest.json.');
  const { manifest, source } = await readManifest(root);
  const normalized = validateManifest(manifest, files, hostVersion);
  for (const [relativePath, expectedHash] of Object.entries(normalized.integrity.files)) {
    const actualHash = await sha256File(path.join(root, ...relativePath.split('/')));
    if (actualHash !== expectedHash) {
      throw pluginError('plugins.integrity.mismatch', 'Plugin file integrity check failed: ' + relativePath);
    }
  }
  if (options.requireReceipt) {
    const receiptPath = path.join(root, INSTALL_RECEIPT);
    const receiptSource = await fsp.readFile(receiptPath, 'utf8').catch(() => '');
    let receipt;
    try { receipt = JSON.parse(receiptSource); } catch (_) { receipt = null; }
    if (!isPlainObject(receipt) || receipt.schemaVersion !== STATE_SCHEMA_VERSION || receipt.id !== normalized.id ||
      receipt.version !== normalized.version || receipt.manifestSha256 !== sha256(source)) {
      throw pluginError('plugins.integrity.receipt', 'Plugin installation receipt is missing or does not match the package.');
    }
  }
  return { manifest: normalized, manifestSource: source, files: Array.from(files).sort() };
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, '.' + path.basename(filePath) + '.' + crypto.randomUUID() + '.tmp');
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

function defaultRegistry() {
  return { schemaVersion: STATE_SCHEMA_VERSION, plugins: {} };
}

function defaultPermissions() {
  return { schemaVersion: PERMISSIONS_SCHEMA_VERSION, grants: {}, initialized: {} };
}

function defaultInstallDialogState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, lastDirectory: '' };
}

async function readJsonFile(filePath, fallback) {
  return (await readJsonFileState(filePath, fallback)).value;
}

function unavailableAgentApproval(error) {
  const code = error && error.code;
  const tool = error && (error.approvalTool === 'workspace_write' || error.approvalTool === 'process_run')
    ? error.approvalTool
    : '';
  if (code === 'AGENT_APPROVAL_EXPIRED') {
    const result = {
      approvalUnavailable: true,
      errorCode: code,
      errorMessage: 'The Agent approval expired before the operation could start.'
    };
    if (tool) result.tool = tool;
    return result;
  }
  if (code === 'AGENT_APPROVAL_NOT_FOUND') {
    const result = {
      approvalUnavailable: true,
      errorCode: code,
      errorMessage: 'The Agent approval is missing or no longer valid.'
    };
    if (tool) result.tool = tool;
    return result;
  }
  return null;
}

async function readJsonFileState(filePath, fallback) {
  try {
    const source = await fsp.readFile(filePath, 'utf8');
    const value = JSON.parse(source);
    return isPlainObject(value)
      ? { status: 'valid', value }
      : { status: 'invalid', value: fallback() };
  } catch (error) {
    return {
      status: error && error.code === 'ENOENT' ? 'missing' : 'invalid',
      value: fallback()
    };
  }
}

function normalizedRegistry(value) {
  const result = defaultRegistry();
  if (!isPlainObject(value) || value.schemaVersion !== STATE_SCHEMA_VERSION || !isPlainObject(value.plugins)) return result;
  for (const [id, record] of Object.entries(value.plugins)) {
    if (!isSafePluginId(id) || !isPlainObject(record)) continue;
    result.plugins[id] = {
      enabled: record.enabled === true,
      installedAt: isNonEmptyString(record.installedAt, 80) ? record.installedAt : '',
      version: isValidSemver(record.version) ? record.version : ''
    };
  }
  return result;
}

function normalizedPermissions(value) {
  const result = defaultPermissions();
  if (!isPlainObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== PERMISSIONS_SCHEMA_VERSION) || !isPlainObject(value.grants)) return result;
  for (const [id, permissions] of Object.entries(value.grants)) {
    if (!isSafePluginId(id) || !Array.isArray(permissions)) continue;
    result.grants[id] = [...new Set(permissions.filter((permission) => KNOWN_PERMISSIONS.has(permission)))].sort();
  }
  if (value.schemaVersion === PERMISSIONS_SCHEMA_VERSION && isPlainObject(value.initialized)) {
    for (const [id, initialized] of Object.entries(value.initialized)) {
      if (isSafePluginId(id) && initialized === true) result.initialized[id] = true;
    }
  }
  return result;
}

function isValidPermissionsState(value) {
  if (!isPlainObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== PERMISSIONS_SCHEMA_VERSION) ||
      !isPlainObject(value.grants)) return false;
  for (const [id, grants] of Object.entries(value.grants)) {
    if (!isSafePluginId(id) || !Array.isArray(grants) || grants.some((permission) => typeof permission !== 'string')) {
      return false;
    }
  }
  if (value.schemaVersion === PERMISSIONS_SCHEMA_VERSION) {
    if (!isPlainObject(value.initialized)) return false;
    for (const [id, initialized] of Object.entries(value.initialized)) {
      if (!isSafePluginId(id) || initialized !== true) return false;
    }
  }
  return true;
}

function normalizedInstallDialogState(value) {
  const result = defaultInstallDialogState();
  if (!isPlainObject(value) || value.schemaVersion !== STATE_SCHEMA_VERSION) return result;
  if (isNonEmptyString(value.lastDirectory, 32767) && path.isAbsolute(value.lastDirectory)) {
    result.lastDirectory = value.lastDirectory;
  }
  return result;
}

function safeManifestDescriptor(manifest) {
  return immutable({
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    engines: cloneJson(manifest.engines),
    main: manifest.main,
    activationEvents: [...manifest.activationEvents],
    permissions: [...manifest.permissions],
    contributes: cloneJson(manifest.contributes),
    localization: cloneJson(manifest.localization)
  });
}

function safeStatus(record) {
  return immutable({
    id: record.id,
    displayName: record.displayName,
    description: record.description,
    version: record.version,
    enabled: record.enabled === true,
    status: record.status,
    requestedPermissions: [...record.requestedPermissions],
    grantedPermissions: [...record.grantedPermissions],
    manifest: record.manifest ? cloneJson(record.manifest) : null,
    integrity: cloneJson(record.integrity),
    installedAt: record.installedAt
  });
}

function createPluginController(options) {
  if (!options || !options.app || !options.ipcMain || !options.getWindow) {
    throw new TypeError('createPluginController requires app, ipcMain, and getWindow.');
  }
  const app = options.app;
  const ipcMain = options.ipcMain;
  const dialog = options.dialog;
  const shell = options.shell;
  const getWindow = options.getWindow;
  const hostVersion = String(options.hostVersion || (typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'));
  const onDidChange = typeof options.onDidChange === 'function' ? options.onDidChange : () => {};
  const agentBroker = options.agentBroker && typeof options.agentBroker.request === 'function' ? options.agentBroker : null;
  const pluginRoot = path.join(app.getPath('userData'), 'plugins');
  const registryPath = path.join(pluginRoot, REGISTRY_FILE);
  const permissionsPath = path.join(pluginRoot, PERMISSIONS_FILE);
  const installDialogStatePath = path.join(pluginRoot, INSTALL_DIALOG_STATE_FILE);
  const installImportRoot = path.join(pluginRoot, INSTALL_IMPORT_DIRECTORY);
  const stagingRoot = path.join(pluginRoot, STAGING_DIRECTORY);
  const trashRoot = path.join(pluginRoot, TRASH_DIRECTORY);
  // Privileged SCM execution lives in a separate local-only broker. It is
  // optional in tests or legacy composition roots without a workspace owner;
  // an installed package still cannot fall back to arbitrary IPC when absent.
  const scmGit = options.scmGit || (typeof options.getWorkspaceIdentity === 'function'
    ? createScmGitBroker({
      getWorkspaceIdentity: options.getWorkspaceIdentity,
      hooksDirectory: path.join(app.getPath('userData'), 'scm-git-hooks')
    })
    : null);
  let registry = defaultRegistry();
  let permissions = defaultPermissions();
  let records = new Map();
  let initialized = false;
  let initializePromise = null;
  let mutationQueue = Promise.resolve();

  function documentViewerForRecord(record, viewerId, requireReadPermission = true) {
    if (!record || record.status !== 'enabled' || !record.integrity.valid || !record.manifest) {
      throw pluginError('plugins.documentView.denied', 'Document viewer is only available from an enabled, verified plugin.');
    }
    if (!record.grantedPermissions.includes(PluginPermission.DOCUMENT_VIEWS_REGISTER) ||
        (requireReadPermission && !record.grantedPermissions.includes(PluginPermission.DOCUMENTS_READ))) {
      throw pluginError('plugins.documentView.permission', 'Document viewer permissions have not been granted.');
    }
    const viewers = record.manifest.contributes && record.manifest.contributes.documentViewers;
    const viewer = Array.isArray(viewers) ? viewers.find((candidate) => candidate.id === viewerId) : null;
    if (!viewer) throw pluginError('plugins.documentView.notFound', 'Document viewer is not declared by this plugin.');
    return viewer;
  }

  function authorizeDocumentViewer(pluginId, viewerId, requireReadPermission = true) {
    const record = records.get(assertSafePluginId(pluginId));
    return documentViewerForRecord(record, viewerId, requireReadPermission);
  }

  const documentBroker = typeof options.resolveWorkspaceFile === 'function' && typeof options.getWorkspaceIdentity === 'function'
    ? createPluginDocumentBroker({
      resolveWorkspaceFile: options.resolveWorkspaceFile,
      getWorkspaceIdentity: options.getWorkspaceIdentity,
      authorize: (pluginId, viewerId) => authorizeDocumentViewer(pluginId, viewerId, true)
    })
    : null;

  function packagePath(id) {
    assertSafePluginId(id);
    const target = path.join(pluginRoot, id);
    if (!directoryInside(pluginRoot, target)) throw pluginError('plugins.id.path', 'Plugin id resolves outside the plugin directory.');
    return target;
  }

  function trustedSender(event) {
    if (!event || !event.sender) return;
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents !== event.sender) {
      throw pluginError('plugins.ipc.sender', 'Plugin IPC request did not come from the workbench window.');
    }
  }

  function currentList() {
    return immutable(Array.from(records.values(), safeStatus).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)));
  }

  function emitChanged(reason) {
    if (agentBroker && typeof agentBroker.disposePlugin === 'function') {
      for (const record of records.values()) {
        if (record.status !== 'enabled') agentBroker.disposePlugin(record.id);
      }
    }
    const payload = immutable({ reason, plugins: currentList() });
    const window = getWindow();
    if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
      window.webContents.send('plugins:changed', payload);
    }
    try { onDidChange(payload); } catch (_) {}
  }

  async function persistRegistry() {
    await writeJsonAtomic(registryPath, registry);
  }

  async function persistPermissions() {
    await writeJsonAtomic(permissionsPath, permissions);
  }

  async function ensureRoot() {
    await fsp.mkdir(pluginRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(installImportRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(trashRoot, { recursive: true, mode: 0o700 });
  }

  async function inspectInstalledPackage(id) {
    const root = packagePath(id);
    try {
      const checked = await validatePackageDirectory(root, hostVersion, { requireReceipt: true });
      const state = registry.plugins[id] || {};
      const requested = checked.manifest.permissions;
      const granted = (permissions.grants[id] || []).filter((permission) => requested.includes(permission));
      return {
        id,
        displayName: checked.manifest.displayName,
        description: checked.manifest.description,
        version: checked.manifest.version,
        enabled: state.enabled === true,
        status: state.enabled === true ? 'enabled' : 'disabled',
        requestedPermissions: [...requested],
        grantedPermissions: [...granted],
        manifest: safeManifestDescriptor(checked.manifest),
        revision: sha256(checked.manifestSource),
        entryHash: checked.manifest.integrity.files[checked.manifest.main],
        fileHashes: checked.manifest.integrity.files,
        integrity: { valid: true, reason: '' },
        installedAt: state.installedAt || ''
      };
    } catch (error) {
      const state = registry.plugins[id] || {};
      const incompatible = error && (error.code === 'plugins.manifest.api' || error.code === 'plugins.manifest.host');
      return {
        id,
        displayName: id,
        description: '',
        version: state.version || '',
        enabled: false,
        status: incompatible ? 'incompatible' : 'invalid',
        requestedPermissions: [],
        grantedPermissions: [],
        manifest: null,
        revision: '',
        entryHash: '',
        fileHashes: {},
        integrity: { valid: false, reason: error && error.code ? error.code : 'plugins.integrity.invalid' },
        installedAt: state.installedAt || ''
      };
    }
  }

  async function scanInstalled() {
    await ensureRoot();
    registry = normalizedRegistry(await readJsonFile(registryPath, defaultRegistry));
    const permissionsFile = await readJsonFileState(permissionsPath, defaultPermissions);
    const permissionsTrusted = permissionsFile.status === 'valid' && isValidPermissionsState(permissionsFile.value);
    permissions = normalizedPermissions(permissionsFile.value);
    const entries = await fsp.readdir(pluginRoot, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isDirectory() && isSafePluginId(entry.name))
      .map((entry) => entry.name)
      .sort();
    const next = new Map();
    let changed = permissionsFile.status === 'invalid';
    for (const id of ids) {
      const inspected = await inspectInstalledPackage(id);
      if (inspected.integrity.valid && !permissionsTrusted) {
        // A missing or malformed permission file cannot prove prior consent or
        // revocation state. Repair it without silently restoring capabilities.
        permissions.grants[id] = [];
        permissions.initialized[id] = true;
        inspected.grantedPermissions = [];
        if (inspected.requestedPermissions.length > 0 && registry.plugins[id] && registry.plugins[id].enabled === true) {
          registry.plugins[id].enabled = false;
          inspected.enabled = false;
          inspected.status = 'disabled';
        }
        changed = true;
      } else if (inspected.integrity.valid && permissions.initialized[id] !== true) {
        // Permission prompts were removed in API 1.2's installed-extension
        // workflow. A manifest remains the upper bound, but every declared
        // capability is available immediately after installation. The marker
        // distinguishes this one-time migration from an intentional later
        // revocation by the user.
        permissions.grants[id] = [...inspected.requestedPermissions].sort();
        permissions.initialized[id] = true;
        inspected.grantedPermissions = [...inspected.requestedPermissions].sort();
        changed = true;
      }
      next.set(id, inspected);
      // A failed receipt or integrity scan must be sticky: merely restoring a
      // directory later cannot silently reactivate a plugin or its consent.
      if (!inspected.integrity.valid) {
        if (registry.plugins[id] && registry.plugins[id].enabled === true) {
          registry.plugins[id].enabled = false;
          changed = true;
        }
        if (permissions.grants[id] && permissions.grants[id].length > 0) {
          delete permissions.grants[id];
          changed = true;
        }
      }
    }
    for (const id of Object.keys(registry.plugins)) {
      if (!next.has(id)) { delete registry.plugins[id]; changed = true; }
    }
    for (const id of Object.keys(permissions.grants)) {
      if (!next.has(id)) { delete permissions.grants[id]; changed = true; }
    }
    for (const id of Object.keys(permissions.initialized)) {
      if (!next.has(id)) { delete permissions.initialized[id]; changed = true; }
    }
    if (changed) {
      await persistRegistry();
      await persistPermissions();
    }
    records = next;
  }

  async function initialize() {
    if (initialized) return currentList();
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      await scanInstalled();
      initialized = true;
      return currentList();
    })().finally(() => { initializePromise = null; });
    return initializePromise;
  }

  async function refreshInternal(reason = 'manual') {
    await initialize();
    const previousIds = new Set(records.keys());
    await scanInstalled();
    for (const id of previousIds) {
      if (records.has(id)) continue;
      if (documentBroker) documentBroker.closePlugin(id);
      if (agentBroker && typeof agentBroker.disposePlugin === 'function') agentBroker.disposePlugin(id);
    }
    if (documentBroker) {
      for (const record of records.values()) {
        if (record.status !== 'enabled' || !record.integrity.valid) documentBroker.closePlugin(record.id);
      }
    }
    emitChanged(reason);
    return currentList();
  }

  function normalizeExpectedPackageIdentity(value) {
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value)) throw pluginError('plugins.install.identity', 'Expected plugin identity is invalid.');
    const id = assertSafePluginId(value.id);
    if (!isValidSemver(value.version)) throw pluginError('plugins.install.identity', 'Expected plugin version is invalid.');
    if (value.expectedMinimumVersion !== undefined && !isValidSemver(value.expectedMinimumVersion)) {
      throw pluginError('plugins.install.downgrade', 'Expected plugin minimum version is invalid.');
    }
    return {
      id,
      version: String(value.version),
      expectedMinimumVersion: value.expectedMinimumVersion === undefined ? null : String(value.expectedMinimumVersion)
    };
  }

  async function installFromPathInternal(sourcePath, options = {}) {
    await initialize();
    if (!isNonEmptyString(sourcePath, 32767)) throw pluginError('plugins.install.source', 'Plugin package path is invalid.');
    const expectedIdentity = normalizeExpectedPackageIdentity(options.expectedIdentity);
    const source = path.resolve(sourcePath);
    const stat = await fsp.lstat(source).catch(() => null);
    if (!stat || stat.isSymbolicLink()) throw pluginError('plugins.install.source', 'Plugin package path is not available.');
    const stage = path.join(stagingRoot, crypto.randomUUID());
    await fsp.mkdir(stage, { recursive: false, mode: 0o700 });
    try {
      if (stat.isDirectory() && options.archiveOnly !== true) {
        await copyPackageDirectory(source, stage);
      } else if (stat.isFile() && path.extname(source).toLowerCase() === '.boboplugin') {
        await extractPluginZip(source, stage);
      } else {
        throw pluginError('plugins.install.type', options.archiveOnly === true
          ? 'Select a .boboplugin package.'
          : 'Select a .boboplugin package or plugin folder.');
      }
      const checked = await validatePackageDirectory(stage, hostVersion);
      if (expectedIdentity && (checked.manifest.id !== expectedIdentity.id || checked.manifest.version !== expectedIdentity.version)) {
        throw pluginError('plugins.install.identity', 'Downloaded plugin package identity does not match the selected marketplace release.');
      }
      // This check runs inside the serialized mutation, after a marketplace
      // download has finished but before it can replace the package directory.
      // A concurrent local import that installed a newer version therefore wins.
      if (expectedIdentity && expectedIdentity.expectedMinimumVersion) {
        const current = records.get(checked.manifest.id);
        if (current && isValidSemver(current.version) && compareSemver(current.version, expectedIdentity.expectedMinimumVersion) > 0) {
          throw pluginError('plugins.install.downgrade', 'A newer plugin version was installed while this package was downloading.');
        }
      }
      await writeJsonAtomic(path.join(stage, INSTALL_RECEIPT), {
        schemaVersion: STATE_SCHEMA_VERSION,
        id: checked.manifest.id,
        version: checked.manifest.version,
        manifestSha256: sha256(checked.manifestSource),
        installedAt: new Date().toISOString()
      });
      const id = checked.manifest.id;
      const destination = packagePath(id);
      const backup = path.join(trashRoot, id + '.' + crypto.randomUUID());
      const hadExisting = fs.existsSync(destination);
      const previousRegistry = cloneJson(registry);
      const previousPermissions = cloneJson(permissions);
      if (hadExisting) await fsp.rename(destination, backup);
      try {
        await fsp.rename(stage, destination);
        registry.plugins[id] = { enabled: false, installedAt: new Date().toISOString(), version: checked.manifest.version };
        permissions.grants[id] = [...checked.manifest.permissions].sort();
        permissions.initialized[id] = true;
        await persistRegistry();
        await persistPermissions();
      } catch (error) {
        await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
        if (hadExisting && fs.existsSync(backup)) await fsp.rename(backup, destination).catch(() => {});
        registry = previousRegistry;
        permissions = previousPermissions;
        await persistRegistry().catch(() => {});
        await persistPermissions().catch(() => {});
        throw error;
      }
      await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
      await refreshInternal('installed');
      return get(id);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function installFromDialog() {
    if (!dialog || typeof dialog.showOpenDialog !== 'function') throw pluginError('plugins.install.dialog', 'Plugin installation dialog is unavailable.');
    await ensureRoot();
    const storedState = normalizedInstallDialogState(await readJsonFile(installDialogStatePath, defaultInstallDialogState));
    const storedDirectory = storedState.lastDirectory || installImportRoot;
    const storedStat = await fsp.stat(storedDirectory).catch(() => null);
    const defaultPath = storedStat && storedStat.isDirectory() ? storedDirectory : installImportRoot;
    const owner = getWindow();
    const options = {
      title: typeof optionsT === 'function' ? optionsT('Plugin package') : 'Plugin package',
      buttonLabel: typeof optionsT === 'function' ? optionsT('Install') : 'Install',
      defaultPath,
      properties: ['openFile'],
      filters: [{ name: typeof optionsT === 'function' ? optionsT('Plugin package') : 'Plugin package', extensions: ['boboplugin'] }]
    };
    const result = owner && !owner.isDestroyed() ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const selectedPath = result.filePaths[0];
    const selectedStat = await fsp.lstat(selectedPath).catch(() => null);
    if (!selectedStat || !selectedStat.isFile() || path.extname(selectedPath).toLowerCase() !== '.boboplugin') {
      throw pluginError('plugins.install.type', 'Select a .boboplugin package.');
    }
    const selectedDirectory = path.dirname(selectedPath);
    if (path.isAbsolute(selectedDirectory)) {
      await writeJsonAtomic(installDialogStatePath, {
        schemaVersion: STATE_SCHEMA_VERSION,
        lastDirectory: selectedDirectory
      });
    }
    return installArchiveFromPath(selectedPath);
  }

  async function setEnabledInternal(id, enabled) {
    await initialize();
    const record = records.get(assertSafePluginId(id));
    if (!record) throw pluginError('plugins.notFound', 'Plugin is not installed.');
    if (!record.integrity.valid) throw pluginError('plugins.integrity.invalid', 'Plugin integrity must pass before it can be enabled.');
    if (enabled === true && permissions.initialized[id] !== true) {
      permissions.grants[id] = [...record.requestedPermissions].sort();
      permissions.initialized[id] = true;
      await persistPermissions();
    }
    registry.plugins[id] = Object.assign({}, registry.plugins[id], { enabled: enabled === true, version: record.version });
    if (enabled !== true && documentBroker) documentBroker.closePlugin(id);
    await persistRegistry();
    await refreshInternal(enabled === true ? 'enabled' : 'disabled');
    return get(id);
  }

  async function grantInternal(id, permission, granted) {
    await initialize();
    const pluginId = assertSafePluginId(id);
    const record = records.get(pluginId);
    if (!record || !record.integrity.valid) throw pluginError('plugins.notFound', 'Plugin is not available.');
    if (!KNOWN_PERMISSIONS.has(permission) || !record.requestedPermissions.includes(permission)) {
      throw pluginError('plugins.permission.invalid', 'Plugin did not request this permission.');
    }
    const next = new Set(permissions.grants[pluginId] || []);
    if (granted === true) next.add(permission); else next.delete(permission);
    permissions.grants[pluginId] = Array.from(next).sort();
    if (granted !== true && documentBroker &&
        (permission === PluginPermission.DOCUMENT_VIEWS_REGISTER || permission === PluginPermission.DOCUMENTS_READ)) {
      documentBroker.closePlugin(pluginId);
    }
    if (granted !== true && agentBroker && typeof agentBroker.disposePlugin === 'function' && [
      PluginPermission.AGENTS_REGISTER,
      PluginPermission.MODELS_GENERATE,
      PluginPermission.WORKSPACE_READ,
      PluginPermission.WORKSPACE_WRITE,
      PluginPermission.PROCESS_EXECUTE,
      PluginPermission.SKILLS_READ,
      PluginPermission.STORAGE_LOCAL
    ].includes(permission)) {
      agentBroker.disposePlugin(pluginId);
    }
    permissions.initialized[pluginId] = true;
    await persistPermissions();
    await refreshInternal(granted === true ? 'permission-granted' : 'permission-revoked');
    return get(pluginId);
  }

  async function uninstallInternal(id) {
    await initialize();
    const pluginId = assertSafePluginId(id);
    if (!records.has(pluginId)) throw pluginError('plugins.notFound', 'Plugin is not installed.');
    if (documentBroker) documentBroker.closePlugin(pluginId);
    if (agentBroker && typeof agentBroker.disposePlugin === 'function') agentBroker.disposePlugin(pluginId);
    const destination = packagePath(pluginId);
    const backup = path.join(trashRoot, pluginId + '.' + crypto.randomUUID());
    await fsp.rename(destination, backup);
    const previousRegistry = cloneJson(registry);
    const previousPermissions = cloneJson(permissions);
    try {
      delete registry.plugins[pluginId];
      delete permissions.grants[pluginId];
      delete permissions.initialized[pluginId];
      await persistRegistry();
      await persistPermissions();
    } catch (error) {
      registry = previousRegistry;
      permissions = previousPermissions;
      await fsp.rename(backup, destination).catch(() => {});
      await persistRegistry().catch(() => {});
      await persistPermissions().catch(() => {});
      throw error;
    }
    await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    await refreshInternal('uninstalled');
    return { id: pluginId, removed: true };
  }

  function enqueueMutation(work) {
    const pending = mutationQueue.then(work, work);
    // Keep the queue usable after a rejected install or filesystem operation.
    mutationQueue = pending.catch(() => {});
    return pending;
  }

  function refresh(reason = 'manual') {
    return enqueueMutation(() => refreshInternal(reason));
  }

  function installFromPath(sourcePath) {
    return enqueueMutation(() => installFromPathInternal(sourcePath));
  }

  // Directory installs remain an internal developer/test workflow. User-facing
  // imports and marketplace downloads always use this archive-only route.
  function installArchiveFromPath(sourcePath, expectedIdentity) {
    return enqueueMutation(() => installFromPathInternal(sourcePath, {
      archiveOnly: true,
      expectedIdentity
    }));
  }

  function setEnabled(id, enabled) {
    return enqueueMutation(() => setEnabledInternal(id, enabled));
  }

  function grant(id, permission, granted) {
    return enqueueMutation(() => grantInternal(id, permission, granted));
  }

  function uninstall(id) {
    return enqueueMutation(() => uninstallInternal(id));
  }

  function get(id) {
    const record = records.get(assertSafePluginId(id));
    return record ? safeStatus(record) : null;
  }

  function runtimeDescriptors() {
    const descriptors = [];
    for (const record of records.values()) {
      if (record.status !== 'enabled' || !record.integrity.valid || !record.manifest) continue;
      descriptors.push(immutable({
        id: record.id,
        manifest: record.manifest,
        grantedPermissions: [...record.grantedPermissions],
        revision: record.revision
      }));
    }
    return immutable(descriptors.sort((left, right) => left.id.localeCompare(right.id)));
  }

  async function loadEntry(id) {
    await initialize();
    const record = records.get(assertSafePluginId(id));
    if (!record || record.status !== 'enabled' || !record.integrity.valid || !record.manifest) {
      throw pluginError('plugins.entry.denied', 'Plugin entry is only available to enabled, verified plugins.');
    }
    const entryPath = path.join(packagePath(record.id), ...record.manifest.main.split('/'));
    if (!directoryInside(packagePath(record.id), entryPath)) throw pluginError('plugins.entry.path', 'Plugin entry resolves outside its package.');
    const source = await fsp.readFile(entryPath, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_ENTRY_BYTES) throw pluginError('plugins.entry.size', 'Plugin entry exceeds the renderer source limit.');
    const expected = record.entryHash;
    if (sha256(source) !== expected) {
      await refresh('integrity-failed');
      throw pluginError('plugins.integrity.mismatch', 'Plugin entry integrity check failed.');
    }
    return immutable({ id: record.id, main: record.manifest.main, source, hash: expected });
  }

  // Package locale files are data, not extension source. Keep the same
  // enabled/integrity gate as loadEntry and return only the selected flat
  // message table so renderer code never learns the installed package path.
  async function loadLocalization(id, locale) {
    await initialize();
    const record = records.get(assertSafePluginId(id));
    if (!record || record.status !== 'enabled' || !record.integrity.valid || !record.manifest) {
      throw pluginError('plugins.localization.denied', 'Plugin localization is only available to enabled, verified plugins.');
    }
    const selectedLocale = normalizePluginLocale(locale);
    const relativePath = selectLocalizationPath(record.manifest.localization, selectedLocale);
    if (!relativePath) return immutable({ locale: selectedLocale, messages: {} });
    const absolutePath = path.join(packagePath(record.id), ...relativePath.split('/'));
    if (!directoryInside(packagePath(record.id), absolutePath)) {
      throw pluginError('plugins.localization.path', 'Plugin localization resolves outside its package.');
    }
    const stat = await fsp.lstat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOCALIZATION_BYTES) {
      await refresh('integrity-failed');
      throw pluginError('plugins.localization.size', 'Plugin localization file is unavailable or exceeds the host limit.');
    }
    const source = await fsp.readFile(absolutePath, 'utf8');
    const expected = record.fileHashes && record.fileHashes[relativePath];
    if (!expected || sha256(source) !== expected) {
      await refresh('integrity-failed');
      throw pluginError('plugins.integrity.mismatch', 'Plugin localization integrity check failed.');
    }
    return immutable({ locale: selectedLocale, messages: parseLocalizationMessages(source) });
  }

  function documentViewMimeType(relativePath) {
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (extension === '.css') return 'text/css';
    if (extension === '.json') return 'application/json';
    if (extension === '.svg') return 'image/svg+xml';
    if (extension === '.js' || extension === '.mjs') return 'text/javascript';
    return 'text/plain';
  }

  async function loadVerifiedDocumentViewFile(record, relativePath, maximumBytes) {
    const absolutePath = path.join(packagePath(record.id), ...relativePath.split('/'));
    if (!directoryInside(packagePath(record.id), absolutePath)) {
      throw pluginError('plugins.documentView.path', 'Document viewer resource resolves outside its package.');
    }
    const stat = await fsp.lstat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
      throw pluginError('plugins.documentView.size', 'Document viewer resource is unavailable or exceeds the host limit.');
    }
    const source = await fsp.readFile(absolutePath, 'utf8');
    const expected = record.fileHashes && record.fileHashes[relativePath];
    if (!expected || sha256(source) !== expected) {
      await refresh('integrity-failed');
      throw pluginError('plugins.integrity.mismatch', 'Document viewer resource integrity check failed.');
    }
    return { path: relativePath, source, hash: expected, mimeType: documentViewMimeType(relativePath) };
  }

  async function loadDocumentView(id, viewerId) {
    await initialize();
    const pluginId = assertSafePluginId(id);
    const record = records.get(pluginId);
    const viewer = documentViewerForRecord(record, viewerId, true);
    const entry = await loadVerifiedDocumentViewFile(record, viewer.entry, MAX_DOCUMENT_VIEW_ENTRY_BYTES);
    const resources = [];
    let totalBytes = Buffer.byteLength(entry.source, 'utf8');
    for (const resourcePath of viewer.resources) {
      const resource = await loadVerifiedDocumentViewFile(record, resourcePath, MAX_DOCUMENT_VIEW_RESOURCE_BYTES);
      totalBytes += Buffer.byteLength(resource.source, 'utf8');
      if (totalBytes > MAX_DOCUMENT_VIEW_TOTAL_BYTES) {
        throw pluginError('plugins.documentView.size', 'Document viewer source exceeds the combined host limit.');
      }
      resources.push(resource);
    }
    return immutable({
      pluginId,
      viewer: cloneJson(viewer),
      entry,
      resources
    });
  }

  function validateRpcArguments(args, maximumBytes = MAX_RPC_ARGUMENT_BYTES) {
    try {
      const encoded = JSON.stringify(args === undefined ? null : args);
      if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) throw new Error('large');
      return cloneJson(args === undefined ? null : args);
    } catch (_) {
      throw pluginError('plugins.rpc.args', 'Plugin RPC arguments must be bounded JSON data.');
    }
  }

  async function rpc(id, method, args) {
    await initialize();
    const pluginId = assertSafePluginId(id);
    const record = records.get(pluginId);
    if (!record || record.status !== 'enabled' || !record.integrity.valid || !record.manifest) {
      throw pluginError('plugins.rpc.plugin', 'Plugin RPC is only available to enabled, verified plugins.');
    }
    if (!isNonEmptyString(method, 120)) {
      throw pluginError('plugins.rpc.denied', 'Plugin RPC method is invalid.');
    }
    const agentMethod = method === 'models.generate' || method === 'models.generateStream' || method.startsWith('agent.');
    const payload = validateRpcArguments(args, agentMethod ? MAX_AGENT_RPC_ARGUMENT_BYTES : MAX_RPC_ARGUMENT_BYTES);
    const permissionForMethod = Object.assign({
      'commands.register': PluginPermission.COMMANDS_REGISTER,
      'commands.execute': PluginPermission.COMMANDS_EXECUTE,
      'contributions.register': PluginPermission.CONTRIBUTIONS_REGISTER,
      'services.get': PluginPermission.SERVICES_READ,
      'sourceControl.register': PluginPermission.SOURCE_CONTROL_REGISTER,
      'fileDecorations.scm.register': PluginPermission.FILE_DECORATIONS_SCM,
      'documentViews.register': PluginPermission.DOCUMENT_VIEWS_REGISTER,
      'agents.register': PluginPermission.AGENTS_REGISTER,
      'models.list': PluginPermission.MODELS_GENERATE,
      'models.generate': PluginPermission.MODELS_GENERATE,
      'models.generateStream': PluginPermission.MODELS_GENERATE,
      'models.cancel': PluginPermission.MODELS_GENERATE,
      'agent.storage.read': PluginPermission.STORAGE_LOCAL,
      'agent.storage.write': PluginPermission.STORAGE_LOCAL,
      'agent.skills.list': PluginPermission.SKILLS_READ,
      'agent.skills.read': PluginPermission.SKILLS_READ,
      'agent.tools.list': PluginPermission.AGENTS_REGISTER
    }, SCM_GIT_METHODS);
    if (method === 'host.getInfo') {
      return immutable({ apiVersion: PLUGIN_API_VERSION, plugin: { id: pluginId, version: record.version } });
    }
    if (method === 'permissions.get') {
      return immutable({ requested: [...record.requestedPermissions], granted: [...record.grantedPermissions] });
    }
    if (method === 'agent.lifecycle.dispose') {
      if (agentBroker && typeof agentBroker.disposePlugin === 'function') agentBroker.disposePlugin(pluginId);
      return immutable({ disposed: true });
    }
    let permission = permissionForMethod[method];
    if (method === 'agent.tools.invoke') {
      const tool = payload && payload.tool;
      if (tool === 'workspace_list' || tool === 'workspace_read' || tool === 'workspace_search') permission = PluginPermission.WORKSPACE_READ;
      else if (tool === 'workspace_write') permission = PluginPermission.WORKSPACE_WRITE;
      else if (tool === 'process_run') permission = PluginPermission.PROCESS_EXECUTE;
    }
    if (!permission) throw pluginError('plugins.rpc.denied', 'Plugin RPC method is not available: ' + String(method));
    if (!record.grantedPermissions.includes(permission)) {
      throw pluginError('plugins.rpc.permission', 'Plugin permission has not been granted: ' + permission);
    }
    if (!isPlainObject(payload)) throw pluginError('plugins.rpc.args', 'Plugin RPC payload must be an object.');
    if (Object.hasOwn(SCM_GIT_METHODS, method)) {
      if (!scmGit) throw pluginError('plugins.scm.unavailable', 'Local source-control service is unavailable.');
      // Unlike ordinary renderer-owned registrations, SCM results originate
      // only in the local main-process broker. They contain opaque repository
      // ids and sanitized data, never a path, command, credential, or server.
      return scmGit.request(method, payload);
    }
    if (method === 'models.list' || method === 'models.generate' || method === 'models.generateStream' ||
        method === 'models.cancel' || method.startsWith('agent.')) {
      if (!agentBroker) throw pluginError('plugins.agent.unavailable', 'The local Agent broker is unavailable.');
      return immutable(await agentBroker.request(pluginId, method, payload, { revision: record.revision }));
    }
    if (method === 'commands.register') {
      if (!isNonEmptyString(payload.id, 180) || !payload.id.startsWith(pluginId + '.')) {
        throw pluginError('plugins.rpc.namespace', 'Plugin commands must use the plugin namespace.');
      }
    }
    if (method === 'commands.execute') {
      if (!isNonEmptyString(payload.id, 180) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(payload.id)) {
        throw pluginError('plugins.rpc.command', 'Plugin command id is invalid.');
      }
    }
    if (method === 'contributions.register') {
      if (!KNOWN_CONTRIBUTION_POINTS.has(payload.point) ||
          payload.point === 'sourceControl' || payload.point === 'fileDecorations.scm' || payload.point === 'documentViews' ||
          !isNonEmptyString(payload.id, 180) || !payload.id.startsWith(pluginId + '.')) {
        throw pluginError('plugins.rpc.contribution', 'Plugin contribution is not a supported owned contribution.');
      }
    }
    if (method === 'services.get') {
      if (payload.id !== 'workbench.projectTasks') {
        throw pluginError('plugins.rpc.service', 'Plugin service is not exposed.');
      }
    }
    if (method === 'sourceControl.register') {
      const allowed = new Set(['id', 'title', 'icon', 'order', 'openCommand']);
      if (Object.keys(payload).some((key) => !allowed.has(key)) ||
          !isNonEmptyString(payload.id, 180) || !payload.id.startsWith(pluginId + '.') ||
          !isNonEmptyString(payload.title, 96) ||
          (payload.icon !== undefined && payload.icon !== 'git-branch') ||
          (payload.order !== undefined && (!Number.isInteger(payload.order) || payload.order < -1000 || payload.order > 1000)) ||
          (payload.openCommand !== undefined && payload.openCommand !== null &&
            (!isNonEmptyString(payload.openCommand, 180) || !payload.openCommand.startsWith(pluginId + '.')))) {
        throw pluginError('plugins.rpc.sourceControl', 'Source-control contribution is not a supported owned descriptor.');
      }
    }
    if (method === 'fileDecorations.scm.register') {
      const allowed = new Set(['id', 'priority']);
      if (Object.keys(payload).some((key) => !allowed.has(key)) ||
          !isNonEmptyString(payload.id, 180) || !payload.id.startsWith(pluginId + '.') ||
          (payload.priority !== undefined && (!Number.isInteger(payload.priority) || payload.priority < -1000 || payload.priority > 1000))) {
        throw pluginError('plugins.rpc.scmDecoration', 'SCM decoration provider is not a supported owned descriptor.');
      }
    }
    if (method === 'documentViews.register') {
      const allowed = new Set(['id', 'title']);
      if (Object.keys(payload).some((key) => !allowed.has(key)) ||
          !isNonEmptyString(payload.id, 180) || !payload.id.startsWith(pluginId + '.') ||
          !isNonEmptyString(payload.title, 120)) {
        throw pluginError('plugins.rpc.documentView', 'Document viewer registration is invalid.');
      }
      const viewer = authorizeDocumentViewer(pluginId, payload.id, false);
      return immutable({
        authorized: true,
        method,
        permission,
        viewer: Object.assign(cloneJson(viewer), { title: payload.title.trim() })
      });
    }
    if (method === 'agents.register') {
      const allowed = new Set(['id', 'title', 'description', 'icon', 'order', 'commands', 'capabilities']);
      if (Object.keys(payload).some((key) => !allowed.has(key)) ||
          !isNonEmptyString(payload.id, 180) || !payload.id.startsWith(pluginId + '.') ||
          !isNonEmptyString(payload.title, 160) || payload.icon !== 'sparkles') {
        throw pluginError('plugins.rpc.agent', 'Agent provider registration is invalid.');
      }
    }
    // Renderer extension host owns the actual registry operation. The main
    // process is the authority for the capability decision only.
    return immutable({ authorized: true, method, permission });
  }

  async function openFolder() {
    await initialize();
    if (!shell || typeof shell.openPath !== 'function') throw pluginError('plugins.folder.unavailable', 'Plugin folder cannot be opened on this platform.');
    const error = await shell.openPath(pluginRoot);
    if (error) throw new Error(error);
    return immutable({ success: true });
  }

  const optionsT = typeof options.t === 'function' ? options.t : null;

  async function agentApprovalRecord(pluginId, approvalId) {
    await initialize();
    const id = assertSafePluginId(pluginId);
    const record = records.get(id);
    if (!record || record.status !== 'enabled' || !record.integrity.valid || !record.manifest || !agentBroker) {
      throw pluginError('plugins.agent.unavailable', 'The Agent plugin or local approval broker is unavailable.');
    }
    const approval = agentBroker.describeApproval(id, approvalId);
    if (!record.grantedPermissions.includes(approval.permission)) {
      throw pluginError('plugins.rpc.permission', 'Plugin permission has not been granted: ' + approval.permission);
    }
    return { id, approval };
  }

  async function describeAgentApproval(payload) {
    try {
      const current = await agentApprovalRecord(payload && payload.pluginId, payload && payload.approvalId);
      return immutable(current.approval);
    } catch (error) {
      const unavailable = unavailableAgentApproval(error);
      if (unavailable) return immutable(unavailable);
      throw error;
    }
  }

  async function decideAgentApproval(payload) {
    try {
      const current = await agentApprovalRecord(payload && payload.pluginId, payload && payload.approvalId);
      return immutable(await agentBroker.decideApproval(current.id, current.approval.approvalId, payload && payload.approved === true));
    } catch (error) {
      const unavailable = unavailableAgentApproval(error);
      if (unavailable) return immutable(unavailable);
      throw error;
    }
  }

  async function cancelAgentApproval(payload) {
    const current = await agentApprovalRecord(payload && payload.pluginId, payload && payload.approvalId);
    return immutable(await agentBroker.cancelApproval(current.id, current.approval.approvalId));
  }

  async function agentAccessRecord(payload) {
    await initialize();
    const id = assertSafePluginId(payload && payload.pluginId);
    const record = records.get(id);
    if (!record || record.status !== 'enabled' || !record.integrity.valid || !record.manifest || !agentBroker ||
        typeof agentBroker.getAccessMode !== 'function' || typeof agentBroker.setAccessMode !== 'function' ||
        typeof agentBroker.clearAccessMode !== 'function') {
      throw pluginError('plugins.agent.unavailable', 'The Agent plugin or local access broker is unavailable.');
    }
    if (!record.grantedPermissions.includes(PluginPermission.AGENTS_REGISTER)) {
      throw pluginError('plugins.rpc.permission', 'Plugin permission has not been granted: ' + PluginPermission.AGENTS_REGISTER);
    }
    const providerId = String(payload && payload.providerId || '');
    const sessionId = String(payload && payload.sessionId || '');
    if (!isNonEmptyString(providerId, 180) || !providerId.startsWith(id + '.') ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(providerId) ||
        !isNonEmptyString(sessionId, 180) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) {
      throw pluginError('plugins.agent.access', 'Agent access mode requires a valid owned provider and session.');
    }
    return { id, providerId, sessionId };
  }

  async function getAgentAccess(payload) {
    const current = await agentAccessRecord(payload);
    return immutable(agentBroker.getAccessMode(current.id, current));
  }

  async function setAgentAccess(payload) {
    const current = await agentAccessRecord(payload);
    return immutable(agentBroker.setAccessMode(current.id, {
      providerId: current.providerId,
      sessionId: current.sessionId,
      accessMode: payload && payload.accessMode,
      confirmed: payload && payload.confirmed === true
    }));
  }

  async function clearAgentAccess(payload) {
    const current = await agentAccessRecord(payload);
    return immutable(agentBroker.clearAccessMode(current.id, {
      providerId: current.providerId,
      sessionId: current.sessionId
    }));
  }

  function registerIpc() {
    ipcMain.handle('plugins:list', async (event) => { trustedSender(event); await initialize(); return currentList(); });
    ipcMain.handle('plugins:get', async (event, id) => { trustedSender(event); await initialize(); return get(id); });
    ipcMain.handle('plugins:install', async (event) => { trustedSender(event); return installFromDialog(); });
    ipcMain.handle('plugins:enable', async (event, id) => { trustedSender(event); return setEnabled(id, true); });
    ipcMain.handle('plugins:disable', async (event, id) => { trustedSender(event); return setEnabled(id, false); });
    ipcMain.handle('plugins:uninstall', async (event, id) => { trustedSender(event); return uninstall(id); });
    ipcMain.handle('plugins:grant', async (event, payload) => {
      trustedSender(event);
      return grant(payload && payload.id, payload && payload.permission, true);
    });
    ipcMain.handle('plugins:revoke', async (event, payload) => {
      trustedSender(event);
      return grant(payload && payload.id, payload && payload.permission, false);
    });
    ipcMain.handle('plugins:runtime-descriptors', async (event) => { trustedSender(event); await initialize(); return runtimeDescriptors(); });
    ipcMain.handle('plugins:load-entry', async (event, id) => { trustedSender(event); return loadEntry(id); });
    ipcMain.handle('plugins:load-localization', async (event, payload) => {
      trustedSender(event);
      return loadLocalization(payload && payload.id, payload && payload.locale);
    });
    ipcMain.handle('plugins:load-document-view', async (event, payload) => {
      trustedSender(event);
      return loadDocumentView(payload && payload.pluginId, payload && payload.viewerId);
    });
    ipcMain.handle('plugins:document-open', async (event, payload) => {
      trustedSender(event);
      if (!documentBroker) throw pluginError('plugins.documentView.unavailable', 'Document viewer broker is unavailable.');
      return documentBroker.open(event, payload);
    });
    ipcMain.handle('plugins:document-read', async (event, payload) => {
      trustedSender(event);
      if (!documentBroker) throw pluginError('plugins.documentView.unavailable', 'Document viewer broker is unavailable.');
      return documentBroker.read(event, payload);
    });
    ipcMain.handle('plugins:document-close', async (event, payload) => {
      trustedSender(event);
      return documentBroker ? documentBroker.close(event, payload) : { closed: false };
    });
    ipcMain.handle('plugins:rpc', async (event, payload) => {
      trustedSender(event);
      return capturePluginRpcResult(() => rpc(
        payload && payload.pluginId,
        payload && payload.method,
        payload && payload.args
      ));
    });
    ipcMain.handle('plugins:agent-approval-describe', async (event, payload) => { trustedSender(event); return describeAgentApproval(payload); });
    ipcMain.handle('plugins:agent-approval-decide', async (event, payload) => { trustedSender(event); return decideAgentApproval(payload); });
    ipcMain.handle('plugins:agent-approval-cancel', async (event, payload) => { trustedSender(event); return cancelAgentApproval(payload); });
    ipcMain.handle('plugins:agent-access-get', async (event, payload) => { trustedSender(event); return getAgentAccess(payload); });
    ipcMain.handle('plugins:agent-access-set', async (event, payload) => { trustedSender(event); return setAgentAccess(payload); });
    ipcMain.handle('plugins:agent-access-clear', async (event, payload) => { trustedSender(event); return clearAgentAccess(payload); });
    ipcMain.handle('plugins:open-folder', async (event) => { trustedSender(event); return openFolder(); });
    ipcMain.handle('plugins:refresh', async (event) => { trustedSender(event); return refresh('manual'); });
  }

  return {
    initialize,
    registerIpc,
    list: currentList,
    get,
    installFromPath,
    installArchiveFromPath,
    installFromDialog,
    setEnabled,
    grant,
    uninstall,
    refresh,
    runtimeDescriptors,
    loadEntry,
    loadLocalization,
    loadDocumentView,
    rpc,
    getAgentAccess,
    setAgentAccess,
    clearAgentAccess,
    openFolder,
    get root() { return pluginRoot; }
  };
}

module.exports = {
  PLUGIN_API_VERSION,
  PluginPermission,
  createPluginController,
  validateManifest,
  validatePackageDirectory,
  readZipEntries,
  satisfiesVersionRange
};
