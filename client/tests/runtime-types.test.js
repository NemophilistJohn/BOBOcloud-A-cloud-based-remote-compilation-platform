'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('runtime contracts keep the selector facade exact and registry-private', () => {
  const source = [
    "import { canonicalLanguage, compareRuntimeVersions, createRuntimeService, RUNTIME_SERVICE_ID } from '../src/runtime';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap,',
    '  RuntimeDefinitionDto,',
    '  RuntimeDependencies,',
    '  RuntimeFacade,',
    '  RuntimeHelpersFacade,',
    '  RuntimeSelectionResultDto,',
    '  RuntimeService',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'fetchRuntimes' | 'selectRuntime' | 'autoSelectForLanguage' | 'autoSelectForActiveFile' | '_helpers';",
    'type FacadeIsExact = AssertTrue<Equal<keyof RuntimeFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof RuntimeService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<RuntimeService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.runtime'], RuntimeService>>;",
    "type PluginAbsent = AssertFalse<'workbench.runtime' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.runtime' = RUNTIME_SERVICE_ID;",
    'declare const dependencies: RuntimeDependencies;',
    'declare const service: RuntimeService;',
    'const created: RuntimeService = createRuntimeService(dependencies);',
    'const helpers: RuntimeHelpersFacade = service._helpers;',
    'const runtime: RuntimeDefinitionDto = { language: "python", version: "3.13", runtimeId: "python:3.13" };',
    'const selection: RuntimeSelectionResultDto = service.autoSelectForLanguage("python");',
    'const language: string = canonicalLanguage("TypeScript");',
    'const comparison: number = compareRuntimeVersions(runtime, runtime);',
    'service.init(); service.fetchRuntimes(); service.selectRuntime("python:3.13"); service.autoSelectForActiveFile(); service.dispose();',
    '// @ts-expect-error Runtime facade methods are a closed compatibility surface.',
    'service.selectRuntime(7);',
    '// @ts-expect-error Runtime service is not exposed to downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.runtime');",
    'void serviceId; void created; void helpers; void runtime; void selection; void language; void comparison;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__runtime-types-contract.ts',
    source
  });
});
