@echo off
REM Mock VS Code tunnel CLI for E2E testing.
REM Simulates the output of `code tunnel --accept-server-license-terms --no-sleep`.

REM Fast-fail for `code tunnel user show` (auth check) — exit 1 = not authenticated
if "%1"=="tunnel" if "%2"=="user" exit /b 1

echo To grant access to the server, please log in to https://github.com/login/device and use code ABCD-1234
ping -n 2 127.0.0.1 >nul
echo Open this link in your browser https://vscode.dev/tunnel/mock-e2e-test
ping -n 3601 127.0.0.1 >nul
