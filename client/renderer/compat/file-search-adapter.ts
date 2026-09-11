import {
  createFileSearchService,
  FILE_SEARCH_SERVICE_ID
} from '../../src/file-search';
import type {
  FileSearchFacade,
  FileSearchFileIconsPort,
  FileSearchI18nPort,
  FileSearchIconsPort,
  FileSearchWorkbenchPort,
  FileSearchWorkspaceLaunchPort,
  FileSearchWorkspacePort,
  FileSearchWorkspaceSettingsPort
} from '../../types/file-search';
import type { RendererState } from '../../types/state';
import type { FileIconService } from '../../types/file-icons';
import type { RendererIconsFacade } from '../../types/icons';
import type { I18nService } from '../../types/i18n';
import type { WorkspaceLaunchFacade } from '../../types/workspace-launch';
import type { WorkspaceSettingsFacade } from '../../types/workspace-settings';
import type { WorkbenchLayoutFacade } from '../../types/workbench-layout';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyFileSearchBobo {
  state?: RendererState;
  i18n?: I18nService | FileSearchI18nPort;
  workspaceSettings?: WorkspaceSettingsFacade | FileSearchWorkspaceSettingsPort;
  fileIcons?: FileIconService | FileSearchFileIconsPort;
  icons?: RendererIconsFacade | FileSearchIconsPort;
  workspaceLaunch?: WorkspaceLaunchFacade | FileSearchWorkspaceLaunchPort;
  workspace?: FileSearchWorkspacePort;
  workbench?: WorkbenchLayoutFacade | FileSearchWorkbenchPort;
  fileSearch?: FileSearchFacade;
}

type LegacyFileSearchWindow = Window & { BOBO?: LegacyFileSearchBobo };

const legacyWindow = window as LegacyFileSearchWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state;
if (!state) throw new Error('File Search requires renderer state.');

let storage: Storage | null = null;
try {
  storage = legacyWindow.localStorage;
} catch (_) {
  storage = null;
}

export const fileSearch = createFileSearchService({
  document,
  eventTarget: legacyWindow,
  state,
  storage,
  getI18n: () => BOBO.i18n,
  getWorkspaceSettings: () => BOBO.workspaceSettings,
  getFileIcons: () => BOBO.fileIcons,
  getIcons: () => BOBO.icons,
  getWorkspaceLaunch: () => BOBO.workspaceLaunch,
  getWorkspace: () => BOBO.workspace,
  getWorkbench: () => BOBO.workbench,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  FILE_SEARCH_SERVICE_ID,
  fileSearch,
  { owner: 'core.file-search', exposeToPlugins: false }
));

// Preserve the historical writable facade while keeping disposal registry-owned.
BOBO.fileSearch = {
  show: fileSearch.show,
  hide: fileSearch.hide,
  refreshCache: fileSearch.refreshCache
};
