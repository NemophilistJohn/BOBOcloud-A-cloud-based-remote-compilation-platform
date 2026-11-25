'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnrollmentLink } = require('../main/enrollment-link');
const { createEnrollmentController } = require('../main/enrollment');
const { authStorageKey } = require('../main/server-identity');
const { LanguagePackManager } = require('../language-pack-manager');

const pin = 'AB'.repeat(32);
const token = 'A'.repeat(43);
const payload = { v: 1, host: 'server.example', httpPort: 3100, wsPort: 3101, dapChildWsPort: 3102, certificateFingerprints: [pin], token, kind: 'root' };
const linkFor = (value = payload) => 'bobocloud://enroll#' + Buffer.from(JSON.stringify(value)).toString('base64url');
const event = id => ({ sender: { id } });

test('all bundled language packs load with enrollment messages', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-enrollment-i18n-'));
  const manager = new LanguagePackManager({ builtinRoot: path.join(__dirname, '..', 'language-packs'), userDataPath: directory });
  t.after(() => { manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const startup = manager.startup();
  assert.deepEqual(startup.errors, []);
  assert.equal(startup.packs.length, 3);
  for (const id of ['en', 'zh-CN', 'ja']) {
    manager.setActive(id);
    assert.notEqual(manager.t('enrollment.auth.addDevice'), 'enrollment.auth.addDevice');
  }
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function fixture(overrides = {}) {
  let settings = { ip: 'old.example', secureTransport: true, certificateFingerprints: [], httpPort: 3100, wsPort: 3101, dapChildWsPort: 3102 };
  let auth = { servers: {} };
  let writable = true;
  const handlers = {};
  const calls = [];
  const installs = [];
  const future = new Date(Date.now() + 3600000).toISOString();
  const result = { success: true, token: 'app-session', expiresAt: future, user: { id: 'u1', username: 'root' }, data: { syncCredential: { mode: 'root', password: 'linux-root-secret' } } };
  const options = {
    ipcMain: { handle(name, fn) { handlers[name] = fn; } },
    settings: {
      async readServerSettings() { return structuredClone(settings); },
      readAuth() { return structuredClone(auth); },
      writeAuth(value) { if (!writable) return false; auth = structuredClone(value); return true; }
    },
    session: { fromPartition() {
      let verify;
      return {
        setCertificateVerifyProc(fn) { verify = fn; },
        async fetch(url, opts) {
          const body = JSON.parse(opts.body);
          calls.push({ url, body });
          if (verify) {
            const result = await new Promise(resolve => verify({ hostname: new URL(url).hostname, certificate: { fingerprint256: overrides.presentedPin || pin } }, resolve));
            if (result !== 0) throw new Error('certificate rejected');
          }
          if (overrides.fetch) return overrides.fetch(body, url);
          return new Response(JSON.stringify(body.action === 'inspectEnrollment'
            ? { success: true, data: { kind: payload.kind, version: '3.0.0', password: 'must-not-leak' } }
            : result));
        },
        async closeAllConnections() {}
      };
    } },
    async applySettings(value) { settings = structuredClone(value); return true; },
    async installSyncCredential(value, previous) { installs.push({ value, previous }); if (overrides.installError) throw Error('failure'); },
    fetch: overrides.refreshFetch || (async () => new Response(JSON.stringify({ success: true, data: { syncCredential: { mode: 'root', password: 'linux-root-secret' } } })))
  };
  const controller = createEnrollmentController(options); controller.registerIpc();
  return { handlers, calls, installs, result, controller, getSettings: () => settings, setSettings: value => { settings = structuredClone(value); }, getAuth: () => auth, setAuth: value => { auth = structuredClone(value); }, setWritable: value => { writable = value; } };
}

test('parser strictly rejects invalid URLs, endpoint, token, and TLS pins', () => {
  assert.equal(parseEnrollmentLink(linkFor()).host, payload.host);
  const bad = [
    'https://server.example/', 'bobocloud://other#abc', 'bobocloud://enroll?token=x#abc',
    linkFor({ ...payload, host: 'server.example/path' }), linkFor({ ...payload, host: ['server.example'] }),
    linkFor({ ...payload, host: '::1' }), linkFor({ ...payload, token: 'short' }),
    linkFor({ ...payload, certificateFingerprints: [] }), linkFor({ ...payload, certificateFingerprints: ['abcdef'] }),
    linkFor({ ...payload, httpPort: 65536 }), linkFor({ ...payload, kind: 'unknown' })
  ];
  for (const value of bad) assert.throws(() => parseEnrollmentLink(value), /invalidLink/);
});

test('preview validates the pin, returns only public data, and binds activation to sender', async () => {
  const f = fixture();
  const preview = await f.handlers['enrollment:preview'](event(1), linkFor());
  assert.equal(preview.kind, 'root');
  assert.equal(JSON.stringify(preview).includes(token), false);
  assert.equal(JSON.stringify(preview).includes('must-not-leak'), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.action, 'inspectEnrollment');
  await assert.rejects(() => f.handlers['enrollment:activate'](event(2), preview.id), /expiredPreview/);
  await f.handlers['enrollment:activate'](event(1), preview.id);
  assert.equal(f.calls.length, 1, 'preview and activation cannot consume the link');
  f.controller.dispose();
  const wrong = fixture({ presentedPin: 'CD'.repeat(32) });
  await assert.rejects(() => wrong.handlers['enrollment:preview'](event(1), linkFor()), /certificate rejected/);
  wrong.controller.dispose();
});

test('authentication keeps SSH secret in main and protects one-use recovery after save failure', async () => {
  const f = fixture();
  const preview = await f.handlers['enrollment:preview'](event(1), linkFor());
  await f.handlers['enrollment:activate'](event(1), preview.id);
  f.setWritable(false);
  await assert.rejects(() => f.handlers['enrollment:authenticate'](event(1), { id: preview.id, identity: 'root', password: 'app-pass' }), /save/);
  assert.equal(f.calls.filter(c => c.body.action === 'login').length, 1);
  f.setWritable(true);
  const result = await f.handlers['enrollment:authenticate'](event(1), { id: preview.id, identity: 'root', password: 'app-pass' });
  assert.equal(f.calls.filter(c => c.body.action === 'login').length, 1, 'a retry must not consume the link twice');
  assert.equal(result.syncReady, true);
  assert.equal(JSON.stringify(result).includes('linux-root-secret'), false);
  assert.equal(f.installs[0].value.password, 'linux-root-secret');
  assert.equal(f.getAuth().servers[authStorageKey(f.getSettings())].token, 'app-session');
  await assert.rejects(() => f.handlers['enrollment:authenticate'](event(1), { id: preview.id }), /expiredPreview/);
  f.controller.dispose();
});

test('server switch blocks sending credentials and ignores late authentication or refresh results', async () => {
  const gate = deferred();
  const f = fixture({ fetch: async body => body.action === 'inspectEnrollment'
    ? new Response(JSON.stringify({ success: true, data: { kind: 'root' } })) : gate.promise });
  const preview = await f.handlers['enrollment:preview'](event(1), linkFor());
  await f.handlers['enrollment:activate'](event(1), preview.id);
  const original = structuredClone(f.getSettings());
  f.setSettings({ ...original, ip: 'other.example' });
  await assert.rejects(() => f.handlers['enrollment:authenticate'](event(1), { id: preview.id, identity: 'root', password: 'app-pass' }), /serverChanged/);
  assert.equal(f.calls.length, 1);
  f.setSettings(original);
  const pending = f.handlers['enrollment:authenticate'](event(1), { id: preview.id, identity: 'root', password: 'app-pass' });
  await new Promise(resolve => setImmediate(resolve));
  f.setSettings({ ...original, ip: 'other.example' });
  gate.resolve(new Response(JSON.stringify(f.result)));
  await assert.rejects(() => pending, /serverChanged/);
  assert.equal(f.installs.length, 0);
  assert.deepEqual(f.getAuth().servers, {});
  f.controller.dispose();

  const refreshGate = deferred();
  const g = fixture({ refreshFetch: () => refreshGate.promise });
  const cfg = g.getSettings();
  g.setAuth({ servers: { [authStorageKey(cfg)]: { token: 'old', expiresAt: Date.now() + 60000 } } });
  const refresh = g.handlers['enrollment:refresh-sync']();
  await new Promise(resolve => setImmediate(resolve));
  g.setSettings({ ...cfg, ip: 'different.example' });
  refreshGate.resolve(new Response(JSON.stringify({ success: true, data: { syncCredential: { mode: 'root', password: 'secret' } } })));
  assert.equal(await refresh, false);
  assert.equal(g.installs.length, 0);
  g.controller.dispose();
});

test('failed sync installation preserves the session and reports degraded readiness', async () => {
  const f = fixture({ installError: true });
  const preview = await f.handlers['enrollment:preview'](event(1), linkFor());
  await f.handlers['enrollment:activate'](event(1), preview.id);
  const result = await f.handlers['enrollment:authenticate'](event(1), { id: preview.id, identity: 'root', password: 'app-pass' });
  assert.equal(result.syncReady, false);
  assert.equal(f.getAuth().servers[authStorageKey(f.getSettings())].token, 'app-session');
  f.controller.dispose();
});

test('a later preview supersedes an earlier in-flight preview', async () => {
  const gate = deferred(); let count = 0;
  const f = fixture({ fetch: async () => {
    count += 1;
    return count === 1 ? gate.promise : new Response(JSON.stringify({ success: true, data: { kind: 'root' } }));
  } });
  const old = f.handlers['enrollment:preview'](event(1), linkFor());
  await new Promise(resolve => setImmediate(resolve));
  const current = await f.handlers['enrollment:preview'](event(1), linkFor());
  gate.resolve(new Response(JSON.stringify({ success: true, data: { kind: 'root' } })));
  await assert.rejects(() => old, /expiredPreview/);
  await f.handlers['enrollment:activate'](event(1), current.id);
  f.controller.dispose();
});

test('refresh cannot overwrite credentials after account changes on the same server', async () => {
  const gate = deferred();
  const f = fixture({ refreshFetch: () => gate.promise });
  const cfg = f.getSettings();
  const key = authStorageKey(cfg);
  f.setAuth({ servers: { [key]: { token: 'old-account', expiresAt: Date.now() + 60000 } } });
  const pending = f.handlers['enrollment:refresh-sync']();
  await new Promise(resolve => setImmediate(resolve));
  f.setAuth({ servers: { [key]: { token: 'new-account', expiresAt: Date.now() + 60000 } } });
  gate.resolve(new Response(JSON.stringify({ success: true, data: { syncCredential: { mode: 'root', password: 'secret' } } })));
  assert.equal(await pending, false);
  assert.equal(f.installs.length, 0);
  f.controller.dispose();
});
