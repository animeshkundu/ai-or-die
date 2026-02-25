@echo off
REM Mock devtunnel CLI for E2E testing.
REM Simulates the subcommands used by VSCodeTunnelManager's two-process model.

REM --- user show: auth check (exit 0 = authenticated) ---
if "%1"=="user" if "%2"=="show" (
  echo Logged in as mock-user using GitHub.
  exit /b 0
)

REM --- user login: authenticate (exit 0 = success) ---
if "%1"=="user" if "%2"=="login" exit /b 0

REM --- create: create a named tunnel ---
if "%1"=="create" (
  echo Created tunnel
  exit /b 0
)

REM --- port create: configure port forwarding ---
if "%1"=="port" if "%2"=="create" (
  echo Port configured
  exit /b 0
)

REM --- host: start hosting the tunnel (long-running) ---
if "%1"=="host" (
  echo Connect via browser: https://mock-e2e-test.devtunnels.ms
  REM Stay alive until killed (real devtunnel host is a long-running daemon)
  ping -n 3601 127.0.0.1 >nul
  exit /b 0
)

REM --- delete: remove a tunnel ---
if "%1"=="delete" exit /b 0

REM Unknown subcommand
echo Unknown subcommand: %* 1>&2
exit /b 1
