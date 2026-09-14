[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$deployScript = Join-Path -Path $PSScriptRoot -ChildPath 'Deploy-BoboCloudServer.ps1'
$fixturePath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("bobocloud-deploy-test-{0}.bin" -f [guid]::NewGuid().ToString('N'))

try {
    # A minimal ELF64 little-endian header for EM_X86_64 is enough for the
    # deployment script's offline target validation. It is never executed.
    [byte[]]$fixture = New-Object byte[] 64
    $fixture[0] = 0x7f
    $fixture[1] = [byte][char]'E'
    $fixture[2] = [byte][char]'L'
    $fixture[3] = [byte][char]'F'
    $fixture[4] = 2
    $fixture[5] = 1
    $fixture[6] = 1
    $fixture[18] = 62
    [System.IO.File]::WriteAllBytes($fixturePath, $fixture)

    $preflight = & $deployScript -Target production-81.70.51.43 -BinaryPath $fixturePath 2>&1
    if (($preflight -join "`n") -notmatch 'No remote action was taken') {
        throw 'Default deployment invocation did not remain in preflight mode.'
    }

    # This exercises PowerShell's ShouldProcess path. It must finish before
    # the script resolves either SSH executable or issues a remote command.
    & $deployScript -Target production-81.70.51.43 -BinaryPath $fixturePath -RemoteCAFile /etc/bobocloud/tls/bobocloud.crt -Apply -ConfirmTarget 81.70.51.43 -WhatIf | Out-Null

    $httpRejected = $false
    try {
        & $deployScript -Target production-81.70.51.43 -BinaryPath $fixturePath -Transport http -Apply -ConfirmTarget 81.70.51.43 -WhatIf 2>$null | Out-Null
    } catch {
        $httpRejected = $_.Exception.Message -match 'requires HTTPS'
    }
    if (-not $httpRejected) {
        throw 'Production apply accepted plaintext HTTP verification.'
    }

    $httpsRejected = $false
    try {
        & $deployScript -Target production-81.70.51.43 -BinaryPath $fixturePath -Transport https -Apply -ConfirmTarget 81.70.51.43 -WhatIf 2>$null | Out-Null
    } catch {
        $httpsRejected = $_.Exception.Message -match 'RemoteCAFile'
    }
    if (-not $httpsRejected) {
        throw 'HTTPS preflight accepted a missing remote CA file.'
    }

    # Dot-source the offline preflight so the remote command generator can be
    # exercised without resolving SSH or opening a network connection.
    . $deployScript -Target production-81.70.51.43 -BinaryPath $fixturePath -RemoteCAFile /etc/bobocloud/tls/bobocloud.crt | Out-Null
    $resolvedGo = Get-NativeCommandPath -Name 'go'
    if ($resolvedGo -isnot [string] -or [string]::IsNullOrWhiteSpace($resolvedGo) -or -not (Test-Path -LiteralPath $resolvedGo -PathType Leaf)) {
        throw 'Native command resolution must return exactly one executable path.'
    }
    $remoteProfile = [pscustomobject]@{
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
        TLSRoot     = '/etc/bobocloud/tls'
        TLSCertFile = '/etc/bobocloud/tls/bobocloud.crt'
        TLSKeyFile  = '/etc/bobocloud/tls/bobocloud.key'
        EnvironmentFile = '/etc/bobocloud/bobocloud.env'
        RequireTLS  = $true
    }
    $expectedHash = ('a' * 64) -join ''
    $expectedUnitHash = ('b' * 64) -join ''
    $prepareCommand = Get-RemotePrepareCommand -Profile $remoteProfile
    $releaseCommand = Get-RemoteReleaseCommand -Profile $remoteProfile -ArtifactPath '/root/cloudeEditor/.deploy/bobocloud-server-test.tmp' -ExpectedHash $expectedHash -UnitArtifactPath '/root/cloudeEditor/.deploy/bobocloud.service-test.tmp' -ExpectedUnitHash $expectedUnitHash -Transport https -ProbeHost '81.70.51.43' -RemoteCAFile '/etc/bobocloud/tls/bobocloud.crt'
    $expectedHashBinding = 'expected_sha="' + $expectedHash + '"'
    $expectedUnitHashBinding = 'expected_unit_sha="' + $expectedUnitHash + '"'
    if ($releaseCommand.Contains('__') -or -not $releaseCommand.Contains($expectedHashBinding) -or -not $releaseCommand.Contains($expectedUnitHashBinding)) {
        throw 'Remote release command did not bind the expected checksums safely.'
    }
    if ($prepareCommand.Contains('__') -or -not $prepareCommand.Contains('flock -n 9') -or -not $prepareCommand.Contains('-mmin +1440')) {
        throw 'Remote preparation must lock and preserve fresh concurrent uploads.'
    }

    $scriptText = Get-Content -LiteralPath $deployScript -Raw
    $shouldProcessIndex = $scriptText.IndexOf('$PSCmdlet.ShouldProcess')
    $sshLookupIndex = $scriptText.IndexOf("Get-NativeCommandPath -Name 'ssh'")
    if ($shouldProcessIndex -lt 0 -or $sshLookupIndex -lt 0 -or $shouldProcessIndex -ge $sshLookupIndex) {
        throw 'ShouldProcess must run before SSH resolution so WhatIf stays offline.'
    }
    foreach ($requiredFragment in @('Get-ChildItem -LiteralPath $releaseRoot', "'^bobocloud-server'", 'systemd-analyze verify "$unit_artifact"', 'systemctl daemon-reload', 'install -m 0644', 'systemctl stop', "'/healthz'", "'/readyz'", 'serverInfo', 'sha256sum', "-name 'bobocloud-server*'", 'flock -n', 'useradd --system', 'usermod --groups', 'runuser -u "$service_user" -- docker info', 'setfacl -m', 'chmod 0710 /root', 'bobocloud.crt', 'bobocloud.key', 'BOBOCLOUD_TLS_REQUIRED', 'BOBOCLOUD_DATA_DIR=/root/cloudeEditor/data', 'ExecStart=/usr/bin/env', 'test "$transport" =', 'find -P', 'chown --no-dereference', 'repair_tree', 'repair_mount_root', 'secure_release_file "$root/lsp_servers.json"', 'secure_release_file "$root/dap_adapters.json"', 'actual_unit_sha="$(sha256sum')) {
        if (-not $scriptText.Contains($requiredFragment)) {
            throw "Deployment script is missing required release step: $requiredFragment"
        }
    }
    if ($scriptText -match 'curl\s+.*\s-k(?:\s|$)') {
        throw 'Deployment script must not use curl -k for verification.'
    }
    foreach ($crlfSafeIdentityCheck in @("grep -Eq '^User=__SERVICE_USER__[[:space:]]*$'", "grep -Eq '^Group=__SERVICE_GROUP__[[:space:]]*$'", "grep -Eq '^SupplementaryGroups=docker[[:space:]]*$'")) {
        if (-not $scriptText.Contains($crlfSafeIdentityCheck)) {
            throw "Release checks must tolerate CRLF unit artifacts: $crlfSafeIdentityCheck"
        }
    }

    $unitText = Get-Content -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath 'bobocloud.service') -Raw
    foreach ($requiredUnitFragment in @('User=bobocloud', 'Group=bobocloud', 'SupplementaryGroups=docker', 'BindsTo=docker.service', 'CapabilityBoundingSet=CAP_SYS_ADMIN', 'AmbientCapabilities=CAP_SYS_ADMIN', 'PrivateMounts=false', 'NoNewPrivileges=true', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'Environment=BOBOCLOUD_TLS_REQUIRED=true', 'Environment=BOBOCLOUD_TLS_ENABLED=true', 'ExecStart=/usr/bin/env', 'BOBOCLOUD_DATA_DIR=/root/cloudeEditor/data', 'ExecStartPre=/usr/bin/test -f /root/cloudeEditor/config.json', 'ExecStartPre=/usr/bin/test ! -L /root/cloudeEditor/config.json', 'ExecStartPre=/usr/bin/test -f /root/cloudeEditor/lsp_servers.json', 'ExecStartPre=/usr/bin/test ! -L /root/cloudeEditor/lsp_servers.json', 'ExecStartPre=/usr/bin/test -f /root/cloudeEditor/dap_adapters.json', 'ExecStartPre=/usr/bin/test ! -L /root/cloudeEditor/dap_adapters.json', 'ExecStartPre=/usr/bin/test -f /etc/bobocloud/bobocloud.env', 'ExecStartPre=/usr/bin/test ! -L /etc/bobocloud/bobocloud.env', 'ExecStartPre=/usr/bin/test -S /run/docker.sock')) {
        if (-not $unitText.Contains($requiredUnitFragment)) {
            throw "systemd unit is missing required hardening directive: $requiredUnitFragment"
        }
    }
    if ($unitText -match '(?m)^User=root\s*$') {
        throw 'systemd unit must not run the compiler as root.'
    }
    foreach ($forbiddenMountNamespaceDirective in @('PrivateTmp=', 'PrivateDevices=', 'ProtectSystem=', 'ProtectHome=', 'ReadWritePaths=', 'InaccessiblePaths=')) {
        if ($unitText -match "(?m)^$([regex]::Escape($forbiddenMountNamespaceDirective))") {
            throw "systemd unit must not hide host mount anchors with $forbiddenMountNamespaceDirective"
        }
    }

    Write-Output 'Deployment script offline validation passed.'
} finally {
    Remove-Item -LiteralPath $fixturePath -Force -ErrorAction SilentlyContinue
}
