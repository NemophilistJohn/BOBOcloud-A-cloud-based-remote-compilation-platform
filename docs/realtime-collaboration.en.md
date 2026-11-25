# Realtime collaboration and split editing

Desktop 2.9.0 and server 2.6.0 introduce optional native realtime team editing. These versions evolve independently. Ordinary Git collaboration remains available.

## Workflow

An administrator selects **Enable Collaboration** on a team project card. Live editing uses a clean, published branch. The server checks conflicts, member worktrees and active project consumers. Initial entry downloads a complete snapshot to a chosen local folder. Replacing a nonempty folder requires confirmation. A complete sibling staging directory is prepared before existing files move, with rollback on failure.

The split action in the editor's upper-right corner or `Ctrl+\` copies the current view to the right. Text panes share one file model and keep their own cursors and scrolling. Repeated plugin views show a preview that moves the original live view on click, preserving its draft. Select a different tab in either pane to show another file or plugin page. Pane focus determines save, run, outline and completion. Peer cursors display a small avatar and name. File tree avatars update when editing membership changes. Undo and redo affect the user's own operations. Save waits for durable server acknowledgement. Reconnection merges same-epoch edits and applies file additions, renames and deletions missed while offline.

Run a file or project task from the authoritative source snapshot while staying in the current panel. The team panel has an expandable history with status, time and retained output, plus shared input, stop, deletion votes, Git checkpoints and personal snapshots. A shared process survives its initiating window disconnecting. An administrator selects **Disable Collaboration** to return to Git. The server first commits and pushes the final canonical snapshot. Successful exit removes the live source, nodes and shared run history. Local mappings persist the live epoch so exit or offline reopen refreshes disk and open models from Git before ordinary synchronization resumes.

## Presence and deletion

A file that has been edited stays held while visible in any pane. Switching away starts a ten-second release period and switching back cancels it. Multiple files and sessions are supported. The desktop sends heartbeats every fifteen seconds. The server releases a session after sixty seconds without a message.

A deletion request captures current editor users, deduplicated across sessions, and blocks new opens. Existing editors can continue editing after consenting. The file is removed when every captured user has consented or released all their holdings. A veto, requester cancellation or 180-second timeout cancels the request. Directory requests include descendants.

## Scope and operations

- Project-local `realtime.json` persists canonical text/tree state, CRDT nodes/tombstones, epochs and bounded idempotency receipts before acknowledging mutations. Local and member cloud worktrees cannot overwrite it. File bodies load lazily after initial download; tree changes and presence broadcast globally.
- Automatic personal cloud backup pauses in live mode. An explicit personal snapshot publishes an independent, quota-checked copy, idempotent per revision. Later live edits do not overwrite that personal copy.
- Execution reuses the existing run/task engine, admission, queues, Docker pool and team cache policy. No permanent execution container is introduced. Existing team runs still do not mount personal project immutable dependency generations; this feature does not redesign dependency installation.
- One shared run per room, with shared stdout/stderr/status, stdin and cancellation. The latest run retains a 256-KiB tail for replay. Up to 12 archived runs retain up to 32 KiB of output each during live mode.
- LSP, DAP and environment inspection use separate canonical-source projections. Mode transitions stop the current window's old execution, sync and analysis services; blocking consumers in other windows must finish before switching.
- Legacy Git writes, upload/run routes and cloud terminals reject mutations in live mode. **Create version** is the explicit canonical Git checkpoint.
- This iteration collaborates on ordinary text. Notebooks open as JSON in live mode; document plugins do not independently save or execute shared notebooks. Normal-mode Notebook features remain available. External editors and unadapted plugins cannot publish local writes as shared operations.
- Limits: 4,096 entries, 16 MiB raw room data, 1 MiB baseline files, 128 KiB editable text; larger supported text and binaries remain read-only snapshots. Node limits are 200,000 per file and 500,000 per room; serialized state is capped at 64 MiB, with 128 sessions. A limit rejects new operations while preserving unresolved local drafts. Checkpointing and re-entering live mode can reseed nodes when appropriate.

Drafts live under Electron userData `collaboration-drafts/`, scoped to server/account/team/project/branch/local root. Deleted-file or old-epoch drafts never automatically overwrite new content; export recovered text through the team panel. User-approved discarded local files are not retained as long-term backups after successful replacement.

## Verification

`realtime-document.test.js` covers Unicode, convergence, selective undo and anchors. `realtime-service.test.js` blocks local materialization after an edit acknowledgement and verifies subsequent typing drains without another keystroke or save, guarding slow-disk queue races. `realtime-main.test.js` exercises real files, context fences, paths, scoped drafts and rollback. `realtime-ui.spec.js` launches two real Electron clients for editing/cursors/undo, split rename, disconnected merge, deletion and output. `split-editors-ui.spec.js` covers independent files, focus, save/run targets and model lifetime. Go collaboration/handler tests exercise real Git, restart recovery, authenticated sockets, actual child-process execution/input/cancellation and cleanup. These enter the existing Node, TypeScript, Electron core, Go and race CI without production credentials.

See [server protocol](../server/REALTIME.md) for exact wire messages and limits.
