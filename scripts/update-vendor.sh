#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
curl -L "https://cdn.jsdelivr.net/npm/marked@15/marked.min.js" -o src/public/vendor/marked.min.js
curl -L "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js" -o src/public/vendor/purify.min.js
echo "Vendor libraries updated."
