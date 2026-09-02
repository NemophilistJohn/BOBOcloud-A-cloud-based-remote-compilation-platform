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

`core/native-host-adapter.ts` is the only new-code entrypoint to the preload
bridge. It projects narrow, host-only domain services into the service registry;
feature modules consume those services through injection. The rclone renderer
facade is the first TypeScript vertical slice using this boundary, while
`compat/rclone-client-adapter.ts` preserves the existing `BOBO.rclone` contract.
The direct-access contract test ratchets the remaining JavaScript callers down
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
