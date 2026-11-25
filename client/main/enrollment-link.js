'use strict';

// This parser is shared by the privileged enrollment broker and its tests.
// The URL fragment is never sent as a URL query or logged.
const crypto = require('node:crypto');
const { isIP } = require('node:net');

function parseEnrollmentLink(input) {
  if (typeof input !== 'string' || input.length > 16384) throw new Error('enrollment.error.invalidLink');
  let url;
  try { url = new URL(input.trim()); } catch (_) { throw new Error('enrollment.error.invalidLink'); }
  if (url.protocol !== 'bobocloud:' || url.hostname !== 'enroll' || (url.pathname && url.pathname !== '/') || url.search || url.username || url.password || url.port) {
    throw new Error('enrollment.error.invalidLink');
  }
  const fragment = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{20,16000}$/.test(fragment)) throw new Error('enrollment.error.invalidLink');
  let value;
  try { value = JSON.parse(Buffer.from(fragment, 'base64url').toString('utf8')); } catch (_) { throw new Error('enrollment.error.invalidLink'); }
  if (!value || value.v !== 1 || !['root', 'register', 'device'].includes(value.kind) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
    throw new Error('enrollment.error.invalidLink');
  }
  const host = typeof value.host === 'string' ? value.host.toLowerCase() : '';
  if (!host || host.length > 253 || isIP(host) === 6 || !(isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) || host.includes('..')) {
    throw new Error('enrollment.error.invalidLink');
  }
  const port = (field, fallback) => {
    const n = value[field] === undefined ? fallback : value[field];
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('enrollment.error.invalidLink');
    return n;
  };
  if (!Array.isArray(value.certificateFingerprints) || !value.certificateFingerprints.length || value.certificateFingerprints.length > 4) throw new Error('enrollment.error.invalidLink');
  const pins = [...new Set(value.certificateFingerprints.map(pin => {
    if (typeof pin !== 'string' || !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/.test(pin)) throw new Error('enrollment.error.invalidLink');
    return pin.replace(/:/g, '').toUpperCase();
  }))];
  return Object.freeze({ v: 1, kind: value.kind, host, httpPort: port('httpPort', 3100), wsPort: port('wsPort', 3101), dapChildWsPort: port('dapChildWsPort', 3102), certificateFingerprints: pins, token: value.token });
}

function settingsForLink(link, previous = {}) {
  return { ip: link.host, secureTransport: true, httpPort: link.httpPort, wsPort: link.wsPort, dapChildWsPort: link.dapChildWsPort,
    certificateFingerprints: link.certificateFingerprints, certificateFingerprint: link.certificateFingerprints[0],
    user: '', pass: '', apiKey: '', syncMode: 'restricted', syncInterval: previous.syncInterval || 30000, setupCompleted: true };
}

function publicPreview(link, inspect) {
  return { kind: link.kind, host: link.host, httpPort: link.httpPort, certificateFingerprint: link.certificateFingerprints[0],
    version: String(inspect.version || ''), expiresAt: inspect.expiresAt || '', syncMode: inspect.syncMode || 'unknown' };
}

module.exports = { parseEnrollmentLink, settingsForLink, publicPreview, randomId: () => crypto.randomUUID() };
