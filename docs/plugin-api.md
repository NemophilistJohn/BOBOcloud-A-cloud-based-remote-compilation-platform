# BOBOCloud Plugin API 1.5.0

Status: public package and isolated extension-host contract. BOBOCloud desktop `2.8.0` implements API 1.5 while remaining compatible with packages that target an earlier API 1.x range.

The reference guide, package checklist, and complete example are in [Plugin Development Guide](./plugin-development.md).

## Compatibility

`engines.pluginApi` is a semver range over this API version. API major versions are compatibility boundaries. BOBOCloud may add fields and capability consumers in a minor version, but it does not remove or alter this contract without a new major API version.

`engines.bobocloud` is separately checked against the installed application version. Both ranges must match before installation succeeds.

```json
{
  "schemaVersion": 1,
  "id": "acme.project-tools",
  "displayName": "Acme Project Tools",
  "version": "1.0.0",
  "engines": {
    "bobocloud": ">=2.8.0 <3.0.0",
    "pluginApi": "^1.5.0"
  },
  "main": "dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "permissions": ["commands.register", "services.read"],
  "contributes": {},
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "dist/extension.js": "<64 lowercase hexadecimal SHA-256 characters>"
    }
  }
}
```

The root file is named `manifest.json`. A `.boboplugin` is a ZIP archive with that file at archive root. The user-facing installer accepts only this archive format; development-folder installation is reserved for internal development and test controllers. Schema 1 retains the single bundled JavaScript entry rule. Schema 2 may additionally contain only the document-view entries and text resources explicitly declared in `contributes.documentViewers`. The integrity map covers every non-manifest file exactly once.

The matching TypeScript declaration is [plugin-sdk/bobocloud-plugin.d.ts](../client/plugin-sdk/bobocloud-plugin.d.ts). [examples/plugins/hello-plugin](../client/examples/plugins/hello-plugin) is a minimal installable directory package with a verified integrity hash.

## Execution Boundary

An opaque-origin sandboxed iframe is used only as a strict transport shell (`sandbox=allow-scripts`); it does not execute package code directly. The shell creates one host-generated Blob Worker, and that dedicated worker executes the installed entry after receiving it over a `MessageChannel`. The worker has no Node.js, Electron API, raw preload bridge, direct renderer object, arbitrary DOM, local filesystem, process, or network access. Its CSP permits only the Blob Worker (`worker-src blob:`) and denies external connections, frames, and object/media loads; the worker also disables `fetch`, XHR, WebSocket, EventSource, `importScripts`, nested workers, and shared workers.

