'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadUtilities() {
  const window = { BOBO: {} };
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils.js'), 'utf8');
  vm.runInNewContext(source, { window });
  return window.BOBO;
}

test('local path flavor follows the workspace path instead of an ambient platform flag', () => {
  const utilities = loadUtilities();
  assert.equal(utilities.isWindowsLocalPath('C:\\workspace\\main.py'), true);
  assert.equal(utilities.isWindowsLocalPath('c:/workspace/main.py'), true);
  assert.equal(utilities.isWindowsLocalPath('\\\\server\\share\\main.py'), true);
  assert.equal(utilities.isWindowsLocalPath('//server/share/main.py'), true);
  assert.equal(utilities.isWindowsLocalPath('/workspace/main.py'), false);
  assert.equal(utilities.localPathSeparator('D:\\workspace'), '\\');
  assert.equal(utilities.localPathSeparator('/workspace'), '/');
});
