[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('production-81.70.51.43')]
    [string]$Target,

    [Parameter(Mandatory = $true, ParameterSetName = 'ExistingBinary')]
    [ValidateNotNullOrEmpty()]
    [string]$BinaryPath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Build')]
    [switch]$Build,

    [switch]$Apply,

    [string]$ConfirmTarget,

    [ValidateSet('http', 'https')]
    [string]$Transport = 'https',

    [ValidatePattern('\A/[A-Za-z0-9._/@+=:,%-]+\z')]
    [string]$RemoteCAFile,

    [ValidatePattern('\A[A-Za-z0-9.-]+\z')]
    [string]$ProbeHost,

    [switch]$AllowInteractiveAuthentication
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Keep production destinations in a closed list. Adding a new host requires a
# reviewed source change instead of accepting an arbitrary command-line host.
$DeploymentProfiles = @{
    'production-81.70.51.43' = [pscustomobject]@{
        Host        = '81.70.51.43'
        User        = 'root'
        RemoteRoot  = '/root/cloudeEditor'
        ServiceName = 'bobocloud.service'
        HTTPPort    = 3100
        ServiceUser = 'bobocloud'
        ServiceGroup = 'bobocloud'
        DockerGroup = 'docker'
        DataRoot    = '/root/cloudeEditor/data'
        WorkspaceRoot = '/shareOnling'
        ServerRoot = '/shareOnling'
        TLSRoot     = '/etc/bobocloud/tls'
        TLSCertFile = '/etc/bobocloud/tls/bobocloud.crt'
        TLSKeyFile  = '/etc/bobocloud/tls/bobocloud.key'
        EnvironmentFile = '/etc/bobocloud/bobocloud.env'
        RequireTLS  = $true
    }
}

function Get-NativeCommandPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $commands = @(Get-Command -Name $Name -CommandType Application -ErrorAction Stop)
    if ($commands.Count -eq 0) {
        throw "Native command was not found: $Name"
    }
    $resolved = [string]$commands[0].Source
    if ([string]::IsNullOrWhiteSpace($resolved) -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Native command did not resolve to an executable file: $Name"
    }
    return $resolved
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter()]
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

function Restore-ProcessEnvironment {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$OriginalValues
    )

    foreach ($name in $OriginalValues.Keys) {
        $value = $OriginalValues[$name]
        if ($null -eq $value) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        } else {
            Set-Item -LiteralPath "Env:$name" -Value $value
        }
    }
}

function Invoke-LocalLinuxAmd64Build {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerRoot
    )

    $goPath = Get-NativeCommandPath -Name 'go'
    $releaseDir = Join-Path -Path $ServerRoot -ChildPath 'release'
    $outputPath = Join-Path -Path $releaseDir -ChildPath 'bobocloud-server-linux-amd64'
    $releaseEntry = Get-Item -LiteralPath $releaseDir -Force -ErrorAction SilentlyContinue
    if ($null -ne $releaseEntry) {
        if (-not $releaseEntry.PSIsContainer -or -not [string]::IsNullOrWhiteSpace([string]$releaseEntry.LinkType)) {
            throw "Refusing to use a release path that is not a real directory: $releaseDir"
        }
    } else {
        New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
    }

    # A release directory must never become a local archive of deployable
    # server binaries. Resolve each exact target before deleting it so this
    # cleanup cannot escape the release directory.
    $releaseRoot = (Resolve-Path -LiteralPath $releaseDir).Path
    $releasePrefix = [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $previousArtifacts = Get-ChildItem -LiteralPath $releaseRoot -Force | Where-Object {
        $_.Name -match '^bobocloud-server'
    }
    foreach ($previousArtifact in $previousArtifacts) {
        $candidatePath = [System.IO.Path]::GetFullPath($previousArtifact.FullName)
        if (-not $candidatePath.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a server artifact outside the release directory: $candidatePath"
        }
        if ($previousArtifact.PSIsContainer -and [string]::IsNullOrWhiteSpace([string]$previousArtifact.LinkType)) {
            throw "Refusing to remove a release directory: $candidatePath"
        }
        # Use the lexical path so a symbolic link is removed rather than
        # resolving and deleting its target outside the release directory.
        Remove-Item -LiteralPath $candidatePath -Force
    }

    $originalValues = @{}
    foreach ($name in @('GOOS', 'GOARCH', 'CGO_ENABLED', 'GOCACHE')) {
        $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }

    $locationPushed = $false
    try {
        Push-Location -LiteralPath $ServerRoot
        $locationPushed = $true
        $env:GOOS = 'linux'
        $env:GOARCH = 'amd64'
        $env:CGO_ENABLED = '0'
        if ([string]::IsNullOrWhiteSpace($env:GOCACHE)) {
            $env:GOCACHE = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath 'bobocloud-go-cache'
            New-Item -ItemType Directory -Path $env:GOCACHE -Force | Out-Null
        }

        Invoke-NativeCommand -FilePath $goPath -Arguments @(
            'build',
            '-trimpath',
            '-buildvcs=false',
            '-o', $outputPath,
            './cmd/bobocloud'
        )
    } finally {
        if ($locationPushed) {
            Pop-Location
        }
        Restore-ProcessEnvironment -OriginalValues $originalValues
    }

    if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
        throw "Cross-compilation did not create $outputPath"
    }

    return (Resolve-Path -LiteralPath $outputPath).Path
}

