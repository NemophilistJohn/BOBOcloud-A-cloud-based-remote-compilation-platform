'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, Platform, Arch } = require('electron-builder');
const {
  BOOTSTRAP_RESOURCE_DESTINATION,
  createBootstrapServerSettings
} = require('../main/server-settings-bootstrap');

const PROJECT_DIRECTORY = path.resolve(__dirname, '..');

function resolveSettingsPath(projectDirectory, requestedPath) {
  const explicit = requestedPath || process.env.BOBO_INTERNAL_SERVER_SETTINGS_PATH;
  if (explicit) {
    const resolved = path.resolve(projectDirectory, explicit);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error('Internal installer server settings file was not found: ' + resolved);
  }

  const repositoryDirectory = path.resolve(projectDirectory, '..');
  const candidates = [
    path.join(projectDirectory, 'server-settings.json'),
    path.join(repositoryDirectory, 'server-settings.json')
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (resolved) return resolved;
  throw new Error('Internal installer requires a local server settings JSON file. Set BOBO_INTERNAL_SERVER_SETTINGS_PATH or pass its path as the first argument.');
}

function stageBootstrapSettings(sourcePath, stagingDirectory) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    throw new Error('Could not read internal server settings JSON: ' + error.message);
  }
  const settings = createBootstrapServerSettings(parsed);
  if (!settings) {
    throw new Error('Internal server settings must include a non-empty ip and user.');
  }
  const bootstrapPath = path.join(stagingDirectory, 'server-settings.bootstrap.json');
  fs.writeFileSync(bootstrapPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return bootstrapPath;
}

function createInternalBuildConfig(_baseConfig, bootstrapPath, outputDirectory) {
  // electron-builder already reads package.json's public build configuration
  // before merging this override. Passing that full configuration again makes
  // array-valued entries such as win.extraResources duplicate, which races two
  // copies of rclone.exe into the same destination on Windows.
  return {
    directories: { output: outputDirectory },
    win: {
      extraResources: [{ from: bootstrapPath, to: BOOTSTRAP_RESOURCE_DESTINATION }]
    }
  };
}

async function packageInternalInstaller(options = {}) {
  const projectDirectory = options.projectDirectory || PROJECT_DIRECTORY;
  const settingsPath = resolveSettingsPath(projectDirectory, options.settingsPath);
  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-internal-bootstrap-'));
  const requestedOutput = options.outputDirectory || process.env.BOBO_INTERNAL_OUTPUT_DIR || path.join('dist', 'internal-test');
  const outputDirectory = path.resolve(projectDirectory, requestedOutput);
  try {
    const bootstrapPath = stageBootstrapSettings(settingsPath, stagingDirectory);
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'));
    const config = createInternalBuildConfig(packageJson.build || {}, bootstrapPath, outputDirectory);
    const buildApplication = options.build || build;
    return await buildApplication({
      projectDir: projectDirectory,
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
      config,
      publish: 'never'
    });
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (require.main === module) {
  packageInternalInstaller({ settingsPath: process.argv[2] }).then((artifacts) => {
    for (const artifact of artifacts) console.log('[internal-installer] created ' + artifact);
  }).catch((error) => {
    console.error('[internal-installer] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createInternalBuildConfig,
  packageInternalInstaller,
  resolveSettingsPath,
  stageBootstrapSettings
};
