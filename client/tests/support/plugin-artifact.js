'use strict';

const fs = require('node:fs');
const path = require('node:path');

function repositoryVersion(repositoryRoot) {
  const packageFile = path.join(repositoryRoot, 'package.json');
  if (!fs.existsSync(packageFile)) return '';
  const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  return typeof parsed.version === 'string' ? parsed.version.trim() : '';
}

function artifactVersion(artifactPath, pluginId) {
  const fileName = path.basename(artifactPath);
  const prefix = pluginId + '-';
  const suffix = '.boboplugin';
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return '';
  return fileName.slice(prefix.length, -suffix.length);
}

function resolvePluginArtifact(options) {
  const explicitValue = String(process.env[options.artifactEnv] || '').trim();
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const explicit = explicitValue.length > 0;
  const version = String(process.env[options.versionEnv] || '').trim() || repositoryVersion(repositoryRoot);
  const artifactPath = explicit
    ? path.resolve(explicitValue)
    : version
      ? path.join(repositoryRoot, 'artifacts', options.pluginId + '-' + version + '.boboplugin')
      : '';

  if (explicit && (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile())) {
    throw new Error(options.artifactEnv + ' does not point to a plugin artifact file: ' + artifactPath);
  }

  return Object.freeze({
    artifactPath,
    explicit,
    repositoryRoot,
    version: version || artifactVersion(artifactPath, options.pluginId)
  });
}

function shouldSkipMissingArtifact(artifact, label) {
  const available = artifact.artifactPath && fs.existsSync(artifact.artifactPath);
  if (available) return false;
  if (artifact.explicit || process.env.CI) {
    throw new Error(label + ' is required but missing: ' + (artifact.artifactPath || '<unresolved>'));
  }
  return true;
}

module.exports = {
  artifactVersion,
  repositoryVersion,
  resolvePluginArtifact,
  shouldSkipMissingArtifact
};
