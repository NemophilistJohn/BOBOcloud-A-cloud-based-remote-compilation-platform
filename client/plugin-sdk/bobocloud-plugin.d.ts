/**
 * BOBOCloud Plugin API 1.6.0 declarations.
 *
 * Copy or reference this file from a plugin's TypeScript project. The runtime
 * is a sandboxed ES module; Node.js, Electron, DOM, and window APIs are not
 * part of this declaration or the supported plugin surface.
 */

export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject { readonly [key: string]: JsonValue | undefined }
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface Disposable {
  dispose(): void;
}

export interface PluginIdentity {
  readonly id: string;
  readonly version: string;
}

export type PluginPermission =
  | 'commands.register'
  | 'commands.execute'
  | 'contributions.register'
  | 'services.read'
  | 'sourceControl.register'
  | 'fileDecorations.scm'
  | 'scm.git.read'
  | 'scm.git.write'
  | 'documentViews.register'
  | 'documents.read'
  | 'agents.register'
  | 'models.generate'
  | 'workspace.read'
  | 'workspace.write'
  | 'process.execute'
  | 'skills.read'
  | 'storage.local';

export interface CommandMetadata {
  readonly title?: string;
  readonly category?: string;
  readonly hint?: string;
}

export type CommandHandler = (...args: readonly JsonValue[]) => JsonValue | Promise<JsonValue>;

/**
 * The v1 host accepts these declarative points. They are lifecycle-safe data
 * registrations, but only a subset have a visible consumer today. See the
 * plugin-development guide before depending on a contribution in production.
 */
export type ContributionPoint =
  | 'menus'
  | 'tasks'
  | 'settings'
  | 'languages'
  | 'ai.tools'
  | 'mcp.providers'
  | 'skills.providers';

export interface ContributionOptions {
  readonly id?: string;
}

export interface ProjectTaskSnapshot {
  readonly label: string;
  readonly kind: 'build' | 'test' | 'run' | 'custom';
  readonly type: string;
  readonly source: string;
  readonly executable: boolean;
  readonly warnings: readonly string[];
}

export interface ProjectTasksServiceSnapshot {
  readonly tasks: readonly ProjectTaskSnapshot[];
  readonly selected: Readonly<{ type: 'file' | 'task'; label: string }> | null;
}

export interface PluginServices {
  /**
   * Requires the `services.read` permission. API v1 exposes only
   * `workbench.projectTasks`, as a data-only snapshot.
   */
  get(id: 'workbench.projectTasks'): Promise<ProjectTasksServiceSnapshot>;
  get(id: string): Promise<unknown>;
}

export interface PluginCommands {
  /** Requires `commands.register`; id must start with `${extension.id}.`. */
  register(id: string, handler: CommandHandler, metadata?: CommandMetadata): Promise<Disposable>;
  /** Requires `commands.execute`. */
  execute(id: string, ...args: readonly JsonValue[]): Promise<JsonValue>;
}

export interface PluginContributions {
  /** Requires `contributions.register`; options.id must use the plugin namespace. */
  register(point: ContributionPoint, contribution: Readonly<Record<string, JsonValue>>, options?: ContributionOptions): Promise<Disposable>;
}

/** A data-only activity contribution. The workbench owns all rendering. */
export interface SourceControlDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon?: 'git-branch';
  readonly order?: number;
  readonly openCommand?: string;
}

export type SourceControlPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export type SourceControlActionKind = 'primary' | 'secondary' | 'danger';
/** Host-owned compact action layout. Menu actions render under the host overflow menu. */
export type SourceControlActionPlacement = 'button' | 'toolbar' | 'menu';
/** Semantic token only; plugins cannot provide SVG, HTML, or CSS. */
export type SourceControlActionIcon = 'refresh' | 'commit' | 'pull' | 'push' | 'branch' | 'publish' | 'remote' | 'stage-all' | 'visibility';
export type SourceControlFormFieldType = 'text' | 'textarea' | 'select' | 'checkbox';

export interface SourceControlSummaryItem {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}

export interface SourceControlSummary {
  readonly title?: string;
  readonly items: readonly SourceControlSummaryItem[];
}

export interface SourceControlSectionItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
  readonly badge?: string;
  /** Must be owned by this extension. */
  readonly command?: string;
  readonly disabled?: boolean;
}

