import type { RcloneClient } from '../src/rclone-client';
import type { DiagnosticsHost, DiagnosticsSettingsService } from './diagnostics';
import type {
  ProjectTasksHost,
  ProjectTasksPluginView,
  ProjectTasksService
} from './project-tasks';
import type {
  CloudFeaturePolicyService,
  ServerCapabilityService,
  ServerTransportService
} from './server-runtime';
import type { DisposableStore } from './lifecycle';
import type { RcloneNativeHost } from './native-host';
import type { ServiceRegistry } from '../renderer/core/service-registry';

export interface RendererServiceMap {
  readonly 'host.diagnostics': Readonly<DiagnosticsHost>;
  readonly 'host.projectTasks': Readonly<ProjectTasksHost>;
  readonly 'host.rclone': Readonly<RcloneNativeHost>;
  readonly 'workbench.diagnosticsSettings': DiagnosticsSettingsService;
  readonly 'workbench.projectTasks': ProjectTasksService;
  readonly 'workbench.rclone': RcloneClient;
  readonly 'workbench.serverTransport': Readonly<ServerTransportService>;
  readonly 'workbench.serverCapabilities': ServerCapabilityService;
  readonly 'workbench.cloudFeaturePolicy': Readonly<CloudFeaturePolicyService>;
}

export interface RendererPluginServiceMap {
  readonly 'workbench.projectTasks': ProjectTasksPluginView;
}

export type { Disposable, DisposableStore } from './lifecycle';
export type {
  ServiceDescription,
  ServiceRegistrationOptions,
  ServiceRegistry,
  ServiceRegistryErrorEvent,
  ServiceRegistryOptions
} from '../renderer/core/service-registry';

export interface RendererPlatform {
  readonly lifecycle: DisposableStore;
  readonly services: ServiceRegistry<RendererServiceMap, RendererPluginServiceMap>;
}
