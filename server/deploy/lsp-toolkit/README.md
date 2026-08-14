# BOBOCloud LSP toolkit

This image contains the remote analysis tools used by the `standard` and
`full` LSP modes. It is deliberately separate from compiler runtime images:
the compiler can still be selected per project while every LSP session uses
one administrator-owned, versioned image.

## Version set

| Language | Server | Pinned version |
| --- | --- | --- |
| Rust | rust-analyzer | 2026-08-10.1 |
| Go | gopls | v0.23.0 |
| C / C++ | clangd | 19.1.7 |
| Java | Eclipse JDT LS / Temurin JRE | 1.60.0 / 21.0.12+8 |
| Python | Pyright | 1.1.411 |
| JavaScript / TypeScript | TypeScript Language Server / TypeScript | 5.3.0 / 6.0.3 |
| HTML / CSS / SCSS / Less / JSON | VS Code language servers extracted | 4.10.0 |
| YAML | YAML Language Server | 1.24.0 |
| Shell | Bash Language Server | 5.6.0 |

The image also includes Go 1.26.5, Rust/Cargo 1.97.1 with Rust standard-library
sources, Python 3, Git, and the C/C++ standard headers required by the analyzers.
GCC/G++ are present for cgo, Rust build scripts and proc-macro support.
These are analysis toolchains; the project's selected local or Docker compiler
remains authoritative for the final build.

The default base is the official `node:20-bookworm-slim` image pinned by digest,
so building and running only requires standard Docker on any Linux distribution.
Downloaded Go, Rust and Java artifacts are pinned by SHA-256. `package-lock.json`
pins the complete npm dependency graph. Debian's exact clangd package version is
requested explicitly during the build.

## Build and verify

```sh
cd /root/cloudeEditor/deploy/lsp-toolkit
chmod +x build.sh *.sh
./build.sh
```

The image tag defaults to `bobocloud/lsp-toolkit:2026.08.11.2`. Override it with
`BOBO_LSP_TOOLKIT_IMAGE` when intentionally publishing a new immutable version.
The verified linux/amd64 build is 2,305,132,447 bytes (2.31 GB decimal, about
2.15 GiB) including both Go and Rust analysis toolchains.
When the prior pinned toolkit image exists locally, `build.sh` uses
`Dockerfile.incremental` and only replaces the Node language-server layer. It
automatically falls back to the complete portable Dockerfile on a fresh host.
For the current server, the same digest can be obtained through its configured
regional mirror without changing the portable Dockerfile default:

```sh
BOBO_LSP_BASE_IMAGE='docker.m.daocloud.io/node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0' \
BOBO_LSP_GO_PROXY='https://goproxy.cn,direct' \
  ./build.sh
```

The health command is safe to run repeatedly and does not start daemons:

```sh
docker run --rm --network none bobocloud/lsp-toolkit:2026.08.11.2 \
  bobocloud-lsp-verify
```

`build.sh` also runs a protocol smoke test in an offline container. Go,
Python, Node/TypeScript and Maven fixtures exercise their resolver with a symbol
that exists only in the dependency view. Native analysis resolves a mounted
server-issued header. Python covers both `pyrightconfig.json` and
`[tool.pyright]`; TypeScript verifies the pinned tsserver reports source
`user-setting`. The Rust fixture verifies a mounted Cargo source path. The
Gradle fixture is deliberately labelled `mounted-classpath-only`: it proves
JDT LS can read an immutable snapshot artifact, but a publisher release must
separately run a real Gradle import against its produced `GRADLE_RO_DEP_CACHE`.

`lsp_servers.example.json` is the matching server manifest. The deployed
`lsp_servers.json` must use the same image tag and fingerprints.

## Runtime and cache contract

The Go service starts one container per active LSP session with no network and
no background daemon. It mounts:

- `/workspace` read-only for project source;
- `/analysis-cache` read-write for disposable, quota-managed analysis state;
- server-issued dependency subtrees read-only at fixed analyzer paths.

Do not bind the compiler target cache as `/analysis-cache`. Clearing LSP state
must never delete shared compiler dependencies. The Go service owns the LSP
quota and retention policy; the image only writes beneath the provided mount.
The image contains no pre-populated writable analysis cache. Docker's builder
cache is host-global: inspect it with `docker system df`, but do not automate
`docker builder prune` from this deployment because that could also evict cloud
compiler build layers. Reclaim it only as an explicit administrator operation.

`BOBO_LSP_MODE=standard` disables clangd's whole-project background index for
low latency and memory use. `BOBO_LSP_MODE=full` normalizes an existing
`compile_commands.json` (or creates a conservative fallback) under
`/analysis-cache/clangd/cdb`, so clangd can persist index shards without writing
to the source tree. Both modes prepare the same normalized compilation database.
Server-issued native fallback flags are passed as bounded JSON, validated again
inside the image, and injected into the generated or normalized
`compile_commands.json` before clangd starts.

Java analysis mounts an existing Maven repository read-only at
`/analysis-deps/java/maven-repository`, then uses a generated file-mirror
settings file to populate the session-private writable repository at
`/analysis-cache/maven/repository`. Gradle keeps its writable user home under
`/analysis-cache/gradle`. A producer copies `modules-2` into an immutable
`gradle/<runtime>/generations/<revision>` directory, marks that generation
ready, then atomically advances `.current`. Only the current private generation
is mounted at `/analysis-cache/gradle/read-only-dependencies/modules-2` and
exposed through `GRADLE_RO_DEP_CACHE`; a live Gradle user cache is never used.

Pyright uses `/usr/local/bin/bobocloud-python` as a server-owned interpreter.
The wrapper injects `BOBO_PYRIGHT_DEPENDENCY_PATHS`, so dependency search paths
survive project config precedence without modifying `pyrightconfig.json` or
`pyproject.toml`. TypeScript sessions merge the server-issued
`initializationOptions.tsserver.path` before forwarding `initialize`.

The image build smoke uses the same 512 MB / 0.75 CPU production limits. JDT LS uses a
384 MB maximum heap, Node language servers use a 384 MB heap, and gopls uses a
400 MiB soft memory limit. Only the selected language server runs in a session.

### Rust initialization policy

`rust-analyzer` configuration is supplied by the LSP client's `initialize`
request, not by command-line flags. The client must not rely on upstream
defaults on a memory-constrained host. Use this for `standard` mode (and for
the image smoke test):

```json
{
  "cachePriming": { "enable": false },
  "cargo": {
    "allTargets": false,
    "buildScripts": { "enable": false }
  },
  "checkOnSave": false,
  "procMacro": { "enable": false }
}
```

The current 512 MB deployment applies the same bounded initialization options
to `full` mode. Full still enables cross-file references, rename, symbols and
the other gateway methods, but it does not eagerly execute Cargo build scripts
or proc macros. Enabling those Rust features requires a deliberately larger
per-session memory limit and a matching client policy. The included Cargo,
rustc, GCC/G++ and Git binaries support them; build scripts and proc macros also
execute project code, so they should only be enabled for trusted workspaces.
