'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEMML_SOURCE = path.join(ROOT, 'node_modules', 'temml', 'dist', 'temml.min.js');
const TEMML_DESTINATION = path.join(ROOT, 'src', 'vendor', 'temml.min.js');

async function prepareVendorAssets() {
  if (!fs.existsSync(TEMML_SOURCE)) {
    throw new Error('Temml is not installed. Run npm install before starting or packaging the app.');
  }
  await fsp.mkdir(path.dirname(TEMML_DESTINATION), { recursive: true });
  await fsp.copyFile(TEMML_SOURCE, TEMML_DESTINATION);
  return TEMML_DESTINATION;
}

if (require.main === module) {
  prepareVendorAssets().then(function(destination) {
    console.log('[vendor] prepared ' + destination);
  }).catch(function(error) {
    console.error('[vendor] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { prepareVendorAssets, TEMML_DESTINATION, TEMML_SOURCE };
