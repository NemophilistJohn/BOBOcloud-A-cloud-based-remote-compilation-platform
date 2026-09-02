'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  collectTaskInputRequests,
  configValuesFromSnapshot,
  createTasksController,
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

test('task configuration reads are bounded and never follow symbolic files', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', ' '.repeat(1024 * 1024 + 1));
  let configuration = loadTaskConfiguration(root);
  assert.equal(configuration.tasks.length, 0);
  assert.equal(configuration.warnings.some((item) => item.code === 'TASKS_JSON_PARSE_ERROR'), true);

  const taskPath = path.join(root, '.vscode', 'tasks.json');
  const outside = path.join(root, 'outside-tasks.json');
  fs.writeFileSync(outside, JSON.stringify({
    version: '2.0.0', tasks: [{ label: 'Outside', type: 'process', command: 'echo' }]
  }));
  fs.rmSync(taskPath);
  try {
    fs.symlinkSync(outside, taskPath);
    configuration = loadTaskConfiguration(root);
    assert.equal(configuration.tasks.length, 0);
    assert.equal(configuration.warnings.some((item) => item.code === 'TASKS_JSON_PARSE_ERROR'), true);
  } catch (error) {
    if (!error || error.code !== 'EPERM') throw error;
  }
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

test('supported interactive variables remain executable while extension and background tasks stay disabled', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', JSON.stringify({
    version: '2.0.0',
    inputs: [{ id: 'name', type: 'promptString', description: 'Name' }],
    tasks: [
      { label: 'npm provider', type: 'npm', script: 'test' },
      { label: 'prompt', type: 'shell', command: 'echo ${input:name}' },
      { label: 'watch', type: 'shell', command: 'npm run watch', isBackground: true }
    ]
  }));
  const configuration = loadTaskConfiguration(root);
  assert.equal(configuration.tasks.find((task) => task.label === 'prompt').executable, true);
  assert.equal(configuration.tasks.find((task) => task.label === 'npm provider').executable, false);
  assert.equal(configuration.tasks.find((task) => task.label === 'watch').executable, false);
  const codes = new Set(configuration.warnings.map((item) => item.code));
  assert.ok(codes.has('TASK_TYPE_UNSUPPORTED'));
  assert.ok(codes.has('TASK_BACKGROUND_UNSUPPORTED'));
});

test('input ids that can mutate ordinary object prototypes are rejected before renderer prompting', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', JSON.stringify({
    version: '2.0.0',
    inputs: [
      { id: '__proto__', type: 'promptString', description: 'Prototype' },
      { id: 'prototype', type: 'promptString', description: 'Prototype property' },
      { id: 'constructor', type: 'promptString', description: 'Constructor' },
      { id: 'safe-id', type: 'promptString', description: 'Safe' }
    ],
    tasks: [
      { label: 'Unsafe proto', type: 'process', command: 'echo', args: ['${input:__proto__}'] },
      { label: 'Unsafe prototype', type: 'process', command: 'echo', args: ['${input:prototype}'] },
      { label: 'Unsafe constructor', type: 'process', command: 'echo', args: ['${input:constructor}'] },
      { label: 'Safe', type: 'process', command: 'echo', args: ['${input:safe-id}'] }
    ]
  }));

  const configuration = loadTaskConfiguration(root);
  assert.equal(configuration.tasks.find((task) => task.label === 'Safe').executable, true);
  for (const label of ['Unsafe proto', 'Unsafe prototype', 'Unsafe constructor']) {
    assert.equal(configuration.tasks.find((task) => task.label === label).executable, false);
  }
  assert.equal(configuration.warnings.filter((item) => item.code === 'TASK_INPUT_DEFINITION_INVALID').length, 3);
  assert.equal(configuration.warnings.filter((item) => item.code === 'TASK_INPUT_UNAVAILABLE').length, 3);
});

test('task variables use two-pass evaluation, prompt once, and redact password inputs from command echo', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', JSON.stringify({
    version: '2.0.0',
    inputs: [
      { id: 'name', type: 'promptString', description: 'Name', default: 'guest', password: true },
      { id: 'mode', type: 'pickString', description: 'Mode', options: ['fast', { label: 'Careful', value: 'safe' }], default: 'fast' },
      { id: 'empty', type: 'pickString', description: 'Empty default', options: ['fallback', ''], default: '' }
    ],
    tasks: [{
      label: 'Variables',
      type: 'process',
      command: '${command:bobocloud.tasks.workspaceFolder}',
      args: ['${input:name}', '${input:name}', '${input:mode}', '${input:empty}', '${config:editor.tabSize}', '${command:bobocloud.tasks.workspaceFolder}']
    }]
  }));
  const configuration = loadTaskConfiguration(root);
  assert.equal(configuration.inputs.find((input) => input.id === 'empty').default, '');
  const requests = collectTaskInputRequests(configuration, 'Variables');
  assert.deepEqual(requests.map((request) => request.id), ['name', 'mode', 'empty']);
  assert.equal(requests[2].default, '');
  assert.throws(
    () => resolveTaskExecution(configuration, 'Variables'),
    (error) => error.code === 'TASK_INPUT_REQUIRED' && error.inputRequests.length === 3
  );
  let commandEvaluations = 0;
  const execution = resolveTaskExecution(configuration, 'Variables', {}, {
    inputValues: { name: 'secret value', mode: 'safe', empty: '' },
    configValues: { 'editor.tabSize': 3 },
    commandResolvers: {
      'bobocloud.tasks.workspaceFolder': ({ variables }) => {
        commandEvaluations += 1;
        return variables.workspaceFolder;
      }
    }
  });
  assert.equal(commandEvaluations, 1, 'a repeated variable is evaluated once during the first pass');
  assert.deepEqual(execution.steps[0].argv, ['/workspace', 'secret value', 'secret value', 'safe', '', '3', '/workspace']);
  assert.equal(execution.steps[0].displayCommand, "/workspace '******' '******' safe '' 3 /workspace");
});

