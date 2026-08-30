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
    [string]$Transport = 'http',

    [ValidatePattern('^/[A-Za-z0-9._/@+=:,%-]+$')]
    [string]$RemoteCAFile,

    [ValidatePattern('^[A-Za-z0-9.-]+$')]
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
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

    # A release directory must never become a local archive of deployable
    # server binaries. Resolve each exact target before deleting it so this
    # cleanup cannot escape the release directory.
    $releaseRoot = (Resolve-Path -LiteralPath $releaseDir).Path
    $releasePrefix = [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $previousArtifacts = Get-ChildItem -LiteralPath $releaseRoot -File | Where-Object {
        $_.Name -match '^bobocloud-server'
    }
    foreach ($previousArtifact in $previousArtifacts) {
        $resolvedArtifact = (Resolve-Path -LiteralPath $previousArtifact.FullName).Path
        if (-not [System.IO.Path]::GetFullPath($resolvedArtifact).StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a server artifact outside the release directory: $resolvedArtifact"
        }
        Remove-Item -LiteralPath $resolvedArtifact -Force
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

function Get-RemotePrepareCommand {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Profile
    )

    $template = @'
set -eu
umask 077
install -d -m 0700 "__ROOT__/.deploy"
exec 9>"__ROOT__/.deploy/bobocloud-release.lock"
if ! flock -n 9; then
  echo "Another BOBOCLOUD release is already in progress." >&2
  exit 75
fi
# Content-addressed uploads are safe to coexist. Only reap abandoned files
# old enough that they cannot belong to another active upload.
find "__ROOT__/.deploy" -maxdepth 1 -type f \( -name 'bobocloud-server-*.tmp' -o -name 'bobocloud.service-*.tmp.service' \) -mmin +1440 -delete
'@
    return $template.Replace('__ROOT__', $Profile.RemoteRoot)
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
expected_sha="__EXPECTED_SHA__"
expected_unit_sha="__EXPECTED_UNIT_SHA__"
transport="__TRANSPORT__"
probe_host="__PROBE_HOST__"
http_port="__HTTP_PORT__"
ca_file="__CA_FILE__"

command -v flock >/dev/null 2>&1
exec 9>"$root/.deploy/bobocloud-release.lock"
if ! flock -n 9; then
  echo "Another BOBOCLOUD release is already in progress." >&2
  exit 75
fi

actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
test "$actual_sha" = "$expected_sha"
actual_unit_sha="$(sha256sum "$unit_artifact" | awk '{print $1}')"
test "$actual_unit_sha" = "$expected_unit_sha"
systemd-analyze verify "$unit_artifact"

install -m 0644 "$unit_artifact" "/etc/systemd/system/$service"
systemctl daemon-reload

systemctl stop "$service"
if systemctl is-active --quiet "$service"; then
  echo "Service remained active after stop: $service" >&2
  exit 1
fi

# Do not retain previous deployed binary versions or rollback snapshots.
rm -f "$root/.bobocloud-server.next"
find "$root" -maxdepth 1 -type f -name 'bobocloud-server*' -delete
install -m 0755 "$artifact" "$root/.bobocloud-server.next"
mv -f "$root/.bobocloud-server.next" "$root/bobocloud-server"
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
wait_for_get '/healthz'
wait_for_get '/readyz'
server_info="$(probe_server_info)"
printf '%s\n' "$server_info"
printf '%s' "$server_info" | grep -Eq '"success"[[:space:]]*:[[:space:]]*true'
systemctl --no-pager --full status "$service"
rm -f "$artifact" "$unit_artifact"
'@
    return ($template.Replace('__ROOT__', $Profile.RemoteRoot).Replace('__ARTIFACT__', $ArtifactPath).Replace('__UNIT_ARTIFACT__', $UnitArtifactPath).Replace('__SERVICE__', $Profile.ServiceName).Replace('__EXPECTED_SHA__', $ExpectedHash).Replace('__EXPECTED_UNIT_SHA__', $ExpectedUnitHash).Replace('__TRANSPORT__', $Transport).Replace('__PROBE_HOST__', $ProbeHost).Replace('__HTTP_PORT__', [string]$Profile.HTTPPort).Replace('__CA_FILE__', $RemoteCAFile))
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
    Invoke-NativeCommand -FilePath $SshPath -Arguments ($SshOptions + @($connection, $Command))
}

$profile = $DeploymentProfiles[$Target]
if ($null -eq $profile) {
    throw "Deployment profile was not found: $Target"
}

if ($Transport -eq 'https' -and [string]::IsNullOrWhiteSpace($RemoteCAFile)) {
    throw 'HTTPS deployment verification requires -RemoteCAFile; production verification never uses curl -k.'
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
Write-Output "Verification transport: $Transport; probe host: $ProbeHost"

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
