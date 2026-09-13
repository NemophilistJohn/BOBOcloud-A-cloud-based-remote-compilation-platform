# Renderer build boundary

`entry.js` is the only source of truth for renderer module composition and
execution order. `index.html` loads Monaco's AMD loader first and then the
generated BOBO renderer bundle.

The current bundle deliberately preserves `window.BOBO` and the editor-rule
globals. Esbuild tree shaking is enabled, but these legacy side-effect modules
cannot yet benefit from fine-grained dead-code removal. New renderer modules
should use explicit imports and exports; compatibility exports can be assigned
to `window.BOBO` at their public boundary.

The editor-rule registry is now a typed vertical service as well.
`completion-rules.ts` owns the language-plugin registry, completion-provider
disposables, symbol cache, and diagnostics DTOs; `compat/editor-rules-adapter.ts`
registers it privately as `workbench.editorRules`. The historical
`window.editorRuleRegistry` and `window.registerCompletionProviders` projections
remain only as compatibility boundaries, while editor-core and diagnostics
resolve the typed service first.

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

The lazy AI presentation bundle uses the same pure boundary for streaming
render scheduling. `src/stream-render-scheduler.ts` owns the typed timer/frame
ports and the four-method batching contract; `compat/stream-render-scheduler-adapter.ts`
is the only place that projects `BOBO.createStreamRenderScheduler`. The
scheduler coalesces burst chunks, supports an immediate final flush, and clears
an optional animation-frame handle even when a host omits cancellation support.

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

Team collaboration now follows the same typed vertical boundary. The historical
DOM workflow lives in `src/collaboration.ts`, with server action DTOs, lock and
cache records, and a disposable thirteen-method facade defined in
`types/collaboration.ts`. `compat/collaboration-adapter.ts` is the sole writable
`BOBO.collaboration` projection; the six filesystem/workspace operations are
available only through the private `host.collaboration` service registered by
`core/native-host-adapter.ts`. Team state, lock heartbeats, modal handlers, and
deferred callbacks are lifecycle-owned, and the service is not exposed to
downloaded plugins.

The shared renderer state now has a typed DTO boundary. `src/state.ts` owns the
eager singleton shape and its stable nested state records, while
`compat/state-adapter.ts` performs the one legacy `BOBO.state` projection. The
state remains mutable for the existing workbench modules, but the typed factory
keeps new code from inventing an unbounded second state shape.

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
bounded transcript writer from the private `workbench.serverComm` service and
preserves the historical `BOBO.runOutput` facade. `src/server-comm.ts` owns the
typed output/HTTP ports, transcript limits, request cancellation, and exact
five-key BOBO compatibility projection supplied by
`compat/server-comm-adapter.ts`. Both services are host-only, so disposal and
transport state cannot become a second output-authority path for plugins.

Run configuration is now a private typed service too. `src/run-config.ts`
normalizes per-workspace argument and build-target DTOs, preserves the v1/v2
storage migration and target cache, and owns the popover, outside-pointer,
locale, and in-flight request cleanup. `compat/run-config-adapter.ts` injects
the legacy state/storage/server ports and projects the historical seven-method
`BOBO.runConfig` facade without exposing run configuration to plugins.

The bottom output panel is now a private typed service as well.
`src/output-panel.ts` owns tab activation, keyboard navigation, clear routing,
and listener disposal through narrow collaborator ports;
`compat/output-panel-adapter.ts` is the sole `BOBO.outputPanel` and
`BOBO.switchToPanel` projection. The service remains host-only and keeps
terminal, debug, problem, and run-output authorities in their existing modules.

Task-output diagnostics now use the same typed vertical boundary. `src/task-
problem-matcher.ts` keeps VS Code-compatible matcher DTOs, workspace scoping,
Monaco marker merging, and the clickable Problems panel behind narrow ports;
`compat/task-problem-matcher-adapter.ts` preserves the writable
`BOBO.taskProblemMatcher` facade and registers the service privately. A bounded
problem snapshot cache avoids re-sorting unchanged task output on every panel
refresh, while registry disposal clears listeners and active matcher state.

Workspace cloud-sync decoration is now a private typed service.
`src/workspace-sync-status.ts` owns the queued/syncing/error/conflict state
machine, revision-fenced upload contexts, bounded mutation de-duplication, and
tree aggregation DTOs. `compat/workspace-sync-status-adapter.ts` is the sole
`BOBO.workspaceSyncStatus` projection and registers the sync-lane contribution
through the typed registry. Registry disposal removes contribution and language
listeners, while coalesced animation-frame notifications keep large tree
updates from triggering redundant visible-row refreshes.

