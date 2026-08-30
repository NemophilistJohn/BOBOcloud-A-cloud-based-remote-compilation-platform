'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PREFIX = 'bobocloud-rclone-package-';
const projectRoot = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cleanupOwnedTemporaryRoot() {
  if (!fs.existsSync(temporaryRoot)) return;
  const resolvedRoot = fs.realpathSync(temporaryRoot);
  const resolvedTemp = fs.realpathSync(os.tmpdir());
  const relative = path.relative(resolvedTemp, resolvedRoot);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      !path.basename(resolvedRoot).startsWith(PREFIX)) {
    throw new Error('Refusing to clean an unowned package directory: ' + resolvedRoot);
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

try {
  if (process.platform !== 'win32') throw new Error('This verification script must run on Windows');
  const builderCli = require.resolve('electron-builder/out/cli/cli.js');
  execFileSync(process.execPath, [
    builderCli,
    '--win',
    '--dir',
    '--config.directories.output=' + temporaryRoot
  ], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });

  const packaged = path.join(temporaryRoot, 'win-unpacked', 'resources', 'rclone', 'rclone.exe');
  const metadata = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'node_modules', '.cache', 'bobocloud-rclone', 'v1.64.0', 'win32-' + process.arch,
    'rclone.source.json'
  ), 'utf8'));
  const digest = sha256(packaged);
  if (digest !== metadata.binarySha256) {
    throw new Error('Packaged rclone digest mismatch: expected ' + metadata.binarySha256 + ', got ' + digest);
  }
  const version = execFileSync(packaged, ['version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0];
  if (!/^rclone v/.test(version)) throw new Error('Packaged executable did not identify itself as rclone');
  console.log('[rclone] packaged executable verified: ' + version + ' / ' + digest);
} finally {
  cleanupOwnedTemporaryRoot();
}
