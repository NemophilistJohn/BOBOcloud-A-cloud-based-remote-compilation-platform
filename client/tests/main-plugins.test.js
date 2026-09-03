'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPluginController, readZipEntries } = require('../main/plugins');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeManifest(version, source, options = {}) {
  return {
    schemaVersion: 1,
    id: options.id || 'acme.sample-plugin',
    displayName: 'Sample Plugin',
    description: 'A constrained test plugin.',
    version,
    engines: { pluginApi: '^1.0.0', bobocloud: '>=2.6.0 <3.0.0' },
    main: 'dist/extension.js',
    activationEvents: ['onStartupFinished'],
    permissions: options.permissions || ['commands.register', 'services.read'],
    contributes: { commands: [{ command: 'acme.sample-plugin.hello', title: 'Hello' }] },
    integrity: {
      algorithm: 'sha256',
      files: { 'dist/extension.js': hash(source) }
    }
  };
}

async function writePackage(root, version = '1.0.0', source = 'export function activate() {}\n') {
  await fsp.mkdir(path.join(root, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(root, 'dist', 'extension.js'), source, 'utf8');
  await fsp.writeFile(path.join(root, 'manifest.json'), JSON.stringify(makeManifest(version, source), null, 2), 'utf8');
}

async function writeDocumentViewPackage(root) {
  const mainSource = 'export async function activate(context) { await context.documentViews.register({ id: "acme.sample-plugin.preview", title: "Preview" }); }\n';
  const viewSource = 'export async function activate(context) { await context.read(0, 4); }\n';
  const styleSource = ':root { color: white; }\n';
  await fsp.mkdir(path.join(root, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(root, 'dist', 'extension.js'), mainSource, 'utf8');
  await fsp.writeFile(path.join(root, 'dist', 'view.js'), viewSource, 'utf8');
  await fsp.writeFile(path.join(root, 'dist', 'view.css'), styleSource, 'utf8');
  const manifest = makeManifest('1.0.0', mainSource, {
    permissions: ['documentViews.register', 'documents.read']
  });
  manifest.schemaVersion = 2;
  manifest.engines.pluginApi = '^1.3.0';
  manifest.contributes = {
    documentViewers: [{
      id: 'acme.sample-plugin.preview',
      entry: 'dist/view.js',
      extensions: ['.pdf', '.csv', '.tar.gz'],
      resources: ['dist/view.css'],
      priority: 10
    }]
  };
  manifest.integrity.files = {
    'dist/extension.js': hash(mainSource),
    'dist/view.js': hash(viewSource),
    'dist/view.css': hash(styleSource)
  };
  await fsp.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { mainSource, viewSource, styleSource };
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '', 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + content.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

async function createHarness(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobocloud-plugins-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  await fsp.mkdir(workspaceRoot);
  const workspaceState = { rootPath: workspaceRoot, workspaceIdentity: 1 };
  const handlers = new Map();
  const events = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 7,
      isDestroyed: () => false,
      once: () => {},
      send: (channel, payload) => events.push({ channel, payload })
    }
  };
  const controller = createPluginController({
    app: { getPath: () => root, getVersion: () => '2.6.0' },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: options.dialog || { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '' },
    getWindow: () => window,
    agentBroker: options.agentBroker,
    getWorkspaceIdentity: () => ({ ...workspaceState }),
    resolveWorkspaceFile: (candidate) => {
      const filePath = path.resolve(candidate);
      const relative = path.relative(workspaceRoot, filePath);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Path is outside the workspace');
      }
      return { filePath, workspaceIdentity: workspaceState.workspaceIdentity };
    }
  });
  controller.registerIpc();
  await controller.initialize();
  return { root, workspaceRoot, workspaceState, controller, handlers, events, window };
}

test('plugin packages install atomically, remain disabled, and receive declared permissions by default', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'source');
  await writePackage(source);

  const installed = await harness.controller.installFromPath(source);
  assert.equal(installed.id, 'acme.sample-plugin');
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(installed.status, 'disabled');
  assert.equal(installed.enabled, false);
  assert.deepEqual(installed.grantedPermissions, ['commands.register', 'services.read']);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);
  await assert.rejects(() => harness.controller.loadEntry(installed.id), { code: 'plugins.entry.denied' });
  await assert.rejects(
    () => harness.controller.rpc(installed.id, 'commands.register', { id: 'acme.sample-plugin.hello' }),
    { code: 'plugins.rpc.plugin' }
  );

  const enabled = await harness.controller.setEnabled(installed.id, true);
  assert.equal(enabled.status, 'enabled');
  assert.deepEqual(enabled.grantedPermissions, ['commands.register', 'services.read']);
  const descriptors = harness.controller.runtimeDescriptors();
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].manifest.main, 'dist/extension.js');
  assert.match(descriptors[0].revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(descriptors).includes(harness.root), false, 'descriptors must not leak plugin paths');
  const entry = await harness.controller.loadEntry(installed.id);
  assert.match(entry.source, /activate/);
  assert.equal(entry.main, 'dist/extension.js');
  assert.deepEqual(
    await harness.controller.rpc(installed.id, 'commands.register', { id: 'acme.sample-plugin.hello' }),
    { authorized: true, method: 'commands.register', permission: 'commands.register' }
  );
  assert.deepEqual(
    await harness.controller.rpc(installed.id, 'services.get', { id: 'workbench.projectTasks' }),
    { authorized: true, method: 'services.get', permission: 'services.read' }
  );
  await harness.controller.grant(installed.id, 'services.read', false);
  await assert.rejects(
    () => harness.controller.rpc(installed.id, 'services.get', { id: 'workbench.projectTasks' }),
    { code: 'plugins.rpc.permission' }
  );
  await harness.controller.grant(installed.id, 'services.read', true);
  await assert.rejects(
    () => harness.controller.rpc(installed.id, 'services.get', { id: 'workbench.fileIcons' }),
    { code: 'plugins.rpc.service' }
  );
  assert.ok(harness.events.some((event) => event.channel === 'plugins:changed'));
});

