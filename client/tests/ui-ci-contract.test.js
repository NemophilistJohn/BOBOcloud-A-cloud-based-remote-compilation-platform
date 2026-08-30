'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SPECIAL_UI_GROUPS,
  SPECIAL_UI_SPECS,
  UI_GROUPS,
  groupForSpec,
  selectionForGroup
} = require('./ui-test-groups');

const TEST_ROOT = __dirname;

function specFiles() {
  const files = [];
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relativePath);
      else if (entry.isFile() && entry.name.endsWith('.spec.js')) files.push(relativePath);
    }
  }
  visit(TEST_ROOT, '');
  return files.sort();
}

test('every UI spec belongs to exactly one CI group and new specs default to core', () => {
  const files = specFiles();
  const listed = new Set();
  for (const [group, groupFiles] of Object.entries(SPECIAL_UI_GROUPS)) {
    assert.ok(UI_GROUPS.includes(group));
    for (const fileName of groupFiles) {
      assert.ok(files.includes(fileName), group + ' references a missing UI spec: ' + fileName);
      assert.equal(listed.has(fileName), false, fileName + ' is listed in more than one special UI group');
      listed.add(fileName);
    }
  }
  for (const fileName of files) assert.ok(UI_GROUPS.includes(groupForSpec(fileName)));
  assert.equal(groupForSpec('future-feature-ui.spec.js'), 'core');
  assert.deepEqual([...listed].sort(), [...SPECIAL_UI_SPECS].sort());
});

test('core UI specs cannot silently skip CI coverage', () => {
  const forbidden = /\btest(?:\.describe)?\.(?:skip|fixme)\s*\(/;
  const offenders = specFiles()
    .filter((fileName) => groupForSpec(fileName) === 'core')
    .filter((fileName) => forbidden.test(fs.readFileSync(path.join(TEST_ROOT, ...fileName.split('/')), 'utf8')));
  assert.deepEqual(offenders, [], 'Move environment-specific specs to an explicit group instead of skipping core CI');
});

test('the default Playwright selection excludes only explicitly classified special specs', () => {
  const selection = selectionForGroup('core');
  assert.equal(selection.testMatch, '**/*.spec.js');
  assert.deepEqual(
    selection.testIgnore.slice().sort(),
    SPECIAL_UI_SPECS.map((fileName) => '**/' + fileName).sort()
  );
});
