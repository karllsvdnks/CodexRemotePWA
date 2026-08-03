param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Start', 'Stop')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator approval is required to manage the Tailscale service.'
}

if ($Action -eq 'Start') {
  Start-Service -Name Tailscale
} else {
  Stop-Service -Name Tailscale
}
