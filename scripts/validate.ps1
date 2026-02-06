$ErrorActionPreference = "Stop"
Write-Host "=== Cortex Validation ==="

Write-Host "Running tests..."
npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

Write-Host "Checking docs structure..."
$dirs = @(
    "docs/architecture",
    "docs/specs",
    "docs/adrs",
    "docs/agent-instructions",
    "docs/history"
)
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        Write-Host "FAIL: Missing directory $dir"
        exit 1
    }
}
Write-Host "All doc directories present."
Write-Host ""
Write-Host "=== Validation PASSED ==="
