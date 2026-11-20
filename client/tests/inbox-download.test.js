'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { crc32 } = require('node:zlib');
const test = require('node:test');
const { extractZip, registerInboxDownload, safeArchivePath } = require('../main/inbox-download');

function projectZip(entries) {
  const files = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data || '');
    const crc = entry.checksum ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    files.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bobo-inbox-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const sender = new EventEmitter();
  sender.id = 1;
  sender.mainFrame = {};
  const owner = { webContents: sender, isDestroyed: () => false };
  const calls = { fetch: [], dialog: [], roots: [] };
  const zip = options.zip || projectZip([{ name: '课程/' }, { name: '课程/code.py', data: 'print(42)\n' }]);
  const controller = registerInboxDownload({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    getWindow: () => owner,
    dialog: {
      async showOpenDialog(window, value) {
        calls.dialog.push({ window, value });
        return options.pick ? options.pick() : { canceled: false, filePaths: [root] };
      }
    },
    settings: {
      async readServerSettings() { return { ip: 'compiler.test', httpPort: 3100, apiKey: 'server-api' }; },
      readAuth() { return { servers: {} }; }
    },
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      return init.method === 'POST'
        ? new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } })
        : new Response(zip, { headers: { 'content-type': 'application/zip', 'content-length': String(zip.length) } });
    },
    t: (key) => key,
    assertSafeLocalRoot(value) { calls.roots.push(value); if (options.unsafe) throw new Error('Protected directory'); }
  });
  const event = { sender, senderFrame: sender.mainFrame };
  return { root, calls, controller, event, handler: handlers.get('inbox:download-project') };
}

test('project archive paths reject traversal and Windows alternate names', () => {
  for (const name of ['../escape', '/absolute', 'a/../../escape', 'a\\file', 'C:/file', 'a//file', 'CON.txt', 'a/nul', 'a/file.', 'a/file ', 'a\u0000b']) {
    assert.throws(() => safeArchivePath(name), /Invalid file name/);
  }
  assert.deepEqual(safeArchivePath('课程/代码.py'), ['课程', '代码.py']);
});

