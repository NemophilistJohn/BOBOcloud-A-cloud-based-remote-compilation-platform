import type { NativeHost } from './native-host';
import type { I18nChangeEvent } from './i18n';

declare global {
  interface Window {
    /** Compatibility projection. New renderer code accesses it only in the host adapter. */
    readonly api: NativeHost;
  }

  interface WindowEventMap {
    'bobo:language-changed': CustomEvent<I18nChangeEvent>;
  }
}

export {};
