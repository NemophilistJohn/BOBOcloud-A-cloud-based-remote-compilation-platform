(function(global) {
  'use strict';
  var BOBO = global.BOBO = global.BOBO || {};

  function normalizedPort(value, fallback) {
    var port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
  }

  function normalizeHost(value) {
    var host = String(value || '').trim();
    if (!host) return '';
    return host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  }

  function endpoint(settings, kind) {
    var value = settings && typeof settings === 'object' ? settings : {};
    var host = normalizeHost(value.ip);
    if (!host) return '';
    var secure = value.secureTransport === true;
    var port = kind === 'ws'
      ? normalizedPort(value.wsPort, 3101)
      : kind === 'dap-child'
        ? normalizedPort(value.dapChildWsPort, 3102)
        : normalizedPort(value.httpPort, 3100);
    return (secure ? 'https' : 'http') + '://' + host + ':' + port;
  }

  function websocket(settings, path, kind) {
    var base = endpoint(settings, kind || 'ws');
    if (!base) return '';
    return base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + (path || '/ws');
  }

  BOBO.serverTransport = { endpoint: endpoint, websocket: websocket, normalizeHost: normalizeHost, normalizedPort: normalizedPort };
})(window);
