'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { organizeCacheGroups } = require('../src/projects');

test('cache modules are grouped by project identity instead of language', () => {
  const cache = organizeCacheGroups([
    {
      language: 'python',
      label: 'Python',
      modules: [
        {
          kind: 'project-dependency', workspace_id: 'workspace-a', project_name: 'Full stack app',
          runtime_id: 'python:3.11', digest: 'python-lock', path: 'project-dependencies/a/python',
          size_bytes: 300, files: 3, last_used: 100
        },
        {
          kind: 'project-dependency', workspace_id: 'workspace-b', project_name: 'Active worker',
          runtime_id: 'python:3.12', digest: 'active-lock', path: 'project-dependencies/b/python',
          size_bytes: 400, files: 4, last_used: 80, active: true
        },
        {
          kind: 'project-dependency', workspace_id: 'workspace-c', project_name: 'Updating worker',
          runtime_id: 'python:3.13', digest: 'writing-lock', path: 'project-dependencies/c/python',
          size_bytes: 150, files: 2, last_used: 70, active: true, writing: true
        },
        { kind: 'legacy-cache', name: 'pip-cache', path: 'pip-cache', size_bytes: 50, files: 2 }
      ]
    },
    {
      language: 'node',
      label: 'Node.js',
      modules: [
        {
          kind: 'project-dependency', workspace_id: 'workspace-a', project_name: 'Full stack app',
          runtime_id: 'node:22', digest: 'node-lock', path: 'project-dependencies/a/node',
          size_bytes: 200, files: 5, last_used: 120
        },
        { name: 'Analysis dependencies', path: 'analysis-dependencies', size_bytes: 25, files: 1 }
      ]
    }
  ]);

  assert.equal(cache.projects.length, 3);
  assert.equal(cache.projects[0].workspaceID, 'workspace-c', 'a writing project is shown before read-only activity');
  assert.equal(cache.projects[1].workspaceID, 'workspace-b', 'the analysis-active project is shown before idle projects');
  assert.equal(cache.projects[2].workspaceID, 'workspace-a');
  assert.deepEqual(cache.projects[2].entries.map((entry) => entry.language), ['node', 'python']);
  assert.equal(cache.projects[2].sizeBytes, 500);
  assert.equal(cache.projects[0].writingCount, 1);
  assert.equal(cache.projects[1].analysisCount, 1);
  assert.equal(cache.snapshotCount, 4);
  assert.equal(cache.activeCount, 2);
  assert.equal(cache.writingCount, 1);
  assert.equal(cache.analysisCount, 1);
  assert.equal(cache.shared.length, 2);
  assert.equal(cache.totalBytes, 1125);
});

test('unattributed project caches remain independently manageable', () => {
  const cache = organizeCacheGroups([{
    language: 'rust',
    label: 'Rust',
    modules: [{
      kind: 'project-dependency', name: 'Unattributed project cache', path: 'project-dependencies/orphan',
      size_bytes: 10, orphaned: true
    }]
  }]);

  assert.equal(cache.projects.length, 1);
  assert.equal(cache.projects[0].orphaned, true);
  assert.equal(cache.projects[0].entries[0].path, 'project-dependencies/orphan');
  assert.equal(cache.shared.length, 0);
});
