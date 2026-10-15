#!/usr/bin/env bash
# Cross-build the ai-or-die-mesh tsnet sidecar for all supported platforms and
# emit SHA-256 checksums. Go cross-compiles from one runner, so this produces
# every target binary plus a checksums manifest the client verifies against.
#
# Output (uploaded to the GitHub release by release-on-main.yml):
#   dist/mesh/ai-or-die-mesh-<plat>-<arch>[.exe]
#   dist/mesh/ai-or-die-mesh-checksums.txt   ("<sha256>  <assetname>" per line)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$root/mesh"
out="$root/dist/mesh"; rm -rf "$out"; mkdir -p "$out"

# Ensure go.mod/go.sum are current FIRST: the content hash below is stamped into
# the binary and names the release tag, so it must describe the exact source
# being built — never a pre-tidy tree.
go mod tidy
git diff --exit-code -- go.mod go.sum

# Content hash (Go-free) identifies this sidecar build; stamp it into the binary
# so `ai-or-die-mesh --version` is traceable and the release tag is mesh-<hash>.
version="$(node "$root/scripts/mesh-lock.js" --print-hash)"
echo "mesh content hash: $version"

# Pinned Tailscale client version, read from the module graph (not parsed from
# go.mod text, where single-line vs block require forms differ). A tailscale
# bump flips the content hash too (go.mod is hashed), so it always ships a new
# mesh-<hash> tag. Fails closed with a clear message, never an opaque pipefail.
tsversion="$(go list -m tailscale.com 2>/dev/null | awk '{print $2}')"
if ! [[ "${tsversion:-}" =~ ^v[0-9]+\.[0-9]+ ]]; then
  echo "could not determine tailscale.com version via 'go list -m tailscale.com'" >&2
  exit 1
fi
echo "tailscale client: $tsversion"

emit() {  # <goos> <goarch> <plat> <arch> <ext>
  local name="ai-or-die-mesh-$3-$4$5"
  GOOS=$1 GOARCH=$2 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$version -X main.tsVersion=$tsversion" -o "$out/$name" .
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
  for b in "$out"/ai-or-die-mesh-windows-*; do
    signtool sign /f "$AIORDIE_SIGN_PFX" /p "${AIORDIE_SIGN_PW:-}" /fd sha256 "$b" && echo "signed $b"
  done
fi

( cd "$out" && sha256sum ai-or-die-mesh-* > ai-or-die-mesh-checksums.txt )
echo "checksums:"; cat "$out/ai-or-die-mesh-checksums.txt"

# Finalize the lock with the freshly-built per-asset checksums (the installer
# verifies downloads against these; they ship inside the npm tarball).
node "$root/scripts/mesh-lock.js" --assets "$out"
