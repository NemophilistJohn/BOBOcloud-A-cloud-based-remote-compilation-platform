'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('run configuration contracts keep DTOs typed and the service private', () => {
  const source = [
    "import { createRunConfigService, RUN_CONFIG_SERVICE_ID, languageForFile, splitArgs } from '../src/run-config';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap,',
    '  RunConfigArgsDto,',
    '  RunConfigDependencies,',
    '  RunConfigFacade,',
    '  RunConfigRawDto,',
    '  RunConfigService,',
    '  RunConfigTargetDto',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'languageForFile' | 'getArgs' | 'describeTarget' | 'refreshForActiveFile' | 'close' | '_splitArgs';",
    'type FacadeIsExact = AssertTrue<Equal<keyof RunConfigFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof RunConfigService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<RunConfigService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.runConfig'], RunConfigService>>;",
    "type PluginAbsent = AssertFalse<'workbench.runConfig' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.runConfig' = RUN_CONFIG_SERVICE_ID;",
    'declare const dependencies: RunConfigDependencies;',
    'declare const service: RunConfigService;',
    'const created: RunConfigService = createRunConfigService(dependencies);',
    'const raw: RunConfigRawDto = { compile: "-O2", run: "--verbose", target: "linux-x86_64" };',
    'const args: RunConfigArgsDto = service.getArgs("c");',
    'const target: RunConfigTargetDto = { id: "linux-x86_64", os: "linux", architecture: "x86_64", environment: "hosted" };',
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.runConfig'] = service;",
    'service.init(); service.refreshForActiveFile(); service.close(); service.dispose();',
    'const language: string | null = languageForFile("main.cpp");',
    'const argv: string[] = splitArgs("cc -DNAME=\\\"value\\\"");',
    '// @ts-expect-error Run configuration methods are a closed compatibility surface.',
    'service.resetAll();',
    '// @ts-expect-error The run configuration service is not exposed to downloaded plugins.',
    "platform.services.getForPlugin('workbench.runConfig');",
    'void serviceId; void created; void raw; void args; void target; void registered; void language; void argv;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__run-config-types-contract.ts',
    source
  });
});
