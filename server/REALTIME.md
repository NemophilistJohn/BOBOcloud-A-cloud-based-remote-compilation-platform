# Native team collaboration protocol

The optional mode is project-wide and pinned to one Git branch. `realtime.json`
under the team project directory is authoritative. Member worktrees and local
folders never overwrite it. Administrators can enable/disable the mode after
active project work stops. Enabling requires clean member worktrees on the
chosen branch and no unpublished commits. A fresh clone supplies the baseline;
ignored local dependency directories are excluded. Disabling commits and pushes
the canonical room through a fresh clone before publishing the new mode epoch.
Each transition rotates member worktree paths, quarantining old SFTP grants.
After the final Git export, disabling removes canonical files, CRDT nodes,
request receipts, and run replay from durable room state; only mode metadata is
retained.

Server 2.6.1 excludes the reserved root `.bobocloud-team.json` mapping from
baseline validation and seeding. A stale checkout may contain an untracked
regular file already present in the chosen canonical branch: only identical
bytes and executable permissions are accepted. Tracked modifications, merge
conflicts, genuinely new/unmatched files and unpublished commits still block
entry. Validation never resets or cleans member copies. Dirty-baseline errors
use HTTP 409, `errorCode: realtime_baseline_dirty` and bounded
`details.baseline` member/branch/path diagnostics.

HTTP actions use the normal authenticated action envelope:

- `getRealtimeState {teamId,projectId}` returns a file manifest and room state.
- `getRealtimeSnapshot {teamId,projectId,epoch}` returns canonical file contents,
  with `base64` for binary/read-only files and no CRDT nodes.
  It also accepts a disabled room's **current** epoch: under resource admission
  and a project activity lease, a temporary fresh clone reconstructs the stored
  branch, then is removed. This response has `enabled:false` and does not
  repersist source. Clients must fetch the current epoch and replace their local
  mapping with this final snapshot before resuming ordinary upload/sync, including
  after an offline mode exit or application restart. Older epochs remain invalid.
- `setRealtimeMode {teamId,projectId,branch,epoch,enabled}` is administrator-only.
  The first epoch is the empty string; later requests require the current epoch.
- `snapshotRealtimePersonal {teamId,projectId,epoch}` manually publishes an
  independent personal cloud workspace after a fresh quota check. Its receipt
  contains `projectKey`, `folderKey`, `folderName`, and `revision`. Retries for a
  revision never overwrite personal changes to an already published copy.
- `createRealtimeVersion {teamId,projectId,epoch,commitMessage}` checkpoints the
  current canonical revision to Git without leaving collaboration. Any member
  can create a version, matching the existing team commit permission.

Connect to `/collaboration` on either HTTP or WebSocket listener. The first
frame, within fifteen seconds, is
`{type:"join",token,teamId,projectId,epoch,sessionId}`. Credentials are never URL
parameters. A session ID is a stable client actor identifier; a reconnect
replaces only the same authenticated user's previous transport. Replies and
broadcasts use these shapes:

```text
state     {type, state:{enabled,epoch,branch,revision,files,presence,deletions,run?}}
document  {type, requestId, file:{id,path,revision,content,nodes,binary?,base64?}}
operation {type, requestId, fileId, revision, insert, delete}
presence  {type, presence, deletions}
ack       {type, requestId, revision?}
error     {type, requestId?, code, message}
runEvent  {type, runId, event:<existing run WebSocket message>}
```

Every operation carries the current opaque `epoch` and an optional bounded
`requestId`. Durable mutation receipts are retained across restart for the most
recent 4,096 requests. The file manifest omits content/nodes. `open {fileId}`
loads a document. `close` acknowledges subscription disposal; active editor
ownership is determined by the full presence pane set, not open-tab count.

`edit {fileId,insert:[{id,after,value}],delete:[id]}` uses a replicated growable
array of Unicode scalar nodes. The virtual root ID is `""`. Each value contains
one scalar. Siblings are ordered by ID **descending**, then visited depth-first.
Client IDs are `clock(16 decimal digits):sessionId:counter(8 decimal digits)`;
seed IDs are `0000000000000000:base:index(8 decimal digits)`. Clients advance
their Lamport clock from received nodes before creating a new insertion. Parents
must exist in the document or earlier in the same atomic batch. Reusing an ID
with different content is rejected. Deletion tombstones are retained within an
epoch; epoch changes permit reseeding. Stale epochs and deleted document IDs
never resurrect files. The client owns durable unresolved drafts.

Tree operations are `create {path,content,directory?}`, `rename {fileId,path}`,
`deleteRequest {fileId}`, and `deleteVote {deleteId,decision}` where decision is
`consent`, `veto`, or requester-only `cancel`. Deletion captures editor **users**,
deduplicated across panes and transports. Pending deletion blocks new opens;
existing editors can continue editing after consenting. All captured users must
consent or release editing. A veto or 180-second expiry cancels the request.
Directory operations cover their descendants.
Create and rename destinations require every parent directory to exist as an
explicit tree entry. Create missing directories first with `create {directory:true}`.

`presence {panes:[{paneId,fileId,editing,cursor?:{anchor,focus}}]}` replaces a
session's active panes. Cursor anchors/focus are CRDT IDs and are ephemeral.
Switching away retains edited-file ownership for ten seconds (`held` expiry
map). The client heartbeats every twenty seconds; sixty seconds without an app
message removes all that session's panes/holds. A transport disconnect alone
does not immediately revoke editing or stop a shared run.

`run {run:{filePath,runtime,folderKey?,folderName?,compileArgs?,runArgs?,
setupCommands?,buildTarget?,task?}}` starts one shared room run. The exact source
generation is captured at acceptance and materialized after normal resource
admission. Existing runners, execution budgets, cache mounts, dependency policy,
and Docker isolation are reused. Any current member can send `stdin {data}` or
`cancelRun`. `run.events` replays a bounded 256-KiB tail, with `omitted:true` when
earlier events were dropped. Live events use the existing status/stdout/stderr/
artifact/result schema. A restarted server reports an unfinished run as
`interrupted`, clears old deletion ballots, and preserves acknowledged edits.

LSP, DAP, and environment inspection receive separate member-owned source
snapshots. Their writes cannot mutate canonical text. Existing terminal and
legacy Git/upload/run mutation routes are rejected in shared mode. Package and
dependency policy remains the existing team execution policy.

Bounds: 4,096 tree entries, 16 MiB raw room contents, 1 MiB individual baseline
files, 128 KiB editable text, 500,000 room nodes, 200,000 nodes per edited file,
64 MiB serialized state, 32 panes/session, 128 connected sessions/room, 128
queued events/transport, 4 MiB unauthenticated join frames, and 64 MiB
authenticated frames. Larger supported baseline
files are preserved as read-only binary/base64 snapshots. Paths reject traversal,
links, Git internals, Windows reserved names, and the local team mapping file.
Slow consumers are disconnected and recover from canonical state.
