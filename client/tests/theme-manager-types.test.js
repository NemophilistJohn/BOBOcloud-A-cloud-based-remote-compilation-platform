'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('theme contracts keep the disposable service precise and workbench-private', () => {
  const source = [
    "import { createThemeService, THEME_SERVICE_ID } from '../src/theme-manager';",
    "import type { Disposable, Dispose } from '../types/lifecycle';",
    'import type {',
    '  BuiltinThemeId,',
    '  ThemeDependencies,',
    '  ThemeDescriptorDto,',
    '  ThemeManagerFacade,',
    '  ThemeMonaco,',
    '  ThemeService',
    "} from '../types/theme';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeMethod = 'init' | 'setMonaco' | 'applyTheme' | 'toggleTheme' | 'getCurrentTheme' | 'listThemes' | 'onChange';",
    'type FacadeIsExact = AssertTrue<Equal<keyof ThemeManagerFacade, FacadeMethod>>;',
    "type ServiceIsDisposableFacade = AssertTrue<Equal<keyof ThemeService, FacadeMethod | 'dispose'>>;",
    "type ListResult = AssertTrue<Equal<ReturnType<ThemeManagerFacade['listThemes']>, readonly ThemeDescriptorDto[]>>;",
    "type ListenerDispose = AssertTrue<Equal<ReturnType<ThemeManagerFacade['onChange']>, Dispose>>;",
    "type FactoryIsNotAny = AssertFalse<IsAny<ReturnType<typeof createThemeService>>>;",
    "type ThemeIdIsNotAny = AssertFalse<IsAny<Parameters<ThemeManagerFacade['applyTheme']>[0]>>;",
    "type MonacoIsNotAny = AssertFalse<IsAny<Parameters<ThemeManagerFacade['setMonaco']>[0]>>;",
    "type ColorsAreNotAny = AssertFalse<IsAny<ThemeDescriptorDto['colors']>>;",
    "const serviceId: 'workbench.theme' = THEME_SERVICE_ID;",
    'declare const dependencies: ThemeDependencies;',
    'const service: ThemeService = createThemeService(dependencies);',
    'const facade: ThemeManagerFacade = service;',
    'const disposable: Disposable = service;',
    'declare const monaco: ThemeMonaco;',
    'facade.setMonaco(monaco);',
    "const descriptor: ThemeDescriptorDto = { id: 'cloud-forge', label: 'Cloud Forge', colors: ['#101311', '#171b18', '#f3f6f1', '#d8a63f', '#6fa8dc'] };",
    'const builtInId: BuiltinThemeId = descriptor.id;',
    '// @ts-expect-error Theme descriptor ids are immutable.',
    "descriptor.id = 'light';",
    '// @ts-expect-error Theme preview tuples are immutable.',
    "descriptor.colors[0] = '#000000';",
    '// @ts-expect-error The compatibility facade does not own service disposal.',
    'facade.dispose();',
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.theme'] = platform.services.require(THEME_SERVICE_ID);",
    "type PluginVisible = 'workbench.theme' extends keyof RendererPluginServiceMap ? true : false;",
    'const pluginVisible: PluginVisible = false;',
    '// @ts-expect-error Theme selection remains private to the trusted workbench.',
    "platform.services.getForPlugin('workbench.theme');",
    'disposable.dispose();',
    'void serviceId; void service; void registered; void pluginVisible; void builtInId;',
    'void (false as unknown as FacadeIsExact);',
    'void (false as unknown as ServiceIsDisposableFacade);',
    'void (false as unknown as ListResult);',
    'void (false as unknown as ListenerDispose);',
    'void (false as unknown as FactoryIsNotAny);',
    'void (false as unknown as ThemeIdIsNotAny);',
    'void (false as unknown as MonacoIsNotAny);',
    'void (false as unknown as ColorsAreNotAny);'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__theme-manager-types-contract.ts',
    source
  });
});
