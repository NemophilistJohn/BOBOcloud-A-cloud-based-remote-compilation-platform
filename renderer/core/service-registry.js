import { toDisposable } from './disposable.js';

function requireId(id, label) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError(label + ' must be a non-empty string.');
  }
  return id.trim();
}

export class ServiceRegistry {
  constructor(options = {}) {
    this._records = new Map();
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._disposed = false;
  }

  register(id, service, options = {}) {
    if (this._disposed) throw new Error('ServiceRegistry has been disposed.');
    const serviceId = requireId(id, 'Service id');
    const owner = requireId(options.owner || 'core', 'Service owner');
    if (service === undefined || service === null) {
      throw new TypeError('Service "' + serviceId + '" requires a value.');
    }
    if (this._records.has(serviceId)) {
      throw new Error('Service already registered: ' + serviceId);
    }

    let disposeService = null;
    if (typeof options.dispose === 'function') {
      disposeService = () => options.dispose(service);
    } else if (typeof service.dispose === 'function') {
      disposeService = () => service.dispose();
    }

    const record = {
      id: serviceId,
      owner,
      service,
      exposeToPlugins: options.exposeToPlugins === true,
      pluginView: options.pluginView === undefined ? service : options.pluginView,
      disposeService
    };
    this._records.set(serviceId, record);

    return toDisposable(() => this._removeRecord(record));
  }

  has(id) {
    return this._records.has(id);
  }

  get(id) {
    const record = this._records.get(id);
    return record && record.service;
  }

  require(id) {
    const service = this.get(id);
    if (service === undefined) throw new Error('Unknown service: ' + id);
    return service;
  }

  getForPlugin(id) {
    const record = this._records.get(id);
    if (!record) throw new Error('Unknown service: ' + id);
    if (!record.exposeToPlugins) throw new Error('Service is not exposed to plugins: ' + id);
    return record.pluginView;
  }

  describe() {
    return Array.from(this._records.values(), (record) => Object.freeze({
      id: record.id,
      owner: record.owner,
      exposeToPlugins: record.exposeToPlugins
    }));
  }

  disposeOwner(owner) {
    const records = Array.from(this._records.values()).filter((record) => record.owner === owner).reverse();
    for (const record of records) this._removeRecord(record);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const records = Array.from(this._records.values()).reverse();
    for (const record of records) this._removeRecord(record);
  }

  _removeRecord(record) {
    if (this._records.get(record.id) !== record) return;
    this._records.delete(record.id);
    if (!record.disposeService) return;
    try {
      record.disposeService();
    } catch (error) {
      this._onError({ source: 'service-dispose', id: record.id, owner: record.owner, error });
    }
  }
}
