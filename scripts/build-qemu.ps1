#!/usr/bin/env pwsh
# Build/download a portable QEMU for Windows (WHPX-enabled).
# Output: sandbox/resources/qemu/win32/qemu-system-x86_64.exe + DLLs + pc-bios/
Set-StrictMode -Version 3
$ErrorActionPreference = "Stop"

$repoRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "sandbox"
$win32Dir = Join-Path $repoRoot "resources" "qemu" "win32"
$pcbiosDir = Join-Path $win32Dir "pc-bios"

Write-Output "==> Ensuring output directories exist"
New-Item -ItemType Directory -Force $win32Dir | Out-Null
New-Item -ItemType Directory -Force $pcbiosDir | Out-Null

# Prefer scoop-managed QEMU if available (fast, no download)
$scoopQemu = Join-Path $env:USERPROFILE "scoop" "apps" "qemu" "current"
if (Test-Path (Join-Path $scoopQemu "qemu-system-x86_64.exe")) {
    Write-Output "==> Copying QEMU from Scoop install at $scoopQemu"
    Copy-Item (Join-Path $scoopQemu "qemu-system-x86_64.exe") $win32Dir -Force
    Copy-Item (Join-Path $scoopQemu "*.dll") $win32Dir -Force
    Copy-Item (Join-Path $scoopQemu "share" "*.bin") $pcbiosDir -Force
    Copy-Item (Join-Path $scoopQemu "share" "*.fd") $pcbiosDir -Force
    Copy-Item (Join-Path $scoopQemu "share" "*.rom") $pcbiosDir -Force
    Copy-Item (Join-Path $scoopQemu "share" "*.img") $pcbiosDir -Force
    Write-Output "==> done"
    exit 0
}

# Otherwise, download the QEMU for Windows installer from qemu.weilnetz.de
$installerUrl = "https://qemu.weilnetz.de/w64/qemu-w64-setup-20260501.exe"
$installerPath = Join-Path $env:TEMP "qemu-w64-setup-20260501.exe"

if (-not (Test-Path $installerPath)) {
    Write-Output "==> Downloading QEMU for Windows (190 MB)..."
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath
}

Write-Output "==> Extracting QEMU (using 7-Zip via Scoop's dl.7z approach)"
# The installer is an NSIS archive with an embedded 7z payload.
# Rename and extract with 7-Zip.
$extractDir = Join-Path $env:TEMP "qemu-extract-tmp"
Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $extractDir | Out-Null

# First extract the NSIS wrapper to get 1.Install.exe
# Then rename 1.Install.exe to .7z and extract

# Simpler: use 7z with -t# for NSIS
7z x -t# "-o$extractDir" $installerPath -y | Out-Null

# The extracted 1.Install.exe is a 7z SFX; rename and extract
$installExe = Join-Path $extractDir "1.Install.exe"
$install7z = Join-Path $extractDir "1.Install.7z"
if (Test-Path $installExe) {
    Rename-Item $installExe $install7z -Force
    7z x "-o$extractDir\out" $install7z -y | Out-Null
}

# Copy files from extracted output
$outDir = Join-Path $extractDir "out"
if (Test-Path (Join-Path $outDir "qemu-system-x86_64.exe")) {
    Copy-Item (Join-Path $outDir "qemu-system-x86_64.exe") $win32Dir -Force
    Copy-Item (Join-Path $outDir "*.dll") $win32Dir -Force
    $shareDir = Join-Path $outDir "share"
    if (Test-Path $shareDir) {
        Copy-Item (Join-Path $shareDir "*.bin") $pcbiosDir -Force
        Copy-Item (Join-Path $shareDir "*.fd") $pcbiosDir -Force
        Copy-Item (Join-Path $shareDir "*.rom") $pcbiosDir -Force
        Copy-Item (Join-Path $shareDir "*.img") $pcbiosDir -Force
    }
}

Write-Output "==> done"
Write-Output "  $( (Get-Item (Join-Path $win32Dir 'qemu-system-x86_64.exe')).Length / 1MB -as [int] ) MB qemu-system-x86_64.exe"
Write-Output "  $( (Get-ChildItem $win32Dir -Filter '*.dll').Count ) DLLs"
Write-Output "  $( (Get-ChildItem $pcbiosDir).Count ) firmware files"