function Test-LinuxAmd64ELF {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Binary does not exist: $Path"
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 20) {
        throw "Binary is too small to be an ELF executable: $Path"
    }
    if ($bytes[0] -ne 0x7f -or $bytes[1] -ne [byte][char]'E' -or $bytes[2] -ne [byte][char]'L' -or $bytes[3] -ne [byte][char]'F') {
        throw "Expected a Linux ELF executable, received: $Path"
    }
    if ($bytes[4] -ne 2 -or $bytes[5] -ne 1) {
        throw "Expected a 64-bit little-endian ELF executable: $Path"
    }

    $machine = [int]$bytes[18] -bor ([int]$bytes[19] -shl 8)
    if ($machine -ne 62) {
        throw "Expected an x86_64 Linux executable, received ELF machine ${machine}: $Path"
    }
}

function ConvertTo-PosixShellCommand {
    param(
        [AllowEmptyString()]
        [string]$Command
    )

    if ($null -eq $Command) {
        return ''
    }
    # PowerShell source files are commonly checked out with CRLF. OpenSSH
    # forwards the command argument byte-for-byte, while POSIX shells treat a
    # trailing CR as part of the preceding token (for example `set -eu` or a
    # path assignment). Normalize at the single remote-command boundary.
    return $Command.Replace("`r`n", "`n").Replace("`r", "`n")
}

function ConvertTo-PosixShellLiteral {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    if ($null -eq $Value) {
        return "''"
    }
    # Single-quoted POSIX shell literals treat every byte literally. A literal
    # apostrophe is represented by closing the quote, emitting an escaped
    # apostrophe, and reopening the quote. Keep this helper even for values
    # currently constrained by ValidatePattern so future template parameters
    # cannot accidentally become shell syntax.
    $escapedApostrophe = "'" + [char]92 + "''"
    return "'" + $Value.Replace("'", $escapedApostrophe) + "'"
}

function Get-RemotePrepareCommand {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Profile
    )

	$template = @'
set -eu
umask 077
root="__ROOT__"
service_user="__SERVICE_USER__"
service_group="__SERVICE_GROUP__"
docker_group="__DOCKER_GROUP__"
data_root="__DATA_ROOT__"
workspace_root="__WORKSPACE_ROOT__"
tls_source="$root/tls"
tls_root="__TLS_ROOT__"
tls_cert="__TLS_CERT__"
tls_key="__TLS_KEY__"
environment_file="__ENVIRONMENT_FILE__"

command -v install >/dev/null 2>&1
command -v getent >/dev/null 2>&1
command -v useradd >/dev/null 2>&1
command -v groupadd >/dev/null 2>&1
command -v usermod >/dev/null 2>&1
command -v runuser >/dev/null 2>&1
command -v stat >/dev/null 2>&1
command -v flock >/dev/null 2>&1

