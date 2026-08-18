'use strict';

// This is deliberately a terminal-only main-process socket factory. It uses
// Node TLS rather than Chromium networking, so it verifies a configured
// certificate fingerprint itself before TerminalTransport sends credentials.

const crypto = require('crypto');
const NodeWebSocket = require('ws');
const { normalizeFingerprint } = require('./secure-transport');

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

function verifyTerminalPeer(socket, expectedFingerprint, url) {
  const expected = normalizeFingerprint(expectedFingerprint);
  const scheme = new URL(String(url)).protocol;
  if (!expected) return;
  if (scheme !== 'wss:') {
    throw terminalTlsError('certificate_unavailable', 'A certificate fingerprint requires secure terminal transport');
  }
  const actual = peerFingerprint(socket);
  if (!actual || !timingSafeFingerprintMatch(expected, actual)) {
    throw terminalTlsError('certificate_mismatch', 'The cloud terminal certificate does not match the configured fingerprint');
  }
}

function createTerminalWebSocketFactory(settings, options = {}) {
  const WebSocket = options.WebSocket || NodeWebSocket;
  const expectedFingerprint = normalizeFingerprint(settings && settings.certificateFingerprint);
  return function createTerminalWebSocket(url) {
    const secure = new URL(String(url)).protocol === 'wss:';
    // Never disable standard TLS validation for an unpinned server. A pin is
    // the explicit opt-in that permits a private/self-signed server cert.
    return new WebSocket(url, {
      perMessageDeflate: false,
      rejectUnauthorized: secure ? !expectedFingerprint : undefined
    });
  };
}

function createTerminalPeerVerifier(settings) {
  const expectedFingerprint = normalizeFingerprint(settings && settings.certificateFingerprint);
  return function verify(socket, url) {
    verifyTerminalPeer(socket, expectedFingerprint, url);
  };
}

module.exports = {
  createTerminalWebSocketFactory,
  createTerminalPeerVerifier,
  verifyTerminalPeer,
  peerFingerprint,
  timingSafeFingerprintMatch
};
