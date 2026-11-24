'use strict';

const fs = require('node:fs');

function verifyPe(file, arch) {
  const machines = { x64: 0x8664, arm64: 0xaa64 };
  if (!Object.hasOwn(machines, arch)) throw new Error('Unsupported Windows architecture');
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Missing DOS header');
    const offset = dos.readUInt32LE(0x3c);
    if (offset > 16 * 1024 * 1024) throw new Error('Invalid PE header offset');
    const pe = Buffer.alloc(6);
    if (fs.readSync(fd, pe, 0, pe.length, offset) !== pe.length || !pe.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) throw new Error('Missing PE header');
    if (pe.readUInt16LE(4) !== machines[arch]) throw new Error('PE architecture does not match ' + arch);
  } finally { fs.closeSync(fd); }
}
if (require.main === module) {
  try { verifyPe(process.argv[2], process.argv[3]); console.log('Verified Windows executable architecture:', process.argv[3]); }
  catch (error) { console.error('[release-pe]', error.message); process.exitCode = 1; }
}
module.exports = { verifyPe };
