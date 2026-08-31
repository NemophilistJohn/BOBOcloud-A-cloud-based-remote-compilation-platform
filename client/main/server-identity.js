'use strict';

const crypto = require('node:crypto');
const { normalizeHost, normalizedPort } = require('./server-transport');

const IDENTITY_SCHEMA = 1;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedCertificatePins(settings) {
  const value = settings && typeof settings === 'object' ? settings : {};
  const pins = [];
  if (value.certificateFingerprint) pins.push(value.certificateFingerprint);
  if (Array.isArray(value.certificateFingerprints)) pins.push(...value.certificateFingerprints);
  return [...new Set(pins
    .map((pin) => String(pin || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase())
    .filter(Boolean))]
    .sort();
}

function endpointDescriptor(settings) {
  const value = settings && typeof settings === 'object' ? settings : {};
  return Object.freeze({
    schema: IDENTITY_SCHEMA,
    secure: value.secureTransport === true,
    host: normalizeHost(value.ip).toLowerCase(),
    httpPort: normalizedPort(value.httpPort, 3100),
    wsPort: normalizedPort(value.wsPort, 3101),
    dapChildWsPort: normalizedPort(value.dapChildWsPort, 3102),
    certificatePins: normalizedCertificatePins(value)
  });
}

function serverEndpointIdentity(settings) {
  return digest(endpointDescriptor(settings));
}

function serverTransportIdentity(settings) {
  const value = settings && typeof settings === 'object' ? settings : {};
  return digest([
    endpointDescriptor(value),
    String(value.apiKey || '')
  ]);
}

function rcloneConnectionIdentity(settings) {
  const value = settings && typeof settings === 'object' ? settings : {};
  return digest([
    IDENTITY_SCHEMA,
    normalizeHost(value.ip).toLowerCase(),
    String(value.user || ''),
    String(value.pass || '')
  ]);
}

function authStorageKey(settings) {
  return 'server-v2:' + serverEndpointIdentity(settings);
}

function legacyAuthStorageKeys(settings) {
  const value = settings && typeof settings === 'object' ? settings : {};
  return [...new Set([
    String(value.ip || ''),
    normalizeHost(value.ip)
  ].map((key) => key.trim()).filter(Boolean))];
}

function credentialForServer(authData, settings) {
  const servers = authData && authData.servers && typeof authData.servers === 'object'
    ? authData.servers
    : {};
  const canonicalKey = authStorageKey(settings);
  if (servers[canonicalKey]) return { credential: servers[canonicalKey], key: canonicalKey, legacy: false };
  for (const key of legacyAuthStorageKeys(settings)) {
    if (servers[key]) return { credential: servers[key], key, legacy: true };
  }
  return { credential: null, key: canonicalKey, legacy: false };
}

function effectiveCredential(credential, currentTime = Date.now()) {
  if (!credential || !credential.token) return null;
  if (credential.expiresAt && !(Number(credential.expiresAt) > currentTime)) return null;
  return credential;
}

function serverAccountIdentity(settings, credential, currentTime = Date.now()) {
  const active = effectiveCredential(credential, currentTime);
  const user = active && active.user && typeof active.user === 'object' ? active.user : {};
  const stableUser = String(user.uid || user.id || user.userId || user.username || '').trim();
  if (stableUser) return 'user:' + stableUser;
  if (active && active.token) return 'session:' + digest(String(active.token));
  const value = settings && typeof settings === 'object' ? settings : {};
  if (value.apiKey) return 'api-key:' + digest(String(value.apiKey));
  return 'single-user';
}

module.exports = {
  authStorageKey,
  credentialForServer,
  effectiveCredential,
  endpointDescriptor,
  legacyAuthStorageKeys,
  normalizedCertificatePins,
  rcloneConnectionIdentity,
  serverAccountIdentity,
  serverEndpointIdentity,
  serverTransportIdentity
};
