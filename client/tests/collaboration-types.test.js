'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('collaboration keeps its typed host boundary, DTO action map, and private disposable facade', () => {
  const source = [
    "import { createCollaborationService, COLLABORATION_SERVICE_ID } from '../src/collaboration';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, CollaborationDependencies, CollaborationFacade, CollaborationHostPort, CollaborationServerRequestMap, CollaborationService, CollaborationTeamMappingDto } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'openHub' | 'openProfile' | 'clearCurrent' | 'restoreMapping' | 'updateTeamChrome' | 'refreshWorkbench' | 'uploadCurrent' | 'onFileOpened' | 'onFileClosed' | 'onFileActivated' | 'isActiveFileReadOnly' | 'releaseForLogout';",
    "type FacadeIsExact = AssertTrue<Equal<keyof CollaborationFacade, FacadeKeys>>;",
    "type ServiceIsExact = AssertTrue<Equal<keyof CollaborationService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<CollaborationService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.collaboration'], CollaborationService>>;",
    "type HostServiceIsExact = AssertTrue<Equal<RendererServiceMap['host.collaboration'], Readonly<CollaborationHostPort>>>;",
    "type WorkbenchPluginAbsent = AssertFalse<'workbench.collaboration' extends keyof RendererPluginServiceMap ? true : false>;",
    "type HostPluginAbsent = AssertFalse<'host.collaboration' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.collaboration' = COLLABORATION_SERVICE_ID;",
    'declare const dependencies: CollaborationDependencies;',
    'declare const mapping: CollaborationTeamMappingDto;',
    'const service: CollaborationService = createCollaborationService(dependencies);',
    'const facade: CollaborationFacade = service;',
    'const host: Readonly<CollaborationHostPort> = (null as unknown as RendererPlatform).services.require(\'host.collaboration\');',
    'void host.getWorkspaceIdentity(); void host.localPathInfo("C:/workspace");',
    'service.init(); void service.openHub(); service.openProfile(); service.clearCurrent(); service.restoreMapping(mapping); service.updateTeamChrome(); void service.refreshWorkbench(); void service.uploadCurrent(); void service.onFileOpened("C:/workspace/a.ts"); void service.onFileClosed("C:/workspace/a.ts"); service.onFileActivated("C:/workspace/a.ts"); service.isActiveFileReadOnly(); void service.releaseForLogout(); service.dispose();',
    'const listPayload: CollaborationServerRequestMap["listTeams"] = {};',
    '// @ts-expect-error Collaboration facade is a closed compatibility surface.',
    'service.open("team");',
    '// @ts-expect-error Collaboration host authority is private to the trusted renderer.',
    "(null as unknown as RendererPlatform).services.getForPlugin('host.collaboration');",
    '// @ts-expect-error Collaboration is not exposed to downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.collaboration');",
    'void serviceId; void facade; void listPayload;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__collaboration-types-contract.ts',
    source
  });
});
