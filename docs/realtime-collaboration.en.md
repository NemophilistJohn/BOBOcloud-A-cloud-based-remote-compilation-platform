# Realtime collaboration and split editing

Desktop 2.9.0 and server 2.6.0 introduce optional native realtime team editing. These versions evolve independently. Ordinary Git collaboration remains available.

## Workflow

An administrator selects **Collaboration mode** on a team project card, then enables live editing on a clean, published branch. Save and publish local changes first. The server checks conflicts, member worktrees and active project consumers. Initial entry downloads a complete snapshot to a chosen local folder; replacing a nonempty folder requires confirmation. A complete sibling staging directory is prepared before existing files move, with rollback on failure.

Use the editor's upper-right split action or `Ctrl+\` to display two panes. Each text file owns its Monaco model. Normal-mode document plugins, Agent and plugin details can share the layout; different notebooks preserve independent iframes and drafts, while selecting the same view focuses its existing pane. Select a tab to fill an empty pane. Focus determines the save, run, outline and completion target; one text file may appear in both panes. Shared edits, compact named/avatar cursors and tree presence update live. Undo and redo affect the user's own operations. Save waits for durable server acknowledgement. Disconnected edits remain in local drafts and merge after reconnecting to the same epoch.

Run a file or project task from the authoritative source snapshot. The team panel shows members/files, shared execution, output, stdin, Stop, deletion votes, Git checkpoints and personal snapshots. A shared process survives its initiating window disconnecting. To return to ordinary collaboration, an administrator disables live mode; the server first commits and pushes the final canonical snapshot. A failed export leaves live mode intact, and old upload grants remain detached from new worktrees. Successful exit removes canonical source/nodes, retaining mode metadata. Local mappings persist the live epoch: exit or offline reopen first reconstructs final files from Git and refreshes disk/open models before ordinary synchronization resumes, preventing stale unopened files overwriting the final version.

## Presence and deletion

A file that has been edited stays held while visible in any pane. Switching away starts a ten-second release period; switching back cancels it. Multiple files and sessions are supported. App heartbeats occur every twenty seconds; sixty seconds without messages releases that session, including an abruptly disconnected one. Reading while connected does not count as going offline.

A deletion request captures current editor users, deduplicated across sessions, and blocks new opens. Existing editors can continue editing after consenting. The file is removed when every captured user has consented or released all their holdings. A veto, requester cancellation or 180-second timeout cancels the request. Directory requests include descendants.

## Scope and operations

- Project-local `realtime.json` persists canonical text/tree state, CRDT nodes/tombstones, epochs and bounded idempotency receipts before acknowledging mutations. Local and member cloud worktrees cannot overwrite it. File bodies load lazily after initial download; tree changes and presence broadcast globally.
- Automatic personal cloud backup pauses in live mode. An explicit personal snapshot publishes an independent, quota-checked copy, idempotent per revision. Later live edits do not overwrite that personal copy.
- Execution reuses the existing run/task engine, admission, queues, Docker pool and team cache policy. No permanent execution container is introduced. Existing team runs still do not mount personal project immutable dependency generations; this feature does not redesign dependency installation.
- One shared run per room, with shared stdout/stderr/status, stdin and cancellation. Retained output replays a bounded 256-KiB tail rather than an unlimited history.
- LSP, DAP and environment inspection use separate canonical-source projections. Mode transitions stop the current window's old execution, sync and analysis services; blocking consumers in other windows must finish before switching.
- Legacy Git writes, upload/run routes and cloud terminals reject mutations in live mode. **Create version** is the explicit canonical Git checkpoint.
- This iteration collaborates on ordinary text. Notebooks open as JSON in live mode; document plugins do not independently save or execute shared notebooks. Normal-mode Notebook features remain available. External editors and unadapted plugins cannot publish local writes as shared operations.
- Limits: 4,096 entries, 16 MiB raw room data, 1 MiB baseline files, 128 KiB editable text; larger supported text and binaries remain read-only snapshots. Node limits are 200,000 per file and 500,000 per room; serialized state is capped at 64 MiB, with 128 sessions. A limit rejects new operations while preserving unresolved local drafts. Checkpointing and re-entering live mode can reseed nodes when appropriate.

Drafts live under Electron userData `collaboration-drafts/`, scoped to server/account/team/project/branch/local root. Deleted-file or old-epoch drafts never automatically overwrite new content; export recovered text through the team panel. User-approved discarded local files are not retained as long-term backups after successful replacement.

## Verification

`realtime-document.test.js` covers Unicode, convergence, selective undo and anchors. `realtime-service.test.js` blocks local materialization after an edit acknowledgement and verifies subsequent typing drains without another keystroke or save, guarding slow-disk queue races. `realtime-main.test.js` exercises real files, context fences, paths, scoped drafts and rollback. `realtime-ui.spec.js` launches two real Electron clients for editing/cursors/undo, split rename, disconnected merge, deletion and output. `split-editors-ui.spec.js` covers independent files, focus, save/run targets and model lifetime. Go collaboration/handler tests exercise real Git, restart recovery, authenticated sockets, actual child-process execution/input/cancellation and cleanup. These enter the existing Node, TypeScript, Electron core, Go and race CI without production credentials.

See [server protocol](../server/REALTIME.md) for exact wire messages and limits.
