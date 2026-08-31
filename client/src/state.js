// src/state.js — Shared application state
// All mutable state lives here so modules don't need closure variables.
(function(global) {
  const ALWAYS_COLLAPSED = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);

  global.BOBO = global.BOBO || {};

  global.BOBO.state = {
    // Editor
    editor: null,
    splitEditor: null,
    diffEditor: null,
    currentViewMode: 'single', // 'single' | 'split' | 'diff' | 'plugin-details' | 'agent-workbench'

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
    ALWAYS_COLLAPSED: ALWAYS_COLLAPSED,

    // Tabs: { path, name, model, language, dirty }
    tabs: [],
    activeTabPath: null,

    // Server
    serverSettings: {},
    // Snapshot negotiated from serverInfo. Missing descriptors intentionally
    // remain compatible with pre-handshake servers.
    serverCapabilities: null,

	// Team collaboration. current is null for personal projects and otherwise
	// {teamId, projectId, projectName, branch, localPath}.
	collaboration: {
	  teams: [],
	  current: null,
	  locks: [],
	  modalOpen: false
	},

    // Auth (cloud account)
    auth: {
      mode: 'unknown',     // 'unknown' | 'single' | 'multi'
      token: '',           // 登录会话 token（多人模式）
      expiresAt: 0,        // 本地计时凭证到期时间戳（毫秒）
      user: null,          // {id, username, email, name, role, api_key, ...}
      serverVersion: '',
      modalOpen: false     // 登录窗口是否正在显示（防止重复弹出）
    },

    // Runtime
    availableRuntimes: [],    // [{language, version, dockerImage, displayName, extensions}]
    selectedRuntime: '',      // "python:3.11" or "" for local
    groupedRuntimes: {},      // {python: [...], java: [...]}

    // Terminal
    setupCommands: [],        // accumulated terminal commands

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
    diagnosticsSettings: null,   // loaded from diagnostics-settings.json; see completion-rules.js DEFAULT_DIAGNOSTICS_SETTINGS

    // Remote language service preference and live transport metrics.
    lsp: {
      settings: { mode: 'local' },
      status: { state: 'local', bytesSent: 0, bytesReceived: 0, latencyMs: null, cache: null }
    },

    // Debug Adapter Protocol. This state is intentionally independent from LSP.
    dap: {
      phase: 'idle', // idle | preparing | connecting | configuring | running | stopped | error
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
    activePanel: 'output', // 'output' | 'terminal' | 'team' | 'debug'

    // AI Agent
    ai: {
      schemaVersion: 3,
      enabled: true,
      chatOpen: false,
      status: 'idle',       // 'idle' | 'thinking' | 'error'
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
      chatMessages: [],     // [{role, content, timestamp, id}]
      referencedFiles: [],  // [{path, name, type:'file'|'folder'}]
      excludedAutoContextPaths: [], // active file paths explicitly removed for this conversation
      autoContextDisabled: false, // conversation-level opt-out for current file, selection and workspace summary
      conversations: [],    // [{id, title, messages, referencedFiles, createdAt}]
      currentConversationId: '', // active conversation id
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
      inlineSession: null   // Monaco InlineCompletion session
    }
  };
})(window);
