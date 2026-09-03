# BOBOCloud Local AI Agent Plugin Architecture

Status: API 1.6 implementation contract and Agent 1.4 construction guide. The minimum API 1.6 desktop host is BOBOCloud 2.8.1.

## Scope and product boundary

The Agent is a purely local client capability. It does not add a Go endpoint, change the cloud compiler protocol, or send Agent state through the BOBOCloud server. Chat and inline completion remain native client features. Agent behavior is supplied by an independently installed plugin and is visible only while that plugin is enabled and successfully registered.

The design has four non-negotiable properties:

1. Downloaded code runs without Node.js, Electron, preload, DOM, filesystem, process, credential, or raw network authority.
2. The host owns every reusable privileged capability and every generic UI surface.
3. The plugin owns orchestration: prompts, turn loops, reasoning policy, goal planning, session semantics, and localized content.
4. Every registration and pending privilege is tied to plugin and workspace lifecycle.

## Layered architecture

```text
Official Agent plugin repository
  manifest + one bundled Worker entry + en/zh-CN/ja messages
                         |
                         | bounded JSON-like messages
                         v
Renderer extension host and protocol
  activation Worker | permission checks | lifecycle handles
                         |
             +-----------+------------+
             |                        |
             v                        v
Renderer Agent platform          Main-process Agent broker
  descriptors/state/store          models | workspace tools
  command payloads                 access policy | approvals | Skills | storage
             |                        |
             v                        v
Trusted Agent workbench          OS / local workspace / AI provider
```

### Host modules

| Module | Responsibility |
| --- | --- |
| `client/main/plugins.js` | Package validation, permission grants, broker method authorization, install/disable/uninstall lifecycle, and sanitized plugin records. |
| `client/main/agent-platform.js` | Opaque model refs and declared capabilities, normalized stream events, structured local tools/descriptors, host-authoritative risk/access policy, revisioned Skill discovery, and isolated JSON persistence. |
| `client/main/ai.js` | Provider-specific request, reasoning, SSE normalization, usage accounting, and cancellation while retaining secret model profiles in the main process. |
| `client/renderer/core/agent.ts` | Agent descriptor/state validation, complete snapshots, compare-and-swap state patches, bounds, events, and owner cleanup. |
| `client/types/agent.ts` | Registration and normalized DTOs, patch/event unions, structural store ownership, and shared disposable contracts. |
| `client/renderer/core/plugin-extension-protocol.ts` | Typed data-only cross-realm protocol and bounded cloning/error envelopes. |
| `client/types/plugin-extension-host.ts` | Extension descriptors, lifecycle results, dynamic registry ports, service snapshots, and disposable ownership contracts. |
| `client/renderer/core/plugin-extension-host.ts` | Permission enforcement, contribution handles, command routing, broker delegation, and deterministic teardown. |
| `client/types/plugin-extension-bootstrap.ts` | Private native extension bridge, subscription, and bootstrap error contracts. |
| `client/renderer/core/plugin-extension-bootstrap.ts` | Delayed activation, refresh coalescing, typed locale integration, and lifecycle-owned native subscriptions. |
| `client/types/command-palette.ts` | Host palette metadata, registration port, compatibility facade, and disposable service contracts. |
| `client/src/command-palette.ts` | Ordered command replacement, localized filtering, batched DOM rendering, and lifecycle cleanup. |
| `client/renderer/compat/command-palette-adapter.ts` | Private service registration and the sole legacy `BOBO.commands` projection. |
| `client/types/platform-adapter.ts` | Typed contract for the frozen, trusted legacy workbench facade. |
| `client/renderer/compat/platform-adapter.ts` | Compatibility projection over typed services, dynamic commands, contributions, Agent state, and source control. |
| `client/renderer/core/plugin-extension-sandbox.ts` | Frozen public plugin context inside the network-disabled Worker. |
| Trusted Agent workbench | Dynamic activity entry, session navigation, editor-sized tab, host access/approval controls, and state-to-command translation. |

No module above is specific to the official Agent plugin id. A future Agent plugin can use the same descriptor, state, model, tool, Skill, storage, and lifecycle contracts without a host patch.

### Plugin modules

The official package should keep a small internal split before bundling:

| Logical module | Responsibility |
| --- | --- |
| activation | Register commands and Agent provider; hydrate persisted state; publish the initial snapshot. |
| sessions | Create, select, delete, title, bound history, and serialize sessions. |
| orchestrator | Build system/user/tool messages, run model turns, parse tool calls, and enforce turn/tool limits. |
| goals | Create and revise bounded goal steps from current evidence, while preserving stable step identities and publishing transitions. |
| tools | Validate model-generated JSON arguments, invoke only named host tools, and pause on approval. |
| skills | Select opaque Skill ids, progressively load revision-pinned documents, and inject only currently relevant bounded instruction text. |
| checkpoints | Estimate the live context budget, roll older turns into semantic checkpoints, and preserve decisions, goal state, tool evidence, and unresolved work. |
| presentation | Convert domain state into the host `AgentState`; localize every visible title and status. |

The release artifact remains one self-contained ES module. Source modules, build tools, tests, and `node_modules` are repository inputs, not package runtime dependencies.

## Frontend architecture

The Agent follows the editor-page layout used by modern VS Code coding agents:

- A dynamic Agent activity-bar item opens a dedicated left sidebar containing new-session, search/grouping, and session-history controls.
- Selecting a session opens or reuses a closeable Agent tab in the central editor area. The Agent tab is a peer of code, settings, plugin-detail, and document tabs rather than a narrow chat panel.
- The central page has a compact transcript/timeline, optional goal progress, an approval row when needed, and a stable bottom composer with model, Agent mode, reasoning effort, access mode, and Skill controls.
- The existing bottom Problems/Output/Debug Console/Terminal panel remains independent and can stay visible under the Agent tab.
- The host renders empty, loading, unconfigured, running, waiting-approval, completed, failed, and cancelled states. A plugin supplies data and commands, never markup.
- If no Agent provider is registered, no empty Agent shell is shown. Disable or uninstall removes its activity entry, sidebar, state, and open tabs.

This requires a frontend API, but it is a data API rather than a webview API: `agents.register()`, immutable Agent state, Agent-state events for trusted workbench code, and namespaced command payloads. Keeping rendering in the host preserves consistent theme, accessibility, localization behavior, layout, and security.

## Runtime flows

### Activation

1. The main process validates package structure, hashes, engine ranges, requested permissions, and grants.
2. The renderer extension host loads the verified entry into a dedicated Worker and supplies a frozen context.
3. The plugin registers its commands and calls `agents.register()`.
4. The extension host validates ownership, registers the contribution and state provider, and returns an opaque handle.
5. The plugin restores its private JSON state, lists model and Skill metadata as permitted, then publishes one complete Agent snapshot.
6. The trusted workbench creates the activity item and opens the selected session only from that snapshot.

### User turn

1. The workbench invokes the plugin's `send` command with one bounded payload.
2. The plugin appends the user message, marks the session running, creates a unique request id, starts a tracked asynchronous turn, publishes a versioned patch, and returns from the command without waiting for the full turn.
3. The plugin calls `models.generateStream()` using an opaque model ref and bounded tool schemas. A feature-detected `generate()` fallback preserves API 1.5 compatibility for the official package.
4. The main broker resolves the secret host profile, translates only declared reasoning controls, and emits normalized request-scoped events. Provider SSE framing and credentials never cross into the Worker.
5. The plugin incrementally upserts the assistant message and timeline, then either finalizes the assistant result or validates and dispatches named tools.
6. Independent host descriptors marked both `readOnly` and `parallelSafe` may execute in a bounded parallel batch. Unknown or mutating tools remain serial.
7. The loop ends on a final response, cancellation, approval wait, bounded iteration limit, or error.

`models.cancel(requestId)` maps only to the calling plugin's host-prefixed request. Cancellation is a real transport operation, not merely a UI state change.

### Goal mode

Goal mode is an orchestration policy, not a more privileged capability. The initial plan is provisional: the plugin exposes a `goal_update` model tool that can add, reorder, split, block, or complete bounded steps as evidence changes. Existing step ids remain stable whenever their intent is unchanged, at most one step is in progress, and every revision is published as ordinary validated Agent state. A blocked or failed step does not silently widen permissions. Resuming continues from persisted semantic state but must re-read workspace facts and request fresh approvals.

### Progressive Skills and rolling context

Skill selection is metadata-first. `skills.list()` supplies opaque id, revision, byte size, and estimated tokens; the plugin exposes those descriptions to the model without immediately loading every document. A `skill_load` orchestration tool reads one selected Skill with its listed revision only when needed. Revision mismatch aborts that load and refreshes the catalog, preventing instructions from changing between selection and use.

