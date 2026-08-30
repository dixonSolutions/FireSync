<#
.SYNOPSIS
  Install the FireSync bridge for the current user on Windows.

.DESCRIPTION
  Writes the native messaging host manifest and registers it under HKCU. Nothing
  is installed machine-wide and nothing needs administrator rights.

.EXAMPLE
  .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
  .\install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.firesync.bridge'
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path

$RegistryRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)

if ($Uninstall) {
  foreach ($root in $RegistryRoots) {
    $key = Join-Path $root $HostName
    if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Host "removed $key" }
  }
  Remove-Item (Join-Path $Here 'host.cmd') -Force -ErrorAction SilentlyContinue
  Write-Host 'Bridge uninstalled. FireSync keeps working without it.'
  return
}

if (-not $ExtensionId) { throw 'Pass -ExtensionId (find it at chrome://extensions).' }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'node is not on PATH; the bridge needs Node 22.5 or newer.' }

# Chrome requires an executable, so wrap the script in a .cmd shim.
$shim = Join-Path $Here 'host.cmd'
"@echo off`r`nnode `"%~dp0host.mjs`" %*" | Set-Content -Path $shim -Encoding ASCII

$manifestPath = Join-Path $Here "$HostName.json"
@{
  name           = $HostName
  description    = 'FireSync bridge - local Firefox profile import, OS keychain, loopback OAuth'
  path           = $shim
  type           = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

foreach ($root in $RegistryRoots) {
  $browserRoot = Split-Path -Parent $root
  if (-not (Test-Path $browserRoot)) { continue }
  $key = Join-Path $root $HostName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  Write-Host "registered $key"
}

Write-Host ''
Write-Host 'Checking the host runs:'
& node (Join-Path $Here 'host.mjs') --self-test | Select-Object -Last 3
Write-Host ''
Write-Host "Now open FireSync's settings and turn on the local bridge."
