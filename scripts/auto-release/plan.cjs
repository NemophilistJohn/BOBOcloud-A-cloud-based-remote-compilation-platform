'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');

const MARKER = /<!-- bobocloud-auto-release:([0-9a-f]{40}) -->/;
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^auto-v[0-9A-Za-z.-]+$/;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
}
function isAncestor(base, head) {
  return spawnSync('git', ['merge-base', '--is-ancestor', base, head], { windowsHide: true }).status === 0;
}
function tagCommit(tag) {
  if (typeof tag !== 'string' || !tag || tag.startsWith('-') || tag.includes('..') || /[\s~^:?*\\[\]\\]/.test(tag)) throw new Error('Invalid release tag');
  const value = git('rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}');
  if (!SHA.test(value)) throw new Error('Invalid release commit');
  return value;
}
function componentChanges(paths) {
  const result = { client: false, server: false };
  for (const name of paths) {
    const path = name.replace(/\\/g, '/');
    if (/\.md$/i.test(path) || /(?:^|\/)(?:tests?|test-results|__tests__)(?:\/|$)/i.test(path) || /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|\.test\.ps1|(?:^|\/)test_[^/]+\.py|(?:^|\/)test-[^/]+\.ps1)$/i.test(path)) continue;
    if (path.startsWith('client/')) result.client = true;
    if (path.startsWith('server/')) result.server = true;
  }
  return result;
}
function chooseBaseline(releases, head, latestStable) {
  const candidates = [];
  for (const release of releases) {
    if (release.draft || !RELEASE_TAG.test(release.tag_name || '')) continue;
    const match = String(release.body || '').match(MARKER);
    if (!match) throw new Error('An automatic release is missing its source marker: ' + release.tag_name);
    const commit = tagCommit(release.tag_name);
    if (commit !== match[1]) throw new Error('Automatic release tag and source marker disagree');
    if (isAncestor(commit, head)) candidates.push({ commit, distance: Number(git('rev-list', '--count', commit + '..' + head)) });
  }
  if (candidates.length) return candidates.sort((a, b) => a.distance - b.distance)[0].commit;
  if (!latestStable || latestStable.draft || latestStable.prerelease) throw new Error('No published stable release exists to use as the initial baseline');
  const baseline = tagCommit(latestStable.tag_name);
  if (!isAncestor(baseline, head)) throw new Error('The initial stable release is not an ancestor of main; configure a valid baseline before publishing');
  return baseline;
}
function changedSince(base, head) {
  const output = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], { windowsHide: true });
  return componentChanges(output.toString('utf8').split('\0').filter(Boolean));
}
function shouldRelease(head, baseline, changes, force) {
  return head !== baseline && (force || (changes.client && changes.server));
}
function ghApi(endpoint, paginate = false) {
  const args = ['api'];
  if (paginate) args.push('--paginate', '--slurp');
  args.push(endpoint);
  const parsed = JSON.parse(execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
  return paginate ? parsed.flat() : parsed;
}
function calculate() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository');
  const head = git('rev-parse', 'HEAD');
  if (!SHA.test(head)) throw new Error('Invalid checkout commit');
  const main = ghApi('repos/' + repo + '/git/ref/heads/main').object.sha;
  if (head !== main) throw new Error('Checkout is no longer the current main commit');
  const runs = ghApi('repos/' + repo + '/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100').workflow_runs;
  const verified = runs.some((run) => run.head_sha === head && run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success');
  if (!verified) return { eligible: false, reason: 'The current main commit does not have a successful push CI run', head };
  const releases = ghApi('repos/' + repo + '/releases?per_page=100', true);
  const managed = releases.filter((r) => !r.draft && RELEASE_TAG.test(r.tag_name || ''));
  let latestStable = null;
  if (!managed.length) latestStable = ghApi('repos/' + repo + '/releases/latest');
  const baseline = chooseBaseline(releases, head, latestStable);
  const changes = changedSince(baseline, head);
  const force = process.env.RELEASE_FORCE === 'true';
  return { eligible: shouldRelease(head, baseline, changes, force), reason: 'Changes since last release', head, baseline, ...changes };
}
function main() {
  const result = process.env.RELEASE_PREVIEW === 'true'
    ? { eligible: true, reason: 'Read-only pull request build', head: git('rev-parse', 'HEAD'), baseline: '' }
    : calculate();
  if (process.argv[2] === '--verify') {
    if (!result.eligible || result.head !== process.argv[3] || result.baseline !== process.argv[4]) throw new Error('Release inputs changed while building; do not publish stale assets');
    console.log('Release inputs still match the successful CI and published baseline');
    return;
  }
  const base = JSON.parse(fs.readFileSync('client/package.json', 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error('Client version must be a stable numeric SemVer');
  const run = process.env.GITHUB_RUN_ID || '';
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '';
  if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error('Invalid workflow run identity');
  const version = base + '-ci.' + run + '.' + attempt;
  const values = { ...result, appVersion: base, version, tag: 'auto-v' + version };
  console.log(JSON.stringify(values));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => key + '=' + String(value)).join('\n') + '\n');
}
if (require.main === module) {
  try { main(); } catch (error) { console.error('[release-plan]', error.message); process.exitCode = 1; }
}
module.exports = { MARKER, componentChanges, chooseBaseline, changedSince, shouldRelease };
