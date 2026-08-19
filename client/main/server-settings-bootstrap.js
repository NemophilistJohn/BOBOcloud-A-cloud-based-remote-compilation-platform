'use strict';

const path = require('path');

const BOOTSTRAP_RESOURCE_DIRECTORY = 'bobocloud';
const BOOTSTRAP_RESOURCE_FILE_NAME = 'server-settings.bootstrap.json';
const BOOTSTRAP_RESOURCE_DESTINATION = BOOTSTRAP_RESOURCE_DIRECTORY + '/' + BOOTSTRAP_RESOURCE_FILE_NAME;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function secret(value) {
  return typeof value === 'string' ? value : '';
}

function fingerprints(value, legacy) {
  const values = [];
  if (typeof legacy === 'string') values.push(legacy);
  if (Array.isArray(value)) values.push(...value);
  return [...new Set(values.map(text).filter(Boolean))].slice(0, 4);
}

function port(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function syncInterval(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30000;
}

// A bundled bootstrap config may establish one server connection, but must not
// become a vehicle for copying arbitrary user preferences into a new profile.
function createBootstrapServerSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ip = text(value.ip);
  const user = text(value.user);
  if (!ip || !user) return null;

  const certificateFingerprints = fingerprints(value.certificateFingerprints, value.certificateFingerprint);
  return {
    ip,
    user,
    pass: secret(value.pass),
    secureTransport: value.secureTransport === true,
    httpPort: port(value.httpPort, 3100),
    wsPort: port(value.wsPort, 3101),
    dapChildWsPort: port(value.dapChildWsPort, 3102),
    certificateFingerprint: certificateFingerprints[0] || '',
    certificateFingerprints,
    syncInterval: syncInterval(value.syncInterval),
    setupCompleted: true
  };
}

function getBootstrapResourcePath(resourcesPath) {
  if (!resourcesPath || typeof resourcesPath !== 'string') return '';
  return path.join(resourcesPath, BOOTSTRAP_RESOURCE_DIRECTORY, BOOTSTRAP_RESOURCE_FILE_NAME);
}

module.exports = {
  BOOTSTRAP_RESOURCE_DESTINATION,
  createBootstrapServerSettings,
  getBootstrapResourcePath,
  fingerprints
};
