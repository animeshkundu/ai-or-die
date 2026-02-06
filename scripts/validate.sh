#!/bin/bash
set -e
echo "=== Cortex Validation ==="
echo "Running tests..."
npm test
echo ""
echo "Checking docs structure..."
for dir in docs/architecture docs/specs docs/adrs docs/agent-instructions docs/history; do
  if [ ! -d "$dir" ]; then
    echo "FAIL: Missing directory $dir"
    exit 1
  fi
done
echo "All doc directories present."
echo ""
echo "=== Validation PASSED ==="
