# Automatic releases

The `Automatic Release` workflow evaluates the latest `main` commit after a
successful **push** run of the `CI` workflow. It publishes a prerelease only
when both the client and server have changed since the last successful
automatic release. Test-only changes and Markdown documentation do not count.
Changes can accumulate over multiple commits. On first use, the most recent
published stable GitHub Release is the baseline; its tag must be an ancestor
of `main`. Subsequent baselines are automatically published releases, whose
source marker must agree with the release tag.

Each release contains unsigned Windows x64/ARM64 installer and portable
executables; Linux x64/ARM64 AppImage, DEB and RPM packages; and Linux server
amd64/arm64 raw binaries plus separate binary-only and default-configuration
archives. `SHA256SUMS.txt` covers every asset. Packages are built from the
same CI-verified commit and are not server deployments. The server configuration
is generated from `config.Default()`, not copied from a working machine.

The workflow checks the current main commit and baseline again before creating
a draft and before publishing it. Failed or superseded runs cannot create a
public partial release; an incomplete draft may remain for investigation. A
verified Git tag may also remain if publication fails after tag creation. A
scheduled retry recovers from overlapping CI completions. GitHub Actions may
replace an older pending concurrency run, but each run evaluates the newest
main commit. If main has advanced without a successful push CI run, publishing
waits for that CI run. PR runs never publish.
Pull requests touching release machinery run the same packaging matrix as a
read-only preview, using the PR head without publishing or deployment access.

Maintainers may manually run `Automatic Release` with `force` enabled for an
emergency when only one component changed. This still requires a successful
push CI run for the exact current main commit, a new commit since the last
release, and the complete artifact matrix. No signing credentials are required.
The automatic versions use the client package's numeric version plus the
GitHub run ID and attempt (for example `2.8.1-ci.12345.1`). The installed
application retains the stable numeric version from `client/package.json`
(such as `2.8.1`) so existing plugin engine ranges continue to match. Identify
the exact build using the release tag and recorded commit. These are GitHub
prereleases and do not replace the stable `Latest` release.

The x64 packages target 64-bit x86 (`amd64`); 32-bit x86 and ARMv7 are not
advertised or built. macOS is intentionally excluded. The workflow only uploads
release artifacts; it does not connect to or modify any server.
The `ssh2` optional native acceleration and CPU-detection modules are omitted
from packaged applications; its supported JavaScript fallback avoids shipping
an addon built for the runner architecture in a cross-architecture package.
Linux ARM64 is cross-packaged on an x64 runner because the pinned
electron-builder DEB/RPM tool is an x86 executable. Its Electron binary is
checked for the target ELF architecture; native ARM hardware runtime testing is
separate.
