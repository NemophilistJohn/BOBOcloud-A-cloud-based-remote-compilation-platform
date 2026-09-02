import type { NativeHost } from './native-host';

declare global {
  interface Window {
    /** Compatibility projection. New renderer code accesses it only in the host adapter. */
    readonly api: NativeHost;
  }
}

export {};
