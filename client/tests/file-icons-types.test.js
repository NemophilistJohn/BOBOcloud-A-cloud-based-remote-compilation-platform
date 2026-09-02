'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('file icon contracts distinguish the mutable host service from its plugin view', () => {
  const source = [
    "import { createFileIconService, FILE_ICONS_SERVICE_ID } from '../src/file-icons';",
    'import type {',
    '  FileIconLookupService,',
    '  FileIconNameMap,',
    '  FileIconPluginView,',
    '  FileIconService,',
    '  FileIconServiceOptions,',
    '  RendererPlatform',
    "} from '../types/renderer-platform';",
    "const serviceId: 'workbench.fileIcons' = FILE_ICONS_SERVICE_ID;",
    "const overrides: FileIconNameMap = { '.bobo': 'bobocloud' };",
    'const options: FileIconServiceOptions = {',
    "  iconDirectory: 'assets/icons/', extensionMap: overrides, filenameMap: null",
    '};',
    'const service: FileIconService = createFileIconService(options);',
    'const lookup: FileIconLookupService = service;',
    'const icon: string | null = lookup.getFileIcon(null);',
    "service.extensionMap['.cloud'] = 'bobocloud';",
    'service.clearIconCache();',
    'declare const platform: RendererPlatform;',
    "const registered: FileIconService = platform.services.require('workbench.fileIcons');",
    "const pluginView: FileIconPluginView = platform.services.getForPlugin('workbench.fileIcons');",
    "pluginView.getFolderIcon('.git');",
    '// @ts-expect-error Frozen plugin lookup methods cannot be rebound.',
    'pluginView.getFileIcon = () => null;',
    '// @ts-expect-error Plugins cannot invalidate the host cache.',
    'pluginView.clearIconCache();',
    '// @ts-expect-error Plugins cannot mutate host icon maps.',
    "pluginView.extensionMap['.unsafe'] = 'unsafe';",
    '// @ts-expect-error File icon maps contain icon-name strings only.',
    "const invalidOptions: FileIconServiceOptions = { extensionMap: { '.bad': 42 } };",
    '// @ts-expect-error Frozen host service methods cannot be rebound.',
    'service.clearIconCache = () => {};',
    'void serviceId; void icon; void registered; void invalidOptions;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__file-icons-types-contract.ts',
    source
  });
});
