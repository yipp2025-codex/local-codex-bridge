Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:NativeWakeupLauncherRoot = $PSScriptRoot
$script:NativeWakeupLogPath = Join-Path $PSScriptRoot "runtime\native-wakeup.log"
$script:NativeWakeupSignalSpool = Join-Path $PSScriptRoot "runtime\native-wakeup-signals"
$script:NativeWakeupLogOverride = $null

$script:NativeWakeupOperationalEvents = @(
    "WAKE_LAUNCHER_ENTRY",
    "OWNER_VALIDATED",
    "PAYLOAD_VALIDATED",
    "ONE_SHOT_STARTED",
    "ONE_SHOT_EXIT_0",
    "ONE_SHOT_FAILED",
    "FAIL:WAKE_LAUNCHER_PREOWNER",
    "SUBSTAGE:WAKE_OWNER_CONFIG_LOAD_FAILED",
    "SUBSTAGE:WAKE_CURRENT_TOKEN_SID_FAILED",
    "SUBSTAGE:WAKE_OWNER_SID_MISMATCH",
    "SUBSTAGE:WAKE_RUNTIME_ROOT_FAILED",
    "SUBSTAGE:WAKE_LOG_INIT_FAILED",
    "SUBSTAGE:WAKE_SIGNAL_SPOOL_PREFLIGHT_FAILED",
    "SUBSTAGE:WAKE_LAUNCHER_UNKNOWN_PREOWNER_FAILURE",
    "SUBSTAGE:NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
    "SUBSTAGE:NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
    "SUBSTAGE:NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH",
    "SUBSTAGE:NATIVE_WAKEUP_RUNTIME_HASH_MISMATCH",
    "SUBSTAGE:NATIVE_WAKEUP_PROJECT_MAPPING_FAILED",
    "SUBSTAGE:NATIVE_WAKEUP_SIGNAL_READ_FAILED",
    "SUBSTAGE:NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED",
    "SUBSTAGE:NATIVE_WAKEUP_DB_REREAD_FAILED",
    "SUBSTAGE:NATIVE_WAKEUP_REGISTRY_REJECTED",
    "SUBSTAGE:NATIVE_WAKEUP_EXECUTOR_START_FAILED",
    "SUBSTAGE:NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE",
    "SUBSTAGE:NATIVE_WAKEUP_DEPLOYMENT_CONFIG_FAILED",
    "SUBSTAGE:NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH",
    "SUBSTAGE:NATIVE_WAKEUP_SIGNAL_MISSING",
    "SUBSTAGE:NATIVE_WAKEUP_MODULE_LOAD_FAILED",
    "SUBSTAGE:NATIVE_WAKEUP_CALLER_ARGUMENT_FORBIDDEN"
)

$script:NativeWakeupPreclaimSubstages = @(
    "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
    "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
    "NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH",
    "NATIVE_WAKEUP_RUNTIME_HASH_MISMATCH",
    "NATIVE_WAKEUP_PROJECT_MAPPING_FAILED",
    "NATIVE_WAKEUP_SIGNAL_READ_FAILED",
    "NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED",
    "NATIVE_WAKEUP_DB_REREAD_FAILED",
    "NATIVE_WAKEUP_REGISTRY_REJECTED",
    "NATIVE_WAKEUP_EXECUTOR_START_FAILED",
    "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE",
    "NATIVE_WAKEUP_DEPLOYMENT_CONFIG_FAILED",
    "NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH",
    "NATIVE_WAKEUP_SIGNAL_MISSING",
    "NATIVE_WAKEUP_MODULE_LOAD_FAILED",
    "NATIVE_WAKEUP_CALLER_ARGUMENT_FORBIDDEN"
)

function Resolve-NativeWakeupFailureSubstage {
    param([AllowNull()][object[]]$Output)

    foreach ($line in @($Output)) {
        $match = [System.Text.RegularExpressions.Regex]::Match(
            [string]$line,
            '^NATIVE_WAKEUP_FAIL_CLOSED:(?<substage>[A-Z0-9_]+)$'
        )
        if ($match.Success -and $script:NativeWakeupPreclaimSubstages -contains $match.Groups['substage'].Value) {
            return $match.Groups['substage'].Value
        }
    }
    return "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE"
}

