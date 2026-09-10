'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('views contracts keep the host read capability private and the legacy facade exact', () => {
  const source = [
    "import { createViewsService, VIEWS_SERVICE_ID } from '../src/views';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  ViewsCodeEditorPort,',
    '  ViewsDependencies,',
    '  ViewsDiffModelDto,',
    '  ViewsFacade,',
    '  ViewsHost,',
    '  ViewsRendererState,',
    '  ViewsService,',
    '  ViewsTabDto,',
    '  ViewsTextModelPort',
    "} from '../types/views';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'openSplit' | 'closeSplit' | 'openDiff' | 'closeDiff' | 'showImagePreview' | 'closeImagePreview' | 'openThemePicker';",
    'type FacadeIsExact = AssertTrue<Equal<keyof ViewsFacade, FacadeKeys>>;',
    'type ServiceIsExact = AssertTrue<Equal<keyof ViewsService, FacadeKeys | \'dispose\' | \'disposed\'>>;',
    'type ServiceIsDisposable = AssertTrue<ViewsService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.views'], ViewsService>>;",
    "type HostServiceIsExact = AssertTrue<Equal<RendererServiceMap['host.views'], Readonly<ViewsHost>>>;",
    "type WorkbenchPluginAbsent = AssertFalse<'workbench.views' extends keyof RendererPluginServiceMap ? true : false>;",
    "type HostPluginAbsent = AssertFalse<'host.views' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.views' = VIEWS_SERVICE_ID;",
    'declare const dependencies: ViewsDependencies;',
    'declare const state: ViewsRendererState;',
    'const service: ViewsService = createViewsService(dependencies);',
    'const disposable: Disposable = service;',
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.views'] = service;",
    "const host: Readonly<ViewsHost> = (null as unknown as RendererServiceMap)['host.views'];",
    "const tab: ViewsTabDto = { path: 'src/main.ts', model: null };",
    'declare const model: ViewsTextModelPort;',
    'const editor: ViewsCodeEditorPort = state.editor as ViewsCodeEditorPort;',
    'const diff: ViewsDiffModelDto = { original: model, modified: model };',
    'const content: Promise<string> = host.readFile(tab.path);',
    'service.init();',
    'service.openSplit(); service.closeSplit();',
    "service.openDiff('a.ts', 'b.ts'); service.closeDiff();",
    "service.showImagePreview('C:/image.png', 'image.png'); service.closeImagePreview();",
    'service.openThemePicker(); service.dispose();',
    '// @ts-expect-error Views service methods are a closed compatibility surface.',
    "service.openDiff('a.ts', 7);",
    '// @ts-expect-error Native view authority is private to the trusted workbench.',
    "platform.services.getForPlugin('host.views');",
    '// @ts-expect-error The views service is not exposed to downloaded plugins.',
    "platform.services.getForPlugin('workbench.views');",
    "const required: ViewsService = platform.services.require('workbench.views');",
    "const requiredHost: Readonly<ViewsHost> = platform.services.require('host.views');",
    'void serviceId; void disposable; void registered; void host; void state; void editor;',
    'void diff; void content; void required; void requiredHost;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__views-types-contract.ts',
    source
  });
});
