@echo off
REM Mock VS Code CLI for E2E testing.
REM Handles both `code serve-web` (new two-process model) and legacy `code tunnel`.

REM --- serve-web subcommand (local VS Code HTTP server) ---
if "%~1"=="serve-web" (
  node "%~dp0fake-code-server.js" %*
  exit /b %errorlevel%
)

REM --- Legacy: tunnel subcommand ---
REM Fast-fail for `code tunnel user show` (auth check) — exit 1 = not authenticated
if "%~1"=="tunnel" if "%~2"=="user" exit /b 1

echo To grant access to the server, please log in to https://github.com/login/device and use code ABCD-1234
ping -n 2 127.0.0.1 >nul
echo Open this link in your browser https://vscode.dev/tunnel/mock-e2e-test
ping -n 3601 127.0.0.1 >nul
