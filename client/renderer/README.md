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
module is `src/file-icons.js`: it exports an injected service factory,
`compat/file-icons-adapter.js` registers the service, and legacy callers see the
same instance through `BOBO.fileIcons`. Follow that pattern one low-coupling
module at a time; do not move a feature and all of its consumers in one change.

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
