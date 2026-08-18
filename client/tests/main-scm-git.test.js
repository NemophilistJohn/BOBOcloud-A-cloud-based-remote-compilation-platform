'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SCM_GIT_METHODS, createScmGitBroker } = require('../main/scm-git');

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true });
}

async function createWorkspace(t, brokerOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-'));
  const hooksDirectory = path.join(root, '.broker-hooks');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { rootPath: root, workspaceIdentity: 1 };
  return {
    root,
    state,
    broker: createScmGitBroker({
      getWorkspaceIdentity: () => ({ ...state }),
      hooksDirectory,
      ...brokerOptions
    })
  };
}

test('local SCM Git broker keeps repository roots opaque and workspace-scoped', async (t) => {
  const { root, state, broker } = await createWorkspace(t);
  assert.deepEqual(
    broker.methods,
    {
      'scm.git.detect': 'scm.git.read',
      'scm.git.status': 'scm.git.read',
      'scm.git.history': 'scm.git.read',
      'scm.git.diff': 'scm.git.read',
      'scm.git.branches': 'scm.git.read',
      'scm.git.remotes': 'scm.git.read',
      'scm.git.clone': 'scm.git.write',
      'scm.git.init': 'scm.git.write',
      'scm.git.setRemote': 'scm.git.write',
      'scm.git.stage': 'scm.git.write',
      'scm.git.stageAll': 'scm.git.write',
      'scm.git.unstage': 'scm.git.write',
      'scm.git.commit': 'scm.git.write',
      'scm.git.checkout': 'scm.git.write',
      'scm.git.createBranch': 'scm.git.write',
      'scm.git.deleteBranch': 'scm.git.write',
      'scm.git.fetch': 'scm.git.write',
      'scm.git.pull': 'scm.git.write',
      'scm.git.push': 'scm.git.write'
    }
  );
  assert.deepEqual(broker.methods, SCM_GIT_METHODS);

  const initial = await broker.request('scm.git.detect', {});
  assert.deepEqual(initial.repositories, []);
  assert.deepEqual(await broker.request('scm.git.detect', { includeNested: false }), { repositories: [] });
  await assert.rejects(() => broker.request('scm.git.detect', { workspacePath: root }), { code: 'SCM_GIT_INVALID_ARGUMENT' });
  await assert.rejects(() => broker.request('scm.git.detect', null), { code: 'SCM_GIT_INVALID_ARGUMENT' });
  await assert.rejects(() => broker.request('scm.git.detect', false), { code: 'SCM_GIT_INVALID_ARGUMENT' });

  const repository = await broker.request('scm.git.init', {});
  assert.match(repository.repositoryId, /^scm-/);
  assert.equal(repository.relativeRoot, '');
  assert.equal(repository.isWorkspaceRoot, true);
  assert.equal(JSON.stringify(repository).includes(root), false);

  await fs.writeFile(path.join(root, 'README.md'), 'first line\n', 'utf8');
  const changed = await broker.request('scm.git.status', { repositoryId: repository.repositoryId });
  assert.equal(changed.relativeRoot, '');
  assert.equal(changed.changes.some((entry) => entry.path === 'README.md' && entry.kind === 'untracked'), true);
  assert.equal(JSON.stringify(changed).includes(root), false);

  // An unborn repository is valid: history is an empty page, and a first
  // publish flow can stage every local file without guessing their paths.
  const unbornHistory = await broker.request('scm.git.history', { repositoryId: repository.repositoryId, limit: 20 });
  assert.deepEqual(unbornHistory.commits, []);
  assert.equal(unbornHistory.hasMore, false);
  const initialBranch = await broker.request('scm.git.createBranch', {
    repositoryId: repository.repositoryId,
    name: 'main',
    checkout: true
  });
  assert.deepEqual(initialBranch, { repositoryId: repository.repositoryId, branch: 'main', checkedOut: true });
  await broker.request('scm.git.stageAll', { repositoryId: repository.repositoryId });
  await git(root, ['config', 'user.name', 'SCM Test']);
  await git(root, ['config', 'user.email', 'scm-test@example.invalid']);
  const committed = await broker.request('scm.git.commit', {
    repositoryId: repository.repositoryId,
    message: 'Initial local SCM test commit'
  });
  assert.match(committed.commit, /^[a-f0-9]{40}$/i);

  const history = await broker.request('scm.git.history', { repositoryId: repository.repositoryId, limit: 500, ref: 'HEAD' });
  assert.equal(history.commits.length, 1);
  assert.equal(history.commits[0].subject, 'Initial local SCM test commit');

  const branch = await broker.request('scm.git.createBranch', {
    repositoryId: repository.repositoryId,
    name: 'feature/local-scm',
    checkout: true
  });
  assert.deepEqual(branch, { repositoryId: repository.repositoryId, branch: 'feature/local-scm', checkedOut: true });
  const branches = await broker.request('scm.git.branches', { repositoryId: repository.repositoryId });
  assert.equal(branches.current, 'feature/local-scm');
  assert.equal(branches.local.some((entry) => entry.name === 'feature/local-scm'), true);

  await fs.writeFile(path.join(root, 'README.md'), 'first line\nsecond line\n', 'utf8');
  const diff = await broker.request('scm.git.diff', { repositoryId: repository.repositoryId, path: 'README.md', ref: 'HEAD' });
  assert.match(diff.content, /second line/);
  assert.equal(diff.content.includes(root), false);

  await broker.request('scm.git.setRemote', {
    repositoryId: repository.repositoryId,
    name: 'origin',
    url: 'https://github.com/example/local-scm.git'
  });
  await git(root, ['remote', 'add', 'sanitized', 'https://token-value@example.invalid/private.git']);
  await git(root, ['remote', 'add', 'local-file', 'file:///tmp/bobocloud-private-remote.git']);
  const remotes = await broker.request('scm.git.remotes', { repositoryId: repository.repositoryId });
  assert.equal(remotes.remotes.some((entry) => entry.name === 'origin'), true);
  assert.match(remotes.remotes.find((entry) => entry.name === 'sanitized').urls[0], /^https:\/\/\*\*\*@example\.invalid\//);
  const localFileRemote = remotes.remotes.find((entry) => entry.name === 'local-file');
  assert.deepEqual(localFileRemote.urls, []);
  assert.deepEqual(localFileRemote.fetchUrls, []);
  assert.equal(localFileRemote.hasUnsupportedUrls, true);
  assert.equal(JSON.stringify(localFileRemote).includes('/tmp/bobocloud-private-remote.git'), false);
  assert.equal(JSON.stringify(remotes).includes('token-value'), false);
  await assert.rejects(
    () => broker.request('scm.git.setRemote', { repositoryId: repository.repositoryId, name: 'unsafe', url: 'file:///tmp/not-allowed.git' }),
    { code: 'SCM_GIT_REMOTE_DENIED' }
  );
  await assert.rejects(
    () => broker.request('scm.git.status', { repositoryId: root }),
    { code: 'SCM_GIT_INVALID_ARGUMENT' }
  );

  state.workspaceIdentity += 1;
  await assert.rejects(
    () => broker.request('scm.git.status', { repositoryId: repository.repositoryId }),
    { code: 'SCM_GIT_STALE_REPOSITORY' }
  );
});

test('local SCM clone is workspace-bound, empty-directory-only, and returns stable failures', async (t) => {
  const sourceParent = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-clone-source-'));
  const hooksDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-clone-hooks-'));
  t.after(() => fs.rm(sourceParent, { recursive: true, force: true }));
  t.after(() => fs.rm(hooksDirectory, { recursive: true, force: true }));
  const source = path.join(sourceParent, 'source');
  const bare = path.join(sourceParent, 'source.git');
  await fs.mkdir(source);
  await git(source, ['init', '--quiet']);
  await git(source, ['config', 'user.name', 'SCM Test']);
  await git(source, ['config', 'user.email', 'scm-test@example.invalid']);
  await fs.writeFile(path.join(source, 'README.md'), 'clone source\n', 'utf8');
  await git(source, ['add', 'README.md']);
  await git(source, ['commit', '--quiet', '-m', 'clone source']);
  const branch = (await git(source, ['branch', '--show-current'])).stdout.trim();
  await git(source, ['clone', '--quiet', '--bare', '.', bare]);

  const remoteUrl = 'https://example.invalid/owner/repository.git';
  const observedCloneCalls = [];
  const { root, broker } = await createWorkspace(t, {
    hooksDirectory,
    execFile(file, args, options, callback) {
      if (args.includes('clone')) {
        observedCloneCalls.push([...args]);
        // The test transport replaces only the already-validated remote URL
        // after observing the broker command. The broker itself still emits
        // protocol.file.allow=never and never accepts the local source path.
        const rewritten = args.map((value) => value === remoteUrl ? bare : value === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : value);
        return execFile(file, rewritten, options, callback);
      }
      return execFile(file, args, options, callback);
    }
  });

  const repository = await broker.request('scm.git.clone', { url: remoteUrl, branch });
  assert.match(repository.repositoryId, /^scm-/);
  assert.equal(repository.relativeRoot, '');
  assert.equal((await fs.stat(path.join(root, '.git'))).isDirectory(), true);
  assert.equal(observedCloneCalls.length, 1);
  assert.equal(observedCloneCalls[0].includes(remoteUrl), true);
  assert.equal(observedCloneCalls[0].includes(bare), false);
  assert.equal(observedCloneCalls[0].includes('protocol.file.allow=never'), true);
  assert.equal(observedCloneCalls[0].at(-1), '.');

  await assert.rejects(
    () => broker.request('scm.git.clone', { url: remoteUrl, target: '../outside' }),
    { code: 'SCM_GIT_INVALID_ARGUMENT' }
  );

  const nonEmpty = await createWorkspace(t);
  await fs.writeFile(path.join(nonEmpty.root, 'keep.md'), 'do not replace\n', 'utf8');
  const protectedHooksDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-protected-hooks-'));
  t.after(() => fs.rm(protectedHooksDirectory, { recursive: true, force: true }));
  let nonEmptyExecCalls = 0;
  const protectedBroker = createScmGitBroker({
    getWorkspaceIdentity: () => ({ ...nonEmpty.state }),
    hooksDirectory: protectedHooksDirectory,
    execFile(...args) {
      nonEmptyExecCalls += 1;
      return execFile(...args);
    }
  });
  await assert.rejects(
    () => protectedBroker.request('scm.git.clone', { url: remoteUrl }),
    { code: 'SCM_GIT_WORKSPACE_NOT_EMPTY' }
  );
  assert.equal(nonEmptyExecCalls, 0, 'a non-empty workspace must fail before Git launches');

  await assert.rejects(
    () => broker.request('scm.git.clone', { url: 'file:///tmp/not-allowed.git' }),
    { code: 'SCM_GIT_REMOTE_DENIED' }
  );
  await assert.rejects(
    () => broker.request('scm.git.clone', { url: 'file:relative-repository.git' }),
    { code: 'SCM_GIT_REMOTE_DENIED' }
  );
  await assert.rejects(
    () => broker.request('scm.git.clone', { url: 'C:/local-repository.git' }),
    { code: 'SCM_GIT_REMOTE_DENIED' }
  );

  const failedWorkspace = await createWorkspace(t, { hooksDirectory });
  const failedBroker = createScmGitBroker({
    getWorkspaceIdentity: () => ({ ...failedWorkspace.state }),
    hooksDirectory,
    execFile(_file, _args, _options, callback) {
      const error = new Error('clone failed');
      queueMicrotask(() => callback(error, '', 'fatal: repository not found'));
      return null;
    }
  });
  await assert.rejects(
    () => failedBroker.request('scm.git.clone', { url: remoteUrl }),
    { code: 'SCM_GIT_CLONE_FAILED' }
  );
});

test('local SCM reports missing Git and paginates status and history snapshots', async (t) => {
  const unavailable = await createWorkspace(t, { gitExecutable: 'bobocloud-git-does-not-exist' });
  await assert.rejects(() => unavailable.broker.request('scm.git.detect', {}), { code: 'SCM_GIT_UNAVAILABLE' });

  const { root, broker } = await createWorkspace(t);
  const repository = await broker.request('scm.git.init', {});
  await git(root, ['config', 'user.name', 'SCM Test']);
  await git(root, ['config', 'user.email', 'scm-test@example.invalid']);
  for (let index = 0; index < 5; index += 1) {
    const fileName = 'commit-' + index + '.txt';
    await fs.writeFile(path.join(root, fileName), 'commit ' + index + '\n', 'utf8');
    await git(root, ['add', fileName]);
    await git(root, ['commit', '--quiet', '-m', 'commit ' + index]);
  }
  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(path.join(root, 'change-' + index + '.txt'), 'change ' + index + '\n', 'utf8');
  }

  const firstStatus = await broker.request('scm.git.status', {
    repositoryId: repository.repositoryId,
    offset: 1,
    limit: 2
  });
  assert.equal(firstStatus.changes.length, 2);
  assert.equal(firstStatus.offset, 1);
  assert.equal(firstStatus.limit, 2);
  assert.equal(firstStatus.total, 5);
  assert.equal(firstStatus.hasMore, true);
  assert.equal(firstStatus.nextOffset, 3);
  const finalStatus = await broker.request('scm.git.status', {
    repositoryId: repository.repositoryId,
    offset: firstStatus.nextOffset,
    limit: 2
  });
  assert.equal(finalStatus.changes.length, 2);
  assert.equal(finalStatus.hasMore, false);
  assert.equal(finalStatus.nextOffset, null);

  const firstHistory = await broker.request('scm.git.history', {
    repositoryId: repository.repositoryId,
    offset: 1,
    limit: 2
  });
  assert.equal(firstHistory.commits.length, 2);
  assert.equal(firstHistory.offset, 1);
  assert.equal(firstHistory.limit, 2);
  assert.equal(firstHistory.hasMore, true);
  assert.equal(firstHistory.nextOffset, 3);
  const finalHistory = await broker.request('scm.git.history', {
    repositoryId: repository.repositoryId,
    offset: 4,
    limit: 2
  });
  assert.equal(finalHistory.commits.length, 1);
  assert.equal(finalHistory.hasMore, false);
  assert.equal(finalHistory.nextOffset, null);

  await assert.rejects(
    () => broker.request('scm.git.status', { repositoryId: repository.repositoryId, offset: -1 }),
    { code: 'SCM_GIT_INVALID_ARGUMENT' }
  );
  await assert.rejects(
    () => broker.request('scm.git.history', { repositoryId: repository.repositoryId, offset: 10_001 }),
    { code: 'SCM_GIT_INVALID_ARGUMENT' }
  );
});

