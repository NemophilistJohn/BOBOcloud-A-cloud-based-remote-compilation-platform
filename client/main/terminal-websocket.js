'use strict';

// Terminal and LSP keep separate lifecycles but share pre-credential TLS checks.
const {
  createCloudWebSocketFactory: createTerminalWebSocketFactory,
  createCloudPeerVerifier: createTerminalPeerVerifier,
  verifyCloudPeer: verifyTerminalPeer,
  peerFingerprint,
  timingSafeFingerprintMatch
} = require('./cloud-websocket');

module.exports = { createTerminalWebSocketFactory, createTerminalPeerVerifier, verifyTerminalPeer, peerFingerprint, timingSafeFingerprintMatch };
