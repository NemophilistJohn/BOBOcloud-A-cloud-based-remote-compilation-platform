'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function expectedAssets(version) {
  const names = [];
  for (const arch of ['x64', 'arm64']) {
    for (const kind of ['setup', 'portable']) names.push(`BOBOCloud-${version}-windows-${arch}-${kind}.exe`);
    for (const ext of ['AppImage', 'deb', 'rpm']) names.push(`BOBOCloud-${version}-linux-${arch}.${ext}`);
  }
  for (const arch of ['amd64', 'arm64']) {
    const base = `bobocloud-server-linux-${arch}`;
    names.push(base, base + '-binary.tar.gz', base + '-with-config.tar.gz');
  }
  return names.sort();
}
function digest(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024 });
}
function main(options = {}) {
  const invoke = options.gh || gh;
  const head = process.env.RELEASE_HEAD || '';
  const baseline = process.env.RELEASE_BASELINE || '';
  const version = process.env.RELEASE_VERSION || '';
  const appVersion = process.env.RELEASE_APP_VERSION || '';
  const tag = process.env.RELEASE_TAG || '';
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(baseline) || !/^\d+\.\d+\.\d+$/.test(appVersion) || !/^\d+\.\d+\.\d+-ci\.\d+\.\d+$/.test(version) || !version.startsWith(appVersion + '-ci.') || tag !== 'auto-v' + version) throw new Error('Invalid release identity');
  const dir = path.resolve('release-assets');
  const names = expectedAssets(version);
  const actual = fs.readdirSync(dir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error('Release assets do not match the required complete platform and architecture set');
  for (const name of names) {
    const info = fs.lstatSync(path.join(dir, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Invalid release asset: ' + name);
  }
  const hashes = names.map((name) => digest(path.join(dir, name)) + '  ' + name).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), hashes);
  const assets = [...names, 'SHA256SUMS.txt'];
  const changes = options.log ? options.log(baseline, head) : execFileSync('git', ['log', '--no-merges', '--max-count=100', '--format=- %s (%h)', baseline + '..' + head], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  const notes = [
    `Automated BOBOCloud build from commit ${head}.`,
    `Previous release baseline: ${baseline}.`,
    `Client application version: ${appVersion}; release build identifier: ${version}.`,
    '',
    'Windows: x64 and ARM64 installer and portable application.',
    'Linux desktop: x64 and ARM64 AppImage, DEB and RPM.',
    'Linux server: amd64 and arm64 binaries, binary-only archives, and archives with generated default configuration.',
    'These prerelease client packages are unsigned. Server archives do not include Docker images.',
    '',
    'Changes:',
    changes || '- No non-merge commit subjects in this range.',
    '',
    `<!-- bobocloud-auto-release:${head} -->`,
    ''
  ].join('\n');
  const notePath = path.join(process.env.RUNNER_TEMP || dir, 'bobocloud-release-notes.md');
  fs.writeFileSync(notePath, notes);
  const check = options.check || (() => execFileSync(process.execPath, ['scripts/auto-release/plan.cjs', '--verify', head, baseline], { stdio: 'inherit' }));
  check();
  invoke('release', 'create', tag, '--target', head, '--draft', '--prerelease', '--title', 'BOBOCloud ' + version, '--notes-file', notePath, ...assets.map((name) => path.join(dir, name)));
  // GitHub draft releases do not create their Git ref yet. Verify the draft's
  // target and assets first, then create and verify the immutable ref explicitly.
  const release = JSON.parse(invoke('release', 'view', tag, '--json', 'tagName,targetCommitish,isDraft,assets'));
  if (!release.isDraft || release.tagName !== tag || release.targetCommitish !== head || release.assets.length !== assets.length) throw new Error('Draft release identity or asset set is invalid');
  for (const name of assets) {
    const asset = release.assets.find((item) => item.name === name);
    const file = path.join(dir, name);
    if (!asset || asset.size !== fs.statSync(file).size || asset.digest !== 'sha256:' + digest(file)) throw new Error('Uploaded release asset failed verification: ' + name);
  }
  check();
  invoke('api', '--method', 'POST', 'repos/' + process.env.GITHUB_REPOSITORY + '/git/refs', '-f', 'ref=refs/tags/' + tag, '-f', 'sha=' + head);
  const reference = JSON.parse(invoke('api', 'repos/' + process.env.GITHUB_REPOSITORY + '/git/ref/tags/' + tag));
  if (reference.object.type !== 'commit' || reference.object.sha !== head) throw new Error('Release tag does not point to the verified source commit');
  check();
  invoke('release', 'edit', tag, '--draft=false');
  const published = JSON.parse(invoke('release', 'view', tag, '--json', 'isDraft,tagName'));
  if (published.isDraft || published.tagName !== tag) throw new Error('Release publication could not be verified');
  console.log('Published complete prerelease ' + tag);
}
if (require.main === module) {
  try { main(); } catch (error) { console.error('[release-publish]', error.message); process.exitCode = 1; }
}
module.exports = { expectedAssets, digest, main };
