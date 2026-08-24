#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$APP_DIR/data/server.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Proceso activo. PID $(cat "$PID_FILE")"
else
  echo "Proceso no activo."
fi

curl -sS "http://127.0.0.1:${PORT:-8771}/health" || true
echo
