#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$APP_DIR/data/server.pid"
LOG_FILE="$APP_DIR/logs/server.log"

mkdir -p "$APP_DIR/data" "$APP_DIR/logs" "$APP_DIR/backups"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Organizador Web ya esta en marcha. PID $(cat "$PID_FILE")"
  exit 0
fi

cd "$APP_DIR/server"
nohup node index.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "Organizador Web iniciado en puerto ${PORT:-8771}. PID $(cat "$PID_FILE")"
