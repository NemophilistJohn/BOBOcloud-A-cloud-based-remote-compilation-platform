import type { Disposable } from './lifecycle';

export type TabOrderPosition = 'before' | 'after';

export interface TabOrderTab {
  readonly path?: unknown;
  readonly [key: string]: unknown;
}

export interface TabOrderFacade {
  reorder<Tab extends TabOrderTab>(
    tabs: Tab[],
    sourcePath: unknown,
    targetPath: unknown,
    position: TabOrderPosition
  ): boolean;
}

export interface TabOrderService extends TabOrderFacade, Disposable {
  readonly disposed: boolean;
}
