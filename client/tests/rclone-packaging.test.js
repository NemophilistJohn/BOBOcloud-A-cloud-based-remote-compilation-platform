'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const archiver = require('archiver');

const packageJson = require('../package.json');
const { beforePack } = require('../scripts/before-pack');
const { addRcloneResource } = require('../scripts/package-mac-zip');
const {
  RCLONE_TARGETS,
  RCLONE_VERSION,
  extractRcloneFromZip,
  getCachePaths,
  normalizeArch,
  prepareRclone,
  resolveTarget,
  sha256File,
  verifyFileSha256
} = require('../scripts/prepare-rclone');

const temporaryDirectories = [];

async function makeTempDirectory() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-rclone-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createZip(zipPath, entries) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 0 } });
  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const [name, contents] of Object.entries(entries)) archive.append(contents, { name });
  await archive.finalize();
  await completed;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

test('pins the six desktop rclone v1.64.0 archives and official SHA256 values', () => {
  assert.equal(RCLONE_VERSION, '1.64.0');
  assert.deepEqual(RCLONE_TARGETS, {
    'win32-x64': {
      archiveName: 'rclone-v1.64.0-windows-amd64.zip',
      sha256: 'b1251cfdcbc44356e001057524c3e2f7be56d94546273d10143bfa1148c155ab'
    },
    'win32-arm64': {
      archiveName: 'rclone-v1.64.0-windows-arm64.zip',
      sha256: '65673e9110f58e5f801f6c7256cb09307466f22e94645b0de36f510141d02be8'
    },
    'darwin-x64': {
      archiveName: 'rclone-v1.64.0-osx-amd64.zip',
      sha256: '9ef83833296876f3182b87030b4f2e851b56621bad4ca4d7a14753553bb8b640'
    },
    'darwin-arm64': {
      archiveName: 'rclone-v1.64.0-osx-arm64.zip',
      sha256: '9183f495b28acb12c872175c6af1f6ba8ca677650cb9d2774caefea273294c8a'
    },
    'linux-x64': {
      archiveName: 'rclone-v1.64.0-linux-amd64.zip',
      sha256: '7ebdb680e615f690bd52c661487379f9df8de648ecf38743e49fe12c6ace6dc7'
    },
    'linux-arm64': {
      archiveName: 'rclone-v1.64.0-linux-arm64.zip',
      sha256: 'b5a6cb3aef4fd1a2165fb8c21b1b1705f3cb754a202adc81931b47cd39c64749'
    }
  });
  assert.equal(resolveTarget('darwin', 'arm64').url, 'https://downloads.rclone.org/v1.64.0/rclone-v1.64.0-osx-arm64.zip');
  assert.equal(resolveTarget('linux', 'x64').entryName, 'rclone-v1.64.0-linux-amd64/rclone');
  assert.equal(resolveTarget('win32', 'x64').entryName, 'rclone-v1.64.0-windows-amd64/rclone.exe');
});

test('normalizes electron-builder numeric architectures and rejects unsupported targets', () => {
  assert.equal(normalizeArch(1), 'x64');
  assert.equal(normalizeArch(3), 'arm64');
  assert.throws(() => normalizeArch(0), /Unsupported rclone architecture/);
  assert.throws(() => resolveTarget('freebsd', 'x64'), /Unsupported rclone platform/);
});

test('verifies files with SHA256 and reports the expected and actual digest', async () => {
  const directory = await makeTempDirectory();
  const filePath = path.join(directory, 'archive.zip');
  await fsp.writeFile(filePath, 'offline archive');
  const digest = crypto.createHash('sha256').update('offline archive').digest('hex');
  assert.equal(await sha256File(filePath), digest);
  assert.equal(await verifyFileSha256(filePath, digest), digest);
  await assert.rejects(
    verifyFileSha256(filePath, '0'.repeat(64)),
    new RegExp('checksum mismatch.*expected ' + '0'.repeat(64) + ', got ' + digest)
  );
});

test('extracts only the pinned rclone entry from an offline ZIP', async () => {
  const directory = await makeTempDirectory();
  const zipPath = path.join(directory, 'fixture.zip');
  const outputPath = path.join(directory, 'rclone');
  await createZip(zipPath, {
    'rclone-v1.64.0-linux-amd64/README.txt': 'not the executable',
    'rclone-v1.64.0-linux-amd64/rclone': 'offline-rclone-binary'
  });

  await extractRcloneFromZip(zipPath, outputPath, {
    entryName: 'rclone-v1.64.0-linux-amd64/rclone'
  });
  assert.equal(await fsp.readFile(outputPath, 'utf8'), 'offline-rclone-binary');
});

test('fails explicitly when the pinned rclone ZIP entry is missing', async () => {
  const directory = await makeTempDirectory();
  const zipPath = path.join(directory, 'fixture.zip');
  await createZip(zipPath, { 'unexpected/rclone': 'wrong entry' });
  await assert.rejects(
    extractRcloneFromZip(zipPath, path.join(directory, 'rclone'), { entryName: 'expected/rclone' }),
    /rclone executable entry not found.*expected\/rclone/
  );
});