The model capability snapshot is the only source for `contextWindowTokens` and the provider's exact `maxOutputTokens`; unknown values remain `null` and use a conservative plugin fallback. The host separately derives `requestOutputLimitTokens = min(maxOutputTokens, 262144)` (or the host ceiling when provider output is unknown), allowing orchestration to retain truthful provider metadata while respecting the local safety boundary. Before each model call, the plugin estimates system, checkpoint, active Skill, recent message, and expected-output cost. When the rolling threshold is crossed, older turns are replaced by a semantic checkpoint that preserves constraints, decisions, goal revisions, file/tool evidence, failures, approvals, and unresolved work. The original user request and recent verbatim turns remain available. Checkpoint creation and replacement are timeline-visible and persisted, so compaction is a resumable state transition rather than silent transcript deletion.

### Trusted access and approval

Access mode is volatile main-process state keyed by exact `pluginId + providerId + sessionId`. The trusted workbench activates a context with `agentAccessGet`, changes it with `agentAccessSet`, and deletes it with `agentAccessClear`; none of these functions exist in the Worker context. `full` requires a separate explicit dangerous-action confirmation before the UI passes `confirmed: true`.

The main broker owns a deterministic risk matrix. Version/help probes and allowlisted read-only Git inspection are low risk, ordinary workspace writes are medium risk, and sensitive configuration/script writes plus all other process execution are high risk. `ask` makes every mutation pending, `auto` executes only low/medium operations directly, and confirmed `full` executes all already-permitted fixed tools directly. The broker re-reads trusted access after asynchronous path/executable resolution and immediately before execution so a concurrent downgrade cannot leave stale authority.

When approval is required:

1. The plugin invokes `workspace_write` or `process_run` with structured input; plugin-supplied access or session fields are ignored.
2. The main broker validates the request and stores the operation under an unguessable, plugin-scoped, workspace-scoped, expiring id. The id alone is not execution authority.
3. The plugin publishes only `{ id }` in `activeSession.approval`; it cannot supply tool, summary, risk, expiry, access mode, or details to the workbench.
4. The trusted workbench asks main to describe the canonical pending operation and renders the decision from that result.
5. Only an explicit user action in trusted UI calls the preload/main `decide` operation. Main consumes the pending id once, checks the exact permission, and revalidates workspace/file state before executing or rejecting it.
6. The workbench invokes the plugin's approval or rejection command only after main returns, carrying the canonical `approvalResult`; the plugin then resumes orchestration.

The Worker context has no approval, rejection, decision, or process-cancel method. For an approved `process_run`, the id remains a trusted-workbench runtime handle: preload/main `cancel` requires the original plugin's `process.execute` grant and terminates only its matching process. Disabling, uninstalling, replacing, or disposing a plugin also terminates its active processes.

## Security model

| Threat | Control |
| --- | --- |
| Plugin reads API keys | Model references are opaque; complete profiles are resolved only in main process memory. |
| Path traversal or symlink escape | Paths are workspace-relative, normalized, resolved against real parents, and rechecked against the active workspace. Symlink traversal is rejected or skipped. |
| Overwriting a changed file | Reads return SHA-256; write requests require the expected hash and recheck it after approval. |
| Shell injection | Process requests use an allowlisted executable and argv array with `shell: false`; no shell string or environment object is accepted. |
| Plugin forges a stronger access mode | Access state is held only in main and keyed by plugin/provider/session. Worker tool payload overrides are ignored; `full` requires trusted UI confirmation. |
| Plugin self-approves a mutation | When policy requires approval, the Worker can only create a pending operation. Describe, decide, and cancel exist solely on the sender-bound trusted renderer/preload/main path. |
| Unexpected automatic mutation | `auto` uses only the host risk matrix, `full` retains all capability/sandbox validation, and mode is re-read at the last execution boundary. |
| Orphaned local process | Running processes stay keyed by plugin and approval id; trusted workbench cancel and every plugin/host teardown path terminate them. |
| Cross-plugin request cancellation or stream injection | Model request ids are host-prefixed by plugin id; events are bound to plugin revision, request id, monotonic sequence, and one terminal state. |
| Skill-based privilege escalation or stale Skill read | Skill content is instruction data only; it grants no permission, cannot bypass tool approval, and is read against a listed content revision. |
| Stale state after workspace switch | Brokers capture and revalidate a monotonic workspace identity; pending approvals are invalidated by mismatch. |
| UI injection | The host accepts bounded state fields and semantic icon/status tokens only; no HTML, CSS, URLs, or callbacks cross the boundary. |
| Resource exhaustion | Entry, RPC, model input, file, output, state-list, session, message, timeline, Skill, storage, timeout, and result counts are bounded. |
| Deleted session or disabled plugin leaves authority | Session deletion clears its access context; deactivation disposes handles and clears plugin-owned access, pending approvals, searches, model requests, and processes. |

