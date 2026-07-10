#!/usr/bin/env bash
# Bootstraps libheif on macOS via Homebrew. Idempotent.
#
# Usage:  bash scripts/setup-libheif-mac.sh
#
# On Apple Silicon (M1/M2/M3), Homebrew installs to /opt/homebrew.
# On Intel Macs, it installs to /usr/local.
# Both paths are detected below.

set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not found. Install from https://brew.sh first." >&2
    exit 1
fi

if ! brew list libheif >/dev/null 2>&1; then
    echo "Installing libheif via brew..."
    # NOTE: brew's libheif formula pulls in x265 (GPL-2.0) as a runtime
    # dep for HEVC encoding. That's fine on dev machines. For a shipped
    # binary we build libheif from source WITHOUT x265 (see
    # .github/workflows/build-ffmpeg-mac.yml's libheif step); this dev
    # setup only powers `cargo build` on the developer's machine.
    brew install libheif
else
    echo "libheif already installed via brew."
fi

BREW_PREFIX="$(brew --prefix)"
LIBHEIF_PREFIX="$(brew --prefix libheif)"

INC_DIR="${LIBHEIF_PREFIX}/include"
LIB_DIR="${LIBHEIF_PREFIX}/lib"

if [[ ! -f "${LIB_DIR}/libheif.dylib" ]]; then
    echo "libheif.dylib not at ${LIB_DIR}. brew install may have failed." >&2
    exit 1
fi

ENV_FILE="$(dirname "$0")/.env.mac"
cat > "${ENV_FILE}" <<EOF
export LIBHEIF_INCLUDE_DIR="${INC_DIR}"
export LIBHEIF_LIB_DIR="${LIB_DIR}"
export PKG_CONFIG_PATH="${LIBHEIF_PREFIX}/lib/pkgconfig:${BREW_PREFIX}/lib/pkgconfig:\${PKG_CONFIG_PATH:-}"
EOF

echo ""
echo "libheif installed."
echo "  Include: ${INC_DIR}"
echo "  Lib:     ${LIB_DIR}"
echo ""
echo "Environment file written to: ${ENV_FILE}"
echo "Source it before building:  source ${ENV_FILE}"