test('Agent broker RPC denies Worker decisions while trusted approval IPC retains exact authority', async (t) => {
  const calls = [];
  const disposed = [];
  const agentBroker = {
    request: async (pluginId, method, args) => {
      calls.push({ pluginId, method, args });
      if (method === 'models.list') return { models: [] };
      if (method === 'models.generate') return { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop', usage: null };
      if (method === 'models.cancel') return { success: true, cancelled: true };
      if (method === 'agent.tools.invoke') {
        const process = args && args.tool === 'process_run';
        return { approvalRequired: true, approval: { id: process ? 'approval-process' : 'approval-write', tool: args.tool } };
      }
      return {};
    },
    describeApproval: (pluginId, approvalId) => {
      calls.push({ pluginId, method: 'describeApproval', args: { approvalId } });
      if (approvalId === 'approval-expired' || approvalId === 'approval-missing' || approvalId === 'approval-evicted') {
        const error = new Error(approvalId === 'approval-expired' ? 'Agent approval expired.' : 'Agent approval is missing or no longer valid.');
        error.code = approvalId === 'approval-expired' ? 'AGENT_APPROVAL_EXPIRED' : 'AGENT_APPROVAL_NOT_FOUND';
        if (approvalId !== 'approval-evicted') {
          error.approvalTool = approvalId === 'approval-expired' ? 'workspace_write' : 'process_run';
        }
        throw error;
      }
      if (approvalId === 'approval-write') {
        return {
          approvalId,
          tool: 'workspace_write',
          summary: 'Write src/app.js',
          risk: 'write',
          permission: 'workspace.write',
          expiresAt: '2026-08-25T12:00:00.000Z',
          details: { path: 'src/app.js', bytes: 4, contentPreview: 'next', contentTruncated: false }
        };
      }
      return {
        approvalId,
        tool: 'process_run',
        summary: 'Run node --version',
        risk: 'execute',
        permission: 'process.execute',
        expiresAt: '2026-08-25T12:00:00.000Z',
        details: { command: 'node', args: ['--version'], cwd: '.', timeoutMs: 10_000 }
      };
    },
    decideApproval: async (pluginId, approvalId, approved) => {
      calls.push({ pluginId, method: 'decideApproval', args: { approvalId, approved } });
      return approved
        ? { approved: true, path: 'src/app.js', sha256: 'a'.repeat(64) }
        : { rejected: true, tool: 'workspace_write' };
    },
    cancelApproval: (pluginId, approvalId) => {
      calls.push({ pluginId, method: 'cancelApproval', args: { approvalId } });
      return { cancelled: true };
    },
    getAccessMode: (pluginId, args) => {
      calls.push({ pluginId, method: 'getAccessMode', args });
      return { pluginId, providerId: args.providerId, sessionId: args.sessionId, accessMode: 'ask' };
    },
    setAccessMode: (pluginId, args) => {
      calls.push({ pluginId, method: 'setAccessMode', args });
      if (args.accessMode === 'full' && args.confirmed !== true) {
        const error = new Error('confirmation required');
        error.code = 'AGENT_FULL_ACCESS_CONFIRMATION_REQUIRED';
        throw error;
      }
      return { pluginId, providerId: args.providerId, sessionId: args.sessionId, accessMode: args.accessMode };
    },
    clearAccessMode: (pluginId, args) => {
      calls.push({ pluginId, method: 'clearAccessMode', args });
      return { pluginId, providerId: args.providerId, sessionId: args.sessionId, accessMode: 'ask' };
    },
    disposePlugin: (pluginId) => disposed.push(pluginId)
  };
  const harness = await createHarness(t, { agentBroker });
  const sourceDirectory = path.join(harness.root, 'agent-package');
  const extensionSource = 'export function activate() {}\n';
  await fsp.mkdir(path.join(sourceDirectory, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(sourceDirectory, 'dist', 'extension.js'), extensionSource, 'utf8');
  await fsp.writeFile(path.join(sourceDirectory, 'manifest.json'), JSON.stringify(makeManifest('1.0.0', extensionSource, {
    permissions: ['agents.register', 'models.generate', 'workspace.read', 'workspace.write', 'process.execute']
  }), null, 2), 'utf8');

  await harness.controller.installFromPath(sourceDirectory);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  assert.deepEqual(await harness.controller.rpc('acme.sample-plugin', 'models.list', {}), { models: [] });
  assert.equal((await harness.controller.rpc('acme.sample-plugin', 'models.generate', {
    modelRef: 'chat:model',
    requestId: 'turn-1',
    messages: [{ role: 'user', content: 'hello' }]
  })).content, 'done');
  assert.deepEqual(await harness.controller.rpc('acme.sample-plugin', 'models.cancel', { requestId: 'turn-1' }), {
    success: true,
    cancelled: true
  });
  assert.equal((await harness.controller.rpc('acme.sample-plugin', 'agent.tools.invoke', {
    tool: 'workspace_write',
    input: { path: 'src/app.js', content: 'next' }
  })).approvalRequired, true);
  assert.equal((await harness.controller.rpc('acme.sample-plugin', 'agent.tools.invoke', {
    tool: 'process_run', input: { command: 'node', args: ['--version'] }
  })).approval.id, 'approval-process');
  for (const method of ['agent.tools.approve', 'agent.tools.reject', 'agent.tools.cancel']) {
    await assert.rejects(
      () => harness.controller.rpc('acme.sample-plugin', method, { approvalId: 'approval-process' }),
      { code: 'plugins.rpc.denied' }
    );
  }
  await assert.rejects(
    () => harness.controller.rpc('acme.sample-plugin', 'agent.access.set', { accessMode: 'full' }),
    { code: 'plugins.rpc.denied' }
  );

  const trustedEvent = { sender: harness.window.webContents };
  assert.equal((await harness.handlers.get('plugins:agent-approval-describe')(trustedEvent, {
    pluginId: 'acme.sample-plugin', approvalId: 'approval-write'
  })).permission, 'workspace.write');
  assert.equal((await harness.handlers.get('plugins:agent-approval-decide')(trustedEvent, {
    pluginId: 'acme.sample-plugin', approvalId: 'approval-write', approved: true
  })).approved, true);
  assert.deepEqual(await harness.handlers.get('plugins:agent-approval-decide')(trustedEvent, {
    pluginId: 'acme.sample-plugin', approvalId: 'approval-expired', approved: true
  }), {
    approvalUnavailable: true,
    tool: 'workspace_write',
    errorCode: 'AGENT_APPROVAL_EXPIRED',
    errorMessage: 'The Agent approval expired before the operation could start.'
  });
  assert.deepEqual(await harness.handlers.get('plugins:agent-approval-decide')(trustedEvent, {
    pluginId: 'acme.sample-plugin', approvalId: 'approval-missing', approved: true
  }), {
    approvalUnavailable: true,
    tool: 'process_run',
    errorCode: 'AGENT_APPROVAL_NOT_FOUND',
    errorMessage: 'The Agent approval is missing or no longer valid.'
  });
  assert.deepEqual(await harness.handlers.get('plugins:agent-approval-describe')(trustedEvent, {
    pluginId: 'acme.sample-plugin', approvalId: 'approval-evicted'
  }), {
    approvalUnavailable: true,
    errorCode: 'AGENT_APPROVAL_NOT_FOUND',
    errorMessage: 'The Agent approval is missing or no longer valid.'
  });
  assert.deepEqual(await harness.handlers.get('plugins:agent-approval-cancel')(trustedEvent, {
    pluginId: 'acme.sample-plugin', approvalId: 'approval-process'
  }), { cancelled: true });
  const accessIdentity = {
    pluginId: 'acme.sample-plugin',
    providerId: 'acme.sample-plugin.main',
    sessionId: 'session-one'
  };
  assert.deepEqual(await harness.handlers.get('plugins:agent-access-get')(trustedEvent, accessIdentity), {
    ...accessIdentity,
    accessMode: 'ask'
  });
  assert.deepEqual(await harness.handlers.get('plugins:agent-access-set')(trustedEvent, {
    ...accessIdentity,
    accessMode: 'auto',
    confirmed: false
  }), { ...accessIdentity, accessMode: 'auto' });
  await assert.rejects(
    () => harness.handlers.get('plugins:agent-access-set')(trustedEvent, { ...accessIdentity, accessMode: 'full' }),
    { code: 'AGENT_FULL_ACCESS_CONFIRMATION_REQUIRED' }
  );
  assert.deepEqual(await harness.handlers.get('plugins:agent-access-set')(trustedEvent, {
    ...accessIdentity,
    accessMode: 'full',
    confirmed: true
  }), { ...accessIdentity, accessMode: 'full' });
  assert.deepEqual(await harness.handlers.get('plugins:agent-access-clear')(trustedEvent, accessIdentity), {
    ...accessIdentity,
    accessMode: 'ask'
  });
  assert.deepEqual(calls.at(-1), {
    pluginId: 'acme.sample-plugin',
    method: 'clearAccessMode',
    args: { providerId: accessIdentity.providerId, sessionId: accessIdentity.sessionId }
  });

  assert.deepEqual(calls.filter((call) => call.method.startsWith('models.')).map((call) => call.method), [
    'models.list',
    'models.generate',
    'models.cancel'
  ]);
  await harness.controller.setEnabled('acme.sample-plugin', false);
  assert.equal(disposed.includes('acme.sample-plugin'), true);
});

test('legacy permission state migrates installed plugins to declared default grants once', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'legacy-permission-package');
  await writePackage(source);
  await harness.controller.installFromPath(source);
  const permissionsPath = path.join(harness.root, 'plugins', '.permissions.json');
  await fsp.writeFile(permissionsPath, JSON.stringify({
    schemaVersion: 1,
    grants: { 'acme.sample-plugin': [] }
  }, null, 2) + '\n', 'utf8');

  const upgraded = createPluginController({
    app: { getPath: () => harness.root, getVersion: () => '2.6.0' },
    ipcMain: { handle() {} },
    getWindow: () => null,
    getWorkspaceIdentity: () => ({ rootPath: harness.workspaceRoot, workspaceIdentity: 1 })
  });
  await upgraded.initialize();

  assert.deepEqual(upgraded.get('acme.sample-plugin').grantedPermissions, [
    'commands.register',
    'services.read'
  ]);
  const persisted = JSON.parse(await fsp.readFile(permissionsPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.initialized['acme.sample-plugin'], true);
});

test('a damaged permission file disables plugins instead of restoring revoked grants', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'permission-recovery-package');
  await writePackage(source);
  await harness.controller.installFromPath(source);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  await harness.controller.grant('acme.sample-plugin', 'services.read', false);
  assert.deepEqual(harness.controller.get('acme.sample-plugin').grantedPermissions, ['commands.register']);

  const permissionsPath = path.join(harness.root, 'plugins', '.permissions.json');
  await fsp.writeFile(permissionsPath, '{ damaged json', 'utf8');
  await harness.controller.refresh('permission-file-damaged');

  const recovered = harness.controller.get('acme.sample-plugin');
  assert.equal(recovered.enabled, false);
  assert.equal(recovered.status, 'disabled');
  assert.deepEqual(recovered.grantedPermissions, []);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);
  const persisted = JSON.parse(await fsp.readFile(permissionsPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(persisted.grants['acme.sample-plugin'], []);
  assert.equal(persisted.initialized['acme.sample-plugin'], true);
});

