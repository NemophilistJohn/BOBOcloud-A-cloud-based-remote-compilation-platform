import type { RcloneNativeHost } from '../types/native-host';
import type {
  RcloneClient,
  RcloneOperationOptions,
  RcloneRendererState
} from '../types/rclone';

export type {
  RcloneClient,
  RcloneOperationOptions,
  RcloneRendererState
} from '../types/rclone';

export interface RcloneClientOptions {
  host: RcloneNativeHost;
  state: RcloneRendererState;
  randomUUID?: () => string;
  now?: () => number;
}

interface WorkspaceLocalScope {
  type: 'workspace';
  rootPath?: string;
  workspaceIdentity?: unknown;
}

interface MappingLocalScope {
  type: 'mapping';
  grantId: string;
}

type LocalScope = WorkspaceLocalScope | MappingLocalScope;
type OperationKind = 'sync' | 'pull';

export function createRcloneClient(options: RcloneClientOptions): RcloneClient {
  const host = options.host;
  const state = options.state;
  const now = options.now || Date.now;
  const randomUUID = options.randomUUID || (() => {
    const cryptoValue = globalThis.crypto;
    return cryptoValue && typeof cryptoValue.randomUUID === 'function'
      ? cryptoValue.randomUUID()
      : '';
  });
  let operationSequence = 0;
  const activeOperationIds = new Set<string>();

  function nextOperationId(kind: string): string {
    operationSequence += 1;
    const generated = randomUUID();
    const randomPart = generated || now().toString(36) + '-' + operationSequence.toString(36);
    return 'rclone-' + kind + '-' + randomPart;
  }

  function localScope(operationOptions: RcloneOperationOptions, kind: OperationKind): LocalScope {
    const requestedLocalPath = kind === 'sync' ? operationOptions.src : operationOptions.dest;
    if (!operationOptions.localGrant && requestedLocalPath && requestedLocalPath !== state.workspaceRoot) {
      throw new Error('The requested rclone path is not the active workspace');
    }
    return operationOptions.localGrant
      ? { type: 'mapping', grantId: operationOptions.localGrant }
      : {
          type: 'workspace',
          rootPath: state.workspaceRoot,
          workspaceIdentity: state.workspaceIdentity
        };
  }

  async function invokeTracked<T>(kind: string, invoke: (operationId: string) => Promise<T>): Promise<T> {
    const operationId = nextOperationId(kind);
    activeOperationIds.add(operationId);
    try {
      return await invoke(operationId);
    } finally {
      activeOperationIds.delete(operationId);
    }
  }

  async function prepareRemote(
    kind: 'workspace' | 'team-pull',
    request: unknown,
    operationOptions: RcloneOperationOptions | null = {}
  ): Promise<unknown> {
    const safeOptions = operationOptions || {};
    return invokeTracked('prepare', (operationId) => host.rclonePrepareRemote({
      operationId,
      kind,
      request: request || {},
      localScope: localScope(safeOptions, kind === 'workspace' ? 'sync' : 'pull')
    }));
  }

  async function runOperation(
    kind: OperationKind,
    operationOptions: RcloneOperationOptions | null = {}
  ): Promise<unknown> {
    const safeOptions = operationOptions || {};
    if (typeof safeOptions.remoteGrantId !== 'string' || !safeOptions.remoteGrantId) {
      throw new Error('A prepared remote synchronization grant is required');
    }
    return invokeTracked(kind, async (operationId) => {
      let disposeProgress = () => {};
      if (typeof safeOptions.onProgress === 'function') {
        disposeProgress = host.onRcloneProgress(operationId, (line, progress) => {
          if ((!progress || !progress.operationId) &&
              (activeOperationIds.size !== 1 || !activeOperationIds.has(operationId))) return;
          safeOptions.onProgress?.(line);
        }) || disposeProgress;
      }
      try {
        const payload = {
          operationId,
          remoteGrantId: safeOptions.remoteGrantId,
          localScope: localScope(safeOptions, kind)
        };
        return kind === 'sync'
          ? await host.rcloneSync(payload)
          : await host.rclonePull(payload);
      } finally {
        disposeProgress();
      }
    });
  }

  return {
    prepareWorkspace: (request, operationOptions) => prepareRemote('workspace', request, operationOptions),
    prepareTeamPull: (request, operationOptions) => prepareRemote('team-pull', request, operationOptions),
    sync: (operationOptions) => runOperation('sync', operationOptions),
    pull: (operationOptions) => runOperation('pull', operationOptions),
    cancel: (operationId) => host.rcloneCancel(operationId),
    cancelAll: (reason) => host.rcloneCancelAll(reason || 'renderer-context-changed'),
    listBinaries: () => host.rcloneListBinaries(),
    getSelection: () => host.rcloneGetSelection(),
    selectBinary: (scanId, candidateId) => host.rcloneSelectBinary({ scanId, candidateId }),
    checkVersion: () => host.rcloneCheckVersion(),
    validateConnection: () => host.rcloneValidateConnection()
  };
}
