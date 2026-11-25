import type { Dispose } from './lifecycle';

export interface SharedNode { id: string; after: string; value: string; deleted?: boolean }
export interface SharedFile {
  id: string; path: string; revision: number; binary?: boolean; directory?: boolean;
  content?: string; base64?: string; nodes?: SharedNode[];
}
export interface SharedPane {
  paneId: string; fileId: string; editing: boolean;
  cursor?: { anchor: string; focus: string };
}
export interface SharedPresence {
  userId: string; name: string; avatar?: string; sessionId: string; panes: SharedPane[]; held?: Record<string, string>;
}
export interface SharedDeletion {
  id: string; fileId: string; path?: string; requestedBy: string;
  expiresAt: string; electorate: string[]; consents: Record<string, boolean>;
}
export interface SharedRun {
  id: string; status: string; starterUserId: string; events?: Record<string, unknown>[]; omitted?: boolean;
  filePath?: string; taskLabel?: string; taskKind?: string; runtime?: string;
  createdAt?: string; completedAt?: string; sequence?: number;
}
export interface SharedState {
  enabled: boolean; epoch: string; branch: string; revision: number;
  files: SharedFile[]; presence: SharedPresence[]; deletions: SharedDeletion[]; run?: SharedRun | null;
  runs?: SharedRun[];
}
export interface SharedOperation { insert: SharedNode[]; delete: string[] }
export interface SharedDraft {
  fileId: string; path: string; epoch: string; text: string; pending: SharedOperation[];
  nodes: SharedNode[]; clock: number;
}
export interface RealtimeHost {
  readTextFile(path: string): Promise<string>;
  prepareTransition(): Promise<void>;
  connect(request: { teamId: string; projectId: string; epoch: string; sessionId: string }): Promise<SharedState>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  materialize(files: SharedFile[], options?: { replace?: boolean; epoch?: string; previousEpoch?: string; reconcile?: boolean; workspaceIdentity?: unknown }): Promise<void>;
  recover(fileId: string): Promise<boolean>;
  drafts(request?: { drafts: SharedDraft[]; contextKey?: string }): Promise<{ sessionId: string; contextKey: string; drafts: SharedDraft[] }>;
  onMessage(listener: (message: Record<string, unknown>) => void): Dispose;
}
export interface RealtimeFacade {
  isActive(): boolean;
  decorateTreeRow(row: HTMLElement, path: string): void;
  prepareFile(path: string): Promise<void>;
  save(path?: string): Promise<boolean>;
  fileOperation(kind: 'create' | 'mkdir' | 'rename' | 'delete', path: string, target?: string): Promise<unknown>;
  openProject(project: Record<string, unknown>, mapping: Record<string, unknown>): Promise<boolean>;
  manage(project: Record<string, unknown>): Promise<void>;
  run(path: string): Promise<boolean>;
  runTask(task: Record<string, unknown>, onEvent: (event: Record<string, unknown>) => void): Promise<boolean>;
  stop(): Promise<void>;
  syncPersonal(): Promise<boolean>;
  leave(): Promise<void>;
}