test('a missing permission file fails closed and explicit grants recover the plugin', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'permission-missing-package');
  await writePackage(source);
  await harness.controller.installFromPath(source);
  await harness.controller.setEnabled('acme.sample-plugin', true);

  const permissionsPath = path.join(harness.root, 'plugins', '.permissions.json');
  await fsp.rm(permissionsPath);
  await harness.controller.refresh('permission-file-missing');

  const recovered = harness.controller.get('acme.sample-plugin');
  assert.equal(recovered.enabled, false);
  assert.deepEqual(recovered.grantedPermissions, []);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);

  await harness.controller.grant('acme.sample-plugin', 'commands.register', true);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  assert.deepEqual(harness.controller.get('acme.sample-plugin').grantedPermissions, ['commands.register']);
  assert.deepEqual(
    await harness.controller.rpc('acme.sample-plugin', 'commands.register', { id: 'acme.sample-plugin.hello' }),
    { authorized: true, method: 'commands.register', permission: 'commands.register' }
  );
  await assert.rejects(
    () => harness.controller.rpc('acme.sample-plugin', 'services.get', { id: 'workbench.projectTasks' }),
    { code: 'plugins.rpc.permission' }
  );
});

test('plugin-localization loader returns only a verified selected flat message table', async (t) => {
  const harness = await createHarness(t);
  const sourceRoot = path.join(harness.root, 'localized-package');
  const entry = 'export function activate() {}\n';
  const english = JSON.stringify({ 'Workspace records': 'Workspace records' });
  const japanese = JSON.stringify({ 'Workspace records': 'Workspace records ja' });
  await fsp.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
  await fsp.mkdir(path.join(sourceRoot, 'language-packs', 'en'), { recursive: true });
  await fsp.mkdir(path.join(sourceRoot, 'language-packs', 'ja'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'dist', 'extension.js'), entry, 'utf8');
  await fsp.writeFile(path.join(sourceRoot, 'language-packs', 'en', 'messages.json'), english, 'utf8');
  await fsp.writeFile(path.join(sourceRoot, 'language-packs', 'ja', 'messages.json'), japanese, 'utf8');
  const manifest = makeManifest('1.0.0', entry, { permissions: [] });
  manifest.localization = {
    default: 'language-packs/en/messages.json',
    ja: 'language-packs/ja/messages.json'
  };
  manifest.integrity.files = {
    'dist/extension.js': hash(entry),
    'language-packs/en/messages.json': hash(english),
    'language-packs/ja/messages.json': hash(japanese)
  };
  await fsp.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  await harness.controller.installFromPath(sourceRoot);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const loaded = await harness.controller.loadLocalization('acme.sample-plugin', 'ja');
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), { locale: 'ja', messages: { 'Workspace records': 'Workspace records ja' } });
  assert.equal(JSON.stringify(loaded).includes(harness.root), false, 'localization payload must not leak package paths');
  const fallback = await harness.controller.loadLocalization('acme.sample-plugin', 'zh-CN');
  assert.deepEqual(JSON.parse(JSON.stringify(fallback)), { locale: 'zh-CN', messages: { 'Workspace records': 'Workspace records' } });

  const nestedRoot = path.join(harness.root, 'nested-localization-package');
  const nestedEntry = 'export function activate() {}\n';
  const nestedMessages = JSON.stringify({ invalid: { nested: true } });
  await fsp.mkdir(path.join(nestedRoot, 'dist'), { recursive: true });
  await fsp.mkdir(path.join(nestedRoot, 'language-packs', 'en'), { recursive: true });
  await fsp.writeFile(path.join(nestedRoot, 'dist', 'extension.js'), nestedEntry, 'utf8');
  await fsp.writeFile(path.join(nestedRoot, 'language-packs', 'en', 'messages.json'), nestedMessages, 'utf8');
  const nestedManifest = makeManifest('1.0.0', nestedEntry, { id: 'acme.nested-localization', permissions: [] });
  nestedManifest.localization = { default: 'language-packs/en/messages.json' };
  nestedManifest.integrity.files = {
    'dist/extension.js': hash(nestedEntry),
    'language-packs/en/messages.json': hash(nestedMessages)
  };
  await fsp.writeFile(path.join(nestedRoot, 'manifest.json'), JSON.stringify(nestedManifest, null, 2), 'utf8');
  await harness.controller.installFromPath(nestedRoot);
  await harness.controller.setEnabled('acme.nested-localization', true);
  await assert.rejects(
    () => harness.controller.loadLocalization('acme.nested-localization', 'en'),
    { code: 'plugins.localization.invalid' }
  );

  const installedJapanese = path.join(harness.root, 'plugins', 'acme.sample-plugin', 'language-packs', 'ja', 'messages.json');
  await fsp.writeFile(installedJapanese, JSON.stringify({ nested: { notAllowed: true } }), 'utf8');
  await assert.rejects(
    () => harness.controller.loadLocalization('acme.sample-plugin', 'ja'),
    { code: 'plugins.integrity.mismatch' }
  );
  assert.equal(harness.controller.get('acme.sample-plugin').status, 'invalid');
});

