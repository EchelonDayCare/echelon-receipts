# download-ffmpeg.ps1 — fetch the LGPL FFmpeg sidecar binaries for Echelon
# Daycare's Graduation Day feature.
#
# Windows: BtbN's LGPL win64 build (h264_mf, no x264/x265).
# macOS aarch64: fetched from our own GitHub Actions release (self-built LGPL
# arm64 binary — no trusted public source publishes one).
#
# Idempotent: skips download if the binary already exists and matches the
# expected SHA-256. Verifies checksum before placing the file so a partial
# or tampered download never lands in src-tauri/binaries/.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/download-ffmpeg.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/download-ffmpeg.ps1 -Platform windows
#   powershell -ExecutionPolicy Bypass -File scripts/download-ffmpeg.ps1 -Platform mac
[CmdletBinding()]
param(
  [ValidateSet('auto','windows','mac')]
  [string]$Platform = 'auto',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path -Parent $PSScriptRoot
$binDir     = Join-Path $repoRoot 'src-tauri\binaries'
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Force -Path $binDir | Out-Null }

# ─── Config ────────────────────────────────────────────────────────────
# BtbN publishes floating "latest" tag; we pin by SHA-256 to catch supply-
# chain changes. Bump this table when refreshing the build.
$WIN_URL    = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'
$WIN_SHA256 = '4cf2fd830abfcfb5c32b0c366e36f7be38fd7b3f92838fe5701815dbdfc892d6'
$WIN_TARGET = 'ffmpeg-x86_64-pc-windows-msvc.exe'

# macOS arm64 comes from our own private GH release (LGPL FFmpeg for Apple
# Silicon — no trusted public LGPL arm64 build exists). The release lives
# on the private repo, so the asset requires GitHub auth to download. We
# use `gh release download` (via the caller's `gh auth` token) rather than
# Invoke-WebRequest+URL to avoid embedding credentials.
$MAC_REPO   = 'EchelonDayCare/echelon-receipts'
$MAC_TAG    = 'ffmpeg-mac-20260710-n7.1'
$MAC_SHA256 = '3105165d86868e1085244fac3622ac1b466057f06eafe9e41b0aca20d2926441'
$MAC_TARGET = 'ffmpeg-aarch64-apple-darwin'

# ─── Helpers ───────────────────────────────────────────────────────────
function Get-Sha256([string]$Path) {
  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
}
function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
  if (-not $Expected) {
    Write-Warning "$Label — no expected SHA-256 configured; skipping verification."
    return
  }
  $actual = Get-Sha256 $Path
  if ($actual -ne $Expected.ToLower()) {
    throw "$Label — SHA-256 mismatch. Expected $Expected, got $actual. Refusing to place tampered binary."
  }
  Write-Host "$Label — SHA-256 OK ($actual)"
}
function Test-BinaryFresh([string]$Path, [string]$ExpectedSha) {
  if ($Force) { return $false }
  if (-not (Test-Path $Path)) { return $false }
  if (-not $ExpectedSha) { return $true }  # can't verify → assume good
  return (Get-Sha256 $Path) -eq $ExpectedSha.ToLower()
}

# ─── Windows ───────────────────────────────────────────────────────────
function Fetch-Windows {
  $dest = Join-Path $binDir $WIN_TARGET
  if (Test-BinaryFresh $dest $WIN_SHA256) {
    Write-Host "Windows FFmpeg already present ($WIN_TARGET). Skipping."
    return
  }
  $tmpZip = Join-Path $env:TEMP "ffmpeg-win64-lgpl-$(Get-Random).zip"
  Write-Host "Downloading Windows FFmpeg from $WIN_URL"
  Invoke-WebRequest -Uri $WIN_URL -OutFile $tmpZip -UseBasicParsing
  Assert-Sha256 $tmpZip $WIN_SHA256 'BtbN zip'

  $tmpDir = Join-Path $env:TEMP "ffmpeg-win64-extract-$(Get-Random)"
  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
  $exe = Get-ChildItem -Path $tmpDir -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
  if (-not $exe) { throw 'ffmpeg.exe not found in extracted archive' }
  Copy-Item -Path $exe.FullName -Destination $dest -Force
  Remove-Item $tmpZip -Force
  Remove-Item $tmpDir -Recurse -Force

  $sz = [math]::Round((Get-Item $dest).Length / 1MB, 1)
  Write-Host "Placed $WIN_TARGET ($sz MB)"

  # Verify it actually runs and has the encoder we need.
  $enc = & $dest -hide_banner -encoders 2>&1
  if ($enc -notmatch 'h264_mf') { throw 'Downloaded binary missing h264_mf encoder' }
  if ($enc -match 'libx264')   { throw 'Downloaded binary has libx264 — expected LGPL build' }
  Write-Host 'Windows FFmpeg verified: h264_mf present, libx264 absent.'
}

# ─── macOS ─────────────────────────────────────────────────────────────
function Fetch-Mac {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "gh CLI required for the private mac release. Install from https://cli.github.com and run 'gh auth login'."
  }
  $dest = Join-Path $binDir $MAC_TARGET
  if (Test-BinaryFresh $dest $MAC_SHA256) {
    Write-Host "macOS FFmpeg already present ($MAC_TARGET). Skipping."
    return
  }
  $tmpDir = Join-Path $env:TEMP "ffmpeg-mac-$(Get-Random)"
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  Write-Host "Downloading macOS FFmpeg from $MAC_REPO @ $MAC_TAG"
  & gh release download $MAC_TAG -R $MAC_REPO -p $MAC_TARGET -D $tmpDir
  if ($LASTEXITCODE -ne 0) { throw "gh release download failed with exit $LASTEXITCODE" }
  $tmp = Join-Path $tmpDir $MAC_TARGET
  Assert-Sha256 $tmp $MAC_SHA256 'macOS ffmpeg'
  Copy-Item -Path $tmp -Destination $dest -Force
  Remove-Item $tmpDir -Recurse -Force
  $sz = [math]::Round((Get-Item $dest).Length / 1MB, 1)
  Write-Host "Placed $MAC_TARGET ($sz MB)"
}

# ─── Main ──────────────────────────────────────────────────────────────
switch ($Platform) {
  'windows' { Fetch-Windows }
  'mac'     { Fetch-Mac }
  default {
    # 'auto' — always try Windows on Windows; only try mac if gh is installed.
    if ($IsWindows -or $PSVersionTable.Platform -ne 'Unix') { Fetch-Windows }
    if (Get-Command gh -ErrorAction SilentlyContinue) { Fetch-Mac }
  }
}
