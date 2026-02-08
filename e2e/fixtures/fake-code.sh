#!/bin/sh
# Mock VS Code tunnel CLI for E2E testing.
# Simulates the output of `code tunnel --accept-server-license-terms --no-sleep`.

# Fast-fail for `code tunnel user show` (auth check) — exit 1 = not authenticated
if [ "$1" = "tunnel" ] && [ "$2" = "user" ]; then
  exit 1
fi

echo "To grant access to the server, please log in to https://github.com/login/device and use code ABCD-1234"
sleep 2
echo "Open this link in your browser https://vscode.dev/tunnel/mock-e2e-test"
# Stay alive until killed (real code tunnel is a long-running daemon)
sleep 3600
