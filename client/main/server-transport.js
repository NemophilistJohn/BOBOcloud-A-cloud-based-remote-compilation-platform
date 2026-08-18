'use strict';

function normalizedPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeHost(value) {
  let host = String(value || '').trim();
  if (!host) return '';
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  return host;
}

function endpoint(settings, kind = 'http') {
  const value = settings && typeof settings === 'object' ? settings : {};
  const host = normalizeHost(value.ip);
  if (!host) return '';
  const secure = value.secureTransport === true;
  const port = kind === 'ws'
    ? normalizedPort(value.wsPort, 3101)
    : kind === 'dap-child'
      ? normalizedPort(value.dapChildWsPort, 3102)
      : normalizedPort(value.httpPort, 3100);
  return `${secure ? 'https' : 'http'}://${host}:${port}`;
}

module.exports = { endpoint, normalizeHost, normalizedPort };
