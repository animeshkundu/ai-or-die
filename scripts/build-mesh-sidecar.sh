#!/usr/bin/env bash
# Cross-build the aiordie-mesh tsnet sidecar for all supported platforms and
# emit SHA-256 checksums. Go cross-compiles from one runner, so this produces
# every target binary plus a checksums manifest the client verifies against.
#
# Output (uploaded to the GitHub release by release-on-main.yml):
#   dist/mesh/aiordie-mesh-<plat>-<arch>[.exe]
#   dist/mesh/aiordie-mesh-checksums.txt   ("<sha256>  <assetname>" per line)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

# Content hash (Go-free) identifies this sidecar build; stamp it into the binary
# so `aiordie-mesh --version` is traceable and the release tag is mesh-<hash>.
version="$(node "$root/scripts/mesh-lock.js" --print-hash)"
echo "mesh content hash: $version"

cd "$root/mesh"
out="$root/dist/mesh"; rm -rf "$out"; mkdir -p "$out"

go mod tidy   # generate go.sum for a reproducible build

emit() {  # <goos> <goarch> <plat> <arch> <ext>
  local name="aiordie-mesh-$3-$4$5"
  GOOS=$1 GOARCH=$2 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$version" -o "$out/$name" .
  echo "built $name"
}
emit windows amd64 windows amd64 .exe
emit windows arm64 windows arm64 .exe
emit linux   amd64 linux   amd64 ""
emit linux   arm64 linux   arm64 ""
emit darwin  amd64 darwin  amd64 ""
emit darwin  arm64 darwin  arm64 ""

# Self-sign Windows binaries when a cert is provided (fleet reputation).
if command -v signtool >/dev/null 2>&1 && [ -n "${AIORDIE_SIGN_PFX:-}" ]; then
  for b in "$out"/aiordie-mesh-windows-*; do
    signtool sign /f "$AIORDIE_SIGN_PFX" /p "${AIORDIE_SIGN_PW:-}" /fd sha256 "$b" && echo "signed $b"
  done
fi

( cd "$out" && sha256sum aiordie-mesh-* > aiordie-mesh-checksums.txt )
echo "checksums:"; cat "$out/aiordie-mesh-checksums.txt"

# Finalize the lock with the freshly-built per-asset checksums (the installer
# verifies downloads against these; they ship inside the npm tarball).
node "$root/scripts/mesh-lock.js" --assets "$out"
