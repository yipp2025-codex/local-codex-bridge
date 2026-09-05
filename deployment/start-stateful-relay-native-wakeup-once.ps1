[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$preOwnerComplete = $false

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        }
        finally { $sha.Dispose() }
    }
    finally { $stream.Dispose() }
}

try {
    . (Join-Path $PSScriptRoot "stateful-relay-native-wakeup-launcher-contract.ps1")
    . (Join-Path $PSScriptRoot "deployment-owner-identity.ps1")
    $unboundArguments = $MyInvocation.UnboundArguments
    $argumentCount = if ($null -eq $unboundArguments) { 0 } else { @($unboundArguments).Count }
    $null = Invoke-StatefulRelayNativeWakeupPreOwner -ArgumentCount $argumentCount
    $preOwnerComplete = $true

    $configPath = Join-Path $PSScriptRoot "config\stateful-relay-native-wakeup.json"
    $entrypointPath = Join-Path $PSScriptRoot "stateful-relay-native-wakeup-once.mjs"
    if (-not [System.IO.File]::Exists($configPath) -or -not [System.IO.File]::Exists($entrypointPath)) {
        throw "NATIVE_WAKEUP_DEPLOYMENT_PAYLOAD_MISSING"
    }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not [System.IO.File]::Exists([string]$config.node_runtime_path)) { throw "NATIVE_WAKEUP_NODE_RUNTIME_MISSING" }
    if ((Get-Sha256Hex ([string]$config.node_runtime_path)) -ne [string]$config.node_runtime_sha256) {
        throw "NATIVE_WAKEUP_NODE_RUNTIME_IDENTITY_MISMATCH"
    }
    if ((Get-Sha256Hex $entrypointPath) -ne [string]$config.payload_sha256.entrypoint) {
        throw "NATIVE_WAKEUP_ENTRYPOINT_IDENTITY_MISMATCH"
    }
    Write-NativeWakeupOperationalEvent "PAYLOAD_VALIDATED"
    Write-NativeWakeupOperationalEvent "ONE_SHOT_STARTED"
    $nativeOutput = @(& ([string]$config.node_runtime_path) $entrypointPath 2>$null)
    $nativeExitCode = $LASTEXITCODE
    if ($nativeExitCode -ne 0) {
        $substage = Resolve-NativeWakeupFailureSubstage -Output $nativeOutput
        Write-NativeWakeupOperationalEvent ("SUBSTAGE:{0}" -f $substage)
        throw "NATIVE_WAKEUP_ONE_SHOT_FAILED"
    }
    Write-NativeWakeupOperationalEvent "ONE_SHOT_EXIT_0"
    exit 0
}
catch {
    $failureMarker = [string]$_.Exception.Message
    if (-not $preOwnerComplete -and (Get-Command Write-NativeWakeupPreOwnerFailure -ErrorAction SilentlyContinue)) {
        $null = Write-NativeWakeupPreOwnerFailure -Substage $failureMarker
    }
    try { Write-NativeWakeupOperationalEvent "ONE_SHOT_FAILED" } catch { }
    exit 1
}
