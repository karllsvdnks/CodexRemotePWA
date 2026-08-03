$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = 'D:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) {
  $nodePath = (Get-Command node -ErrorAction Stop).Source
}

Set-Location -LiteralPath $projectRoot
Write-Host "Starting Codex Remote PWA. Press Ctrl+C or close this window to stop it."
& $nodePath (Join-Path $projectRoot 'server.mjs')
