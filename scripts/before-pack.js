'use strict';

const { prepareRclone } = require('./prepare-rclone');
const { buildRenderer } = require('./build-renderer');

async function beforePack(context, dependencies = {}) {
  const build = dependencies.buildRenderer || buildRenderer;
  await build({ mode: 'production' });
  const platform = context && context.electronPlatformName;
  if (platform === 'win32') return null;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error('Unsupported electron-builder platform for rclone packaging: ' + String(platform));
  }

  const prepare = dependencies.prepareRclone || prepareRclone;
  const binaryPath = await prepare({ platform, arch: context.arch });
  console.log('[rclone] prepared ' + platform + ' resource: ' + binaryPath);
  return binaryPath;
}

module.exports = beforePack;
module.exports.beforePack = beforePack;
