import type { RcloneNativeHost } from '../../types/native-host';
import { RCLONE_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { rendererPlatform } from '../core/bootstrap.js';
import {
  createRcloneClient,
  type RcloneClient,
  type RcloneRendererState
} from '../../src/rclone-client';

interface LegacyBobo {
  state?: RcloneRendererState;
  rclone?: RcloneClient;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const host = rendererPlatform.services.require(RCLONE_HOST_SERVICE_ID) as RcloneNativeHost;
const rcloneClient = createRcloneClient({
  host,
  state: BOBO.state || {}
});

const registration = rendererPlatform.services.register('workbench.rclone', rcloneClient, {
  owner: 'core',
  exposeToPlugins: false
});
rendererPlatform.lifecycle.add(registration);

// Existing host modules retain the same mutable facade. rclone-settings adds
// refreshStatus after its own initialization, so this projection cannot freeze.
BOBO.rclone = rcloneClient;
