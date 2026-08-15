#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

cat >"${TMP}/main.c" <<'EOF'
int main(void) { return 0; }
EOF
cat >"${TMP}/main.cpp" <<'EOF'
int main() { return 0; }
EOF
cat >"${TMP}/main.rs" <<'EOF'
fn main() {}
EOF
cat >"${TMP}/bare.rs" <<'EOF'
#![no_std]
#![no_main]
use core::panic::PanicInfo;
#[panic_handler] fn panic(_: &PanicInfo) -> ! { loop {} }
#[no_mangle] pub extern "C" fn Reset() -> ! { loop {} }
EOF

for version in 11 13; do
  image="bobocloud-cross-gcc:${version}"
  docker image inspect "${image}" >/dev/null
  docker run --rm -v "${TMP}:/workspace" "${image}" sh -ec '
    aarch64-linux-gnu-gcc /workspace/main.c -o /workspace/c-linux-arm64
    x86_64-w64-mingw32-gcc /workspace/main.c -o /workspace/c-windows-x86_64.exe
    arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -specs=nosys.specs /workspace/main.c -o /workspace/c-cortex-m4.elf
    aarch64-linux-gnu-g++ /workspace/main.cpp -o /workspace/cpp-linux-arm64
    test -s /workspace/c-linux-arm64 && test -s /workspace/c-windows-x86_64.exe && test -s /workspace/c-cortex-m4.elf && test -s /workspace/cpp-linux-arm64
  '
done

for version in 1.75 1.82; do
  image="bobocloud-cross-rust:${version}"
  docker image inspect "${image}" >/dev/null
  docker run --rm -v "${TMP}:/workspace" "${image}" sh -ec '
    rustc --target aarch64-unknown-linux-gnu -C linker=aarch64-linux-gnu-gcc /workspace/main.rs -o /workspace/rust-linux-arm64
    rustc --target x86_64-pc-windows-gnu -C linker=x86_64-w64-mingw32-gcc /workspace/main.rs -o /workspace/rust-windows-x86_64.exe
    rustc --target thumbv7em-none-eabihf -C linker=rust-lld --emit=obj /workspace/bare.rs -o /workspace/rust-cortex-m4.o
    test -s /workspace/rust-linux-arm64 && test -s /workspace/rust-windows-x86_64.exe && test -s /workspace/rust-cortex-m4.o
  '
done

echo "Cross-toolchain smoke checks passed."
