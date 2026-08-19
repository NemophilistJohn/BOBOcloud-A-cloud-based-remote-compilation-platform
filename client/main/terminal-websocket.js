'use strict';

// This is deliberately a terminal-only main-process socket factory. It uses
// Node TLS rather than Chromium networking, so it verifies a configured
// certificate fingerprint itself before TerminalTransport sends credentials.

const crypto = require('crypto');
const NodeWebSocket = require('ws');
const { normalizeFingerprint, configuredFingerprints } = require('./secure-transport');

function terminalTlsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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

function verifyTerminalPeer(socket, expectedFingerprints, url) {
  const expected = Array.isArray(expectedFingerprints)
    ? [...new Set(expectedFingerprints.map(normalizeFingerprint).filter(Boolean))]
    : [normalizeFingerprint(expectedFingerprints)].filter(Boolean);
  const scheme = new URL(String(url)).protocol;
  if (expected.length === 0) return;
  if (scheme !== 'wss:') {
    throw terminalTlsError('certificate_unavailable', 'A certificate fingerprint requires secure terminal transport');
  }
  const actual = peerFingerprint(socket);
  if (!actual || !expected.some((fingerprint) => timingSafeFingerprintMatch(fingerprint, actual))) {
    throw terminalTlsError('certificate_mismatch', 'The cloud terminal certificate does not match the configured fingerprint');
  }
}

function createTerminalWebSocketFactory(settings, options = {}) {
  const WebSocket = options.WebSocket || NodeWebSocket;
  const expectedFingerprints = configuredFingerprints(settings);
  return function createTerminalWebSocket(url) {
    const secure = new URL(String(url)).protocol === 'wss:';
    // Never disable standard TLS validation for an unpinned server. A pin is
    // the explicit opt-in that permits a private/self-signed server cert.
    return new WebSocket(url, {
      perMessageDeflate: false,
      rejectUnauthorized: secure ? expectedFingerprints.length === 0 : undefined
    });
  };
}

function createTerminalPeerVerifier(settings) {
  const expectedFingerprints = configuredFingerprints(settings);
  return function verify(socket, url) {
    verifyTerminalPeer(socket, expectedFingerprints, url);
  };
}

module.exports = {
  createTerminalWebSocketFactory,
  createTerminalPeerVerifier,
  verifyTerminalPeer,
  peerFingerprint,
  timingSafeFingerprintMatch
};
