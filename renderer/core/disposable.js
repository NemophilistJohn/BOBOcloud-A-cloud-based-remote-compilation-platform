export function toDisposable(dispose) {
  if (typeof dispose !== 'function') {
    throw new TypeError('A disposable requires a dispose function.');
  }

  let active = true;
  return Object.freeze({
    dispose() {
      if (!active) return;
      active = false;
      dispose();
    }
  });
}

export class DisposableStore {
  constructor(options = {}) {
    this._items = new Set();
    this._disposed = false;
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
  }

  get disposed() {
    return this._disposed;
  }

  add(disposable) {
    if (!disposable || typeof disposable.dispose !== 'function') {
      throw new TypeError('DisposableStore accepts objects with dispose().');
    }
    if (this._disposed) {
      this._disposeOne(disposable);
      return disposable;
    }
    this._items.add(disposable);
    return disposable;
  }

  delete(disposable) {
    return this._items.delete(disposable);
  }

  clear() {
    const items = Array.from(this._items).reverse();
    this._items.clear();
    for (const disposable of items) this._disposeOne(disposable);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.clear();
  }

  _disposeOne(disposable) {
    try {
      disposable.dispose();
    } catch (error) {
      this._onError({ source: 'lifecycle', error });
    }
  }
}
