#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$APP_DIR/data/server.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No existe PID. Puede que la app no este en marcha."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  sleep 1
fi

rm -f "$PID_FILE"
echo "Organizador Web detenido."
