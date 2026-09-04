import { RCLONE_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { rendererPlatform } from '../core/bootstrap';
import {
  createRcloneClient
} from '../../src/rclone-client';
import type {
  RcloneClient,
  RcloneRendererState
} from '../../types/rclone';

interface LegacyBobo {
  state?: RcloneRendererState;
  rclone?: RcloneClient;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const host = rendererPlatform.services.require(RCLONE_HOST_SERVICE_ID);
const rcloneClient = createRcloneClient({
  host,
  state: BOBO.state || {}
});

const registration = rendererPlatform.services.register('workbench.rclone', rcloneClient, {
  owner: 'core',
  exposeToPlugins: false
});
rendererPlatform.lifecycle.add(registration);

// Legacy modules and UI contracts replace methods at runtime. The settings
// adapter also adds refreshStatus, so this compatibility projection stays mutable.
BOBO.rclone = rcloneClient;
