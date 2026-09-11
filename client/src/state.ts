import type {
  RendererAiState,
  RendererState
} from '../types/state';

/** Shared application state.  The object remains mutable for legacy callers. */
export const ALWAYS_COLLAPSED = new Set<string>([
  'node_modules', '.git', '.venv', 'venv', '__pycache__'
]);

function createAiState(): RendererAiState {
  return {
    schemaVersion: 3,
    enabled: true,
    chatOpen: false,
    status: 'idle',
    chatProfiles: [],
    inlineProfiles: [],
    chatProfileId: '',
    inlineProfileId: '',
    connectionHealth: { chat: {}, inline: {} },
    globalInstructions: '',
    chat: {
      instructions: '',
      parameters: { maxTokens: 4096, temperature: 0.2, topP: 1, stop: [] },
      context: {
        maxInputChars: 48000,
        currentFileChars: 20000,
        selectionChars: 6000,
        projectChars: 4000,
        referencedFileChars: 5000,
        maxReferencedFiles: 4,
        historyMessages: 12,
        historyMessageChars: 6000
      }
    },
    inline: {
      enabled: false,
      instructions: '',
      debounceMs: 450,
      parameters: { maxTokens: 160, temperature: 0, topP: 1, stop: [] },
      context: { prefixChars: 6000, suffixChars: 2500 }
    },
    chatMessages: [],
    referencedFiles: [],
    excludedAutoContextPaths: [],
    autoContextDisabled: false,
    conversations: [],
    currentConversationId: '',
    chatStreaming: false,
    inlineStatus: 'idle',
    // Derived compatibility aliases for renderer modules during v1 migration.
    currentModel: '',
    chatModel: '',
    inlineModel: '',
    models: [],
    inlineEnabled: false,
    inlineDebounceMs: 450,
    chatSystemPrompt: '',
    inlineInstruction: '',
    inlinePrefixChars: 6000,
    inlineSuffixChars: 2500,
    inlineMaxTokens: 160,
    inlineSession: null
  };
}

export function createRendererState(): RendererState {
  return {
    // Editor
    editor: null,
    splitEditor: null,
    diffEditor: null,
    currentViewMode: 'single',

    // Workspace
    workspaceRoot: null,
    workspaceTree: null,
    workspaceIdentity: null,
    workspaceGeneration: 0,
    workspaceLeaveApprovals: new Map(),
    workspaceTransitionLocked: false,
    workspaceTransitionToken: null,
    workspaceTransitionEditorStates: null,
    workspaceSettings: null,
    expandedPaths: new Set(),
    ALWAYS_COLLAPSED,

    // Tabs
    tabs: [],
    activeTabPath: null,

    // Server
    serverSettings: {},
    // Missing descriptors intentionally remain compatible with pre-handshake
    // servers.
    serverCapabilities: null,

    // Team collaboration.
    collaboration: {
      teams: [],
      current: null,
      locks: [],
      modalOpen: false
    },

    // Auth (cloud account)
    auth: {
      mode: 'unknown',
      token: '',
      expiresAt: 0,
      user: null,
      serverVersion: '',
      modalOpen: false
    },

    // Runtime
    availableRuntimes: [],
    selectedRuntime: '',
    groupedRuntimes: {},

    // Terminal
    setupCommands: [],

    // Run / WebSocket
    activeRunSocket: null,
    activeRunId: null,
    activeRunContext: null,
    activeRunCancelled: false,
    runIdentityEpoch: 0,
    runLogInitialized: false,
    artifactInflight: new Map(),
    runSessionTimestamp: null,
    showTimestampNextLine: true,
    autoScrollEnabled: true,

    // Auto-sync
    autoSyncInterval: null,
    workspaceChangeVersion: 0,
    lastSyncedVersion: -1,

    // Diagnostics
    currentDiagnostics: { errors: 0, warnings: 0, infos: 0 },
    diagnosticsSettings: null,

    // Remote language service preference and live transport metrics.
    lsp: {
      settings: { mode: 'local' },
      status: { state: 'local', bytesSent: 0, bytesReceived: 0, latencyMs: null, cache: null }
    },

    // Debug Adapter Protocol. This state is intentionally independent from LSP.
    dap: {
      phase: 'idle',
      configurationId: 'builtin:current-file',
      configurations: [],
      warnings: [],
      breakpoints: new Map(),
      watches: [],
      threads: [],
      stackFrames: [],
      scopes: [],
      variables: [],
      selectedThreadId: 0,
      selectedFrameId: 0,
      clientSessionId: '',
      authEpoch: 0,
      adapter: null,
      capabilities: null
    },

    // Image preview
    currentImagePath: null,
    imageRotation: 0,
    imageScale: 1,

    // UI state
    contextMenuEl: null,

    // Output panel
    activePanel: 'output',

    // AI Agent
    ai: createAiState()
  };
}

