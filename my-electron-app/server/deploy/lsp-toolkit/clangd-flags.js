#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FLAGS = 8;
const MAX_FLAG_BYTES = 512;
const MAX_TOTAL_BYTES = 2048;
const ALLOWED_FLAGS = new Set([
  '--sysroot=/analysis-deps/native/sysroot',
  '-I/analysis-deps/native/include'
]);

function parseFallbackFlags(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid fallback flags JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_FLAGS) {
    throw new Error(`fallback flags must be an array with at most ${MAX_FLAGS} entries`);
  }
  let total = 0;
  for (const flag of parsed) {
    if (typeof flag !== 'string' || flag.length === 0 || /[\0\r\n]/.test(flag)) {
      throw new Error('fallback flags must be non-empty single-line strings');
    }
    const size = Buffer.byteLength(flag, 'utf8');
    total += size;
    if (size > MAX_FLAG_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error('fallback flags exceed the configured size limit');
    }
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new Error(`fallback flag is not server-issued: ${flag}`);
    }
  }
  return [...new Set(parsed)];
}

function writeFlagFile(destination, flags) {
  const output = path.resolve(destination);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  const content = flags.length > 0 ? `${flags.join('\n')}\n` : '';
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, output);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function main() {
  const destination = process.argv[2];
  if (!destination) throw new Error('fallback flag output path is required');
  const flags = parseFallbackFlags(process.env.BOBO_CLANGD_FALLBACK_FLAGS_JSON);
  writeFlagFile(destination, flags);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`clangd fallback flags rejected: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { parseFallbackFlags, writeFlagFile };
