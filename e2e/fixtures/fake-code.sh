#!/bin/sh
# Mock VS Code CLI for E2E testing.
# Handles both `code serve-web` (new two-process model) and legacy `code tunnel`.

# --- serve-web subcommand (local VS Code HTTP server) ---
if [ "$1" = "serve-web" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  exec node "$SCRIPT_DIR/fake-code-server.js" "$@"
fi

# --- Legacy: tunnel subcommand ---
# Fast-fail for `code tunnel user show` (auth check) — exit 1 = not authenticated
if [ "$1" = "tunnel" ] && [ "$2" = "user" ]; then
  exit 1
fi

echo "To grant access to the server, please log in to https://github.com/login/device and use code ABCD-1234"
sleep 0.5
echo "Open this link in your browser https://vscode.dev/tunnel/mock-e2e-test"
# Stay alive until killed (real code tunnel is a long-running daemon)
sleep 3600