test('local SCM status attaches bounded staged and working-tree diff stats', async (t) => {
  const { root, broker } = await createWorkspace(t);
  const repository = await broker.request('scm.git.init', {});
  await git(root, ['config', 'user.name', 'SCM Test']);
  await git(root, ['config', 'user.email', 'scm-test@example.invalid']);
  await fs.writeFile(path.join(root, 'main.py'), 'one\ntwo\n', 'utf8');
  await fs.writeFile(path.join(root, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
  await broker.request('scm.git.stage', { repositoryId: repository.repositoryId, paths: ['main.py', 'asset.bin'] });
  await broker.request('scm.git.commit', { repositoryId: repository.repositoryId, message: 'initial content' });

  await fs.writeFile(path.join(root, 'main.py'), 'one\nthree\nfour\n', 'utf8');
  await fs.writeFile(path.join(root, 'asset.bin'), Buffer.from([0, 1, 4, 3]));
  await fs.writeFile(path.join(root, 'new.py'), 'untracked\n', 'utf8');
  const working = await broker.request('scm.git.status', { repositoryId: repository.repositoryId, limit: 10 });
  const workingCode = working.changes.find((entry) => entry.path === 'main.py');
  const binary = working.changes.find((entry) => entry.path === 'asset.bin');
  const untracked = working.changes.find((entry) => entry.path === 'new.py');
  assert.deepEqual(workingCode.indexStats, null);
  assert.deepEqual(workingCode.workingTreeStats, { additions: 2, deletions: 1 });
  assert.equal(binary.workingTreeStats, null, 'binary numstat must remain unknown');
  assert.equal(untracked.indexStats, null);
  assert.equal(untracked.workingTreeStats, null);

  const staged = await broker.request('scm.git.stage', { repositoryId: repository.repositoryId, paths: ['main.py'] });
  const stagedCode = staged.changes.find((entry) => entry.path === 'main.py');
  assert.deepEqual(stagedCode.indexStats, { additions: 2, deletions: 1 });
  assert.equal(stagedCode.workingTreeStats, null);

  await fs.writeFile(path.join(root, 'main.py'), 'one\nthree\nfour\nfive\n', 'utf8');
  const mixed = await broker.request('scm.git.status', { repositoryId: repository.repositoryId, limit: 10 });
  const mixedCode = mixed.changes.find((entry) => entry.path === 'main.py');
  assert.deepEqual(mixedCode.indexStats, { additions: 2, deletions: 1 });
  assert.deepEqual(mixedCode.workingTreeStats, { additions: 1, deletions: 0 });
});

test('local SCM deletes only an inactive local branch', async (t) => {
  const { root, broker } = await createWorkspace(t);
  const repository = await broker.request('scm.git.init', {});
  await fs.writeFile(path.join(root, 'README.md'), 'branch test\n', 'utf8');
  await broker.request('scm.git.stage', { repositoryId: repository.repositoryId, paths: ['README.md'] });
  await git(root, ['config', 'user.name', 'SCM Test']);
  await git(root, ['config', 'user.email', 'scm-test@example.invalid']);
  await broker.request('scm.git.commit', { repositoryId: repository.repositoryId, message: 'branch test' });

  const activeBranch = (await broker.request('scm.git.branches', { repositoryId: repository.repositoryId })).current;
  await broker.request('scm.git.createBranch', { repositoryId: repository.repositoryId, name: 'remove-me' });
  assert.deepEqual(
    await broker.request('scm.git.deleteBranch', { repositoryId: repository.repositoryId, name: 'remove-me' }),
    { repositoryId: repository.repositoryId, branch: 'remove-me', deleted: true }
  );
  const branches = await broker.request('scm.git.branches', { repositoryId: repository.repositoryId });
  assert.equal(branches.local.some((entry) => entry.name === 'remove-me'), false);
  await assert.rejects(
    () => broker.request('scm.git.deleteBranch', { repositoryId: repository.repositoryId, name: activeBranch, force: true }),
    { code: 'SCM_GIT_BRANCH_CHECKED_OUT' }
  );
});

test('queued mutations are rejected before old-workspace work can begin', async (t) => {
  let addCalls = 0;
  let notifyFirstAdd;
  let releaseFirstAdd;
  const firstAddStarted = new Promise((resolve) => { notifyFirstAdd = resolve; });
  const releaseFirstAddPromise = new Promise((resolve) => { releaseFirstAdd = resolve; });
  const { root, state, broker } = await createWorkspace(t, {
    execFile(file, args, options, callback) {
      if (!args.includes('add')) return execFile(file, args, options, callback);
      addCalls += 1;
      return execFile(file, args, options, (error, stdout, stderr) => {
        if (addCalls !== 1) {
          callback(error, stdout, stderr);
          return;
        }
        notifyFirstAdd();
        releaseFirstAddPromise.then(() => callback(error, stdout, stderr));
      });
    }
  });
  const repository = await broker.request('scm.git.init', {});
  await fs.writeFile(path.join(root, 'first.md'), 'first\n', 'utf8');
  await fs.writeFile(path.join(root, 'second.md'), 'second\n', 'utf8');

  const first = broker.request('scm.git.stage', {
    repositoryId: repository.repositoryId,
    paths: ['first.md']
  });
  const firstFailure = assert.rejects(first, { code: 'SCM_GIT_STALE_REPOSITORY' });
  await firstAddStarted;
  const queuedSecond = broker.request('scm.git.stage', {
    repositoryId: repository.repositoryId,
    paths: ['second.md']
  });
  const queuedSecondFailure = assert.rejects(queuedSecond, { code: 'SCM_GIT_STALE_REPOSITORY' });

  state.workspaceIdentity += 1;
  releaseFirstAdd();
  await firstFailure;
  await queuedSecondFailure;
  assert.equal(addCalls, 1, 'the queued mutation must not invoke git add after the workspace changes');

  const status = (await git(root, ['status', '--porcelain'])).stdout;
  assert.match(status, /^\?\? second\.md$/m);
});

test('local SCM refuses worktrees whose Git directory escapes the active workspace', async (t) => {
  const { root, broker } = await createWorkspace(t);
  const sourceParent = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-source-'));
  t.after(() => fs.rm(sourceParent, { recursive: true, force: true }));
  const source = path.join(sourceParent, 'source-repository');
  const linkedWorktree = path.join(root, 'linked-worktree');
  await fs.mkdir(source);
  await git(source, ['init', '--quiet']);
  await git(source, ['config', 'user.name', 'SCM Test']);
  await git(source, ['config', 'user.email', 'scm-test@example.invalid']);
  await fs.writeFile(path.join(source, 'README.md'), 'source\n', 'utf8');
  await git(source, ['add', 'README.md']);
  await git(source, ['commit', '--quiet', '-m', 'source commit']);
  await git(source, ['worktree', 'add', '--quiet', '--detach', linkedWorktree]);

  const discovered = await broker.request('scm.git.detect', { includeNested: true });
  assert.deepEqual(discovered, { repositories: [] });
});

test('SCM Git child processes scrub inherited Git command and config overrides', async (t) => {
  const injected = {
    GIT_SSH_COMMAND: 'not-a-real-ssh-command',
    GIT_SSH: 'not-a-real-ssh-command',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: 'not-a-real-ssh-command',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EXEC_PATH: path.join(os.tmpdir(), 'not-a-real-git-exec-path'),
    GIT_PROXY_COMMAND: 'not-a-real-proxy-command',
    GIT_EXTERNAL_DIFF: 'not-a-real-diff-command',
    GIT_ASKPASS: 'not-a-real-askpass-command',
    SSH_ASKPASS: 'not-a-real-askpass-command',
    SSH_ASKPASS_REQUIRE: 'force',
    GCM_TRACE: '1',
    SSH_AUTH_SOCK: 'preserved-test-agent.sock'
  };
  const previous = new Map(Object.keys(injected).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(injected)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const environments = [];
  const { broker } = await createWorkspace(t, {
    execFile(file, args, options, callback) {
      environments.push(options.env);
      return execFile(file, args, options, callback);
    }
  });
  await broker.request('scm.git.init', {});
  assert.ok(environments.length > 0);
  for (const environment of environments) {
    for (const key of Object.keys(injected)) {
      if (key !== 'SSH_AUTH_SOCK') assert.equal(environment[key], undefined, key + ' must not reach Git');
    }
    assert.equal(environment.SSH_AUTH_SOCK, injected.SSH_AUTH_SOCK);
    assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
    assert.equal(environment.GCM_INTERACTIVE, 'Never');
  }
});

test('secure hooks setup failure prevents any Git process from launching', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-hooks-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const blockedHooksDirectory = path.join(root, 'blocked-hooks');
  await fs.writeFile(blockedHooksDirectory, 'not a directory', 'utf8');
  let execCalls = 0;
  const state = { rootPath: root, workspaceIdentity: 1 };
  const broker = createScmGitBroker({
    getWorkspaceIdentity: () => ({ ...state }),
    hooksDirectory: blockedHooksDirectory,
    execFile(...args) {
      execCalls += 1;
      return execFile(...args);
    }
  });

  await assert.rejects(() => broker.request('scm.git.detect', {}), { code: 'SCM_GIT_HOOKS_UNAVAILABLE' });
  assert.equal(execCalls, 0);
});

test('init does not launch Git when the workspace changes during hooks preparation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { rootPath: root, workspaceIdentity: 1 };
  const hooksDirectory = path.join(root, 'deferred-hooks');
  let notifyHooksRequested;
  let releaseHooksDirectory;
  const hooksRequested = new Promise((resolve) => { notifyHooksRequested = resolve; });
  const hooksDirectoryReady = new Promise((resolve) => { releaseHooksDirectory = resolve; });
  let execCalls = 0;
  const broker = createScmGitBroker({
    getWorkspaceIdentity: () => ({ ...state }),
    getHooksDirectory() {
      notifyHooksRequested();
      return hooksDirectoryReady;
    },
    execFile(...args) {
      execCalls += 1;
      return execFile(...args);
    }
  });

  const initialize = broker.request('scm.git.init', {});
  await hooksRequested;
  state.workspaceIdentity += 1;
  releaseHooksDirectory(hooksDirectory);

  await assert.rejects(initialize, { code: 'SCM_GIT_STALE_REPOSITORY' });
  assert.equal(execCalls, 0, 'no Git child process may start after a deferred hooks setup observes a new workspace');
});

test('pre-launch scope validation detects a workspace switch during root canonicalization', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bobocloud-scm-git-scope-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hooksDirectory = path.join(root, 'deferred-hooks');
  let notifyHooksRequested;
  let releaseHooksDirectory;
  const hooksRequested = new Promise((resolve) => { notifyHooksRequested = resolve; });
  const hooksDirectoryReady = new Promise((resolve) => { releaseHooksDirectory = resolve; });
  let validateScope = false;
  let validationReads = 0;
  let execCalls = 0;
  const broker = createScmGitBroker({
    getWorkspaceIdentity() {
      if (!validateScope) return { rootPath: root, workspaceIdentity: 1 };
      validationReads += 1;
      return { rootPath: root, workspaceIdentity: validationReads === 1 ? 1 : 2 };
    },
    getHooksDirectory() {
      notifyHooksRequested();
      return hooksDirectoryReady;
    },
    execFile(...args) {
      execCalls += 1;
      return execFile(...args);
    }
  });

  const initialize = broker.request('scm.git.init', {});
  await hooksRequested;
  validateScope = true;
  releaseHooksDirectory(hooksDirectory);

  await assert.rejects(initialize, { code: 'SCM_GIT_STALE_REPOSITORY' });
  assert.equal(execCalls, 0, 'Git must not start when the identity changes while the pre-launch check resolves the root');
});
