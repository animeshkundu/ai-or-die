#!/bin/sh
# Mock devtunnel CLI for E2E testing.
# Simulates the subcommands used by VSCodeTunnelManager's two-process model.

# --- user show: auth check (exit 0 = authenticated) ---
if [ "$1" = "user" ] && [ "$2" = "show" ]; then
  exit 0
fi

# --- user login: authenticate (exit 0 = success) ---
if [ "$1" = "user" ] && [ "$2" = "login" ]; then
  exit 0
fi

# --- create: create a named tunnel ---
if [ "$1" = "create" ]; then
  echo "Created tunnel"
  exit 0
fi

# --- port create: configure port forwarding ---
if [ "$1" = "port" ] && [ "$2" = "create" ]; then
  echo "Port configured"
  exit 0
fi

# --- host: start hosting the tunnel (long-running) ---
# Accepts optional -p <port> flag (ignored by mock)
if [ "$1" = "host" ]; then
  echo "Connect via browser: https://mock-e2e-test.devtunnels.ms"
  # Stay alive until killed (real devtunnel host is a long-running daemon)
  sleep 3600
  exit 0
fi

# --- delete: remove a tunnel ---
if [ "$1" = "delete" ]; then
  exit 0
fi

# Unknown subcommand — exit with error
echo "Unknown subcommand: $*" >&2
exit 1