function Write-NativeWakeupOperationalEvent {
    param([Parameter(Mandatory = $true)][string]$Event)
    if ($script:NativeWakeupOperationalEvents -notcontains $Event) {
        throw "WAKE_LOG_INIT_FAILED"
    }
    if ($null -ne $script:NativeWakeupLogOverride) {
        & $script:NativeWakeupLogOverride $Event
        return
    }
    try {
        $runtimeDirectory = Split-Path -Parent $script:NativeWakeupLogPath
        if (-not [System.IO.Directory]::Exists($runtimeDirectory)) {
            [System.IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
        }
        if ([System.IO.File]::Exists($script:NativeWakeupLogPath) -and (Get-Item -LiteralPath $script:NativeWakeupLogPath).Length -ge 65536) {
            [System.IO.File]::WriteAllText($script:NativeWakeupLogPath, "")
        }
        [System.IO.File]::AppendAllText(
            $script:NativeWakeupLogPath,
            ((Get-Date).ToUniversalTime().ToString("o") + " " + $Event + [Environment]::NewLine)
        )
    }
    catch {
        throw "WAKE_LOG_INIT_FAILED"
    }
}

function Test-NativeWakeupRuntimeRoot {
    try {
        $item = Get-Item -LiteralPath $script:NativeWakeupLauncherRoot -Force
        $canonical = [System.IO.Path]::GetFullPath($item.FullName).TrimEnd('\')
        $expected = [System.IO.Path]::GetFullPath($script:NativeWakeupLauncherRoot).TrimEnd('\')
        if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return $false }
        return [string]::Equals($canonical, $expected, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Test-NativeWakeupSignalSpool {
    try {
        if (-not [System.IO.Directory]::Exists($script:NativeWakeupSignalSpool)) { return $false }
        $item = Get-Item -LiteralPath $script:NativeWakeupSignalSpool -Force
        return $item.PSIsContainer -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    }
    catch { return $false }
}

function Invoke-StatefulRelayNativeWakeupPreOwner {
    param([Parameter(Mandatory = $true)][int]$ArgumentCount)

    if (-not (Test-NativeWakeupRuntimeRoot)) { throw "WAKE_RUNTIME_ROOT_FAILED" }
    try { Write-NativeWakeupOperationalEvent "WAKE_LAUNCHER_ENTRY" }
    catch { throw "WAKE_LOG_INIT_FAILED" }
    if ($ArgumentCount -ne 0) { throw "WAKE_LAUNCHER_UNKNOWN_PREOWNER_FAILURE" }

    try { $expectedSid = Read-FrozenDeploymentOwnerSid }
    catch { throw "WAKE_OWNER_CONFIG_LOAD_FAILED" }
    try { $currentSid = Get-CurrentWindowsTokenSid }
    catch { throw "WAKE_CURRENT_TOKEN_SID_FAILED" }
    if (-not [string]::Equals($expectedSid, $currentSid, [System.StringComparison]::Ordinal)) {
        throw "WAKE_OWNER_SID_MISMATCH"
    }
    if (-not (Test-NativeWakeupSignalSpool)) { throw "WAKE_SIGNAL_SPOOL_PREFLIGHT_FAILED" }
    Write-NativeWakeupOperationalEvent "OWNER_VALIDATED"
    return [pscustomobject]@{ OwnerValidated = $true; SignalSpoolValidated = $true }
}

function Write-NativeWakeupPreOwnerFailure {
    param([AllowNull()][string]$Substage)
    $fixed = @(
        "WAKE_OWNER_CONFIG_LOAD_FAILED", "WAKE_CURRENT_TOKEN_SID_FAILED",
        "WAKE_OWNER_SID_MISMATCH", "WAKE_RUNTIME_ROOT_FAILED",
        "WAKE_LOG_INIT_FAILED", "WAKE_SIGNAL_SPOOL_PREFLIGHT_FAILED",
        "WAKE_LAUNCHER_UNKNOWN_PREOWNER_FAILURE"
    )
    if ($fixed -notcontains $Substage) { $Substage = "WAKE_LAUNCHER_UNKNOWN_PREOWNER_FAILURE" }
    try {
        Write-NativeWakeupOperationalEvent "FAIL:WAKE_LAUNCHER_PREOWNER"
        Write-NativeWakeupOperationalEvent ("SUBSTAGE:{0}" -f $Substage)
    }
    catch { }
    return $Substage
}
