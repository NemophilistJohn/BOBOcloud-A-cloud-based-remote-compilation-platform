'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadServerComm(response, options = {}) {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'server-comm.js'), 'utf8');
  const BOBO = {
    state: { serverSettings: { ip: 'compiler.example' }, auth: {} }
  };
  const windowObject = { BOBO, AbortController: options.AbortController || globalThis.AbortController };
  vm.runInNewContext(source, {
    window: windowObject,
    document: {
      getElementById() { return null; },
      createDocumentFragment() { return { appendChild() {} }; },
      createElement() { return { appendChild() {} }; },
      createTextNode(value) { return { textContent: String(value) }; }
    },
    fetch: options.fetch || (() => Promise.resolve(response)),
    console,
    Date,
    Promise,
    JSON,
    setTimeout,
    clearTimeout
  }, { filename: 'src/server-comm.js' });
  return BOBO;
}

test('plain-text HTTPS protocol mismatch returns a setup error instead of a JSON parser error', async () => {
  const BOBO = loadServerComm({
    ok: false,
    status: 400,
    text() { return Promise.resolve('Client sent an HTTP request to an HTTPS server.'); }
  });

  const result = await BOBO.sendToServer('serverInfo', {}, { quiet: true });
  assert.equal(result.success, false);
  assert.equal(result.error, 'The server requires HTTPS, but secure transport is disabled in Server Settings.');
  assert.equal(result.status, 400);
  assert.equal(result.errorCode, 'invalid_server_response');
});

test('unexpected non-JSON responses stay actionable and never expose parser internals', async () => {
  const BOBO = loadServerComm({
    ok: false,
    status: 502,
    text() { return Promise.resolve('<html>bad gateway</html>'); }
  });

  const result = await BOBO.sendToServer('serverInfo', {}, { quiet: true });
  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.error, 'The server returned an invalid response. Check the server address and transport setting.');
  assert.doesNotMatch(result.error, /Unexpected token/i);
});

test('request timeouts abort fetch and return a stable transport error', async () => {
  let observedSignal = null;
  const BOBO = loadServerComm(null, {
    fetch(_url, init) {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
  });

  const result = await BOBO.sendToServer('applyProjectPackageChanges', {}, { quiet: true, timeoutMs: 5 });
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.success, false);
  assert.equal(result.error, 'The server request timed out.');
  assert.equal(result.errorCode, 'transport_timeout');
});

test('quiet HTTP failures expose integer Retry-After seconds', async () => {
  const BOBO = loadServerComm({
    ok: false,
    status: 409,
    headers: { get(name) { return name === 'Retry-After' ? '3' : null; } },
    text() { return Promise.resolve(JSON.stringify({ success: false, errorCode: 'package_plan_in_use', error: 'busy' })); }
  });

  const result = await BOBO.sendToServer('applyProjectPackageChanges', {}, { quiet: true });
  assert.equal(result.retryAfterSeconds, 3);
  assert.equal(result.errorCode, 'package_plan_in_use');
});
