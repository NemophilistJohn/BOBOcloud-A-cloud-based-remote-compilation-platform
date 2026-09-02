export type Dispose = () => void;

export interface Disposable {
  dispose(): void;
}

export interface MaybeAsyncDisposable {
  dispose(): void | PromiseLike<void>;
}

export interface DisposableStore extends Disposable {
  readonly disposed: boolean;
  add<Value extends Disposable>(disposable: Value): Value;
  addAsync<Value extends MaybeAsyncDisposable>(disposable: Value): Value;
  delete(disposable: MaybeAsyncDisposable): boolean;
  clear(): void;
  disposeAsync(): Promise<void>;
}
