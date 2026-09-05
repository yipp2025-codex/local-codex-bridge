Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The owner authority is deployment-local configuration, never an artifact ACL
# owner and never a caller-provided identity.
$script:DeploymentOwnerIdentityConfigPath = Join-Path $PSScriptRoot "config\deployment-owner.env"
$script:OwnerIdentityTestMode = $false
$script:DeploymentOwnerSidOverride = $null
$script:CurrentWindowsSidOverride = $null

function Get-DeploymentOwnerIdentityConfigPath {
    return $script:DeploymentOwnerIdentityConfigPath
}

function ConvertTo-CanonicalDeploymentOwnerSid {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$SidText
    )

    if ([string]::IsNullOrWhiteSpace($SidText)) {
        throw "DEPLOYMENT_OWNER_SID_MISSING"
    }

    $candidate = $SidText.Trim()
    if ($candidate -notmatch '^S-\d-\d+(?:-\d+)+$') {
        throw "DEPLOYMENT_OWNER_SID_MALFORMED"
    }

    try {
        $sid = New-Object -TypeName System.Security.Principal.SecurityIdentifier -ArgumentList $candidate
        return [string]$sid.Value
    }
    catch {
        throw "DEPLOYMENT_OWNER_SID_MALFORMED"
    }
}

function Read-DeploymentOwnerSidFromFixedConfig {
    $path = Get-DeploymentOwnerIdentityConfigPath
    if (-not [System.IO.File]::Exists($path)) {
        throw "DEPLOYMENT_OWNER_CONFIG_MISSING"
    }

    try {
        $configuredSid = $null
        foreach ($line in [System.IO.File]::ReadAllLines($path)) {
            $trimmed = $line.Trim()
            if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
                continue
            }

            $match = [System.Text.RegularExpressions.Regex]::Match(
                $trimmed,
                '^STATEFUL_RELAY_DEPLOYMENT_OWNER_SID=(.+)$'
            )
            if (-not $match.Success -or $null -ne $configuredSid) {
                throw "DEPLOYMENT_OWNER_CONFIG_MALFORMED"
            }
            $configuredSid = $match.Groups[1].Value.Trim()
        }

        if ([string]::IsNullOrWhiteSpace($configuredSid)) {
            throw "DEPLOYMENT_OWNER_CONFIG_MISSING"
        }
        return ConvertTo-CanonicalDeploymentOwnerSid $configuredSid
    }
    catch {
        if ($_.Exception.Message -in @(
                "DEPLOYMENT_OWNER_CONFIG_MISSING",
                "DEPLOYMENT_OWNER_CONFIG_MALFORMED",
                "DEPLOYMENT_OWNER_SID_MISSING",
                "DEPLOYMENT_OWNER_SID_MALFORMED"
            )) {
            throw
        }
        throw "DEPLOYMENT_OWNER_CONFIG_MALFORMED"
    }
}

function Read-FrozenDeploymentOwnerSid {
    if ($script:OwnerIdentityTestMode -and $null -ne $script:DeploymentOwnerSidOverride) {
        $overrideSid = & $script:DeploymentOwnerSidOverride
        if ($null -eq $overrideSid) {
            throw "DEPLOYMENT_OWNER_CONFIG_MISSING"
        }
        return ConvertTo-CanonicalDeploymentOwnerSid $overrideSid
    }

    return Read-DeploymentOwnerSidFromFixedConfig
}

function Get-CurrentWindowsTokenSid {
    if ($script:OwnerIdentityTestMode -and $null -ne $script:CurrentWindowsSidOverride) {
        $overrideSid = & $script:CurrentWindowsSidOverride
        if ($null -eq $overrideSid) {
            throw "DEPLOYMENT_OWNER_TOKEN_UNAVAILABLE"
        }
        return ConvertTo-CanonicalDeploymentOwnerSid $overrideSid
    }

    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity -or $null -eq $identity.User) {
            throw "token SID unavailable"
        }
        return ConvertTo-CanonicalDeploymentOwnerSid $identity.User.Value
    }
    catch {
        if ($_.Exception.Message -eq "DEPLOYMENT_OWNER_SID_MALFORMED") {
            throw
        }
        throw "DEPLOYMENT_OWNER_TOKEN_UNAVAILABLE"
    }
}

function Test-DeploymentOwnerIdentity {
    $expectedSid = Read-FrozenDeploymentOwnerSid
    $currentSid = Get-CurrentWindowsTokenSid
    return [string]::Equals($expectedSid, $currentSid, [System.StringComparison]::Ordinal)
}
