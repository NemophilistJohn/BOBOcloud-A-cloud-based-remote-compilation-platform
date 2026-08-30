const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTabOrder() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'tab-order.js'), 'utf8'),
    sandbox,
    { filename: 'src/tab-order.js' }
  );
  return sandbox.BOBO.tabOrder;
}

test('tab order supports precise before and after insertion while preserving tab objects', () => {
  const tabOrder = loadTabOrder();
  const alpha = { path: '/workspace/alpha.js', dirty: false };
  const beta = { path: '/workspace/beta.js', dirty: true };
  const gamma = { path: '/workspace/gamma.js', dirty: false };
  const tabs = [alpha, beta, gamma];

  assert.equal(tabOrder.reorder(tabs, alpha.path, gamma.path, 'after'), true);
  assert.deepEqual(tabs.map(tab => tab.path), [beta.path, gamma.path, alpha.path]);
  assert.equal(tabs[0], beta);
  assert.equal(tabs[2], alpha);

  assert.equal(tabOrder.reorder(tabs, alpha.path, beta.path, 'before'), true);
  assert.deepEqual(tabs.map(tab => tab.path), [alpha.path, beta.path, gamma.path]);
  assert.equal(tabs[1].dirty, true);
});

test('tab order rejects stale, same-position, and invalid reorder requests', () => {
  const tabOrder = loadTabOrder();
  const tabs = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];

  assert.equal(tabOrder.reorder(tabs, 'a', 'b', 'before'), false);
  assert.equal(tabOrder.reorder(tabs, 'missing', 'b', 'after'), false);
  assert.equal(tabOrder.reorder(tabs, 'a', 'a', 'after'), false);
  assert.equal(tabOrder.reorder(tabs, 'a', 'c', 'invalid'), false);
  assert.deepEqual(tabs.map(tab => tab.path), ['a', 'b', 'c']);
});
