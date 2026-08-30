'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolvePluginArtifact, shouldSkipMissingArtifact } = require('./support/plugin-artifact');

test('explicit plugin artifact paths fail closed when the file is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-plugin-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envName = 'BOBO_TEST_PLUGIN_ARTIFACT';
  const previous = process.env[envName];
  process.env[envName] = path.join(root, 'missing.boboplugin');
  t.after(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });
  assert.throws(() => resolvePluginArtifact({
    artifactEnv: envName,
    pluginId: 'bobocloud.test',
    repositoryRoot: root,
    versionEnv: 'BOBO_TEST_PLUGIN_VERSION'
  }), /does not point to a plugin artifact file/);
});

test('repository package version selects the current plugin artifact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-plugin-repository-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.4.5' }));
  const resolved = resolvePluginArtifact({
    artifactEnv: 'BOBO_UNUSED_PLUGIN_ARTIFACT',
    pluginId: 'bobocloud.test',
    repositoryRoot: root,
    versionEnv: 'BOBO_UNUSED_PLUGIN_VERSION'
  });
  assert.equal(resolved.version, '3.4.5');
  assert.equal(resolved.artifactPath, path.join(root, 'artifacts', 'bobocloud.test-3.4.5.boboplugin'));
  assert.equal(resolved.explicit, false);
});

test('CI plugin compatibility cannot silently skip a missing default artifact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-plugin-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.CI;
  process.env.CI = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  });
  const resolved = resolvePluginArtifact({
    artifactEnv: 'BOBO_UNUSED_CI_PLUGIN_ARTIFACT',
    pluginId: 'bobocloud.test',
    repositoryRoot: root,
    versionEnv: 'BOBO_UNUSED_CI_PLUGIN_VERSION'
  });
  assert.throws(() => shouldSkipMissingArtifact(resolved, 'Test plugin artifact'), /required but missing/);
});
