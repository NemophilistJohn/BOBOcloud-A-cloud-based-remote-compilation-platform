'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const workspaceSource = fs.readFileSync(path.join(ROOT, 'src', 'workspace.js'), 'utf8');

test('registered document viewers take priority over the built-in image fallback', () => {
  const openFileStart = workspaceSource.indexOf('async function openFile(filePath, name)');
  const activateTabStart = workspaceSource.indexOf('function activateTab(filePath)', openFileStart);
  const openFileSource = workspaceSource.slice(openFileStart, activateTabStart);
  const registrationIndex = openFileSource.indexOf('BOBO.documentViews.find(name)');
  const imageFallbackIndex = openFileSource.indexOf('BOBO.isImageFile(name) && !documentRegistration');
  assert.ok(registrationIndex >= 0, 'openFile should query registered document viewers');
  assert.ok(imageFallbackIndex > registrationIndex, 'the image fallback should run only after viewer selection');
  const createIndex = openFileSource.indexOf('await BOBO.documentViews.create');
  const committedTabIndex = openFileSource.indexOf('committedDocumentTab', createIndex);
  const pushIndex = openFileSource.indexOf('S.tabs.push(documentTab)', createIndex);
  assert.ok(createIndex >= 0 && committedTabIndex > createIndex && pushIndex > committedTabIndex,
    'openFile should recheck the tab after async document-view creation before committing it');
});

test('document views use one typed adapter while coupled workbench callers keep the BOBO projection', () => {
  const entrySource = fs.readFileSync(path.join(ROOT, 'renderer', 'entry.js'), 'utf8');
  const adapterSource = fs.readFileSync(
    path.join(ROOT, 'renderer', 'compat', 'document-views-adapter.ts'),
    'utf8'
  );
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

  assert.match(entrySource, /import ['"]\.\/compat\/document-views-adapter\.ts['"]/);
  assert.doesNotMatch(entrySource, /import ['"]\.\.\/src\/document-views(?:\.js|\.ts)['"]/);
  assert.match(adapterSource, /BOBO\.documentViews\s*=\s*documentViews\s*;/);
  assert.match(appSource, /BOBO\.documentViews\) BOBO\.documentViews\.init\(\)/);
  assert.match(workspaceSource, /BOBO\.documentViews\.find\(name\)/);
  assert.match(workspaceSource, /BOBO\.documentViews\.disposeAll\(\)/);
  assert.doesNotMatch(appSource, /from ['"][^'"]*document-views/);
  assert.doesNotMatch(workspaceSource, /from ['"][^'"]*document-views/);
});
