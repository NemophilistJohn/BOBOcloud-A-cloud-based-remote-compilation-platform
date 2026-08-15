'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadMatcher() {
  const setCalls = [];
  const model = { uri: { fsPath: 'E:\\workspace\\src\\main.c' } };
  const window = {
    BOBO: { state: { workspaceRoot: 'E:\\workspace' } },
    monaco: {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      editor: {
        getModels: () => [model],
        setModelMarkers: (_model, owner, markers) => setCalls.push({ owner, markers })
      }
    },
    document: { getElementById: () => null },
    setTimeout,
    clearTimeout
  };
  window.window = window;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/task-problem-matcher.js'), 'utf8'), { window, Set, Map, Array, String, Number, RegExp, Object, JSON, Math, console });
  return { matcher: window.BOBO.taskProblemMatcher, setCalls };
}

test('GCC task output becomes a workspace-scoped error marker', () => {
  const { matcher, setCalls } = loadMatcher();
  const session = matcher.begin({ problemMatcher: '$gcc' });
  session.consume('src/main.c:12:5: error: expected semicolon', 'task:build:task-step-1');
  const problems = matcher.getProblems();
  assert.equal(problems.length, 1);
  assert.deepEqual({ path: problems[0].path, line: problems[0].line, column: problems[0].column, severity: problems[0].severity }, {
    path: 'E:/workspace/src/main.c', line: 12, column: 5, severity: 'error'
  });
  assert.equal(problems[0].message, 'expected semicolon');
  assert.equal(setCalls.at(-1).owner, 'task-problem-matcher');
  assert.equal(setCalls.at(-1).markers[0].startLineNumber, 12);
});

test('matcher ignores setup output and rejects paths outside the workspace', () => {
  const { matcher } = loadMatcher();
  const session = matcher.begin({ problemMatcher: '$gcc' });
  session.consume('src/main.c:2:1: error: not from task', 'setup');
  session.consume('../../etc/passwd:2:1: error: outside', 'task:build:task-step-1');
  assert.deepEqual(matcher.getProblems(), []);
});

test('multi-line rust matcher emits the source location after an error header', () => {
  const { matcher } = loadMatcher();
  const session = matcher.begin({ problemMatcher: '$rustc' });
  session.consume('error[E0308]: mismatched types', 'task:build:task-step-1');
  session.consume('  --> src/main.rs:7:9', 'task:build:task-step-1');
  const problem = matcher.getProblems()[0];
  assert.equal(problem.relativePath, 'src/main.rs');
  assert.equal(problem.line, 7);
  assert.equal(problem.code, 'E0308');
  assert.equal(problem.message, 'mismatched types');
});
