'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('settings keeps its six-method facade and private disposable service contract', () => {
  const source = [
    "import { createSettingsService, SETTINGS_SERVICE_ID } from '../src/settings';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, SettingsAiModelDto, SettingsDependencies, SettingsFacade, SettingsServerSettingsDto, SettingsService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'open' | 'close' | 'openFirstRun' | 'finishFirstRun' | 'isFirstRunOpen';",
    'type FacadeIsExact = AssertTrue<Equal<keyof SettingsFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof SettingsService, FacadeKeys | 'dispose' | 'disposed'>>;",
    "type DependencyKeys = 'document' | 'window' | 'state' | 'getI18n' | 'getThemeManager' | 'getToast' | 'getDiagnosticsSettings' | 'getRcloneSettings' | 'getWorkbench' | 'getLanguagePacksPanel' | 'getLsp' | 'getAiService' | 'getAiSettingsCenter' | 'logger';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof SettingsDependencies, DependencyKeys>>;',
    'type ServiceIsDisposable = AssertTrue<SettingsService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.settings'], SettingsService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.settings' extends keyof RendererPluginServiceMap ? true : false>;",
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createSettingsService>>>;',
    "const serviceId: 'workbench.settings' = SETTINGS_SERVICE_ID;",
    'declare const dependencies: SettingsDependencies;',
    'declare const model: SettingsAiModelDto;',
    'declare const serverSettings: SettingsServerSettingsDto;',
    'const service: SettingsService = createSettingsService(dependencies);',
    'const facade: SettingsFacade = service;',
    'const disposable: Disposable = service;',
    "service.init(); service.open('server'); service.close(); service.finishFirstRun(); service.dispose();",
    'const firstRunOpen: boolean = service.openFirstRun();',
    'const currentFirstRunState: boolean = service.isFirstRunOpen();',
    '// @ts-expect-error AI model DTOs are immutable at the settings boundary.',
    "model.name = 'replacement';",
    '// @ts-expect-error Server settings remain immutable, untrusted input DTOs.',
    "serverSettings.ip = 'replacement.example';",
    '// @ts-expect-error Settings exposes a closed compatibility surface.',
    'service.reload();',
    '// @ts-expect-error Settings is intentionally absent from the downloaded-plugin service map.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.settings');",
    'void serviceId; void facade; void disposable; void firstRunOpen; void currentFirstRunState;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__settings-types-contract.ts',
    source
  });
});