test('schema-2 document viewers load only verified resources and read through sender-bound workspace handles', async (t) => {
  const harness = await createHarness(t);
  const sourceRoot = path.join(harness.root, 'document-view-package');
  const { viewSource, styleSource } = await writeDocumentViewPackage(sourceRoot);
  const documentPath = path.join(harness.workspaceRoot, 'sample.pdf');
  await fsp.writeFile(documentPath, Buffer.from([1, 2, 3, 4, 5, 6]));

  await harness.controller.installFromPath(sourceRoot);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const loaded = await harness.controller.loadDocumentView('acme.sample-plugin', 'acme.sample-plugin.preview');
  assert.equal(loaded.entry.source, viewSource);
  assert.equal(loaded.resources[0].source, styleSource);
  assert.deepEqual(loaded.viewer.extensions, ['.pdf', '.csv', '.tar.gz']);
  assert.deepEqual(Object.keys(loaded.viewer).sort(), ['entry', 'extensions', 'id', 'priority', 'resources']);
  assert.equal(Object.hasOwn(loaded.viewer, 'title'), false);
  assert.equal(JSON.stringify(loaded).includes(harness.root), false, 'view source payload must not leak package paths');
  const registration = await harness.controller.rpc('acme.sample-plugin', 'documentViews.register', {
    id: 'acme.sample-plugin.preview', title: 'Preview'
  });
  assert.equal(registration.authorized, true);
  assert.equal(registration.viewer.entry, 'dist/view.js');

  const trustedEvent = { sender: harness.window.webContents };
  const openHandler = harness.handlers.get('plugins:document-open');
  const readHandler = harness.handlers.get('plugins:document-read');
  const closeHandler = harness.handlers.get('plugins:document-close');
  const opened = await openHandler(trustedEvent, {
    pluginId: 'acme.sample-plugin', viewerId: 'acme.sample-plugin.preview', filePath: documentPath
  });
  assert.equal(opened.name, 'sample.pdf');
  assert.equal(JSON.stringify(opened).includes(harness.workspaceRoot), false, 'document handle must not leak paths');
  const chunk = await readHandler(trustedEvent, { documentId: opened.documentId, offset: 1, length: 3 });
  assert.deepEqual([...chunk.data], [2, 3, 4]);
  await assert.rejects(
    () => readHandler({ sender: { id: 10 } }, { documentId: opened.documentId, offset: 0, length: 1 }),
    { code: 'plugins.ipc.sender' }
  );
  const replacementPath = path.join(harness.workspaceRoot, 'replacement.pdf');
  await fsp.writeFile(replacementPath, Buffer.from([7, 8, 9, 10, 11, 12]));
  await fsp.rm(documentPath);
  await fsp.rename(replacementPath, documentPath);
  await assert.rejects(
    () => readHandler(trustedEvent, { documentId: opened.documentId, offset: 0, length: 1 }),
    { code: 'DOCUMENT_VIEW_CHANGED' }
  );
  await harness.controller.grant('acme.sample-plugin', 'documents.read', false);
  await assert.rejects(
    () => harness.controller.loadDocumentView('acme.sample-plugin', 'acme.sample-plugin.preview'),
    { code: 'plugins.documentView.permission' }
  );
  await assert.rejects(
    () => readHandler(trustedEvent, { documentId: opened.documentId, offset: 0, length: 1 }),
    { code: 'DOCUMENT_VIEW_NOT_FOUND' }
  );
  assert.deepEqual(await closeHandler(trustedEvent, { documentId: opened.documentId }), { closed: false });

  await harness.controller.grant('acme.sample-plugin', 'documents.read', true);
  const reopened = await openHandler(trustedEvent, {
    pluginId: 'acme.sample-plugin', viewerId: 'acme.sample-plugin.preview', filePath: documentPath
  });
  await fsp.rm(path.join(harness.controller.root, 'acme.sample-plugin'), { recursive: true });
  await harness.controller.refresh();
  await assert.rejects(
    () => readHandler(trustedEvent, { documentId: reopened.documentId, offset: 0, length: 1 }),
    { code: 'DOCUMENT_VIEW_NOT_FOUND' }
  );
});

