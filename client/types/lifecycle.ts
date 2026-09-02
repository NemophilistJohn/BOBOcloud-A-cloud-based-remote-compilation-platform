export type Dispose = () => void;

export interface Disposable {
  dispose(): void;
}

export interface DisposableStore extends Disposable {
  readonly disposed: boolean;
  add<Value extends Disposable>(disposable: Value): Value;
  delete(disposable: Disposable): boolean;
  clear(): void;
}