export interface SourceControlLoadMoreAction {
  /** Must be owned by this extension. */
  readonly command: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

export interface SourceControlSection {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly emptyMessage?: string;
  readonly collapsed?: boolean;
  readonly items: readonly SourceControlSectionItem[];
  readonly loadMore?: SourceControlLoadMoreAction;
}

export interface SourceControlFormFieldBase {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
}

export interface SourceControlTextFormField extends SourceControlFormFieldBase {
  readonly type?: 'text' | 'textarea';
  readonly value?: string;
}

export interface SourceControlSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SourceControlSelectFormField extends SourceControlFormFieldBase {
  readonly type: 'select';
  readonly value?: string;
  readonly options: readonly SourceControlSelectOption[];
}

export interface SourceControlCheckboxFormField extends SourceControlFormFieldBase {
  readonly type: 'checkbox';
  readonly value?: boolean;
}

export type SourceControlFormField =
  | SourceControlTextFormField
  | SourceControlSelectFormField
  | SourceControlCheckboxFormField;

export interface SourceControlForm {
  readonly title?: string;
  readonly submitLabel?: string;
  readonly fields: readonly SourceControlFormField[];
}

export interface SourceControlAction {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Must be owned by this extension. */
  readonly command: string;
  readonly kind?: SourceControlActionKind;
  readonly placement?: SourceControlActionPlacement;
  readonly icon?: SourceControlActionIcon;
  readonly disabled?: boolean;
  readonly form?: SourceControlForm;
}

/**
 * Bounded data rendered by the trusted source-control sidebar. It never
 * accepts HTML, CSS, URLs, DOM nodes, callbacks, or arbitrary command args.
 */
export interface SourceControlState {
  readonly phase?: SourceControlPhase;
  readonly title?: string;
  readonly message?: string;
  readonly summary?: SourceControlSummary;
  readonly sections?: readonly SourceControlSection[];
  readonly actions?: readonly SourceControlAction[];
}

/** The host supplies this single data argument to a referenced command. */
export interface SourceControlCommandPayload {
  readonly sourceControlId: string;
  readonly actionId: string;
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly sectionId?: string;
  readonly itemId?: string;
  readonly kind?: string;
}

export interface SourceControlStateProvider extends Disposable {
  readonly id: string;
  setState(state: SourceControlState): Promise<Readonly<{ version: number }>>;
  clearState(): Promise<Readonly<{ version: number }>>;
}

export interface PluginSourceControl {
  /** Requires `sourceControl.register`; lifecycle cleanup is automatic. */
  register(descriptor: SourceControlDescriptor): Promise<SourceControlStateProvider>;
}

export interface PluginI18n {
  readonly locale: 'en' | 'zh-CN' | 'ja';
  t(key: string, values?: Readonly<Record<string, string | number | boolean | null | undefined>>): string;
  onDidChange(listener: (event: Readonly<{ locale: 'en' | 'zh-CN' | 'ja' }>) => void): Disposable;
}

export type ScmFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'ignored';

/** A path is always relative to the active local workspace. */
export interface ScmFileDecorationEntry {
  readonly path: string;
  readonly status: ScmFileStatus;
}

export interface ScmFileDecorationProvider extends Disposable {
  /** Replaces this provider's complete SCM state. Requires `fileDecorations.scm`. */
  set(entries: readonly ScmFileDecorationEntry[]): Promise<Readonly<{
    changedPaths: readonly string[];
    entryCount: number;
  }>>;
  /** Clears the supplied paths, or all state when paths is omitted. */
  clear(paths?: readonly string[]): Promise<Readonly<{
    clearedPaths: readonly string[];
    entryCount: number;
  }>>;
}

export interface PluginFileDecorations {
  /**
   * Requires `fileDecorations.scm`. Plugin code publishes only a relative path
   * and a fixed status; the host owns colors, badges, labels, and tree DOM.
   */
  registerScm(options: Readonly<{ id: string; priority?: number }>): Promise<ScmFileDecorationProvider>;
}

export interface DocumentViewRegistration {
  /** Must match one contributes.documentViewers entry and use the plugin namespace. */
  readonly id: string;
  /** Localized title used by the host for accessibility and diagnostics. */
  readonly title: string;
}

export interface PluginDocumentViews {
  /** Requires both `documentViews.register` and `documents.read`. */
  register(descriptor: DocumentViewRegistration): Promise<Disposable>;
}

export interface ScmRepositoryDescriptor {
  /** An opaque, workspace-session-scoped repository token. */
  readonly repositoryId: string;
  /** A relative root only; no absolute local path is exposed. */
  readonly relativeRoot: string;
  readonly isWorkspaceRoot: boolean;
}

export interface ScmBranchState {
  readonly head: string;
  readonly upstream: string;
  readonly ahead: number;
  readonly behind: number;
  readonly oid: string;
}

export interface ScmChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: string;
  readonly workingTree: string;
  readonly kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
  /** Staged additions/deletions relative to HEAD; null for unknown/binary/untracked. */
  readonly indexStats: ScmDiffStat | null;
  /** Working-tree additions/deletions relative to the index; null when unavailable. */
  readonly workingTreeStats: ScmDiffStat | null;
}

