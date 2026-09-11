'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('workbench layout contracts keep the shell service private and disposable', () => {
  const source = [
    "import { createWorkbenchLayoutService, WORKBENCH_LAYOUT_SERVICE_ID } from '../src/workbench-layout';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPluginServiceMap, RendererServiceMap, WorkbenchApplyOptionsDto, WorkbenchLayoutDependencies, WorkbenchLayoutFacade, WorkbenchLayoutService, WorkbenchLayoutSnapshotDto, WorkbenchPersistentStateDto } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'getState' | 'apply' | 'refreshControls' | 'refreshContext' | 'registerPrimaryView' | 'unregisterPrimaryView' | 'setPrimaryView' | 'setPrimaryVisible' | 'togglePrimary' | 'setPanelVisible' | 'togglePanel' | 'revealPanel' | 'ensureBottomPanelSize' | 'setPanelPosition' | 'togglePanelPosition' | 'togglePanelMaximized' | 'setDensity' | 'setFocusMode' | 'setAuxiliaryVisible' | 'toggleAuxiliary' | 'reset';",
    'type FacadeIsExact = AssertTrue<Equal<keyof WorkbenchLayoutFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof WorkbenchLayoutService, FacadeKeys | 'dispose' | 'disposed'>>;",
    "type DependenciesAreExact = AssertTrue<Equal<keyof WorkbenchLayoutDependencies, 'document' | 'eventTarget' | 'state' | 'storage' | 'requestAnimationFrame' | 'cancelAnimationFrame' | 'setTimer' | 'clearTimer' | 'getComputedStyle' | 'createCustomEvent' | 'createMutationObserver' | 'getCommands' | 'getTerminal' | 'getFileSearch' | 'getSettings' | 'getProjects' | 'getCollaboration' | 'getAiAgentButton' | 'getAiChatPanel' | 'getSwitchToPanel' | 'reportError'>>;",
    'type ServiceIsDisposable = AssertTrue<WorkbenchLayoutService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.layout'], WorkbenchLayoutService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.layout' extends keyof RendererPluginServiceMap ? true : false>;",
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createWorkbenchLayoutService>>>;',
    "const serviceId: 'workbench.layout' = WORKBENCH_LAYOUT_SERVICE_ID;",
    'declare const dependencies: WorkbenchLayoutDependencies;',
    'declare const snapshot: WorkbenchLayoutSnapshotDto;',
    'declare const persistent: WorkbenchPersistentStateDto;',
    'declare const options: WorkbenchApplyOptionsDto;',
    '// @ts-expect-error Layout snapshots are immutable DTOs.',
    "snapshot.activity = 'search';",
    '// @ts-expect-error Persistent layout state is immutable.',
    'persistent.sidebarWidth = 300;',
    'const service: WorkbenchLayoutService = createWorkbenchLayoutService(dependencies);',
    'const facade: WorkbenchLayoutFacade = service;',
    'const disposable: Disposable = service;',
    'service.init(); service.apply(options); service.setPrimaryView("explorer"); service.dispose();',
    '// @ts-expect-error The workbench layout service has a closed compatibility surface.',
    'service.reload();',
    'void serviceId; void snapshot; void persistent; void facade; void disposable;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__workbench-layout-types-contract.ts',
    source
  });
});

