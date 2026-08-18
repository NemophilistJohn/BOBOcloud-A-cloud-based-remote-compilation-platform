# BOBOCloud Plugin Development Guide

This guide targets the BOBOCloud Plugin API `1.2.0` in BOBOCloud `2.6.0` and later.

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
    "bobocloud": ">=2.6.0",
    "pluginApi": "^1.2.0"
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

Calculate the SHA-256 for `dist/extension.js`, replace the manifest value, create a `.boboplugin` archive, then open the **Extensions** activity-bar view and choose **Install .boboplugin package**. The normal user-facing picker accepts only that archive format and remembers a plugin-private import location, never the current workspace folder. The application installs a plugin in a disabled state. Open its detail tab to enable it and grant the requested `commands.register` permission.

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
- Package schema version is exactly `1`.
- Plugin ids use lower-case reverse-domain notation, such as `publisher.feature`.
- The plugin entry must be a relative POSIX `.js` or `.mjs` path. Backslashes, absolute paths, `..`, hidden segments, symlinks, executables, and special files are rejected.
- API v1 accepts one bundled JavaScript entry. Relative JavaScript imports are not supported because the sandbox imports the verified entry from a Blob URL.
- Archives must be ordinary single-disk, non-encrypted ZIP files. ZIP64 archives are rejected.
- A package is limited to 128 files, 64 MiB expanded content, 32 MiB archive content, 8 MiB per file, 128 KiB manifest, and 2 MiB entry source at load time.
- Allowed non-manifest files are `.js`, `.mjs`, `.json`, `.md`, `.txt`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`, and `.css`.
- Every non-manifest file must be listed once in the integrity map. Files not listed in the map and map entries without a file are rejected.

These checks are deliberately strict. They prevent path traversal, archive bombs, unexpected executables, mutable module graphs, and source changes after approval.

## 3. Manifest Reference

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | Yes | Must be `1`. |
| `id` | Yes | Lower-case namespaced id, for example `acme.project-tools`. Commands and contribution ids must begin with this value plus `.`. |
| `displayName` | No | Human-readable name, up to 120 characters. Defaults to `id`. |
| `description` | No | Human-readable summary, up to 500 characters. |
| `version` | Yes | Strict semantic version, for example `1.2.3`. |
| `engines.bobocloud` | Yes | Semver range supported by the BOBOCloud application, for example `>=2.6.0 <3.0.0`. |
| `engines.pluginApi` | Yes | Semver range supported by the plugin API, for example `^1.2.0`. |
| `main` | Yes | One bundled `.js` or `.mjs` entry relative to the package root. |
| `activationEvents` | No | Optional array of up to 64 bounded activation labels. API v1 stores these labels as metadata; enabled, verified packages currently activate after the workbench is ready. |
| `permissions` | Yes | Unique capability ids. API 1.2.0 accepts the command, contribution, read-only service, source-control, SCM decoration, and local-SCM permissions listed in the API reference. Declared permissions are the package's hard capability ceiling and are enabled automatically after a verified install. |
| `contributes` | No | Bounded declarative JSON contribution metadata. |
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

Do not include `node_modules`, a source map, a second JavaScript module, or a folder enclosing the package root unless each file is intended for the package and listed in `integrity.files`.

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

Do not start background work during activation. API v1's optional activation event labels are validated and stored but do not yet provide lazy host dispatch; enabled, verified packages currently activate after the `bobo:ready` workbench event. Future releases may make the labels routing triggers.

## 6. Runtime API

The sandbox receives a frozen `context` object. All methods are asynchronous except adding a subscription. Arguments and results cross a JSON-like data boundary: plain objects, arrays, strings, booleans, finite numbers, and `null`. Functions, DOM nodes, class instances, accessors, circular data, and oversized payloads are rejected. TypeScript projects can reference [plugin-sdk/bobocloud-plugin.d.ts](../client/plugin-sdk/bobocloud-plugin.d.ts) for the exact API `1.2.0` declarations.

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

The host intentionally rejects executable file-decoration providers and debug-configuration providers. The static SCM decoration publisher is a separately permissioned, data-only exception. API v1 implements package validation, isolation, lifecycle cleanup, the command registry, and the read-only task snapshot. The contribution points above are accepted as declarative, lifecycle-managed data but are reserved for future workbench consumers: they do not yet create a visible UI, execute a task, start an MCP server, invoke an AI tool, or load a language provider. Mark feature usage as optional and provide a command fallback until the corresponding consumer is released.

### Read-only services

`services.get` needs `services.read`. The current allowlist is:

- `workbench.projectTasks`

Services return an immutable snapshot or narrow data view. They never provide direct access to the workbench service object, raw task command lines, local paths, credentials, or mutation methods.

### Source-control sidebar

`sourceControl.register` needs `sourceControl.register`. It creates a lifecycle-owned, host-rendered sidebar provider rather than a plugin webview. The provider publishes only a bounded `SourceControlState`: localized heading and status strings, one summary, bounded sections and items, optional load-more commands, and bounded host-rendered forms/actions. The host owns the activity-bar icon, panel DOM, styles, accessibility behavior, and form validation.

Every referenced command must be registered by the same plugin and use its namespace. The host invokes it with one `SourceControlCommandPayload`, never arbitrary arguments. `clearState()` returns the provider to its waiting state; disabling, refreshing, or uninstalling the plugin also disposes it. See [Plugin API: Source-Control Sidebar](./plugin-api.md#source-control-sidebar) and the SDK declarations for the exact shape.

### Local SCM and file decorations

API 1.2.0 includes a permission-gated, local-only SCM boundary:

- `context.sourceControl.register()` creates a data-only, host-rendered sidebar state provider.
- `context.fileDecorations.registerScm()` publishes fixed-status, workspace-relative entries into the file tree's existing `scm` rail.
- `context.scm.git` exposes only the named, structured local SCM requests documented in [Plugin API: Local SCM API](./plugin-api.md#local-scm-api).

The package never receives a workspace root, local file handle, shell, environment, raw network capability, credential, DOM node, styling primitive, or arbitrary process arguments. Request only the exact permission needed: `sourceControl.register`, `fileDecorations.scm`, `scm.git.read`, or `scm.git.write`.

### Read-only host metadata

`context.host.request()` is a narrow read-only metadata API. It is not a manifest permission and does not provide a general broker. API `1.2.0` accepts only these methods:

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
These eight permissions are valid in an API 1.2.0 manifest. Automatic enablement does not bypass the sandbox, the main-process broker, argument validation, ownership rules, or workspace scoping. Workspace access, general networking, process execution, raw credentials, MCP, AI, task execution, and debugger capabilities are not requestable in API 1.2.0.

## 8. Security Model

The security model is part of the compatibility contract:

- Plugin source is loaded only after package validation and entry-file SHA-256 verification.
- The opaque-origin iframe is a strict transport shell (`sandbox=allow-scripts`); it does not execute package code directly.
- The shell creates one host-generated Blob Worker. The worker receives the verified entry over a `MessageChannel` and is the only context that executes package code.
- The sandbox CSP permits only that Blob Worker (`worker-src blob:`) and denies network connections, frames, object/media loads, and external imports. The worker additionally disables `fetch`, XHR, WebSocket, EventSource, `importScripts`, nested workers, and shared workers.
- The worker receives a single bundled entry over a Blob URL. It cannot resolve arbitrary package or local paths and has no Node.js, Electron, `window.api`, `window.BOBO`, DOM, or workbench object access.
- Main process policy validates installations, permissions, IPC sender identity, bounded RPC arguments, allowed service ids, and the structured local-SCM allowlist.
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

1. Build one ESM entry file with no relative JavaScript imports.
2. Validate the `id`, semantic versions, engine ranges, permissions, and package paths.
3. Regenerate the integrity map after every byte change.
4. Open the Extensions activity-bar view, use its local install action to select the `.boboplugin` archive, then open the extension's workbench detail tab.
5. Verify every declared permission is enabled after installation and that no undeclared permission is available.
6. Revoke one permission at a time and verify only its corresponding API fails cleanly; restore it and confirm the runtime recovers.
7. Disable, re-enable, refresh, update, and uninstall the package. Confirm it does not leave visible commands or contributions behind.
8. Exercise an activation error, a thrown command, and a slow command. The workbench must remain usable.
9. Test English, Simplified Chinese, and Japanese strings for any visible plugin contribution.
10. Run the host repository's `npm test` when contributing changes to the Plugin API itself.

## 11. Compatibility and Publishing

- Treat `engines.pluginApi` major versions as hard compatibility boundaries.
- Prefer a conservative range such as `^1.2.0`; do not claim future API support before testing it.
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
| Command is not shown in the palette | The active command palette may not support disposable third-party registrations yet. | Keep the command registration, but expose a supported menu/contribution when that consumer is released. |
| A privileged operation is unavailable | API v1 does not expose filesystem, network, process, credential, MCP, AI, task, or debugger capabilities. | Do not rely on undocumented bridges; wait for a named, permissioned API. |
