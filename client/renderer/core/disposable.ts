import type {
  Disposable,
  DisposableStore as DisposableStoreContract,
  MaybeAsyncDisposable
} from '../../types/lifecycle';

export interface DisposableStoreErrorEvent {
  readonly source: 'lifecycle';
  readonly error: unknown;
}

export interface DisposableStoreOptions {
  readonly onError?: (event: DisposableStoreErrorEvent) => void;
}

export function toDisposable(dispose: () => void): Disposable {
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

function isPromiseLike(value: void | PromiseLike<void>): value is PromiseLike<void> {
  return value !== undefined && value !== null && typeof value.then === 'function';
}

export class DisposableStore implements DisposableStoreContract {
  private readonly _items = new Set<MaybeAsyncDisposable>();
  private readonly _asyncItems = new Set<MaybeAsyncDisposable>();
  private readonly _pending = new Set<Promise<void>>();
  private readonly _onError: (event: DisposableStoreErrorEvent) => void;
  private _disposed = false;
  private _disposePromise: Promise<void> | null = null;
  private _itemsToDispose: MaybeAsyncDisposable[] | null = null;
  private _asyncItemsToDispose: MaybeAsyncDisposable[] | null = null;

  constructor(options: DisposableStoreOptions = {}) {
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
  }

  get disposed(): boolean {
    return this._disposed;
  }

  add<Value extends Disposable>(disposable: Value): Value {
    this._requireDisposable(disposable);
    if (this._disposed) {
      if (this._itemsToDispose) this._itemsToDispose.push(disposable);
      else this._track(this._disposeOneNow(disposable));
      return disposable;
    }
    if (!this._asyncItems.has(disposable)) this._items.add(disposable);
    return disposable;
  }

  addAsync<Value extends MaybeAsyncDisposable>(disposable: Value): Value {
    this._requireDisposable(disposable);
    if (this._disposed) {
      if (this._asyncItemsToDispose) this._asyncItemsToDispose.push(disposable);
      else this._track(this._disposeOneNow(disposable));
      return disposable;
    }
    if (!this._items.has(disposable)) this._asyncItems.add(disposable);
    return disposable;
  }

  delete(disposable: MaybeAsyncDisposable): boolean {
    const removed = this._items.delete(disposable);
    return this._asyncItems.delete(disposable) || removed;
  }

  clear(): void {
    this._drainNow();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // Assign first so a disposer that re-enters disposeAsync observes the
    // same in-flight operation rather than an already-resolved placeholder.
    this._disposePromise = Promise.resolve().then(() => this._waitForPending());
    this._drainNow();
  }

  disposeAsync(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    this._asyncItemsToDispose = Array.from(this._asyncItems);
    this._itemsToDispose = Array.from(this._items);
    this._asyncItems.clear();
    this._items.clear();
    // Deferring the drain by one microtask makes the Promise observable before
    // any disposer can re-enter the store.
    this._disposePromise = Promise.resolve().then(() => this._disposeSequentially());
    return this._disposePromise;
  }

  private _requireDisposable(disposable: MaybeAsyncDisposable): void {
    if (!disposable || typeof disposable.dispose !== 'function') {
      throw new TypeError('DisposableStore accepts objects with dispose().');
    }
  }

  private _drainNow(): void {
    const asyncItems = Array.from(this._asyncItems).reverse();
    const items = Array.from(this._items).reverse();
    this._asyncItems.clear();
    this._items.clear();
    for (const disposable of [...asyncItems, ...items]) {
      this._track(this._disposeOneNow(disposable));
    }
  }

  private async _disposeSequentially(): Promise<void> {
    let observedEmpty = false;
    while (true) {
      const disposable = this._asyncItemsToDispose?.pop() || this._itemsToDispose?.pop();
      if (disposable) {
        observedEmpty = false;
        await this._disposeOneAsync(disposable);
        continue;
      }
      if (this._pending.size > 0) {
        observedEmpty = false;
        await Promise.all(Array.from(this._pending));
        continue;
      }
      if (!observedEmpty) {
        observedEmpty = true;
        await Promise.resolve();
        continue;
      }
      this._asyncItemsToDispose = null;
      this._itemsToDispose = null;
      return;
    }
  }

  private async _waitForPending(): Promise<void> {
    let observedEmpty = false;
    while (true) {
      if (this._pending.size > 0) {
        observedEmpty = false;
        await Promise.all(Array.from(this._pending));
        continue;
      }
      if (observedEmpty) return;
      observedEmpty = true;
      await Promise.resolve();
    }
  }

  private _track(promise: Promise<void> | null): void {
    if (!promise) return;
    this._pending.add(promise);
    void promise.then(() => this._pending.delete(promise));
  }

  private _disposeOneNow(disposable: MaybeAsyncDisposable): Promise<void> | null {
    try {
      const result = disposable.dispose();
      if (isPromiseLike(result)) {
        return Promise.resolve(result).catch((error: unknown) => this._report(error));
      }
    } catch (error) {
      this._report(error);
    }
    return null;
  }

  private async _disposeOneAsync(disposable: MaybeAsyncDisposable): Promise<void> {
    try {
      await disposable.dispose();
    } catch (error) {
      this._report(error);
    }
  }

  private _report(error: unknown): void {
    try {
      this._onError({ source: 'lifecycle', error });
    } catch (_) {
      // Cleanup observers cannot interrupt or replace the original teardown.
    }
  }
}
