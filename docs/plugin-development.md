# BOBOCloud Plugin Development Guide

This guide targets BOBOCloud Plugin API `1.4.0`, whose minimum desktop host is BOBOCloud `2.7.0`.

Plugins are installed locally. They run in an isolated sandbox and communicate with the workbench through a narrow, permission-gated API. A plugin is never given Node.js, Electron IPC, `window.api`, account credentials, the workspace path, or arbitrary DOM access.

For the complete contract, see [Plugin API](./plugin-api.md).

The matching TypeScript declaration is [plugin-sdk/bobocloud-plugin.d.ts](../client/plugin-sdk/bobocloud-plugin.d.ts). A ready-to-install directory package is available at [examples/plugins/hello-plugin](../client/examples/plugins/hello-plugin).

## 1. Quick Start

Create this directory:

```text
hello-plugin/
  manifest.json
  dist/
    extension.js
```

`manifest.json`:

```json
{
  "schemaVersion": 1,
  "id": "example.hello-plugin",
  "displayName": "Hello Plugin",
  "description": "Adds a safe example command.",
  "version": "1.0.0",
  "engines": {
    "bobocloud": ">=2.7.0 <3.0.0",
    "pluginApi": "^1.4.0"
  },
  "main": "dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "permissions": ["commands.register"],
  "contributes": {},
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "dist/extension.js": "REPLACE_WITH_SHA256"
    }
  }
}
```

`dist/extension.js` must be one self-contained ES module:

```js
export async function activate(context) {
  await context.commands.register(
    'example.hello-plugin.sayHello',
    () => ({ message: 'Hello from an isolated BOBOCloud plugin.' }),
    {
      title: 'Hello Plugin: Say Hello',
      category: 'Extensions'
    }
  );
}

export async function deactivate() {
  // Release only resources created by this plugin.
}
```

Calculate the SHA-256 for `dist/extension.js`, replace the manifest value, create a `.boboplugin` archive, then open the **Extensions** activity-bar view and choose **Install .boboplugin package**. The normal user-facing picker accepts only that archive format and remembers a plugin-private import location, never the current workspace folder. The application installs a plugin in a disabled state with its declared permissions granted by default. Open its detail tab to inspect those grants and enable it.

## 2. Package Format

The normal installer accepts a `.boboplugin` ZIP file only. A ZIP archive must contain the package files at its archive root; it must not wrap them in an additional top-level directory. Development-folder installation is an internal test/development controller capability, not a user-facing picker mode.

```text
hello-plugin.boboplugin
  manifest.json
  dist/extension.js
```

The host copies the package into its private application-data directory. That location is intentionally not an API and must not be assumed by a plugin.

### Package rules