export interface ScmDiffStat {
  readonly additions: number;
  readonly deletions: number;
}

export interface ScmStatus {
  readonly repositoryId: string;
  /** Repository root relative to the active local workspace. */
  readonly relativeRoot: string;
  readonly branch: ScmBranchState;
  readonly changes: readonly ScmChange[];
  /** The zero-based position of the first returned change. */
  readonly offset: number;
  /** The requested page size, capped at 200 by the host. */
  readonly limit: number;
  /** Number of changes observed by this status snapshot. */
  readonly total: number;
  readonly hasMore: boolean;
  /** The offset for the next status page, or null when the snapshot is exhausted. */
  readonly nextOffset: number | null;
}

export interface ScmCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: Readonly<{ name: string; email: string }>;
  readonly date: string;
  readonly subject: string;
}

export interface ScmBranch {
  readonly name: string;
  readonly hash: string;
  readonly upstream: string;
}

export interface ScmRemote {
  readonly name: string;
  /** Compatibility alias for fetchUrls. */
  readonly urls: readonly string[];
  readonly fetchUrls: readonly string[];
  readonly pushUrls: readonly string[];
  /** True when a configured remote URL was omitted because its form is unsupported. */
  readonly hasUnsupportedUrls: boolean;
}

export interface PluginScmGit {
  /** Requires `scm.git.read`. */
  detect(options?: Readonly<{ includeNested?: boolean }>): Promise<Readonly<{
    repositories: readonly ScmRepositoryDescriptor[];
  }>>;
  status(args: Readonly<{ repositoryId: string; offset?: number; limit?: number }>): Promise<ScmStatus>;
  history(args: Readonly<{ repositoryId: string; offset?: number; limit?: number; ref?: string }>): Promise<Readonly<{
    repositoryId: string;
    commits: readonly ScmCommit[];
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
  }>>;
  diff(args: Readonly<{ repositoryId: string; path?: string; ref?: string; staged?: boolean }>): Promise<Readonly<{
    repositoryId: string;
    content: string;
    truncated: boolean;
  }>>;
  branches(args: Readonly<{ repositoryId: string }>): Promise<Readonly<{
    repositoryId: string;
    current: string;
    local: readonly ScmBranch[];
    remote: readonly ScmBranch[];
  }>>;
  remotes(args: Readonly<{ repositoryId: string }>): Promise<Readonly<{
    repositoryId: string;
    remotes: readonly ScmRemote[];
  }>>;

