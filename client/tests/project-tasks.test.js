'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  loadTaskConfiguration,
  resolveTaskExecution,
  substituteString
} = require('../main/tasks');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-tasks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

test('JSONC configurations merge deeply and BOBO labels override VS Code with an explicit conflict', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', `{
    // comments and trailing commas are valid JSONC
    "version": "2.0.0",
    "options": { "env": { "GLOBAL": "yes" }, "shell": { "executable": "bash" } },
    "tasks": [
      { "label": "Build", "type": "shell", "command": "echo vscode", "options": { "env": { "LOCAL": "one" } } },
    ],
  }`);
  write(root, '.bobocloud/tasks.json', `{
    "version": "2.0.0",
    "tasks": [{ "label": "Build", "type": "process", "command": "npm", "args": ["run", "build"] }]
  }`);

  const configuration = loadTaskConfiguration(root);
  assert.equal(configuration.tasks.length, 1);
  assert.equal(configuration.tasks[0].source, 'bobocloud');
  assert.deepEqual(configuration.tasks[0].args, ['run', 'build']);
  const conflict = configuration.warnings.find((item) => item.code === 'TASK_LABEL_CONFLICT');
  assert.ok(conflict);
  assert.match(conflict.message, /\.bobocloud[\\/]tasks\.json/);
  assert.match(conflict.message, /\.vscode[\\/]tasks\.json/);

  fs.rmSync(path.join(root, '.bobocloud'), { recursive: true });
  const vscodeOnly = loadTaskConfiguration(root);
  assert.deepEqual(vscodeOnly.tasks[0].options.env, { GLOBAL: 'yes', LOCAL: 'one' });
  assert.deepEqual(vscodeOnly.tasks[0].options.shell, { executable: 'bash' });
});

test('parse diagnostics include line and column and partial JSONC is never executable', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', `{
    "version": "2.0.0",
    "tasks": [{ "label": "Broken", "command": "echo ok", }]
    trailing
  }`);
  const configuration = loadTaskConfiguration(root);
  const diagnostic = configuration.warnings.find((item) => item.code === 'TASKS_JSON_PARSE_ERROR');
  assert.ok(diagnostic);
  assert.ok(diagnostic.line >= 3);
  assert.ok(diagnostic.column >= 1);
  assert.equal(configuration.tasks.every((task) => task.executable === false), true);
});

test('resolver preserves parallel dependencies and adds sequence edges', (t) => {
  const root = workspace(t);
  write(root, '.bobocloud/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [
      { label: 'A', type: 'process', command: 'echo', args: ['a'] },
      { label: 'B', type: 'process', command: 'echo', args: ['b'] },
      { label: 'Parallel', dependsOn: ['A', 'B'] },
      { label: 'Sequence', dependsOn: ['A', 'B'], dependsOrder: 'sequence' }
    ]
  }));
  const configuration = loadTaskConfiguration(root);
  const parallel = resolveTaskExecution(configuration, 'Parallel');
  const parallelA = parallel.steps.find((step) => step.label === 'A');
  const parallelB = parallel.steps.find((step) => step.label === 'B');
  assert.deepEqual(parallelA.dependsOn, []);
  assert.deepEqual(parallelB.dependsOn, []);

  const sequence = resolveTaskExecution(configuration, 'Sequence');
  const sequenceA = sequence.steps.find((step) => step.label === 'A');
  const sequenceB = sequence.steps.find((step) => step.label === 'B');
  assert.deepEqual(sequenceB.dependsOn, [sequenceA.id]);
});

test('sequence ordering reuses a shared dependency without creating a cycle', (t) => {
  const root = workspace(t);
  write(root, '.bobocloud/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [
      { label: 'C', type: 'process', command: 'c' },
      { label: 'A', type: 'process', command: 'a', dependsOn: 'C' },
      { label: 'B', type: 'process', command: 'b', dependsOn: 'C' },
      { label: 'Root', dependsOn: ['A', 'B'], dependsOrder: 'sequence' }
    ]
  }));

  const execution = resolveTaskExecution(loadTaskConfiguration(root), 'Root');
  const byLabel = new Map(execution.steps.map((step) => [step.label, step]));
  assert.equal(execution.steps.filter((step) => step.label === 'C').length, 1);
  assert.deepEqual(byLabel.get('C').dependsOn, []);
  assert.deepEqual(byLabel.get('A').dependsOn, [byLabel.get('C').id]);
  assert.deepEqual(new Set(byLabel.get('B').dependsOn), new Set([byLabel.get('C').id, byLabel.get('A').id]));
});

test('cloud variables resolve to container paths while env variables remain unavailable before launch', (t) => {
  const root = workspace(t);
  write(root, 'src/example.test.js', '');
  write(root, '.bobocloud/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [{
      label: 'Test selected',
      type: 'process',
      command: 'node',
      args: ['${relativeFile}', '${fileBasenameNoExtension}'],
      options: {
        cwd: '${workspaceFolder}/src',
        env: { EXPLICIT: '${workspaceFolderBasename}' }
      },
      group: { kind: 'test', isDefault: true }
    }]
  }));
  const configuration = loadTaskConfiguration(root);
  const execution = resolveTaskExecution(configuration, 'Test selected', {
    activeFile: path.join(root, 'src', 'example.test.js'), lineNumber: 7, columnNumber: 3
  });
  assert.deepEqual(execution.steps[0].argv, ['node', 'src/example.test.js', 'example.test']);
  assert.equal(execution.steps[0].cwd, 'src');
  assert.equal(execution.steps[0].env.EXPLICIT, path.basename(root));

  assert.throws(
    () => substituteString('${env:PATH}', {}, {}),
    (error) => error.code === 'TASK_VARIABLE_UNAVAILABLE' && /PATH/.test(error.message)
  );
  assert.throws(
    () => substituteString('${userHome}', {}, {}),
    (error) => error.code === 'TASK_VARIABLE_UNAVAILABLE' && /userHome/.test(error.message)
  );
});

test('options.env is passed to the cloud process but cannot expand env variables in command or args', (t) => {
  const root = workspace(t);
  write(root, '.bobocloud/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [{
      label: 'env semantics',
      type: 'process',
      command: 'printenv',
      args: ['${env:EXPLICIT}'],
      options: { env: { EXPLICIT: 'cloud-value' } }
    }]
  }));
  const configuration = loadTaskConfiguration(root);
  assert.throws(
    () => resolveTaskExecution(configuration, 'env semantics'),
    (error) => error.code === 'TASK_VARIABLE_UNAVAILABLE' && /EXPLICIT/.test(error.message)
  );
});

test('shell and process tasks preserve their distinct quoting contracts', (t) => {
  const root = workspace(t);
  write(root, '.bobocloud/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [
      { label: 'shell line', type: 'shell', command: 'printf one && printf two' },
      { label: 'shell path', type: 'shell', command: '/workspace/My Tool/bin/run', args: ['two words'] },
      { label: 'shell explicit', type: 'shell', command: { value: 'echo $HOME', quoting: 'strong' }, args: [{ value: '$USER', quoting: 'weak' }] },
      { label: 'process argv', type: 'process', command: '/workspace/My Tool/bin/run', args: ['two words'] }
    ]
  }));
  const configuration = loadTaskConfiguration(root);
  assert.equal(resolveTaskExecution(configuration, 'shell line').steps[0].argv.at(-1), 'printf one && printf two');
  assert.equal(resolveTaskExecution(configuration, 'shell path').steps[0].argv.at(-1), "'/workspace/My Tool/bin/run' 'two words'");
  assert.equal(resolveTaskExecution(configuration, 'shell explicit').steps[0].argv.at(-1), "'echo $HOME' \"$USER\"");
  assert.deepEqual(resolveTaskExecution(configuration, 'process argv').steps[0].argv, ['/workspace/My Tool/bin/run', 'two words']);
});

test('unsupported extension tasks, interactive variables and background tasks remain visible but disabled', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', JSON.stringify({
    version: '2.0.0',
    inputs: [{ id: 'name', type: 'promptString' }],
    tasks: [
      { label: 'npm provider', type: 'npm', script: 'test' },
      { label: 'prompt', type: 'shell', command: 'echo ${input:name}' },
      { label: 'watch', type: 'shell', command: 'npm run watch', isBackground: true }
    ]
  }));
  const configuration = loadTaskConfiguration(root);
  assert.equal(configuration.tasks.every((task) => task.executable === false), true);
  const codes = new Set(configuration.warnings.map((item) => item.code));
  assert.ok(codes.has('TASKS_INPUTS_UNSUPPORTED'));
  assert.ok(codes.has('TASK_TYPE_UNSUPPORTED'));
  assert.ok(codes.has('TASK_VARIABLE_UNSUPPORTED'));
  assert.ok(codes.has('TASK_BACKGROUND_UNSUPPORTED'));
});

test('every structured task configuration warning has a renderer localization mapping', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../main/tasks.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/project-tasks.js'), 'utf8');
  const warningCodes = new Set(Array.from(
    mainSource.matchAll(/warning\(\s*['"](TASKS?_[A-Z0-9_]+)['"]/g),
    (match) => match[1]
  ));
  warningCodes.add('TASKS_LOAD_FAILED');
  for (const code of warningCodes) {
    assert.match(rendererSource, new RegExp('\\b' + code + '\\s*:'), `missing renderer warning mapping for ${code}`);
  }
});

test('problemMatcher is carried to the renderer execution plan but is not sent as a server warning', (t) => {
  const root = workspace(t);
  write(root, '.bobocloud/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'Build', type: 'process', command: 'cc', args: ['main.c'], problemMatcher: '$gcc' }]
  }));
  const configuration = loadTaskConfiguration(root);
  assert.equal(configuration.tasks[0].warnings.some((item) => item.field === 'problemMatcher'), false);
  assert.equal(resolveTaskExecution(configuration, 'Build').problemMatcher, '$gcc');
});
