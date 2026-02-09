# Generates ~500KB/sec of ANSI-rich terminal output simulating Claude planning.
# Usage: powershell heavy-output.ps1 [duration_seconds]
param([int]$Duration = 10)

$ESC = [char]27
$BOLD = "$ESC[1m"
$DIM = "$ESC[2m"
$GREEN = "$ESC[32m"
$BLUE = "$ESC[34m"
$CYAN = "$ESC[36m"
$YELLOW = "$ESC[33m"
$MAGENTA = "$ESC[35m"
$RESET = "$ESC[0m"

$end = (Get-Date).AddSeconds($Duration)
$i = 0

while ((Get-Date) -lt $end) {
    $i++
    $phase = ($i % 5) + 1

    Write-Host "${BOLD}${BLUE}## Phase ${phase}: Implementation Details${RESET}"
    Write-Host "${DIM}Planning step $i of the optimization pipeline...${RESET}"
    Write-Host ""
    Write-Host "${GREEN}+ Added new module for handling WebSocket binary frames${RESET}"
    Write-Host "${GREEN}+ Implemented circular buffer with O(1) push/evict operations${RESET}"
    Write-Host "${YELLOW}~ Modified server.js to support TCP_NODELAY on all connections${RESET}"
    Write-Host "${MAGENTA}  -> This change affects lines 1091-1110 of the server module${RESET}"
    Write-Host ""
    Write-Host "${CYAN}### Code Changes:${RESET}"
    Write-Host '```javascript'
    Write-Host "const ws = new WebSocket.Server({"
    Write-Host "  server,"
    Write-Host "  maxPayload: 8 * 1024 * 1024,"
    Write-Host "  perMessageDeflate: {"
    Write-Host "    threshold: 1024,"
    Write-Host "    serverNoContextTakeover: false,"
    Write-Host "    zlibDeflateOptions: { level: 1 }"
    Write-Host "  }"
    Write-Host "});"
    Write-Host '```'
    Write-Host ""

    $p50 = Get-Random -Minimum 3 -Maximum 18
    $p95 = Get-Random -Minimum 15 -Maximum 45
    $p99 = Get-Random -Minimum 30 -Maximum 90
    Write-Host "${BOLD}Performance metrics:${RESET} p50=${GREEN}${p50}ms${RESET} p95=${YELLOW}${p95}ms${RESET} p99=${MAGENTA}${p99}ms${RESET}"
    Write-Host ([string]([char]0x2501) * 78)
    Write-Host ""

    for ($j = 1; $j -le 30; $j++) {
        Write-Host "${DIM}  Processing node ${i}.${j}: analyzing dependencies, resolving imports, checking types...${RESET}"
    }
    Write-Host ""

    Start-Sleep -Milliseconds 50
}

Write-Host ""
Write-Host "${BOLD}${GREEN}Output generation complete. $i iterations.${RESET}"
