<#
.SYNOPSIS
  Install the FireSync enterprise policy for Chrome on Windows.

.DESCRIPTION
  Writes the ExtensionSettings policy that installs FireSync from a self-hosted
  update manifest, and turns off Chrome's built-in password manager so the two
  do not both offer to save.

  Off-store installs require the device to be managed (AD / Entra ID / Chrome
  Enterprise Core). This script warns when it detects an unmanaged device
  rather than leaving you to wonder why nothing appeared.

.EXAMPLE
  .\Install-FireSyncPolicy.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop `
      -UpdateUrl https://example.com/firesync/update.xml
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$UpdateUrl
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an elevated PowerShell session.'
}

$domainJoined = (Get-CimInstance Win32_ComputerSystem).PartOfDomain
$cloudManaged = Test-Path 'HKLM:\SOFTWARE\Policies\Google\Chrome\CloudManagementEnrollmentToken'
if (-not $domainJoined -and -not $cloudManaged) {
  Write-Warning @'
This device is neither domain-joined nor enrolled in Chrome Enterprise Core.
Chrome will ACCEPT this policy but REFUSE to install an off-store extension.
See docs/DISTRIBUTION.md#windows: enrol the browser in Chrome Enterprise Core
(free), or load the unpacked build from chrome://extensions instead.
'@
}

$base = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
$key  = "$base\ExtensionSettings\$ExtensionId"

New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name 'installation_mode' -Value 'normal_installed' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'update_url'        -Value $UpdateUrl        -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'override_update_url' -Value 1               -PropertyType DWord  -Force | Out-Null
New-ItemProperty -Path $key -Name 'toolbar_pin'       -Value 'force_pinned'    -PropertyType String -Force | Out-Null

New-ItemProperty -Path $base -Name 'PasswordManagerEnabled'   -Value 0 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $base -Name 'AutofillAddressEnabled'   -Value 0 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $base -Name 'AutofillCreditCardEnabled' -Value 0 -PropertyType DWord -Force | Out-Null

Write-Host "Policy written. Restart Chrome, then check chrome://policy." -ForegroundColor Green
