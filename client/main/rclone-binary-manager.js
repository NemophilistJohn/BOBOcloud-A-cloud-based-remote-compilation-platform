'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readJsonFileSync, writeJsonAtomicSync } = require('./atomic-file');

const STATE_SCHEMA_VERSION = 1;
const SCAN_TTL_MS = 2 * 60 * 1000;
const MAX_EXTERNAL_BINARY_BYTES = 256 * 1024 * 1024;
const PREPARED_RCLONE_VERSION = '1.64.0';
const MAX_STATE_BYTES = 64 * 1024;

function executableName(platform) {
  return platform === 'win32' ? 'rclone.exe' : 'rclone';
}

function pathEnvironment(environment) {
  const key = Object.keys(environment || {}).find((name) => name.toLowerCase() === 'path');
  return key ? String(environment[key] || '') : '';
}

function stripPathEntry(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function atomicWriteJson(filePath, value) {
  writeJsonAtomicSync(filePath, value, { maxBytes: MAX_STATE_BYTES });
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    let bytesRead = 0;
    input.on('error', reject);
    input.on('data', (chunk) => {
      bytesRead += chunk.length;
      if (bytesRead > MAX_EXTERNAL_BINARY_BYTES) {
        const error = new Error('rclone candidate grew beyond the allowed size while hashing');
        error.code = 'RCLONE_CANDIDATE_TOO_LARGE';
        input.destroy(error);
        return;
      }
      hash.update(chunk);
    });
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function pathIsOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function canonicalPath(candidate) {
  const resolved = path.resolve(candidate);
  try { return fs.realpathSync(resolved); } catch (_) { return resolved; }
}

function createRcloneBinaryManager(options) {
  const app = options.app;
  const rclone = options.rclone;
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const environment = options.environment || process.env;
  const resourcesPath = options.resourcesPath || process.resourcesPath || '';
  const now = options.now || Date.now;
  const randomId = options.randomId || (() => crypto.randomUUID());
  const probeVersion = options.probeVersion || ((binaryPath, source) => rclone.checkVersion(binaryPath, source));
  const userDataPath = options.userDataPath || app.getPath('userData');
  const managedRoot = options.managedRoot || path.join(userDataPath, 'rclone-bin');
  const statePath = options.statePath || path.join(userDataPath, 'rclone-binary.json');
  const configPath = options.configPath || path.join(userDataPath, 'rclone', 'rclone.conf');
  const exeName = executableName(platform);
  const developmentResource = path.join(__dirname, '..', 'rclone', exeName);
  const preparedResource = path.join(__dirname, '..', 'node_modules', '.cache', 'bobocloud-rclone',
    'v' + PREPARED_RCLONE_VERSION, platform + '-' + architecture, exeName);
  const bundledPath = options.bundledPath || (app.isPackaged
    ? path.join(resourcesPath, 'rclone', exeName)
    : (fs.existsSync(preparedResource) ? preparedResource : developmentResource));
  const appRoot = options.appRoot || (typeof app.getAppPath === 'function' ? app.getAppPath() : path.join(__dirname, '..'));
  const protectedRoots = [userDataPath, resourcesPath, appRoot, path.dirname(bundledPath)]
    .filter(Boolean).map(canonicalPath).filter((value, index, values) => values.indexOf(value) === index);
  const scans = new Map();
  let selecting = false;
  let state = readState();
  let selectionEpoch = 1;

  function bundledState() {
    return { schemaVersion: STATE_SCHEMA_VERSION, mode: 'bundled' };
  }

  function readState() {
    try {
      const parsed = readJsonFileSync(statePath, { maxBytes: MAX_STATE_BYTES });
      if (parsed && parsed.schemaVersion === STATE_SCHEMA_VERSION && parsed.mode === 'external' &&
          typeof parsed.sourcePath === 'string' && /^[a-f0-9]{64}$/.test(parsed.sha256 || '') &&
          typeof parsed.version === 'string') {
        return parsed;
      }
    } catch (_) {}
    return bundledState();
  }

  function persistState(nextState) {
    atomicWriteJson(statePath, nextState);
    state = Object.assign({}, nextState);
    selectionEpoch += 1;
  }

  function managedPath(kind, digest) {
    return path.join(managedRoot, kind, digest, exeName);
  }

  function cleanupManaged(kind, keepDigest) {
    const root = path.join(managedRoot, kind);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry.name) || entry.name === keepDigest) continue;
      try { fs.rmSync(path.join(root, entry.name), { recursive: true, force: true }); } catch (_) {}
    }
  }

  function publicSelection(snapshot) {
    const selected = snapshot || state;
    if (selected.mode === 'external') {
      return {
        source: 'system',
        path: selected.sourcePath,
        version: selected.version,
        confirmedAt: selected.confirmedAt || null
      };
    }
    return { source: 'bundled', path: null, version: null };
  }

  function inspectFile(candidatePath, requireExecutable) {
    const absolutePath = path.resolve(candidatePath);
    const canonical = fs.realpathSync(absolutePath);
    const stat = fs.statSync(canonical);
    if (!stat.isFile()) throw new Error('rclone candidate is not a regular file');
    if (stat.size <= 0 || stat.size > MAX_EXTERNAL_BINARY_BYTES) {
      throw new Error('rclone candidate has an invalid file size');
    }
    if (requireExecutable !== false && platform !== 'win32' && (stat.mode & 0o111) === 0) {
      throw new Error('rclone candidate is not executable');
    }
    return { path: canonical, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  }

  function samePath(left, right) {
    return platform === 'win32'
      ? String(left).toLowerCase() === String(right).toLowerCase()
      : left === right;
  }

  function assertSafeLocalRoot(candidate) {
    if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('Invalid local directory');
    const target = canonicalPath(candidate);
    for (const protectedRoot of protectedRoots) {
      if (!pathIsOutside(protectedRoot, target) || !pathIsOutside(target, protectedRoot)) {
        const error = new Error('This directory is reserved by BOBOCLOUD and cannot be used as a workspace or mapping');
        error.code = 'PROTECTED_LOCAL_DIRECTORY';
        throw error;
      }
    }
    return target;
  }

  function pruneScans() {
    const threshold = now() - SCAN_TTL_MS;
    for (const [scanId, scan] of scans) {
      if (scan.createdAt < threshold) scans.delete(scanId);
    }
  }

  function scanPathCandidates() {
    const delimiter = platform === 'win32' ? ';' : ':';
    const candidates = [];
    const seen = new Set();
    for (const rawEntry of pathEnvironment(environment).split(delimiter)) {
      const directory = stripPathEntry(rawEntry);
      if (!directory) continue;
      try {
        const inspected = inspectFile(path.join(directory, exeName));
        if (samePath(inspected.path, bundledPath)) continue;
        const key = platform === 'win32' ? inspected.path.toLowerCase() : inspected.path;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(inspected);
      } catch (_) {}
    }
    return candidates;
  }

  async function listCandidates(senderId) {
    pruneScans();
    for (const [existingId, scan] of scans) {
      if (scan.senderId === senderId) scans.delete(existingId);
    }
    const scanId = randomId();
    const internal = [{ id: randomId(), source: 'bundled', path: bundledPath }];
    for (const candidate of scanPathCandidates()) {
      internal.push(Object.assign({ id: randomId(), source: 'system' }, candidate));
    }
    scans.set(scanId, { senderId, createdAt: now(), candidates: internal });
    const selection = publicSelection();
    return {
      scanId,
      selection,
      candidates: internal.map((candidate) => ({
        id: candidate.id,
        source: candidate.source,
        path: candidate.source === 'system' ? candidate.path : null,
        selected: candidate.source === selection.source && (candidate.source === 'bundled' || (
          samePath(candidate.path, selection.path) && candidate.size === state.sourceSize && candidate.mtimeMs === state.sourceMtimeMs
        ))
      }))
    };
  }

  async function publishVerifiedCopy(source, kind, expectedFingerprint) {
    const before = inspectFile(source, kind === 'external');
    if (expectedFingerprint && (!samePath(before.path, expectedFingerprint.path) ||
        before.size !== expectedFingerprint.size || before.mtimeMs !== expectedFingerprint.mtimeMs)) {
      throw new Error('rclone candidate changed after it was scanned');
    }
    const sourceDigestBefore = await sha256File(before.path);
    const destination = managedPath(kind, sourceDigestBefore);
    const destinationDirectory = path.dirname(destination);
    fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(destination)) {
      const existing = inspectFile(destination, false);
      const existingDigest = await sha256File(existing.path);
      if (existingDigest !== sourceDigestBefore) throw new Error('managed rclone copy failed integrity validation');
      if (platform !== 'win32') fs.chmodSync(existing.path, 0o700);
      return { path: existing.path, digest: sourceDigestBefore, source: before };
    }

    const temporaryPath = destination + '.tmp-' + process.pid + '-' + now() + '-' + randomId();
    try {
      fs.copyFileSync(before.path, temporaryPath, fs.constants.COPYFILE_EXCL);
      if (platform !== 'win32') fs.chmodSync(temporaryPath, 0o700);
      const after = inspectFile(before.path, kind === 'external');
      const sourceDigestAfter = await sha256File(after.path);
      const copiedDigest = await sha256File(temporaryPath);
      if (!samePath(after.path, before.path) || sourceDigestAfter !== sourceDigestBefore || copiedDigest !== sourceDigestBefore) {
        throw new Error('rclone candidate changed while it was being copied');
      }
      fs.renameSync(temporaryPath, destination);
      return { path: destination, digest: sourceDigestBefore, source: before };
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch (_) {}
    }
  }

  async function copyVerifiedExternal(candidate) {
    const copied = await publishVerifiedCopy(candidate.path, 'external', candidate);
    const versionResult = await probeVersion(copied.path, 'system');
    if (!versionResult || !versionResult.available) {
      throw new Error(versionResult && versionResult.error || 'external rclone validation failed');
    }
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      mode: 'external',
      sourcePath: copied.source.path,
      sourceSize: copied.source.size,
      sourceMtimeMs: copied.source.mtimeMs,
      sha256: copied.digest,
      version: versionResult.version,
      confirmedAt: now()
    };
  }

  async function prepareBundledExecutable() {
    const copied = await publishVerifiedCopy(bundledPath, 'bundled');
    cleanupManaged('bundled', copied.digest);
    return copied;
  }

  async function selectCandidate(senderId, payload, confirmExternal) {
    if (selecting) throw new Error('Another rclone selection is already in progress');
    pruneScans();
    const scanId = payload && typeof payload.scanId === 'string' ? payload.scanId : '';
    const candidateId = payload && typeof payload.candidateId === 'string' ? payload.candidateId : '';
    const scan = scans.get(scanId);
    if (!scan || scan.senderId !== senderId) throw new Error('The rclone scan is missing or expired');
    const candidate = scan.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('The selected rclone candidate is invalid');

    selecting = true;
    try {
      if (candidate.source === 'bundled') {
        const prepared = await prepareBundledExecutable();
        const checked = await probeVersion(prepared.path, 'bundled');
        if (!checked || !checked.available) throw new Error(checked && checked.error || 'bundled rclone validation failed');
        persistState(bundledState());
        cleanupManaged('external', '');
        scans.delete(scanId);
        return {
          cancelled: false,
          selection: publicSelection(),
          version: Object.assign({}, checked, { path: null, revision: 'bundled:' + prepared.digest })
        };
      }

      const confirmed = await confirmExternal({ path: candidate.path });
      if (!confirmed) return { cancelled: true, selection: publicSelection() };
      const nextState = await copyVerifiedExternal(candidate);
      persistState(nextState);
      cleanupManaged('external', nextState.sha256);
      scans.delete(scanId);
      return {
        cancelled: false,
        selection: publicSelection(),
        version: { available: true, path: nextState.sourcePath, source: 'system', version: nextState.version, revision: nextState.sha256 }
      };
    } finally {
      selecting = false;
    }
  }

  async function getExecutionDescriptor() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const epoch = selectionEpoch;
      const snapshot = Object.assign({}, state);
      if (snapshot.mode === 'external') {
        try {
          const managed = managedPath('external', snapshot.sha256);
          const inspected = inspectFile(managed);
          const digest = await sha256File(inspected.path);
          if (epoch !== selectionEpoch) continue;
          if (digest !== snapshot.sha256) throw new Error('managed rclone digest changed');
          return { path: inspected.path, source: 'system', revision: snapshot.sha256, selectionEpoch: epoch };
        } catch (_) {
          if (epoch !== selectionEpoch) continue;
          persistState(bundledState());
          cleanupManaged('external', '');
          continue;
        }
      }

      const prepared = await prepareBundledExecutable();
      if (epoch !== selectionEpoch) continue;
      return {
        path: prepared.path,
        source: 'bundled',
        revision: 'bundled:' + prepared.digest,
        selectionEpoch: epoch
      };
    }
    throw new Error('rclone selection changed too frequently');
  }

  function isSelectionCurrent(descriptor) {
    return Boolean(descriptor) && descriptor.selectionEpoch === selectionEpoch;
  }

  async function checkActiveVersion() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const descriptor = await getExecutionDescriptor();
        const result = await probeVersion(descriptor.path, descriptor.source);
        if (!isSelectionCurrent(descriptor)) continue;
        const selected = publicSelection();
        return Object.assign({}, result, {
          path: descriptor.source === 'system' ? selected.path : null,
          source: descriptor.source,
          revision: descriptor.revision
        });
      } catch (error) {
        const selected = publicSelection();
        return { available: false, path: selected.path, source: selected.source, error: error.message };
      }
    }
    return { available: false, path: null, source: publicSelection().source, error: 'rclone selection changed too frequently' };
  }

  cleanupManaged('external', state.mode === 'external' ? state.sha256 : '');

  return {
    listCandidates,
    selectCandidate,
    getSelection: async () => publicSelection(),
    getExecutionDescriptor,
    isSelectionCurrent,
    checkActiveVersion,
    assertSafeLocalRoot,
    paths: Object.freeze({ bundled: bundledPath, state: statePath, managedRoot, config: configPath })
  };
}

module.exports = {
  STATE_SCHEMA_VERSION,
  SCAN_TTL_MS,
  createRcloneBinaryManager,
  executableName,
  pathEnvironment,
  sha256File
};
