import {
  createWorkspaceSettingsService,
  WORKSPACE_SETTINGS_SERVICE_ID
} from '../../src/workspace-settings';
import type {
  WorkspaceSettingsDetectLanguage,
  WorkspaceSettingsEditorCorePort,
  WorkspaceSettingsEnvironmentActivityPort,
  WorkspaceSettingsFacade,
  WorkspaceSettingsFileSearchPort,
  WorkspaceSettingsLspPort,
  WorkspaceSettingsRendererState,
  WorkspaceSettingsRuntimePort,
  WorkspaceSettingsWorkspacePort
} from '../../types/workspace-settings';
import { rendererPlatform } from '../core/bootstrap';
import { WORKSPACE_SETTINGS_HOST_SERVICE_ID } from '../core/native-host-adapter';

interface LegacyWorkspaceSettingsBobo {
  state?: WorkspaceSettingsRendererState;
  detectLanguage?: WorkspaceSettingsDetectLanguage;
  editorCore?: WorkspaceSettingsEditorCorePort;
  runtime?: WorkspaceSettingsRuntimePort;
  lsp?: WorkspaceSettingsLspPort;
  environmentActivity?: WorkspaceSettingsEnvironmentActivityPort;
  workspace?: WorkspaceSettingsWorkspacePort;
  fileSearch?: WorkspaceSettingsFileSearchPort;
  workspaceSettings?: WorkspaceSettingsFacade;
}

type LegacyWorkspaceSettingsWindow = Window & {
  BOBO?: LegacyWorkspaceSettingsBobo;
};

const legacyWindow = window as LegacyWorkspaceSettingsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state;
if (!state) throw new Error('Renderer state must be initialized before workspace settings.');

export const workspaceSettings = createWorkspaceSettingsService({
  state,
  host: rendererPlatform.services.require(WORKSPACE_SETTINGS_HOST_SERVICE_ID),
  getDetectLanguage: () => {
    const detectLanguage = BOBO.detectLanguage;
    return typeof detectLanguage === 'function'
      ? (name, content) => detectLanguage.call(BOBO, name, content)
      : null;
  },
  getEditorCore: () => BOBO.editorCore,
  getRuntime: () => BOBO.runtime,
  getLsp: () => BOBO.lsp,
  getEnvironmentActivity: () => BOBO.environmentActivity,
  getWorkspace: () => BOBO.workspace,
  getFileSearch: () => BOBO.fileSearch,
  reportError: (phase, error) => {
    console.error('workspace settings ' + phase + ':', error);
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  WORKSPACE_SETTINGS_SERVICE_ID,
  workspaceSettings,
  { owner: 'core.workspace-settings', exposeToPlugins: false }
));

// Preserve the historical writable facade while keeping disposal registry-owned.
BOBO.workspaceSettings = {
  applySnapshot: workspaceSettings.applySnapshot,
  refreshForWorkspace: workspaceSettings.refreshForWorkspace,
  clear: workspaceSettings.clear,
  setMonaco: workspaceSettings.setMonaco,
  attachEditor: workspaceSettings.attachEditor,
  applyAll: workspaceSettings.applyAll,
  applyModel: workspaceSettings.applyModel,
  languageForFile: workspaceSettings.languageForFile,
  effectiveEditorSettings: workspaceSettings.effectiveEditorSettings,
  configValue: workspaceSettings.configValue,
  isPathExcluded: workspaceSettings.isPathExcluded,
  filterTreeChildren: workspaceSettings.filterTreeChildren
};
