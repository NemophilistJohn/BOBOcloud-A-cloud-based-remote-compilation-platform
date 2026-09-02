import type { RcloneClient } from '../src/rclone-client';
import type {
  CloudFeaturePolicyService,
  ServerCapabilityService,
  ServerTransportService
} from './server-runtime';
import type { Disposable, DisposableStore } from './lifecycle';
import type { RcloneNativeHost } from './native-host';

export interface RendererServiceMap {
  readonly 'host.rclone': Readonly<RcloneNativeHost>;
  readonly 'workbench.rclone': RcloneClient;
  readonly 'workbench.serverTransport': Readonly<ServerTransportService>;
  readonly 'workbench.serverCapabilities': ServerCapabilityService;
  readonly 'workbench.cloudFeaturePolicy': Readonly<CloudFeaturePolicyService>;
}

export type { Disposable, DisposableStore } from './lifecycle';

export interface ServiceRegistrationOptions<Service> {
  readonly owner?: string;
  readonly exposeToPlugins?: boolean;
  readonly pluginView?: unknown;
  readonly dispose?: (service: Service) => void;
}

export interface ServiceDescription {
  readonly id: string;
  readonly owner: string;
  readonly exposeToPlugins: boolean;
}

export interface ServiceRegistry<Services extends object> extends Disposable {
  register<ServiceId extends keyof Services & string>(
    id: ServiceId,
    service: Services[ServiceId],
    options?: ServiceRegistrationOptions<Services[ServiceId]>
  ): Disposable;
  has<ServiceId extends keyof Services & string>(id: ServiceId): boolean;
  get<ServiceId extends keyof Services & string>(id: ServiceId): Services[ServiceId] | undefined;
  require<ServiceId extends keyof Services & string>(id: ServiceId): Services[ServiceId];
  describe(): readonly ServiceDescription[];
  disposeOwner(owner: string): void;
}

export interface RendererPlatform {
  readonly lifecycle: DisposableStore;
  readonly services: ServiceRegistry<RendererServiceMap>;
}
