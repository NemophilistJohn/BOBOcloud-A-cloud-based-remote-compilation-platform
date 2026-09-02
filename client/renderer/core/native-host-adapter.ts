import type {
  DiagnosticsHost,
  DiagnosticsOpenListener,
  DiagnosticsSettingsWriteDto
} from '../../types/diagnostics';
import type { NativeHost, RcloneNativeHost, RcloneProgressListener } from '../../types/native-host';
import { toDisposable } from './disposable.js';
import { rendererPlatform } from './typed-platform';

export const DIAGNOSTICS_HOST_SERVICE_ID = 'host.diagnostics';
export const RCLONE_HOST_SERVICE_ID = 'host.rclone';

function createDiagnosticsHost(host: NativeHost): Readonly<DiagnosticsHost> {
  return Object.freeze({
    readSettings: () => host.readDiagnosticsSettings(),
    writeSettings: (settings: DiagnosticsSettingsWriteDto) => host.writeDiagnosticsSettings(settings),
    onOpen: (listener: DiagnosticsOpenListener) => toDisposable(
      host.onOpenDiagnosticsSettings(() => listener())
    )
  });
}

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

const diagnosticsRegistration = rendererPlatform.services.register(
  DIAGNOSTICS_HOST_SERVICE_ID,
  createDiagnosticsHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(diagnosticsRegistration);

const rcloneRegistration = rendererPlatform.services.register(
  RCLONE_HOST_SERVICE_ID,
  createRcloneNativeHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(rcloneRegistration);