test -d "$root"
test ! -L "$root"
test -d "$root/tls"
test ! -L "$root/tls"

# Serialize each provisioning/release phase. The release phase reacquires the
# same lock before stopping systemd, so concurrent replacements cannot overlap;
# content-addressed uploads may safely happen between the two phases.
install -d -o root -g root -m 0700 "$root/.deploy"
test ! -L "$root/.deploy"
exec 9>"$root/.deploy/bobocloud-release.lock"
if ! flock -n 9; then
  echo "Another BOBOCLOUD release is already in progress." >&2
  exit 75
fi
find "$root/.deploy" -maxdepth 1 -type f \( -name 'bobocloud-server-*.tmp' -o -name 'bobocloud.service-*.tmp.service' \) -mmin +1440 -delete

# Create a locked-down service identity. It receives no shell and no host
# capabilities except the explicit Docker group needed by the CLI.
if ! getent group "$service_group" >/dev/null 2>&1; then
  groupadd --system "$service_group"
fi
test "$(getent group "$service_group" | cut -d: -f3)" != 0
if ! id -u "$service_user" >/dev/null 2>&1; then
  useradd --system --gid "$service_group" --home-dir "$data_root" --shell /usr/sbin/nologin "$service_user"
else
  usermod --gid "$service_group" --shell /usr/sbin/nologin "$service_user"
fi
test "$(id -u "$service_user")" != 0
getent group "$docker_group" >/dev/null 2>&1
test "$(getent group "$docker_group" | cut -d: -f3)" != 0
# This service has one deliberate supplementary group. Reconcile the complete
# list instead of appending stale groups from an older host configuration.
usermod --groups "$docker_group" "$service_user"

# Docker group membership is checked as the actual service identity. Merely
# having a group entry while the socket is root-only would otherwise make a
# release appear healthy and fail after systemd starts it.
test -S /run/docker.sock
test "$(stat -c '%G' /run/docker.sock)" = "$docker_group"
test "$(stat -c '%A' /run/docker.sock | cut -c5-6)" = "rw"
runuser -u "$service_user" -- id -nG | tr ' ' '\n' | grep -Fx "$docker_group" >/dev/null
runuser -u "$service_user" -- docker info --format '{{.ServerVersion}}' >/dev/null

# Preserve the existing /root/cloudeEditor release location while allowing
# only this account to traverse /root and read the release inputs. Prefer ACLs;
# the chmod fallback grants execute-only traversal on /root and group access to
# the release directory, never broad read access to root's home files.
if command -v setfacl >/dev/null 2>&1; then
  setfacl -m "u:$service_user:--x" /root
  chmod 0750 "$root"
  setfacl -m "u:$service_user:r-x" "$root"
else
  # setfacl is not present on minimal images. Use a dedicated group for
  # traversal and release-file access; do not grant the group access to other
  # files in /root.
  chgrp "$service_group" /root
  chmod 0710 /root
  chgrp "$service_group" "$root"
  chmod 0750 "$root"
fi

secure_release_file() {
  path="$1"
  mode="$2"
  test -f "$path"
  test ! -L "$path"
  chown root:"$service_group" "$path"
  case "$mode" in
    r) chmod 0640 "$path" ;;
    rx) chmod 0750 "$path" ;;
    *) echo "Unsupported release-file mode: $mode" >&2; exit 1 ;;
  esac
  if command -v setfacl >/dev/null 2>&1; then
    setfacl -m "u:$service_user:$mode" "$path"
  fi
}
# A fresh host may not have a previous binary yet. If an entry is present,
# including a dangling symlink, validate it before the release phase; an absent
# entry is intentionally allowed so the staged artifact can provide the first
# installation.
if [ -e "$root/bobocloud-server" ] || [ -L "$root/bobocloud-server" ]; then
  secure_release_file "$root/bobocloud-server" rx