Workspace editor settings now follow the same vertical boundary.
`src/workspace-settings.ts` validates and freezes the supported settings DTOs,
applies language associations, indentation, editor options, and exclude rules,
and fences late workspace reads. `compat/workspace-settings-adapter.ts` is the
sole `BOBO.workspaceSettings` projection; its private host service is the only
route to preload settings IPC. Registry disposal now removes host, Monaco, and
editor subscriptions, while a shared empty snapshot avoids repeated fallback
allocation on model and tree hot paths.

Workspace launch now follows the same private host boundary. The
`src/workspace-launch.ts` service owns the first-frame picker queue, recent-project persistence,
single-flight requests, localized controls, and disposable startup listeners;
`compat/workspace-launch-adapter.ts` is the sole `BOBO.workspaceLaunch`
projection. Its narrow `host.workspaceLaunch` service keeps picker and recent
workspace IPC out of the launch state machine and remains unavailable to
plugins.

The application shell and its region geometry now follow that boundary too.
`src/workbench-layout.ts` owns the validated layout DTO, viewport clamping,
resizer/keyboard listeners, editor-layout scheduling, and context refresh
under one disposable `workbench.layout` service. The service injects storage,
DOM, timers, animation frames, and legacy collaborators, so no second native
authority is introduced; `compat/workbench-layout-adapter.ts` is the only
place that projects the exact historical `BOBO.workbench` facade. The service
is private to the trusted workbench and registry disposal removes every shell
listener and deferred callback.

Quick Open is now a private typed service as well. `src/file-search.ts` owns
the bounded fuzzy index, history/suggestion DTOs, localized result rendering,
and keyboard lifecycle through injected state, storage, DOM, and workbench
ports. `compat/file-search-adapter.ts` is the only `BOBO.fileSearch`
projection, preserving its writable three-method facade while keeping the
service out of the downloaded-plugin map. Cache rebuilds stay identity-aware,
and bounded insertion avoids sorting the complete workspace result set.

The unified settings shell now follows the same private typed boundary.
`src/settings.ts` preserves the existing Local, LSP, Workbench, Language,
Server, first-run, theme, diagnostics, and legacy AI flows behind injected
state and collaborator ports. `compat/settings-adapter.ts` alone projects the
historical six-method `BOBO.settings` facade. Registry disposal removes the
static DOM handlers, render-scoped AI handlers, overlays, and deferred focus or
first-run callbacks; no settings service is exposed to downloaded plugins.

The Monaco editor core now follows the same private typed boundary.
`src/editor-core.ts` keeps editor creation, keyboard commands, status-bar
rendering, and debounced syntax diagnostics behind typed Monaco/DOM and
collaborator ports; `compat/editor-core-adapter.ts` is the sole writable
`BOBO.editorCore` projection and registers the private `workbench.editorCore`
service. Monaco model listeners, the expected cancellation filter, and pending
diagnostic timers are disposed with the service, while the existing AMD
loading order and legacy command behavior remain unchanged.

The account profile and compile-activity center follows the same boundary.
`src/account-profile.ts` keeps the profile draft, avatar processing, UTC
activity heatmap, identity/request generations, and close-confirmation flow
behind typed state, account, collaboration, and transport ports.
`compat/account-profile-adapter.ts` is the sole writable five-method
`BOBO.accountProfile` projection and registers the lifecycle-owned
`workbench.accountProfile` service privately; in-flight activity/save/image
callbacks are fenced during reset or disposal, and no account authority is
exposed to downloaded plugins.

AI prompt assembly is now a typed pure boundary. `src/ai-prompts.ts` owns the
bounded context/history DTOs, deterministic character budgeting, and inline/chat
message builders; `compat/ai-prompts-adapter.ts` is the only legacy
`BOBO.aiPrompts` projection. It adds no host authority or registry exposure, so
the existing AI transport and context modules can continue consuming the same
facade while they are migrated independently.

AI context gathering now follows the same private typed-service boundary.
`src/ai-context.ts` owns the six historical context methods through narrow state,
Monaco model/editor, DOM file-tree, and prompt-truncation ports;
`compat/ai-context-adapter.ts` is the sole writable `BOBO.aiContext` projection
and registers `workbench.aiContext` privately. Current-file, selection, project
structure, open-tab, full-context, and inline-context budgets retain their
existing limits and null/disabled behavior, while service disposal fences later
reads and the context service grants no host or downloaded-plugin authority.

