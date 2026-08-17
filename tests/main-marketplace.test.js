'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OFFICIAL_API_URL,
  OFFICIAL_RAW_ORIGIN,
  createMarketplaceController,
  fetchOfficialCatalog
} = require('../main/marketplace');

const REVISION = 'a'.repeat(40);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function metadataHash(source) {
  return sha256(Buffer.from(source.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function jsonBytes(value, crlf = false) {
  const text = JSON.stringify(value, null, 2) + '\n';
  return Buffer.from(crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

function response(source, options = {}) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8');
  return {
    ok: options.status === undefined ? true : options.status >= 200 && options.status < 300,
    status: options.status === undefined ? 200 : options.status,
    redirected: options.redirected === true,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(bytes.length) : null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function rawUrl(relative) {
  return OFFICIAL_RAW_ORIGIN + '/NemophilistJohn/BOBOCloud-Marketplace-Registry/' + REVISION + '/' + relative;
}

function artifactUrl(version) {
  return OFFICIAL_RAW_ORIGIN + '/acme/sample-plugin/v' + version + '/artifacts/sample.boboplugin';
}

function createFixture(options = {}) {
  const id = options.id || 'acme.sample-plugin';
  const [publisher, name] = id.split('.');
  const latest = options.latest || '1.0.0';
  const versions = options.versions || ['0.9.0', latest];
  const artifacts = new Map();
  const descriptors = new Map();
  const descriptorRecords = {};
  for (const version of versions) {
    const artifact = version === latest
      ? (options.artifact || Buffer.from('latest-plugin-archive', 'utf8'))
      : Buffer.from('plugin-archive-' + version, 'utf8');
    const url = options.artifactUrl || artifactUrl(version);
    artifacts.set(url, artifact);
    const descriptor = {
      schemaVersion: 1,
      id: options.descriptorId || id,
      version,
      publishedAt: '2026-08-17T00:00:00.000Z',
      engines: { bobocloud: '>=2.6.0 <3.0.0', pluginApi: '^1.2.0' },
      artifact: { format: 'boboplugin', url, sha256: sha256(artifact), size: artifact.length },
      source: { repository: 'https://github.com/acme/sample-plugin', ref: 'v' + version },
      permissions: ['commands.register', 'sourceControl.register', 'fileDecorations.scm'],
      locales: ['en', 'zh-CN', 'ja']
    };
    const source = jsonBytes(descriptor, version === latest);
    const relative = 'packages/' + publisher + '/' + name + '/versions/' + version + '.json';
    descriptors.set(relative, source);
    descriptorRecords[version] = { path: relative, sha256: metadataHash(source) };
  }
  const packageRelative = 'packages/' + publisher + '/' + name + '/index.json';
  const packageIndex = {
    schemaVersion: 1,
    id,
    publisher,
    name,
    summary: {
      displayName: { en: 'Sample Plugin', 'zh-CN': '示例插件', ja: 'サンプルプラグイン' },
      description: { en: 'A verified test package.', 'zh-CN': '已验证的测试插件。', ja: '検証済みのテストプラグインです。' },
      categories: ['testing']
    },
    latest,
    versions: descriptorRecords
  };
  const packageSource = jsonBytes(packageIndex);
  const shardRelative = 'indexes/official.json';
  const shard = {
    schemaVersion: 1,
    id: 'official',
    packages: [{ id, path: packageRelative, latest, sha256: metadataHash(packageSource) }]
  };
  const shardSource = jsonBytes(shard);
  const root = {
    schemaVersion: 1,
    registryId: 'bobocloud.marketplace',
    updatedAt: '2026-08-17T00:00:00.000Z',
    format: {
      shardPath: 'indexes/<shard>.json',
      packagePath: 'packages/<publisher>/<name>/index.json',
      versionPath: 'packages/<publisher>/<name>/versions/<semver>.json'
    },
    policy: {
      packageIdPattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$',
      artifactProtocol: 'https',
      artifactHosts: ['raw.githubusercontent.com'],
      artifactDigest: 'sha256',
      immutableVersionDocuments: true
    },
    shards: [{ id: 'official', path: shardRelative, sha256: metadataHash(shardSource), count: 1 }]
  };
  const responses = new Map();
  responses.set(OFFICIAL_API_URL, jsonBytes({ sha: REVISION }));
  responses.set(rawUrl('registry.json'), jsonBytes(root));
  responses.set(rawUrl(shardRelative), shardSource);
  responses.set(rawUrl(packageRelative), packageSource);
  for (const [relative, source] of descriptors) responses.set(rawUrl(relative), source);
  for (const [url, source] of artifacts) responses.set(url, source);
  const calls = [];
  const state = { online: true };
  const fetch = async (url, request) => {
    calls.push({ url, request });
    if (!state.online) throw new Error('offline');
    const source = responses.get(url);
    if (source instanceof Error) throw source;
    if (!source) return response('missing', { status: 404 });
    if (source && source.redirected) return response(source.body || '', { redirected: true });
    return response(source);
  };
  return { id, latest, versions, responses, calls, state, fetch, descriptors, artifacts };
}

async function createHarness(t, fixture, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-marketplace-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false }
  };
  const records = new Map((options.installed || []).map((record) => [record.id, record]));
  const installs = [];
  const pluginManager = {
    root: path.join(root, 'plugins'),
    initialize: async () => Array.from(records.values()),
    list: () => Array.from(records.values()),
    get: (id) => records.get(id) || null,
    installArchiveFromPath: async (archivePath, expected) => {
      installs.push({ archivePath, expected, bytes: await fsp.readFile(archivePath) });
      if (typeof options.installArchiveFromPath === 'function') return options.installArchiveFromPath(archivePath, expected, records);
      const result = {
        id: expected.id,
        version: expected.version,
        status: 'disabled',
        enabled: false,
        grantedPermissions: []
      };
      records.set(result.id, result);
      return result;
    }
  };
  const controller = createMarketplaceController({
    app: { getPath: () => root, getVersion: () => '2.6.0' },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWindow: () => window,
    pluginManager,
    fetch: fixture.fetch,
    cachePath: path.join(root, 'cache', 'catalog.json')
  });
  controller.registerIpc();
  return { root, handlers, window, records, installs, controller, pluginManager };
}

test('official catalog is commit-pinned, canonicalizes CRLF digests, and hydrates only latest metadata', async () => {
  const fixture = createFixture();
  const catalog = await fetchOfficialCatalog(fixture.fetch);
  assert.equal(catalog.revision, REVISION);
  assert.equal(catalog.packages.length, 1);
  assert.equal(catalog.packages[0].latestDescriptor.version, '1.0.0');
  assert.deepEqual(catalog.packages[0].versions.map((entry) => entry.version).sort(), ['0.9.0', '1.0.0']);
  assert.ok(fixture.calls.every((call) => call.request.redirect === 'error'));
  assert.ok(fixture.calls.some((call) => call.url === OFFICIAL_API_URL));
  assert.ok(fixture.calls.some((call) => call.url === rawUrl('registry.json')));
  assert.equal(fixture.calls.some((call) => call.url.endsWith('/versions/0.9.0.json')), false, 'history descriptors are lazy');
  assert.equal(fixture.calls.some((call) => call.url.includes('/main/')), false, 'raw metadata must use the immutable revision');
});

test('catalog rejects digest failures, path traversal, multi-dot ids, and non-approved artifact hosts', async () => {
  const brokenDigest = createFixture();
  brokenDigest.responses.set(rawUrl('indexes/official.json'), jsonBytes({ schemaVersion: 1, id: 'official', packages: [] }));
  await assert.rejects(() => fetchOfficialCatalog(brokenDigest.fetch), { code: 'plugins.marketplace.integrity' });

  const traversal = createFixture();
  const rootSource = traversal.responses.get(rawUrl('registry.json'));
  const root = JSON.parse(rootSource.toString('utf8'));
  root.shards[0].path = '../indexes/official.json';
  traversal.responses.set(rawUrl('registry.json'), jsonBytes(root));
  await assert.rejects(() => fetchOfficialCatalog(traversal.fetch), { code: 'plugins.marketplace.registry' });

  const multiDot = createFixture({ id: 'acme.sample.plugin' });
  await assert.rejects(() => fetchOfficialCatalog(multiDot.fetch), { code: 'plugins.marketplace.registry' });

  const unapprovedArtifact = createFixture({ artifactUrl: 'https://example.invalid/acme/sample/v1.0.0/sample.boboplugin' });
  await assert.rejects(() => fetchOfficialCatalog(unapprovedArtifact.fetch), { code: 'plugins.marketplace.artifact-host' });
});

test('marketplace returns safe installed state and serves only an explicit verified-cache fallback offline', async (t) => {
  const fixture = createFixture();
  const harness = await createHarness(t, fixture, {
    installed: [{ id: fixture.id, version: '0.9.0', status: 'enabled', enabled: true, grantedPermissions: ['commands.register'] }]
  });
  const first = await harness.controller.list();
  assert.equal(first.provenance, 'network');
  assert.equal(first.stale, false);
  assert.equal(first.packages[0].installedVersion, '0.9.0');
  assert.equal(first.packages[0].installedStatus, 'enabled');
  assert.equal(first.packages[0].updateAvailable, true);
  assert.equal(first.packages[0].versions.length, 1);
  assert.equal(JSON.stringify(first).includes('sample.boboplugin'), false, 'catalog must not reveal installation URLs');

  fixture.state.online = false;
  const offline = await harness.controller.refresh();
  assert.equal(offline.provenance, 'verified-cache');
  assert.equal(offline.stale, true);

  fixture.state.online = true;
  fixture.responses.set(OFFICIAL_API_URL, { redirected: true, body: 'redirected' });
  await assert.rejects(() => harness.controller.refresh(), { code: 'plugins.marketplace.redirect' });

  const noCache = createFixture();
  noCache.state.online = false;
  const noCacheHarness = await createHarness(t, noCache);
  await assert.rejects(() => noCacheHarness.controller.list(), { code: 'plugins.marketplace.network' });
});

test('marketplace installs only the verified latest artifact and blocks online historical versions and downgrades', async (t) => {
  const fixture = createFixture();
  const harness = await createHarness(t, fixture);
  const installed = await harness.controller.install(fixture.id);
  assert.equal(installed.status, 'disabled');
  assert.deepEqual(installed.grantedPermissions, []);
  assert.equal(harness.installs.length, 1);
  assert.equal(harness.installs[0].expected.id, fixture.id);
  assert.equal(harness.installs[0].expected.version, fixture.latest);
  assert.deepEqual(harness.installs[0].bytes, fixture.artifacts.get(artifactUrl(fixture.latest)));
  assert.equal(fs.existsSync(harness.installs[0].archivePath), false, 'private download staging must be removed after install');

  const olderFixture = createFixture();
  const olderHarness = await createHarness(t, olderFixture);
  await assert.rejects(() => olderHarness.controller.install(olderFixture.id, '0.9.0'), { code: 'plugins.marketplace.version' });
  assert.equal(olderFixture.calls.some((call) => call.url.endsWith('/versions/0.9.0.json')), false, 'historical releases require manual package import');

  const downgradeFixture = createFixture();
  const downgradeHarness = await createHarness(t, downgradeFixture, {
    installed: [{ id: downgradeFixture.id, version: '1.1.0', status: 'enabled', enabled: true, grantedPermissions: ['commands.register'] }]
  });
  await assert.rejects(() => downgradeHarness.controller.install(downgradeFixture.id), { code: 'plugins.marketplace.downgrade' });
  assert.equal(downgradeHarness.installs.length, 0);
});

test('artifact hash and identity failures do not reach installation, and marketplace IPC is sender-bound', async (t) => {
  const badArtifact = createFixture();
  badArtifact.responses.set(artifactUrl(badArtifact.latest), Buffer.from('tampered-archive', 'utf8'));
  const badArtifactHarness = await createHarness(t, badArtifact);
  await assert.rejects(() => badArtifactHarness.controller.install(badArtifact.id), { code: 'plugins.marketplace.artifact' });
  assert.equal(badArtifactHarness.installs.length, 0);

  const identityFixture = createFixture({ descriptorId: 'acme.other-plugin' });
  const identityHarness = await createHarness(t, identityFixture);
  await assert.rejects(() => identityHarness.controller.install(identityFixture.id), { code: 'plugins.marketplace.registry' });
  assert.equal(identityHarness.installs.length, 0);

  const ipcFixture = createFixture();
  const ipcHarness = await createHarness(t, ipcFixture);
  await assert.rejects(
    () => ipcHarness.handlers.get('plugins:marketplace-list')({ sender: {} }),
    { code: 'plugins.marketplace.sender' }
  );
  const listed = await ipcHarness.handlers.get('plugins:marketplace-list')({ sender: ipcHarness.window.webContents });
  assert.equal(listed.packages[0].id, ipcFixture.id);
});
