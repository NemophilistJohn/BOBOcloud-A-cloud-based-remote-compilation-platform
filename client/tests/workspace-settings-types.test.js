'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('workspace settings contracts keep host authority private and lifecycle-owned', () => {
  const source = [
    "import { createWorkspaceSettingsService, WORKSPACE_SETTINGS_SERVICE_ID } from '../src/workspace-settings';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { NativeHost } from '../types/native-host';",
    "import type { RendererPluginServiceMap, RendererServiceMap, WorkspaceSettingsDependencies, WorkspaceSettingsFacade, WorkspaceSettingsHost, WorkspaceSettingsLanguageIdDto, WorkspaceSettingsRequestDto, WorkspaceSettingsService, WorkspaceSettingsSnapshotDto } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'applySnapshot' | 'refreshForWorkspace' | 'clear' | 'setMonaco' | 'attachEditor' | 'applyAll' | 'applyModel' | 'languageForFile' | 'effectiveEditorSettings' | 'configValue' | 'isPathExcluded' | 'filterTreeChildren';",
    'type FacadeIsExact = AssertTrue<Equal<keyof WorkspaceSettingsFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof WorkspaceSettingsService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<WorkspaceSettingsService extends Disposable ? true : false>;',
    "type HostIsExact = AssertTrue<Equal<keyof WorkspaceSettingsHost, 'read' | 'onDidChange'>>;",
    "type HostMapIsExact = AssertTrue<Equal<RendererServiceMap['host.workspaceSettings'], Readonly<WorkspaceSettingsHost>>>;",
    "type NativeRequestIsExact = AssertTrue<Equal<Parameters<NativeHost['readWorkspaceSettings']>[0], WorkspaceSettingsRequestDto>>;",
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.workspaceSettings'], WorkspaceSettingsService>>;",
    "type PluginHostAbsent = AssertFalse<'host.workspaceSettings' extends keyof RendererPluginServiceMap ? true : false>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.workspaceSettings' extends keyof RendererPluginServiceMap ? true : false>;",
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createWorkspaceSettingsService>>>;',
    "const serviceId: 'workbench.workspaceSettings' = WORKSPACE_SETTINGS_SERVICE_ID;",
    "const language: WorkspaceSettingsLanguageIdDto = 'typescript';",
    '// @ts-expect-error Language identifiers are a closed, validated DTO union.',
    "const invalidLanguage: WorkspaceSettingsLanguageIdDto = 'vue';",
    "declare const request: WorkspaceSettingsRequestDto;",
    '// @ts-expect-error Host requests are immutable value DTOs.',
    "request.rootPath = 'C:/other';",
    'declare const snapshot: WorkspaceSettingsSnapshotDto;',
    '// @ts-expect-error Validated snapshots are immutable.',
    'snapshot.settings.editor.tabSize = 8;',
    'declare const dependencies: WorkspaceSettingsDependencies;',
    'const service: WorkspaceSettingsService = createWorkspaceSettingsService(dependencies);',
    'service.applyAll(); service.clear(); service.dispose();',
    '// @ts-expect-error The workspace settings service has a closed compatibility surface.',
    'service.reload();',
    'void ({} as RendererServiceMap);',
    'void serviceId; void language; void invalidLanguage; void service;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__workspace-settings-types-contract.ts',
    source
  });
});
