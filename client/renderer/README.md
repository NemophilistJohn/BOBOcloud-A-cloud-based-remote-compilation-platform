# Renderer build boundary

`entry.js` is the only source of truth for renderer module composition and
execution order. `index.html` loads Monaco's AMD loader first and then the
generated BOBO renderer bundle.

The current bundle deliberately preserves `window.BOBO` and the editor-rule
globals. Esbuild tree shaking is enabled, but these legacy side-effect modules
cannot yet benefit from fine-grained dead-code removal. New renderer modules
should use explicit imports and exports; compatibility exports can be assigned
to `window.BOBO` at their public boundary.

`core/` now contains the explicit renderer platform: lifecycle ownership plus
service, command, contribution, and plugin registries. `compat/` is the only
place that should add new legacy `window.BOBO` projections. The first migrated
module is `src/file-icons.ts`: it exports an injected service factory,
`compat/file-icons-adapter.ts` registers the service, and legacy callers see the
same instance through `BOBO.fileIcons`. Follow that pattern one low-coupling
module at a time; do not move a feature and all of its consumers in one change.

Theme selection follows that boundary without adding a native capability.
`src/theme-manager.ts` owns the synchronous, injectable theme service, while
`compat/theme-manager-adapter.ts` registers the private `workbench.theme`
service and projects the exact seven-method `window.themeManager` facade.
Listeners and the service share the disposable lifecycle contract; downloaded
plugins receive no theme service.

Installed extensions cross a separate typed wire boundary in
`core/plugin-extension-protocol.ts`. Its DTOs keep request arguments and
successful response values untrusted until the host method validates them, and
its bounded data cloner remains self-contained because the sandbox embeds that
factory's source directly into the isolated Worker. This protocol module is not
a service and does not add another host or compatibility adapter.

Agent renderer state is the next typed core boundary. `core/agent.ts` preserves
the existing runtime validation, bounds, compare-and-swap updates, and owner
cleanup, while `../types/agent.ts` separates permissive registration DTOs from
complete immutable snapshots. State handles and subscriptions use the shared
disposable contract; published patch events are defensive frozen copies with
normalized identities so the trusted workbench can update keyed rows safely.
`types/renderer-platform.ts` depends on the structural Agent store contract,
not on the concrete implementation class.

The trusted-module `core/plugin-runtime.ts` now follows the same contract-first
shape. `../types/plugin-runtime.ts` separates manifest input, immutable runtime
snapshots, permission values, operation results, plugin context ports, and
async disposal. Its dynamic service, command, and contribution paths enter the
same registries through explicit checked runtime methods; the closed host maps
remain strict for ordinary TypeScript callers. Installed packages still use
the separate Worker extension host and do not gain this trusted context.

The source-control slice follows the same boundary: typed SCM request and
decoration DTOs feed a host-rendered `src/source-control-view.ts` service, while
`compat/source-control-view-adapter.ts` is the only legacy projection. Runtime
plugin command ids use the explicit dynamic-command port, and the view remains
host-only rather than becoming a plugin service.

The command palette is likewise a host-only typed presentation service.
`src/command-palette.ts` keeps its ordered replacement semantics in an O(1)
map and batches result DOM updates, while
`compat/command-palette-adapter.ts` preserves the exact `BOBO.commands`
surface. The installed extension host resolves the service through the typed
registry, so typed core code no longer reaches back through the compatibility
namespace.

Document Views use the same vertical boundary. `core/document-view.ts` owns
descriptor validation and selection, `core/document-view-sandbox.ts` owns the
bounded opaque-frame protocol, and `src/document-views.ts` owns injected
workbench lifecycle. `core/native-host-adapter.ts` exposes only
the slice's `host.documentViews` capability;
`compat/document-views-adapter.ts` registers the private
`workbench.documentViews` service and is the sole `BOBO.documentViews`
projection for the still-coupled workspace and app callers. Neither service is
available through the plugin service map.

`core/native-host-adapter.ts` is the only new-code entrypoint to the preload
bridge. It projects narrow, host-only domain services into the service registry;
feature modules consume those services through injection. The typed rclone
client and lifecycle-owned settings selector use the private `host.rclone`,
`workbench.rclone`, and `workbench.rcloneSettings` contracts. Their two adapters
preserve the mutable `BOBO.rclone` client and historical four-method
`BOBO.rcloneSettings` facade for legacy callers. Selection requests send only
opaque scan and candidate ids; executable confirmation and trust remain in
Electron main. The direct-access contract test ratchets remaining JavaScript callers down
and rejects bridge access from any other TypeScript module.

`types/renderer-platform.ts` is the compile-time service map over that existing
runtime registry; `types/lifecycle.ts` supplies the shared disposable contract.
The server runtime slice now keeps transport construction, capability DTO
normalization/refresh, and cloud feature policy in injectable TypeScript
services. Their three adapters in `compat/` register one host-only instance
each and retain the legacy `BOBO` projections while older consumers are
migrated.

The future third-party contract is specified in `../../docs/plugin-api.md`. The
current runtime activates only already-loaded trusted modules and is not a
plugin package loader or security sandbox.

AI transport, the status button, and Monaco inline completion stay in the core
bundle. The settings center, chat panel, Markdown renderer, and Temml are built
as `bobo-ai-ui.js`. `ai-ui-loader.js` preserves their `window.BOBO` APIs with
proxies and loads that bundle once, on the first visible Chat or AI Settings
action. Its `init()` proxies only record pending initialization, so startup does
not fetch or parse the presentation bundle.

- `npm run build:renderer:dev` creates an unminified bundle with a linked source
  map for local development.
- `npm run build:renderer` creates the minified production bundle.
- electron-builder's `beforePack` hook always rebuilds production artifacts; it
  never trusts an older development bundle.