- The root `manifest.json` is required and must be valid JSON.
- Package schema version is `1` for activation-only plugins or `2` for plugins that declare document viewers.
- Plugin ids use lower-case reverse-domain notation, such as `publisher.feature`.
- The plugin entry must be a relative POSIX `.js` or `.mjs` path. Backslashes, absolute paths, `..`, hidden segments, symlinks, executables, and special files are rejected.
- The activation entry is one self-contained JavaScript bundle. Relative JavaScript imports are not supported because the sandbox imports the verified entry from a Blob URL.
- Schema 1 rejects every other JavaScript file. Schema 2 additionally allows only document-view entries and JavaScript text resources named by `contributes.documentViewers`.
- Archives must be ordinary single-disk, non-encrypted ZIP files. ZIP64 archives are rejected.
- A package is limited to 128 files, 64 MiB expanded content, 32 MiB archive content, 8 MiB per file, 128 KiB manifest, and 2 MiB activation-entry source at load time. Each document-view entry or resource is limited to 8 MiB and one loaded view is limited to 24 MiB combined.
- Allowed non-manifest files are `.js`, `.mjs`, `.json`, `.md`, `.txt`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`, and `.css`.
- Every non-manifest file must be listed once in the integrity map. Files not listed in the map and map entries without a file are rejected.

These checks are deliberately strict. They prevent path traversal, archive bombs, unexpected executables, mutable module graphs, and source changes after approval.

## 3. Manifest Reference

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | Yes | `1` for the original single-entry package format; `2` when declaring document viewers. |
| `id` | Yes | Lower-case namespaced id, for example `acme.project-tools`. Commands and contribution ids must begin with this value plus `.`. |
| `displayName` | No | Human-readable name, up to 120 characters. Defaults to `id`. |
| `description` | No | Human-readable summary, up to 500 characters. |
| `version` | Yes | Strict semantic version, for example `1.2.3`. |
| `engines.bobocloud` | Yes | Semver range supported by the BOBOCloud application, for example `>=2.7.0 <3.0.0` for API 1.4 Agent packages. |
| `engines.pluginApi` | Yes | Semver range supported by the plugin API, for example `^1.4.0` for Agent capabilities. |
| `main` | Yes | One bundled `.js` or `.mjs` entry relative to the package root. |
| `activationEvents` | Yes | Array of up to 64 bounded activation labels. Use `onStartupFinished` for the current eager post-workbench activation path. |
| `permissions` | Yes | Unique capability ids. API 1.4.0 accepts the permissions listed in the API reference. Declared permissions are the package's hard capability ceiling and are enabled automatically after a verified install. |
| `contributes` | No | Bounded declarative JSON contribution metadata. Schema 2 may declare `documentViewers`; each executable view still requires runtime registration. |
| `localization` | No | Map from `default`, `en`, `zh-CN`, or `ja` to a package-relative JSON file. |
| `integrity` | Yes | SHA-256 file coverage map described below. |

Unknown manifest fields are rejected. Keep future metadata in a documented contribution payload rather than adding custom top-level fields.

## 4. Integrity Map and Packaging

The manifest's integrity map covers every package file except `manifest.json`.

```json
{
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "dist/extension.js": "bb4d2f3d3dbe9a...64 lowercase hexadecimal characters..."
    }
  }
}
```

Use a release build that emits a single file and calculate the hash from its exact bytes. This small Node script rewrites the map for a package with one entry file:

```js
// scripts/write-integrity.mjs
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const source = await readFile(path.join(root, manifest.main));
manifest.integrity = {
  algorithm: 'sha256',
  files: {
    [manifest.main]: createHash('sha256').update(source).digest('hex')
  }
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
```

For an archive, create it from inside the package directory:

```powershell
Compress-Archive -Path manifest.json,dist -DestinationPath ..\hello-plugin.zip
Rename-Item ..\hello-plugin.zip hello-plugin.boboplugin
```

Do not include `node_modules`, a source map, an undeclared JavaScript module, or a folder enclosing the package root. Every intended package file must be listed in `integrity.files`.

## 5. Activation and Lifecycle

An entry exports `activate(context)`. It may also export `deactivate()`.

```js
export async function activate(context) {
  const command = await context.commands.register(
    'example.hello-plugin.hello',
    () => 'hello',
    { title: 'Hello Plugin: Hello', category: 'Extensions' }
  );
  context.subscriptions.add(command);

  return () => {
    // Optional disposal hook. The host also disposes registered resources.
  };
}

export async function deactivate() {
  // Optional. Keep this bounded and idempotent.
}
```

The host applies the following lifecycle guarantees:

- Activation has a 15-second upper bound. It should normally return in under 50 ms after registering lightweight providers.
- Command invocation has a 10-second upper bound.
- Deactivation is given 1.5 seconds. Timeouts terminate the sandbox and the host still disposes registrations in reverse order.
- A failure from one plugin is attributed to that plugin and cannot stop the rest of the workbench.
- Disabling, uninstalling, refreshing, or disposing the application deactivates the plugin and removes its command and contribution registrations.
- `context.subscriptions.add(disposable)` owns a disposable for the plugin lifetime. The returned value must expose `dispose()`.

Do not start background work during activation. API v1 requires activation event labels in the manifest, but they are currently validated and stored rather than used for lazy host dispatch; enabled, verified packages activate after the `bobo:ready` workbench event. Future releases may make the labels routing triggers.

## 6. Runtime API

The activation sandbox receives a frozen `context` object. All methods are asynchronous except adding a subscription. Arguments and results cross a JSON-like data boundary: plain objects, arrays, strings, booleans, finite numbers, and `null`. Functions, DOM nodes, class instances, accessors, circular data, and oversized payloads are rejected. TypeScript projects can reference [plugin-sdk/bobocloud-plugin.d.ts](../client/plugin-sdk/bobocloud-plugin.d.ts) for the exact API `1.4.0` declarations.

```ts
interface Disposable { dispose(): void }

interface PluginContext {
  readonly apiVersion: string;
  readonly extension: Readonly<{ id: string; version: string }>;
  readonly subscriptions: Readonly<{ add<T extends Disposable>(value: T): T }>;
  readonly commands: Readonly<{
    register(id: string, handler: (...args: unknown[]) => unknown, metadata?: CommandMetadata): Promise<Disposable>;
    execute(id: string, ...args: unknown[]): Promise<unknown>;
  }>;
  readonly contributions: Readonly<{
    register(point: ContributionPoint, contribution: object, options?: { id?: string }): Promise<Disposable>;
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
  readonly agents: PluginAgents;
  readonly models: PluginModels;
  readonly tools: PluginTools;
  readonly skills: PluginSkills;
  readonly storage: PluginStorage;
  readonly services: Readonly<{
    get(id: string): Promise<unknown>;
  }>;
  readonly host: Readonly<{
    request(method: 'host.getInfo' | 'permissions.get', args?: null): Promise<unknown>;
  }>;
}

interface CommandMetadata {
  title?: string;
  category?: string;
  hint?: string;
}
```

### Commands

`commands.register` needs `commands.register`. Its id must start with `${context.extension.id}.` and the handler runs inside the sandbox.

```js
await context.commands.register(
  'example.hello-plugin.formatProject',
  async (resource) => ({ accepted: true, resource }),
  { title: 'Hello Plugin: Format Project', category: 'Extensions' }
);
```

`commands.execute` needs `commands.execute`. It invokes an existing registered host command through the command registry. A successful call performs that command's normal side effects, so request this permission only when the package genuinely needs it and never treat it as a way to bypass another capability. Treat command arguments and results as untrusted data.

The command registry is live in API v1. A command-palette integration is only exposed when the active palette supports disposable registrations; do not assume every command will be visible in every BOBOCloud build yet.

### Contributions

`contributions.register` needs `contributions.register`. Contribution ids also use the plugin namespace. Installed packages may register only declarative values at these points:

- `menus`
- `tasks`
- `settings`
- `languages`
- `ai.tools`
- `mcp.providers`
- `skills.providers`

The host intentionally rejects executable file-decoration providers and debug-configuration providers. The static SCM decoration publisher is a separately permissioned, data-only exception. The contribution points above are accepted as declarative, lifecycle-managed data but remain reserved for their future workbench consumers: generic `ai.tools` and `skills.providers` declarations do not invoke the API 1.4 model or Skill brokers. Agent plugins must use the dedicated Agent context namespaces described below.

### Document views

Document views use a dedicated API rather than the generic contribution registry. Use package schema 2, declare the exact executable entry and resources, and request both permissions:

```json
{
  "schemaVersion": 2,
  "permissions": ["documentViews.register", "documents.read"],
  "contributes": {
    "documentViewers": [{
      "id": "example.preview.markdown",
      "extensions": [".md", ".markdown"],
      "entry": "dist/document-view.js",
      "resources": ["dist/document-view.css"],
      "priority": 100
    }]
  }
}
```

The activation entry calls `context.documentViews.register({ id, title })`. The id must match the manifest and use the plugin namespace; the host derives extensions, entry, resources, and priority from the verified manifest rather than trusting runtime data. Once selected, a registered viewer takes precedence over built-in file fallbacks for that extension. Re-register localized titles after `context.i18n.onDidChange` and own every registration through `context.subscriptions`.

The view entry separately exports `activate(context)`. It receives a DOM root only inside its own opaque-origin iframe, bounded metadata without a local path, plugin localization, host theme variables, verified resource Blob URLs, and `read`, `readAll`, and `readText` for the current document. It does not receive the activation context or any general workbench capability. See [Plugin API: Document Views](./plugin-api.md#document-views) and the SDK declarations for the exact shape.

### Read-only services

`services.get` needs `services.read`. The current allowlist is:

- `workbench.projectTasks`

Services return an immutable snapshot or narrow data view. They never provide direct access to the workbench service object, raw task command lines, local paths, credentials, or mutation methods.

### Source-control sidebar

`sourceControl.register` needs `sourceControl.register`. It creates a lifecycle-owned, host-rendered sidebar provider rather than a plugin webview. The provider publishes only a bounded `SourceControlState`: localized heading and status strings, one summary, bounded sections and items, optional load-more commands, and bounded host-rendered forms/actions. The host owns the activity-bar icon, panel DOM, styles, accessibility behavior, and form validation.

Every referenced command must be registered by the same plugin and use its namespace. The host invokes it with one `SourceControlCommandPayload`, never arbitrary arguments. `clearState()` returns the provider to its waiting state; disabling, refreshing, or uninstalling the plugin also disposes it. See [Plugin API: Source-Control Sidebar](./plugin-api.md#source-control-sidebar) and the SDK declarations for the exact shape.

### Local SCM and file decorations

API 1.2.0 introduced a permission-gated, local-only SCM boundary:

- `context.sourceControl.register()` creates a data-only, host-rendered sidebar state provider.
- `context.fileDecorations.registerScm()` publishes fixed-status, workspace-relative entries into the file tree's existing `scm` rail.
- `context.scm.git` exposes only the named, structured local SCM requests documented in [Plugin API: Local SCM API](./plugin-api.md#local-scm-api).

The activation entry never receives a workspace root, local file handle, shell, environment, raw network capability, credential, DOM node, styling primitive, or arbitrary process arguments. Request only the exact permission needed: `sourceControl.register`, `fileDecorations.scm`, `scm.git.read`, or `scm.git.write`.

### Agent modules

API 1.4 treats an Agent as a dedicated plugin module, separate from native Chat and inline completion. BOBOCloud owns the trusted editor-sized Agent tab, session rail, state validation, model connections, filesystem/process brokers, approvals, Skill discovery, and local storage. The plugin owns the prompt, turn loop, goal planning, tool selection, localized session content, and complete state snapshots.

An Agent package commonly requests:

```json
{
  "engines": { "bobocloud": ">=2.7.0 <3.0.0", "pluginApi": "^1.4.0" },
  "activationEvents": ["onStartupFinished"],
  "permissions": [
    "commands.register",
    "agents.register",
    "models.generate",
    "workspace.read",
    "workspace.write",
    "process.execute",
    "skills.read",
    "storage.local"
  ]
}
```

Register every command first, then call `context.agents.register()` with one namespaced provider id, nine namespaced command ids, and the supported modes/reasoning efforts. Publish the session list and active session through the returned provider's `setState()`. The host supplies one bounded `AgentCommandPayload` to each command and renders only validated data. It never executes plugin HTML, CSS, DOM callbacks, or arbitrary UI code. A `send` command should start a tracked asynchronous turn, publish running state, and return promptly; do not await the full model/tool loop inside the command's 10-second invocation window.

Use `context.models.list()` to populate the state with opaque configured model refs. A model key and endpoint remain in the host profile. Pass a unique `requestId` to `generate()` and call `context.models.cancel(requestId)` from the Agent's cancel command; the host scopes the actual request id to the calling plugin. Do not infer a provider's native reasoning parameter: expose `low`, `medium`, `high`, and `max` as portable orchestration choices and let the broker map only explicitly enabled provider options.

The fixed read tools (`workspace_list`, `workspace_read`, and `workspace_search`) run immediately and require `workspace.read`. `workspace_write` and `process_run` only create expiring pending operations. Publish only the returned approval id as `{ approval: { id } }` in Agent state and stop that turn; plugin state cannot supply the tool, summary, risk, expiry, or decision details. The Worker intentionally has no approve, reject, decide, or process-cancel method. The trusted workbench describes the canonical pending operation, asks the user, calls the main-process decision/cancel API directly, then invokes the plugin's namespaced `approve` or `reject` command with `{ approvalId, approvalResult }`. Treat that command as a completion notification and resume orchestration from the canonical result; it is not the authority that performs the write or process. Writes use workspace-relative paths plus SHA-256 conflict checks. Processes use an allowlisted executable and structured argv with `shell: false`; no shell string, absolute cwd, custom environment, or tool installation is available. Handle missing executables and path/case differences across Windows, macOS, and Linux as normal failures.

`context.skills` returns opaque ids and bounded `SKILL.md` metadata/content from supported user and workspace roots. Treat Skill text as untrusted instructions: selecting a Skill never grants a permission, and resulting actions still use the same broker and approval path. `context.storage` atomically replaces one plugin-private JSON object up to 8 MiB; use it for sessions and preferences, not secrets.

See [Plugin API: Agent Platform](./plugin-api.md#agent-platform) and the SDK declaration for the full state, model, tool, Skill, storage, error, and command-payload shapes.

### Read-only host metadata

`context.host.request()` is a narrow read-only metadata API. It is not a manifest permission and does not provide a general broker. API `1.4.0` accepts only these methods:

- `host.getInfo` returns the plugin API version and the calling plugin's id and version.
- `permissions.get` returns the calling plugin's requested and currently granted permissions.

Both methods accept `null` or no argument. They cannot read files, access the network, start a process, invoke MCP or AI services, retrieve credentials, or mutate host state. All other method names are rejected.

## 7. Permissions

Every permission must appear in `manifest.permissions`. After a verified install or update, BOBOCloud enables every declared permission by default so a plugin can work immediately. The declaration remains a strict capability ceiling: undeclared APIs are never available, and the user can revoke any declared permission in the **Extensions** detail tab. Disabling a plugin stops its runtime; revoking a permission leaves the plugin installed but makes the relevant call fail with `EXTENSION_PERMISSION_DENIED`.

| Permission | Current meaning |
| --- | --- |
| `commands.register` | Register a namespaced command. |
| `commands.execute` | Execute an existing registered host command, including that command's normal side effects. |
| `contributions.register` | Store a namespaced declarative contribution at an allowed point. |
| `services.read` | Read an allowlisted immutable workbench service snapshot. |
| `sourceControl.register` | Register a bounded data-only source-control descriptor. |
| `fileDecorations.scm` | Publish bounded fixed-status entries to the SCM file-tree rail. |
| `scm.git.read` | Call read-only structured local SCM operations. |
| `scm.git.write` | Call structured local SCM mutation operations. |
| `documentViews.register` | Register a document viewer already authorized by schema-2 manifest metadata. |
| `documents.read` | Read only the current user-opened document from that viewer through a scoped opaque handle. |
| `agents.register` | Register a bounded host-rendered Agent provider and publish its state. |
| `models.generate` | List opaque model refs, generate turns, and cancel this plugin's requests. |
| `workspace.read` | Invoke bounded workspace list, read, and search tools. |
| `workspace.write` | Request a pending write for the trusted workbench to decide. |
| `process.execute` | Request a pending process for the trusted workbench to decide or cancel. |
| `skills.read` | Discover and read bounded Skills through opaque ids. |
| `storage.local` | Read and replace isolated plugin-private JSON state. |

These seventeen permissions are valid in an API 1.4.0 manifest. Automatic enablement does not bypass the sandbox, the main-process broker, argument validation, ownership rules, workspace scoping, or Agent approval. API 1.4 exposes only its named workspace and process tools; arbitrary filesystem access, shell commands, caller-defined environments, raw credentials, networking, MCP, cloud task execution, and debugger capabilities remain unavailable.

## 8. Security Model

The security model is part of the compatibility contract:

- Plugin source is loaded only after package validation and entry-file SHA-256 verification.
- The opaque-origin iframe is a strict transport shell (`sandbox=allow-scripts`); it does not execute package code directly.
- The shell creates one host-generated Blob Worker. The worker receives the verified entry over a `MessageChannel` and is the only context that executes package code.
- The sandbox CSP permits only that Blob Worker (`worker-src blob:`) and denies network connections, frames, object/media loads, and external imports. The worker additionally disables `fetch`, XHR, WebSocket, EventSource, `importScripts`, nested workers, and shared workers.
- The worker receives a single bundled entry over a Blob URL. It cannot resolve arbitrary package or local paths and has no Node.js, Electron, `window.api`, `window.BOBO`, DOM, or workbench object access.
- A document view uses a second opaque-origin iframe with `sandbox=allow-scripts`, a network-denying CSP, blocked browser connection APIs, no parent/workbench access, and no absolute path. It receives only verified source/resources and the selected file through a scoped MessageChannel broker.
- Document sessions are bound to the IPC sender, plugin id, viewer id, workspace identity, file size, and modification time. The main process reauthorizes every chunk and closes sessions on tab/plugin/workspace/sender lifecycle events.
- Main process policy validates installations, permissions, IPC sender identity, bounded RPC arguments, allowed service ids, document handles, and the structured local-SCM allowlist.
- Agent brokers keep model credentials in the main process, expose only opaque model and Skill ids, reject workspace escapes and symlinks, and bind pending mutations to the plugin, active workspace identity, and expiry. Only the trusted renderer/preload/main path can describe, decide, or cancel them; the Worker API can only request them.
- Agent process execution uses a fixed executable allowlist, argv arrays, `shell: false`, a relative workspace cwd, bounded output, and a bounded timeout; plugins cannot provide an environment object.
- The renderer validates owned ids, message protocol version, data-only payloads, request timeouts, and reverse-order disposal.
- The management UI sees only sanitized package metadata. It does not receive plugin source, internal installation paths, or secrets.

Never ask users to grant extra permissions solely to make an error disappear. Narrow the package's declared permissions to the API calls it actually makes, and handle deliberate revocation as a normal runtime state.

## 9. Localization

Bundle user-facing plugin strings in JSON and declare them in `localization`.

```json
{
  "localization": {
    "default": "language-packs/en/messages.json",
    "zh-CN": "language-packs/zh-CN/messages.json",
    "ja": "language-packs/ja/messages.json"
  }
}
```

Every path must be package-relative, use `/`, point to an included `.json` file, and be listed in `integrity.files`. The host verifies the selected locale resource against its declared SHA-256 before activation and whenever the workbench locale changes. It accepts only a bounded flat JSON string map and passes only `{ locale, messages }` to the sandbox.

Use `context.i18n.t(key, values?)` for package-owned text and subscribe with `context.i18n.onDidChange(listener)` to re-publish any visible host-rendered state. `context.i18n.locale` is always `en`, `zh-CN`, or `ja`. The loader prefers the active locale, then `default`, then `en`; it does not inject, expose, or modify BOBOCloud's core language packs.

## 10. Testing Checklist

Before publishing a package:

1. Build the activation entry and every declared view entry as self-contained ESM files with no relative JavaScript imports.
2. Validate the `id`, semantic versions, engine ranges, permissions, and package paths.
3. Regenerate the integrity map after every byte change.
4. Open the Extensions activity-bar view, use its local install action to select the `.boboplugin` archive, then open the extension's workbench detail tab.
5. Verify every declared permission is enabled after installation and that no undeclared permission is available.
6. Revoke one permission at a time and verify only its corresponding API fails cleanly; restore it and confirm the runtime recovers.
7. Disable, re-enable, refresh, update, and uninstall the package. Confirm it does not leave visible commands or contributions behind.
8. Exercise an activation error, a thrown command, and a slow command. The workbench must remain usable.
9. Test English, Simplified Chinese, and Japanese strings for any visible plugin contribution.
10. Run the host repository's `npm test` when contributing changes to the Plugin API itself.
11. For document views, verify the iframe lacks `allow-same-origin`, cannot read `window.parent`, `window.api`, or the network, and loses document access after permission revocation, disable, tab close, or workspace switch.
12. For Agents, verify registration/state rejection, model cancellation, each permission revocation, absence of Worker approval methods, trusted write/process decisions and rejection, stale-workspace and file-conflict failures, Skill opacity, storage limits, and provider cleanup after disable/uninstall.
13. Exercise Agent behavior on Windows, macOS, and Linux (or CI representatives), including executable availability, path separators, case sensitivity, cancellation, and process termination.

## 11. Compatibility and Publishing

- Treat `engines.pluginApi` major versions as hard compatibility boundaries.
- Prefer a conservative range such as `^1.4.0` when using Agent capabilities; do not claim future API support before testing it.
- Additive behavior may arrive in a plugin API minor version. Removed or changed behavior requires a new major API version.
- Keep command ids, setting ids, contribution ids, and persisted data names stable after release.
- The `.boboplugin` extension only identifies an installable package. It is not a signature or a trust endorsement.
- Publish the archive hash alongside the archive so users can independently verify what they download.

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Package cannot be selected | The file does not end in `.boboplugin`. | Build the archive and select that file; the user-facing installer does not install folders. |
| Install rejects the archive | Root layout, file type, size, ZIP mode, manifest, engine range, or integrity map is invalid. | Read the reported error, rebuild the bundle, and regenerate the integrity map. |
| Plugin stays disabled | It was explicitly disabled, found incompatible, or failed package integrity validation. | Review the detail page, reinstall a verified compatible package, then enable it. |
| API call is denied | The permission was not declared or the user revoked it. | Add the minimal manifest permission and reinstall/update, or restore the revoked permission in the detail tab. |
| Activation fails | The entry is not a single ESM bundle or does not export `activate(context)`. | Build a self-contained `.js` or `.mjs` entry and export `activate`. |
| A document opens as text | Its viewer was not declared and registered, lacks a permission, or the extension is disabled. | Check schema 2, the exact namespaced id, both document-view permissions, integrity, and enabled state. |
| Command is not shown in the palette | The active command palette may not support disposable third-party registrations yet. | Keep the command registration, but expose a supported menu/contribution when that consumer is released. |
| Agent does not appear | The plugin is disabled, lacks `agents.register`, failed activation, or registered an invalid descriptor/command namespace. | Review the plugin detail state and error, then verify all nine commands and the provider id use the plugin namespace. |
| Model generation is unavailable | `models.generate` is missing/revoked or the selected opaque model profile is incomplete. | Restore the minimal permission or configure a local chat profile; never embed an API key in the plugin. |
| A local Agent action is unavailable | The named tool permission is absent, the approval expired, the workspace changed, or the executable is unavailable. | Re-read current state, request a fresh operation, and handle platform-specific tool availability; do not use undocumented bridges. |
