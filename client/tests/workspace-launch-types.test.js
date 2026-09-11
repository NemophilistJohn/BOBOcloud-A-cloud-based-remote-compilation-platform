'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('workspace launch contracts keep picker authority private and disposable', () => {
  const source = [
    "import { createWorkspaceLaunchService, WORKSPACE_LAUNCH_SERVICE_ID } from '../src/workspace-launch';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { NativeHost } from '../types/native-host';",
    "import type { RendererPluginServiceMap, RendererServiceMap, WorkspaceLaunchDependencies, WorkspaceLaunchFacade, WorkspaceLaunchHost, WorkspaceLaunchOpenedWorkspaceDto, WorkspaceLaunchService, WorkspaceLaunchTreeNodeDto } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'requestOpen' | 'setConsumer' | 'whenIdle';",
    'type FacadeIsExact = AssertTrue<Equal<keyof WorkspaceLaunchFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof WorkspaceLaunchService, FacadeKeys | 'dispose' | 'disposed'>>;",
    "type HostIsExact = AssertTrue<Equal<keyof WorkspaceLaunchHost, 'pick' | 'forgetRecent' | 'onDidOpen'>>;",
    "type DependenciesAreExact = AssertTrue<Equal<keyof WorkspaceLaunchDependencies, 'document' | 'host' | 'storage' | 'getI18n' | 'reportError'>>;",
    'type ServiceIsDisposable = AssertTrue<WorkspaceLaunchService extends Disposable ? true : false>;',
    "type HostMapIsExact = AssertTrue<Equal<RendererServiceMap['host.workspaceLaunch'], Readonly<WorkspaceLaunchHost>>>;",
    "type WorkbenchMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.workspaceLaunch'], WorkspaceLaunchService>>;",
    "type PluginHostAbsent = AssertFalse<'host.workspaceLaunch' extends keyof RendererPluginServiceMap ? true : false>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.workspaceLaunch' extends keyof RendererPluginServiceMap ? true : false>;",
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createWorkspaceLaunchService>>>;',
    "const serviceId: 'workbench.workspaceLaunch' = WORKSPACE_LAUNCH_SERVICE_ID;",
    'declare const host: WorkspaceLaunchHost;',
    'declare const opened: WorkspaceLaunchOpenedWorkspaceDto;',
    'declare const nativeHost: NativeHost;',
    'const pickResult: Promise<WorkspaceLaunchOpenedWorkspaceDto | null> = nativeHost.pickWorkspace();',
    'const forgetResult: Promise<boolean> = nativeHost.forgetRecentWorkspace(opened.rootPath);',
    'const tree: WorkspaceLaunchTreeNodeDto = { name: "workspace", path: "/workspace", type: "folder" };',
    '// @ts-expect-error Workspace transition DTOs are immutable.',
    "opened.rootPath = '/other';",
    'declare const dependencies: WorkspaceLaunchDependencies;',
    'const service: WorkspaceLaunchService = createWorkspaceLaunchService(dependencies);',
    'const facade: WorkspaceLaunchFacade = service;',
    'const disposable: Disposable = service;',
    'const openedSubscription: Disposable = host.onDidOpen(() => {});',
    'service.init(); service.requestOpen(); service.setConsumer(() => true); service.whenIdle(); service.dispose();',
    '// @ts-expect-error The workspace launch service has a closed compatibility surface.',
    'service.reload();',
    'void serviceId; void pickResult; void forgetResult; void tree; void facade; void disposable; void openedSubscription;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__workspace-launch-types-contract.ts',
    source
  });
});
