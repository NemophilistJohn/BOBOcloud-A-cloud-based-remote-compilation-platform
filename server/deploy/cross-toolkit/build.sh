#!/usr/bin/env bash
set -euo pipefail

# Build exactly the image tags referenced by model.CrossBuildImage. Keep this
# script beside the Dockerfiles so an operator can audit image contents before
# enabling a target on a production server.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for version in 11 13; do
  docker build --build-arg "GCC_VERSION=${version}" -f "${ROOT}/Dockerfile.gcc" -t "bobocloud-cross-gcc:${version}" "${ROOT}"
done
for version in 1.75 1.82; do
  docker build --build-arg "RUST_VERSION=${version}" -f "${ROOT}/Dockerfile.rust" -t "bobocloud-cross-rust:${version}" "${ROOT}"
done

echo "Cross-toolchain images built. Run ${ROOT}/verify.sh before enabling production traffic."
