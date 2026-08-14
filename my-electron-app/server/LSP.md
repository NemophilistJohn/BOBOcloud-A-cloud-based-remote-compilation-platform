# Remote LSP

The remote LSP gateway runs at `/lsp` on both the HTTP API port and the
backward-compatible WebSocket port. New clients use port `3100`, so deployments
do not need to expose an additional public port for code intelligence. It uses
administrator-owned commands from `lsp_servers.json`; clients cannot send
an executable, image, working directory, or absolute path.

## Connection protocol

The first WebSocket text message must be:

```json
{
  "type": "lsp.start",
  "token": "session-or-api-token",
  "mode": "standard",
  "languageId": "rust",
  "runtimeId": "rust:stable",
  "workspace": {
    "kind": "team",
    "teamId": "team-id",
    "projectId": "project-id",
    "branch": "main"
  }
}
```

A personal workspace uses:

```json
{
  "kind": "personal",
  "folderName": "Visible name",
  "folderKey": "server-folder-key"
}
```

The server authenticates the token, verifies team membership, and resolves the
workspace internally. It replies with `lsp.ready` or `lsp.error`. After a
remote `lsp.ready`, the client sends standard JSON-RPC 2.0 `initialize`, then
`initialized`, before document messages. Server requests such as
`workspace/configuration` are passed through and must receive normal JSON-RPC
responses from the client.

Document URIs use `bobocloud-lsp:///` plus a workspace-relative POSIX path.
The gateway maps these to the authorized worktree and never exposes server
paths. Absolute, external, encoded traversal, and `..` URIs are rejected.

Control messages are `lsp.ping`, `lsp.stop`, and `lsp.cache.clear`. A connected
session may clear only its own analysis namespace; the analyzer is stopped and
its lease is released first, then the connection closes for a clean reconnect.

## Modes

- `local` starts no server process.
- `standard` permits open-document sync, completion/resolve, hover,
  definition, and diagnostics. Diagnostics for unopened documents are dropped.
- `full` additionally permits references, rename, workspace/document symbols,
  semantic tokens, implementation/type definition, inlay hints, code actions,
  and workspace diagnostics.

The gateway enforces the method policy even if an analyzer advertises more
capabilities.

## Analyzer manifest and Docker

`lsp_servers.example.json` is the versioned deployment contract. The dedicated
`bobocloud/lsp-toolkit:2026.08.11.2` image is the default remote analysis
environment and includes the configured language-server commands. Set the
same image in the active `lsp_servers.json` after it is built on the target
registry or host.

When `docker.image` is present it is used even when the project's compile
runtime is `local`. This keeps analysis independent from the host Linux
distribution. A runtime image is used only when the manifest has no dedicated
image and a Docker runtime was selected. Host execution is the final fallback
for `runtimeId: local` with no manifest image.

Only the standard `docker` CLI, bind mounts, and environment variables are
required. The container receives a read-only workspace, a writable dedicated
analysis cache, `network=none`, resource limits, dropped capabilities, and a
writable tmpfs. On Linux it runs with the server process UID:GID and
`HOME=/analysis-cache/home`, so non-root services retain ownership of cache
files while root deployments continue to use `0:0`.

On SELinux-enforcing hosts, label the configured data/worktree roots for
container access (or apply the deployment's equivalent bind-mount relabeling)
before enabling LSP. The gateway intentionally does not force Docker's `:z` or
`:Z` option because that changes host labels and is deployment-specific.

`command`, `standardCommand`, `fullCommand`, and their Docker equivalents are
manifest-owned arrays. `environment` is also administrator-owned.
`fingerprint` must change whenever the server binary, wrapper, or toolchain
changes; it participates in analysis cache isolation. JavaScript and TypeScript
are aliases of the `node` entry and use `typescript-language-server`.

## Cache model

Analysis indexes live only under `data/lsp-cache`. A cache key includes owner,
user, project/folder, branch, runtime, language, toolchain fingerprint, and a
bounded dependency-lock hash. Mode is deliberately excluded so standard and
full reuse the same analyzer index. Separate per-user writable indexes avoid
concurrent writers.

The server resolves a language-specific dependency view from personal or team
runtime storage. Only dependency content that the selected analyzer can consume
is mounted, always read-only and at fixed container paths. Writable analyzer
state remains under `/analysis-cache`; clearing LSP analysis data never deletes
build or dependency caches. Team dependency leases are non-exclusive and do not
hold a compiler target/build lock for the lifetime of the LSP session.

Analysis caches have a per-owner quota, retention-based LRU pruning, cached
size scans, active leases, and manual `all`, `project`, or `namespace` cleanup
through the authenticated HTTP actions `getLSPCacheInfo` and `clearLSPCache`.
Team-wide HTTP cleanup is restricted to the team administrator.

## Resource configuration

The relevant JSON fields are `lsp_enabled`, `lsp_manifest_path`,
`lsp_max_sessions`, `lsp_max_sessions_per_user`, `lsp_idle_ttl_seconds`,
`lsp_max_message_bytes`, `lsp_bandwidth_per_minute_bytes`,
`lsp_cache_quota_mb`, `lsp_cache_retention_days`, `lsp_memory_limit`, and
`lsp_cpu_limit`. Environment overrides are available for enablement, manifest,
session limits, cache quota, memory, and CPU. The checked-in server config uses
two global sessions, one per user, 512 MB, and 0.75 CPU to fit the current
small deployment host.
