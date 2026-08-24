'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'workspace.js'), 'utf8');

test('registered document viewers take priority over the built-in image fallback', () => {
  const openFileStart = workspaceSource.indexOf('async function openFile(filePath, name)');
  const activateTabStart = workspaceSource.indexOf('function activateTab(filePath)', openFileStart);
  const openFileSource = workspaceSource.slice(openFileStart, activateTabStart);
  const registrationIndex = openFileSource.indexOf('BOBO.documentViews.find(name)');
  const imageFallbackIndex = openFileSource.indexOf('BOBO.isImageFile(name) && !documentRegistration');
  assert.ok(registrationIndex >= 0, 'openFile should query registered document viewers');
  assert.ok(imageFallbackIndex > registrationIndex, 'the image fallback should run only after viewer selection');
});