test('inbox native download extracts one chosen folder and acknowledges only after success', async (t) => {
  const value = await fixture(t);
  const result = await value.handler(value.event, { messageId: 'a'.repeat(32), name: '课程项目' });
  assert.equal(result.archived, true);
  assert.equal(await fs.readFile(path.join(value.root, '课程项目/课程/code.py'), 'utf8'), 'print(42)\n');
  assert.equal(value.calls.fetch[0].url, 'http://compiler.test:3100/inbox/project/' + 'a'.repeat(32));
  assert.equal(value.calls.fetch[0].init.headers.Authorization, 'Bearer server-api');
  assert.equal(value.calls.fetch[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(value.calls.fetch[1].init.body), { action: 'respondInbox', messageId: 'a'.repeat(32), decision: 'local' });
  assert.deepEqual(await fs.readdir(value.root), ['课程项目']);
  assert.equal(value.event.sender.listenerCount('destroyed'), 0);
});

test('same-name downloads keep prior files and create an unused destination', async (t) => {
  const value = await fixture(t);
  await fs.mkdir(path.join(value.root, 'Project'));
  await fs.writeFile(path.join(value.root, 'Project/keep'), 'original');
  await value.handler(value.event, { messageId: 'b'.repeat(32), name: 'Project' });
  assert.equal(await fs.readFile(path.join(value.root, 'Project/keep'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(value.root, 'Project (2)/课程/code.py'), 'utf8'), 'print(42)\n');
});

test('cancelled location picker and protected roots never start a transfer', async (t) => {
  const cancelled = await fixture(t, { pick: () => ({ canceled: true, filePaths: [] }) });
  assert.equal(await cancelled.handler(cancelled.event, { messageId: 'c'.repeat(32) }), null);
  assert.equal(cancelled.calls.fetch.length, 0);
  const protectedRoot = await fixture(t, { unsafe: true });
  await assert.rejects(protectedRoot.handler(protectedRoot.event, { messageId: 'c'.repeat(32) }), /Protected directory/);
  assert.equal(protectedRoot.calls.fetch.length, 0);
});

test('corrupt file data removes incomplete destination and sends no receipt', async (t) => {
  const value = await fixture(t, { zip: projectZip([{ name: 'code.py', data: 'wrong checksum', checksum: 0 }]) });
  await assert.rejects(value.handler(value.event, { messageId: 'd'.repeat(32), name: 'Project' }), /integrity/);
  assert.equal(value.calls.fetch.length, 1);
  assert.deepEqual(await fs.readdir(value.root), []);
  assert.equal(value.event.sender.listenerCount('destroyed'), 0);
});

test('symlink ZIP entries and traversal fail without writing outside destination', async (t) => {
  for (const entry of [{ name: '../outside', data: 'bad' }, { name: 'link', mode: 0o120777, data: 'outside' }]) {
    const value = await fixture(t, { zip: projectZip([entry]) });
    await assert.rejects(value.handler(value.event, { messageId: 'e'.repeat(32), name: 'Project' }));
    assert.equal(value.calls.fetch.length, 1);
    assert.deepEqual(await fs.readdir(value.root), []);
    await assert.rejects(fs.stat(path.join(value.root, 'outside')), { code: 'ENOENT' });
  }
});

test('receipt retry acknowledges the existing local project without another download or picker', async (t) => {
  const zip = projectZip([{ name: 'code.py', data: 'complete' }]);
  let attempts = 0;
  const value = await fixture(t, {
    async fetch(_url, init) {
      if (init.method === 'POST') {
        if (++attempts === 1) throw new Error('network disconnected');
        return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(zip, { headers: { 'content-type': 'application/zip' } });
    }
  });
  assert.deepEqual(await value.handler(value.event, { messageId: 'f'.repeat(32), name: 'Project' }), { archived: false });
  assert.equal(await fs.readFile(path.join(value.root, 'Project/code.py'), 'utf8'), 'complete');
  assert.deepEqual(await value.handler(value.event, { messageId: 'f'.repeat(32), name: 'Project' }), { archived: true });
  assert.equal(attempts, 2);
  assert.deepEqual(value.calls.fetch.map(({ init }) => init.method || 'GET'), ['GET', 'POST', 'POST']);
  assert.deepEqual(JSON.parse(value.calls.fetch[2].init.body), { action: 'respondInbox', messageId: 'f'.repeat(32), decision: 'local' });
  assert.equal(value.calls.dialog.length, 1);
  assert.deepEqual(await fs.readdir(value.root), ['Project']);
  assert.equal(await fs.readFile(path.join(value.root, 'Project/code.py'), 'utf8'), 'complete');
  assert.equal(value.event.sender.listenerCount('destroyed'), 0);
});

test('non-OK receipt responses cancel unused bodies and preserve the completed project for retry', async (t) => {
  const zip = projectZip([{ name: 'code.py', data: 'complete' }]);
  let cancelled = false;
  let attempts = 0;
  const value = await fixture(t, {
    async fetch(_url, init) {
      if (init.method !== 'POST') return new Response(zip, { headers: { 'content-type': 'application/zip' } });
      if (++attempts > 1) return new Response(JSON.stringify({ success: true }));
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      return new Response(body, { status: 503, headers: { 'content-type': 'application/json' } });
    }
  });
  const payload = { messageId: 'f'.repeat(32), name: 'Project' };
  assert.deepEqual(await value.handler(value.event, payload), { archived: false });
  assert.equal(cancelled, true);
  assert.equal(await fs.readFile(path.join(value.root, 'Project/code.py'), 'utf8'), 'complete');
  assert.deepEqual(await value.handler(value.event, payload), { archived: true });
  assert.equal(value.calls.dialog.length, 1);
  assert.deepEqual(value.calls.fetch.map(({ init }) => init.method || 'GET'), ['GET', 'POST', 'POST']);
  assert.deepEqual(await fs.readdir(value.root), ['Project']);
});

test('HTTP rejection cancels its response stream without receiving a project', async (t) => {
  let cancelled = false;
  const value = await fixture(t, {
    async fetch() {
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      return new Response(body, { status: 410, headers: { 'content-type': 'application/zip' } });
    }
  });
  await assert.rejects(value.handler(value.event, { messageId: 'a'.repeat(32) }), /Project download failed/);
  assert.equal(cancelled, true);
  assert.deepEqual(await fs.readdir(value.root), []);
});

test('cancellation during transfer removes its temporary archive and releases sender subscriptions', async (t) => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const value = await fixture(t, {
    async fetch(_url, init) {
      const body = new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        started();
      } });
      return new Response(body, { headers: { 'content-type': 'application/zip' } });
    }
  });
  const transfer = value.handler(value.event, { messageId: 'b'.repeat(32), name: 'Project' });
  await entered;
  value.controller.cancel();
  await assert.rejects(transfer);
  assert.deepEqual(await fs.readdir(value.root), []);
  assert.equal(value.event.sender.listenerCount('destroyed'), 0);
});

test('extractor honors cancellation before creating a destination file', async (t) => {
  const value = await fixture(t);
  const archive = path.join(value.root, 'input.zip');
  await fs.writeFile(archive, projectZip([{ name: 'code.py', data: 'x' }]));
  const destination = path.join(value.root, 'destination');
  await fs.mkdir(destination);
  const controller = new AbortController();
  controller.abort(new Error('cancelled test'));
  await assert.rejects(extractZip(archive, destination, controller.signal), /cancelled test/);
  assert.deepEqual(await fs.readdir(destination), []);
});

test('native inbox download rejects foreign windows and embedded frames before opening a picker', async (t) => {
  const value = await fixture(t);
  const foreign = new EventEmitter();
  foreign.mainFrame = {};
  await assert.rejects(value.handler({ sender: foreign, senderFrame: foreign.mainFrame }, { messageId: 'a'.repeat(32) }), /Untrusted|main frame/);
  await assert.rejects(value.handler({ sender: value.event.sender, senderFrame: {} }, { messageId: 'a'.repeat(32) }), /Untrusted|main frame/);
  assert.equal(value.calls.dialog.length, 0);
});
