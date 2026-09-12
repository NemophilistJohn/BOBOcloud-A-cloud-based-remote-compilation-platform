'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI agent button keeps its five-key facade, private host event, and disposable service contract', () => {
  const source = [
    "import { createAiAgentButtonService, AI_AGENT_BUTTON_SERVICE_ID } from '../src/ai-agent-button';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AiAgentButtonDependencies, AiAgentButtonFacade, AiAgentButtonHostPort, AiAgentButtonProfileDto, AiAgentButtonService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'updateLEDs' | 'toggleChat' | 'openMenu' | 'closeMenu';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AiAgentButtonFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof AiAgentButtonService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<AiAgentButtonService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.aiAgentButton'], AiAgentButtonService>>;",
    "type HostMapIsExact = AssertTrue<Equal<RendererServiceMap['host.aiUi'], Readonly<AiAgentButtonHostPort>>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.aiAgentButton' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'document' | 'state' | 'getI18n' | 'getAiService' | 'getAiInline' | 'getWorkbench' | 'getChatPanel' | 'getSettingsCenter' | 'getToast' | 'host' | 'setTimer' | 'clearTimer';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof AiAgentButtonDependencies, DependencyKeys>>;',
    'type HostIsNotAny = AssertFalse<IsAny<AiAgentButtonHostPort>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createAiAgentButtonService>>>;',
    "const serviceId: 'workbench.aiAgentButton' = AI_AGENT_BUTTON_SERVICE_ID;",
    'declare const dependencies: AiAgentButtonDependencies;',
    'declare const profile: AiAgentButtonProfileDto;',
    'declare const service: AiAgentButtonService;',
    'const facade: AiAgentButtonFacade = service;',
    'const host: Readonly<AiAgentButtonHostPort> = (null as unknown as RendererPlatform).services.require(\'host.aiUi\');',
    'const created: AiAgentButtonService = createAiAgentButtonService(dependencies);',
    'service.init(); service.updateLEDs("idle"); service.toggleChat(); service.openMenu(); service.closeMenu(); service.dispose();',
    'void serviceId; void facade; void host; void created; void profile;',
    '// @ts-expect-error AI agent button exposes a closed compatibility surface.',
    'service.saveSettings();',
    '// @ts-expect-error AI agent button is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.aiAgentButton');",
    '// @ts-expect-error Profile DTOs are immutable at the typed boundary.',
    'profile.name = "replacement";'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-agent-button-types-contract.ts',
    source
  });
});
