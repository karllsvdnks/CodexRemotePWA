$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $PSCommandPath
$projectRoot = Split-Path -Parent $scriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $compiler)) {
  throw "C# compiler was not found: $compiler"
}

$clients = @(
  @{ Source = 'client\CodexRemoteConsole.cs'; Output = 'CodexRemoteConsole.exe' },
  @{ Source = 'client\CodexRemoteSetup.cs'; Output = 'CodexRemoteSetup.exe' }
)

foreach ($client in $clients) {
  $source = Join-Path $projectRoot $client.Source
  $output = Join-Path $projectRoot $client.Output
  if (-not (Test-Path -LiteralPath $source)) { throw "Client source was not found: $source" }
  & $compiler /nologo /target:winexe /out:$output /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.ServiceProcess.dll $source
  if ($LASTEXITCODE -ne 0) { throw "Codex Remote client compilation failed: $($client.Source)" }
  Write-Host "Created: $output"
}
