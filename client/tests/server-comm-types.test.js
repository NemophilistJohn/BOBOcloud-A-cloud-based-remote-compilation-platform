'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('server communication keeps its five-key facade and private disposable service contract', () => {
  const source = [
    "import { createServerCommService, SERVER_COMM_SERVICE_ID } from '../src/server-comm';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, ServerCommDependencies, ServerCommFacade, ServerCommOutputUpdateOptionsDto, ServerCommRequestOptionsDto, ServerCommService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'updateRunOutput' | 'clearRunOutput' | 'clearRunOutputDetails' | 'refreshRunOutputOmission' | 'sendToServer';",
    'type FacadeIsExact = AssertTrue<Equal<keyof ServerCommFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof ServerCommService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<ServerCommService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.serverComm'], ServerCommService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.serverComm' extends keyof RendererPluginServiceMap ? true : false>;",
    'type DependencyKeys =',
    "  'document' | 'getState' | 'getI18n' | 'getTransport' | 'getWorkspace' | 'getAuth' | 'getRunOutput' | 'getLocalPathSeparator' | 'fetch' | 'createAbortController' | 'setTimeout' | 'clearTimeout';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof ServerCommDependencies, DependencyKeys>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createServerCommService>>>;',
    "const serviceId: 'workbench.serverComm' = SERVER_COMM_SERVICE_ID;",
    'declare const dependencies: ServerCommDependencies;',
    'declare const outputOptions: ServerCommOutputUpdateOptionsDto;',
    'declare const requestOptions: ServerCommRequestOptionsDto;',
    'const service: ServerCommService = createServerCommService(dependencies);',
    'const facade: ServerCommFacade = service;',
    'service.updateRunOutput("hello", outputOptions);',
    'service.clearRunOutput(); service.clearRunOutputDetails(); service.refreshRunOutputOmission();',
    'service.sendToServer("serverInfo", {}, requestOptions); service.dispose();',
    '// @ts-expect-error Server communication exposes a closed compatibility surface.',
    'service.retry();',
    '// @ts-expect-error Server communication is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.serverComm');",
    'void serviceId; void facade;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__server-comm-types-contract.ts',
    source
  });
});