fi
secure_release_file "$root/config.json" r
# Enabled protocol workers must have an explicit, validated catalog. A missing
# catalog must stop provisioning rather than silently selecting local commands.
secure_release_file "$root/lsp_servers.json" r
secure_release_file "$root/dap_adapters.json" r
if [ -f "$root/compile_rules.json" ]; then
  secure_release_file "$root/compile_rules.json" r
fi

# Keep existing user state in place for this release. Ownership is repaired
# only after the release command stops the service, so a running compiler can
# never race a recursive permission change. The release command also uses
# -P/--no-dereference and skips managed mount roots.
test -d "$data_root"
test ! -L "$data_root"
test -d "$workspace_root"
test ! -L "$workspace_root"

# Move the existing root-only certificate/key into a service-readable, root-
# owned directory. Never follow a symlink or relax the private-key mode.
test ! -L "$tls_source"
if [ -e "$tls_root" ] && [ -L "$tls_root" ]; then
  echo "Refusing symlink TLS directory: $tls_root" >&2
  exit 1
fi
install -d -o root -g "$service_group" -m 0750 "$tls_root"
for tls_file in "$tls_cert" "$tls_key"; do
  if [ -e "$tls_file" ] && [ -L "$tls_file" ]; then
    echo "Refusing symlink TLS destination: $tls_file" >&2
    exit 1
  fi
done
if [ -f "$tls_source/bobocloud.crt" ]; then
  test ! -L "$tls_source/bobocloud.crt"
  test "$(stat -c '%u' "$tls_source/bobocloud.crt")" = 0
  install -o root -g "$service_group" -m 0640 "$tls_source/bobocloud.crt" "$tls_cert"
fi
if [ -f "$tls_source/bobocloud.key" ]; then
  test ! -L "$tls_source/bobocloud.key"
  test "$(stat -c '%u' "$tls_source/bobocloud.key")" = 0
  case "$(stat -c '%A' "$tls_source/bobocloud.key")" in
    -rw-------|-r--------) ;;
    *) echo "Refusing TLS private key with broad permissions" >&2; exit 1 ;;
  esac
  install -o root -g "$service_group" -m 0640 "$tls_source/bobocloud.key" "$tls_key"
fi
test -s "$tls_cert"
test -s "$tls_key"
test "$(stat -c '%u' "$tls_key")" = 0
test "$(stat -c '%A' "$tls_key" | cut -c5-6)" = "r-"

# The env file is intentionally required by the unit. Create an empty,
# protected file on a first install so systemd cannot silently omit it.
if [ -e "$environment_file" ] && [ -L "$environment_file" ]; then
  echo "Refusing symlink environment file: $environment_file" >&2
  exit 1
fi
environment_dir="$(dirname "$environment_file")"
if [ -e "$environment_dir" ] && [ -L "$environment_dir" ]; then
  echo "Refusing symlink environment directory: $environment_dir" >&2
  exit 1
fi
install -d -o root -g "$service_group" -m 0750 "$environment_dir"
if [ ! -e "$environment_file" ]; then
  install -o root -g "$service_group" -m 0640 /dev/null "$environment_file"
else
  chown root:"$service_group" "$environment_file"
  chmod 0640 "$environment_file"
fi

'@
	return $template.Replace('__ROOT__', $Profile.RemoteRoot).Replace('__SERVICE_USER__', $Profile.ServiceUser).Replace('__SERVICE_GROUP__', $Profile.ServiceGroup).Replace('__DOCKER_GROUP__', $Profile.DockerGroup).Replace('__DATA_ROOT__', $Profile.DataRoot).Replace('__WORKSPACE_ROOT__', $Profile.WorkspaceRoot).Replace('__TLS_ROOT__', $Profile.TLSRoot).Replace('__TLS_CERT__', $Profile.TLSCertFile).Replace('__TLS_KEY__', $Profile.TLSKeyFile).Replace('__ENVIRONMENT_FILE__', $Profile.EnvironmentFile)
}

function Get-RemoteChecksumCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedHash,

        [Parameter(Mandatory = $true)]
        [string]$UnitArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedUnitHash
    )

    $template = @'