  /** All methods below require `scm.git.write`. */
  /** Clones only into an empty active local workspace; no destination path is accepted. */
  clone(args: Readonly<{ url: string; branch?: string }>): Promise<ScmRepositoryDescriptor>;
  init(): Promise<ScmRepositoryDescriptor>;
  setRemote(args: Readonly<{ repositoryId: string; name: string; url: string }>): Promise<Readonly<{
    repositoryId: string;
    name: string;
    url: string;
  }>>;
  stage(args: Readonly<{ repositoryId: string; paths: readonly string[] }>): Promise<ScmStatus>;
  stageAll(args: Readonly<{ repositoryId: string }>): Promise<ScmStatus>;
  unstage(args: Readonly<{ repositoryId: string; paths: readonly string[] }>): Promise<ScmStatus>;
  commit(args: Readonly<{ repositoryId: string; message: string }>): Promise<Readonly<{
    repositoryId: string;
    commit: string;
  }>>;
  checkout(args: Readonly<{ repositoryId: string; branch: string; force?: boolean }>): Promise<Readonly<{
    repositoryId: string;
    branch: string;
  }>>;
  createBranch(args: Readonly<{ repositoryId: string; name: string; checkout?: boolean }>): Promise<Readonly<{
    repositoryId: string;
    branch: string;
    checkedOut: boolean;
  }>>;
  /** Deletes a local branch. The checked out branch cannot be deleted. */
  deleteBranch(args: Readonly<{ repositoryId: string; name: string; force?: boolean }>): Promise<Readonly<{
    repositoryId: string;
    branch: string;
    deleted: true;
  }>>;
  fetch(args: Readonly<{ repositoryId: string; remote?: string }>): Promise<ScmRemoteOperationResult>;
  pull(args: Readonly<{ repositoryId: string; remote?: string; branch?: string }>): Promise<ScmRemoteOperationResult>;
  push(args: Readonly<{
    repositoryId: string;
    remote?: string;
    branch?: string;
    force?: boolean;
    setUpstream?: boolean;
  }>): Promise<ScmRemoteOperationResult>;
}

export interface ScmRemoteOperationResult {
  readonly repositoryId: string;
  readonly remote: string;
  readonly branch: string;
  readonly output: string;
}

export interface PluginScm {
  readonly git: PluginScmGit;
}

export type AgentPhase = 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
export type AgentMode = 'chat' | 'goal';
export type AgentAccessMode = 'ask' | 'auto' | 'full';
export type AgentToolRiskLevel = 'low' | 'medium' | 'high';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentEffectiveReasoningEffort = AgentReasoningEffort | 'none';
export type AgentSessionStatus = 'idle' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled';
export type AgentTimelineKind = 'thought' | 'tool' | 'status' | 'skill' | 'compaction' | 'error';
export type AgentTimelineStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'rejected';
export type AgentGoalStepStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';

export interface AgentCommandMap {
  /** Every command id must use the registering plugin namespace. */
  readonly create: string;
  readonly select: string;
  readonly delete: string;
  readonly send: string;
  readonly cancel: string;
  readonly approve: string;
  readonly reject: string;
  readonly preferences: string;
  readonly configure: string;
}

/** Data-only declaration rendered by the trusted Agent workbench. */
export interface AgentDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: 'sparkles';
  readonly order?: number;
  readonly commands: AgentCommandMap;
  readonly capabilities?: Readonly<{
    readonly modes?: readonly AgentMode[];
    readonly reasoningEfforts?: readonly AgentReasoningEffort[];
    readonly accessModes?: readonly AgentAccessMode[];
    readonly skills?: boolean;
    readonly localTools?: boolean;
  }>;
}

export interface AgentSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt?: string;
  readonly status?: AgentSessionStatus;
  readonly mode?: AgentMode;
}

/** Opaque model reference backed by a host-owned AI profile. It contains no credentials. */
export interface AgentModelChoice {
  readonly ref: string;
  readonly name: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly purpose?: 'chat' | 'inline';
  readonly configured?: boolean;
  readonly capabilities?: Readonly<{
    readonly contextWindowTokens: number | null;
    readonly maxOutputTokens: number | null;
    /** Effective per-request ceiling after the host safety limit is applied. */
    readonly requestOutputLimitTokens: number;
    readonly tools: boolean | null;
    readonly streaming: boolean | null;
    readonly parallelToolCalls: boolean | null;
    readonly reasoningEfforts: readonly AgentReasoningEffort[];
    readonly effectiveEffortMap: Readonly<Partial<Record<AgentReasoningEffort, AgentEffectiveReasoningEffort>>>;
    readonly source: 'provider-api' | 'official-catalog' | 'user-override' | 'unknown';
  }> | null;
}

export interface AgentSkillChoice {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly source?: 'workspace' | 'user';
  readonly enabled?: boolean;
  readonly revision?: string;
  readonly sizeBytes?: number | null;
  readonly estimatedTokens?: number | null;
}

export interface AgentMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content?: string;
  readonly reasoning?: string;
  readonly createdAt?: string;
}

