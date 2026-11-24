# Build your first BOBOCLOUD plugin

[简体中文](plugin-quickstart.zh-CN.md) · [README](../README.md) · [Full API](plugin-api.md)

The current host is desktop **2.8.1**, Plugin API **1.11.0**. The supported public contract is [the SDK declaration](../client/plugin-sdk/bobocloud-plugin.d.ts), not `window.BOBO`, Electron IPC, internal renderer services, or a VS Code extension API.

## 1. Choose the right surface

| You want to build | Use | Boundary |
| --- | --- | --- |
| A command or orchestration module | Schema 1, one bundled ESM activation entry. | An isolated Worker; no arbitrary DOM, Node, filesystem, shell, or networking. |
| A file viewer/editor | Schema 2 document viewer entries and declared resources. | A separate opaque iframe with current-document handles. |
| A local Git workflow | Dedicated source-control/Git brokers and SCM decoration lane. | Structured host operations; no arbitrary `git` shell. |
| An Agent | `agents`, `models`, `tools`, `skills`, `storage`. | Host-owned model credentials, tool approval, workspace resolution, and process execution. |
| A notebook workflow | Scoped document read/write/analyze/execute APIs as supported. | Runtime-dependent execution through the host; no direct remote shell. |

Generic `menus`, `tasks`, `settings`, `languages`, `ai.tools`, `mcp.providers`, and `skills.providers` declarations do not by themselves implement visible/executable integrations. Check [implemented versus reserved surfaces](plugin-development.md#contributions) before building on a name.

## 2. Start with a real package

Copy [hello-plugin](../client/examples/plugins/hello-plugin/) to a separate plugin repository. Its manifest already has a valid integrity hash and the minimum command permission. Its structure is:

```text
hello-plugin/
  manifest.json
  dist/
    extension.js
```

An activation module exports `activate(context)`:

```js
export async function activate(context) {
  await context.commands.register(
    'example.hello-plugin.hello',
    () => ({ message: 'Hello from an isolated BOBOCloud plugin.' }),
    { title: 'Hello Plugin: Say Hello', category: 'Extensions' }
  );
}
```

Use a unique reverse-domain-style plugin/command namespace. A changed command title is a byte change: regenerate integrity before installation. The simple example demonstrates the contract; production visible strings should resolve English, Simplified Chinese, and Japanese resources.

## 3. Understand the manifest

- `schemaVersion`: 1 for activation only; 2 for declared document views/resources.
- `id`, `version`: stable identity and semantic release version.
- `engines.bobocloud` and `engines.pluginApi`: both must match the host. Declare the oldest version that supplies all capabilities used, rather than blindly requiring the latest.
- `main`: one self-contained ESM bundle, not a Node project with runtime imports.
- `activationEvents`: required by validation; do not assume arbitrary lazy event dispatch.
- `permissions`: concrete supported capabilities only. Declaring a name does not create a new API.
- `integrity.files`: the exact SHA-256 of every non-manifest file, including locales and view resources.

See [the complete manifest reference](plugin-development.md#3-manifest-reference) for allowed fields. Do not add arbitrary top-level metadata or native executables. Unknown fields, path traversal, symlinks, unsupported archives, and missing/extra integrity files are rejected.

## 4. Package and install

For the unchanged bundled example, from the compiler repository root:

```powershell
Set-Location client/examples/plugins/hello-plugin
python -m zipfile -c hello-plugin.boboplugin manifest.json dist
```

The archive root must directly contain `manifest.json` and `dist/extension.js`; an extra enclosing `hello-plugin/` directory is wrong. Python is one convenient ZIP tool, not a plugin runtime requirement. Do not commit the generated artifact to the compiler repository.

After editing files, use the [integrity-map example](plugin-development.md#4-integrity-map-and-packaging) to regenerate hashes, then recreate the archive. Never keep a hash from an earlier build.

Open **Extensions → Install .boboplugin package**, select the archive, inspect the result and detail page, and find the registered command in the command palette. Current installation enables a validated compatible package and grants its declared permissions by default; inspect or revoke grants in its details. Replacement restores declared defaults. “Official” does not bypass validation or undeclared-permission checks.

## 5. Keep the Worker small

Bundle dependencies into the entry. Cross-boundary data must be bounded plain JSON-like values; convert `Error`, `Map`, `Set`, classes, and other runtime objects into plain records. Do not send functions or DOM nodes.

Use disposable subscriptions and keep deactivation bounded/idempotent. The host removes owned registrations even after failure, but your plugin should stop its own work. Handle permission revocation, workspace changes, model cancellation, stale document handles, disabled state, and invalidated operations explicitly.

For an Agent, the Worker cannot grant itself approval. It sends a structured tool request; the trusted host determines the canonical action and approval. `full` changes approval behavior, never path confinement, permissions, executable validation, quotas, or cancellation. Model refs and Skill IDs are opaque; they are not keys or absolute paths.

## 6. Test the installed archive

1. Install a fresh archive with no development-folder shortcut; check integrity and compatible API ranges.
2. Invoke the command, then disable/re-enable the plugin and confirm registrations disappear/recover.
3. Revoke a needed permission and verify a clear failure, not a fallback to a broader internal API.
4. Switch workspace and close/reopen its views; old handles/results must not act on the new project.
5. Test English, Simplified Chinese, and Japanese layouts and a failing/slow activation path.
6. For viewers, verify isolated DOM and scoped read/write/execute permissions separately; a read-only viewer must not acquire execution authority.
7. For host API changes, run matching main/broker/protocol/renderer/SDK/real Electron tests, not only the plugin's unit tests.

## 7. Publish independently

Publish an immutable plugin version/archive in the plugin repository. Then update the Registry chain in order: version descriptor → package index → official shard → root registry. Artifact hashes cover exact archive bytes; Registry JSON hashes use the documented normalized text convention. Verify remote artifacts and the full chain before claiming a release is live.

Do not rewrite a released tag/descriptor to alter compatibility. Publish a new semantic version. Keep compiler commits, plugin releases, and Registry commits separate. For complete packaging, limits, permissions, and error behavior, use [Plugin Development](plugin-development.md) and [Plugin API](plugin-api.md).
