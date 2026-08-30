'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RCLONE_VERSION = '1.64.0';
const RCLONE_BASE_URL = 'https://downloads.rclone.org/v' + RCLONE_VERSION;
const DEFAULT_CACHE_ROOT = path.join(PROJECT_ROOT, 'node_modules', '.cache', 'bobocloud-rclone');

const RCLONE_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    archiveName: 'rclone-v1.64.0-windows-amd64.zip',
    sha256: 'b1251cfdcbc44356e001057524c3e2f7be56d94546273d10143bfa1148c155ab'
  }),
  'win32-arm64': Object.freeze({
    archiveName: 'rclone-v1.64.0-windows-arm64.zip',
    sha256: '65673e9110f58e5f801f6c7256cb09307466f22e94645b0de36f510141d02be8'
  }),
  'darwin-x64': Object.freeze({
    archiveName: 'rclone-v1.64.0-osx-amd64.zip',
    sha256: '9ef83833296876f3182b87030b4f2e851b56621bad4ca4d7a14753553bb8b640'
  }),
  'darwin-arm64': Object.freeze({
    archiveName: 'rclone-v1.64.0-osx-arm64.zip',
    sha256: '9183f495b28acb12c872175c6af1f6ba8ca677650cb9d2774caefea273294c8a'
  }),
  'linux-x64': Object.freeze({
    archiveName: 'rclone-v1.64.0-linux-amd64.zip',
    sha256: '7ebdb680e615f690bd52c661487379f9df8de648ecf38743e49fe12c6ace6dc7'
  }),
  'linux-arm64': Object.freeze({
    archiveName: 'rclone-v1.64.0-linux-arm64.zip',
    sha256: 'b5a6cb3aef4fd1a2165fb8c21b1b1705f3cb754a202adc81931b47cd39c64749'
  })
});

function normalizeArch(arch) {
  if (arch === 1 || arch === 'x64') return 'x64';
  if (arch === 3 || arch === 'arm64') return 'arm64';
  throw new Error('Unsupported rclone architecture: ' + String(arch) + ' (expected x64 or arm64)');
}

function resolveTarget(platform, arch, manifest = RCLONE_TARGETS) {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new Error('Unsupported rclone platform: ' + String(platform) + ' (expected win32, darwin or linux)');
  }
  const normalizedArch = normalizeArch(arch);
  const key = platform + '-' + normalizedArch;
  const target = manifest[key];
  if (!target) throw new Error('No pinned rclone artifact for ' + key);
  const archiveStem = target.archiveName.replace(/\.zip$/i, '');
  return {
    ...target,
    platform,
    arch: normalizedArch,
    key,
    entryName: target.entryName || archiveStem + '/' + (platform === 'win32' ? 'rclone.exe' : 'rclone'),
    binaryName: platform === 'win32' ? 'rclone.exe' : 'rclone',
    url: target.url || RCLONE_BASE_URL + '/' + target.archiveName
  };
}

function getCachePaths(platform, arch, cacheRoot = DEFAULT_CACHE_ROOT, manifest = RCLONE_TARGETS) {
  const target = resolveTarget(platform, arch, manifest);
  const versionRoot = path.join(cacheRoot, 'v' + RCLONE_VERSION);
  const targetDir = path.join(versionRoot, target.key);
  return {
    target,
    versionRoot,
    targetDir,
    binaryPath: path.join(targetDir, target.binaryName),
    metadataPath: path.join(targetDir, 'rclone.source.json'),
    archivePath: path.join(versionRoot, 'archives', target.archiveName)
  };
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function verifyFileSha256(filePath, expectedSha256, label = 'rclone archive') {
  let actual;
  try {
    actual = await sha256File(filePath);
  } catch (error) {
    throw new Error(label + ' is missing or unreadable at ' + filePath + ': ' + error.message, { cause: error });
  }
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(label + ' checksum mismatch at ' + filePath + ': expected ' + expectedSha256 + ', got ' + actual);
  }
  return actual;
}

function requestToFile(url, destination, redirectsRemaining, httpsImpl) {
  return new Promise((resolve, reject) => {
    const request = httpsImpl.get(url, (response) => {
      const statusCode = response.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error('Too many redirects while downloading ' + url));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url).toString();
        resolve(requestToFile(redirectUrl, destination, redirectsRemaining - 1, httpsImpl));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error('Failed to download ' + url + ': HTTP ' + statusCode));
        return;
      }
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      pipeline(response, output).then(resolve, reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Timed out downloading ' + url)));
    request.on('error', reject);
  });
}

async function downloadFile(url, destination, options = {}) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await requestToFile(url, destination, options.maxRedirects ?? 5, options.httpsImpl || https);
  } catch (error) {
    await fsp.rm(destination, { force: true });
    throw error;
  }
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    });
  });
}