set -eu
actual_sha="$(sha256sum "__ARTIFACT__" | awk '{print $1}')"
test "$actual_sha" = "__EXPECTED_SHA__"
unit_sha="$(sha256sum "__UNIT_ARTIFACT__" | awk '{print $1}')"
test "$unit_sha" = "__EXPECTED_UNIT_SHA__"
printf '%s\n' "remote server SHA-256 verified: $actual_sha"
printf '%s\n' "remote systemd unit SHA-256 verified: $unit_sha"
'@
    return ($template.Replace('__ARTIFACT__', $ArtifactPath).Replace('__EXPECTED_SHA__', $ExpectedHash).Replace('__UNIT_ARTIFACT__', $UnitArtifactPath).Replace('__EXPECTED_UNIT_SHA__', $ExpectedUnitHash))
}

function Get-RemoteReleaseCommand {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Profile,

        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedHash,

        [Parameter(Mandatory = $true)]
        [string]$UnitArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedUnitHash,

        [Parameter(Mandatory = $true)]
        [ValidateSet('http', 'https')]
        [string]$Transport,

        [Parameter(Mandatory = $true)]
        [string]$ProbeHost,

        [string]$RemoteCAFile
    )

    $template = @'
set -eu
root="__ROOT__"
artifact="__ARTIFACT__"
unit_artifact="__UNIT_ARTIFACT__"
service="__SERVICE__"
service_user="__SERVICE_USER__"
service_group="__SERVICE_GROUP__"
data_root="__DATA_ROOT__"
workspace_root="__WORKSPACE_ROOT__"
expected_sha="__EXPECTED_SHA__"
expected_unit_sha="__EXPECTED_UNIT_SHA__"
transport="__TRANSPORT__"
probe_host=__PROBE_HOST__
http_port="__HTTP_PORT__"
ca_file=__CA_FILE__

command -v flock >/dev/null 2>&1
exec 9>"$root/.deploy/bobocloud-release.lock"
if ! flock -n 9; then
  echo "Another BOBOCLOUD release is already in progress." >&2
  exit 75
fi

test -f "$artifact"
test ! -L "$artifact"
test -f "$unit_artifact"
test ! -L "$unit_artifact"
actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
test "$actual_sha" = "$expected_sha"
actual_unit_sha="$(sha256sum "$unit_artifact" | awk '{print $1}')"
test "$actual_unit_sha" = "$expected_unit_sha"
systemd-analyze verify "$unit_artifact"

# Refuse to install a unit that would silently revert to a root or plaintext
# service. The unit itself carries the same values; this check protects the
# release transaction if a stale/mismatched artifact is supplied.
grep -Eq '^User=__SERVICE_USER__[[:space:]]*$' "$unit_artifact"
grep -Eq '^Group=__SERVICE_GROUP__[[:space:]]*$' "$unit_artifact"
grep -Eq '^SupplementaryGroups=docker[[:space:]]*$' "$unit_artifact"
grep -Eq '^Environment=BOBOCLOUD_TLS_REQUIRED=true[[:space:]]*$' "$unit_artifact"
grep -Eq '^Environment=BOBOCLOUD_TLS_ENABLED=true[[:space:]]*$' "$unit_artifact"
grep -Eq '^Environment=BOBOCLOUD_SERVER_ROOT=__SERVER_ROOT__[[:space:]]*$' "$unit_artifact"
grep -Eq '^ExecStart=/usr/bin/env' "$unit_artifact"
grep -Eq 'BOBOCLOUD_TLS_REQUIRED=true' "$unit_artifact"
grep -Eq 'BOBOCLOUD_TLS_ENABLED=true' "$unit_artifact"
grep -Eq 'BOBOCLOUD_DATA_DIR=/root/cloudeEditor/data' "$unit_artifact"
grep -Eq 'BOBOCLOUD_SERVER_ROOT=__SERVER_ROOT__' "$unit_artifact"
test "$transport" = 'https'

if systemctl is-active --quiet "$service"; then
  systemctl stop "$service"
