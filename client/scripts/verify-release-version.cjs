'use strict';

const asar = require('@electron/asar');
const semver = require('semver');

function verifyReleaseVersion(archive, expected) {
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+$/.test(expected)) throw new Error('Expected host version must be a stable numeric SemVer');
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (manifest.version !== expected || semver.prerelease(manifest.version) !== null) throw new Error('Packaged host version is not the expected stable version');
}
if (require.main === module) {
  try { verifyReleaseVersion(process.argv[2], process.argv[3]); console.log('Verified packaged host version:', process.argv[3]); }
  catch (error) { console.error('[release-version]', error.message); process.exitCode = 1; }
}
module.exports = { verifyReleaseVersion };
