'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('language packs panel contracts keep DTOs immutable and the service workbench-private', () => {
  const source = [
    "import { createLanguagePacksPanel, normalizeLanguagePackPanelEntries } from '../src/language-packs-panel';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  LanguagePackPanelViewDto,',
    '  LanguagePacksPanelDependencies,',
    '  LanguagePacksPanelFacade,',
    '  LanguagePacksPanelService,',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type Expect<Value extends true> = Value;',
    'type RenderResult = Expect<Equal<Awaited<ReturnType<LanguagePacksPanelFacade[\'render\']>>, readonly LanguagePackPanelViewDto[]>>;',
    'type InitResult = Expect<Equal<Awaited<ReturnType<LanguagePacksPanelFacade[\'init\']>>, boolean>>;',
    'declare const dependencies: LanguagePacksPanelDependencies;',
    'const service: LanguagePacksPanelService = createLanguagePacksPanel(dependencies);',
    'const disposable: Disposable = service;',
    'const packs: readonly LanguagePackPanelViewDto[] = normalizeLanguagePackPanelEntries({ packs: [] });',
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.languagePacksPanel'] = platform.services.require('workbench.languagePacksPanel');",
    "type PluginVisible = 'workbench.languagePacksPanel' extends keyof RendererPluginServiceMap ? true : false;",
    'const pluginVisible: PluginVisible = false;',
    '// @ts-expect-error The language packs settings surface is private to the trusted workbench.',
    "platform.services.getForPlugin('workbench.languagePacksPanel');",
    'declare const pack: LanguagePackPanelViewDto;',
    '// @ts-expect-error Normalized panel DTOs are immutable.',
    "pack.id = 'ja';",
    'service.render({ quiet: true, preserveStatus: true });',
    'disposable.dispose();',
    'void packs; void registered; void pluginVisible; void pack;',
    'void (false as unknown as RenderResult); void (false as unknown as InitResult);'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__language-packs-panel-types-contract.ts',
    source
  });
});
