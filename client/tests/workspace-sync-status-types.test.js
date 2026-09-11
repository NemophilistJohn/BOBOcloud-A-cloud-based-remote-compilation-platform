'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('workspace sync status keeps its state machine typed, private and disposable', () => {
  const source = [
    "import { createWorkspaceSyncStatus, STATUS_LABELS, STATUS_PRIORITY, WORKSPACE_SYNC_STATUS_SERVICE_ID } from '../src/workspace-sync-status';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap,',
    '  WorkspaceSyncContextDto,',
    '  WorkspaceSyncFileEventDto,',
    '  WorkspaceSyncProvider,',
    '  WorkspaceSyncStateDto,',
    '  WorkspaceSyncStatusDependencies,',
    '  WorkspaceSyncStatusFacade,',
    '  WorkspaceSyncStatusService,',
    '  WorkspaceSyncTreeNodeDto',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type StateIsExact = AssertTrue<Equal<WorkspaceSyncStateDto, 'synced' | 'local-only' | 'queued' | 'syncing' | 'error' | 'conflict'>>;",
    "type FacadeKey = 'states' | 'provider' | 'resetWorkspace' | 'clearWorkspace' | 'setTree' | 'markChanged' | 'markDeleted' | 'markWorkspaceChanged' | 'setBufferDirty' | 'handleFileEvent' | 'beginSync' | 'finishSync' | 'setConflicts' | 'getDecoration' | 'decorateRow' | 'refreshVisible' | 'registerContribution' | 'toWorkspaceRelativePath';",
    'type FacadeIsExact = AssertTrue<Equal<keyof WorkspaceSyncStatusFacade, FacadeKey>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof WorkspaceSyncStatusService, FacadeKey | 'dispose' | 'disposed'>>;",
    "type DependenciesAreExact = AssertTrue<Equal<keyof WorkspaceSyncStatusDependencies, 'document' | 'events' | 'requestFrame' | 'cancelFrame' | 'getI18n' | 'getWorkspace' | 'getCloudIcon' | 'registerContribution' | 'reportError'>>;",
    'type FactoryIsNotAny = AssertFalse<IsAny<ReturnType<typeof createWorkspaceSyncStatus>>>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.workspaceSyncStatus'], WorkspaceSyncStatusService>>;",
    "type PluginAbsent = AssertFalse<'workbench.workspaceSyncStatus' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.workspaceSyncStatus' = WORKSPACE_SYNC_STATUS_SERVICE_ID;",
    "const state: WorkspaceSyncStateDto = 'queued';",
    "const priority: number = STATUS_PRIORITY[state];",
    "const label: string = STATUS_LABELS[state];",
    'declare const dependencies: WorkspaceSyncStatusDependencies;',
    'const service: WorkspaceSyncStatusService = createWorkspaceSyncStatus(dependencies);',
    'const facade: WorkspaceSyncStatusFacade = service;',
    'const disposable: Disposable = service;',
    "const tree: WorkspaceSyncTreeNodeDto = { path: '/workspace', type: 'folder', children: [{ path: '/workspace/main.ts', type: 'file' }] };",
    "const event: WorkspaceSyncFileEventDto = { event: 'file-changed', path: '/workspace/main.ts', mutationId: 'save-1' };",
    'service.resetWorkspace(tree.path, tree);',
    'service.handleFileEvent(event);',
    'const context: WorkspaceSyncContextDto = service.beginSync({ force: true });',
    'service.finishSync(context, { success: true });',
    "const provider: WorkspaceSyncProvider = service.provider;",
    "const lane: 'sync' = provider.lane;",
    '// @ts-expect-error Sync contexts are immutable snapshots.',
    'context.revision = 2;',
    '// @ts-expect-error Sync contribution lanes are closed.',
    "provider.lane = 'scm';",
    '// @ts-expect-error The service surface does not expose mutable internal maps.',
    'service.entries.clear();',
    'declare const platform: RendererPlatform;',
    'const fromRegistry: WorkspaceSyncStatusService = platform.services.require(WORKSPACE_SYNC_STATUS_SERVICE_ID);',
    '// @ts-expect-error Workspace sync state is private to the trusted workbench.',
    "platform.services.getForPlugin('workbench.workspaceSyncStatus');",
    'service.dispose();',
    'void serviceId; void priority; void label; void facade; void disposable; void context;',
    'void provider; void lane; void fromRegistry;',
    'void (false as unknown as StateIsExact);',
    'void (false as unknown as FacadeIsExact);',
    'void (false as unknown as ServiceIsExact);',
    'void (false as unknown as DependenciesAreExact);',
    'void (false as unknown as FactoryIsNotAny);',
    'void (false as unknown as WorkbenchServiceIsExact);',
    'void (false as unknown as PluginAbsent);'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__workspace-sync-status-types-contract.ts',
    source
  });
});
