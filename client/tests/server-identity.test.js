'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authStorageKey,
  credentialForServer,
  effectiveCredential,
  rcloneConnectionIdentity,
  serverAccountIdentity,
  serverEndpointIdentity,
  serverTransportIdentity
} = require('../main/server-identity');

function settings(overrides = {}) {
  return Object.assign({
    ip: 'compiler.example',
    user: 'root',
    pass: 'ssh-secret',
    apiKey: 'api-secret',
    secureTransport: true,
    httpPort: 3100,
    wsPort: 3101,
    dapChildWsPort: 3102,
    certificateFingerprints: ['AA:BB', '11:22']
  }, overrides);
}

test('server endpoint identity includes transport boundaries but ignores UI cadence', () => {
  const original = settings({ syncInterval: 30_000 });
  assert.equal(serverEndpointIdentity(original), serverEndpointIdentity(settings({ syncInterval: 5000 })));
  assert.notEqual(serverEndpointIdentity(original), serverEndpointIdentity(settings({ httpPort: 4100 })));
  assert.notEqual(serverEndpointIdentity(original), serverEndpointIdentity(settings({ secureTransport: false })));
  assert.notEqual(serverEndpointIdentity(original), serverEndpointIdentity(settings({ certificateFingerprints: ['AA:BB'] })));
});

test('effective account identity follows the credential actually used on the wire', () => {
  const now = 1_000_000;
  const current = settings({ apiKey: 'api-one' });
  const active = { token: 'session-token', expiresAt: now + 1, user: { id: 'user-a' } };
  const expired = { token: 'expired-token', expiresAt: now - 1, user: { id: 'stale-user' } };
  assert.equal(effectiveCredential(active, now), active);
  assert.equal(effectiveCredential(expired, now), null);
  assert.equal(serverAccountIdentity(current, active, now), 'user:user-a');
  assert.match(serverAccountIdentity(current, expired, now), /^api-key:[a-f0-9]{64}$/);
  assert.notEqual(
    serverAccountIdentity(current, expired, now),
    serverAccountIdentity(settings({ apiKey: 'api-two' }), expired, now)
  );
});

test('transport and rclone identities react only to their own credentials', () => {
  const original = settings();
  assert.notEqual(serverTransportIdentity(original), serverTransportIdentity(settings({ apiKey: 'next-api-key' })));
  assert.equal(serverTransportIdentity(original), serverTransportIdentity(settings({ pass: 'next-ssh-password' })));
  assert.notEqual(rcloneConnectionIdentity(original), rcloneConnectionIdentity(settings({ pass: 'next-ssh-password' })));
  assert.equal(rcloneConnectionIdentity(original), rcloneConnectionIdentity(settings({ apiKey: 'next-api-key' })));
});

test('auth storage keys never contain raw endpoint or credential data', () => {
  const key = authStorageKey(settings());
  assert.match(key, /^server-v2:[a-f0-9]{64}$/);
  assert.doesNotMatch(key, /compiler|secret|root/);
});

test('credential lookup prefers canonical storage and supports one-time legacy fallback', () => {
  const current = settings();
  const canonical = { token: 'canonical' };
  const legacy = { token: 'legacy' };
  assert.deepEqual(credentialForServer({ servers: { [current.ip]: legacy } }, current), {
    credential: legacy, key: current.ip, legacy: true
  });
  const key = authStorageKey(current);
  assert.deepEqual(credentialForServer({ servers: { [current.ip]: legacy, [key]: canonical } }, current), {
    credential: canonical, key, legacy: false
  });
});
