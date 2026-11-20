'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { crc32 } = require('node:zlib');
const yauzl = require('yauzl');
const { endpoint } = require('./server-transport');
const { credentialForServer, effectiveCredential, serverEndpointIdentity, serverAccountIdentity } = require('./server-identity');
const { readBoundedResponse } = require('./rclone-remote-authority');

const maxProject = 1024 ** 3;
const maxArchive = maxProject + 200 * 1024 ** 2;
const invalidPart = /[<>:"\\|?*\u0000-\u001f]|[. ]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function safeArchivePath(name) {
  const parts = name.replace(/\/$/, '').split('/');
  if (Buffer.byteLength(name) > 4096 || parts.some((part) => !part || invalidPart.test(part) || Buffer.byteLength(part) > 255)) {
    throw new Error('Invalid file name in project snapshot');
  }
  return parts;
}

function byteBound(limit, checksum) {
  let count = 0;
  let crc = 0;
  return new Transform({
    transform(data, _encoding, cb) {
      count += data.length;
      if (count > limit) return cb(new Error('Project snapshot exceeds its size limit'));
      if (checksum !== undefined) crc = crc32(data, crc);
      cb(null, data);
    },
    flush(cb) {
      cb(checksum !== undefined && (crc !== checksum || count !== limit)
        ? new Error('Project snapshot failed its integrity check') : undefined);
    }
  });
}

async function extractZip(file, destination, signal) {
  const archive = await yauzl.openPromise(file, { strictFileNames: true });
  try {
    if (archive.entryCount > 20000) throw new Error('Project snapshot contains too many files');
    let size = 0;
    for await (const entry of archive.eachEntry()) {
      signal.throwIfAborted();
      const parts = safeArchivePath(entry.fileName);
      const directory = entry.fileName.endsWith('/');
      const type = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (type && type !== (directory ? 0x4000 : 0x8000)) throw new Error('Invalid project snapshot file type');
      size += entry.uncompressedSize;
      if (size > maxProject) throw new Error('Project snapshot exceeds its size limit');
      const target = path.join(destination, ...parts);
      if (directory) {
        await fs.mkdir(target, { mode: 0o700 });
      } else {
        const input = await archive.openReadStreamPromise(entry);
        await pipeline(input, byteBound(entry.uncompressedSize, entry.crc32),
          createWriteStream(target, { flags: 'wx', mode: 0o600 | ((entry.externalFileAttributes >>> 16) & 0o100) }), { signal });
      }
    }
  } finally {
    archive.close();
  }
}

async function makeDestination(parent, title) {
  let name = String(title || '').trim().slice(0, 70).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (!name || invalidPart.test(name)) name = 'Project';
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const dir = path.join(parent, suffix === 1 ? name : name + ' (' + suffix + ')');
    try {
      await fs.mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not find an unused project download folder');
}

function registerInboxDownload({ ipcMain, dialog, getWindow, settings, fetch, t, assertSafeLocalRoot }) {
  let active;
  const receipts = new Set();
  const cancel = () => active?.abort();
  ipcMain.handle('inbox:download-project', async (event, payload) => {
    const owner = getWindow();
    if (!owner || owner.isDestroyed?.() || event.sender !== owner.webContents ||
        (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) throw new Error('Untrusted inbox download sender');
    const id = payload?.messageId;
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || active) throw new Error('Invalid or busy inbox download');
    const controller = active = new AbortController();
    const { signal } = controller;
    const sender = event.sender;
    sender.once('destroyed', cancel);
    let stage;
    let dest;
    let completed = false;
    let timeout;
    try {
      const cfg = await settings.readServerSettings();
      const base = endpoint(cfg);
      const auth = effectiveCredential(credentialForServer(settings.readAuth(), cfg).credential);
      const token = auth?.token || cfg.apiKey;
      if (!base || !token) throw new Error('No authenticated server connection');
      const receipt = serverEndpointIdentity(cfg) + ':' + serverAccountIdentity(cfg, auth) + ':' + id;
      timeout = setTimeout(cancel, 5 * 60 * 1000);
      const options = { headers: { Authorization: 'Bearer ' + token }, signal, redirect: 'error', cache: 'no-store', credentials: 'omit' };
      const acknowledge = async () => {
        try {
          const ack = await fetch(base, {
            ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'respondInbox', messageId: id, decision: 'local' })
          });
          if (ack.ok && JSON.parse(await readBoundedResponse(ack, 128 * 1024)).success === true) {
            receipts.delete(receipt);
            return { archived: true };
          }
          await ack.body?.cancel().catch(() => {});
        } catch (_) {}
        return { archived: false };
      };
      if (receipts.has(receipt)) return await acknowledge();
      const picked = await dialog.showOpenDialog(getWindow(), {
        title: t('Choose download location'), buttonLabel: t('Download here'), properties: ['openDirectory', 'createDirectory']
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      signal.throwIfAborted();
      const parent = await fs.realpath(picked.filePaths[0]);
      await assertSafeLocalRoot(parent);
      const response = await fetch(base + '/inbox/project/' + id, options);
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/zip')) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Project download failed');
      }
      stage = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-inbox-'));
      const archive = path.join(stage, 'project.zip');
      await pipeline(Readable.fromWeb(response.body), byteBound(maxArchive), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
      dest = await makeDestination(parent, payload?.name);
      await extractZip(archive, dest, signal);
      signal.throwIfAborted();
      completed = true;
      receipts.add(receipt);
      if (receipts.size > 128) receipts.delete(receipts.values().next().value);
      return await acknowledge();
    } finally {
      clearTimeout(timeout);
      sender.removeListener('destroyed', cancel);
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (dest && !completed) await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      active = null;
    }
  });
  return { cancel };
}

module.exports = { registerInboxDownload, extractZip, safeArchivePath };