async function extractRcloneFromZip(zipPath, destination, options = {}) {
  const entryName = options.entryName;
  if (!entryName) throw new Error('Expected rclone ZIP entry was not specified');
  const zipFile = await openZip(zipPath);

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      if (error) reject(error);
      else resolve();
    };

    zipFile.on('error', finish);
    zipFile.on('end', () => finish(new Error('rclone executable entry not found in ' + zipPath + ': expected ' + entryName)));
    zipFile.on('entry', (entry) => {
      if (entry.fileName !== entryName) {
        zipFile.readEntry();
        return;
      }
      zipFile.openReadStream(entry, (error, input) => {
        if (error) {
          finish(error);
          return;
        }
        const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o755 });
        pipeline(input, output).then(() => finish(), finish);
      });
    });
    zipFile.readEntry();
  });
}

async function validateCachedBinary(paths) {
  const binaryExists = await fileExists(paths.binaryPath);
  const metadataExists = await fileExists(paths.metadataPath);
  if (!binaryExists && !metadataExists) return false;
  if (!binaryExists || !metadataExists) {
    throw new Error('Incomplete rclone cache at ' + paths.targetDir + '; remove this target cache and rebuild');
  }

  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(paths.metadataPath, 'utf8'));
  } catch (error) {
    throw new Error('Invalid rclone cache metadata at ' + paths.metadataPath + ': ' + error.message, { cause: error });
  }
  if (metadata.archiveSha256 !== paths.target.sha256 || !metadata.binarySha256) {
    throw new Error('Stale rclone cache metadata at ' + paths.metadataPath + '; remove this target cache and rebuild');
  }
  await verifyFileSha256(paths.binaryPath, metadata.binarySha256, 'cached rclone executable');
  await fsp.chmod(paths.binaryPath, 0o755);
  return true;
}

async function prepareRclone(options = {}) {
  const manifest = options.manifest || RCLONE_TARGETS;
  const paths = getCachePaths(options.platform, options.arch, options.cacheRoot || DEFAULT_CACHE_ROOT, manifest);
  if (await validateCachedBinary(paths)) return paths.binaryPath;

  await fsp.mkdir(path.dirname(paths.archivePath), { recursive: true });
  await fsp.mkdir(paths.targetDir, { recursive: true });
  const unique = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const archiveTemp = paths.archivePath + '.download-' + unique;
  const binaryTemp = paths.binaryPath + '.extract-' + unique;
  const metadataTemp = paths.metadataPath + '.write-' + unique;

  try {
    if (await fileExists(paths.archivePath)) {
      await verifyFileSha256(paths.archivePath, paths.target.sha256);
    } else {
      const downloader = options.download || downloadFile;
      await downloader(paths.target.url, archiveTemp);
      await verifyFileSha256(archiveTemp, paths.target.sha256, 'downloaded rclone archive');
      await fsp.rename(archiveTemp, paths.archivePath);
    }

    const extractor = options.extract || extractRcloneFromZip;
    await extractor(paths.archivePath, binaryTemp, { entryName: paths.target.entryName });
    let stat;
    try {
      stat = await fsp.stat(binaryTemp);
    } catch (error) {
      throw new Error('rclone extraction did not create ' + binaryTemp + ': ' + error.message, { cause: error });
    }
    if (!stat.isFile() || stat.size === 0) throw new Error('Extracted rclone executable is empty or invalid: ' + binaryTemp);
    await fsp.chmod(binaryTemp, 0o755);
    const binarySha256 = await sha256File(binaryTemp);
    const metadata = {
      version: RCLONE_VERSION,
      platform: paths.target.platform,
      arch: paths.target.arch,
      archive: paths.target.archiveName,
      archiveSha256: paths.target.sha256,
      binarySha256
    };
    await fsp.writeFile(metadataTemp, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    await fsp.rename(binaryTemp, paths.binaryPath);
    await fsp.rename(metadataTemp, paths.metadataPath);
    return paths.binaryPath;
  } finally {
    await Promise.all([
      fsp.rm(archiveTemp, { force: true }),
      fsp.rm(binaryTemp, { force: true }),
      fsp.rm(metadataTemp, { force: true })
    ]);
  }
}

module.exports = {
  DEFAULT_CACHE_ROOT,
  RCLONE_BASE_URL,
  RCLONE_TARGETS,
  RCLONE_VERSION,
  downloadFile,
  extractRcloneFromZip,
  getCachePaths,
  normalizeArch,
  prepareRclone,
  resolveTarget,
  sha256File,
  validateCachedBinary,
  verifyFileSha256
};
