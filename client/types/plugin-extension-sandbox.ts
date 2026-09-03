import type { Disposable } from './lifecycle';

/** Narrow DOM target used to attach an isolated extension iframe. */
export interface PluginExtensionSandboxMountTarget {
  appendChild(node: HTMLIFrameElement): unknown;
}

/** Injectable document surface used by the renderer sandbox factory. */
export interface PluginExtensionSandboxDocument {
  readonly body?: PluginExtensionSandboxMountTarget | null;
  readonly documentElement?: PluginExtensionSandboxMountTarget | null;
  createElement(tagName: 'iframe'): HTMLIFrameElement;
}

export interface PluginExtensionSandboxOptions {
  readonly document?: PluginExtensionSandboxDocument;
  readonly MessageChannel?: typeof MessageChannel;
  readonly connectTimeoutMs?: number;
  /** Messages remain untrusted until the extension host validates the protocol DTO. */
  readonly onMessage?: (message: unknown) => void;
  readonly onFatal?: (error: unknown) => void;
}

export interface PluginExtensionSandbox extends Disposable {
  readonly ready: Promise<void>;
  postMessage(message: unknown): void;
}

export type PluginExtensionSandboxFactory = (
  options?: PluginExtensionSandboxOptions
) => PluginExtensionSandbox;
