'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const plist = require('plist');
const yauzl = require('yauzl');
const { downloadArtifact } = require('electron/node_modules/@electron/get');
const { prepareRclone } = require('./prepare-rclone');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const productName = packageJson.build.productName;
const appVersion = packageJson.version;
const electronVersion = require('electron/package.json').version;
const arch = process.argv[2] || 'x64';
const asarPath = path.resolve(process.argv[3] || path.join(projectRoot, 'release', appVersion, 'win-unpacked', 'resources', 'app.asar'));
const outputDir = path.resolve(process.argv[4] || path.join(projectRoot, 'release', appVersion + '-mac'));
const outputPath = path.join(outputDir, productName + '-' + appVersion + '-mac-' + arch + '.zip');
const sourceRoot = 'Electron.app/';
const targetRoot = productName + '.app/';

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => error ? reject(error) : resolve(zipFile));
  });
}

function readEntryBuffer(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function buildIcns(png) {
  const type = Buffer.from('ic09'); // 512x512 PNG representation
  const elementLength = Buffer.alloc(4);
  elementLength.writeUInt32BE(png.length + 8);
  const body = Buffer.concat([type, elementLength, png]);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

function transformPlist(buffer) {
  const info = plist.parse(buffer.toString('utf8'));
  info.CFBundleDisplayName = productName;
  info.CFBundleName = productName;
  info.CFBundleIdentifier = packageJson.build.appId;
  info.CFBundleShortVersionString = appVersion;
  info.CFBundleVersion = appVersion;
  info.CFBundleIconFile = 'electron.icns';
  delete info.ElectronAsarIntegrity;
  return Buffer.from(plist.build(info), 'utf8');
}

function addElectronEntries(zipFile, archive) {
  return new Promise((resolve, reject) => {
    zipFile.on('error', reject);
    zipFile.on('end', resolve);
    zipFile.on('entry', async (entry) => {
      try {
        if (!entry.fileName.startsWith(sourceRoot)) {
          zipFile.readEntry();
          return;
        }

        const relativeName = entry.fileName.slice(sourceRoot.length);
        const targetName = targetRoot + relativeName;
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = mode & 0o170000;
        const isDirectory = entry.fileName.endsWith('/');
        const isSymlink = fileType === 0o120000;
        const isDefaultApp = relativeName === 'Contents/Resources/default_app.asar';
        const isIcon = relativeName === 'Contents/Resources/electron.icns';

        if (isDefaultApp || isIcon) {
          zipFile.readEntry();
          return;
        }
        if (isDirectory) {
          archive.append(Buffer.alloc(0), { name: targetName, type: 'directory', mode: mode || 0o755, date: entry.getLastModDate() });
          zipFile.readEntry();
          return;
        }

        if (isSymlink) {
          const target = (await readEntryBuffer(zipFile, entry)).toString('utf8');
          archive.symlink(targetName, target, mode || 0o777);
          zipFile.readEntry();
          return;
        }

        if (relativeName === 'Contents/Info.plist') {
          const transformed = transformPlist(await readEntryBuffer(zipFile, entry));
          archive.append(transformed, { name: targetName, mode: mode || 0o644, date: entry.getLastModDate() });
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          stream.on('error', reject);
          stream.on('end', () => zipFile.readEntry());
          archive.append(stream, { name: targetName, mode: mode || 0o644, date: entry.getLastModDate() });
        });
      } catch (error) {
        reject(error);
      }
    });
    zipFile.readEntry();
  });
}

function addRcloneResource(archive, rclonePath) {
  let stat;
  try {
    stat = fs.statSync(rclonePath);
  } catch (error) {
    throw new Error('Prepared macOS rclone executable is missing at ' + rclonePath + ': ' + error.message, { cause: error });
  }
  if (!stat.isFile() || stat.size === 0) throw new Error('Prepared macOS rclone executable is empty or invalid: ' + rclonePath);
  archive.file(rclonePath, {
    name: targetRoot + 'Contents/Resources/rclone/rclone',
    mode: 0o755
  });
}

async function main() {
  if (!fs.existsSync(asarPath)) throw new Error('Audited app.asar not found: ' + asarPath);
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Supported macOS architectures: x64, arm64');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('[mac-cross] preparing pinned rclone for darwin-' + arch);
  const rclonePath = await prepareRclone({ platform: 'darwin', arch, projectRoot });

  console.log('[mac-cross] downloading official Electron ' + electronVersion + ' for darwin-' + arch);
  const electronZip = await downloadArtifact({
    version: electronVersion,
    artifactName: 'electron',
    platform: 'darwin',
    arch
  });
  const zipFile = await openZip(electronZip);

  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);

  await addElectronEntries(zipFile, archive);
  archive.file(asarPath, { name: targetRoot + 'Contents/Resources/app.asar', mode: 0o644 });
  const iconPng = fs.readFileSync(path.join(projectRoot, 'ico', 'app-icon.png'));
  archive.append(buildIcns(iconPng), { name: targetRoot + 'Contents/Resources/electron.icns', mode: 0o644 });
  addRcloneResource(archive, rclonePath);
  await archive.finalize();
  await completed;

  console.log('[mac-cross] created ' + outputPath);
  console.log('[mac-cross] unsigned app bundle; native macOS signing and DMG creation still require macOS');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[mac-cross] FAILED: ' + error.stack);
    process.exitCode = 1;
  });
}

module.exports = { addRcloneResource, main };
