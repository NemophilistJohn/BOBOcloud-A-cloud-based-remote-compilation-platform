'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.join(__dirname, 'prepare-clangd-cdb.js');

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-clangd-cdb-'));
  const workspace = path.join(root, 'workspace');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    run({ workspace, cache });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function prepare(workspace, cache, flags = []) {
  const flagsPath = path.join(cache, 'fallback-flags');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(flagsPath, flags.length > 0 ? `${flags.join('\n')}\n` : '');
  const result = spawnSync(process.execPath, [script, workspace, cache, flagsPath], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const directory = result.stdout.trim();
  assert.equal(directory, path.join(cache, 'cdb'));
  return JSON.parse(fs.readFileSync(path.join(cache, 'cdb', 'compile_commands.json'), 'utf8'));
}

test('generates a conservative compile database when the project has none', () => {
  withFixture(({ workspace, cache }) => {
    const source = path.join(workspace, 'src', 'main.c');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'int main(void) { return 0; }\n');

    const database = prepare(workspace, cache);
    assert.equal(database.length, 1);
    assert.equal(database[0].directory, '/workspace');
    assert.equal(database[0].file, '/workspace/src/main.c');
    assert.deepEqual(database[0].arguments, [
      'clang', '-std=gnu17', '-I/workspace', '-c', '/workspace/src/main.c'
    ]);
  });
});

test('normalizes a relocated project compile database to the analyzer workspace', () => {
  withFixture(({ workspace, cache }) => {
    const source = path.join(workspace, 'src', 'main.cpp');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'int main() { return 0; }\n');
    fs.writeFileSync(path.join(workspace, 'compile_commands.json'), JSON.stringify([{
      directory: '/old/project/build',
      file: '/old/project/src/main.cpp',
      arguments: ['clang++', '-I/old/project/include', '-c', '/old/project/src/main.cpp']
    }]));

    const database = prepare(workspace, cache);
    assert.equal(database.length, 1);
    assert.equal(database[0].directory, '/workspace/build');
    assert.equal(database[0].file, '/workspace/src/main.cpp');
    assert.deepEqual(database[0].arguments, [
      'clang++', '-I/workspace/include', '-c', '/workspace/src/main.cpp'
    ]);
  });
});

test('injects validated dependency flags into generated and normalized argument arrays', () => {
  withFixture(({ workspace, cache }) => {
    const source = path.join(workspace, 'src', 'main.c');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'int main(void) { return 0; }\n');
    const flags = ['--sysroot=/analysis-deps/native/sysroot', '-I/analysis-deps/native/include'];

    const generated = prepare(workspace, cache, flags);
    assert.deepEqual(generated[0].arguments.slice(0, 3), ['clang', ...flags]);

    fs.writeFileSync(path.join(workspace, 'compile_commands.json'), JSON.stringify([{
      directory: '/old/project',
      file: '/old/project/src/main.c',
      arguments: ['clang', '-std=gnu17', '-c', '/old/project/src/main.c']
    }]));
    const normalized = prepare(workspace, cache, flags);
    assert.deepEqual(normalized[0].arguments.slice(0, 3), ['clang', ...flags]);
    assert.equal(normalized[0].arguments.filter((value) => value === flags[0]).length, 1);
  });
});
