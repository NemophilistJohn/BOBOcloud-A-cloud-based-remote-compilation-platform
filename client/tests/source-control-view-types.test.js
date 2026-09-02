'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('source-control view is a disposable host-only service with an explicit command port', () => {
  const source = [
    "import { createSourceControlViewService } from '../src/source-control-view';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap,',
    '  SourceControlCommandPayloadDto,',
    '  SourceControlViewCommandPort,',
    '  SourceControlViewDependencies,',
    '  SourceControlViewService',
    "} from '../types/renderer-platform';",
    'declare const dependencies: SourceControlViewDependencies;',
    'declare const platform: RendererPlatform;',
    'declare const commands: SourceControlViewCommandPort;',
    'declare const payload: SourceControlCommandPayloadDto;',
    'const service: SourceControlViewService = createSourceControlViewService(dependencies);',
    'const disposable: Disposable = service;',
    "const registered: RendererServiceMap['workbench.sourceControlView'] = service;",
    "const required: SourceControlViewService = platform.services.require('workbench.sourceControlView');",
    "commands.executeDynamicIsolated('acme.source-control.refresh', payload).then((result) => {",
    '  if (result.ok) void result.value;',
    '  else void result.error;',
    '});',
    "type HostOnly = 'workbench.sourceControlView' extends keyof RendererPluginServiceMap ? true : false;",
    'const hostOnly: HostOnly = false;',
    '// @ts-expect-error The host-rendered view is intentionally absent from the plugin service map.',
    "platform.services.getForPlugin('workbench.sourceControlView');",
    '// @ts-expect-error Runtime command ids still require the normalized source-control payload.',
    "commands.executeDynamicIsolated('acme.source-control.refresh', { arbitrary: true });",
    'service.init(); service.refresh(); disposable.dispose();',
    'void registered; void required; void hostOnly;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__source-control-view-types-contract.ts',
    source
  });
});
