import { toDisposable } from './disposable.js';
import type { Disposable } from '../../types/lifecycle';

type ServiceId<Services extends object> = Extract<keyof Services, string>;
type PluginServiceMap<Services extends object> = Partial<Record<keyof Services, unknown>>;
type PluginServiceId<Services extends object, PluginServices extends object> =
  Extract<keyof Services & keyof PluginServices, string>;
type PluginViewFor<PluginServices extends object, Id extends PropertyKey> =
  Id extends keyof PluginServices ? PluginServices[Id] : never;

export interface ServiceRegistryErrorEvent {
  readonly source: 'service-dispose';
  readonly id: string;
  readonly owner: string;
  readonly error: unknown;
}

export interface ServiceRegistryOptions {
  readonly onError?: (event: ServiceRegistryErrorEvent) => void;
}

interface ServiceRegistrationBase<Service> {
  readonly owner?: string;
  readonly dispose?: (service: Service) => void;
}

type ServiceExposureOptions<PluginView> =
  | {
      readonly exposeToPlugins?: false;
      readonly pluginView?: never;
    }
  | ([PluginView] extends [never]
      ? never
      : {
          readonly exposeToPlugins: true;
          readonly pluginView: PluginView;
        });

export type ServiceRegistrationOptions<Service, PluginView = Service> =
  ServiceRegistrationBase<Service> & ServiceExposureOptions<PluginView>;

export interface ServiceDescription {
  readonly id: string;
  readonly owner: string;
  readonly exposeToPlugins: boolean;
}

interface RuntimeServiceRegistrationOptions<Service> {
  readonly owner?: string;
  readonly exposeToPlugins?: boolean;
  readonly pluginView?: unknown;
  readonly dispose?: (service: Service) => void;
}

interface ServiceRecord {
  readonly id: string;
  readonly owner: string;
  readonly service: unknown;
  readonly exposeToPlugins: boolean;
  readonly pluginView: unknown;
  readonly disposeService: (() => void) | null;
}

function requireId(id: unknown, label: string): string {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError(label + ' must be a non-empty string.');
  }
  return id.trim();
}

function hasDisposeMethod(value: unknown): value is { dispose(): void } {
  return value !== null &&
    value !== undefined &&
    typeof (value as { dispose?: unknown }).dispose === 'function';
}

export class ServiceRegistry<
  Services extends object = Record<string, unknown>,
  PluginServices extends PluginServiceMap<Services> = Services
> implements Disposable {
  private readonly _records: Map<string, ServiceRecord>;
  private readonly _onError: (event: ServiceRegistryErrorEvent) => void;
  private _disposed: boolean;

  constructor(options: ServiceRegistryOptions = {}) {
    this._records = new Map<string, ServiceRecord>();
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._disposed = false;
  }

  register<Id extends ServiceId<Services>>(
    id: Id,
    service: Services[Id],
    options?: ServiceRegistrationOptions<Services[Id], PluginViewFor<PluginServices, Id>>
  ): Disposable {
    if (this._disposed) throw new Error('ServiceRegistry has been disposed.');
    const serviceId = requireId(id, 'Service id');
    const registrationOptions = (options === undefined ? {} : options) as
      RuntimeServiceRegistrationOptions<Services[Id]>;
    const owner = requireId(registrationOptions.owner || 'core', 'Service owner');
    if (service === undefined || service === null) {
      throw new TypeError('Service "' + serviceId + '" requires a value.');
    }
    if (this._records.has(serviceId)) {
      throw new Error('Service already registered: ' + serviceId);
    }

    let disposeService = null;
    if (typeof registrationOptions.dispose === 'function') {
      disposeService = () => (
        registrationOptions.dispose as (registeredService: Services[Id]) => void
      )(service);
    } else if (hasDisposeMethod(service)) {
      disposeService = () => service.dispose();
    }

    const record: ServiceRecord = {
      id: serviceId,
      owner,
      service,
      exposeToPlugins: registrationOptions.exposeToPlugins === true,
      pluginView: registrationOptions.pluginView === undefined
        ? service
        : registrationOptions.pluginView,
      disposeService
    };
    this._records.set(serviceId, record);

    return toDisposable(() => this._removeRecord(record));
  }

  has<Id extends ServiceId<Services>>(id: Id): boolean {
    return this._records.has(id);
  }

  get<Id extends ServiceId<Services>>(id: Id): Services[Id] | undefined {
    const record = this._records.get(id);
    return record?.service as Services[Id] | undefined;
  }

  require<Id extends ServiceId<Services>>(id: Id): Services[Id] {
    const service = this.get(id);
    if (service === undefined) throw new Error('Unknown service: ' + id);
    return service;
  }

  getForPlugin<Id extends PluginServiceId<Services, PluginServices>>(
    id: Id
  ): PluginServices[Id] {
    return this.getForPluginDynamic(id);
  }

  /** Runtime boundary for service ids supplied by a validated plugin descriptor. */
  getForPluginDynamic<Id extends PluginServiceId<Services, PluginServices>>(
    id: Id
  ): PluginServices[Id];
  getForPluginDynamic<Id extends string>(
    id: Id
  ): Id extends keyof PluginServices ? PluginServices[Id] : unknown;
  getForPluginDynamic(id: string): unknown {
    const record = this._records.get(id);
    if (!record) throw new Error('Unknown service: ' + id);
    if (!record.exposeToPlugins) throw new Error('Service is not exposed to plugins: ' + id);
    return record.pluginView;
  }

  describe(): readonly ServiceDescription[] {
    return Array.from(this._records.values(), (record) => Object.freeze({
      id: record.id,
      owner: record.owner,
      exposeToPlugins: record.exposeToPlugins
    }));
  }

  disposeOwner(owner: string): void {
    const records = Array.from(this._records.values()).filter((record) => record.owner === owner).reverse();
    for (const record of records) this._removeRecord(record);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const records = Array.from(this._records.values()).reverse();
    for (const record of records) this._removeRecord(record);
  }

  private _removeRecord(record: ServiceRecord): void {
    if (this._records.get(record.id) !== record) return;
    this._records.delete(record.id);
    if (!record.disposeService) return;
    try {
      record.disposeService();
    } catch (error) {
      try {
        this._onError({ source: 'service-dispose', id: record.id, owner: record.owner, error });
      } catch (_) {
        // Error observers cannot interrupt registry cleanup.
      }
    }
  }
}
