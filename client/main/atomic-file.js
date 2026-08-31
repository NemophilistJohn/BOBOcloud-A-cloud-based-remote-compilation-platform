'use strict';

const fs = require('node:fs');
const path = require('node:path');

let sequence = 0;

function byteLength(value) {
  return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value), 'utf8');
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (_) {
    // Directory fsync is unavailable on Windows and some virtual filesystems.
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
  }
}

function writeFileAtomicSync(filePath, content, options = {}) {
  const maximum = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : 0;
  const size = byteLength(content);
  if (maximum && size > maximum) {
    const error = new Error('Persisted data exceeds its storage limit');
    error.code = 'DATA_TOO_LARGE';
    throw error;
  }

  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${++sequence}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', options.mode || 0o600);
    fs.writeFileSync(descriptor, content, options.encoding || undefined);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, options.mode || 0o600); } catch (_) {}
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function readFileBoundedSync(filePath, options = {}) {
  const maximum = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 0;
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    const unsafe = new Error('Persisted data must be an ordinary file');
    unsafe.code = 'UNSAFE_DATA_FILE';
    throw unsafe;
  }
  const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || (before.dev !== opened.dev || before.ino !== opened.ino)) {
      const unsafe = new Error('Persisted data changed while it was being opened');
      unsafe.code = 'UNSAFE_DATA_FILE';
      throw unsafe;
    }
    if (maximum && opened.size > maximum) {
      const oversized = new Error('Persisted data exceeds its storage limit');
      oversized.code = 'DATA_TOO_LARGE';
      throw oversized;
    }
    const limit = maximum || Math.max(1, opened.size + 1);
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const capacity = Math.min(64 * 1024, limit + 1 - total);
      if (capacity <= 0) break;
      const chunk = Buffer.allocUnsafe(capacity);
      const bytesRead = fs.readSync(descriptor, chunk, 0, capacity, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > limit || (maximum && total > maximum)) {
      const oversized = new Error('Persisted data exceeds its storage limit');
      oversized.code = 'DATA_TOO_LARGE';
      throw oversized;
    }
    const value = Buffer.concat(chunks, total);
    return options.encoding ? value.toString(options.encoding) : value;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
  }
}

function readJsonFileSync(filePath, options = {}) {
  return JSON.parse(readFileBoundedSync(filePath, Object.assign({}, options, { encoding: 'utf8' })));
}

async function readFileBounded(filePath, options = {}) {
  const maximum = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 0;
  const before = await fs.promises.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    const unsafe = new Error('Persisted data must be an ordinary file');
    unsafe.code = 'UNSAFE_DATA_FILE';
    throw unsafe;
  }
  const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;
  let handle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      const unsafe = new Error('Persisted data changed while it was being opened');
      unsafe.code = 'UNSAFE_DATA_FILE';
      throw unsafe;
    }
    if (maximum && opened.size > maximum) {
      const oversized = new Error('Persisted data exceeds its storage limit');
      oversized.code = 'DATA_TOO_LARGE';
      throw oversized;
    }
    const limit = maximum || Math.max(1, opened.size + 1);
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const capacity = Math.min(64 * 1024, limit + 1 - total);
      if (capacity <= 0) break;
      const chunk = Buffer.allocUnsafe(capacity);
      const result = await handle.read(chunk, 0, capacity, null);
      if (!result.bytesRead) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
    if (total > limit || (maximum && total > maximum)) {
      const oversized = new Error('Persisted data exceeds its storage limit');
      oversized.code = 'DATA_TOO_LARGE';
      throw oversized;
    }
    const value = Buffer.concat(chunks, total);
    return options.encoding ? value.toString(options.encoding) : value;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function writeJsonAtomicSync(filePath, value, options = {}) {
  const spacing = options.compact === true ? 0 : 2;
  writeFileAtomicSync(filePath, JSON.stringify(value, null, spacing) + '\n', {
    encoding: 'utf8',
    maxBytes: options.maxBytes,
    mode: options.mode || 0o600
  });
}

async function writeFileAtomic(filePath, content, options = {}) {
  const maximum = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 0;
  const size = byteLength(content);
  if (maximum && size > maximum) {
    const error = new Error('Persisted data exceeds its storage limit');
    error.code = 'DATA_TOO_LARGE';
    throw error;
  }
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${++sequence}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', options.mode || 0o600);
    await handle.writeFile(content, options.encoding || undefined);
    await handle.sync();
    await handle.close();
    handle = null;
    if (typeof options.beforeReplace === 'function') await options.beforeReplace();
    await fs.promises.rename(temporary, filePath);
    await fs.promises.chmod(filePath, options.mode || 0o600).catch(() => {});
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

module.exports = {
  readFileBounded,
  readFileBoundedSync,
  readJsonFileSync,
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomicSync
};
