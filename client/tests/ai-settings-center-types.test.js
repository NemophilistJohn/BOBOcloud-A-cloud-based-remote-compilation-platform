'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI settings center keeps its seven-key facade, typed DTO boundary, and disposable private service', () => {
  const source = [
    "import { createAiSettingsCenterService, AI_SETTINGS_CENTER_SERVICE_ID } from '../src/ai-settings-center';",
    "import type { Disposable, Dispose } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AiProfileDto, AiSettingsCenterDependencies, AiSettingsCenterDraft, AiSettingsCenterFacade, AiSettingsCenterService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'open' | 'close' | 'save' | 'switchTab' | 'isDirty' | 'getDraft';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AiSettingsCenterFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof AiSettingsCenterService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<AiSettingsCenterService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.aiSettingsCenter'], AiSettingsCenterService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.aiSettingsCenter' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'document' | 'state' | 'getI18n' | 'getSchema' | 'getAiService' | 'getConfirm' | 'getIcons' | 'getAgentButton' | 'getAgentWorkbench' | 'setTimer' | 'clearTimer' | 'logger';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof AiSettingsCenterDependencies, DependencyKeys>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createAiSettingsCenterService>>>;',
    "const serviceId: 'workbench.aiSettingsCenter' = AI_SETTINGS_CENTER_SERVICE_ID;",
    'declare const dependencies: AiSettingsCenterDependencies;',
    'declare const profile: AiProfileDto;',
    'declare const draft: AiSettingsCenterDraft;',
    'const service: AiSettingsCenterService = createAiSettingsCenterService(dependencies);',
    'const facade: AiSettingsCenterFacade = service;',
    'const disposable: Disposable = service;',
    'const platform = null as unknown as RendererPlatform;',
    "const registered: AiSettingsCenterService = platform.services.require('workbench.aiSettingsCenter');",
    'service.init(); service.open("connections"); service.switchTab("chat"); service.isDirty(); service.getDraft(); service.close(); service.save(); service.dispose();',
    'const unsubscribe: Dispose | undefined = dependencies.getI18n()?.onChange?.(() => {});',
    '// @ts-expect-error AI settings center exposes a closed compatibility surface.',
    'service.refresh();',
    '// @ts-expect-error AI settings center is intentionally absent from downloaded plugins.',
    "platform.services.getForPlugin('workbench.aiSettingsCenter');",
    '// @ts-expect-error Profile DTOs are immutable at the typed boundary.',
    'profile.name = "replacement";',
    'draft.chatOpen = !draft.chatOpen;',
    'void serviceId; void facade; void disposable; void registered; void unsubscribe;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-settings-center-types-contract.ts',
    source
  });
});
