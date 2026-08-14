#!/bin/sh
set -eu

cache_root="${BOBO_LSP_CACHE_DIR:-/analysis-cache}/clangd"
workspace="${BOBO_LSP_WORKSPACE:-/workspace}"
mkdir -p "$cache_root"

flags_file="$cache_root/fallback-flags"
node /opt/bobocloud/clangd-flags.js "$flags_file"

set -- \
  --clang-tidy=false \
  --completion-style=detailed \
  --header-insertion=never \
  --limit-results=100 \
  --limit-references=1000 \
  --log=error

if cdb_dir="$(node /opt/bobocloud/prepare-clangd-cdb.js "$workspace" "$cache_root" "$flags_file")" && [ -n "$cdb_dir" ]; then
  set -- "$@" "--compile-commands-dir=$cdb_dir"
fi

if [ "${BOBO_LSP_MODE:-standard}" = "full" ]; then
  set -- "$@" --background-index --background-index-priority=low
else
  set -- "$@" --background-index=false
fi

exec /usr/bin/clangd-19 "$@"