test('document viewer authorization changes before mutation persistence and revoked handles never revive', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);
  const sourceRoot = path.join(harness.root, 'document-view-live-authorization');
  await writeDocumentViewPackage(sourceRoot);
  const documentPath = path.join(harness.workspaceRoot, 'live.pdf');
  await fsp.writeFile(documentPath, Buffer.from([1, 2, 3, 4]));
  await harness.controller.installFromPath(sourceRoot);
  await harness.controller.setEnabled('acme.sample-plugin', true);

  const trustedEvent = { sender: harness.window.webContents };
  const openHandler = harness.handlers.get('plugins:document-open');
  const readHandler = harness.handlers.get('plugins:document-read');
  const closeHandler = harness.handlers.get('plugins:document-close');
  const request = {
    pluginId: 'acme.sample-plugin',
    viewerId: 'acme.sample-plugin.preview',
    filePath: documentPath
  };
  const opened = await openHandler(trustedEvent, request);

  const permissionsPath = path.join(harness.root, 'plugins', '.permissions.json');
  const permissionPersistStarted = deferred();
  const permissionPersistGate = deferred();
  const originalRename = fsp.rename;
  let permissionRenameMatched = false;
  let revoking;
  fsp.rename = async (from, to) => {
    if (!permissionRenameMatched && path.resolve(to) === path.resolve(permissionsPath)) {
      permissionRenameMatched = true;
      permissionPersistStarted.resolve();
      await permissionPersistGate.promise;
    }
    return originalRename.call(fsp, from, to);
  };
  try {
    revoking = harness.controller.grant('acme.sample-plugin', 'documents.read', false);
    await permissionPersistStarted.promise;
    assert.equal(
      harness.controller.runtimeDescriptors()[0].grantedPermissions.includes('documents.read'),
      false,
      'runtime descriptors must remove a revoked permission before persistence completes'
    );
    await assert.rejects(
      () => harness.controller.loadDocumentView('acme.sample-plugin', 'acme.sample-plugin.preview'),
      { code: 'plugins.documentView.permission' }
    );
    await assert.rejects(() => openHandler(trustedEvent, request), { code: 'plugins.documentView.permission' });
    await assert.rejects(
      () => readHandler(trustedEvent, { documentId: opened.documentId, offset: 0, length: 1 }),
      { code: 'DOCUMENT_VIEW_NOT_FOUND' }
    );
  } finally {
    permissionPersistGate.resolve();
    fsp.rename = originalRename;
    if (revoking) await revoking.catch(() => {});
  }
  await revoking;

  const grantPersistStarted = deferred();
  const grantPersistGate = deferred();
  let grantRenameMatched = false;
  let granting;
  fsp.rename = async (from, to) => {
    if (!grantRenameMatched && path.resolve(to) === path.resolve(permissionsPath)) {
      grantRenameMatched = true;
      grantPersistStarted.resolve();
      await grantPersistGate.promise;
    }
    return originalRename.call(fsp, from, to);
  };
  try {
    granting = harness.controller.grant('acme.sample-plugin', 'documents.read', true);
    await grantPersistStarted.promise;
    assert.equal(
      harness.controller.runtimeDescriptors()[0].grantedPermissions.includes('documents.read'),
      false,
      'a new grant must not become effective before persistence and refresh complete'
    );
    await assert.rejects(
      () => harness.controller.loadDocumentView('acme.sample-plugin', 'acme.sample-plugin.preview'),
      { code: 'plugins.documentView.permission' }
    );
    await assert.rejects(() => openHandler(trustedEvent, request), { code: 'plugins.documentView.permission' });
  } finally {
    grantPersistGate.resolve();
    fsp.rename = originalRename;
    if (granting) await granting.catch(() => {});
  }
  await granting;
  await assert.rejects(
    () => readHandler(trustedEvent, { documentId: opened.documentId, offset: 0, length: 1 }),
    { code: 'DOCUMENT_VIEW_NOT_FOUND' }
  );
  const reopened = await openHandler(trustedEvent, request);

  const registryPath = path.join(harness.root, 'plugins', '.registry.json');
  const registryPersistStarted = deferred();
  const registryPersistGate = deferred();
  let registryRenameMatched = false;
  let disabling;
  fsp.rename = async (from, to) => {
    if (!registryRenameMatched && path.resolve(to) === path.resolve(registryPath)) {
      registryRenameMatched = true;
      registryPersistStarted.resolve();
      await registryPersistGate.promise;
    }
    return originalRename.call(fsp, from, to);
  };
  try {
    disabling = harness.controller.setEnabled('acme.sample-plugin', false);
    await registryPersistStarted.promise;
    assert.deepEqual(harness.controller.runtimeDescriptors(), []);
    await assert.rejects(
      () => harness.controller.loadDocumentView('acme.sample-plugin', 'acme.sample-plugin.preview'),
      { code: 'plugins.documentView.denied' }
    );
    await assert.rejects(() => openHandler(trustedEvent, request), { code: 'plugins.documentView.denied' });
    await assert.rejects(
      () => readHandler(trustedEvent, { documentId: reopened.documentId, offset: 0, length: 1 }),
      { code: 'DOCUMENT_VIEW_NOT_FOUND' }
    );
  } finally {
    registryPersistGate.resolve();
    fsp.rename = originalRename;
    if (disabling) await disabling.catch(() => {});
  }
  await disabling;

  await harness.controller.setEnabled('acme.sample-plugin', true);
  await assert.rejects(
    () => readHandler(trustedEvent, { documentId: reopened.documentId, offset: 0, length: 1 }),
    { code: 'DOCUMENT_VIEW_NOT_FOUND' }
  );
  const current = await openHandler(trustedEvent, request);
  assert.deepEqual(await closeHandler(trustedEvent, { documentId: current.documentId }), { closed: true });
});

test('replacement and uninstall durably disable plugin runtime before moving package bytes', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'document-view-first');
  const replacement = path.join(harness.root, 'document-view-replacement');
  await writeDocumentViewPackage(first);
  await writeDocumentViewPackage(replacement);
  const documentPath = path.join(harness.workspaceRoot, 'transaction.pdf');
  await fsp.writeFile(documentPath, Buffer.from([1, 2, 3, 4]));
  await harness.controller.installFromPath(first);
  await harness.controller.setEnabled('acme.sample-plugin', true);

  const trustedEvent = { sender: harness.window.webContents };
  const openHandler = harness.handlers.get('plugins:document-open');
  const readHandler = harness.handlers.get('plugins:document-read');
  const request = {
    pluginId: 'acme.sample-plugin',
    viewerId: 'acme.sample-plugin.preview',
    filePath: documentPath
  };
  const originalRename = fsp.rename;
  const destination = path.join(harness.root, 'plugins', 'acme.sample-plugin');
  const trashRoot = path.join(harness.root, 'plugins', '.trash');
  const registryPath = path.join(harness.root, 'plugins', '.registry.json');
  const opened = await openHandler(trustedEvent, request);

  const replacementMoveStarted = deferred();
  const replacementMoveGate = deferred();
  let replacementMoveMatched = false;
  let replacing;
  fsp.rename = async (from, to) => {
    if (!replacementMoveMatched && path.resolve(from) === path.resolve(destination) &&
        path.dirname(path.resolve(to)) === path.resolve(trashRoot)) {
      replacementMoveMatched = true;
      replacementMoveStarted.resolve();
      await replacementMoveGate.promise;
    }
    return originalRename.call(fsp, from, to);
  };
  try {
    replacing = harness.controller.installFromPath(replacement);
    await replacementMoveStarted.promise;
    const persistedRegistry = JSON.parse(await fsp.readFile(registryPath, 'utf8'));
    assert.equal(persistedRegistry.plugins['acme.sample-plugin'].enabled, false);
    assert.deepEqual(harness.controller.runtimeDescriptors(), []);
    await assert.rejects(() => harness.controller.loadEntry('acme.sample-plugin'), { code: 'plugins.entry.denied' });
    await assert.rejects(
      () => harness.controller.rpc('acme.sample-plugin', 'host.getInfo', {}),
      { code: 'plugins.rpc.plugin' }
    );
    await assert.rejects(
      () => harness.controller.loadDocumentView('acme.sample-plugin', 'acme.sample-plugin.preview'),
      { code: 'plugins.documentView.denied' }
    );
    await assert.rejects(() => openHandler(trustedEvent, request), { code: 'plugins.documentView.denied' });
    await assert.rejects(
      () => readHandler(trustedEvent, { documentId: opened.documentId, offset: 0, length: 1 }),
      { code: 'DOCUMENT_VIEW_NOT_FOUND' }
    );
  } finally {
    replacementMoveGate.resolve();
    fsp.rename = originalRename;
    if (replacing) await replacing.catch(() => {});
  }
  const installed = await replacing;
  assert.equal(installed.status, 'disabled');

  await harness.controller.setEnabled('acme.sample-plugin', true);
  await assert.rejects(
    () => readHandler(trustedEvent, { documentId: opened.documentId, offset: 0, length: 1 }),
    { code: 'DOCUMENT_VIEW_NOT_FOUND' }
  );
  const reopened = await openHandler(trustedEvent, request);

  const uninstallMoveStarted = deferred();
  const uninstallMoveGate = deferred();
  let uninstallMoveMatched = false;
  let uninstalling;
  fsp.rename = async (from, to) => {
    if (!uninstallMoveMatched && path.resolve(from) === path.resolve(destination) &&
        path.dirname(path.resolve(to)) === path.resolve(trashRoot)) {
      uninstallMoveMatched = true;
      uninstallMoveStarted.resolve();
      await uninstallMoveGate.promise;
    }
    return originalRename.call(fsp, from, to);
  };
  try {
    uninstalling = harness.controller.uninstall('acme.sample-plugin');
    await uninstallMoveStarted.promise;
    const persistedRegistry = JSON.parse(await fsp.readFile(registryPath, 'utf8'));
    assert.equal(persistedRegistry.plugins['acme.sample-plugin'].enabled, false);
    assert.deepEqual(harness.controller.runtimeDescriptors(), []);
    await assert.rejects(() => harness.controller.loadEntry('acme.sample-plugin'), { code: 'plugins.entry.denied' });
    await assert.rejects(
      () => harness.controller.rpc('acme.sample-plugin', 'host.getInfo', {}),
      { code: 'plugins.rpc.plugin' }
    );
    await assert.rejects(
      () => harness.controller.loadDocumentView('acme.sample-plugin', 'acme.sample-plugin.preview'),
      { code: 'plugins.documentView.denied' }
    );
    await assert.rejects(() => openHandler(trustedEvent, request), { code: 'plugins.documentView.denied' });
    await assert.rejects(
      () => readHandler(trustedEvent, { documentId: reopened.documentId, offset: 0, length: 1 }),
      { code: 'DOCUMENT_VIEW_NOT_FOUND' }
    );
  } finally {
    uninstallMoveGate.resolve();
    fsp.rename = originalRename;
    if (uninstalling) await uninstalling.catch(() => {});
  }
  assert.deepEqual(await uninstalling, { id: 'acme.sample-plugin', removed: true });
});