export interface AgentTimelineItem {
  readonly id: string;
  readonly kind?: AgentTimelineKind;
  readonly title: string;
  readonly detail?: string;
  readonly status?: AgentTimelineStatus;
  readonly createdAt?: string;
}

export interface AgentGoalStep {
  readonly id: string;
  readonly title: string;
  readonly status?: AgentGoalStepStatus;
}

export interface AgentGoal {
  readonly title: string;
  readonly status?: AgentGoalStepStatus;
  readonly steps?: readonly AgentGoalStep[];
}

export interface AgentApproval {
  readonly id: string;
}

export interface AgentCompaction {
  readonly count: number;
  readonly compactedMessages: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly compactedAt: string;
}

export interface AgentActiveSession {
  readonly id: string;
  readonly title: string;
  readonly status?: AgentSessionStatus;
  readonly mode?: AgentMode;
  /** Plugin/session semantics only. Host tool authority comes from trusted main-process state. */
  readonly accessMode?: AgentAccessMode;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly effectiveReasoningEffort?: AgentEffectiveReasoningEffort;
  readonly modelRef?: string;
  readonly messages?: readonly AgentMessage[];
  readonly timeline?: readonly AgentTimelineItem[];
  readonly goal?: AgentGoal | null;
  readonly approval?: AgentApproval | null;
  readonly compacting?: boolean;
  readonly compaction?: AgentCompaction | null;
}

/** Complete replacement snapshot. The host validates, bounds, freezes, and renders it. */
export interface AgentState {
  readonly phase?: AgentPhase;
  readonly message?: string;
  readonly activeSessionId?: string;
  readonly sessions?: readonly AgentSessionSummary[];
  readonly models?: readonly AgentModelChoice[];
  readonly skills?: readonly AgentSkillChoice[];
  readonly activeSession?: AgentActiveSession | null;
}

/** The host supplies this single data argument to every Agent command. */
export interface AgentCommandPayload {
  readonly providerId: string;
  readonly action: string;
  readonly sessionId?: string;
  readonly text?: string;
  readonly mode?: AgentMode;
  /** Trusted workbench selection; this field does not itself grant tool access. */
  readonly accessMode?: AgentAccessMode;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly modelRef?: string;
  readonly skillIds?: readonly string[];
  readonly approvalId?: string;
  /** Canonical result produced by the trusted host approval broker. */
  readonly approvalResult?: AgentApprovalResult;
}

export interface AgentStateProvider extends Disposable {
  readonly id: string;
  setState(state: AgentState): Promise<Readonly<{ version: number }>>;
  updateState(patch: AgentStatePatch): Promise<Readonly<{ applied: boolean; version: number }>>;
  clearState(): Promise<Readonly<{ version: number }>>;
}

export type AgentStatePatchOperation =
  | Readonly<{ type: 'state.merge'; value: Partial<Omit<AgentState, 'activeSession'>> }>
  | Readonly<{ type: 'session.merge'; value: Partial<Omit<AgentActiveSession, 'messages' | 'timeline'>> }>
  | Readonly<{ type: 'message.upsert'; value: AgentMessage }>
  | Readonly<{ type: 'timeline.upsert'; value: AgentTimelineItem }>;

export interface AgentStatePatch {
  readonly baseVersion: number;
  readonly operations: readonly AgentStatePatchOperation[];
}

export interface PluginAgents {
  /** Requires `agents.register`; lifecycle cleanup is automatic. */
  register(descriptor: AgentDescriptor): Promise<AgentStateProvider>;
}

export interface AgentModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly JsonObject[];
}

export interface AgentModelToolDefinition {
  readonly type: 'function';
  readonly function: Readonly<{
    readonly name: string;
    readonly description?: string;
    readonly parameters?: JsonObject;
  }>;
}

export interface AgentModelGenerateRequest {
  readonly modelRef: string;
  readonly requestId: string;
  readonly messages: readonly AgentModelMessage[];
  readonly tools?: readonly AgentModelToolDefinition[];
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface AgentModelToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON-encoded tool arguments supplied by the model. Validate before use. */
  readonly arguments: string;
}

export interface AgentModelGenerateResult {
  readonly content: string;
  readonly reasoning: string;
  readonly toolCalls: readonly AgentModelToolCall[];
  readonly finishReason: string;
  readonly usage: AgentModelUsage | null;
  readonly requestedReasoningEffort: AgentReasoningEffort;
  readonly effectiveReasoningEffort: AgentEffectiveReasoningEffort;
}

