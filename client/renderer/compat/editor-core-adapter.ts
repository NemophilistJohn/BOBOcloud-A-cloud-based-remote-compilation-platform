import {
  createEditorCoreService,
  EDITOR_CORE_SERVICE_ID
} from '../../src/editor-core';
import type {
  EditorCoreAiInlinePort,
  EditorCoreCommandsPort,
  EditorCoreDapPort,
  EditorCoreDiagnosticsSettingsPort,
  EditorCoreFacade,
  EditorCoreGlobalEventPort,
  EditorCoreI18nPort,
  EditorCoreMonacoPort,
  EditorCoreProjectTasksPort,
  EditorCoreRendererState,
  EditorCoreRuleRegistryPort,
  EditorCoreRunnerPort,
  EditorCoreService,
  EditorCoreSettingsPort,
  EditorCoreTaskProblemMatcherPort,
  EditorCoreThemePort,
  EditorCoreWorkspacePort,
  EditorCoreWorkspaceSettingsPort
} from '../../types/editor-core';
import type { I18nService } from '../../types/i18n';
import type { RendererState } from '../../types/state';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyEditorCoreBobo {
  state?: RendererState;
  i18n?: I18nService | EditorCoreI18nPort;
  workspace?: EditorCoreWorkspacePort;
  dap?: EditorCoreDapPort;
  projectTasks?: EditorCoreProjectTasksPort;
  runner?: EditorCoreRunnerPort;
  commands?: EditorCoreCommandsPort;
  settings?: EditorCoreSettingsPort;
  aiInline?: EditorCoreAiInlinePort;
  taskProblemMatcher?: EditorCoreTaskProblemMatcherPort;
  diagnosticsSettings?: EditorCoreDiagnosticsSettingsPort;
  workspaceSettings?: EditorCoreWorkspaceSettingsPort;
  langDisplayName?: (languageId: string) => string;
  switchToPanel?: (panelName: string) => unknown;
  editorCore?: EditorCoreFacade;
}

type LegacyEditorCoreWindow = Window & {
  BOBO?: LegacyEditorCoreBobo;
  themeManager?: EditorCoreThemePort;
  editorRuleRegistry?: EditorCoreRuleRegistryPort;
  registerCompletionProviders?: (monaco: EditorCoreMonacoPort) => unknown;
};

const legacyWindow = window as LegacyEditorCoreWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state;
if (!state) throw new Error('Editor core requires renderer state.');

const editorCore: EditorCoreService = createEditorCoreService({
  document,
  eventTarget: legacyWindow as EditorCoreGlobalEventPort,
  state: state as unknown as EditorCoreRendererState,
  getI18n: () => BOBO.i18n as EditorCoreI18nPort | undefined,
  getTheme: () => legacyWindow.themeManager,
  getWorkspace: () => BOBO.workspace,
  getDap: () => BOBO.dap,
  getProjectTasks: () => BOBO.projectTasks,
  getRunner: () => BOBO.runner,
  getCommands: () => BOBO.commands,
  getSettings: () => BOBO.settings,
  getAiInline: () => BOBO.aiInline,
  getTaskProblemMatcher: () => BOBO.taskProblemMatcher,
  getDiagnosticsSettings: () => BOBO.diagnosticsSettings,
  getWorkspaceSettings: () => BOBO.workspaceSettings,
  getRuleRegistry: () => legacyWindow.editorRuleRegistry,
  getLanguageDisplayName: (languageId) => (
    typeof BOBO.langDisplayName === 'function'
      ? BOBO.langDisplayName(languageId)
      : languageId
  ),
  switchToPanel: (panelName) => BOBO.switchToPanel?.call(BOBO, panelName),
  registerCompletionProviders: (monaco) => {
    const register = legacyWindow.registerCompletionProviders;
    if (typeof register !== 'function') {
      throw new Error('registerCompletionProviders is unavailable.');
    }
    return register.call(legacyWindow, monaco);
  },
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  EDITOR_CORE_SERVICE_ID,
  editorCore,
  { owner: 'core.editor-core', exposeToPlugins: false }
));

// Preserve the historical writable eight-method facade. Disposal remains
// owned by the private renderer service registry and is not projected.
BOBO.editorCore = {
  init: editorCore.init,
  updateStatusBar: editorCore.updateStatusBar,
  updateDiagnosticsStatus: editorCore.updateDiagnosticsStatus,
  refreshDiagnosticsForModel: editorCore.refreshDiagnosticsForModel,
  showFindWidget: editorCore.showFindWidget,
  showReplaceWidget: editorCore.showReplaceWidget,
  recheckAll: editorCore.recheckAll,
  checkActiveOnSave: editorCore.checkActiveOnSave
};

export { editorCore };

