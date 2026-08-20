[CmdletBinding()]
param(
    [string]$Version = $(if ($env:CC_LHC_VERSION) { $env:CC_LHC_VERSION } else { "0.2.0" }),
    [string]$Prefix = $env:CC_LHC_PREFIX,
    [string]$InstallRoot = $env:CC_LHC_INSTALL_ROOT,
    [string]$AssetDir = $env:CC_LHC_ASSET_DIR,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$Repository = if ($env:CC_LHC_REPOSITORY) { $env:CC_LHC_REPOSITORY } else { "liminal-ai/long-horizon-context" }
if (-not $Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA "cc-lhc" }
if (-not $InstallRoot) { $InstallRoot = Join-Path $Prefix "packages" }
$BinDir = Join-Path $Prefix "bin"
$Launcher = Join-Path $BinDir "cc-lhc.cmd"
$Marker = Join-Path $InstallRoot ".cc-lhc-installer-managed"

function Fail([string]$Message) { throw "cc-lhc installer: $Message" }

function Remove-ManagedPathEntry([string]$PathEntry) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $UserPath) { return }
    $Entries = @($UserPath.Split(';') | Where-Object { $_ -and $_.TrimEnd('\') -ine $PathEntry.TrimEnd('\') })
    [Environment]::SetEnvironmentVariable("Path", ($Entries -join ';'), "User")
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $Launcher) {
        $LauncherText = Get-Content -LiteralPath $Launcher -Raw
        if ($LauncherText -notmatch 'managed by cc-lhc install.ps1') {
            Fail "$Launcher is not managed by this installer"
        }
        Remove-Item -LiteralPath $Launcher -Force
    }
    if ((Test-Path -LiteralPath $InstallRoot) -and -not (Test-Path -LiteralPath $Marker)) {
        Fail "$InstallRoot is not marked as installer-managed"
    }
    if (Test-Path -LiteralPath $InstallRoot) {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    }
    Remove-ManagedPathEntry $BinDir
    Write-Output "Removed the managed cc-lhc installation. User state was preserved."
    exit 0
}

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
    Fail "invalid version: $Version"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node 24.3 or later is required."
}
$NodeVersionText = (& node -p "process.versions.node").Trim()
if ($LASTEXITCODE -ne 0) { Fail "could not read the Node version." }
if ([System.Version]::Parse($NodeVersionText) -lt [System.Version]::Parse("24.3.0")) {
    Fail "Node 24.3 or later is required; found v$NodeVersionText."
}

$Target = (& node -p "process.platform + '-' + process.arch").Trim()
if ($LASTEXITCODE -ne 0) { Fail "could not identify the platform." }
if ($Target -notin @("win32-x64", "win32-arm64")) { Fail "unsupported platform $Target" }

if ((Test-Path -LiteralPath $InstallRoot) -and -not (Test-Path -LiteralPath $Marker)) {
    Fail "$InstallRoot exists but is not marked as installer-managed"
}
if (Test-Path -LiteralPath $Launcher) {
    $LauncherText = Get-Content -LiteralPath $Launcher -Raw
    if ($LauncherText -notmatch 'managed by cc-lhc install.ps1') {
        Fail "$Launcher already exists and is not managed by this installer"
    }
}

$BundleName = "cc-lhc-v$Version-$Target"
$Asset = "$BundleName.zip"
$Base = "https://github.com/$Repository/releases/download/cc-lhc-v$Version"
$InstallTemp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-lhc-install-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $InstallTemp | Out-Null