fi
if systemctl is-active --quiet "$service"; then
  echo "Service remained active after stop: $service" >&2
  exit 1
fi

# The previous release may have had host-level privileges. Re-check both
# staged inputs after it is stopped so it cannot mutate an artifact between
# validation and installation.
actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
test "$actual_sha" = "$expected_sha"
actual_unit_sha="$(sha256sum "$unit_artifact" | awk '{print $1}')"
test "$actual_unit_sha" = "$expected_unit_sha"
systemd-analyze verify "$unit_artifact"

install -m 0644 "$unit_artifact" "/etc/systemd/system/$service"
systemctl daemon-reload

# Repair ownership while the old process is stopped. Never follow a symlink,
# and never walk the kernel mount anchors which Docker/LSP/DAP may have left in
# the data tree. Bind anchors are cleaned during the next server startup.
repair_tree() {
  tree="$1"
  test -d "$tree"
  test ! -L "$tree"
  find -P "$tree" -xdev \
    \( -path "$data_root/lsp-cache/mounts" -o -path "$data_root/dap-cache/mounts" -o -path "$data_root/personalcache-mounts" \) -prune -o \
    \( -type d -o -type f \) -exec chown --no-dereference "$service_user:$service_group" '{}' +
  find -P "$tree" -xdev \
    \( -path "$data_root/lsp-cache/mounts" -o -path "$data_root/dap-cache/mounts" -o -path "$data_root/personalcache-mounts" \) -prune -o \
    \( -type d -o -type f \) -exec chmod go-rwx '{}' +
}
repair_mount_root() {
  tree="$1"
  # A stale bind mount at the anchor itself must be cleaned by the server's
  # recovery path, never chmod/chown'ed as if it were an ordinary directory.
  if ! command -v mountpoint >/dev/null 2>&1; then
    echo "Refusing to repair cache anchor without mountpoint: $tree" >&2
    exit 1
  fi
  if mountpoint -q "$tree"; then
    echo "Refusing to repair a mounted cache anchor: $tree" >&2
    exit 1
  else
    mount_status=$?
    case "$mount_status" in
      32)
        # util-linux mountpoint uses 32 for an existing path that is not a
        # mountpoint. This is the expected result on the production host.
        ;;
      1)
        # A missing path is reported as status 1 by util-linux. Allow the
        # repair below to create it, but do not treat status 1 as safe for an
        # existing entry because it can also represent an inspection error.
        if [ -e "$tree" ] || [ -L "$tree" ]; then
          echo "Unable to determine whether cache anchor is mounted: $tree" >&2
          exit 1
        fi
        ;;
      *)
        echo "Unable to determine whether cache anchor is mounted: $tree" >&2
        exit 1
        ;;
    esac
  fi
  test ! -L "$tree"
  if [ ! -e "$tree" ]; then
    install -d -o "$service_user" -g "$service_group" -m 0700 "$tree"
    return
  fi
  test -d "$tree"
  # Child entries may be live bind mounts. Change only the anchor directory
  # itself so ownership repair never crosses into a mounted cache generation.
  chown --no-dereference "$service_user:$service_group" "$tree"
  chmod 0700 "$tree"
}
repair_tree "$data_root"
repair_tree "$workspace_root"
repair_mount_root "$data_root/lsp-cache/mounts"
repair_mount_root "$data_root/dap-cache/mounts"
repair_mount_root "$data_root/personalcache-mounts"
install -d -o "$service_user" -g "$service_group" -m 0700 "$data_root"
install -d -o "$service_user" -g "$service_group" -m 0700 "$workspace_root"

# Do not retain previous deployed binary versions or rollback snapshots.
rm -f "$root/.bobocloud-server.next"
find -P "$root" -maxdepth 1 \( -type f -o -type l \) -name 'bobocloud-server*' -delete
install -o root -g "$service_group" -m 0750 "$artifact" "$root/.bobocloud-server.next"
mv -f "$root/.bobocloud-server.next" "$root/bobocloud-server"
if command -v setfacl >/dev/null 2>&1; then
  setfacl -m "u:$service_user:r-x" "$root/bobocloud-server"
