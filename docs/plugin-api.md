# BOBOCloud Plugin API 1.2.0

Status: public package and isolated extension-host contract. BOBOCloud `2.6.0` is the first host release for this API.

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
    "bobocloud": ">=2.6.0 <3.0.0",
    "pluginApi": "^1.2.0"
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

The root file is named `manifest.json`. A `.boboplugin` is a ZIP archive with that file at archive root. The user-facing installer accepts only this archive format; development-folder installation is reserved for internal development and test controllers. A package contains one bundled JavaScript entry in API v1 and the integrity map covers every non-manifest file exactly once.

The matching TypeScript declaration is [plugin-sdk/bobocloud-plugin.d.ts](../plugin-sdk/bobocloud-plugin.d.ts). [examples/plugins/hello-plugin](../examples/plugins/hello-plugin) is a minimal installable directory package with a verified integrity hash.

## Execution Boundary

An opaque-origin sandboxed iframe is used only as a strict transport shell (`sandbox=allow-scripts`); it does not execute package code directly. The shell creates one host-generated Blob Worker, and that dedicated worker executes the installed entry after receiving it over a `MessageChannel`. The worker has no Node.js, Electron API, raw preload bridge, direct renderer object, arbitrary DOM, local filesystem, process, or network access. Its CSP permits only the Blob Worker (`worker-src blob:`) and denies external connections, frames, and object/media loads; the worker also disables `fetch`, XHR, WebSocket, EventSource, `importScripts`, nested workers, and shared workers.

The host verifies the entry SHA-256 before passing the source through the channel. The sandbox imports that single source from a Blob URL. Relative JavaScript imports are consequently unsupported.

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

For API 1.2.0, a package may request only these permissions:

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

A manifest declaration is the package's hard capability ceiling. BOBOCloud automatically enables all declared permissions after a verified install or update; users can revoke or restore each permission in the **Extensions** detail tab. A call still requires both the manifest declaration and a currently active grant. Undeclared or revoked calls reject with `EXTENSION_PERMISSION_DENIED`.

There is no plugin capability for workspace reads or writes, shell/process spawning, raw network connections, credentials, MCP process control, AI model access, DAP, or arbitrary IPC in API 1.2.0. The local SCM methods below are a narrow main-process broker, not a general workspace, process, or network capability.

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

Plugin contribution ids must also begin with the plugin id plus `.`. API 1.2.0 accepts only data declarations at these points:

| Point | API status |
| --- | --- |
| `menus` | Declarative storage; a full third-party menu consumer is pending. |
| `tasks` | Declarative storage; third-party cloud task execution is pending. |
| `settings` | Declarative storage; typed settings UI consumer is pending. |
| `languages` | Declarative storage; Monaco provider consumer is pending. |
| `ai.tools` | Declarative storage; model tool consent and execution are pending. |
| `mcp.providers` | Declarative storage; main-process MCP lifecycle is pending. |
| `skills.providers` | Declarative storage; skill catalog consumer is pending. |

Executable file-decoration callbacks and debug-configuration providers are intentionally not exposed to installed package code because they require executable callbacks or security-sensitive workflow ownership. The static SCM decoration publisher documented below is the sole data-only file-decoration exception in API 1.2.0.

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

`SourceControlState` accepts `phase` (`idle`, `loading`, `ready`, `empty`, or `error`), optional localized `title` and `message`, one bounded summary, at most 8 bounded sections, and at most 16 actions. Each section contains bounded item data and may contain one `loadMore` command. An action can be immediate or carry one bounded host-rendered form containing text, textarea, select, and checkbox fields. Actions may request the host-owned `button`, compact `toolbar`, or overflow `menu` placement. Toolbar actions must use a supported semantic icon token; plugins cannot provide SVG, HTML, CSS, or their own menu DOM. The exact TypeScript shapes are in [plugin-sdk/bobocloud-plugin.d.ts](../plugin-sdk/bobocloud-plugin.d.ts).

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

The exact TypeScript signatures and result shapes are in [plugin-sdk/bobocloud-plugin.d.ts](../plugin-sdk/bobocloud-plugin.d.ts). The host permits only HTTPS and SSH remote URLs; embedded credentials, local-file URLs, custom helpers, arbitrary Git configuration, and interactive prompts are rejected. The plugin never receives credentials. A device's normal local credential helper or SSH agent may satisfy a host-mediated remote operation.

Stable local-SCM error codes are:

`SCM_GIT_UNAVAILABLE`, `SCM_GIT_NO_WORKSPACE`, `SCM_GIT_WORKSPACE_NOT_EMPTY`, `SCM_GIT_INVALID_ARGUMENT`, `SCM_GIT_REPOSITORY_NOT_FOUND`, `SCM_GIT_STALE_REPOSITORY`, `SCM_GIT_NOT_REPOSITORY`, `SCM_GIT_BRANCH_CHECKED_OUT`, `SCM_GIT_REMOTE_DENIED`, `SCM_GIT_AUTH_REQUIRED`, `SCM_GIT_IDENTITY_REQUIRED`, `SCM_GIT_NOTHING_TO_COMMIT`, `SCM_GIT_CLONE_FAILED`, `SCM_GIT_CONFLICT`, `SCM_GIT_OUTPUT_TOO_LARGE`, and `SCM_GIT_OPERATION_FAILED`.

### Implemented vs Reserved

API v1 implements package installation and validation, permission storage, isolated activation, lifecycle cleanup, the command registry, the `workbench.projectTasks` read-only snapshot, local SCM broker mediation, the host-rendered source-control sidebar, and static SCM file-tree decorations. The remaining declarative contribution points are stored and disposed correctly, but their user-facing consumers are reserved: they do not yet add a visible menu, create a settings UI, run a cloud task, register a Monaco provider, invoke an AI tool, start MCP, or load a skill. Do not advertise those effects from an API v1 package.

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

This helper is not available to installed package code and is not part of Plugin API 1.2.0.

Typical runtime failures have stable error codes:

- `EXTENSION_PERMISSION_DENIED`
- `EXTENSION_INVALID_REQUEST`
- `EXTENSION_NOT_FOUND`
- `EXTENSION_PROTOCOL_ERROR`
- `EXTENSION_TIMEOUT`
- `EXTENSION_UNAVAILABLE`
- `EXTENSION_CANCELLED`

Errors are attributed to the owning plugin and do not abort workbench startup or unrelated plugins.

## Host Metadata And Internal Bridges

`context.host.request()` is a deliberately small, read-only plugin API. It accepts only `host.getInfo` (the API version and calling plugin identity) and `permissions.get` (the calling plugin's requested and granted permissions). Neither method needs a manifest permission, accepts useful arguments, or grants a general broker capability. Any other method is denied. Local SCM methods are exposed only through `context.scm.git`, never through this generic metadata broker.

`window.api.plugins` is an application-internal preload bridge for the trusted BOBOCloud renderer. It exposes package management, validated descriptor, source, and broker calls to the extension host. It is not available to plugin code and must not be treated as a public plugin API.

The host metadata methods do not expose filesystem, network, process, credential, MCP, AI, task, debug, or arbitrary IPC access. Future privileged APIs will be explicit, permissioned, mediated by the main process, and user-consented.

## Future Direction

Future API versions may add explicit user-consented capabilities for workspace operations, networking, processes, credential references, MCP services, skills, AI tools, task execution, language servers, and debug providers. Each will be separately versioned, sandboxed, permissioned, mediated by the main process, and accompanied by a visible user-facing explanation.
