'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLspController } = require('../main/lsp');
const { authStorageKey } = require('../main/server-identity');

test('main LSP cache scopes use decrypted settings and remain server/user isolated', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-main-lsp-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const firstServer = { ip: 'first.example', httpPort: 3100 };
  const secondServer = { ip: 'second.example', httpPort: 3100 };
  let currentServer = firstServer;
  let firstUser = 'user-a';
  let firstExpiresAt = 0;
  let currentTime = 1_000_000;
  const settings = {
    paths: { clientAnalysisCache: path.join(root, 'cache') },
    async readServerSettings() { return Object.assign({}, currentServer); },
    readAuth() {
      return {
        servers: {
          [authStorageKey(firstServer)]: { token: 'first', expiresAt: firstExpiresAt, user: { id: firstUser } },
          [authStorageKey(secondServer)]: { token: 'second', user: { id: 'user-b' } }
        }
      };
    },
    readLspSettings() {
      return { mode: 'local', clientCacheMode: 'lazy', clientCacheSizeMiB: 1, clientCacheDependencyIndexEnabled: false };
    }
  };
  const controller = createLspController({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWindow: () => null,
    settings,
    now: () => currentTime
  });
  controller.registerIpc();
  const scope = {
    workspace: { kind: 'personal', folderKey: 'pworkspace' },
    languageId: 'javascript',
    runtimeId: 'node:22',
    dependencyRevision: 'revision-one'
  };
  const value = { isIncomplete: false, items: [{ label: 'alpha', kind: 3, insertText: 'alpha' }] };
  assert.equal((await handlers.get('lsp:client-cache-put')({}, scope, 'sha256:key', value)).stored, true);

  currentServer = secondServer;
  controller.dispose();
  assert.equal(await handlers.get('lsp:client-cache-get')({}, scope, 'sha256:key'), null);
  currentServer = firstServer;
  controller.dispose();
  assert.equal((await handlers.get('lsp:client-cache-get')({}, scope, 'sha256:key')).items[0].label, 'alpha');

  firstUser = 'user-c';
  controller.dispose();
  assert.equal(await handlers.get('lsp:client-cache-get')({}, scope, 'sha256:key'), null);
  assert.equal((await handlers.get('lsp:client-cache-put')({}, scope, 'sha256:key', value)).stored, true);

  firstExpiresAt = currentTime + 10;
  currentServer = Object.assign({}, firstServer, { apiKey: 'api-one' });
  controller.dispose();
  assert.equal((await handlers.get('lsp:client-cache-get')({}, scope, 'sha256:key')).items[0].label, 'alpha');
  currentTime += 11;
  assert.equal(await handlers.get('lsp:client-cache-get')({}, scope, 'sha256:key'), null,
    'natural token expiry must switch cache identity when API-key fallback begins');
  assert.equal((await handlers.get('lsp:client-cache-put')({}, scope, 'sha256:key', value)).stored, true);
  currentServer = Object.assign({}, firstServer, { apiKey: 'api-two' });
  controller.dispose();
  assert.equal(await handlers.get('lsp:client-cache-get')({}, scope, 'sha256:key'), null,
    'rotating the effective API key must create a new cache namespace');
});