fi
systemctl start "$service"

if [ "$transport" = 'https' ]; then
  base_url="$transport://$probe_host:$http_port"
else
  # Plain HTTP checks never leave the target host.
  base_url="http://127.0.0.1:$http_port"
fi

probe_get() {
  endpoint="$1"
  if [ "$transport" = 'https' ]; then
    test -r "$ca_file"
    curl --fail --silent --show-error --max-time 5 --cacert "$ca_file" --resolve "$probe_host:$http_port:127.0.0.1" "$base_url$endpoint"
  else
    curl --fail --silent --show-error --max-time 5 "$base_url$endpoint"
  fi
}

probe_server_info() {
  if [ "$transport" = 'https' ]; then
    test -r "$ca_file"
    curl --fail --silent --show-error --max-time 5 --cacert "$ca_file" --resolve "$probe_host:$http_port:127.0.0.1" --request POST --header 'Content-Type: application/json' --data '{"action":"serverInfo"}' "$base_url/"
  else
    curl --fail --silent --show-error --max-time 5 --request POST --header 'Content-Type: application/json' --data '{"action":"serverInfo"}' "$base_url/"
  fi
}

wait_for_get() {
  endpoint="$1"
  attempt=0
  until probe_get "$endpoint"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      echo "Timed out waiting for $endpoint" >&2
      exit 1
    fi
    sleep 1
  done
}

systemctl is-active --quiet "$service"
test "$(systemctl show -p User --value "$service")" = "$service_user"
wait_for_get '/healthz'
wait_for_get '/readyz'
server_info="$(probe_server_info)"
printf '%s\n' "$server_info"
printf '%s' "$server_info" | grep -Eq '"success"[[:space:]]*:[[:space:]]*true'
systemctl --no-pager --full status "$service"
rm -f "$artifact" "$unit_artifact"
'@
    $probeHostLiteral = ConvertTo-PosixShellLiteral $ProbeHost
    $caFileLiteral = ConvertTo-PosixShellLiteral $RemoteCAFile
    return ($template.Replace('__ROOT__', $Profile.RemoteRoot).Replace('__ARTIFACT__', $ArtifactPath).Replace('__UNIT_ARTIFACT__', $UnitArtifactPath).Replace('__SERVICE__', $Profile.ServiceName).Replace('__SERVICE_USER__', $Profile.ServiceUser).Replace('__SERVICE_GROUP__', $Profile.ServiceGroup).Replace('__DATA_ROOT__', $Profile.DataRoot).Replace('__WORKSPACE_ROOT__', $Profile.WorkspaceRoot).Replace('__SERVER_ROOT__', $Profile.ServerRoot).Replace('__EXPECTED_SHA__', $ExpectedHash).Replace('__EXPECTED_UNIT_SHA__', $ExpectedUnitHash).Replace('__TRANSPORT__', $Transport).Replace('__PROBE_HOST__', $probeHostLiteral).Replace('__HTTP_PORT__', [string]$Profile.HTTPPort).Replace('__CA_FILE__', $caFileLiteral))
}

function Invoke-RemoteCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SshPath,

        [Parameter(Mandatory = $true)]
        [string[]]$SshOptions,

        [Parameter(Mandatory = $true)]
        [pscustomobject]$Profile,

        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    $connection = "$($Profile.User)@$($Profile.Host)"
    $normalizedCommand = ConvertTo-PosixShellCommand -Command $Command
    Invoke-NativeCommand -FilePath $SshPath -Arguments ($SshOptions + @($connection, $normalizedCommand))
}

$profile = $DeploymentProfiles[$Target]
if ($null -eq $profile) {
    throw "Deployment profile was not found: $Target"
}

if ($profile.RequireTLS -and $Apply -and $Transport -ne 'https') {
	throw 'The production profile requires HTTPS; plaintext deployment verification is disabled.'
}
if ($Transport -eq 'https' -and $Apply -and [string]::IsNullOrWhiteSpace($RemoteCAFile)) {
	throw 'HTTPS deployment verification requires -RemoteCAFile when applying a release; production verification never uses curl -k.'
}
if ([string]::IsNullOrWhiteSpace($ProbeHost)) {
    $ProbeHost = $profile.Host
}

