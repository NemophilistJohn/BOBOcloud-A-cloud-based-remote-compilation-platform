'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('run output contracts keep the structured facade typed and registry-private', () => {
  const source = [
    "import { createRunOutputService, RUN_OUTPUT_SERVICE_ID } from '../src/run-output';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap,',
    '  RunOutputBeginOptionsDto,',
    '  RunOutputDependencies,',
    '  RunOutputFacade,',
    '  RunOutputFinishOptionsDto,',
    '  RunOutputService,',
    '  RunOutputStatusDto',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'begin' | 'detail' | 'phase' | 'handleStatus' | 'finish' | 'clear' | 'clearTranscript' | 'isActive' | 'setDetailsVisible' | 'setPanelActive';",
    'type FacadeIsExact = AssertTrue<Equal<keyof RunOutputFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof RunOutputService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<RunOutputService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.runOutput'], RunOutputService>>;",
    "type PluginAbsent = AssertFalse<'workbench.runOutput' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.runOutput' = RUN_OUTPUT_SERVICE_ID;",
    'declare const dependencies: RunOutputDependencies;',
    'declare const service: RunOutputService;',
    'const created: RunOutputService = createRunOutputService(dependencies);',
    'const begin: RunOutputBeginOptionsDto = { target: "main.py", runtime: "Python 3.13" };',
    'const status: RunOutputStatusDto = { type: "status", stage: "run:python", message: "started" };',
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.runOutput'] = service;",
    'service.init();',
    'const sessionId: number = service.begin(begin);',
    'service.handleStatus(status, sessionId);',
    'service.detail("output", { sessionId, stage: "run:python" });',
    'service.phase("running", "started", { sessionId });',
    'service.finish({ success: true, returnCode: 0, sessionId });',
    'service.clear(); service.clearTranscript(); service.setDetailsVisible(true); service.setPanelActive(true);',
    'const active: boolean = service.isActive(sessionId);',
    'service.dispose();',
    '// @ts-expect-error Run output service methods are a closed compatibility surface.',
    'service.openDetails();',
    '// @ts-expect-error The run output service is not exposed to downloaded plugins.',
    "platform.services.getForPlugin('workbench.runOutput');",
    'void serviceId; void created; void registered; void active;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__run-output-types-contract.ts',
    source
  });
});
