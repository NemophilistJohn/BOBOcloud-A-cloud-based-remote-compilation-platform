'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { endpoint } = require('../main/server-transport');
const { createSecureTransportGuard } = require('../main/secure-transport');

test('server transport keeps SSH host separate and derives encrypted endpoints', () => {
  const settings = { ip: '81.70.51.43', secureTransport: true, httpPort: 3100, wsPort: 3101, dapChildWsPort: 3102 };
  assert.equal(endpoint(settings, 'http'), 'https://81.70.51.43:3100');
  assert.equal(endpoint(settings, 'ws'), 'https://81.70.51.43:3101');
  assert.equal(endpoint(settings, 'dap-child'), 'https://81.70.51.43:3102');
});

test('certificate guard only overrides Chromium validation for a pinned configured host', () => {
  const guard = createSecureTransportGuard();
  guard.update({ ip: '81.70.51.43', secureTransport: true, certificateFingerprint: 'AA:BB:CC' });
  assert.equal(guard.verify({ hostname: '81.70.51.43', certificate: { fingerprint: 'AA-BB-CC' } }), 0);
  assert.equal(guard.verify({ hostname: '81.70.51.43', certificate: { fingerprint: '00:11:22' } }), -2);
  assert.equal(guard.verify({ hostname: 'different.test', certificate: { fingerprint: 'AA:BB:CC' } }), -3);
});
