#!/usr/bin/env bash
# download-ffmpeg.sh — fetch LGPL FFmpeg sidecar binaries for macOS + Windows.
# See scripts/download-ffmpeg.ps1 for the Windows-native version.
set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────
WIN_URL='https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'
WIN_SHA256='4cf2fd830abfcfb5c32b0c366e36f7be38fd7b3f92838fe5701815dbdfc892d6'
WIN_TARGET='ffmpeg-x86_64-pc-windows-msvc.exe'

# macOS arm64 comes from our own private GH release (LGPL FFmpeg for
# Apple Silicon — no trusted public LGPL arm64 build exists). The release
# is on the private repo, so the asset requires GitHub auth to download.
# We use `gh release download` which uses the caller's `gh auth` token,
# rather than curl+URL, to avoid embedding credentials.
MAC_REPO='EchelonDayCare/echelon-receipts'
MAC_TAG='ffmpeg-mac-20260710-n7.1'
MAC_SHA256='3105165d86868e1085244fac3622ac1b466057f06eafe9e41b0aca20d2926441'
MAC_TARGET='ffmpeg-aarch64-apple-darwin'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$repo_root/src-tauri/binaries"
mkdir -p "$bin_dir"

# ─── Helpers ────────────────────────────────────────────────────────────
sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}
assert_sha256() {
  local path="$1" expected="$2" label="$3"
  if [ -z "$expected" ]; then
    echo "warn: $label — no expected SHA-256 configured; skipping verification." >&2
    return 0
  fi
  local actual; actual="$(sha256 "$path")"
  if [ "$actual" != "$expected" ]; then
    echo "error: $label — SHA-256 mismatch. Expected $expected, got $actual." >&2
    return 1
  fi
  echo "$label — SHA-256 OK ($actual)"
}
fresh() {
  local path="$1" expected="$2"
  [ -n "${FORCE:-}" ] && return 1
  [ -f "$path" ] || return 1
  [ -z "$expected" ] && return 0
  [ "$(sha256 "$path")" = "$expected" ]
}

# ─── Windows ────────────────────────────────────────────────────────────
fetch_windows() {
  local dest="$bin_dir/$WIN_TARGET"
  if fresh "$dest" "$WIN_SHA256"; then
    echo "Windows FFmpeg already present ($WIN_TARGET). Skipping."
    return 0
  fi
  local tmpzip; tmpzip="$(mktemp -t ffmpeg-win.XXXXXX).zip"
  echo "Downloading Windows FFmpeg from $WIN_URL"
  curl -fL "$WIN_URL" -o "$tmpzip"
  assert_sha256 "$tmpzip" "$WIN_SHA256" 'BtbN zip'
  local tmpdir; tmpdir="$(mktemp -d -t ffmpeg-win-extract.XXXXXX)"
  unzip -q "$tmpzip" -d "$tmpdir"
  local exe; exe="$(find "$tmpdir" -name 'ffmpeg.exe' | head -n1)"
  [ -n "$exe" ] || { echo "error: ffmpeg.exe not in archive" >&2; return 1; }
  cp -f "$exe" "$dest"
  rm -f "$tmpzip"; rm -rf "$tmpdir"
  local sz; sz="$(du -m "$dest" | awk '{print $1}')"
  echo "Placed $WIN_TARGET (${sz} MB)"
}

# ─── macOS ──────────────────────────────────────────────────────────────
fetch_mac() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "error: gh CLI required for the private mac release. Install with 'brew install gh' and 'gh auth login'." >&2
    return 1
  fi
  local dest="$bin_dir/$MAC_TARGET"
  if fresh "$dest" "$MAC_SHA256"; then
    echo "macOS FFmpeg already present ($MAC_TARGET). Skipping."
    return 0
  fi
  local tmpdir; tmpdir="$(mktemp -d -t ffmpeg-mac.XXXXXX)"
  echo "Downloading macOS FFmpeg from $MAC_REPO @ $MAC_TAG"
  gh release download "$MAC_TAG" -R "$MAC_REPO" -p "$MAC_TARGET" -D "$tmpdir"
  local tmp="$tmpdir/$MAC_TARGET"
  assert_sha256 "$tmp" "$MAC_SHA256" 'macOS ffmpeg'
  cp -f "$tmp" "$dest"
  chmod +x "$dest"
  rm -rf "$tmpdir"
  local sz; sz="$(du -m "$dest" | awk '{print $1}')"
  echo "Placed $MAC_TARGET (${sz} MB)"
}

case "${1:-auto}" in
  windows) fetch_windows ;;
  mac|macos|darwin) fetch_mac ;;
  auto|'')
    case "$(uname -s)" in
      Darwin) fetch_mac ;;
      Linux|MINGW*|MSYS*|CYGWIN*) fetch_windows ;;
      *) fetch_windows ;;
    esac
    ;;
  *) echo "usage: $0 [auto|windows|mac]" >&2; exit 2 ;;
esac
