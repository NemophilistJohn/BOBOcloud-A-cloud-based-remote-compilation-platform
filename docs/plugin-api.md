# BOBOCloud Plugin API (Draft 1)

Status: renderer foundation implemented; third-party package discovery and loading are not enabled yet.

This document defines the compatibility boundary for the future plugin host. The current renderer provides registries, lifecycle cleanup, permission declarations, error isolation, and a trusted-module activation API. It does not yet execute downloaded third-party code.

## Design goals

- Keep plugins out of `window.BOBO`; plugins receive an explicit, capability-limited context.
- Make every registration disposable and owned by one plugin.
- Keep remote-sync, source-control, and diagnostic decorations in separate lanes.
- Prefer declarative contributions and lazy activation over startup side effects.
- Route filesystem, process, credentials, network, and cloud operations through audited main-process brokers.
- Keep user-facing strings in language bundles. English, Simplified Chinese, and Japanese are mandatory for bundled plugins.

## Manifest

Plugin ids, command ids, settings, and contribution ids use a reverse-domain-like namespace owned by the publisher.

```json
{
  "id": "acme.build-tools",
  "displayName": "Acme Build Tools",
  "version": "1.0.0",
  "engines": {
    "bobocloud": ">=2.6.0",
    "pluginApi": "^1.0.0"
  },
  "main": "./dist/extension.js",
  "activationEvents": [
    "onCommand:acme.build-tools.build",
    "onTaskType:acme-build"
  ],
  "permissions": [
    "commands.register",
    "commands.execute",
    "contributions.register",
    "services.read"
  ],
  "contributes": {
    "commands": [
      {
        "command": "acme.build-tools.build",
        "title": "%command.build%",
        "category": "%category.build%"
      }
    ],
    "menus": {
      "explorer/context": [
        {
          "command": "acme.build-tools.build",
          "when": "resourceType == folder",
          "group": "tasks@100"
        }
      ]
    }
  },
  "localization": {
    "default": "./language-packs/en/messages.json",
    "zh-CN": "./language-packs/zh-CN/messages.json",
    "ja": "./language-packs/ja/messages.json"
  }
}
```

`engines.pluginApi` is checked before activation. API major versions are compatibility boundaries. Additive fields may appear in a minor version; removals and semantic changes require a new major version.

## Activation and lifecycle

An extension module exports `activate(context)` and may export `deactivate()`.

```js
export function activate(context) {
  context.subscriptions.add(context.commands.register(
    'acme.build-tools.build',
    async (folder) => runBuild(folder),
    { title: 'Build project', category: 'Build' }
  ));
}

export async function deactivate() {
  // Stop private workers or flush bounded state here.
}
```

The host owns a disposable store per plugin. Command, contribution, listener, and service registrations are removed during deactivation in reverse order. Cleanup is also performed when activation fails halfway through. `deactivate()` failures are logged but do not prevent cleanup of the remaining registrations.

Activation handlers must not perform long work. Load large modules after a relevant activation event, and keep synchronous activation below 50 ms on a normal workstation.

## Implemented renderer context

The initial `1.0.0` context exposes:

```ts
interface PluginContext {
  readonly apiVersion: "1.0.0";
  readonly plugin: { readonly id: string; readonly version: string };
  readonly subscriptions: { add<T extends Disposable>(value: T): T };
  readonly services: { get<T>(id: string): T };
  readonly commands: {
    register(id: string, handler: (...args: unknown[]) => unknown, metadata?: CommandMetadata): Disposable;
    execute(id: string, ...args: unknown[]): Promise<unknown>;
  };
  readonly contributions: {
    register(point: ContributionPoint, value: object, options?: { id?: string }): Disposable;
  };
}
```

Only services explicitly marked `exposeToPlugins` can be read by plugins. Migrated services include `workbench.fileIcons` and the read-only `workbench.projectTasks` view. A service may expose a narrower immutable `pluginView`; lifecycle and mutation methods on its trusted host object are never automatically published.

Errors from command handlers and contribution providers are reported with plugin ownership metadata. `executeIsolated()` and contribution collection preserve the host loop when one provider fails.

## Contribution points

The initial registry reserves these stable points:

| Point | Purpose |
| --- | --- |
| `menus` | Declarative menu items referencing registered commands |
| `fileDecorations.sync` | BOBOCloud/local synchronization state only |
| `fileDecorations.scm` | Git or another source-control provider only |
| `fileDecorations.diagnostic` | Errors, warnings, and informational diagnostics |
| `tasks` | Task providers and task types |
| `settings` | Typed settings schema and defaults |
| `languages` | Language metadata, grammars, and analysis providers |
| `ai.tools` | Future model-callable tools with explicit schemas |
| `mcp.providers` | Future MCP server descriptors and connection factories |
| `skills.providers` | Future skill catalogs and skill content loaders |

Unknown contribution points are rejected for third-party plugins. Core code may add a point before exposing it through a new plugin API minor version.

## Commands and menus

A command has one globally unique id and one handler. Duplicate ids are rejected instead of silently replacing the previous owner. Menus reference commands by id and do not carry executable code.

Menu contributions use stable locations such as `explorer/context`, `editor/context`, `run/primary`, and `commandPalette`. `when` clauses will use a restricted context-key expression language; they are not JavaScript. Plugins must supply icons by registered icon id and translated titles by localization key.

## File decorations

File decorations are providers, not DOM nodes. A provider contract is:

```ts
interface FileDecorationProvider {
  readonly id: string;
  readonly namespace: string;
  readonly lane: "sync" | "scm" | "diagnostic";
  readonly priority?: number; // integer from -1000 to 1000
  getDecoration(path: string, node: Readonly<{ type: "file" | "folder"; name: string }>): FileDecoration | null;
  onDidChange?(listener: (paths?: readonly string[]) => void): Disposable;
}

interface FileDecoration {
  status: string;
  badge: string;
  tooltip?: string;
  ariaLabel?: string;
  transient?: boolean;
}
```

`path` is workspace-relative and uses `/` separators; the workspace root is the empty string. `getDecoration` must be synchronous and must only read provider-owned cached state. Network or filesystem refresh happens in the background, followed by `onDidChange`. Passing no paths means all decorations are stale.

Register a provider at the point matching its lane:

```js
context.contributions.register('fileDecorations.sync', {
  id: 'acme.sync-status',
  namespace: 'acme.sync',
  lane: 'sync',
  priority: 100,
  getDecoration(path) {
    return cache.get(path) || null;
  },
  onDidChange(listener) {
    return events.on('change', listener);
  }
});
```

The workbench renders stable lanes after the file name in this order: sync, SCM, diagnostic. Providers within one lane are ordered by descending priority and then id. A lane has a fixed width so status changes do not move filenames.

The sync lane uses semantic icon ids such as `cloud-check`, `cloud-upload`, `cloud-download`, `cloud-conflict`, and `cloud-offline`. It must not use the `M`, `A`, `D`, `U`, or `C` letter badges reserved for SCM. Color is supporting information; every decoration also needs a tooltip and accessible label.

## Tasks

Core task discovery owns `.bobocloud/tasks.json` and VS Code-compatible `.vscode/tasks.json` parsing. Plugins must not parse or rewrite those files behind the task service. The current plugin-facing service is deliberately read-only:

```ts
interface ProjectTasksService {
  list(): readonly Readonly<{
    label: string;
    kind: "build" | "test" | "run" | "custom";
    type: "shell" | "process" | string;
    source: "bobocloud" | "vscode" | string;
    executable: boolean;
    warnings: readonly string[]; // stable warning codes
  }>[];
  getSelected(): Readonly<{ type: "file" | "task"; label: string }>;
}
```

Read it with `context.services.get('workbench.projectTasks')`. It does not expose `init`, `dispose`, refresh internals, raw task JSON, command lines, or environment values. Execution and refresh use registered commands so normal permission, attribution, and error isolation apply:

- `bobocloud.tasks.runSelected`
- `bobocloud.tasks.refresh`

The `tasks` contribution point is reserved in API `1.0.0`, but the workbench does not consume third-party task providers yet. Registering a contribution stores and owns it for lifecycle testing only; it does not add a Run menu item or executable command. A future minor API will define provider activation, normalized output, limits, and cloud execution mediation before enabling that consumer.

The future normalized provider shape is expected to retain these VS Code-compatible concepts, but this is not an implemented contract yet:

```ts
interface TaskDefinition {
  id: string;
  label: string;
  type: "build" | "test" | "run" | "shell" | string;
  command: string;
  args?: readonly string[];
  options?: { cwd?: string; env?: Record<string, string> };
  group?: "build" | "test" | "run";
  problemMatcher?: string | readonly string[];
  dependsOn?: string | readonly string[];
  presentation?: { reveal?: "always" | "silent" | "never"; panel?: "shared" | "dedicated" | "new" };
}
```

When provider execution is enabled, it will always go through the host task service so cancellation, output, remote execution and history remain consistent. Plugins will not receive a local process primitive.

## Settings and languages

Settings contributions are declarative JSON schemas with a plugin-owned prefix. A plugin may not write another plugin's setting. Secrets use a credential service and are never returned by normal settings reads.

Language contributions declare ids, aliases, extensions, optional grammars, and provider factories. They cannot patch Monaco globals directly. Provider registrations are disposable and lazy by language activation event.

## AI tools, MCP, and Skills

These points are reserved but are not enabled for third-party packages yet:

- `ai.tools` declares a stable tool id, JSON input/output schemas, required permissions, timeout, and an invoker. The model never receives credentials.
- `mcp.providers` declares transport metadata. The main process owns subprocesses, sockets, credentials, timeouts, and user consent.
- `skills.providers` returns versioned skill descriptors and content. Skills are data/instructions, not automatically executable renderer code.

Every AI-initiated privileged action must show its owning plugin/tool, validate structured input, enforce workspace trust, and use the same permission broker as a user-initiated command.

## Permissions and process boundary

The implemented renderer permissions are `commands.register`, `commands.execute`, `contributions.register`, and `services.read`. Future privileged permissions will be granular, for example `workspace.read`, `workspace.write`, `network.connect`, `process.execute`, `credentials.read`, and `mcp.start`.

A manifest declaration is necessary but not sufficient authorization. Privileged operations require a main-process capability grant and may require per-workspace user consent. Plugins must not receive Node.js, Electron IPC, raw `window.api`, credential values, arbitrary DOM access, or unrestricted network access.

Downloaded plugins will run in an isolated worker or utility process. The current trusted-module runtime is an integration foundation, not a security sandbox and not a public installation mechanism.

## Compatibility and quality gates

- Validate manifest schema, API range, permissions, localization completeness, and unique ids before installation.
- Activate each plugin behind an error boundary; one failure cannot stop workbench startup.
- Cap provider result counts and payload sizes at the consumer boundary.
- Record activation duration and attributed errors without logging source text, credentials, or model prompts.
- Test activation failure cleanup, deactivation, duplicate ids, permission denial, and provider exceptions.
- Deprecate APIs for at least one minor release before removal in the next major API version.

`window.BOBO.platform` is a temporary trusted compatibility facade for migrating bundled modules. Third-party plugins must use only the injected context documented here.