test('command inputs and command variables are restricted to the built-in allowlist', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', JSON.stringify({
    version: '2.0.0',
    inputs: [
      { id: 'active', type: 'command', command: 'bobocloud.tasks.relativeFile' },
      { id: 'unsafe', type: 'command', command: 'extension.executeArbitraryCode' }
    ],
    tasks: [
      { label: 'Safe', type: 'process', command: 'echo', args: ['${input:active}', '${input:active}'] },
      { label: 'Unsafe input', type: 'process', command: 'echo', args: ['${input:unsafe}'] },
      { label: 'Unsafe command', type: 'process', command: 'echo', args: ['${command:extension.executeArbitraryCode}'] },
      { label: 'Unsafe config', type: 'process', command: 'echo', args: ['${config:terminal.integrated.env.linux}'] }
    ]
  }));
  const configuration = loadTaskConfiguration(root);
  const safe = configuration.tasks.find((task) => task.label === 'Safe');
  assert.equal(safe.executable, true);
  assert.deepEqual(resolveTaskExecution(configuration, 'Safe', {
    activeFile: path.join(root, 'src', 'main.js')
  }).steps[0].argv, ['echo', 'src/main.js', 'src/main.js']);
  assert.equal(configuration.tasks.find((task) => task.label === 'Unsafe input').executable, false);
  assert.equal(configuration.tasks.find((task) => task.label === 'Unsafe command').executable, false);
  assert.equal(configuration.tasks.find((task) => task.label === 'Unsafe config').executable, false);
  const codes = new Set(configuration.warnings.map((item) => item.code));
  assert.ok(codes.has('TASK_INPUT_COMMAND_NOT_ALLOWED'));
  assert.ok(codes.has('TASK_INPUT_UNAVAILABLE'));
  assert.ok(codes.has('TASK_COMMAND_NOT_ALLOWED'));
  assert.ok(codes.has('TASK_CONFIG_NOT_ALLOWED'));
});

test('presentation and rerun options expose only implemented semantics and warn for shared-panel limitations', (t) => {
  const root = workspace(t);
  write(root, '.vscode/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [{
      label: 'Presented', type: 'process', command: 'echo', args: ['ok'],
      presentation: { reveal: 'silent', echo: false, focus: true, clear: true, panel: 'dedicated', group: 'build', showReuseMessage: false },
      runOptions: { reevaluateOnRerun: false, runOn: 'folderOpen', instanceLimit: 2 }
    }]
  }));
  const configuration = loadTaskConfiguration(root);
  const execution = resolveTaskExecution(configuration, 'Presented');
  assert.deepEqual(execution.presentation, { reveal: 'silent', echo: false, focus: true, clear: true });
  assert.deepEqual(execution.runOptions, { reevaluateOnRerun: false, runOn: 'folderOpen' });
  assert.equal(execution.steps[0].echo, false);
  const codes = configuration.warnings.map((item) => item.code);
  assert.equal(codes.filter((code) => code === 'TASK_PRESENTATION_FIELD_UNSUPPORTED').length, 3);
  assert.ok(codes.includes('TASK_RUN_ON_MANUAL_ONLY'));
  assert.ok(codes.includes('TASK_RUN_OPTION_UNSUPPORTED'));
});

test('config variables are read from the active language slice of the imported settings snapshot', async (t) => {
  const root = workspace(t);
  write(root, '.vscode/settings.json', JSON.stringify({
    'editor.tabSize': 2,
    '[javascript]': { 'editor.tabSize': 4 },
    'terminal.integrated.env.linux': { SECRET: 'not-visible' }
  }));
  write(root, '.vscode/tasks.json', JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'Config', type: 'process', command: 'echo', args: ['${config:editor.tabSize}'] }]
  }));
  const handlers = new Map();
  const identity = { rootPath: root, workspaceIdentity: 9 };
  const controller = createTasksController({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWorkspaceIdentity: () => identity
  });
  controller.registerIpc();
  const result = await handlers.get('tasks:resolve')({}, { label: 'Config', context: { languageId: 'javascript' } });
  assert.equal(result.success, true);
  assert.deepEqual(result.execution.steps[0].argv, ['echo', '4']);
  assert.deepEqual(configValuesFromSnapshot({
    settings: { editor: { tabSize: 2 }, languages: { javascript: { tabSize: 4 } } }
  }, 'javascript'), { 'editor.tabSize': 4 });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|terminal\.integrated/);
});

test('every structured task configuration warning has a renderer localization mapping', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../main/tasks.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/project-tasks.ts'), 'utf8');
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