test('prepareRclone downloads, verifies, extracts, records integrity and reuses a valid cache', async () => {
  const cacheRoot = await makeTempDirectory();
  const archiveContents = Buffer.from('mock rclone archive');
  const archiveSha256 = crypto.createHash('sha256').update(archiveContents).digest('hex');
  const manifest = {
    'linux-arm64': {
      archiveName: 'rclone-v1.64.0-linux-arm64.zip',
      sha256: archiveSha256
    }
  };
  let downloads = 0;
  let extractions = 0;
  const options = {
    platform: 'linux',
    arch: 3,
    cacheRoot,
    manifest,
    download: async (url, destination) => {
      downloads += 1;
      assert.equal(url, 'https://downloads.rclone.org/v1.64.0/rclone-v1.64.0-linux-arm64.zip');
      await fsp.writeFile(destination, archiveContents);
    },
    extract: async (archivePath, destination, extractOptions) => {
      extractions += 1;
      assert.equal(await fsp.readFile(archivePath, 'utf8'), archiveContents.toString());
      assert.equal(extractOptions.entryName, 'rclone-v1.64.0-linux-arm64/rclone');
      await fsp.writeFile(destination, 'mock executable');
    }
  };

  const binaryPath = await prepareRclone(options);
  assert.equal(binaryPath, getCachePaths('linux', 'arm64', cacheRoot, manifest).binaryPath);
  assert.equal(await fsp.readFile(binaryPath, 'utf8'), 'mock executable');
  assert.equal(downloads, 1);
  assert.equal(extractions, 1);

  const reusedPath = await prepareRclone({
    ...options,
    download: async () => assert.fail('valid cache must not download again'),
    extract: async () => assert.fail('valid cache must not extract again')
  });
  assert.equal(reusedPath, binaryPath);
  assert.equal(downloads, 1);
  assert.equal(extractions, 1);
});

test('prepareRclone fails on a bad download checksum and does not publish a binary', async () => {
  const cacheRoot = await makeTempDirectory();
  const manifest = {
    'darwin-x64': {
      archiveName: 'rclone-v1.64.0-osx-amd64.zip',
      sha256: '0'.repeat(64)
    }
  };
  await assert.rejects(
    prepareRclone({
      platform: 'darwin',
      arch: 'x64',
      cacheRoot,
      manifest,
      download: async (_url, destination) => fsp.writeFile(destination, 'bad archive'),
      extract: async () => assert.fail('a bad archive must not be extracted')
    }),
    /downloaded rclone archive checksum mismatch/
  );
  assert.equal(await fsp.stat(getCachePaths('darwin', 'x64', cacheRoot, manifest).binaryPath).then(() => true, () => false), false);
});

test('prepareRclone rejects a corrupted cached executable', async () => {
  const cacheRoot = await makeTempDirectory();
  const archiveContents = Buffer.from('archive');
  const manifest = {
    'linux-x64': {
      archiveName: 'rclone-v1.64.0-linux-amd64.zip',
      sha256: crypto.createHash('sha256').update(archiveContents).digest('hex')
    }
  };
  const options = {
    platform: 'linux',
    arch: 'x64',
    cacheRoot,
    manifest,
    download: async (_url, destination) => fsp.writeFile(destination, archiveContents),
    extract: async (_archive, destination) => fsp.writeFile(destination, 'original binary')
  };
  const binaryPath = await prepareRclone(options);
  await fsp.writeFile(binaryPath, 'corrupted binary');
  await assert.rejects(prepareRclone(options), /cached rclone executable checksum mismatch/);
});

test('electron-builder hook prepares every supported desktop platform with the context architecture', async () => {
  const calls = [];
  const prepare = async (target) => {
    calls.push(target);
    return '/cache/' + target.platform + '/rclone';
  };
  assert.equal(await beforePack({ electronPlatformName: 'darwin', arch: 1 }, { prepareRclone: prepare }), '/cache/darwin/rclone');
  assert.equal(await beforePack({ electronPlatformName: 'linux', arch: 3 }, { prepareRclone: prepare }), '/cache/linux/rclone');
  assert.equal(await beforePack({ electronPlatformName: 'win32', arch: 1 }, { prepareRclone: prepare }), '/cache/win32/rclone');
  assert.deepEqual(calls, [
    { platform: 'darwin', arch: 1 },
    { platform: 'linux', arch: 3 },
    { platform: 'win32', arch: 1 }
  ]);
  await assert.rejects(beforePack({ electronPlatformName: 'freebsd', arch: 1 }, { prepareRclone: prepare }), /Unsupported electron-builder platform/);
});

test('electron-builder maps Windows, macOS and Linux to prepared resources', () => {
  assert.equal(packageJson.build.beforePack, 'scripts/before-pack.js');
  for (const [platform, config] of [['darwin', packageJson.build.mac], ['linux', packageJson.build.linux]]) {
    for (const target of config.target) assert.deepEqual(target.arch, ['x64', 'arm64']);
    assert.deepEqual(config.extraResources, [{
      from: 'node_modules/.cache/bobocloud-rclone/v1.64.0/' + platform + '-${arch}/rclone',
      to: 'rclone/rclone'
    }]);
  }
  assert.deepEqual(packageJson.build.win.extraResources, [{
    from: 'node_modules/.cache/bobocloud-rclone/v1.64.0/win32-${arch}/rclone.exe',
    to: 'rclone/rclone.exe'
  }]);
});

test('manual macOS ZIP adds the prepared rclone executable with mode 0755', async () => {
  const directory = await makeTempDirectory();
  const binaryPath = path.join(directory, 'rclone');
  await fsp.writeFile(binaryPath, 'binary');
  const calls = [];
  addRcloneResource({ file: (...args) => calls.push(args) }, binaryPath);
  assert.deepEqual(calls, [[binaryPath, {
    name: packageJson.build.productName + '.app/Contents/Resources/rclone/rclone',
    mode: 0o755
  }]]);
  assert.throws(
    () => addRcloneResource({ file: () => assert.fail('missing files must not be added') }, path.join(directory, 'missing')),
    /rclone executable is missing/
  );
});