export interface AgentModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
}

export type AgentModelStreamEvent =
  | Readonly<{ type: 'response.started'; requestId: string; sequence: number; requestedReasoningEffort: AgentReasoningEffort; effectiveReasoningEffort: AgentEffectiveReasoningEffort }>
  | Readonly<{ type: 'content.delta' | 'reasoning.delta'; requestId: string; sequence: number; delta: string }>
  | Readonly<{ type: 'tool_call.delta'; requestId: string; sequence: number; index: number; id?: string; name?: string; argumentsDelta?: string }>
  | Readonly<{ type: 'usage'; requestId: string; sequence: number; usage: AgentModelUsage }>
  | Readonly<{ type: 'response.completed'; requestId: string; sequence: number; requestedReasoningEffort: AgentReasoningEffort; effectiveReasoningEffort: AgentEffectiveReasoningEffort; result: AgentModelGenerateResult }>
  | Readonly<{ type: 'response.error'; requestId: string; sequence: number; error: Readonly<{ code: string; message: string }> }>;

export interface PluginModels {
  /** All methods require `models.generate`; returned refs never contain a secret. */
  list(): Promise<Readonly<{ models: readonly AgentModelChoice[] }>>;
  generate(args: AgentModelGenerateRequest): Promise<AgentModelGenerateResult>;
  generateStream(args: AgentModelGenerateRequest, onEvent: (event: AgentModelStreamEvent) => void | Promise<void>): Promise<AgentModelGenerateResult>;
  /** Cancels only this plugin's host-prefixed request id. */
  cancel(requestId: string): Promise<Readonly<{ success: boolean; cancelled: boolean }>>;
}

export interface AgentWorkspaceListInput { readonly path?: string; readonly depth?: number; readonly limit?: number }
export interface AgentWorkspaceListResult {
  readonly entries: readonly Readonly<{ path: string; type: 'file' | 'directory' }>[];
  readonly truncated: boolean;
  readonly workspaceIdentity: number;
}
export interface AgentWorkspaceReadInput { readonly path: string }
export interface AgentWorkspaceReadResult { readonly path: string; readonly content: string; readonly sha256: string; readonly size: number }
export interface AgentWorkspaceSearchInput { readonly query: string; readonly caseSensitive?: boolean; readonly limit?: number }
export interface AgentWorkspaceSearchResult {
  readonly results: readonly Readonly<{ path: string; line: number; preview: string }>[];
  readonly truncated: boolean;
}
export interface AgentWorkspaceWriteInput { readonly path: string; readonly content: string; readonly expectedSha256?: string }
export interface AgentProcessRunInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}
export interface AgentToolApprovalRequired {
  readonly approvalRequired: true;
  readonly approval: Readonly<{
    readonly id: string;
    readonly tool: string;
    readonly summary: string;
    readonly risk: 'read' | 'write' | 'execute' | 'network';
    readonly riskLevel: AgentToolRiskLevel;
    readonly accessMode: AgentAccessMode;
    readonly expiresAt: string;
  }>;
}
export interface AgentAutomaticToolMetadata {
  readonly autoApproved?: true;
  readonly accessMode?: 'auto' | 'full';
  readonly riskLevel?: AgentToolRiskLevel;
}
export interface AgentWorkspaceWriteResult extends AgentAutomaticToolMetadata {
  readonly approved: true;
  readonly path: string;
  readonly sha256: string;
}
export interface AgentProcessRunResult extends AgentAutomaticToolMetadata {
  readonly approved: true;
  readonly exitCode: number | null;
  readonly signal: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}
export interface AgentToolRejectedResult {
  readonly approved?: false;
  readonly rejected: true;
  readonly cancelled?: boolean;
  readonly tool: 'workspace_write' | 'process_run';
  readonly failed?: false;
}
/** The trusted host authorized the operation but could not complete it. */
export interface AgentToolExecutionFailedResult extends AgentAutomaticToolMetadata {
  readonly approved?: false;
  readonly rejected: true;
  readonly failed: true;
  /** Omitted only when an expired or missing approval has outlived the host's bounded identity cache. */
  readonly tool?: 'workspace_write' | 'process_run';
  readonly errorCode: string;
  readonly errorMessage: string;
  /** `unknown` means the operation may have produced side effects and must not be retried without verification. */
  readonly outcome: 'not-started' | 'unknown';
  readonly mayHaveExecuted: boolean;
}
export type AgentApprovalResult =
  | AgentWorkspaceWriteResult
  | AgentProcessRunResult
  | AgentToolRejectedResult
  | AgentToolExecutionFailedResult;

