'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('task problem matcher contracts keep diagnostics state private and disposable', () => {
  const source = [
    "import { createTaskProblemMatcherService, TASK_PROBLEM_MATCHER_SERVICE_ID } from '../src/task-problem-matcher';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPluginServiceMap, RendererServiceMap, TaskProblemMatcherDependencies, TaskProblemMatcherFacade, TaskProblemMatcherService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'begin' | 'clear' | 'getProblems' | 'getAllProblems' | 'refreshMonacoProblems' | 'onDidChange' | 'applyModel' | 'activeSession' | 'openProblem';",
    'type FacadeIsExact = AssertTrue<Equal<keyof TaskProblemMatcherFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof TaskProblemMatcherService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<TaskProblemMatcherService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.taskProblemMatcher'], TaskProblemMatcherService>>;",
    "type PluginAbsent = AssertFalse<'workbench.taskProblemMatcher' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.taskProblemMatcher' = TASK_PROBLEM_MATCHER_SERVICE_ID;",
    'declare const dependencies: TaskProblemMatcherDependencies;',
    'const service: TaskProblemMatcherService = createTaskProblemMatcherService(dependencies);',
    'service.init(); service.clear(); service.refreshMonacoProblems(); service.dispose();',
    '// @ts-expect-error The matcher service has a closed compatibility surface.',
    'service.render();',
    "void ({} as RendererServiceMap);",
    'void serviceId; void service;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__task-problem-matcher-types-contract.ts',
    source
  });
});