test('a replacement rollback cannot revive an entry load from an older runtime generation', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'entry-generation-first');
  const replacement = path.join(harness.root, 'entry-generation-replacement');
  await writePackage(first, '1.0.0', 'export const generation = 1;\n');
  await writePackage(replacement, '1.0.0', 'export const generation = 2;\n');
  await harness.controller.installFromPath(first);
  await harness.controller.setEnabled('acme.sample-plugin', true);

  const destination = path.join(harness.root, 'plugins', 'acme.sample-plugin');
  const installedEntry = path.join(destination, 'dist', 'extension.js');
  const trashRoot = path.join(harness.root, 'plugins', '.trash');
  const readStarted = deferred();
  const readGate = deferred();
  const originalReadFile = fsp.readFile;
  const originalRename = fsp.rename;
  let entryReadMatched = false;
  let replacementMoveFailed = false;
  let loading;
  fsp.readFile = async (filePath, ...args) => {
    if (!entryReadMatched && path.resolve(filePath) === path.resolve(installedEntry)) {
      entryReadMatched = true;
      readStarted.resolve();
      await readGate.promise;
    }
    return originalReadFile.call(fsp, filePath, ...args);
  };
  fsp.rename = async (from, to) => {
    if (!replacementMoveFailed && path.resolve(from) === path.resolve(destination) &&
        path.dirname(path.resolve(to)) === path.resolve(trashRoot)) {
      replacementMoveFailed = true;
      throw new Error('synthetic replacement move failure');
    }
    return originalRename.call(fsp, from, to);
  };
  try {
    loading = harness.controller.loadEntry('acme.sample-plugin');
    await readStarted.promise;
    await assert.rejects(
      () => harness.controller.installFromPath(replacement),
      /synthetic replacement move failure/
    );
    assert.equal(harness.controller.runtimeDescriptors().length, 1, 'the original plugin should be restored');
    readGate.resolve();
    await assert.rejects(loading, { code: 'plugins.entry.denied' });
  } finally {
    readGate.resolve();
    fsp.readFile = originalReadFile;
    fsp.rename = originalRename;
    if (loading) await loading.catch(() => {});
  }
});

test('an incomplete same-version replacement rollback stays disabled after controller restart', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'restart-first');
  const replacement = path.join(harness.root, 'restart-replacement');
  await writePackage(first, '1.0.0', 'export const generation = 1;\n');
  await writePackage(replacement, '1.0.0', 'export const generation = 2;\n');
  await harness.controller.installFromPath(first);
  await harness.controller.setEnabled('acme.sample-plugin', true);

  const destination = path.join(harness.root, 'plugins', 'acme.sample-plugin');
  const trashRoot = path.join(harness.root, 'plugins', '.trash');
  const permissionsPath = path.join(harness.root, 'plugins', '.permissions.json');
  const originalRename = fsp.rename;
  const originalRm = fsp.rm;
  let permissionFailureInjected = false;
  fsp.rename = async (from, to) => {
    if (!permissionFailureInjected && path.resolve(to) === path.resolve(permissionsPath)) {
      permissionFailureInjected = true;
      throw new Error('synthetic permission persistence failure');
    }
    if (path.dirname(path.resolve(from)) === path.resolve(trashRoot) && path.resolve(to) === path.resolve(destination)) {
      throw new Error('synthetic backup restore failure');
    }
    return originalRename.call(fsp, from, to);
  };
  fsp.rm = async (target, ...args) => {
    if (path.resolve(target) === path.resolve(destination)) {
      throw new Error('synthetic replacement removal failure');
    }
    return originalRm.call(fsp, target, ...args);
  };
  try {
    await assert.rejects(
      () => harness.controller.installFromPath(replacement),
      /synthetic permission persistence failure/
    );
  } finally {
    fsp.rename = originalRename;
    fsp.rm = originalRm;
  }

  const persistedPermissions = JSON.parse(await fsp.readFile(permissionsPath, 'utf8'));
  assert.deepEqual(persistedPermissions.grants['acme.sample-plugin'], []);
  const restarted = createPluginController({
    app: { getPath: () => harness.root, getVersion: () => '2.6.0' },
    ipcMain: { handle() {} },
    getWindow: () => harness.window,
    getWorkspaceIdentity: () => ({ ...harness.workspaceState }),
    resolveWorkspaceFile: (candidate) => ({
      filePath: path.resolve(candidate),
      workspaceIdentity: harness.workspaceState.workspaceIdentity
    })
  });
  await restarted.initialize();
  const recovered = restarted.get('acme.sample-plugin');
  assert.equal(recovered.status, 'disabled');
  assert.deepEqual(recovered.grantedPermissions, []);
  assert.deepEqual(restarted.runtimeDescriptors(), []);
  await assert.rejects(() => restarted.loadEntry('acme.sample-plugin'), { code: 'plugins.entry.denied' });
});

