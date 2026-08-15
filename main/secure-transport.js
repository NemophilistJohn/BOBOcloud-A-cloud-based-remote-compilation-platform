'use strict';

const crypto = require('crypto');

function normalizeFingerprint(value) {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function normalizeHost(value) {
  return String(value || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function certificateFingerprints(certificate) {
  const values = [];
  if (certificate && certificate.fingerprint) values.push(certificate.fingerprint);
  if (certificate && certificate.fingerprint256) values.push(certificate.fingerprint256);
	if (certificate && certificate.data) {
		try {
			let raw = certificate.data;
			if (typeof raw === 'string' && raw.includes('BEGIN CERTIFICATE')) {
				raw = Buffer.from(raw.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, ''), 'base64');
			}
			values.push(crypto.createHash('sha256').update(raw).digest('hex'));
		} catch (_) {}
	}
  return values.map(normalizeFingerprint).filter(Boolean);
}

function createSecureTransportGuard() {
  let current = {};
  function update(settings) {
    current = Object.assign({}, settings || {});
  }
  function verify(request) {
    if (current.secureTransport !== true) return -3; // Chromium's normal validation.
    const expected = normalizeFingerprint(current.certificateFingerprint);
    const requestedHost = normalizeHost(request && (request.hostname || request.host));
    if (!expected || !requestedHost || requestedHost !== normalizeHost(current.ip)) return -3;
    return certificateFingerprints(request && request.certificate).includes(expected) ? 0 : -2;
  }
  return { update, verify };
}

module.exports = { createSecureTransportGuard, normalizeFingerprint, certificateFingerprints, normalizeHost };