try {
    $Archive = Join-Path $InstallTemp $Asset
    $Checksums = Join-Path $InstallTemp "SHA256SUMS"
    if ($AssetDir) {
        $CandidateArchive = Join-Path $AssetDir $Asset
        $CandidateChecksums = Join-Path $AssetDir "SHA256SUMS"
        if (-not (Test-Path -LiteralPath $CandidateArchive -PathType Leaf)) { Fail "candidate directory is missing $Asset" }
        if (-not (Test-Path -LiteralPath $CandidateChecksums -PathType Leaf)) { Fail "candidate directory is missing SHA256SUMS" }
        Copy-Item -LiteralPath $CandidateArchive -Destination $Archive
        Copy-Item -LiteralPath $CandidateChecksums -Destination $Checksums
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile $Archive
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile $Checksums
    }

    $ChecksumLine = Get-Content -LiteralPath $Checksums | Where-Object { $_ -match "\s+$([regex]::Escape($Asset))$" } | Select-Object -First 1
    if (-not $ChecksumLine) { Fail "SHA256SUMS does not list $Asset" }
    $Expected = ($ChecksumLine -split '\s+')[0].ToLowerInvariant()
    $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { Fail "checksum mismatch for $Asset" }

    $ExtractRoot = Join-Path $InstallTemp "extract"
    Expand-Archive -LiteralPath $Archive -DestinationPath $ExtractRoot
    $Bundle = Join-Path $ExtractRoot $BundleName
    $ManifestPath = Join-Path $Bundle "release-manifest.json"
    $Entrypoint = Join-Path $Bundle "package\dist\bin.js"
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { Fail "archive is missing release-manifest.json" }
    if (-not (Test-Path -LiteralPath $Entrypoint -PathType Leaf)) { Fail "archive is missing the cc-lhc entrypoint" }

    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($Manifest.schemaVersion -ne 1 -or $Manifest.product -ne "cc-lhc" -or
        $Manifest.version -ne $Version -or $Manifest.target -ne $Target -or
        $Manifest.entrypoint -ne "package/dist/bin.js") {
        Fail "release manifest identity mismatch"
    }

    $PreviousNativeRequirement = $env:CC_LHC_NATIVE_REQUIRE_ADDON
    try {
        $env:CC_LHC_NATIVE_REQUIRE_ADDON = "1"
        & node $Entrypoint --lhc-help | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "downloaded runtime verification failed" }
    } finally {
        $env:CC_LHC_NATIVE_REQUIRE_ADDON = $PreviousNativeRequirement
    }

    New-Item -ItemType Directory -Path (Join-Path $InstallRoot "versions") -Force | Out-Null
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Set-Content -LiteralPath $Marker -Value "managed by cc-lhc install.ps1" -Encoding Ascii

    $Destination = Join-Path (Join-Path $InstallRoot "versions") "$Version-$Target"
    $Stage = "$Destination.tmp.$PID"
    if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
    Copy-Item -LiteralPath $Bundle -Destination $Stage -Recurse
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Move-Item -LiteralPath $Stage -Destination $Destination

    $InstalledEntrypoint = Join-Path $Destination "package\dist\bin.js"
    $EscapedEntrypoint = $InstalledEntrypoint.Replace('%', '%%')
    $LauncherText = "@echo off`r`nrem managed by cc-lhc install.ps1`r`nnode `"$EscapedEntrypoint`" %*`r`n"
    Set-Content -LiteralPath $Launcher -Value $LauncherText -Encoding Ascii -NoNewline

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $UserEntries = if ($UserPath) { @($UserPath.Split(';') | Where-Object { $_ }) } else { @() }
    if (-not ($UserEntries | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') })) {
        $NewUserPath = (@($BinDir) + $UserEntries) -join ';'
        [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
    }
    if (-not (($env:Path.Split(';')) | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') })) {
        $env:Path = "$BinDir;$env:Path"
    }

    try {
        $env:CC_LHC_NATIVE_REQUIRE_ADDON = "1"
        & $Launcher --lhc-help | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "installed launcher verification failed" }
    } finally {
        $env:CC_LHC_NATIVE_REQUIRE_ADDON = $PreviousNativeRequirement
    }

    Write-Output "Installed cc-lhc $Version for $Target."
    Write-Output "Command: $Launcher"
} finally {
    if (Test-Path -LiteralPath $InstallTemp) {
        Remove-Item -LiteralPath $InstallTemp -Recurse -Force
    }
}
