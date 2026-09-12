'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI transport contract keeps the closed facade, private host port, and DTO boundaries typed', () => {
  const source = [
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AiChatPayloadDto, AiInlineCompletionResultDto, AiInlineRequestDto, AiService, AiServiceDependencies, AiServiceFacade, AiServiceHostPort, AiSettingsDto } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'loadSettings' | 'saveSettings' | 'getSettings' | 'updateSettings' | 'applySettings' | 'sendChat' | 'cancelStream' | 'getInlineCompletion' | 'cancelInline' | 'clearInlineCache' | 'updateStatus' | 'onStreamChunk' | 'onStreamEnd' | 'onStreamError' | 'getProfiles' | 'getProfileFor' | 'getProfileById' | 'getConnectionFor' | 'addProfile' | 'updateProfile' | 'removeProfile' | 'setProfileFor' | 'testProfileConnection' | 'testActiveConnections' | 'getConnectionHealth' | 'getModelFor' | 'getModelById' | 'getCurrentModelConfig' | 'getCurrentModelName' | 'getModelStatus' | 'addModel' | 'updateModel' | 'removeModel' | 'setCurrentModel' | 'setModelFor' | 'testModelConnection' | 'buildChatPayload' | 'buildInlineRequest' | 'buildMessages' | 'extractInlineText' | 'extractChatText' | 'sanitizeModel' | 'fingerprint';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AiServiceFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof AiService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<AiService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.aiService'], AiService>>;",
    "type HostMapIsExact = AssertTrue<Equal<RendererServiceMap['host.ai'], Readonly<AiServiceHostPort>>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.aiService' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'state' | 'schema' | 'getPrompts' | 'host' | 'getAgentButton';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof AiServiceDependencies, DependencyKeys>>;',
    'type HostIsNotAny = AssertFalse<IsAny<AiServiceHostPort>>;',
    'declare const service: AiService;',
    'declare const dependencies: AiServiceDependencies;',
    'declare const settings: AiSettingsDto;',
    'declare const chatPayload: AiChatPayloadDto;',
    'declare const inlineRequest: AiInlineRequestDto;',
    'declare const completion: AiInlineCompletionResultDto;',
    'const facade: AiServiceFacade = service;',
    'const host: Readonly<AiServiceHostPort> = (null as unknown as RendererPlatform).services.require(\'host.ai\');',
    'service.init(); service.loadSettings(); service.saveSettings(); service.getSettings();',
    'service.sendChat("hello"); service.getInlineCompletion({}); service.dispose();',
    'void dependencies; void settings; void chatPayload; void inlineRequest; void completion; void facade; void host;',
    '// @ts-expect-error AI service exposes a closed compatibility surface.',
    'service.reload();',
    '// @ts-expect-error AI service is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.aiService');",
    '// @ts-expect-error Canonical AI settings are immutable DTOs at the host boundary.',
    'settings.chatOpen = false;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-service-types-contract.ts',
    source
  });
});

