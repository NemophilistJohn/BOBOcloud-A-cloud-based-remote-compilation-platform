'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore } = require('../main/settings-store');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  };
}

test('settings store encrypts server, auth, and AI credentials without changing its API', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-secret-settings-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const app = { isPackaged: false, getPath: () => userData };
  const store = createSettingsStore({ app, safeStorage: fakeSafeStorage() });

  await store.writeServerSettings({ ip: 'cloud.test', user: 'root', pass: 'ssh-secret', apiKey: 'server-secret', setupCompleted: true });
  store.writeAuth({ servers: { current: { token: 'session-secret' } } });
  store.writeAiSettings({
    schemaVersion: 3,
    chatProfiles: [{ id: 'chat', name: 'Chat', endpoint: 'https://ai.test', modelId: 'model', apiKey: 'ai-secret' }],
    inlineProfiles: [], chatProfileId: 'chat', inlineProfileId: ''
  });

  for (const name of ['server-settings.json', 'auth.json', 'ai-settings.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(userData, name), 'utf8'), /ssh-secret|server-secret|session-secret|ai-secret/);
  }
  assert.equal((await store.readServerSettings()).pass, 'ssh-secret');
  assert.equal(store.readAuth().servers.current.token, 'session-secret');
  assert.equal(store.readAiSettings().chatProfiles[0].apiKey, 'ai-secret');
});

test('an unreadable encrypted AI file is never replaced with migrated defaults', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-secret-recovery-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const app = { isPackaged: false, getPath: () => userData };
  const writer = createSettingsStore({ app, safeStorage: fakeSafeStorage() });
  assert.equal(writer.writeAiSettings({
    schemaVersion: 3,
    chatProfiles: [{ id: 'chat', name: 'Chat', endpoint: 'https://ai.test', modelId: 'model', apiKey: 'keep-me' }],
    inlineProfiles: [], chatProfileId: 'chat', inlineProfileId: ''
  }), true);
  const aiPath = path.join(userData, 'ai-settings.json');
  const encrypted = fs.readFileSync(aiPath);

  const unavailable = createSettingsStore({
    app,
    safeStorage: { isEncryptionAvailable: () => false }
  });
  assert.equal(unavailable.readAiSettings().chatProfiles.length, 0);
  assert.deepEqual(fs.readFileSync(aiPath), encrypted);

  const broken = createSettingsStore({
    app,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: () => { throw new Error('temporary keychain failure'); }
    }
  });
  assert.equal(broken.readAiSettings().chatProfiles.length, 0);
  assert.deepEqual(fs.readFileSync(aiPath), encrypted);
});

test('existing plaintext credentials migrate atomically when secure storage becomes available', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-secret-migration-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const app = { isPackaged: false, getPath: () => userData };
  fs.writeFileSync(path.join(userData, 'server-settings.json'), JSON.stringify({
    ip: 'cloud.test', user: 'root', pass: 'plain-ssh', apiKey: 'plain-server', setupCompleted: true
  }));
  fs.writeFileSync(path.join(userData, 'auth.json'), JSON.stringify({
    servers: { current: { token: 'plain-session' } }
  }));
  fs.writeFileSync(path.join(userData, 'ai-settings.json'), JSON.stringify({
    schemaVersion: 3,
    chatProfiles: [{ id: 'chat', name: 'Chat', endpoint: 'https://ai.test', modelId: 'model', apiKey: 'plain-ai' }],
    inlineProfiles: [], chatProfileId: 'chat', inlineProfileId: ''
  }));

  const store = createSettingsStore({ app, safeStorage: fakeSafeStorage() });
  assert.equal((await store.readServerSettings()).pass, 'plain-ssh');
  assert.equal(store.readAuth().servers.current.token, 'plain-session');
  assert.equal(store.readAiSettings().chatProfiles[0].apiKey, 'plain-ai');
  for (const name of ['server-settings.json', 'auth.json', 'ai-settings.json']) {
    const raw = fs.readFileSync(path.join(userData, name), 'utf8');
    assert.match(raw, /__bobocloudEncryptedV1/);
    assert.doesNotMatch(raw, /plain-ssh|plain-server|plain-session|plain-ai/);
  }
});

test('a failed plaintext migration preserves readable settings and original files', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-secret-migration-failure-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const app = { isPackaged: false, getPath: () => userData };
  const values = {
    'server-settings.json': { ip: 'cloud.test', user: 'root', pass: 'keep-ssh', setupCompleted: true },
    'auth.json': { servers: { current: { token: 'keep-session' } } },
    'ai-settings.json': {
      schemaVersion: 3,
      chatProfiles: [{ id: 'chat', name: 'Chat', endpoint: 'https://ai.test', modelId: 'model', apiKey: 'keep-ai' }],
      inlineProfiles: [], chatProfileId: 'chat', inlineProfileId: ''
    }
  };
  const originals = {};
  for (const [name, value] of Object.entries(values)) {
    const target = path.join(userData, name);
    fs.writeFileSync(target, JSON.stringify(value));
    originals[name] = fs.readFileSync(target);
  }
  const store = createSettingsStore({
    app,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('temporary encryption failure'); },
      decryptString: (value) => Buffer.from(value).toString('utf8')
    }
  });
  assert.equal((await store.readServerSettings()).pass, 'keep-ssh');
  assert.equal(store.readAuth().servers.current.token, 'keep-session');
  assert.equal(store.readAiSettings().chatProfiles[0].apiKey, 'keep-ai');
  for (const name of Object.keys(values)) {
    assert.deepEqual(fs.readFileSync(path.join(userData, name)), originals[name]);
  }
});
