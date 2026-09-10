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

Pure renderer utilities deliberately stay outside the service registry because
they own no state, resources, host authority, or lifecycle. `src/utils.ts`
exports six typed functions for direct imports, while
`compat/utils-adapter.ts` is their sole writable `BOBO` projection for legacy
callers. Static lookup data is allocated once, and language display lookup uses
own properties so prototype-shaped unknown language ids remain ordinary ids.

The small renderer primitives now use the same typed boundary. `src/icons.ts`
owns the immutable SVG catalog and `compat/icons-adapter.ts` gives legacy code a
writable copy. `src/tab-order.ts` keeps reorder semantics pure while its private
service adapter preserves `BOBO.tabOrder`. `src/toast.ts` owns the notification
DOM and all timeout/click cleanup; `compat/toast-adapter.ts` preserves the
historical three-method facade without exposing the service to downloaded
plugins.

Cache inventory normalization follows the same pure-module boundary.
`src/cache-model.ts` owns the typed v2 DTO normalization, matching, sorting, and
grouping functions, while `compat/cache-model-adapter.ts` projects the exact
legacy `BOBO.cacheModel` facade. Internal category ranking is immutable and
precomputed; the facade receives its own writable category-order copy, so
legacy customization cannot change typed core sorting. Capability metadata is
copied through own enumerable string and symbol properties without granting
prototype-shaped keys special behavior.

Environment activity is a private, lifecycle-owned workbench service.
`src/environment-activity.ts` owns its typed scoped ledger and event DTOs, while
`compat/environment-activity-adapter.ts` captures the established renderer state
reference, resolves the current legacy `projectKey` function for each scope, and
projects the exact writable seven-key `BOBO.environmentActivity` facade. The
service is not exposed to downloaded plugins; registry disposal clears its
subscriptions without adding disposal authority to the compatibility surface.

Cache Inventory state and mutations are likewise owned by a private typed
service. `src/cache-store.ts` injects the dynamic renderer identity, transport,
abort-controller, and cache model boundaries; `compat/cache-store-adapter.ts`
is the only `BOBO.cacheStore` and `BOBO.cacheStoreFactory` projection. Inventory
reads are single-flight per identity, invalidations coalesce into a trailing
refresh, and context epochs prevent reset, disposal, or identity changes from
letting late reads and mutations repopulate another account's state. The
service is lifecycle-disposable and is not exposed to downloaded plugins.

The Cache Center presentation is a separate private, lifecycle-owned service.
`src/cache-center.ts` keeps rendering, filtering, and cache actions behind
injected typed ports, while `compat/cache-center-adapter.ts` is the sole
`BOBO.cacheCenter` projection for the still-JavaScript Projects view. The
adapter preserves dynamic legacy collaborators without exposing Cache Center
or its cache mutation controls to downloaded plugins.

The Environment Center is also a private vertical service.
`src/environment-center-model.ts` owns the pure manifest, health, package, and
server-snapshot transforms; `src/environment-center.ts` owns rendering and the
diagnose/plan/confirm/apply workflow through typed DTOs and injected ports.
`compat/environment-center-adapter.ts` is the sole `BOBO.environmentCenter`
projection. Workspace and identity epochs fence late refreshes and actions,
while registry disposal removes every DOM, workbench, activity, marker, file,
and timer subscription. Its `readTree` and file-event authority comes only
through the narrow private service created by `core/native-host-adapter.ts`.

The editor views slice follows the same boundary. `src/views.ts` owns split,
diff, image-preview, and theme-picker behavior through typed state, Monaco, and
host ports; `compat/views-adapter.ts` is the sole writable `BOBO.views`
projection with the historical eight methods and order. Diff request epochs
prevent late file reads from replacing a newer view, while split listeners,
debounce timers, Monaco models, and DOM handlers are released through the
shared disposable lifecycle. File reads use the private `host.views` capability
from `core/native-host-adapter.ts`, and neither views service is exposed to
downloaded plugins.

The Projects and cache-management panel now follows the same vertical split.
`src/projects.ts` owns the server-project DTO normalization, quota/project
rendering, identity fences, delegated delete handling, and DOM/preload
subscription cleanup. `compat/projects-adapter.ts` is the only writable
`BOBO.projects` projection and preserves its historical six methods and order.
Local project-name persistence and the `open-server-projects` event are exposed
only through the private `host.projects` capability; the workbench service is
kept out of the downloaded-plugin service map. The cache center remains a
separate service injected through a narrow port, so the existing Projects/cache
tab behavior does not acquire a second lifecycle or authority path.

Runtime selection is now a private typed workbench service as well.
`src/runtime.ts` keeps the Local-versus-Docker choice, per-language preferences,
numeric version ordering, menu behavior, and automatic active-file selection;
`compat/runtime-adapter.ts` preserves the exact six-key `BOBO.runtime` facade,
including its helper bundle. Storage and legacy workbench collaborators are
injected ports, catalog responses cross an explicit DTO boundary, and a request
epoch prevents late catalog reads from repopulating a disposed selector. The
service owns its button, outside-click, and deferred-listener lifecycle and is
not available to downloaded plugins.

Structured run presentation now follows the same boundary. `src/run-output.ts`
owns the lifecycle summary, phase/status DTOs, session fencing, detail-count
state, and locale refresh behavior; `compat/run-output-adapter.ts` injects the
existing bounded transcript writer from `server-comm.js` and preserves the
historical `BOBO.runOutput` facade. The service is registered as private
`workbench.runOutput`, so disposal removes its locale listener without creating
a second output-authority path for plugins.

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

Confirmation dialogs use a private typed service with lazy DOM ownership,
FIFO request ordering, discriminated boolean/details results, and deterministic
timer cleanup. `compat/confirm-dialog-adapter.ts` registers
`workbench.confirm` for the trusted workbench and projects only the callable
`BOBO.confirm` facade; service disposal is not exposed to legacy consumers or
downloaded plugins.

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
