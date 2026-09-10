import { createViewsService, VIEWS_SERVICE_ID } from '../../src/views';
import type {
  ViewsCollaborationPort,
  ViewsEditorCorePort,
  ViewsFacade,
  ViewsMonacoPort,
  ViewsRendererState,
  ViewsSettingsPort,
  ViewsWorkspaceSettingsPort
} from '../../types/views';
import { THEME_SERVICE_ID } from '../../src/theme-manager';
import { rendererPlatform } from '../core/bootstrap';
import { VIEWS_HOST_SERVICE_ID } from '../core/native-host-adapter';

interface LegacyViewsNamespace {
  state?: ViewsRendererState;
  collaboration?: ViewsCollaborationPort;
  workspaceSettings?: ViewsWorkspaceSettingsPort;
  editorCore?: ViewsEditorCorePort;
  settings?: ViewsSettingsPort;
  detectLanguage?: (name: string, content: string) => string;
  updateRunOutput?: (message: string) => void;
  views?: ViewsFacade;
}

type LegacyViewsWindow = Window & {
  BOBO?: LegacyViewsNamespace;
  monaco?: ViewsMonacoPort;
};

const legacyWindow = window as LegacyViewsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Views requires renderer state.');

const host = rendererPlatform.services.require(VIEWS_HOST_SERVICE_ID);
const theme = rendererPlatform.services.require(THEME_SERVICE_ID);
const views = createViewsService({
  document,
  state: BOBO.state,
  host,
  getMonaco: () => legacyWindow.monaco,
  getCollaboration: () => BOBO.collaboration,
  getWorkspaceSettings: () => BOBO.workspaceSettings,
  getEditorCore: () => BOBO.editorCore,
  getTheme: () => theme,
  getSettings: () => BOBO.settings,
  detectLanguage: (name, content) => {
    if (typeof BOBO.detectLanguage !== 'function') {
      throw new Error('Language detection is unavailable.');
    }
    return BOBO.detectLanguage.call(BOBO, name, content);
  },
  updateRunOutput: (message) => {
    if (typeof BOBO.updateRunOutput !== 'function') {
      throw new Error('Run output is unavailable.');
    }
    BOBO.updateRunOutput.call(BOBO, message);
  },
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs),
  clearTimer: (timer) => legacyWindow.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  VIEWS_SERVICE_ID,
  views,
  { owner: 'core.views', exposeToPlugins: false }
));

// Preserve the historical writable facade and insertion order.
BOBO.views = {
  init: views.init,
  openSplit: views.openSplit,
  closeSplit: views.closeSplit,
  openDiff: views.openDiff,
  closeDiff: views.closeDiff,
  showImagePreview: views.showImagePreview,
  closeImagePreview: views.closeImagePreview,
  openThemePicker: views.openThemePicker
};