Plugin-local storage should still be treated as ordinary local application data, not a credential vault. The current application AI settings also need a separate at-rest secret-storage migration; the Agent boundary prevents new exposure to plugins but does not by itself encrypt existing host settings.

## Cross-platform contract

The packaged runtime remains JavaScript and uses Node/Electron primitives that exist on Windows, macOS, and Linux; typed renderer sources are erased by the existing esbuild pipeline:

- `node:path`, `realpath`, and workspace-relative POSIX serialization normalize OS-specific paths at the broker edge.
- `spawn(executable, argv, { shell: false })` avoids shell dialect coupling. `windowsHide` prevents helper windows on Windows.
- The executable allowlist includes platform spellings where needed (`npm.cmd`, `gradle.bat`, and similar), while absence is reported as a normal process failure.
- Plugin state lives beneath Electron `app.getPath('userData')`; Skills use `app.getPath('home')` plus supported dot-directory conventions.
- The plugin never embeds drive letters, `/home` paths, shell separators, signal assumptions, or a platform-specific package path.

macOS and Linux still require release-time validation for executable permissions and process termination semantics; Windows requires validation of atomic replacement when a destination already exists and command resolution for `.cmd`/`.bat`. These belong in platform CI and focused integration tests, not in plugin branching logic.

## Language decision

Keeping the client and official plugin in the JavaScript/TypeScript Electron architecture is the preferred design. The difficult parts are capability isolation, lifecycle, validation, concurrency, cancellation, and tests; adding a native sidecar language would not remove that complexity and would introduce another protocol, packaging matrix, update channel, signing surface, crash supervision, and cross-platform binary distribution.

Use typed DTO modules and incrementally migrated TypeScript renderer sources as compile-time contracts. The emitted runtime remains a single JavaScript bundle, and the downloadable plugin still ships one self-contained JavaScript module. A native or non-JS sidecar is justified only for a concrete capability Node/Electron cannot provide with acceptable correctness or performance, and it should still sit behind the same main-process broker rather than being exposed to plugins.

## Delivery and registration

The official plugin is developed and released from [BOBOCloud-AI-Agent-plugin-offical](https://github.com/NemophilistJohn/BOBOCloud-AI-Agent-plugin-offical). The host repository ignores its local nested checkout so the package retains an independent history and release cadence.

Each release must:

1. Build one deterministic activation entry and include en, zh-CN, and ja plugin-local messages.
2. Regenerate the manifest integrity map from exact package bytes.
3. Validate and install the produced `.boboplugin`, including enable, permission revocation, approval, cancellation, disable, update, and uninstall paths.
4. Publish the immutable archive and SHA-256 in the plugin repository release.
5. Register that exact version, source, artifact URL, size, SHA-256, engine ranges, publisher, and localized metadata in [BOBOCloud-Marketplace-Registry](https://github.com/NemophilistJohn/BOBOCloud-Marketplace-Registry).
6. Recompute and validate the registry's package/version/shard/root hash chain, then verify remote artifact bytes and catalog metadata.

The marketplace or host chooses the artifact URL. A plugin cannot supply an install URL or update itself.

## Construction sequence

1. Land the generic API 1.6 model capability, stream event, incremental state, tool descriptor, revisioned Skill, trusted access, and host risk-policy contracts with unit tests.
2. Land the trusted Agent workbench with keyed patch rendering and provider-aware model connection forms while leaving Chat and inline completion intact.
3. Build the official plugin against the declaration, including session storage/cleanup, dynamic Goal mode, requested/effective effort levels, model cancellation, progressive Skills, rolling checkpoints, bounded parallel reads, serial mutations, and approvals.
4. Run Node contract tests, renderer build checks, and real Electron UI flows at desktop and compact viewports.
5. Package and install the real archive, verify three locales and lifecycle cleanup, then publish the plugin release.
6. Register the immutable artifact in the marketplace and verify the complete remote hash chain.
7. Add Windows, macOS, and Linux CI coverage for packaging, path behavior, process handling, and cancellation before widening the executable/tool catalog.
