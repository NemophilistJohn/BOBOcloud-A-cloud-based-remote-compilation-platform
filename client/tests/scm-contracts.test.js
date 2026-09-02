'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');
const { SCM_GIT_METHODS } = require('../main/scm-git');

const ROOT = path.resolve(__dirname, '..');
let scm;

test.before(async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: {
      contents: [
        "export * from './renderer/core/scm-file-decoration.ts';",
        "export * from './renderer/core/scm-git.ts';"
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'scm-contract-test-entry.ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', build.outputFiles[0].text)(module, module.exports, require);
  scm = module.exports;
});

test('SCM decoration updates remain ordered and linear at the contract maximum', () => {
  const provider = scm.createScmFileDecorationProvider({
    id: 'acme.scm.decorations',
    namespace: 'acme.scm'
  });
  const initial = Array.from({ length: 4096 }, (_, index) => ({
    path: 'src/file-' + index + '.ts',
    status: 'modified'
  }));
  const notifications = [];
  provider.onDidChange(paths => notifications.push(paths));
  assert.equal(provider.set(initial).entryCount, 4096);
  const replacement = initial.slice(1).map(entry => ({ ...entry }));
  replacement.push({ path: 'src/new.ts', status: 'added' });
  const result = provider.set(replacement);
  assert.deepEqual(result.changedPaths, ['src/file-0.ts', 'src/new.ts']);
  assert.equal(result.entryCount, 4096);
  assert.equal(notifications.length, 2);
  provider.set(replacement);
  assert.equal(notifications.length, 2, 'equal snapshots must not emit');
  provider.dispose();
  assert.deepEqual(provider.clear(), { clearedPaths: [], entryCount: 0 });
});

test('SCM boundary rejects accessors without invoking them', () => {
  let reads = 0;
  const decoration = {};
  Object.defineProperty(decoration, 'path', {
    enumerable: true,
    get() { reads += 1; return 'src/main.ts'; }
  });
  Object.defineProperty(decoration, 'status', { enumerable: true, value: 'modified' });
  assert.throws(() => scm.normalizeScmDecorationEntries([decoration]), /accessors/);
  assert.equal(reads, 0);

  const args = { repositoryId: 'scm-1234567890abcdef' };
  Object.defineProperty(args, 'limit', {
    enumerable: true,
    get() { reads += 1; return 20; }
  });
  assert.throws(() => scm.normalizeScmGitRequest({ operation: 'status', args }), /accessors/);
  assert.equal(reads, 0);
  assert.throws(() => scm.normalizeScmDecorationEntries([new Date()]), /plain object/);
});

test('renderer SCM permissions stay in lockstep with the main broker', () => {
  const rendererMethods = Object.fromEntries(
    Object.values(scm.ScmGitOperation).map((operation) => [
      'scm.git.' + operation,
      scm.scmGitPermissionForOperation(operation)
    ])
  );
  assert.deepEqual(rendererMethods, SCM_GIT_METHODS);
});

test('all SCM Git operations normalize to immutable, operation-specific DTOs', () => {
  const repositoryId = 'scm-1234567890abcdef';
  const registrations = Object.freeze({
    detect: { includeNested: true },
    status: { repositoryId, offset: 0, limit: 200 },
    history: { repositoryId, offset: 10_000, limit: 500, ref: 'main' },
    diff: { repositoryId, path: 'src/main.ts', ref: 'HEAD', staged: false },
    branches: { repositoryId },
    remotes: { repositoryId },
    clone: { url: 'https://github.com/example/repository.git', branch: 'main' },
    init: Object.create(null),
    setRemote: { repositoryId, name: null, url: 'git@github.com:example/repository.git' },
    stage: { repositoryId, paths: ['src/main.ts', 'README.md'] },
    stageAll: { repositoryId },
    unstage: { repositoryId, paths: ['src/main.ts'] },
    commit: { repositoryId, message: 'Keep the complete implementation' },
    checkout: { repositoryId, branch: 'feature/typed-scm', force: false },
    createBranch: { repositoryId, name: 'feature/next', checkout: true },
    deleteBranch: { repositoryId, name: 'feature/old', force: true },
    fetch: { repositoryId, remote: null },
    pull: { repositoryId, remote: 'upstream', branch: null },
    push: { repositoryId, remote: 'origin', branch: 'main', force: false, setUpstream: true }
  });

  assert.deepEqual(Object.keys(registrations), Object.values(scm.ScmGitOperation));
  for (const [operation, args] of Object.entries(registrations)) {
    const normalized = scm.normalizeScmGitRequest({ operation, args });
    assert.equal(normalized.operation, operation);
    assert.equal(normalized.permission, SCM_GIT_METHODS['scm.git.' + operation]);
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.args), true);
    assert.equal(Object.getPrototypeOf(normalized.args), null);
  }

  const setRemote = scm.normalizeScmGitRequest({ operation: 'setRemote', args: registrations.setRemote });
  assert.equal(setRemote.args.name, 'origin');
  const fetch = scm.normalizeScmGitRequest({ operation: 'fetch', args: registrations.fetch });
  assert.equal(fetch.args.remote, 'origin');
  const pull = scm.normalizeScmGitRequest({ operation: 'pull', args: registrations.pull });
  assert.equal(Object.hasOwn(pull.args, 'branch'), false);
  const stage = scm.normalizeScmGitRequest({ operation: 'stage', args: registrations.stage });
  assert.equal(Object.isFrozen(stage.args.paths), true);
});

test('SCM pagination and path collection boundaries are enforced', () => {
  const repositoryId = 'scm-1234567890abcdef';
  const paths = Array.from({ length: 256 }, (_, index) => 'src/file-' + index + '.ts');
  assert.equal(scm.normalizeScmGitRequest({
    operation: 'stage',
    args: { repositoryId, paths }
  }).args.paths.length, 256);
  assert.throws(() => scm.normalizeScmGitRequest({
    operation: 'stage',
    args: { repositoryId, paths: paths.concat('src/overflow.ts') }
  }), /between 1 and 256/);
  assert.throws(() => scm.normalizeScmGitRequest({
    operation: 'unstage',
    args: { repositoryId, paths: ['src/main.ts', './src/main.ts'] }
  }), /must not repeat/);
  assert.throws(() => scm.normalizeScmGitRequest({
    operation: 'status',
    args: { repositoryId, offset: 10_001 }
  }), /0 to 10000/);
  assert.throws(() => scm.normalizeScmGitRequest({
    operation: 'history',
    args: { repositoryId, limit: 0 }
  }), /1 to 500/);
});
