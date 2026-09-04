'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginSemver = require('../shared/plugin-semver');
const mainPlugins = require('../main/plugins');
const marketplace = require('../main/marketplace');

const ROOT = path.resolve(__dirname, '..');

test('plugin version validation uses strict canonical SemVer in every host boundary', () => {
  const matrix = [
    ['0.0.0', true],
    ['1.2.3-alpha.1', true],
    ['1.2.3-alpha+build.9', true],
    ['1.2.3+build.9', true],
    ['01.2.3', false],
    ['1.2', false],
    ['1.2.3-01', false],
    ['v1.2.3', false],
    ['=1.2.3', false],
    [' 1.2.3', false]
  ];
  for (const [version, expected] of matrix) {
    assert.equal(pluginSemver.isValidSemver(version), expected, version);
  }
});

test('plugin range evaluation follows node-semver partial comparator semantics', () => {
  const matrix = [
    ['1.5.0', '>1', false],
    ['2.0.0', '>1', true],
    ['1.5.0', '>1.5', false],
    ['1.6.0', '>1.5', true],
    ['1.5.0', '>=1 <2', true],
    ['1.5.0', '^2 || 1.x', true],
    ['2.1.0', '^2 || 1.x', true],
    ['3.0.0', '^2 || 1.x', false],
    ['1.5.0', '1.0.0 ||', false],
    ['1.5.0', 'garbage', false]
  ];
  for (const [version, range, expected] of matrix) {
    assert.equal(pluginSemver.satisfiesVersionRange(version, range), expected, version + ' ' + range);
    assert.equal(mainPlugins.satisfiesVersionRange(version, range), expected, 'main/plugins: ' + version + ' ' + range);
  }
});

test('plugin comparisons handle prerelease identifiers and build metadata consistently', () => {
  const matrix = [
    ['1.0.0-beta.10', '1.0.0-beta.2', 1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0+build.2', '1.0.0+build.1', 0],
    ['invalid', '1.0.0', null]
  ];
  for (const [left, right, expected] of matrix) {
    assert.equal(pluginSemver.compareSemver(left, right), expected, left + ' / ' + right);
    assert.equal(marketplace.compareSemver(left, right), expected, 'marketplace: ' + left + ' / ' + right);
  }
});

test('all plugin SemVer consumers are wired to the shared helper and package it', () => {
  const sources = {
    plugins: fs.readFileSync(path.join(ROOT, 'main', 'plugins.js'), 'utf8'),
    marketplace: fs.readFileSync(path.join(ROOT, 'main', 'marketplace.js'), 'utf8'),
    runtime: fs.readFileSync(path.join(ROOT, 'renderer', 'core', 'plugin-runtime.ts'), 'utf8'),
    manager: fs.readFileSync(path.join(ROOT, 'src', 'plugin-manager-ui.ts'), 'utf8')
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /shared\/plugin-semver/, name);
  }
  assert.doesNotMatch(sources.plugins, /function\s+(?:compareSemver|parsePartialVersion|satisfiesVersionToken)\s*\(/);
  assert.doesNotMatch(sources.marketplace, /function\s+compareSemver\s*\(/);
  assert.doesNotMatch(sources.runtime, /function\s+(?:parsePartialVersion|satisfiesToken)\s*\(/);
  assert.doesNotMatch(sources.manager, /function\s+compareVersions\s*\(/);

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.dependencies.semver, '7.7.3');
  assert.equal(packageLock.packages[''].dependencies.semver, '7.7.3');
  assert.equal(packageLock.packages['node_modules/semver'].dev, undefined);
  assert.ok(packageJson.build.files.includes('shared/'));
});
