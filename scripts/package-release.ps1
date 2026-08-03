[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $PSCommandPath
$projectRoot = Split-Path -Parent $scriptRoot
if ([String]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $projectRoot 'release' }
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$releaseName = "CodexRemotePWA-$($manifest.version)-win64"
$archivePath = Join-Path $OutputDirectory "$releaseName.zip"
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-remote-release-" + [Guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $stagingRoot $releaseName
$tailscaleInstallerRelativePath = 'installers\tailscale-setup-1.98.10.exe'
$tailscaleInstallerSha256 = '3AC2CEABAF5FFF67CECAA02D597ED1FB419FC890F33AC6C53A6C8339B1E35952'

# Consumer ZIP profile: only runtime files, README.md, and 教程.md are distributed.
$files = @(
    'CodexRemoteConsole.exe',
    'CodexRemoteSetup.exe',
    'README.md',
    'server.mjs',
    'Start-CodexRemotePWA.cmd',
    '教程.md'
)
$directories = @('public')
$scriptFiles = @(
    'bootstrap-codex-api-auth.mjs',
    'codex-remote-client.ps1',
    'manage-tailscale.ps1',
    'start-codex-remote.ps1'
)

try {
    New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

    foreach ($file in $files) {
        $source = Join-Path $projectRoot $file
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release file is missing: $file" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $releaseRoot $file)
    }
    $tailscaleInstallerSource = Join-Path $projectRoot $tailscaleInstallerRelativePath
    if (-not (Test-Path -LiteralPath $tailscaleInstallerSource -PathType Leaf)) { throw "Tailscale installer is missing: $tailscaleInstallerRelativePath" }
    $tailscaleInstallerHash = (Get-FileHash -LiteralPath $tailscaleInstallerSource -Algorithm SHA256).Hash
    if ($tailscaleInstallerHash -ne $tailscaleInstallerSha256) { throw 'Tailscale installer SHA-256 does not match the approved release artifact.' }
    $tailscaleInstallerDestination = Join-Path $releaseRoot $tailscaleInstallerRelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $tailscaleInstallerDestination) | Out-Null
    Copy-Item -LiteralPath $tailscaleInstallerSource -Destination $tailscaleInstallerDestination
    $releaseEnvSource = Join-Path $projectRoot 'scripts\release-default.env'
    if (-not (Test-Path -LiteralPath $releaseEnvSource -PathType Leaf)) { throw 'Release environment defaults are missing.' }
    $releaseEnv = Get-Content -Raw -Encoding UTF8 $releaseEnvSource
    $requiredDefaults = @('REMOTE_PASSWORD=replace-with-a-long-random-password', 'WORKSPACE_ROOT=.', 'HOST=127.0.0.1', 'PORT=8787')
    foreach ($default in $requiredDefaults) {
        if ($releaseEnv -notmatch [Regex]::Escape($default)) { throw "Release environment default is missing: $default" }
    }
    Copy-Item -LiteralPath $releaseEnvSource -Destination (Join-Path $releaseRoot '.env')
    foreach ($directory in $directories) {
        $source = Join-Path $projectRoot $directory
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Release directory is missing: $directory" }
        Copy-Item -LiteralPath $source -Destination $releaseRoot -Recurse
    }
    $releaseScripts = Join-Path $releaseRoot 'scripts'
    New-Item -ItemType Directory -Force -Path $releaseScripts | Out-Null
    foreach ($scriptFile in $scriptFiles) {
        $source = Join-Path $projectRoot (Join-Path 'scripts' $scriptFile)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release script is missing: $scriptFile" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $releaseScripts $scriptFile)
    }
    $releaseManifest = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
    $releaseManifest.scripts.PSObject.Properties.Remove('package:release')
    $releaseManifest.scripts.PSObject.Properties.Remove('test')
    $releaseManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $releaseRoot 'package.json') -Encoding UTF8

    if (Test-Path -LiteralPath $archivePath -PathType Leaf) { Remove-Item -LiteralPath $archivePath -Force }
    Compress-Archive -LiteralPath $releaseRoot -DestinationPath $archivePath -CompressionLevel Optimal

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $defaultEnvEntry = "$releaseName/.env"
        $forbidden = @('(^|/)data/', '(^|/)node_modules/', '(^|/)\.git/', '(^|/)test/')
        foreach ($entry in $archive.Entries) {
            $entryPath = $entry.FullName.Replace('\', '/')
            if ($entryPath -match '(^|/)\.env($|/)' -and $entryPath -ne $defaultEnvEntry) { throw "Forbidden release environment file: $($entry.FullName)" }
            foreach ($pattern in $forbidden) {
                if ($entryPath -match $pattern) { throw "Forbidden release entry: $($entry.FullName)" }
            }
        }
        $releaseDocs = @("$releaseName/README.md", "$releaseName/教程.md")
        $requiredReleaseEntries = @("$releaseName/.env", "$releaseName/CodexRemoteConsole.exe", "$releaseName/CodexRemoteSetup.exe", "$releaseName/Start-CodexRemotePWA.cmd", "$releaseName/server.mjs", "$releaseName/installers/tailscale-setup-1.98.10.exe", "$releaseName/public/app.js", "$releaseName/scripts/codex-remote-client.ps1", "$releaseName/scripts/manage-tailscale.ps1")
        $archiveEntries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        $allowedReleaseEntries = @(
            "$releaseName/.env",
            "$releaseName/CodexRemoteConsole.exe",
            "$releaseName/CodexRemoteSetup.exe",
            "$releaseName/package.json",
            "$releaseName/README.md",
            "$releaseName/server.mjs",
            "$releaseName/Start-CodexRemotePWA.cmd",
            "$releaseName/教程.md",
            "$releaseName/installers/tailscale-setup-1.98.10.exe",
            "$releaseName/public/app.js",
            "$releaseName/public/icon.svg",
            "$releaseName/public/index.html",
            "$releaseName/public/manifest.webmanifest",
            "$releaseName/public/styles.css",
            "$releaseName/public/sw.js",
            "$releaseName/scripts/bootstrap-codex-api-auth.mjs",
            "$releaseName/scripts/codex-remote-client.ps1",
            "$releaseName/scripts/manage-tailscale.ps1",
            "$releaseName/scripts/start-codex-remote.ps1"
        )
        $unexpectedReleaseEntries = @($archiveEntries | Where-Object { $_ -notin $allowedReleaseEntries })
        if ($unexpectedReleaseEntries.Count -gt 0) { throw "Unexpected release entries: $($unexpectedReleaseEntries -join ', ')" }
        foreach ($requiredEntry in $requiredReleaseEntries) {
            if ($archiveEntries -notcontains $requiredEntry) { throw "Required release entry is missing: $requiredEntry" }
        }
        $tailscaleArchiveEntry = @($archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq "$releaseName/installers/tailscale-setup-1.98.10.exe" })
        if ($tailscaleArchiveEntry.Count -ne 1) { throw 'Tailscale installer entry is missing or ambiguous.' }
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $installerStream = $tailscaleArchiveEntry[0].Open()
            try { $tailscaleArchiveHash = ([BitConverter]::ToString($sha256.ComputeHash($installerStream))).Replace('-', '') }
            finally { $installerStream.Dispose() }
        }
        finally { $sha256.Dispose() }
        if ($tailscaleArchiveHash -ne $tailscaleInstallerSha256) { throw 'Tailscale installer changed while creating the release archive.' }
        foreach ($entry in $archive.Entries) {
            $entryPath = $entry.FullName.Replace('\', '/')
            if ($entryPath -match '\.md$' -and $releaseDocs -notcontains $entryPath) { throw "Unexpected release document: $($entry.FullName)" }
        }
    }
    finally {
        $archive.Dispose()
    }

    Write-Host "Created release archive: $archivePath"
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
}
