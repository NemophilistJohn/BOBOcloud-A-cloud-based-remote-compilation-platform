'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(CLIENT_ROOT, '..');

test('the repository keeps Electron code in client and Go service code in server', () => {
  assert.equal(path.basename(CLIENT_ROOT), 'client');
  for (const entry of ['package.json', 'main.js', 'preload.js', 'index.html', 'main', 'src', 'renderer', 'scripts', 'tests']) {
    assert.equal(fs.existsSync(path.join(CLIENT_ROOT, entry)), true, 'missing client/' + entry);
  }
  for (const entry of ['go.mod', 'cmd', 'internal', 'deploy']) {
    assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'server', entry)), true, 'missing server/' + entry);
  }
  for (const entry of ['main.js', 'preload.js', 'index.html']) {
    assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, entry)), false, 'legacy root client entry remains: ' + entry);
  }
});

test('root convenience commands delegate to the client package without duplicating client dependencies', () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.scripts.start, 'npm --prefix client run start');
  assert.equal(rootPackage.scripts.test, 'npm --prefix client run test');
  assert.equal(rootPackage.scripts['test:ui'], 'npm --prefix client run test:ui');
  assert.equal(rootPackage.scripts['test:server'], 'go -C server test ./...');
});

test('client screenshot tooling starts Electron from client and publishes shared repository documentation', () => {
  const source = fs.readFileSync(path.join(CLIENT_ROOT, 'scripts', 'capture-readme-screenshots.js'), 'utf8');
  assert.match(source, /const CLIENT_ROOT = path\.resolve\(__dirname, '\.\.'\);/);
  assert.match(source, /const REPOSITORY_ROOT = path\.resolve\(CLIENT_ROOT, '\.\.'\);/);
  assert.match(source, /path\.join\(REPOSITORY_ROOT, 'docs', 'screenshots'\)/);
  assert.match(source, /args: \[CLIENT_ROOT,/);
});
