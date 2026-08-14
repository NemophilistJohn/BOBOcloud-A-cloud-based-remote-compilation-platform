'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('formula rendering bundles Temml without shipping a raw vendor script', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const temmlFiles = packageJson.build.files.filter(entry => /temml/i.test(entry));
  assert.deepEqual(temmlFiles, []);
  assert.ok(packageJson.build.files.includes('renderer-dist/'));
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'renderer', 'ai-ui-entry.js'), 'utf8'),
    /import '\.\/temml-runtime\.js';/
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'renderer', 'temml-runtime.js'), 'utf8'),
    /import temml from 'temml';/
  );
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), /src\/vendor\/temml\.min\.js/);
});
