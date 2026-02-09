#!/bin/bash
# Generates ~500KB/sec of ANSI-rich terminal output simulating Claude planning.
# Usage: bash heavy-output.sh [duration_seconds]
DURATION=${1:-10}
END=$((SECONDS + DURATION))

# ANSI color codes
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
BLUE='\033[34m'
CYAN='\033[36m'
YELLOW='\033[33m'
MAGENTA='\033[35m'
RESET='\033[0m'

i=0
while [ $SECONDS -lt $END ]; do
  i=$((i + 1))

  # Simulate markdown-style plan output with ANSI formatting
  printf "${BOLD}${BLUE}## Phase %d: Implementation Details${RESET}\n" $((i % 5 + 1))
  printf "${DIM}Planning step %d of the optimization pipeline...${RESET}\n" $i
  printf "\n"
  printf "${GREEN}+ Added new module for handling WebSocket binary frames${RESET}\n"
  printf "${GREEN}+ Implemented circular buffer with O(1) push/evict operations${RESET}\n"
  printf "${YELLOW}~ Modified server.js to support TCP_NODELAY on all connections${RESET}\n"
  printf "${MAGENTA}  → This change affects lines 1091-1110 of the server module${RESET}\n"
  printf "\n"
  printf "${CYAN}### Code Changes:${RESET}\n"
  printf '```javascript\n'
  printf "const ws = new WebSocket.Server({\n"
  printf "  server,\n"
  printf "  maxPayload: 8 * 1024 * 1024,\n"
  printf "  perMessageDeflate: {\n"
  printf "    threshold: 1024,\n"
  printf "    serverNoContextTakeover: false,\n"
  printf "    zlibDeflateOptions: { level: 1 }\n"
  printf "  }\n"
  printf "});\n"
  printf '```\n'
  printf "\n"
  printf "${BOLD}Performance metrics:${RESET} p50=${GREEN}%dms${RESET} p95=${YELLOW}%dms${RESET} p99=${MAGENTA}%dms${RESET}\n" \
    $((RANDOM % 15 + 3)) $((RANDOM % 30 + 15)) $((RANDOM % 60 + 30))
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  printf "\n"

  # Control output rate: ~500KB/sec means ~50KB per 100ms iteration
  # Each iteration above is ~1.5KB, so we do a few more lines
  for j in $(seq 1 30); do
    printf "${DIM}  Processing node %d.%d: analyzing dependencies, resolving imports, checking types...${RESET}\n" $i $j
  done
  printf "\n"

  # Small sleep to control rate (yield to shell for input processing)
  sleep 0.05
done

printf "\n${BOLD}${GREEN}Output generation complete. %d iterations.${RESET}\n" $i
