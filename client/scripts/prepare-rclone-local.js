'use strict';

const { prepareRclone } = require('./prepare-rclone');

prepareRclone({ platform: process.platform, arch: process.arch }).then((binaryPath) => {
  console.log('[rclone] local bundled executable ready: ' + binaryPath);
}).catch((error) => {
  console.error('[rclone] could not prepare the local bundled executable:', error.message);
  process.exitCode = 1;
});
