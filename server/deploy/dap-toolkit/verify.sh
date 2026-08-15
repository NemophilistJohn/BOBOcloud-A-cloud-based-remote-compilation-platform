#!/usr/bin/env bash
set -euo pipefail

bundle_version=1.0.0
declare -a candidates=()
declare -a finals=()

verify_candidate() {
  local language="$1"
  local candidate="$2"
  local final="$3"
  docker image inspect "$candidate" >/dev/null
  python3 dap-smoke.py --language "$language" --image "$candidate"
  candidates+=("$candidate")
  finals+=("$final")
}

for version in 3.9 3.10 3.11 3.12 3.13; do
  candidate="bobocloud/dap-python:${version}-${bundle_version}-candidate"
  final="bobocloud/dap-python:${version}-${bundle_version}"
  verify_candidate python "$candidate" "$final"
done
for version in 1.21 1.23; do
  candidate="bobocloud/dap-go:${version}-${bundle_version}-candidate"
  final="bobocloud/dap-go:${version}-${bundle_version}"
  verify_candidate go "$candidate" "$final"
done

for version in 20 22; do
  candidate="bobocloud/dap-node:${version}-${bundle_version}-candidate"
  final="bobocloud/dap-node:${version}-${bundle_version}"
  docker image inspect "$candidate" >/dev/null
  python3 node-dap-smoke.py --image "$candidate"
  candidates+=("$candidate")
  finals+=("$final")
done

# Final tags are an availability boundary. Do not update any of them unless
# every candidate passed a real breakpoint/stack/variables/continue smoke.
for index in "${!candidates[@]}"; do
  docker tag "${candidates[$index]}" "${finals[$index]}"
done
docker image rm -f "${candidates[@]}" >/dev/null
