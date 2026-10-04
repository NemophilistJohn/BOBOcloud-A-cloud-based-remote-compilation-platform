'use strict';

const crypto = require('node:crypto');
const { normalizeFingerprint, configuredFingerprints } = require('./secure-transport');

function timingSafeFingerprintMatch(expected, actual) {
  const left = Buffer.from(normalizeFingerprint(expected), 'ascii');
  const right = Buffer.from(normalizeFingerprint(actual), 'ascii');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function peerFingerprint(socket) {
  const tlsSocket = socket && socket._socket;
  if (!tlsSocket || typeof tlsSocket.getPeerCertificate !== 'function') return '';
  const certificate = tlsSocket.getPeerCertificate(true);
  if (!certificate || !certificate.raw) return '';
  return crypto.createHash('sha256').update(certificate.raw).digest('hex').toUpperCase();
}

function verifyCloudPeer(socket, expectedFingerprints, url) {
  const expected = configuredFingerprints({ certificateFingerprints: Array.isArray(expectedFingerprints)
    ? expectedFingerprints : [expectedFingerprints] });
  if (!expected.length) return;
  if (new URL(String(url)).protocol !== 'wss:') {
    throw Object.assign(new Error('A certificate fingerprint requires secure cloud transport'), { code: 'certificate_unavailable' });
  }
  const actual = peerFingerprint(socket);
  if (!actual || !expected.some(fingerprint => timingSafeFingerprintMatch(fingerprint, actual))) {
    throw Object.assign(new Error('The cloud certificate does not match the configured fingerprint'), { code: 'certificate_mismatch' });
  }
}

function createCloudWebSocketFactory(settings, options = {}) {
  const WebSocket = options.WebSocket || require('ws');
  const expected = configuredFingerprints(settings);
  return url => new WebSocket(url, {
    perMessageDeflate: false,
    handshakeTimeout: 10000,
    // Private TLS is permitted only with an explicit pin, verified before
    // credentials by the owning transport. Unpinned servers retain CA checks.
    rejectUnauthorized: new URL(String(url)).protocol === 'wss:' ? expected.length === 0 : undefined
  });
}

function createCloudPeerVerifier(settings) {
  const expected = configuredFingerprints(settings);
  return (socket, url) => verifyCloudPeer(socket, expected, url);
}

module.exports = { createCloudWebSocketFactory, createCloudPeerVerifier, verifyCloudPeer, peerFingerprint, timingSafeFingerprintMatch };
