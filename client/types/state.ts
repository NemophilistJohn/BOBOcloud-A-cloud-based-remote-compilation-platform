/**
 * The renderer state is intentionally mutable.  Legacy workbench modules
 * still coordinate through this object, so the contract describes the stable
 * shape without making those fields readonly or granting plugin code access
 * to the state store.
 */

import type { WorkspaceSettingsSnapshotDto } from './workspace-settings';

export interface RendererTabState {
  path?: string | null;
  name?: string;
  model?: unknown;
  language?: string;
  dirty?: boolean;
  readonly [key: string]: unknown;
}

export interface RendererCollaborationState {
  teams: unknown[];
  current: Record<string, unknown> | null;
  locks: unknown[];
  modalOpen: boolean;
  readonly [key: string]: unknown;
}

export interface RendererAuthState {
  mode: string;
  token: string;
  expiresAt: number;
  user: Record<string, unknown> | null;
  serverVersion: string;
  modalOpen: boolean;
  readonly [key: string]: unknown;
}

export interface RendererRuntimeState {
  availableRuntimes: unknown[];
  selectedRuntime: string;
  groupedRuntimes: Record<string, unknown[]>;
}

export interface RendererDiagnosticsState {
  errors: number;
  warnings: number;
  infos: number;
  readonly [key: string]: unknown;
}

export interface RendererLspState {
  settings: Record<string, unknown>;
  status: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface RendererDapState {
  phase: string;
  configurationId: string;
  configurations: unknown[];
  warnings: unknown[];
  breakpoints: Map<unknown, unknown>;
  watches: unknown[];
  threads: unknown[];
  stackFrames: unknown[];
  scopes: unknown[];
  variables: unknown[];
  selectedThreadId: number;
  selectedFrameId: number;
  clientSessionId: string;
  authEpoch: number;
  adapter: unknown;
  capabilities: unknown;
  readonly [key: string]: unknown;
}

export interface RendererAiParametersState {
  maxTokens: number;
  temperature: number;
  topP: number;
  stop: string[];
  readonly [key: string]: unknown;
}

export interface RendererAiChatContextState {
  maxInputChars: number;
  currentFileChars: number;
  selectionChars: number;
  projectChars: number;
  referencedFileChars: number;
  maxReferencedFiles: number;
  historyMessages: number;
  historyMessageChars: number;
  readonly [key: string]: unknown;
}

export interface RendererAiInlineContextState {
  prefixChars: number;
  suffixChars: number;
  readonly [key: string]: unknown;
}

export interface RendererAiChatState {
  instructions: string;
  parameters: RendererAiParametersState;
  context: RendererAiChatContextState;
  readonly [key: string]: unknown;
}

export interface RendererAiInlineState {
  enabled: boolean;
  instructions: string;
  debounceMs: number;
  parameters: RendererAiParametersState;
  context: RendererAiInlineContextState;
  readonly [key: string]: unknown;
}

export interface RendererAiState {
  schemaVersion: number;
  enabled: boolean;
  chatOpen: boolean;
  status: string;
  chatProfiles: unknown[];
  inlineProfiles: unknown[];
  chatProfileId: string;
  inlineProfileId: string;
  connectionHealth: { chat: Record<string, unknown>; inline: Record<string, unknown> };
  globalInstructions: string;
  chat: RendererAiChatState;
  inline: RendererAiInlineState;
  chatMessages: unknown[];
  referencedFiles: unknown[];
  excludedAutoContextPaths: string[];
  autoContextDisabled: boolean;
  conversations: unknown[];
  currentConversationId: string;
  chatStreaming: boolean;
  inlineStatus: string;
  currentModel: string;
  chatModel: string;
  inlineModel: string;
  models: unknown[];
  inlineEnabled: boolean;
  inlineDebounceMs: number;
  chatSystemPrompt: string;
  inlineInstruction: string;
  inlinePrefixChars: number;
  inlineSuffixChars: number;
  inlineMaxTokens: number;
  inlineSession: unknown;
  readonly [key: string]: unknown;
}

export interface RendererState {
  editor: unknown;
  splitEditor: unknown;
  diffEditor: unknown;
  currentViewMode: string;
  workspaceRoot: string | null;
  workspaceTree: unknown;
  workspaceIdentity: unknown;
  workspaceGeneration: number;
  workspaceLeaveApprovals: Map<unknown, unknown>;
  workspaceTransitionLocked: boolean;
  workspaceTransitionToken: unknown;
  workspaceTransitionEditorStates: unknown;
  workspaceSettings: WorkspaceSettingsSnapshotDto | null;
  expandedPaths: Set<string>;
  ALWAYS_COLLAPSED: Set<string>;
  tabs: RendererTabState[];
  activeTabPath: string | null;
  serverSettings: Record<string, unknown>;
  serverCapabilities: unknown;
  collaboration: RendererCollaborationState;
  auth: RendererAuthState;
  availableRuntimes: unknown[];
  selectedRuntime: string;
  groupedRuntimes: Record<string, unknown[]>;
  setupCommands: string[];
  activeRunSocket: unknown;
  activeRunId: unknown;
  activeRunContext: unknown;
  activeRunCancelled: boolean;
  runIdentityEpoch: number;
  runLogInitialized: boolean;
  artifactInflight: Map<unknown, unknown>;
  runSessionTimestamp: number | null;
  showTimestampNextLine: boolean;
  autoScrollEnabled: boolean;
  autoSyncInterval: unknown;
  workspaceChangeVersion: number;
  lastSyncedVersion: number;
  currentDiagnostics: RendererDiagnosticsState;
  diagnosticsSettings: unknown;
  lsp: RendererLspState;
  dap: RendererDapState;
  currentImagePath: string | null;
  imageRotation: number;
  imageScale: number;
  contextMenuEl: unknown;
  activePanel: string;
  ai: RendererAiState;
  readonly [key: string]: unknown;
}
