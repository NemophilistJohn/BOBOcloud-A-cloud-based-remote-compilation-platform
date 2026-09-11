import {
  createWorkspaceSyncStatus,
  WORKSPACE_SYNC_STATUS_SERVICE_ID
} from '../../src/workspace-sync-status';
import type {
  WorkspaceSyncProvider,
  WorkspaceSyncStatusFacade
} from '../../types/workspace-sync-status';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyWorkspaceSyncBobo {
  workspaceSyncStatus?: WorkspaceSyncStatusFacade;
  i18n?: {
    t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
  };
  workspace?: {
    refreshFileDecorations?(lane?: string): unknown;
  };
  icons?: {
    cloud?: string;
  };
}

type LegacyWorkspaceSyncWindow = Window & {
  BOBO?: LegacyWorkspaceSyncBobo;
};

const legacyWindow = window as LegacyWorkspaceSyncWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
export const workspaceSyncStatus = createWorkspaceSyncStatus({
  document,
  events: legacyWindow,
  requestFrame: typeof legacyWindow.requestAnimationFrame === 'function'
    ? (callback) => legacyWindow.requestAnimationFrame(callback)
    : undefined,
  cancelFrame: typeof legacyWindow.cancelAnimationFrame === 'function'
    ? (handle) => legacyWindow.cancelAnimationFrame(handle)
    : undefined,
  getI18n: () => BOBO.i18n,
  getWorkspace: () => BOBO.workspace,
  getCloudIcon: () => BOBO.icons?.cloud || '',
  registerContribution: (provider: WorkspaceSyncProvider) => (
    rendererPlatform.contributions.register('fileDecorations.sync', provider, {
      id: provider.id,
      owner: 'core.sync'
    })
  ),
  reportError: (phase, error) => {
    console.error('workspace sync ' + phase + ':', error);
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  WORKSPACE_SYNC_STATUS_SERVICE_ID,
  workspaceSyncStatus,
  { owner: 'core.sync', exposeToPlugins: false }
));

// Preserve the exact historical frozen facade without exposing registry-owned
// disposal to legacy callers.
BOBO.workspaceSyncStatus = Object.freeze({
  states: workspaceSyncStatus.states,
  provider: workspaceSyncStatus.provider,
  resetWorkspace: workspaceSyncStatus.resetWorkspace,
  clearWorkspace: workspaceSyncStatus.clearWorkspace,
  setTree: workspaceSyncStatus.setTree,
  markChanged: workspaceSyncStatus.markChanged,
  markDeleted: workspaceSyncStatus.markDeleted,
  markWorkspaceChanged: workspaceSyncStatus.markWorkspaceChanged,
  setBufferDirty: workspaceSyncStatus.setBufferDirty,
  handleFileEvent: workspaceSyncStatus.handleFileEvent,
  beginSync: workspaceSyncStatus.beginSync,
  finishSync: workspaceSyncStatus.finishSync,
  setConflicts: workspaceSyncStatus.setConflicts,
  getDecoration: workspaceSyncStatus.getDecoration,
  decorateRow: workspaceSyncStatus.decorateRow,
  refreshVisible: workspaceSyncStatus.refreshVisible,
  registerContribution: workspaceSyncStatus.registerContribution,
  toWorkspaceRelativePath: workspaceSyncStatus.toWorkspaceRelativePath
});
workspaceSyncStatus.registerContribution();
