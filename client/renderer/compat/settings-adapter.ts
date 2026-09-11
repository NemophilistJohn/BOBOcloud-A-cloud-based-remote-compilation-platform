import {
  createSettingsService,
  SETTINGS_SERVICE_ID
} from '../../src/settings';
import type {
  SettingsAiServicePort,
  SettingsAiSettingsCenterPort,
  SettingsDependencies,
  SettingsDiagnosticsPort,
  SettingsFacade,
  SettingsI18nPort,
  SettingsLanguagePacksPort,
  SettingsLspPort,
  SettingsRendererState,
  SettingsRclonePort,
  SettingsThemePort,
  SettingsToastPort,
  SettingsWorkbenchPort
} from '../../types/settings';
import type { DiagnosticsSettingsService } from '../../types/diagnostics';
import type { I18nService } from '../../types/i18n';
import type { LanguagePacksPanelService } from '../../types/language-packs-panel';
import type { RendererState } from '../../types/state';
import type { RcloneSettingsFacade } from '../../types/rclone';
import type { ThemeManagerFacade } from '../../types/theme';
import type { ToastService } from '../../types/toast';
import type { WorkbenchLayoutFacade } from '../../types/workbench-layout';
import { rendererPlatform } from '../core/bootstrap';

interface LegacySettingsBobo {
  state?: RendererState;
  i18n?: I18nService;
  diagnosticsSettings?: DiagnosticsSettingsService;
  rcloneSettings?: RcloneSettingsFacade;
  workbench?: WorkbenchLayoutFacade;
  languagePacksPanel?: LanguagePacksPanelService;
  lsp?: SettingsLspPort;
  aiService?: SettingsAiServicePort;
  aiSettingsCenter?: SettingsAiSettingsCenterPort;
  toast?: ToastService;
  settings?: SettingsFacade;
}

type SettingsWindow = Window & {
  BOBO?: LegacySettingsBobo;
  themeManager?: ThemeManagerFacade;
};

const legacyWindow = window as SettingsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Settings requires renderer state.');

const settings = createSettingsService({
  document,
  window: legacyWindow,
  state: BOBO.state as unknown as SettingsRendererState,
  getI18n: () => BOBO.i18n as SettingsI18nPort | undefined,
  getThemeManager: () => legacyWindow.themeManager as SettingsThemePort | undefined,
  getToast: () => BOBO.toast as SettingsToastPort | undefined,
  getDiagnosticsSettings: () => BOBO.diagnosticsSettings as SettingsDiagnosticsPort | undefined,
  getRcloneSettings: () => BOBO.rcloneSettings as SettingsRclonePort | undefined,
  getWorkbench: () => BOBO.workbench as SettingsWorkbenchPort | undefined,
  getLanguagePacksPanel: () => BOBO.languagePacksPanel as SettingsLanguagePacksPort | undefined,
  getLsp: () => BOBO.lsp,
  getAiService: () => BOBO.aiService,
  getAiSettingsCenter: () => BOBO.aiSettingsCenter,
  logger: console
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  SETTINGS_SERVICE_ID,
  settings,
  { owner: 'core.settings', exposeToPlugins: false }
));

// Preserve the historical writable facade while keeping the implementation
// and disposal ownership inside the typed service registry.
BOBO.settings = {
  init: settings.init,
  open: settings.open,
  close: settings.close,
  openFirstRun: settings.openFirstRun,
  finishFirstRun: settings.finishFirstRun,
  isFirstRunOpen: settings.isFirstRunOpen
};
