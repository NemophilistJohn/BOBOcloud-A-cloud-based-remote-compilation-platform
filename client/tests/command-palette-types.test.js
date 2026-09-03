'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('command palette contracts preserve disposable registrations and host-only ownership', () => {
  const source = [
    "import { COMMAND_PALETTE_SERVICE_ID, createCommandPalette } from '../src/command-palette';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  CommandPaletteCommandDto,',
    '  CommandPaletteCommandHandler,',
    '  CommandPaletteFacade,',
    '  CommandPaletteRegistrationPort,',
    '  CommandPaletteService,',
    '  PluginExtensionCommandPalettePort,',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap',
    "} from '../types/renderer-platform';",
    "const serviceId: 'workbench.commandPalette' = COMMAND_PALETTE_SERVICE_ID;",
    'declare const document: Document;',
    'declare const window: Window;',
    'const service: CommandPaletteService = createCommandPalette({',
    '  document, eventTarget: window, getI18n: () => null,',
    '  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),',
    '  clearTimer: (timer) => window.clearTimeout(timer)',
    '});',
    'const handler: CommandPaletteCommandHandler = async () => true;',
    "const registration: Disposable = service.register('acme.command', 'Command', '', 'Extensions', handler);",
    'const registrationPort: CommandPaletteRegistrationPort = service;',
    'const extensionPort: PluginExtensionCommandPalettePort = service;',
    'const facade: CommandPaletteFacade = service;',
    "const descriptor: CommandPaletteCommandDto = { id: 'acme.command', label: 'Command', hint: '', category: 'Extensions' };",
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.commandPalette'] = platform.services.require('workbench.commandPalette');",
    "type HostOnly = 'workbench.commandPalette' extends keyof RendererPluginServiceMap ? true : false;",
    'const hostOnly: HostOnly = false;',
    '// @ts-expect-error The command palette is a host-owned presentation surface.',
    "platform.services.getForPlugin('workbench.commandPalette');",
    '// @ts-expect-error Palette handlers do not receive registry execution arguments.',
    "service.register('bad.handler', 'Bad', '', 'Tests', (value: unknown) => value);",
    '// @ts-expect-error Command descriptors are immutable.',
    "descriptor.label = 'Changed';",
    'registration.dispose(); service.dispose();',
    'void serviceId; void registrationPort; void extensionPort; void facade;',
    'void registered; void descriptor; void hostOnly;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__command-palette-types-contract.ts',
    source
  });
});
