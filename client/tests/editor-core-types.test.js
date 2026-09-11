'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('editor core keeps its eight-method facade and private disposable service contract', () => {
  const source = [
    "import { createEditorCoreService, EDITOR_CORE_SERVICE_ID } from '../src/editor-core';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, EditorCoreDependencies, EditorCoreFacade, EditorCoreModelOptionsDto, EditorCoreService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'updateStatusBar' | 'updateDiagnosticsStatus' | 'refreshDiagnosticsForModel' | 'showFindWidget' | 'showReplaceWidget' | 'recheckAll' | 'checkActiveOnSave';",
    'type FacadeIsExact = AssertTrue<Equal<keyof EditorCoreFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof EditorCoreService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<EditorCoreService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.editorCore'], EditorCoreService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.editorCore' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'document' | 'eventTarget' | 'state' | 'getI18n' | 'getTheme' | 'getWorkspace' | 'getDap' | 'getProjectTasks' | 'getRunner' | 'getCommands' | 'getSettings' | 'getAiInline' | 'getTaskProblemMatcher' | 'getDiagnosticsSettings' | 'getWorkspaceSettings' | 'getRuleRegistry' | 'getLanguageDisplayName' | 'switchToPanel' | 'registerCompletionProviders' | 'setTimer' | 'clearTimer';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof EditorCoreDependencies, DependencyKeys>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createEditorCoreService>>>;',
    "const serviceId: 'workbench.editorCore' = EDITOR_CORE_SERVICE_ID;",
    'declare const dependencies: EditorCoreDependencies;',
    'declare const options: EditorCoreModelOptionsDto;',
    'const service: EditorCoreService = createEditorCoreService(dependencies);',
    'const facade: EditorCoreFacade = service;',
    'const disposable: Disposable = service;',
    'service.updateDiagnosticsStatus(); service.recheckAll(); service.checkActiveOnSave(); service.dispose();',
    '// @ts-expect-error Editor model options are immutable DTOs at the typed boundary.',
    'options.tabSize = 8;',
    '// @ts-expect-error Editor core exposes a closed compatibility surface.',
    'service.reload();',
    '// @ts-expect-error Editor core is intentionally absent from the downloaded-plugin service map.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.editorCore');",
    'void serviceId; void facade; void disposable;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__editor-core-types-contract.ts',
    source
  });
});