test('schema-1 packages still reject extra executable view code', async (t) => {
  const harness = await createHarness(t);
  const sourceRoot = path.join(harness.root, 'legacy-extra-script');
  const source = 'export function activate() {}\n';
  await fsp.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'dist', 'extension.js'), source, 'utf8');
  await fsp.writeFile(path.join(sourceRoot, 'dist', 'view.js'), source, 'utf8');
  const manifest = makeManifest('1.0.0', source);
  manifest.integrity.files['dist/view.js'] = hash(source);
  await fsp.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await assert.rejects(() => harness.controller.installFromPath(sourceRoot), { code: 'plugins.manifest.main' });
});

test('a replacement package is disabled and receives its declared permissions', async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'first');
  const second = path.join(harness.root, 'second');
  await writePackage(first, '1.0.0');
  await writePackage(second, '1.1.0', 'export const version = 2;\n');
  await harness.controller.installFromPath(first);
  await harness.controller.grant('acme.sample-plugin', 'commands.register', true);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const replacement = await harness.controller.installFromPath(second);
  assert.equal(replacement.version, '1.1.0');
  assert.equal(replacement.enabled, false);
  assert.deepEqual(replacement.grantedPermissions, ['commands.register', 'services.read']);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);
});

test('runtime revisions change when same-version package bytes are replaced', async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'revision-first');
  const second = path.join(harness.root, 'revision-second');
  await writePackage(first, '1.0.0', 'export const revision = 1;\n');
  await writePackage(second, '1.0.0', 'export const revision = 2;\n');

  await harness.controller.installFromPath(first);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const firstRevision = harness.controller.runtimeDescriptors()[0].revision;
  await harness.controller.installFromPath(second);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const secondRevision = harness.controller.runtimeDescriptors()[0].revision;

  assert.match(firstRevision, /^[a-f0-9]{64}$/);
  assert.match(secondRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(secondRevision, firstRevision);
});

test('plugin mutations serialize concurrent replacement requests', async (t) => {
  const harness = await createHarness(t);
  const first = path.join(harness.root, 'first');
  const second = path.join(harness.root, 'second');
  await writePackage(first, '1.0.0');
  await writePackage(second, '1.2.0', 'export const version = 12;\n');
  const [firstResult, secondResult] = await Promise.all([
    harness.controller.installFromPath(first),
    harness.controller.installFromPath(second)
  ]);
  assert.equal(firstResult.version, '1.0.0');
  assert.equal(secondResult.version, '1.2.0');
  assert.equal(harness.controller.get('acme.sample-plugin').version, '1.2.0');
  assert.equal(harness.controller.get('acme.sample-plugin').enabled, false);
});

test('refresh detects post-install tampering and suppresses runtime descriptors', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'source');
  await writePackage(source);
  await harness.controller.installFromPath(source);
  await harness.controller.grant('acme.sample-plugin', 'commands.register', true);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const installedSource = path.join(harness.root, 'plugins', 'acme.sample-plugin', 'dist', 'extension.js');
  await fsp.writeFile(installedSource, 'export const tampered = true;\n', 'utf8');
  const refreshed = await harness.controller.refresh('test-tamper');
  assert.equal(refreshed[0].status, 'invalid');
  assert.equal(refreshed[0].enabled, false);
  assert.equal(refreshed[0].integrity.valid, false);
  assert.deepEqual(refreshed[0].grantedPermissions, []);
  assert.deepEqual(harness.controller.runtimeDescriptors(), []);
});

test('ZIP packages install without exposing paths and traversal entries are rejected', async (t) => {
  const harness = await createHarness(t);
  const source = 'export default {};\n';
  const manifest = JSON.stringify(makeManifest('1.0.0', source), null, 2);
  const archive = path.join(harness.root, 'sample.boboplugin');
  await fsp.writeFile(archive, makeZip([
    { name: 'manifest.json', content: manifest },
    { name: 'dist/extension.js', content: source }
  ]));
  const installed = await harness.controller.installFromPath(archive);
  assert.equal(installed.status, 'disabled');
  assert.deepEqual(harness.controller.list().map((record) => record.id), ['acme.sample-plugin']);

  const malicious = makeZip([{ name: '../outside.js', content: 'bad' }]);
  assert.throws(() => readZipEntries(malicious), { code: 'plugins.package.path' });
});

test('validation rejects mutable code graphs and native package files before installation', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'multiple-scripts');
  const entry = 'export const entry = true;\n';
  const helper = 'export const helper = true;\n';
  await fsp.mkdir(path.join(source, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(source, 'dist', 'extension.js'), entry, 'utf8');
  await fsp.writeFile(path.join(source, 'dist', 'helper.js'), helper, 'utf8');
  const manifest = makeManifest('1.0.0', entry);
  manifest.integrity.files['dist/helper.js'] = hash(helper);
  await fsp.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await assert.rejects(() => harness.controller.installFromPath(source), { code: 'plugins.manifest.main' });
  assert.deepEqual(harness.controller.list(), []);

  const nativeSource = path.join(harness.root, 'native-file');
  await writePackage(nativeSource);
  await fsp.writeFile(path.join(nativeSource, 'addon.node'), 'native', 'utf8');
  await assert.rejects(() => harness.controller.installFromPath(nativeSource), { code: 'plugins.package.fileType' });
  assert.deepEqual(harness.controller.list(), []);
});

test('plugin IPC surface is explicit and sender-bound', async (t) => {
  const harness = await createHarness(t);
  const expected = [
    'plugins:list', 'plugins:get', 'plugins:install', 'plugins:enable', 'plugins:disable', 'plugins:uninstall',
    'plugins:grant', 'plugins:revoke', 'plugins:runtime-descriptors', 'plugins:load-entry', 'plugins:load-localization',
    'plugins:load-document-view', 'plugins:document-open', 'plugins:document-read', 'plugins:document-close', 'plugins:rpc',
    'plugins:agent-approval-describe', 'plugins:agent-approval-decide', 'plugins:agent-approval-cancel',
    'plugins:agent-access-get', 'plugins:agent-access-set', 'plugins:agent-access-clear',
    'plugins:open-folder', 'plugins:refresh'
  ];
  assert.deepEqual(Array.from(harness.handlers.keys()), expected);
  const foreignEvent = { sender: {} };
  await assert.rejects(() => harness.handlers.get('plugins:list')(foreignEvent), { code: 'plugins.ipc.sender' });
});

