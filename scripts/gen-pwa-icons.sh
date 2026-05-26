#!/usr/bin/env bash
# One-off generator for static PWA icon PNGs.
#
# Why static PNGs (vs the previous dynamic SVG routes in src/server.js): manifest.json
# declares icons as "type": "image/png", but the server was returning image/svg+xml.
# iOS Edge/Safari is known to silently reject apple-touch-icon that isn't actually
# PNG, falling back to a generic globe. Committing real PNG assets makes install
# behavior deterministic across platforms.
#
# Usage: bash scripts/gen-pwa-icons.sh
# Requires: macOS (uses qlmanage). To regenerate on Linux, swap in rsvg-convert
# or `inkscape --export-type=png`.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT_DIR="src/public/icons"
mkdir -p "$OUT_DIR"

TMP_SVG="$(mktemp -t pwaicon).svg"
trap 'rm -f "$TMP_SVG"' EXIT

cat > "$TMP_SVG" <<'EOF'
<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#1a1a1a" rx="10"/>
  <path d="M50 18 C28 18 18 32 18 48 C18 58 24 66 32 70 L32 74 C32 78 36 80 40 78 L44 76"
        fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
  <path d="M50 18 C72 18 82 32 82 48 C82 58 76 66 68 70 L68 74 C68 78 64 80 60 78 L56 76"
        fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
  <circle cx="38" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
  <circle cx="62" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
  <circle cx="50" cy="28" r="2.5" fill="#ff6b00" opacity="0.4"/>
  <text x="50" y="62" text-anchor="middle" dominant-baseline="middle"
        font-family="'JetBrains Mono','SF Mono',monospace" font-size="28" font-weight="700" fill="#ff6b00">&gt;_</text>
</svg>
EOF

for SIZE in 16 32 144 180 192 512; do
  echo "  → icon-${SIZE}.png"
  qlmanage -t -s "$SIZE" -o "$OUT_DIR" "$TMP_SVG" >/dev/null 2>&1
  mv "$OUT_DIR/$(basename "$TMP_SVG").png" "$OUT_DIR/icon-${SIZE}.png"
done

echo "Done. Generated $(ls "$OUT_DIR" | wc -l | tr -d ' ') files in $OUT_DIR/"
