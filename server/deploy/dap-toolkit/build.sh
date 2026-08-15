#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
bundle_version=1.0.0
go_proxy="${GOPROXY:-https://mirrors.aliyun.com/goproxy/,direct}"
js_debug_release_base="${JS_DEBUG_RELEASE_BASE:-https://ghfast.top/https://github.com/microsoft/vscode-js-debug/releases/download}"
apt_debian_mirror="${APT_DEBIAN_MIRROR:-http://mirrors.cloud.tencent.com/debian}"
apt_security_mirror="${APT_SECURITY_MIRROR:-http://mirrors.cloud.tencent.com/debian-security}"

build_candidate() {
  local dockerfile="$1"
  local base_image="$2"
  local candidate="$3"
  docker image rm -f "$candidate" >/dev/null 2>&1 || true
  docker build -f "$dockerfile" \
    --build-arg "BASE_IMAGE=$base_image" \
    --build-arg "GOPROXY=$go_proxy" \
	--build-arg "JS_DEBUG_RELEASE_BASE=$js_debug_release_base" \
	--build-arg "APT_DEBIAN_MIRROR=$apt_debian_mirror" \
	--build-arg "APT_SECURITY_MIRROR=$apt_security_mirror" \
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

for version in 20 22; do
  build_candidate Dockerfile.node "node:${version}-slim" \
    "bobocloud/dap-node:${version}-${bundle_version}-candidate"
done
