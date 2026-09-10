import type {
  TabOrderFacade,
  TabOrderPosition,
  TabOrderService,
  TabOrderTab
} from '../types/tab-order';

export const TAB_ORDER_SERVICE_ID = 'workbench.tabOrder' as const;

function indexOfPath<Tab extends TabOrderTab>(tabs: Tab[], filePath: unknown): number {
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (tab && tab.path === filePath) return index;
  }
  return -1;
}

export function reorderTabs<Tab extends TabOrderTab>(
  tabs: Tab[],
  sourcePath: unknown,
  targetPath: unknown,
  position: TabOrderPosition
): boolean {
  if (!Array.isArray(tabs) || (position !== 'before' && position !== 'after')) return false;
  const sourceIndex = indexOfPath(tabs, sourcePath);
  const targetIndex = indexOfPath(tabs, targetPath);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;

  let insertionIndex = targetIndex + (position === 'after' ? 1 : 0);
  if (sourceIndex < insertionIndex) insertionIndex -= 1;
  if (sourceIndex === insertionIndex) return false;

  const movedTab = tabs.splice(sourceIndex, 1)[0];
  if (!movedTab) return false;
  tabs.splice(insertionIndex, 0, movedTab);
  return true;
}

export function createTabOrderService(): TabOrderService {
  let disposed = false;
  const reorder = <Tab extends TabOrderTab>(
    tabs: Tab[],
    sourcePath: unknown,
    targetPath: unknown,
    position: TabOrderPosition
  ): boolean => disposed ? false : reorderTabs(tabs, sourcePath, targetPath, position);
  const facade: TabOrderFacade = { reorder };
  const service: TabOrderService = {
    get disposed() { return disposed; },
    reorder: facade.reorder,
    dispose() { disposed = true; }
  };
  return Object.freeze(service);
}
