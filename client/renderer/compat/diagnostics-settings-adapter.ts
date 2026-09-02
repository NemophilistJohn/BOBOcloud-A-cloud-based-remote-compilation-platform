import {
  createDiagnosticsSettings,
  type DiagnosticsEditorCore,
  type DiagnosticsI18n,
  type DiagnosticsRendererState,
  type DiagnosticsRuleRegistry,
  type DiagnosticsToast
} from '../../src/diagnostics-settings';
import type { DiagnosticsSettingsService } from '../../types/diagnostics';
import { DIAGNOSTICS_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { rendererPlatform } from '../core/typed-platform';

export const DIAGNOSTICS_SETTINGS_SERVICE_ID = 'workbench.diagnosticsSettings';

interface LegacyBobo {
  state?: DiagnosticsRendererState;
  i18n?: DiagnosticsI18n;
  editorCore?: DiagnosticsEditorCore;
  toast?: DiagnosticsToast;
  diagnosticsSettings?: DiagnosticsSettingsService;
}

type DiagnosticsWindow = Window & {
  BOBO?: LegacyBobo;
  editorRuleRegistry?: DiagnosticsRuleRegistry;
};

const legacyWindow = window as DiagnosticsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Diagnostics settings requires renderer state.');

const diagnosticsSettings = createDiagnosticsSettings({
  host: rendererPlatform.services.require(DIAGNOSTICS_HOST_SERVICE_ID),
  document,
  languageEvents: legacyWindow,
  getState: () => BOBO.state as DiagnosticsRendererState,
  getI18n: () => BOBO.i18n,
  getRuleRegistry: () => legacyWindow.editorRuleRegistry,
  getEditorCore: () => BOBO.editorCore,
  getToast: () => BOBO.toast
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  DIAGNOSTICS_SETTINGS_SERVICE_ID,
  diagnosticsSettings,
  { owner: 'core.diagnostics', exposeToPlugins: false }
));

BOBO.diagnosticsSettings = diagnosticsSettings;
