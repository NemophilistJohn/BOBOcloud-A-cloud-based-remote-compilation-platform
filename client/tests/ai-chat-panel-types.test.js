'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI chat panel keeps its ten-key facade, typed host port, and disposable private service contract', () => {
  const source = [
    "import { createAiChatPanelService, AI_CHAT_PANEL_SERVICE_ID } from '../src/ai-chat-panel';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AiChatPanelDependencies, AiChatPanelFacade, AiChatPanelHostPort, AiChatPanelService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'setVisible' | 'sendMessage' | 'clearChat' | 'updateContextBar' | 'addReferencedFile' | 'removeReferencedFile' | 'excludeAutoFileContext' | 'openFilePicker' | 'saveChatHistory';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AiChatPanelFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof AiChatPanelService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<AiChatPanelService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.aiChatPanel'], AiChatPanelService>>;",
    "type HostMapIsExact = AssertTrue<Equal<RendererServiceMap['host.aiChatPanel'], Readonly<AiChatPanelHostPort>>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.aiChatPanel' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'document' | 'window' | 'state' | 'getI18n' | 'getAiService' | 'getAiContext' | 'getAiPrompts' | 'getAiMarkdown' | 'getSettingsCenter' | 'getAgentButton' | 'getWorkbench' | 'getToast' | 'getIcons' | 'getSchedulerFactory' | 'host' | 'setTimer' | 'clearTimer' | 'logger';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof AiChatPanelDependencies, DependencyKeys>>;',
    'type HostIsNotAny = AssertFalse<IsAny<AiChatPanelHostPort>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createAiChatPanelService>>>;',
    "const serviceId: 'workbench.aiChatPanel' = AI_CHAT_PANEL_SERVICE_ID;",
    'declare const dependencies: AiChatPanelDependencies;',
    'const service: AiChatPanelService = createAiChatPanelService(dependencies);',
    'const facade: AiChatPanelFacade = service;',
    'const host: Readonly<AiChatPanelHostPort> = (null as unknown as RendererPlatform).services.require(\'host.aiChatPanel\');',
    'service.init(); service.setVisible(true); void service.sendMessage(); service.clearChat(); service.updateContextBar(); service.addReferencedFile("a"); service.removeReferencedFile("a"); service.excludeAutoFileContext("a"); service.openFilePicker(); void service.saveChatHistory(); service.dispose();',
    'void serviceId; void facade; void host;',
    '// @ts-expect-error AI chat panel exposes a closed compatibility surface.',
    'service.refresh();',
    '// @ts-expect-error AI chat panel is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.aiChatPanel');"
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-chat-panel-types-contract.ts',
    source
  });
});
