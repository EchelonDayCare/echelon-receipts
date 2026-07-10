# Bootstraps libheif on Windows for building the Echelon Daycare app.
# Uses vcpkg (Microsoft's C/C++ package manager). Idempotent.
#
# Usage:  pwsh -File scripts/setup-libheif-windows.ps1
#
# What this does:
#   1. Clones vcpkg into %USERPROFILE%\vcpkg if not present
#   2. Bootstraps vcpkg
#   3. Installs libheif:x64-windows-static-md (matches Rust's default MSVC CRT)
#   4. Emits environment variables (LIBHEIF_LIB_DIR / LIBHEIF_INCLUDE_DIR) to
#      the current session AND to a scripts/.env.windows file so subsequent
#      `cargo build` invocations pick them up.
#
# Rebuilding after Windows update / vcpkg update:
#   cd $env:USERPROFILE\vcpkg; git pull; .\bootstrap-vcpkg.bat; .\vcpkg upgrade --no-dry-run

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$vcpkgRoot = Join-Path $env:USERPROFILE 'vcpkg'
$triplet   = 'x64-windows-static-md'

if (-not (Test-Path $vcpkgRoot)) {
    Write-Host "Cloning vcpkg into $vcpkgRoot ..."
    git clone --depth 1 https://github.com/microsoft/vcpkg.git $vcpkgRoot
} else {
    Write-Host "vcpkg already present at $vcpkgRoot"
}

if (-not (Test-Path (Join-Path $vcpkgRoot 'vcpkg.exe'))) {
    Write-Host "Bootstrapping vcpkg ..."
    & (Join-Path $vcpkgRoot 'bootstrap-vcpkg.bat') -disableMetrics
    if ($LASTEXITCODE -ne 0) { throw "vcpkg bootstrap failed" }
}

Write-Host "Installing libheif:$triplet (this can take 5-15 minutes on first run) ..."
# IMPORTANT: `[core]` selects only the base library — decode via libde265
# (LGPL-3.0). We DO NOT enable the default `hevc` feature because that
# pulls in x265 (GPL-2.0-or-later), which would contaminate Echelon's
# proprietary binary once statically linked. Echelon only DECODES HEIC,
# so an encoder plugin is unnecessary.
& (Join-Path $vcpkgRoot 'vcpkg.exe') install "libheif[core]:$triplet"
if ($LASTEXITCODE -ne 0) { throw "vcpkg install libheif failed" }

$installed = Join-Path $vcpkgRoot "installed\$triplet"
$libDir    = Join-Path $installed 'lib'
$incDir    = Join-Path $installed 'include'

if (-not (Test-Path (Join-Path $libDir 'heif.lib'))) {
    throw "Expected $libDir\heif.lib but did not find it. Check vcpkg output."
}

# Emit to current shell
$env:LIBHEIF_LIB_DIR     = $libDir
$env:LIBHEIF_INCLUDE_DIR = $incDir
$env:VCPKG_ROOT          = $vcpkgRoot

# Persist for future shells
$envFile = Join-Path $PSScriptRoot '.env.windows'
@(
    "LIBHEIF_LIB_DIR=$libDir",
    "LIBHEIF_INCLUDE_DIR=$incDir",
    "VCPKG_ROOT=$vcpkgRoot"
) | Set-Content -Path $envFile -Encoding utf8

Write-Host ""
Write-Host "libheif installed."
Write-Host "  Include: $incDir"
Write-Host "  Lib:     $libDir"
Write-Host ""
Write-Host "Environment file written to: $envFile"
Write-Host "For a new terminal, run:"
Write-Host "  Get-Content $envFile | ForEach-Object { `$k,`$v = `$_ -split '=',2; [Environment]::SetEnvironmentVariable(`$k, `$v) }"
