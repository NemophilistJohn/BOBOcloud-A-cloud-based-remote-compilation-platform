'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore } = require('../main/settings-store');
const { createLspController } = require('../main/lsp');
const { LspTransport } = require('../lsp-transport');

function storeFixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-lsp-cache-settings-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  return createSettingsStore({ app: { isPackaged: false, getPath: () => userData } });
}

test('cache preparation strategy is independent of disk persistence and capacity', (t) => {
  const store = storeFixture(t);
  assert.equal(store.readLspSettings().clientCacheStrategy, 'smart');
  let settings = store.writeLspSettings({ clientCacheStrategy: 'project', clientCacheMode: 'off', clientCacheSizeMiB: 1 });
  assert.equal(settings.clientCacheStrategy, 'project');
  assert.equal(settings.clientCacheMode, 'off');
  settings = store.writeLspSettings({ clientCacheMode: 'lazy', clientCacheDependencyIndexEnabled: true });
  assert.equal(settings.clientCacheStrategy, 'project');
  assert.equal(settings.clientCacheDependencyIndexEnabled, true);
  assert.equal(settings.clientCacheSizeMiB, 1);
  assert.equal(store.readLspSettings().clientCacheStrategy, 'project');
  assert.equal(store.writeLspSettings({ clientCacheStrategy: 'on-demand' }).clientCacheStrategy, 'on-demand');
});

test('legacy cache policies migrate while retaining explicit persistence preferences', (t) => {
  const store = storeFixture(t);
  for (const [legacy, expected] of [['off', 'off'], ['session', 'lazy'], ['persistent', 'active']]) {
    fs.writeFileSync(store.paths.lsp, JSON.stringify({ mode: 'standard', clientCacheMode: legacy, clientCacheSizeMiB: 12, clientCacheDependencyIndexEnabled: true }));
    const settings = store.readLspSettings();
    assert.equal(settings.clientCacheMode, expected);
    assert.equal(settings.clientCacheStrategy, 'smart');
    assert.equal(settings.clientCacheDependencyIndexEnabled, expected !== 'off');
    assert.equal(settings.clientCacheSizeMiB, 12);
  }
  assert.equal(store.writeLspSettings({ clientCacheStrategy: 'unsupported' }).clientCacheStrategy, 'smart');
});

test('dependency index controls forward bounded queries and reject host paths at main IPC', async (t) => {
  const handlers = new Map();
  const sent = [];
  const originalSend = LspTransport.prototype.sendControl;
  LspTransport.prototype.sendControl = function(type, payload) { sent.push({ type, payload }); return true; };
  t.after(() => { LspTransport.prototype.sendControl = originalSend; });
  const controller = createLspController({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    getWindow: () => null,
    settings: storeFixture(t)
  });
  t.after(() => controller.dispose());
  controller.registerIpc();
  const control = handlers.get('lsp:control');
  await control({}, { type: 'lsp.dependency.index.request', params: { requestId: 'old', maxBytes: 65536 } });
  assert.deepEqual(sent[0].payload, { requestId: 'old', cursor: '', maxBytes: 65536 });
  await control({}, { type: 'lsp.dependency.index.request', params: { requestId: 'scoped', queryKind: 'module', module: '@scope/package', prefix: 'ar', maxBytes: 65536 } });
  assert.equal(sent[1].payload.module, '@scope/package');
  assert.equal(sent[1].payload.queryKind, 'module');
  for (const params of [{ queryKind: 'shell' }, { module: '../escape' }, { module: 'C:/host/file' }, { prefix: 'a\nb' }, { module: 'x'.repeat(257) }]) {
    await assert.rejects(control({}, { type: 'lsp.dependency.index.request', params: { requestId: 'invalid', ...params } }), /Invalid dependency API/);
  }
  assert.equal(sent.length, 2);
});
