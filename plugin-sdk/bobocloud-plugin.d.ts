/**
 * BOBOCloud Plugin API 1.2.0 declarations.
 *
 * Copy or reference this file from a plugin's TypeScript project. The runtime
 * is a sandboxed ES module; Node.js, Electron, DOM, and window APIs are not
 * part of this declaration or the supported plugin surface.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue | undefined };

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
  | 'scm.git.write';

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
    | string;
}

export type ActivationResult = void | (() => void | Promise<void>) | Disposable | Promise<void | (() => void | Promise<void>) | Disposable>;

export type Activate = (context: PluginContext) => ActivationResult;
export type Deactivate = () => void | Promise<void>;