export interface PluginTools {
  list(): Promise<Readonly<{ tools: readonly AgentToolDescriptor[] }>>;
  /** `workspace_list`, `workspace_read`, and `workspace_search` require `workspace.read`. */
  invoke(tool: 'workspace_list', input?: AgentWorkspaceListInput): Promise<AgentWorkspaceListResult>;
  invoke(tool: 'workspace_read', input: AgentWorkspaceReadInput): Promise<AgentWorkspaceReadResult>;
  invoke(tool: 'workspace_search', input: AgentWorkspaceSearchInput): Promise<AgentWorkspaceSearchResult>;
  /** `ask`, or a host-classified high-risk `auto` call, returns an approval without executing. */
  invoke(tool: 'workspace_write', input: AgentWorkspaceWriteInput): Promise<AgentToolApprovalRequired | AgentWorkspaceWriteResult | AgentToolExecutionFailedResult>;
  invoke(tool: 'process_run', input: AgentProcessRunInput): Promise<AgentToolApprovalRequired | AgentProcessRunResult | AgentToolExecutionFailedResult>;
  invoke(tool: string, input?: JsonObject): Promise<JsonValue>;
}

export interface AgentToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly risk: AgentToolRiskLevel;
  readonly readOnly: boolean;
  readonly parallelSafe: boolean;
  readonly requiresWorkspace: boolean;
}

export interface AgentSkillSummary {
  readonly id: string;
  readonly source: 'workspace' | 'user';
  readonly name: string;
  readonly description: string;
  readonly size: number;
  readonly sizeBytes: number;
  readonly estimatedTokens: number;
  readonly revision: string;
}
export interface AgentSkillDocument {
  readonly id: string;
  readonly source: 'workspace' | 'user';
  readonly name: string;
  readonly description: string;
  readonly sizeBytes: number;
  readonly estimatedTokens: number;
  readonly revision: string;
  readonly content: string;
}
export interface PluginSkills {
  /** Requires `skills.read`; no filesystem path is returned. */
  list(): Promise<Readonly<{ skills: readonly AgentSkillSummary[] }>>;
  read(skillId: string, revision?: string): Promise<AgentSkillDocument>;
}

export interface PluginStorage {
  /** Requires `storage.local`; data is isolated by plugin id and limited to 8 MiB. */
  read(): Promise<Readonly<{ value: JsonObject }>>;
  write(value: JsonObject): Promise<Readonly<{ saved: true; bytes: number }>>;
}

export interface HostInfo {
  readonly apiVersion: string;
  readonly plugin: PluginIdentity;
}

export interface PermissionSnapshot {
  readonly requested: readonly string[];
  readonly granted: readonly string[];
}

/**
 * Read-only metadata probes. This is deliberately not a general broker and
 * cannot access files, network, processes, credentials, or host services.
 */
export interface PluginHost {
  request(method: 'host.getInfo', args?: null): Promise<HostInfo>;
  request(method: 'permissions.get', args?: null): Promise<PermissionSnapshot>;
}

export interface PluginContext {
  readonly apiVersion: string;
  readonly extension: PluginIdentity;
  readonly subscriptions: Readonly<{
    add<T extends Disposable>(value: T): T;
  }>;
  readonly commands: PluginCommands;
  readonly contributions: PluginContributions;
  readonly i18n: PluginI18n;
  readonly sourceControl: PluginSourceControl;
  readonly fileDecorations: PluginFileDecorations;
  readonly documentViews: PluginDocumentViews;
  readonly agents: PluginAgents;
  readonly models: PluginModels;
  readonly tools: PluginTools;
  readonly skills: PluginSkills;
  readonly storage: PluginStorage;
  readonly scm: PluginScm;
  readonly services: PluginServices;
  readonly host: PluginHost;
}

