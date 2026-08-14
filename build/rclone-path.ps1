param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('add', 'remove')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$Entry
)

$ErrorActionPreference = 'Stop'
$environmentKeyPath = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'

function Get-NormalizedPathEntry([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $clean = $Value.Trim().Trim('"').TrimEnd('\', '/')
    return [Environment]::ExpandEnvironmentVariables($clean)
}

$environmentKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($environmentKeyPath, $true)
if (-not $environmentKey) { throw 'Unable to open the system Environment registry key.' }

try {
    $current = [string]$environmentKey.GetValue(
        'Path',
        '',
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    $target = Get-NormalizedPathEntry $Entry
    $segments = @($current.Split(';'))
    $matchesTarget = {
        param([string]$Segment)
        [string]::Equals(
            (Get-NormalizedPathEntry $Segment),
            $target,
            [StringComparison]::OrdinalIgnoreCase
        )
    }

    if ($Action -eq 'add') {
        $exists = $false
        foreach ($segment in $segments) {
            if (& $matchesTarget $segment) { $exists = $true; break }
        }
        if ($exists) {
            Write-Output 'already-present'
            exit 10
        }

        $updated = if ([string]::IsNullOrEmpty($current)) {
            $Entry
        } elseif ($current.EndsWith(';')) {
            $current + $Entry
        } else {
            $current + ';' + $Entry
        }
        $environmentKey.SetValue('Path', $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        Write-Output 'added'
    } else {
        $removed = $false
        $kept = @()
        foreach ($segment in $segments) {
            if (-not $removed -and (& $matchesTarget $segment)) {
                $removed = $true
                continue
            }
            $kept += $segment
        }
        $updated = [string]::Join(';', $kept)
        if (-not $removed) {
            Write-Output 'not-present'
            exit 10
        }
        $environmentKey.SetValue('Path', $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        Write-Output 'removed'
    }
} finally {
    $environmentKey.Dispose()
}