$serverRoot = Split-Path -Parent $PSScriptRoot
if ($Build) {
    $resolvedBinaryPath = Invoke-LocalLinuxAmd64Build -ServerRoot $serverRoot
} else {
    $resolvedBinaryPath = (Resolve-Path -LiteralPath $BinaryPath -ErrorAction Stop).Path
}

Test-LinuxAmd64ELF -Path $resolvedBinaryPath
$localHash = (Get-FileHash -LiteralPath $resolvedBinaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($localHash -notmatch '^[a-f0-9]{64}$') {
    throw "Unable to calculate a SHA-256 checksum for $resolvedBinaryPath"
}
$unitPath = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath 'bobocloud.service') -ErrorAction Stop).Path
$unitHash = (Get-FileHash -LiteralPath $unitPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($unitHash -notmatch '^[a-f0-9]{64}$') {
    throw "Unable to calculate a SHA-256 checksum for $unitPath"
}

$artifactPath = "$($profile.RemoteRoot)/.deploy/bobocloud-server-$($localHash.Substring(0, 16)).tmp"
$unitArtifactPath = "$($profile.RemoteRoot)/.deploy/bobocloud.service-$($unitHash.Substring(0, 16)).tmp.service"
Write-Output "Preflight passed for $Target ($($profile.User)@$($profile.Host))."
Write-Output "Local Linux/amd64 ELF SHA-256: $localHash"
Write-Output "Local systemd unit SHA-256: $unitHash"
Write-Output "Remote artifact path: $artifactPath"
Write-Output "Remote systemd unit path: $unitArtifactPath"
Write-Output "Verification transport: $Transport; probe host: $ProbeHost; production TLS required: $($profile.RequireTLS)"

if (-not $Apply) {
    Write-Output 'No remote action was taken. Add -Apply -ConfirmTarget <profile host> to deploy after reviewing this preflight.'
    return
}

if ($ConfirmTarget -cne $profile.Host) {
    throw "Refusing deployment. -ConfirmTarget must exactly match $($profile.Host)."
}

if (-not $PSCmdlet.ShouldProcess("$Target ($($profile.Host))", 'replace the deployed BOBOCLOUD server binary')) {
    return
}

$sshPath = Get-NativeCommandPath -Name 'ssh'
$scpPath = Get-NativeCommandPath -Name 'scp'
$sshOptions = @('-o', 'StrictHostKeyChecking=yes')
if (-not $AllowInteractiveAuthentication) {
    $sshOptions += @('-o', 'BatchMode=yes')
}

Invoke-RemoteCommand -SshPath $sshPath -SshOptions $sshOptions -Profile $profile -Command (Get-RemotePrepareCommand -Profile $profile)

$connection = "$($profile.User)@$($profile.Host)"
Invoke-NativeCommand -FilePath $scpPath -Arguments ($sshOptions + @($resolvedBinaryPath, "${connection}:$artifactPath"))
Invoke-NativeCommand -FilePath $scpPath -Arguments ($sshOptions + @($unitPath, "${connection}:$unitArtifactPath"))

Invoke-RemoteCommand -SshPath $sshPath -SshOptions $sshOptions -Profile $profile -Command (Get-RemoteChecksumCommand -ArtifactPath $artifactPath -ExpectedHash $localHash -UnitArtifactPath $unitArtifactPath -ExpectedUnitHash $unitHash)
Invoke-RemoteCommand -SshPath $sshPath -SshOptions $sshOptions -Profile $profile -Command (Get-RemoteReleaseCommand -Profile $profile -ArtifactPath $artifactPath -ExpectedHash $localHash -UnitArtifactPath $unitArtifactPath -ExpectedUnitHash $unitHash -Transport $Transport -ProbeHost $ProbeHost -RemoteCAFile $RemoteCAFile)

Write-Output "Deployment completed and verified on $Target."
