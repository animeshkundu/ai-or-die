#!/usr/bin/env bash
# Build the aiordie-mesh tsnet sidecar for all platforms and self-sign on
# Windows. Output: dist/mesh/<os>-<arch>/aiordie-mesh[.exe]. ai-or-die fetches
# the matching binary into %LOCALAPPDATA%/ai-or-die/bin and supervises it.
set -euo pipefail
cd "$(dirname "$0")/../mesh"
out="../dist/mesh"; mkdir -p "$out"
build() { GOOS=$1 GOARCH=$2 go build -ldflags='-s -w' -o "$out/$1-$2/aiordie-mesh$3" .; echo "built $1-$2"; }
build windows amd64 .exe
build windows arm64 .exe
build linux   amd64 ""
build linux   arm64 ""
build darwin  amd64 ""
build darwin  arm64 ""
# Self-sign Windows binaries for fleet reputation (cert imported on enroll).
if command -v signtool >/dev/null 2>&1 && [ -n "${AIORDIE_SIGN_PFX:-}" ]; then
  for b in "$out"/windows-*/aiordie-mesh.exe; do
    signtool sign /f "$AIORDIE_SIGN_PFX" /p "${AIORDIE_SIGN_PW:-}" /fd sha256 "$b" && echo "signed $b"
  done
else
  echo "signtool/cert absent — shipping unsigned (runs, but no SmartScreen reputation)"
fi
