'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

async function loadBundledProtocol(minify) {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['renderer/core/plugin-extension-protocol.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    minify,
    legalComments: 'none',
    write: false,
    logLevel: 'silent'
  });
  const module = { exports: {} };
  const context = { module, exports: module.exports };
  vm.runInNewContext(build.outputFiles[0].text, context, {
    filename: minify ? 'plugin-extension-protocol.min.cjs' : 'plugin-extension-protocol.cjs'
  });
  return module.exports;
}

function verifyStandaloneCloner(protocol) {
  const factorySource = protocol.createExtensionDataCloner.toString();
  const clone = vm.runInNewContext('(' + factorySource + ')()', Object.create(null));

  const shared = Object.create(null);
  shared.value = 'shared';
  const source = { first: shared, second: shared };
  const cloned = clone(source);
  assert.deepEqual(JSON.parse(JSON.stringify(cloned)), {
    first: { value: 'shared' },
    second: { value: 'shared' }
  });
  assert.equal(Object.getPrototypeOf(cloned), null);
  assert.equal(Object.getPrototypeOf(cloned.first), null);
  assert.notEqual(cloned.first, cloned.second);

  const sparse = [];
  sparse.length = 3;
  sparse[1] = 'present';
  const sparseClone = clone(sparse);
  assert.equal(sparseClone.length, 3);
  assert.equal(0 in sparseClone, false);
  assert.equal(sparseClone[1], 'present');

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => clone(cyclic), /circular data/);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => clone(value), /non-finite number/);
  }
  for (const value of [() => null, 1n]) {
    assert.throws(() => clone(value), /data only/);
  }

  let accessorReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'hidden', {
    get() {
      accessorReads += 1;
      return 'secret';
    }
  });
  assert.throws(() => clone(accessor), /accessors/);
  assert.equal(accessorReads, 0);

  assert.throws(
    () => clone({ nested: { value: true } }, { maxDepth: 1 }),
    /maximum depth/
  );
  assert.throws(
    () => clone(['one', 'two'], { maxItems: 1 }),
    /too many items/
  );
}

test('extension data cloner remains self-contained in development and production bundles', async () => {
  for (const minify of [false, true]) {
    const protocol = await loadBundledProtocol(minify);
    verifyStandaloneCloner(protocol);
  }
});
