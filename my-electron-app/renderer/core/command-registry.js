import { toDisposable } from './disposable.js';

function requireId(id, label) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError(label + ' must be a non-empty string.');
  }
  return id.trim();
}

export class CommandRegistry {
  constructor(options = {}) {
    this._records = new Map();
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._disposed = false;
  }

  register(id, handler, metadata = {}) {
    if (this._disposed) throw new Error('CommandRegistry has been disposed.');
    const commandId = requireId(id, 'Command id');
    const owner = requireId(metadata.owner || 'core', 'Command owner');
    if (typeof handler !== 'function') {
      throw new TypeError('Command "' + commandId + '" requires a handler.');
    }
    if (this._records.has(commandId)) {
      throw new Error('Command already registered: ' + commandId);
    }

    const record = {
      id: commandId,
      owner,
      handler,
      title: typeof metadata.title === 'string' ? metadata.title : commandId,
      category: typeof metadata.category === 'string' ? metadata.category : '',
      permissions: Object.freeze(Array.isArray(metadata.permissions) ? [...metadata.permissions] : [])
    };
    this._records.set(commandId, record);
    return toDisposable(() => {
      if (this._records.get(commandId) === record) this._records.delete(commandId);
    });
  }

  has(id) {
    return this._records.has(id);
  }

  async execute(id, ...args) {
    const record = this._records.get(id);
    if (!record) throw new Error('Unknown command: ' + id);
    try {
      return await record.handler(...args);
    } catch (error) {
      this._onError({ source: 'command', id: record.id, owner: record.owner, error });
      throw error;
    }
  }

  async executeIsolated(id, ...args) {
    try {
      return { ok: true, value: await this.execute(id, ...args) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  describe() {
    return Array.from(this._records.values(), (record) => Object.freeze({
      id: record.id,
      owner: record.owner,
      title: record.title,
      category: record.category,
      permissions: record.permissions
    }));
  }

  disposeOwner(owner) {
    for (const [id, record] of this._records) {
      if (record.owner === owner) this._records.delete(id);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._records.clear();
  }
}
