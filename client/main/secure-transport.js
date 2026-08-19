'use strict';

const crypto = require('crypto');

function normalizeFingerprint(value) {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function configuredFingerprints(settings) {
  const value = settings && typeof settings === 'object' ? settings : {};
  const candidates = [];
  if (value.certificateFingerprint) candidates.push(value.certificateFingerprint);
  if (Array.isArray(value.certificateFingerprints)) candidates.push(...value.certificateFingerprints);
  return [...new Set(candidates.map(normalizeFingerprint).filter(Boolean))];
}

function normalizeHost(value) {
  return String(value || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function certificateFingerprints(certificate) {
  const values = [];
  if (certificate && certificate.fingerprint) values.push(certificate.fingerprint);
  if (certificate && certificate.fingerprint256) values.push(certificate.fingerprint256);
	if (certificate && certificate.raw) {
		try { values.push(crypto.createHash('sha256').update(certificate.raw).digest('hex')); } catch (_) {}
	}
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
    const expected = configuredFingerprints(current);
    const requestedHost = normalizeHost(request && (request.hostname || request.host));
    if (!expected || !requestedHost || requestedHost !== normalizeHost(current.ip)) return -3;
    if (expected.length === 0) return -3;
    const received = certificateFingerprints(request && request.certificate);
    return expected.some((fingerprint) => received.includes(fingerprint)) ? 0 : -2;
  }
  return { update, verify };
}

module.exports = { createSecureTransportGuard, normalizeFingerprint, configuredFingerprints, certificateFingerprints, normalizeHost };
