'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI inline provider keeps a closed private service and typed Monaco ports', () => {
  const source = [
    "import { createAiInlineService, AI_INLINE_SERVICE_ID } from '../src/ai-inline';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AiInlineDependencies, AiInlineFacade, AiInlineModelPort, AiInlineMonacoPort, AiInlineProvider, AiInlineService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'setEnabled' | 'trigger' | 'cancelPending' | 'registerForLanguage' | 'registerForAllLanguages' | '_createProvider';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AiInlineFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof AiInlineService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<AiInlineService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.aiInline'], AiInlineService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.aiInline' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'state' | 'getAiService' | 'getAiContext' | 'getMonaco' | 'setTimeout' | 'clearTimeout' | 'logger';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof AiInlineDependencies, DependencyKeys>>;',
    'type ModelIsNotAny = AssertFalse<IsAny<AiInlineModelPort>>;',
    'type MonacoIsNotAny = AssertFalse<IsAny<AiInlineMonacoPort>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createAiInlineService>>>;',
    "const serviceId: 'workbench.aiInline' = AI_INLINE_SERVICE_ID;",
    'declare const dependencies: AiInlineDependencies;',
    'declare const service: AiInlineService;',
    'const facade: AiInlineFacade = service;',
    'const provider: AiInlineProvider = service._createProvider();',
    'const created: AiInlineService = createAiInlineService(dependencies);',
    'service.init(); service.registerForAllLanguages(); service.cancelPending(); service.trigger(); service.dispose();',
    'void serviceId; void facade; void provider; void created;',
    '// @ts-expect-error AI inline exposes a closed compatibility surface.',
    'service.reload();',
    '// @ts-expect-error AI inline is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.aiInline');"
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-inline-types-contract.ts',
    source
  });
});