AI transport and profile coordination now follow the same boundary.
`src/ai-service.ts` owns the canonical v4 settings, compatibility aliases,
connection fingerprints and health probes, chat/inline request cancellation,
stream filtering, and the bounded inline LRU through typed DTOs and the private
`host.ai` port. `compat/ai-service-adapter.ts` is the sole writable
`BOBO.aiService` projection and registers `workbench.aiService` privately;
the historical 44-method facade remains intact, while generation fences and
disposable stream subscriptions prevent late host results from mutating state
after disposal or supersession.

The Monaco inline-completion lane now has its own typed vertical boundary.
`src/ai-inline.ts` owns the provider, latest-wins debounce, model-version
checks, and cancellation lifecycle through structural Monaco, AI-service, and
AI-context ports; `compat/ai-inline-adapter.ts` registers the private
`workbench.aiInline` service and projects the exact seven-key writable
`BOBO.aiInline` facade. Provider registrations, model listeners, token
subscriptions, timers, and pending promises are released together, while the
existing language coverage, trigger filtering, split-editor routing, and
empty-result behavior remain unchanged. The service is intentionally absent
from the downloaded-plugin map.

The lazy Markdown renderer now follows the same explicit presentation boundary.
`src/ai-markdown.ts` receives typed DOM, Temml, clipboard, icon, i18n, and timer
ports; `compat/ai-markdown-adapter.ts` alone projects `BOBO.aiMarkdown`. Safe
link filtering, native MathML fallback, code-copy feedback, and streaming cursor
rendering remain in the same order and use the existing localized strings.

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
as `bobo-ai-ui.js`. `ai-ui-loader.ts` preserves their `window.BOBO` APIs with
proxies and loads that bundle once, on the first visible Chat or AI Settings
action. Its `init()` proxies only record pending initialization, so startup does
not fetch or parse the presentation bundle. Its small typed contract keeps the
lazy loader's bundle result and compatibility namespace explicit without pulling
the DOM-heavy presentation modules into the startup graph.

The AI status button is now a private `workbench.aiAgentButton` service. Its
typed host event arrives through the private `host.aiUi` adapter, while lazy
chat/settings proxies remain presentation dependencies. The compatibility
adapter projects only the historical five-key `BOBO.aiAgentButton` facade;
button DOM listeners, menu timers, host subscriptions, and status-bar nodes
are lifecycle-owned and removed together on disposal. The AI service and
workbench layout resolve the button through the typed service map instead of
creating another global dependency.

The settings center follows the same boundary in the lazy bundle. Its
`workbench.aiSettingsCenter` service receives the schema, AI transport, dialog,
icons, and sibling workbench ports through a typed dependency object, owns its
timers and locale subscription, and exposes only the historical seven-key
`BOBO.aiSettingsCenter` projection. The shared schema remains the deliberate
CommonJS-compatible JavaScript implementation used by both the main process and
the renderer; `types/ai-settings-schema.ts` and
`compat/ai-settings-schema-adapter.ts` provide its single typed renderer
contract without duplicating or weakening the normalization rules.

The chat panel now follows the same lazy-service boundary. Its historical DOM,
stream rendering, command suggestions, referenced-file limits, conversation
history migration, and ten-key `BOBO.aiChatPanel` facade remain unchanged, while
file/tree/history IPC is narrowed to the private `host.aiChatPanel` port and all
panel listeners and timers are owned by the disposable
`workbench.aiChatPanel` service.

The Agent workbench now follows the same typed vertical boundary in the core
bundle. `src/agent-workbench.ts` keeps its keyed feed reconciliation,
host-canonical approval rendering, access-mode confirmation, and six-key
`BOBO.agentWorkbench` facade while receiving sibling services and timers
through injected ports. `core/native-host-adapter.ts` narrows the six approval
and access operations to the private `host.agentWorkbench` capability;
`compat/agent-workbench-adapter.ts` registers the disposable
`workbench.agentWorkbench` service and preserves the existing ready-event
initialization timing. Disposal fences late approval/model results and clears
owned DOM, listener, and expiry-timer state, while neither the service nor its
host authority is exposed to downloaded plugins.

- `npm run build:renderer:dev` creates an unminified bundle with a linked source
  map for local development.
- `npm run build:renderer` creates the minified production bundle.
- electron-builder's `beforePack` hook always rebuilds production artifacts; it
  never trusts an older development bundle.
