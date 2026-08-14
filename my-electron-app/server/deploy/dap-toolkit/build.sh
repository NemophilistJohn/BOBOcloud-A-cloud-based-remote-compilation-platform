#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
bundle_version=1.0.0
go_proxy="${GOPROXY:-https://mirrors.aliyun.com/goproxy/,direct}"

build_candidate() {
  local dockerfile="$1"
  local base_image="$2"
  local candidate="$3"
  docker image rm -f "$candidate" >/dev/null 2>&1 || true
  docker build -f "$dockerfile" \
    --build-arg "BASE_IMAGE=$base_image" \
    --build-arg "GOPROXY=$go_proxy" \
    -t "$candidate" .
}

for version in 3.9 3.10 3.11 3.12 3.13; do
  build_candidate Dockerfile.python "python:${version}-slim" \
    "bobocloud/dap-python:${version}-${bundle_version}-candidate"
done

for version in 1.21 1.23; do
  build_candidate Dockerfile.delve "golang:${version}" \
    "bobocloud/dap-go:${version}-${bundle_version}-candidate"
done

# Node is intentionally excluded until the gateway supports js-debug child sessions.
