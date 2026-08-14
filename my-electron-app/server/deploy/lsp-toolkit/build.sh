#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image="${BOBO_LSP_TOOLKIT_IMAGE:-bobocloud/lsp-toolkit:2026.08.11.2}"
base_image="${BOBO_LSP_BASE_IMAGE:-node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0}"
go_proxy="${BOBO_LSP_GO_PROXY:-https://proxy.golang.org,direct}"
toolkit_base="${BOBO_LSP_TOOLKIT_BASE_IMAGE:-bobocloud/lsp-toolkit:2026.08.11.1}"
smoke_cache=$(mktemp -d "${TMPDIR:-/tmp}/bobocloud-lsp-smoke.XXXXXX")
trap 'rm -rf -- "$smoke_cache"' EXIT HUP INT TERM

if [ -f "$script_dir/Dockerfile.incremental" ] && docker image inspect "$toolkit_base" >/dev/null 2>&1; then
  docker build --pull=false \
    --file "$script_dir/Dockerfile.incremental" \
    --build-arg "NODE_BASE_IMAGE=$base_image" \
    --build-arg "TOOLKIT_BASE_IMAGE=$toolkit_base" \
    --tag "$image" "$script_dir"
else
  docker build --pull=false \
    --build-arg "BASE_IMAGE=$base_image" \
    --build-arg "GO_PROXY=$go_proxy" \
    --tag "$image" "$script_dir"
fi
docker run --rm --network none "$image" bobocloud-lsp-verify
docker run --rm --network none --memory 512m --cpus 0.75 \
  -v "$smoke_cache:/analysis-cache:rw" \
  "$image" bobocloud-lsp-smoke
docker image inspect "$image" --format 'image={{.RepoTags}} id={{.Id}} size_bytes={{.Size}}'
