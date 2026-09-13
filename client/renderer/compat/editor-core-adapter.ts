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
  EditorCoreMarkerDto,
  EditorCoreModelPort,
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
import type {
  EditorRuleMonacoPort,
  EditorRuleRegistryPort,
  EditorRuleTextModelPort
} from '../../types/editor-rules';
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

type EditorCoreRuleModelCandidate = EditorCoreModelPort & {
  readonly getValue?: () => string;
};

function getRegisteredEditorRules(): EditorRuleRegistryPort | undefined {
  return rendererPlatform.services.get('workbench.editorRules') ||
    legacyWindow.editorRuleRegistry as unknown as EditorRuleRegistryPort | undefined;
}

function asEditorRuleModel(model: EditorCoreModelPort): EditorRuleTextModelPort | null {
  const candidate = model as EditorCoreRuleModelCandidate;
  if (typeof candidate.getValue !== 'function' || typeof candidate.getLineCount !== 'function') {
    return null;
  }
  return candidate as unknown as EditorRuleTextModelPort;
}

function asEditorRuleMonaco(monaco: EditorCoreMonacoPort): EditorRuleMonacoPort | null {
  if (!monaco || !monaco.MarkerSeverity) return null;
  return monaco as unknown as EditorRuleMonacoPort;
}

// Keep a stable bridge object for editor-core while resolving the private
// service on every call. This preserves replacement semantics and remains
// correct when an embedding loads adapters in a different order.
const editorRuleRegistryBridge: EditorCoreRuleRegistryPort = {
  getSyntaxMarkers(model, monaco, options): readonly EditorCoreMarkerDto[] {
    const currentEditorRules = getRegisteredEditorRules();
    const ruleModel = asEditorRuleModel(model);
    const ruleMonaco = asEditorRuleMonaco(monaco);
    if (!currentEditorRules || !ruleModel || !ruleMonaco) return [];
    return currentEditorRules.getSyntaxMarkers(ruleModel, ruleMonaco, options);
  }
};

function getEditorRuleRegistry(): EditorCoreRuleRegistryPort | null | undefined {
  return getRegisteredEditorRules() ? editorRuleRegistryBridge : undefined;
}

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
  getRuleRegistry: getEditorRuleRegistry,
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
