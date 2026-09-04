import {
  createRcloneSettings,
  RCLONE_SETTINGS_SERVICE_ID
} from '../../src/rclone-settings';
import type {
  RcloneClient,
  RcloneSettingsFacade
} from '../../types/rclone';
import { rendererPlatform } from '../core/bootstrap';
import { I18N_SERVICE_ID } from './i18n-adapter';

interface LegacyRcloneClient extends RcloneClient {
  refreshStatus?: RcloneSettingsFacade['refreshStatus'];
}

interface LegacyBobo {
  rclone?: LegacyRcloneClient;
  rcloneSettings?: RcloneSettingsFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const rcloneClient = rendererPlatform.services.require('workbench.rclone');
const rcloneSettings = createRcloneSettings({
  document,
  window,
  client: rcloneClient,
  getI18n: () => rendererPlatform.services.get(I18N_SERVICE_ID)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  RCLONE_SETTINGS_SERVICE_ID,
  rcloneSettings,
  { owner: 'core.rclone-settings', exposeToPlugins: false }
));

// Preserve the historical facade, key order, and mutable rclone extension.
BOBO.rcloneSettings = {
  initialize: rcloneSettings.initialize,
  open: rcloneSettings.open,
  close: rcloneSettings.close,
  refreshStatus: rcloneSettings.refreshStatus
};
if (BOBO.rclone) BOBO.rclone.refreshStatus = rcloneSettings.refreshStatus;