The host verifies the entry SHA-256 before passing the source through the channel. The activation sandbox imports that single source from a Blob URL. Relative JavaScript imports are consequently unsupported. A schema-2 document view runs in a separate opaque-origin iframe described under [Document Views](#document-views); it is not the activation Worker and receives a different, narrower context.

All values exchanged with the host are bounded JSON-like data: plain objects, arrays, strings, booleans, finite numbers, and `null`. Functions, class instances, DOM objects, accessors, circular structures, non-finite numbers, and oversized payloads are rejected.

## Extension Module

The entry is an ES module that exports `activate(context)`. `deactivate()` is optional. `activate()` may return a disposer function or an object exposing `dispose()`.

```js
export async function activate(context) {
  await context.commands.register(
    'acme.project-tools.inspect',
    async () => ({ ok: true }),
    { title: 'Acme: Inspect Project', category: 'Extensions' }
  );
}

export async function deactivate() {
  // Bounded, idempotent cleanup only.
}
```

The host caps activation at 15 seconds, a command invocation at 10 seconds, and deactivation at 1.5 seconds. It removes all plugin-owned registrations even when activation or deactivation fails.

## Context

```ts
interface Disposable {
  dispose(): void;
}

interface CommandMetadata {
  title?: string;
  category?: string;
  hint?: string;
}

interface PluginContext {
  readonly apiVersion: string;
  readonly extension: Readonly<{ id: string; version: string }>;
  readonly subscriptions: Readonly<{
    add<T extends Disposable>(value: T): T;
  }>;
  readonly commands: Readonly<{
    register(
      id: string,
      handler: (...args: unknown[]) => unknown,
      metadata?: CommandMetadata
    ): Promise<Disposable>;
    execute(id: string, ...args: unknown[]): Promise<unknown>;
  }>;
  readonly contributions: Readonly<{
    register(
      point: ContributionPoint,
      contribution: object,
      options?: { id?: string }
    ): Promise<Disposable>;
  }>;
  readonly i18n: Readonly<{
    locale: 'en' | 'zh-CN' | 'ja';
    t(key: string, values?: Record<string, string | number | boolean>): string;
    onDidChange(listener: (event: { locale: string }) => void): Disposable;
  }>;
  readonly sourceControl: Readonly<{
    register(descriptor: SourceControlDescriptor): Promise<SourceControlStateProvider>;
  }>;
  readonly documentViews: Readonly<{
    register(descriptor: { id: string; title: string }): Promise<Disposable>;
  }>;
  readonly agents: Readonly<{
    register(descriptor: AgentDescriptor): Promise<AgentStateProvider>;
  }>;
  readonly models: Readonly<{
    list(): Promise<{ models: readonly AgentModelChoice[] }>;
    generate(request: AgentModelGenerateRequest): Promise<AgentModelGenerateResult>;
    cancel(requestId: string): Promise<{ success: boolean; cancelled: boolean }>;
  }>;
  readonly tools: Readonly<{
    invoke(tool: string, input?: object): Promise<unknown>;
  }>;
  readonly skills: Readonly<{
    list(): Promise<{ skills: readonly AgentSkillSummary[] }>;
    read(skillId: string): Promise<AgentSkillDocument>;
  }>;
  readonly storage: Readonly<{
    read(): Promise<{ value: object }>;
    write(value: object): Promise<{ saved: true; bytes: number }>;
  }>;
  readonly services: Readonly<{
    get(id: string): Promise<unknown>;
  }>;
  readonly host: Readonly<{
    request(method: 'host.getInfo' | 'permissions.get', args?: null): Promise<unknown>;
  }>;
}
```

`context.subscriptions.add()` owns a disposable until deactivation. The host disposes subscriptions in reverse registration order. Calling `dispose()` multiple times is safe.

## Permissions

For API 1.5.0, a package may request only these permissions:

| Permission | Enables |
| --- | --- |
| `commands.register` | `context.commands.register()` |
| `commands.execute` | `context.commands.execute()` |
| `contributions.register` | `context.contributions.register()` |
| `services.read` | `context.services.get()` |
| `sourceControl.register` | `context.sourceControl.register()` |
| `fileDecorations.scm` | `context.fileDecorations.registerScm()` and its state publisher |
| `scm.git.read` | Read-only local SCM requests through `context.scm.git` |
| `scm.git.write` | Local SCM mutation requests through `context.scm.git` |
| `documentViews.register` | Register a manifest-declared document viewer with the workbench. |
| `documents.read` | Let that viewer read only the document the user opened through a scoped opaque handle. |
| `agents.register` | Register one host-rendered Agent workbench provider and publish bounded state. |
| `models.generate` | List opaque host model references and generate through a configured local AI profile. |
| `workspace.read` | Invoke the bounded `workspace_list`, `workspace_read`, and `workspace_search` tools. |
| `workspace.write` | Let the plugin request a pending `workspace_write`; only the trusted workbench can decide it. |
| `process.execute` | Let the plugin request a pending structured process; only the trusted workbench can decide or cancel it. |
| `skills.read` | Discover and read bounded `SKILL.md` files through opaque skill ids. |
| `storage.local` | Read and atomically replace plugin-private JSON state. |

A manifest declaration is the package's hard capability ceiling. BOBOCloud automatically enables all declared permissions after a verified install or update; users can revoke or restore each permission in the **Extensions** detail tab. A call still requires both the manifest declaration and a currently active grant. Undeclared or revoked calls reject with `EXTENSION_PERMISSION_DENIED`.

API 1.5 adds only the named local Agent brokers above. It does not add arbitrary filesystem access, a shell command string, caller-selected environment variables, raw network connections, credentials, MCP process control, DAP, or arbitrary IPC. Every Agent filesystem result is workspace-relative, model profiles are exposed only as opaque references, and writes or processes pass through the trusted access policy and host risk matrix. `documents.read` remains limited to the current user-opened document through a sender-, plugin-, viewer-, workspace-, size-, and modification-bound opaque handle. The local SCM methods below likewise remain a narrow broker rather than a general workspace, process, or network capability.

## Commands

```js
const disposable = await context.commands.register(
  'acme.project-tools.run',
  async (resource) => ({ resource, accepted: true }),
  { title: 'Acme: Run', category: 'Extensions', hint: '' }
);
context.subscriptions.add(disposable);
```

Command ids must begin with `context.extension.id + '.'`. The handler remains in the sandbox. The host routes only its data arguments and response. One plugin cannot overwrite another plugin's command id.

`commands.execute` accepts any registered command id but is separately permission-gated. A successful invocation performs the target command's normal side effects, so this permission is intentionally significant and must not be used to bypass a missing capability.

Some BOBOCloud command palette builds do not yet expose disposable third-party command registration. The command registry and lifecycle remain active, but visible command-palette placement should be treated as an optional integration until the palette consumer advertises support.

## Contributions

Plugin contribution ids must also begin with the plugin id plus `.`. API 1.5.0 accepts data declarations at these points:

| Point | API status |
| --- | --- |
| `menus` | Declarative storage; a full third-party menu consumer is pending. |
| `tasks` | Declarative storage; third-party cloud task execution is pending. |
| `settings` | Declarative storage; typed settings UI consumer is pending. |
| `languages` | Declarative storage; Monaco provider consumer is pending. |
| `ai.tools` | Declarative storage; model tool consent and execution are pending. |
| `mcp.providers` | Declarative storage; main-process MCP lifecycle is pending. |
| `skills.providers` | Declarative storage; skill catalog consumer is pending. |

`documentViews` and `agents` use dedicated structurally validated registration APIs and cannot be registered through `context.contributions.register()`. Executable file-decoration callbacks and debug-configuration providers are intentionally not exposed to installed package code because they require executable callbacks or security-sensitive workflow ownership. The static SCM decoration publisher documented below remains the sole data-only file-decoration exception in API 1.5.0.

## Document Views

Document viewers require package schema 2 and both `documentViews.register` and `documents.read`. The manifest is the executable-code allowlist:

```json
{
  "schemaVersion": 2,
  "permissions": ["documentViews.register", "documents.read"],
  "contributes": {
    "documentViewers": [{
      "id": "acme.project-tools.markdown",
      "extensions": [".md", ".markdown"],
      "entry": "dist/document-view.js",
      "resources": ["dist/document-view.css"],
      "priority": 100
    }]
  }
}
```

A package may declare at most 16 viewers. Viewer ids are unique and namespaced; each viewer has 1 to 32 unique lowercase extensions, one included `.js` or `.mjs` entry, up to 16 included text resources, and an integer priority from -1000 to 1000. The host selects the longest matching extension, then the highest priority. A selected registered viewer takes precedence over built-in file fallbacks such as the image preview; built-in handling remains available when no registered viewer matches. A view entry or resource is limited to 8 MiB and the combined loaded view is limited to 24 MiB. Every file remains covered by the package integrity map and is SHA-256 verified at load time.

The activation Worker registers only a manifest-declared viewer id and a localized title:

```js
export async function activate(context) {
  const registration = await context.documentViews.register({
    id: 'acme.project-tools.markdown',
    title: context.i18n.t('Markdown preview')
  });
  context.subscriptions.add(registration);
}
```

The view entry separately exports `activate(context)`. It runs inside its own `sandbox="allow-scripts"` iframe with an opaque origin. Its CSP denies connections, forms, nested frames, object/media loads, and undeclared URLs. `fetch`, XHR, WebSocket, EventSource, WebTransport, RTC, `window.open`, and beacons are blocked. The iframe has no Node.js, Electron, preload bridge, workbench object, parent DOM, workspace path, or absolute document path. Blob Workers are allowed only so bundled parsers such as PDF.js can process bytes without blocking the view.

```ts
interface DocumentViewContext {
  readonly root: HTMLElement;
  readonly document: Readonly<{
    documentId: string;
    name: string;
    extension: string;
    size: number;
    lastModified: string;
  }>;
  readonly viewer: Readonly<{
    id: string;
    title: string;
    extensions: readonly string[];
    priority: number;
  }>;
  readonly i18n: PluginI18n;
  readonly assets: Readonly<{ url(resourcePath: string): string }>;
  read(offset: number, length: number): Promise<Uint8Array>;
  readAll(maximumBytes?: number): Promise<Uint8Array>;
  readText(maximumBytes?: number, encoding?: string): Promise<string>;
}
```

`read()` accepts only a bounded range and returns at most 2 MiB. `readAll()` and `readText()` reject above the caller-supplied bound and never exceed the host's 128 MiB ceiling. The main process revalidates the current workspace and file identity on every chunk. A workspace switch, file replacement, size/mtime change, permission revocation, plugin disable, sender destruction, or tab close invalidates the session. `assets.url()` returns a temporary Blob URL only for a resource declared by that viewer; no package path is exposed.

## Source-Control Sidebar

`context.sourceControl` is a generic, data-only sidebar API. The workbench creates its activity-bar item and panel dynamically for each registered provider. The extension may publish localized titles, bounded summary facts, sections, item lists, forms, and named actions, but cannot provide HTML, CSS, URLs, DOM nodes, callbacks, or arbitrary command arguments.

### Registration and state

`sourceControl.register` returns a lifecycle-owned state provider:

```ts
const view = await context.sourceControl.register({
  id: 'publisher.extension.workspace-view',
  title: context.i18n.t('Workspace records'),
  icon: 'git-branch',
  order: 0,
  openCommand: 'publisher.extension.openWorkspaceView'
});

await view.setState({
  phase: 'ready',
  title: context.i18n.t('Workspace records'),
  summary: {
    items: [{ label: context.i18n.t('Selected'), value: '1' }]
  },
  sections: [{
    id: 'records',
    title: context.i18n.t('Records'),
    items: []
  }],
  actions: [{
    id: 'refresh',
    title: context.i18n.t('Refresh'),
    command: 'publisher.extension.refreshWorkspaceView',
    kind: 'primary'
  }]
});
```

`id`, `openCommand`, every section-item command, every action command, and every load-more command must use the calling plugin namespace. `icon` currently accepts only `git-branch`; `order` is an integer from `-1000` through `1000`. Disabling, refreshing, or uninstalling a package disposes the provider and removes its activity item and panel.

`SourceControlState` accepts `phase` (`idle`, `loading`, `ready`, `empty`, or `error`), optional localized `title` and `message`, one bounded summary, at most 8 bounded sections, and at most 16 actions. Each section contains bounded item data and may contain one `loadMore` command. An action can be immediate or carry one bounded host-rendered form containing text, textarea, select, and checkbox fields. Actions may request the host-owned `button`, compact `toolbar`, or overflow `menu` placement. Toolbar actions must use a supported semantic icon token; plugins cannot provide SVG, HTML, CSS, or their own menu DOM. The exact TypeScript shapes are in [plugin-sdk/bobocloud-plugin.d.ts](../client/plugin-sdk/bobocloud-plugin.d.ts).

When the user invokes a state command, the registered extension command receives exactly one `SourceControlCommandPayload` argument:

```ts
{
  sourceControlId: 'publisher.extension.workspace-view',
  actionId: 'refresh',
  values: {},
  kind: 'action'
}
```

For a section item, the payload also includes `sectionId` and `itemId`; for a load-more action it includes `sectionId` and `kind: 'loadMore'`. Form `values` are revalidated by the host and include only the declared fields. Use `clearState()` to return a provider to its host-rendered waiting state, then call `dispose()` when the provider is no longer needed.

## Agent Platform

API 1.5 separates the reusable local capability plane from product-specific Agent orchestration:

| Layer | Owner | Responsibilities |
| --- | --- | --- |
| Trusted workbench | BOBOCloud renderer | Activity item, session rail, editor-sized Agent tab, message/timeline/goal rendering, inputs, accessibility, and command payload construction. |
| Capability brokers | BOBOCloud main process | Model-profile lookup, provider requests, workspace path validation, local tool execution, approval tokens, Skill discovery, and plugin-private storage. |
| Orchestrator | Downloaded plugin Worker | Prompts, turn loop, tool selection, goal planning, session semantics, cancellation state, localization, and bounded state publication. |

Chat and inline completion stay as BOBOCloud-native features. An Agent is a separate plugin contribution and may reuse a configured model only through an opaque `modelRef`; it never receives the underlying endpoint credential or API key. No Agent provider appears when no enabled plugin has registered one, and disable, replacement, activation failure, uninstall, or host shutdown removes the provider and its state.

### Registration and state

`context.agents.register()` requires `agents.register`. The provider id and all nine command ids must use the calling plugin namespace:

```js
const agent = await context.agents.register({
  id: 'publisher.agent.main',
  title: context.i18n.t('AI Agent'),
  icon: 'sparkles',
  commands: {
    create: 'publisher.agent.create',
    select: 'publisher.agent.select',
    delete: 'publisher.agent.delete',
    send: 'publisher.agent.send',
    cancel: 'publisher.agent.cancel',
    approve: 'publisher.agent.approve',
    reject: 'publisher.agent.reject',
    preferences: 'publisher.agent.preferences',
    configure: 'publisher.agent.configure'
  },
  capabilities: {
    modes: ['chat', 'goal'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    accessModes: ['ask', 'auto', 'full'],
    skills: true,
    localTools: true
  }
});

await agent.setState({
  phase: 'ready',
  activeSessionId: 'session-1',
  sessions: [{ id: 'session-1', title: 'Inspect project', mode: 'goal', status: 'running' }],
  models: (await context.models.list()).models,
  skills: [],
  activeSession: {
    id: 'session-1',
    title: 'Inspect project',
    status: 'running',
    mode: 'goal',
    reasoningEffort: 'xhigh',
    accessMode: 'ask',
    messages: [],
    timeline: [],
    goal: { title: 'Inspect project', status: 'in-progress', steps: [] },
    approval: null,
    compacting: false,
    compaction: null
  }
});
```

The workbench invokes a referenced command with exactly one `AgentCommandPayload`: `{ providerId, action }` plus only the bounded fields relevant to that action (`sessionId`, `text`, `mode`, `reasoningEffort`, `accessMode`, `modelRef`, `skillIds`, `approvalId`, or the canonical host-produced `approvalResult`). The plugin owns command behavior and republishes a complete state snapshot after each meaningful transition. The host accepts no HTML, CSS, SVG, URLs, callbacks, or DOM objects in the descriptor or state.

Agent command handlers must acknowledge quickly and continue model/tool work in plugin-owned asynchronous tasks. Installed command invocations retain the normal 10-second upper bound, so a `send` handler must not await the complete model turn. Track the task by session/request id, publish progress, and let `cancel` stop the corresponding model request and plugin orchestration. An approved process is cancelled only by the trusted workbench/main path described below.

The state model supports `idle`, `loading`, `ready`, `unconfigured`, and `error` provider phases; chat and goal sessions; low, medium, high, xhigh, and max reasoning effort; messages; a thought/tool/status/skill/compaction/error timeline; goal steps; bounded compaction metadata; and at most one pending approval for the active session. A plugin may mirror `accessMode` for session semantics, but that value is not authorization and the trusted workbench ignores it when deciding host access. Exact limits and shapes are in [plugin-sdk/bobocloud-plugin.d.ts](../client/plugin-sdk/bobocloud-plugin.d.ts).

### Model broker

`context.models.list()`, `context.models.generate()`, and `context.models.cancel()` require `models.generate`. `list()` returns bounded display metadata and opaque refs such as a chat-profile ref. `generate()` accepts bounded messages, JSON-schema function tools, a selected opaque ref, a plugin-local request id, and a reasoning effort. The host prefixes that request id with the plugin identity before dispatch. `cancel(requestId)` can therefore cancel only the calling plugin's matching in-flight request. The host resolves the model ref against current local AI settings and sends the request with the host-owned secret profile. A missing, revoked, or incomplete profile fails cleanly; no fallback key or endpoint is sent into the Worker.

Reasoning effort is a portable Agent-level control. The broker maps it to provider-native fields only for profiles that explicitly enable that provider option; otherwise it still controls the orchestrator's budget and defaults without sending an unsupported provider parameter.

### Trusted access modes

Access mode is host-owned state bound to the exact plugin, provider, session, and current workspace lifecycle:

| Mode | Host behavior |
| --- | --- |
| `ask` | Every workspace write or process request becomes a pending approval. |
| `auto` | The host automatically executes only operations its deterministic policy classifies as low or medium risk. High-risk operations still become pending approvals. |
| `full` | The host skips approval for all already-permitted fixed Agent tools only after an explicit dangerous-action confirmation in trusted UI. |

The trusted workbench selects and activates a session context through `window.api.agentAccessGet({ pluginId, providerId, sessionId })`, changes it through `window.api.agentAccessSet({ pluginId, providerId, sessionId, accessMode, confirmed })`, and removes it when the session is deleted through `window.api.agentAccessClear({ pluginId, providerId, sessionId })`. All three return `{ pluginId, providerId, sessionId, accessMode }`; `clear` always returns `ask`. Setting `full` requires `confirmed: true`; the UI must obtain that value only after an explicit user confirmation. These preload methods are not present in the downloaded Worker context. `tools.invoke()` accepts no access-mode or session override, so plugin-supplied fields cannot elevate authority.

Access choices are volatile. Deleting a session, switching the active session, downgrading a context, revoking an Agent permission, disabling/replacing/uninstalling the plugin, switching workspace, or disposing the host cancels or clears applicable automatic authority. The broker re-reads the trusted mode after asynchronous path/executable resolution and immediately before an operation becomes pending or active, preventing an in-flight request from retaining a stale higher mode.

`full` means unrestricted approval within the already granted Agent capability set, not unrestricted machine access. It never bypasses manifest grants, the Worker sandbox, workspace-relative and symlink checks, expected file hashes, the process executable allowlist, structured argv/cwd rules, sanitized environment, concurrency/output/time limits, workspace identity, or lifecycle cancellation.

### Local tools and approval

`context.tools.invoke(name, input)` exposes only these fixed tools:

| Tool | Permission | Behavior |
| --- | --- | --- |
| `workspace_list` | `workspace.read` | Lists bounded file/directory entries under a workspace-relative path. |
| `workspace_read` | `workspace.read` | Reads one regular UTF-8 text file up to 2 MiB and returns its SHA-256. |
| `workspace_search` | `workspace.read` | Searches bounded text files, skips symlinks and common generated trees, and returns workspace-relative matches. |
| `workspace_write` | `workspace.write` | Validates a relative path and expected file hash, then applies the trusted access policy. |
| `process_run` | `process.execute` | Validates one allowlisted executable, an argument array, relative cwd, and timeout, then applies the trusted access policy. |

Read tools execute immediately. The main process assigns every write/process operation a host-authoritative `riskLevel`:

| Operation | Risk level |
| --- | --- |
| Version/help process probes and allowlisted read-only Git inspection | `low` |
| Ordinary workspace file creation or replacement | `medium` |
| Writes to environment/credential files, Git or CI control data, VS Code task/settings files, package/container/build entry files, or executable scripts | `high` |
| Interpreter, package-manager, build-system, Git mutation/network, and every other process execution | `high` |

The matrix is implemented in the main process from validated canonical input. Plugins cannot provide or lower `riskLevel`. In `ask`, and for high-risk `auto` calls, write/process tools follow this protocol:

1. `context.tools.invoke()` returns `{ approvalRequired: true, approval: { id, tool, summary, risk, riskLevel, accessMode, expiresAt } }`. The id identifies a pending operation but is not authority to execute it.
2. The plugin publishes only `{ approval: { id } }` in `AgentState`. Tool, summary, risk, expiry, and details are not accepted from plugin state.
3. The trusted workbench asks the main process to `describe` the id and renders approve and reject controls only from that canonical plugin-bound, workspace-bound operation.
4. Only a user click in trusted UI calls main-process `decide`. The main process rechecks ownership, grant, expiry, workspace identity, and file state, consumes the pending operation once, and executes or rejects it. A running process can likewise be cancelled only through the trusted workbench/main path.
5. After the main process returns its canonical result, the workbench invokes the plugin's namespaced `approve` or `reject` command with `{ approvalId, approvalResult }`. That command resumes orchestration; it does not authorize or perform the local side effect.

Approval ids expire after ten minutes and cannot be reused or transferred between plugins. The Worker context deliberately has no `tools.approve`, `tools.reject`, `tools.decide`, or `tools.cancel`; knowing or fabricating an approval id cannot produce the side effect. A pending write is also protected by optimistic SHA-256 validation before and after approval. Process execution uses an exact executable plus argv array with `shell: false`, a workspace-relative cwd, a maximum 120-second timeout, bounded output, and no plugin-supplied environment. The trusted decision IPC may remain pending until an approved process exits while the workbench stays responsive and can issue a trusted cancel. Plugin disable, uninstall, replacement, or host disposal also terminates its running processes. The allowlist contains common cross-platform developer tools, but the host does not install them; plugins must handle a tool being absent on Windows, macOS, or Linux.

When `auto` or confirmed `full` authorizes an operation, `invoke()` returns the canonical write/process result directly with `autoApproved: true`, the applied `accessMode`, and `riskLevel`. No approval command is involved. The plugin must handle the declared union of a pending approval and a completed result.

### Skills and local storage

`context.skills.list()` and `read()` require `skills.read`. The host discovers bounded `SKILL.md` files from supported workspace and user roots for `.agents`, `.codex`, and `.claude`, returns an opaque id plus metadata, and reveals content only when that id is read. It never returns the filesystem path. Skill text is untrusted instruction data: the plugin decides whether to include it in a model turn, while every resulting local action still passes through the normal tool permission and approval boundary.

`context.storage` requires `storage.local`. It reads or atomically replaces one JSON object isolated by plugin id in BOBOCloud application data, with an 8 MiB limit. It is suitable for session summaries and preferences, not secrets; the storage API is whole-document replacement rather than a transactional database.

## Plugin-local Localization

Bundle package-owned visible strings in flat JSON files and declare them in the manifest:

```json
{
  "localization": {
    "default": "language-packs/en/messages.json",
    "zh-CN": "language-packs/zh-CN/messages.json",
    "ja": "language-packs/ja/messages.json"
  }
}
```

Every path must be package-relative, use `/`, point to an included `.json` file, and be listed in `integrity.files`. The main process verifies the selected file against its declared SHA-256 on every load, limits it to a flat bounded string map, and returns only `{ locale, messages }` to the sandbox. It never exposes a package path.

Use `context.i18n` for every package-owned string that reaches a host-rendered view. It is ready before `activate(context)` runs:

```js
const title = context.i18n.t('Workspace records');
const localeSubscription = context.i18n.onDidChange(() => {
  // Re-publish localized data for any active host-rendered provider.
  void view.setState(makeLocalizedState(context.i18n));
});
context.subscriptions.add(localeSubscription);
```

`locale` is always `en`, `zh-CN`, or `ja`. The loader prefers the selected locale, then `default`, then `en`; an undeclared locale resource produces an empty message map. Package messages are isolated from BOBOCloud's language packs and cannot modify them.

## Local SCM API

This section documents the separately permissioned local source-control broker. All values are bounded JSON-like data. The host chooses the active local workspace; a plugin cannot provide an absolute path, a working directory, an environment object, a shell command, or arbitrary command-line arguments.

### SCM file decorations

The existing file-tree `scm` rail is separate from the `sync` and `diagnostic` rails. A package that has `fileDecorations.scm` can publish status data through a static provider:

```ts
const decorations = await context.fileDecorations.registerScm({
  id: 'publisher.extension.scm-status',
  priority: 0
});

await decorations.set([
  { path: 'src/example.js', status: 'modified' }
]);
await decorations.clear(['src/example.js']);
decorations.dispose();
```

`path` is a non-empty workspace-relative path. It must not be absolute, contain `..`, or contain control characters. A publication accepts at most 4096 entries and each path appears once. `status` is one of `added`, `modified`, `deleted`, `renamed`, `untracked`, `conflicted`, or `ignored`.

The plugin never supplies a badge, color, tooltip, ARIA label, style, DOM node, or rendering callback. BOBOCloud owns all presentation and removes the provider state when the provider or plugin is disposed.

### Local SCM broker

`context.scm.git.detect({ includeNested?: boolean })` is the only discovery call. It returns repository descriptors:

```ts
{
  repositories: [{
    repositoryId: 'scm-opaque-session-token',
    relativeRoot: '',
    isWorkspaceRoot: true
  }]
}
```

`repositoryId` is an opaque, session-scoped capability token. It is not a filesystem path. The token becomes stale when the active local workspace changes, disappears, or no longer resolves to the same repository. `relativeRoot` is the only location value returned and is relative to the selected workspace.

`status()` repeats the repository's `relativeRoot`. Its `changes[].path` and `originalPath` are relative to that repository, not directly to the workspace. A consumer that publishes those changes through `fileDecorations.registerScm()` must prefix the path with `status.relativeRoot` (unless it is empty). It must normalize the combined value as a workspace-relative path and must never infer or request an absolute path.

The following methods require `scm.git.read`:

| Method | Input after `repositoryId` | Result |
| --- | --- | --- |
| `status` | `offset?: 0..10000`, `limit?: 1..200` | A bounded changed-path page with `offset`, `limit`, `total`, `hasMore`, and `nextOffset`. Each changed record may expose staged and working-tree `{ additions, deletions }` statistics when safely available. |
| `history` | `offset?: 0..10000`, `limit?: 1..500`, `ref?: string` | A bounded commit page with `offset`, `hasMore`, and `nextOffset`; records contain hash, parents, author, date, and subject. |
| `diff` | `path?: relative path`, `ref?: string`, `staged?: boolean` | Bounded diff text with `truncated`. |
| `branches` | none | Current, local, and remote branch metadata. |
| `remotes` | none | Remote names and sanitized URLs. |

The following methods require `scm.git.write`:

| Method | Additional input | Result |
| --- | --- | --- |
| `init` | none | A descriptor for the active workspace root. |
| `clone` | `url`, `branch?: string` | A descriptor after cloning only into an empty active local workspace; no destination path is accepted. |
| `setRemote` | `repositoryId`, `name`, `url` | Sanitized remote descriptor. |
| `stage`, `unstage` | `repositoryId`, `paths: relative path[]` | Updated status. |
| `stageAll` | `repositoryId` | Stages all changes in the selected local repository and returns updated bounded status. |
| `commit` | `repositoryId`, `message` | Commit identifier. |
| `checkout` | `repositoryId`, `branch`, `force?: boolean` | Active branch name. |
| `createBranch` | `repositoryId`, `name`, `checkout?: boolean` | Branch name and `checkedOut`. |
| `deleteBranch` | `repositoryId`, `name`, `force?: boolean` | Deleted local branch name; the checked-out branch is rejected. |
| `fetch` | `repositoryId`, `remote?: string` | Bounded operation result. |
| `pull` | `repositoryId`, `remote?: string`, `branch?: string` | Bounded operation result. |
| `push` | `repositoryId`, `remote?: string`, `branch?: string`, `force?: boolean`, `setUpstream?: boolean` | Bounded operation result. |

The exact TypeScript signatures and result shapes are in [plugin-sdk/bobocloud-plugin.d.ts](../client/plugin-sdk/bobocloud-plugin.d.ts). The host permits only HTTPS and SSH remote URLs; embedded credentials, local-file URLs, custom helpers, arbitrary Git configuration, and interactive prompts are rejected. The plugin never receives credentials. A device's normal local credential helper or SSH agent may satisfy a host-mediated remote operation.

Stable local-SCM error codes are:

`SCM_GIT_UNAVAILABLE`, `SCM_GIT_NO_WORKSPACE`, `SCM_GIT_WORKSPACE_NOT_EMPTY`, `SCM_GIT_INVALID_ARGUMENT`, `SCM_GIT_REPOSITORY_NOT_FOUND`, `SCM_GIT_STALE_REPOSITORY`, `SCM_GIT_NOT_REPOSITORY`, `SCM_GIT_BRANCH_CHECKED_OUT`, `SCM_GIT_REMOTE_DENIED`, `SCM_GIT_AUTH_REQUIRED`, `SCM_GIT_IDENTITY_REQUIRED`, `SCM_GIT_NOTHING_TO_COMMIT`, `SCM_GIT_CLONE_FAILED`, `SCM_GIT_CONFLICT`, `SCM_GIT_OUTPUT_TOO_LARGE`, and `SCM_GIT_OPERATION_FAILED`.

### Implemented vs Reserved

API v1 implements package installation and validation, permission storage, isolated activation, lifecycle cleanup, the command registry, the `workbench.projectTasks` read-only snapshot, local SCM broker mediation, the host-rendered source-control sidebar, static SCM file-tree decorations, schema-2 document views, and the API 1.5 Agent platform described above. The generic `ai.tools` and `skills.providers` declarations remain reserved; they do not invoke models or load Skills. Agent plugins use the dedicated `context.models`, `context.tools`, `context.skills`, and `context.agents` APIs instead. Other declarative points are stored and disposed correctly but still do not add a visible menu, create a settings UI, run a cloud task, register a Monaco provider, or start MCP.

## Services

`services.get(id)` returns a cloned, read-only view and currently allows only `workbench.projectTasks`.

The caller does not receive the host object, a path, task command lines, secrets, mutable state, or a back reference to the renderer. Unknown service ids are denied.

## Status and Errors

The management UI consumes only the sanitized plugin record:

```ts
interface PluginRecord {
  id: string;
  displayName: string;
  description: string;
  version: string;
  enabled: boolean;
  status: "enabled" | "disabled" | "invalid" | "incompatible";
  requestedPermissions: readonly string[];
  grantedPermissions: readonly string[];
  manifest: ManifestDescriptor | null;
  integrity: { valid: boolean; reason: string };
  installedAt: string;
}
```

`invalid` identifies an integrity or package validation failure. `incompatible` identifies an engine range mismatch. Both statuses force the package disabled and clear grants. A verified replacement restores its declared default grants; the user may revoke them again from the detail page.

## Workbench Detail Page

The trusted BOBOCloud renderer exposes one narrow internal navigation helper for the Extensions sidebar:

```ts
BOBO.pluginDetails.open(pluginId: string): Promise<boolean>
```

It opens or reuses one closeable main-workbench tab per installed plugin id. The page renders only the sanitized `PluginRecord`: identity, version, status, integrity state, engine ranges, requested/granted permissions, activation events, and contribution-point names. It never displays package source, an installation path, or secrets, and it never creates or changes a Monaco editor model. A `plugins:changed` event refreshes opened details or closes a tab for an uninstalled package.

This helper is not available to installed package code and is not part of Plugin API 1.5.0.

Typical runtime failures have stable error codes:

- `EXTENSION_PERMISSION_DENIED`
- `EXTENSION_INVALID_REQUEST`
- `EXTENSION_NOT_FOUND`
- `EXTENSION_PROTOCOL_ERROR`
- `EXTENSION_TIMEOUT`
- `EXTENSION_UNAVAILABLE`
- `EXTENSION_CANCELLED`

Agent brokers additionally return stable `AGENT_*` failures for missing or stale workspaces, invalid paths and requests, unconfigured or failed models, storage limits, file conflicts, denied commands, expired approvals, missing Skills, and process failures. The complete union is in the SDK declaration.

Errors are attributed to the owning plugin and do not abort workbench startup or unrelated plugins.

## Host Metadata And Internal Bridges

`context.host.request()` is a deliberately small, read-only plugin API. It accepts only `host.getInfo` (the API version and calling plugin identity) and `permissions.get` (the calling plugin's requested and granted permissions). Neither method needs a manifest permission, accepts useful arguments, or grants a general broker capability. Any other method is denied. Local SCM and Agent capabilities are exposed only through their dedicated, permissioned context namespaces, never through this generic metadata broker.

`window.api.plugins` is an application-internal preload bridge for the trusted BOBOCloud renderer. It exposes package management, validated descriptor, source, and broker calls to the extension host. It is not available to plugin code and must not be treated as a public plugin API.

The host metadata methods do not expose filesystem, network, process, credential, MCP, AI, task, debug, or arbitrary IPC access. API 1.5's Agent methods remain explicit, permissioned, mediated by the main process, workspace-scoped, and governed by trusted access state plus the host risk matrix where they can mutate state.

## Future Direction

Future API versions may add narrower networking, credential-reference, MCP, task-execution, language-server, debug-provider, and richer workspace-edit capabilities. Each must remain separately versioned, sandboxed, permissioned, mediated by the main process, and accompanied by a visible user-facing explanation.
