import type { Disposable } from './lifecycle';
import type {
  PluginExtensionHostBroker,
  PluginExtensionObservedErrorEvent
} from './plugin-extension-host';

export type PluginExtensionNativeHostAsyncValue<Value = unknown> =
  Value | PromiseLike<Value>;

export type PluginExtensionNativeHostSubscription = Disposable | null;

/**
 * Private renderer service projected by the unique preload host adapter.
 * Values crossing IPC remain unknown until the extension host validates them.
 */
export interface PluginExtensionNativeHost {
  readonly listDescriptors: () => PluginExtensionNativeHostAsyncValue<unknown>;
  readonly loadEntry: (id: string) => PluginExtensionNativeHostAsyncValue<unknown>;
  readonly loadLocalization?: (
    id: string,
    locale: string
  ) => PluginExtensionNativeHostAsyncValue<unknown>;
  readonly broker?: PluginExtensionHostBroker;
  readonly onDidChange?: (
    listener: () => void
  ) => PluginExtensionNativeHostSubscription;
  readonly onAgentModelEvent?: (
    listener: (payload: unknown) => void
  ) => PluginExtensionNativeHostSubscription;
}

export type PluginExtensionBootstrapErrorSource =
  | 'extension-bootstrap-dispose'
  | 'extension-bootstrap-subscribe';

export interface PluginExtensionBootstrapErrorEvent {
  readonly source: PluginExtensionBootstrapErrorSource;
  readonly id?: string;
  readonly error: unknown;
}

export type PluginExtensionBootstrapObservedErrorEvent =
  | PluginExtensionObservedErrorEvent
  | PluginExtensionBootstrapErrorEvent;
