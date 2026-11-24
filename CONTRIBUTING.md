# Contributing to BOBOCLOUD

[简体中文](CONTRIBUTING.zh-CN.md) · [README](README.md)

Contributions can improve user experience, language adapters, accessibility/localization, documentation, tests, deployment, or plugins. Start with a reproducible problem and the smallest owning boundary. Optional product behavior often belongs in a plugin; reusable, validated capabilities belong in the host.

## Start locally

Use Node.js 22 and the Go version declared by [server/go.mod](server/go.mod) (currently 1.25). Install client dependencies with `npm ci --prefix client`; run `npm start` for the desktop. Editing and most tests need no production account. Use a test profile and your own service for live experiments.

Read applicable `AGENTS.md` instructions and inspect `git status` before editing. Preserve unrelated changes. Do not deploy to an operator's server, modify a real account, install dependencies in somebody else's project, or publish a plugin as part of an ordinary test run.

## Find the owning module

| Change | Start here |
| --- | --- |
| Editor interaction and completion | `client/src/`, `client/editor-rules/`, `client/completion-rules.ts`. |
| Renderer services, startup, disposal, extension boundary | `client/renderer/`, `client/types/`. |
| Desktop files, credentials, processes, transport, approvals | `client/main/`, then the explicit `client/preload.js` contract. |
| Cloud API or lifecycle | `server/internal/handler/`; keep `server/cmd/bobocloud/main.go` composition-focused. |
| Dependency transactions and cache ownership | `server/internal/packageops/`, `personalcache/`, `cachev2/`, corresponding client main controllers. |
| Fair admission and resource accounting | `resourcecontrol/`, `resourcegovernor/`, `hostresource/`. |
| Language intelligence or debugging | Separate `server/internal/lsp/` and `dap/` owners. |
| Installable extension | [Plugin quick start](docs/plugin-quickstart.en.md), [SDK](client/plugin-sdk/bobocloud-plugin.d.ts), independent plugin repository. |

Generated `client/renderer-dist/` bundles are build output. Edit their source and rebuild. `window.BOBO` is a host compatibility projection, not a plugin API. New privileged renderer calls should use a narrow private host port through the native adapter, not another direct preload-global caller.

## Protect correctness during asynchronous work

Bind work to server, account, workspace identity, revision, and operation/session generation. Reject late results after a boundary changes. For each long-running workflow define what happens on cancel, close, sign-out, server change, and workspace switch. A cancelled promise is not proof that its process, container, mount, or lease has been cleaned up.

Published dependency generations are immutable. Never repair them by writing into mounted package trees or deleting only catalog rows/directories. Run, LSP, and DAP may independently lease the same generation; their mutable state stays separate. Build-artifact reuse must still execute the program.

Do not turn input into shell text. Validate structured paths, arguments, URLs, JSON messages, and permissions at the authority that owns them. Do not widen container privileges or disable TLS checks merely to make a test pass.

## Choose validation that matches the change

| Area | Useful local checks |
| --- | --- |
| Pure client logic | `node --test client/tests/<affected>.test.js`. |
| Renderer contracts | `npm run typecheck`, `npm run build:renderer`. |
| Editor/LSP interaction | `npm --prefix client run test:ui:lsp`. |
| Broader workbench interaction | `npm run test:ui`; use the corresponding spec while iterating. |
| Package Center transactions | `npm --prefix client run test:ui:packages`. |
| Cloud logic | `go -C server test ./...`, `go -C server vet ./...`. |
| Shared lifecycle/cache/resource state | Relevant `go -C server test -race ./internal/<package>` plus the ordinary suite. |
| Test ownership | `node scripts/ci/verify-test-routing.mjs`. |
| Documentation | Validate relative links, fenced examples, Mermaid syntax, bilingual parity, and rendered screenshots. |

Root `npm test` runs the client Node suite, not Go. Run renderer builds serially on Windows. Real Electron tests use isolated profiles; mock transport tests do not replace TLS or live-deployment checks. An ordinary new hermetic UI spec enters the core lane automatically; artifact-dependent, platform-specific, privileged, or nested-module tests need explicit routing.

Keep the GitHub workflow read-only toward services/accounts. The stable **CI Gate** aggregates client contracts, UI shards, packages, plugin compatibility, packaged app, Go/race, privileged mounts, toolkit contracts, and Windows release preflight. New failures need an explanation or fix, not a hidden skip.

## Localization and documentation

User-visible or accessible core strings must extend English, Simplified Chinese, and Japanese packs. Plugin-owned strings belong in plugin-owned packs. Check placeholder parity and actual layout at narrow widths.

Keep [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md), and paired `.en.md`/`.zh-CN.md` guides, semantically aligned. Describe shipped behavior using current code/tests, separate examples from measurements, and label fixture images. Do not publish a profile, source from an unrelated project, service keys, tokens, local private paths, or account history unrelated to a demonstration. See [media provenance](docs/media/README.md).

## A useful issue or pull request

An issue should give versions, OS, language/runtime, a minimal project, expected/actual behavior, exact steps, and sanitized output/run ID where relevant. Distinguish local logic, controlled UI, live service, and deployment observations.

A PR should lead with the user-visible trigger and resulting behavior, name meaningful boundaries changed, list validation actually run, and state remaining limitations. Prefer a focused change over unrelated cleanup. If a feature changes a public contract, update the validator, broker, preload/transport, renderer, SDK, docs, and relevant tests together.

The repository [LICENSE](LICENSE) is Apache-2.0. Preserve third-party notices and review licenses before redistributing dependencies, images, fonts, or recorded assets.
