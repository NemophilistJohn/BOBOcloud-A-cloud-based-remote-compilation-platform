import type { Disposable } from './lifecycle';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastIconPort {
  readonly check?: string;
  readonly close?: string;
  readonly cloud?: string;
}

export interface ToastFacade {
  success(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

export interface ToastDependencies {
  readonly document: Document;
  readonly getIcons: () => ToastIconPort | null | undefined;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}

export interface ToastService extends ToastFacade, Disposable {
  readonly disposed: boolean;
}
