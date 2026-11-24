# Friends, inbox and project snapshots

## Team workspace and navigation

The sidebar contains Friends and Teams lists. A team's disclosure arrow expands
its project shortcuts (at most five visible rows with scrolling); clicking its
name opens an independent workbench tab with Members and Projects. Team tabs
use the shared tab ordering and close lifecycle. The bottom Team workbench is
retained for Git and workspace actions.

A mapped team workspace is identified by team ID, project ID and branch; it
does not need a personal folder key to prepare its private team worktree.
The earlier client required both and rejected valid mappings before HTTP.
Successful team uploads remain directed at that private worktree for execution
and Git. A separate personal mirror uses the normal personal quota preflight,
so a failed personal backup is reported without redirecting team execution.
Successful uploads alone record the public last-sync timestamp.

## Boundaries and storage

- Every enabled account on one server is discoverable. The directory returns
  only public UID, display name, avatar and optional last successful workspace
  sync time. A missing sync time is unknown, not online/offline presence.
- Inbox metadata uses the existing BoltDB in two versioned buckets; a focused
  `social.db` is used only by an embedder with no application database.
- Project offers capture a cloud personal workspace into one immutable,
  content-addressed ZIP in `DataDir/project-snapshots`. Sending identical
  content to several recipients references the same ZIP. No recipient project
  copy is created until that recipient explicitly chooses cloud acceptance.
- `.git`, `.bobocloud-team.json` and `.boboproject` are omitted from the
  snapshot so accepting a project does not inherit another user's Git/team
  mapping. Symlinks and nonregular files are rejected by snapshot capture.
- A cloud acceptance creates a new `received-{messageId}` personal workspace.
  It checks fresh personal disk usage under the existing user mutation lease.
  A durable import target recorded before publication makes retries idempotent.
  Existing recipient edits are preserved.
- Private `.inbox-import-{messageId}` partial directories are removed before
  listeners start, under user mutation fences. Completed personal workspaces
  and their import metadata are retained.

## API contract

All actions use the existing authenticated POST JSON envelope at `/`.

| Action | Input | Response `data` |
| --- | --- | --- |
| `listFriends` | none | Array of `{uid,name,avatar,lastSyncAt?}` |
| `listInbox` | none | `{pending: Message[], archived: Message[], unread: number}` |
| `sendInbox` | `recipientId` (public UID), `kind`, plus `projectKey`, `teamId` or `note` | Created public message |
| `respondInbox` | `messageId`, `decision` | Updated public message; cloud acceptance also returns `projectKey` |
| `deleteInbox` | `messageId` | Permanently removes the current recipient's archived message; repeated deletion succeeds. Pending offers return a conflict. |
| `recordWorkspaceSync` | none | Success after a completed workspace sync; throttled to one stored stamp per 30 seconds |

Message kinds are `project`, `invite`, `note`. Decisions are `read`, `reject`,
`cloud`, `local`, `invite`. Only the recipient can list, read, decide or
download an offer. Directed team acceptance rechecks the inviter's current
team administration authority and account status; it creates no reusable
invitation code.

The recipient downloads a pending project at authenticated
`GET /inbox/project/{messageId}`, which streams the existing ZIP and does not
archive the message. After successful local extraction the native client
acknowledges with `respondInbox`, decision `local`.
The native client chooses a destination using the operating system picker and
extracts with bounded file counts, sizes, paths and checksum validation. Its ZIP
temporary file exists on the receiving computer, never once per recipient on
the server. An acknowledgement retry during the same app session reuses the
successful local receipt without another download or duplicate folder.

## Retention and bounds

- Project and invitation offers are actionable for 72 hours.
- A decided offer is archived for seven days from its decision. An expired
  offer is archived for seven days from its original deadline, even if cleanup
  runs late. A note enters the archive when read.
- Each recipient can retain 100 pending and 300 total messages; one sender can
  have at most 20 pending messages in that recipient's inbox. Duplicate pending
  invitations for the same team are rejected.
- Snapshot capture accepts at most 1 GiB and 20,000 entries per project.
- Capture, import and download reuse central resource admission without Docker;
  capture/import are bounded to two minutes and download writes to two minutes.
- Every ten minutes a managed maintenance task expires metadata and deletes
  snapshot ZIPs with no pending references. Active capture/read/extract leases
  prevent deletion of in-use archives.

## Server configuration

Both values are positive byte counts. Existing configurations inherit defaults;
explicit zero, negative values, invalid integers and overflow fail validation.

| JSON key | Environment variable | Default |
| --- | --- | --- |
| `project_snapshot_capacity_bytes` | `BOBOCLOUD_PROJECT_SNAPSHOT_CAPACITY_BYTES` | 2,147,483,648 (2 GiB) |
| `project_snapshot_reserve_bytes` | `BOBOCLOUD_PROJECT_SNAPSHOT_RESERVE_BYTES` | 1,073,741,824 (1 GiB) |

Capacity bounds retained ZIP archive bytes globally. Reserve is the minimum
free space kept on the target filesystem during archive creation or cloud
extraction. Personal disk quota still applies to the accepted project.

## Regression coverage

`internal/social` tests persistence/reopen, recipient isolation, exact expiry,
archive retention, read/decision semantics, duplicate invites and inbox limits.
`internal/handler/social_test.go` exercises authenticated HTTP directory,
immutable shared snapshots, local download acknowledgement, quota enforcement,
idempotent/recovered cloud imports, Unicode note limits, invitation authority
and crash-partial recovery.
