'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI context keeps its six-method facade and private disposable service contract', () => {
  const source = [
    "import { createAiContextService, AI_CONTEXT_SERVICE_ID } from '../src/ai-context';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AiContextDependencies, AiContextFacade, AiContextModelPort, AiContextPositionDto, AiContextService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'getCurrentFileContext' | 'getSelectionContext' | 'getProjectContext' | 'getActiveTabContexts' | 'buildFullContext' | 'getInlineContext';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AiContextFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof AiContextService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<AiContextService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.aiContext'], AiContextService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.aiContext' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'document' | 'state' | 'getAiPrompts';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof AiContextDependencies, DependencyKeys>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createAiContextService>>>;',
    "const serviceId: 'workbench.aiContext' = AI_CONTEXT_SERVICE_ID;",
    'declare const dependencies: AiContextDependencies;',
    'declare const model: AiContextModelPort;',
    'declare const position: AiContextPositionDto;',
    'const service: AiContextService = createAiContextService(dependencies);',
    'const facade: AiContextFacade = service;',
    'service.getCurrentFileContext();',
    'service.getSelectionContext();',
    'service.getProjectContext();',
    'service.getActiveTabContexts();',
    'service.buildFullContext();',
    'service.getInlineContext(model, position);',
    'service.dispose();',
    '// @ts-expect-error AI context exposes a closed compatibility surface.',
    'service.retry();',
    '// @ts-expect-error AI context is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.aiContext');",
    'void serviceId; void facade;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-context-types-contract.ts',
    source
  });
});