/** Stable failures returned by the structured local SCM broker. */
export type ScmGitErrorCode =
  | 'SCM_GIT_UNAVAILABLE'
  | 'SCM_GIT_NO_WORKSPACE'
  | 'SCM_GIT_WORKSPACE_NOT_EMPTY'
  | 'SCM_GIT_INVALID_ARGUMENT'
  | 'SCM_GIT_REPOSITORY_NOT_FOUND'
  | 'SCM_GIT_STALE_REPOSITORY'
  | 'SCM_GIT_NOT_REPOSITORY'
  | 'SCM_GIT_BRANCH_CHECKED_OUT'
  | 'SCM_GIT_REMOTE_DENIED'
  | 'SCM_GIT_AUTH_REQUIRED'
  | 'SCM_GIT_IDENTITY_REQUIRED'
  | 'SCM_GIT_NOTHING_TO_COMMIT'
  | 'SCM_GIT_CLONE_FAILED'
  | 'SCM_GIT_CONFLICT'
  | 'SCM_GIT_OUTPUT_TOO_LARGE'
  | 'SCM_GIT_OPERATION_FAILED';

/** Stable failures returned by the local Agent capability brokers. */
export type AgentErrorCode =
  | 'AGENT_NO_WORKSPACE'
  | 'AGENT_STALE_WORKSPACE'
  | 'AGENT_INVALID_PATH'
  | 'AGENT_INVALID_MODEL_REQUEST'
  | 'AGENT_MODEL_FAILED'
  | 'AGENT_MODEL_UNCONFIGURED'
  | 'AGENT_MODEL_CAPABILITY'
  | 'AGENT_MODEL_PROTOCOL'
  | 'AGENT_STORAGE_TOO_LARGE'
  | 'AGENT_STORAGE_INVALID'
  | 'AGENT_FILE_TOO_LARGE'
  | 'AGENT_INVALID_SEARCH'
  | 'AGENT_FILE_CHANGED'
  | 'AGENT_COMMAND_DENIED'
  | 'AGENT_INVALID_COMMAND'
  | 'AGENT_INVALID_TOOL'
  | 'AGENT_TOOL_NOT_FOUND'
  | 'AGENT_PROCESS_FAILED'
  | 'AGENT_APPROVAL_NOT_FOUND'
  | 'AGENT_APPROVAL_EXPIRED'
  | 'AGENT_SKILL_NOT_FOUND'
  | 'AGENT_SKILL_CHANGED'
  | 'AGENT_METHOD_DENIED';

export interface PluginApiError extends Error {
  readonly code:
    | 'EXTENSION_CANCELLED'
    | 'EXTENSION_PERMISSION_DENIED'
    | 'EXTENSION_INVALID_REQUEST'
    | 'EXTENSION_NOT_FOUND'
    | 'EXTENSION_PROTOCOL_ERROR'
    | 'EXTENSION_TIMEOUT'
    | 'EXTENSION_UNAVAILABLE'
    | ScmGitErrorCode
    | AgentErrorCode
    | string;
}

export type ActivationResult = void | (() => void | Promise<void>) | Disposable | Promise<void | (() => void | Promise<void>) | Disposable>;

export type Activate = (context: PluginContext) => ActivationResult;
export type Deactivate = () => void | Promise<void>;

/** API supplied only to a declared schema-2 document-view entry inside its isolated iframe. */
export interface DocumentViewContext {
  readonly root: HTMLElement;
  readonly document: Readonly<{
    readonly documentId: string;
    readonly name: string;
    readonly extension: string;
    readonly size: number;
    readonly lastModified: string;
  }>;
  readonly viewer: Readonly<{
    readonly id: string;
    readonly title: string;
    readonly extensions: readonly string[];
    readonly priority: number;
  }>;
  readonly i18n: PluginI18n;
  readonly assets: Readonly<{
    /** Returns a temporary Blob URL only for a resource declared by this viewer. */
    url(resourcePath: string): string;
  }>;
  /** Reads at most 2 MiB from the current document handle. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Reads the current document only when it is within the supplied bounded limit. */
  readAll(maximumBytes?: number): Promise<Uint8Array>;
  readText(maximumBytes?: number, encoding?: string): Promise<string>;
}

export type ActivateDocumentView = (context: DocumentViewContext) => ActivationResult;
