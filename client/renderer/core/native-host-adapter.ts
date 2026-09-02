import type { NativeHost, RcloneNativeHost, RcloneProgressListener } from '../../types/native-host';
import { rendererPlatform } from './bootstrap.js';

export const RCLONE_HOST_SERVICE_ID = 'host.rclone';

function createRcloneNativeHost(host: NativeHost): Readonly<RcloneNativeHost> {
  return Object.freeze({
    rclonePrepareRemote: (payload: unknown) => host.rclonePrepareRemote(payload),
    rcloneSync: (payload: unknown) => host.rcloneSync(payload),
    rclonePull: (payload: unknown) => host.rclonePull(payload),
    rcloneCancel: (operationId: string) => host.rcloneCancel(operationId),
    rcloneCancelAll: (reason: unknown) => host.rcloneCancelAll(reason),
    rcloneListBinaries: () => host.rcloneListBinaries(),
    rcloneGetSelection: () => host.rcloneGetSelection(),
    rcloneSelectBinary: (payload: unknown) => host.rcloneSelectBinary(payload),
    rcloneCheckVersion: () => host.rcloneCheckVersion(),
    rcloneValidateConnection: () => host.rcloneValidateConnection(),
    onRcloneProgress: (operationId: string, listener: RcloneProgressListener) => (
      host.onRcloneProgress(operationId, listener)
    )
  });
}

// This is the only new renderer module allowed to read the preload global.
// Domain services below it expose narrower capabilities and remain host-only.
const nativeHost = window.api;
if (!nativeHost || typeof nativeHost !== 'object') {
  throw new Error('The BOBOCLOUD native host bridge is unavailable.');
}

const registration = rendererPlatform.services.register(
  RCLONE_HOST_SERVICE_ID,
  createRcloneNativeHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(registration);
