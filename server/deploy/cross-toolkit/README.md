# BOBOCLOUD Cross Toolchains

These images implement the server-side `buildTarget` catalog for C, C++, and
Rust. They are separate from normal runtime images because cross-built output
is returned as an artifact and is not executed in the Linux compile container.

```bash
cd /root/cloudeEditor/cross-toolkit
chmod +x build.sh verify.sh
./build.sh
./verify.sh
```

The catalog currently provides native Linux x86_64, Linux ARM64, Windows
x86_64 (GNU/MinGW) and Cortex-M4 bare-metal/RTOS. A Rust Cortex-M4 project
must provide its normal embedded `no_std` setup and linker configuration; the
smoke test validates target availability only.
