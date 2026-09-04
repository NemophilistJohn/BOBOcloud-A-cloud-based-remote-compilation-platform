'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('rclone settings contracts keep opaque DTOs precise and the service workbench-private', () => {
  const source = [
    "import { createRcloneSettings } from '../src/rclone-settings';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  RcloneBinaryScanDto,',
    '  RcloneClient,',
    '  RcloneSelectionDto,',
    '  RcloneSelectBinaryResultDto,',
    '  RcloneSettingsDependencies,',
    '  RcloneSettingsFacade,',
    '  RcloneSettingsService,',
    '  RcloneVersionResultDto,',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type Expect<Value extends true> = Value;',
    "type ListResult = Expect<Equal<Awaited<ReturnType<RcloneClient['listBinaries']>>, RcloneBinaryScanDto>>;",
    "type SelectResult = Expect<Equal<Awaited<ReturnType<RcloneClient['selectBinary']>>, RcloneSelectBinaryResultDto>>;",
    "type RefreshResult = Expect<Equal<Awaited<ReturnType<RcloneSettingsFacade['refreshStatus']>>, RcloneVersionResultDto | null>>;",
    "type InitializeResult = Expect<Equal<ReturnType<RcloneSettingsFacade['initialize']>, void>>;",
    'declare const dependencies: RcloneSettingsDependencies;',
    'const service: RcloneSettingsService = createRcloneSettings(dependencies);',
    'const disposable: Disposable = service;',
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.rcloneSettings'] = platform.services.require('workbench.rcloneSettings');",
    "type PluginVisible = 'workbench.rcloneSettings' extends keyof RendererPluginServiceMap ? true : false;",
    'const pluginVisible: PluginVisible = false;',
    '// @ts-expect-error Rclone settings remain private to the trusted workbench.',
    "platform.services.getForPlugin('workbench.rcloneSettings');",
    "const scan: RcloneBinaryScanDto = { scanId: 'scan', selection: { source: 'bundled', path: null, version: null }, candidates: [{ id: 'candidate', source: 'bundled', path: null, selected: true }] };",
    'declare const selection: RcloneSelectionDto;',
    '// @ts-expect-error Selection DTOs are immutable.',
    "selection.source = 'system';",
    '// @ts-expect-error Renderer candidates contain opaque ids, not renderer-selected executable paths.',
    "const invalidScan: RcloneBinaryScanDto = { scanId: 'scan', selection: scan.selection, candidates: [{ id: 'candidate', source: 'bundled', path: '/tmp/rclone', selected: true }] };",
    'disposable.dispose();',
    'void service; void registered; void pluginVisible; void scan; void selection; void invalidScan;',
    'void (false as unknown as ListResult);',
    'void (false as unknown as SelectResult);',
    'void (false as unknown as RefreshResult);',
    'void (false as unknown as InitializeResult);'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__rclone-settings-types-contract.ts',
    source
  });
});