test('plugin install dialog only imports packages and keeps a plugin-specific directory', async (t) => {
  const calls = [];
  let selectedPath = '';
  const dialog = {
    showOpenDialog: async (_owner, options) => {
      calls.push(options);
      if (calls.length === 1) return { canceled: false, filePaths: [selectedPath] };
      if (calls.length === 2) return { canceled: true, filePaths: [] };
      return { canceled: false, filePaths: [path.dirname(selectedPath)] };
    }
  };
  const harness = await createHarness(t, { dialog });
  const source = 'export default {}\n';
  const packageDirectory = path.join(harness.root, 'downloaded-plugin');
  await fsp.mkdir(packageDirectory, { recursive: true });
  selectedPath = path.join(packageDirectory, 'sample.boboplugin');
  await fsp.writeFile(selectedPath, makeZip([
    { name: 'manifest.json', content: JSON.stringify(makeManifest('1.0.0', source), null, 2) },
    { name: 'dist/extension.js', content: source }
  ]));

  const installed = await harness.controller.installFromDialog();
  assert.equal(installed.id, 'acme.sample-plugin');
  assert.deepEqual(calls[0].properties, ['openFile']);
  assert.equal(calls[0].title, 'Plugin package');
  assert.deepEqual(calls[0].filters, [{ name: 'Plugin package', extensions: ['boboplugin'] }]);
  assert.equal(calls[0].defaultPath, path.join(harness.root, 'plugins', '.imports'));
  assert.notEqual(calls[0].defaultPath, harness.workspaceRoot, 'plugin import must not inherit the workspace picker path');
  const persisted = JSON.parse(await fsp.readFile(path.join(harness.root, 'plugins', '.install-dialog.json'), 'utf8'));
  assert.equal(persisted.lastDirectory, packageDirectory);

  assert.equal(await harness.controller.installFromDialog(), null);
  assert.equal(calls[1].defaultPath, packageDirectory, 'next plugin import should restore the plugin-specific location');
  await assert.rejects(() => harness.controller.installFromDialog(), { code: 'plugins.install.type' });
});

test('marketplace identity expectations fail before replacing an installed package', async (t) => {
  const harness = await createHarness(t);
  const existing = path.join(harness.root, 'existing');
  await writePackage(existing, '1.0.0');
  await harness.controller.installFromPath(existing);
  await harness.controller.grant('acme.sample-plugin', 'commands.register', true);
  await harness.controller.setEnabled('acme.sample-plugin', true);

  const replacementSource = 'export const marketplace = true;\n';
  const mismatchedArchive = path.join(harness.root, 'mismatched.boboplugin');
  await fsp.writeFile(mismatchedArchive, makeZip([
    { name: 'manifest.json', content: JSON.stringify(makeManifest('1.1.0', replacementSource, { id: 'acme.other-plugin' }), null, 2) },
    { name: 'dist/extension.js', content: replacementSource }
  ]));
  await assert.rejects(
    () => harness.controller.installArchiveFromPath(mismatchedArchive, { id: 'acme.sample-plugin', version: '1.1.0' }),
    { code: 'plugins.install.identity' }
  );
  const retained = harness.controller.get('acme.sample-plugin');
  assert.equal(retained.version, '1.0.0');
  assert.equal(retained.status, 'enabled');
  assert.deepEqual(retained.grantedPermissions, ['commands.register', 'services.read']);
  assert.equal(harness.controller.get('acme.other-plugin'), null);
});

test('serialized marketplace installs cannot overwrite a newer concurrent local import', async (t) => {
  const harness = await createHarness(t);
  const localNewer = path.join(harness.root, 'local-newer');
  await writePackage(localNewer, '2.0.0', 'export const local = 2;\n');
  const marketplaceSource = 'export const marketplace = 1;\n';
  const marketplaceArchive = path.join(harness.root, 'marketplace-v1.boboplugin');
  await fsp.writeFile(marketplaceArchive, makeZip([
    { name: 'manifest.json', content: JSON.stringify(makeManifest('1.0.0', marketplaceSource), null, 2) },
    { name: 'dist/extension.js', content: marketplaceSource }
  ]));

  // This mirrors a v1 marketplace download completing after the user started
  // a local v2 import. The second request must observe v2 inside the queue.
  const localInstall = harness.controller.installFromPath(localNewer);
  const staleMarketplaceInstall = harness.controller.installArchiveFromPath(marketplaceArchive, {
    id: 'acme.sample-plugin',
    version: '1.0.0',
    expectedMinimumVersion: '1.0.0'
  });
  await localInstall;
  await assert.rejects(staleMarketplaceInstall, { code: 'plugins.install.downgrade' });
  const retained = harness.controller.get('acme.sample-plugin');
  assert.equal(retained.version, '2.0.0');
  assert.equal(retained.status, 'disabled');
  assert.deepEqual(retained.grantedPermissions, ['commands.register', 'services.read']);
});

test('SCM and static source-control permissions remain main-process authorized', async (t) => {
  const harness = await createHarness(t);
  const source = path.join(harness.root, 'scm-package');
  await writePackage(source);
  const manifestPath = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  manifest.permissions = ['scm.git.read', 'scm.git.write', 'sourceControl.register', 'fileDecorations.scm'];
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  await harness.controller.installFromPath(source);
  await harness.controller.setEnabled('acme.sample-plugin', true);
  const trustedEvent = { sender: harness.window.webContents };
  const rpcHandler = harness.handlers.get('plugins:rpc');
  assert.deepEqual(
    await harness.controller.rpc('acme.sample-plugin', 'scm.git.detect', { includeNested: false }),
    { repositories: [] }
  );
  const success = await rpcHandler(trustedEvent, {
    pluginId: 'acme.sample-plugin',
    method: 'scm.git.detect',
    args: { includeNested: false }
  });
  assert.equal(success.ok, true);
  assert.deepEqual(success.value, { repositories: [] });
  assert.deepEqual(
    await harness.controller.rpc('acme.sample-plugin', 'sourceControl.register', {
      id: 'acme.sample-plugin.source-control',
      title: 'Source Control',
      icon: 'git-branch',
      order: 10,
      openCommand: 'acme.sample-plugin.openSourceControl'
    }),
    { authorized: true, method: 'sourceControl.register', permission: 'sourceControl.register' }
  );
  assert.deepEqual(
    await harness.controller.rpc('acme.sample-plugin', 'fileDecorations.scm.register', {
      id: 'acme.sample-plugin.decorations',
      priority: 25
    }),
    { authorized: true, method: 'fileDecorations.scm.register', permission: 'fileDecorations.scm' }
  );
  await assert.rejects(
    () => harness.controller.rpc('acme.sample-plugin', 'fileDecorations.scm.set', {}),
    { code: 'plugins.rpc.denied' }
  );

  harness.workspaceState.rootPath = null;
  await assert.rejects(
    () => harness.controller.rpc('acme.sample-plugin', 'scm.git.detect', { includeNested: false }),
    { code: 'SCM_GIT_NO_WORKSPACE' }
  );
  const failure = await rpcHandler(trustedEvent, {
    pluginId: 'acme.sample-plugin',
    method: 'scm.git.detect',
    args: { includeNested: false }
  });
  assert.equal(failure.ok, false);
  assert.deepEqual(failure.error, {
    code: 'SCM_GIT_NO_WORKSPACE',
    message: 'Open a local workspace before using source control.'
  });
  await assert.rejects(
    () => rpcHandler({ sender: {} }, {
      pluginId: 'acme.sample-plugin',
      method: 'scm.git.detect',
      args: { includeNested: false }
    }),
    { code: 'plugins.ipc.sender' }
  );
});
