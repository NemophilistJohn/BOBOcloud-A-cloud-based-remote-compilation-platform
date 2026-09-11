'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('output panel contracts keep the facade exact and service registry private', () => {
  const source = [
    "import { createOutputPanelService, OUTPUT_PANEL_SERVICE_ID } from '../src/output-panel';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, OutputPanelDependencies, OutputPanelFacade, OutputPanelService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'setupOutputResizer';",
    'type FacadeIsExact = AssertTrue<Equal<keyof OutputPanelFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof OutputPanelService, FacadeKeys | 'switchToPanel' | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<OutputPanelService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.outputPanel'], OutputPanelService>>;",
    "type PluginAbsent = AssertFalse<'workbench.outputPanel' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.outputPanel' = OUTPUT_PANEL_SERVICE_ID;",
    'declare const dependencies: OutputPanelDependencies;',
    'declare const platform: RendererPlatform;',
    'const service: OutputPanelService = createOutputPanelService(dependencies);',
    "const registered: RendererServiceMap['workbench.outputPanel'] = service;",
    'service.init(); service.setupOutputResizer(); service.switchToPanel("output"); service.dispose();',
    '// @ts-expect-error Compatibility consumers cannot invoke registry-owned disposal state as a method on the facade.',
    'const facade: OutputPanelFacade = service; facade.dispose();',
    '// @ts-expect-error The output panel is not exposed to downloaded plugins.',
    "platform.services.getForPlugin('workbench.outputPanel');",
    'void serviceId; void registered;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__output-panel-types-contract.ts',
    source
  });
});
